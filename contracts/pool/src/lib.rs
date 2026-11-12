mod crypto;
use crypto::{decimal, parse, poseidon, sha_field, Field};
use near_sdk::collections::{LookupMap, LookupSet, Vector};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const DEPTH: usize = 8;
const CAPACITY: u32 = 1 << DEPTH;
const FEE: u128 = 20_000_000_000_000_000_000_000;
const ZERO: Field = [0; 32];

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PayoutState {
    Pending,
    Retryable,
    Complete,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Payout {
    pub state: PayoutState,
    pub recipient: AccountId,
    pub disclosure_root: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Record {
    pub index: u64,
    pub kind: String,
    pub commitment: Option<String>,
    pub nullifier: Option<String>,
    pub recipient: Option<AccountId>,
    pub disclosure_root: String,
    pub block_height: u64,
    pub timestamp_ns: String,
}

#[near(serializers = [json])]
pub struct Config {
    pub protocol: String,
    pub network: String,
    pub denomination: U128,
    pub storage_fee: U128,
    pub domain: String,
    pub root: String,
    pub leaf_count: u32,
    pub capacity: u32,
    pub record_count: u64,
    pub outstanding_notes: u32,
    pub verifier_sha256: String,
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_payout(
        &mut self,
        nullifier: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool;
}

// No owner, pause, sweep, upgrade, verifier setter, or privileged spending methods.
// Deploy key must separately be removed to make the account code immutable.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    network: String,
    denomination: u128,
    domain: Field,
    verifier: Vec<u8>,
    nodes: Vec<Field>,
    leaves: Vector<Field>,
    commitments: LookupSet<Field>,
    roots: LookupSet<Field>,
    spent: LookupSet<Field>,
    payouts: LookupMap<Field, Payout>,
    records: Vector<Record>,
    outstanding: u32,
}

#[near]
impl Pool {
    #[init]
    #[payable]
    pub fn new(network: String, denomination: U128, verification_key: Base64VecU8) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Initialize from contract account"
        );
        require!(
            network == "testnet" || network == "sandbox",
            "Hackathon pool: testnet or sandbox only"
        );
        require!(
            denomination.0 > 0 && denomination.0 <= u128::MAX / CAPACITY as u128,
            "Invalid denomination"
        );
        require!(
            env::attached_deposit() >= NearToken::from_near(1),
            "Attach 1 NEAR storage reserve"
        );
        crypto::validate_vk(&verification_key.0);
        let d = sha_field(&format!(
            "core:v1|{}|{}|{}",
            network,
            env::current_account_id(),
            denomination.0
        ));
        let mut nodes = vec![ZERO; 2 * CAPACITY as usize - 1];
        let mut zero = ZERO;
        for level in (0..DEPTH).rev() {
            zero = poseidon(&zero, &zero);
            nodes[(1 << level) - 1..(1 << (level + 1)) - 1].fill(zero);
        }
        let mut roots = LookupSet::new(b"r");
        roots.insert(&nodes[0]);
        Self {
            network,
            denomination: denomination.0,
            domain: d,
            verifier: verification_key.0,
            nodes,
            leaves: Vector::new(b"l"),
            commitments: LookupSet::new(b"c"),
            roots,
            spent: LookupSet::new(b"s"),
            payouts: LookupMap::new(b"p"),
            records: Vector::new(b"e"),
            outstanding: 0,
        }
    }

    pub fn get_config(&self) -> Config {
        Config {
            protocol: "core-v1".into(),
            network: self.network.clone(),
            denomination: U128(self.denomination),
            storage_fee: U128(FEE),
            domain: decimal(&self.domain),
            root: decimal(&self.nodes[0]),
            leaf_count: self.leaves.len() as u32,
            capacity: CAPACITY,
            record_count: self.records.len(),
            outstanding_notes: self.outstanding,
            verifier_sha256: hex::encode(env::sha256(&self.verifier)),
        }
    }
    pub fn get_commitments(&self, from_index: u64, limit: u32) -> Vec<String> {
        (from_index
            ..from_index
                .saturating_add(limit.min(256) as u64)
                .min(self.leaves.len()))
            .map(|i| decimal(&self.leaves.get(i).expect("leaf")))
            .collect()
    }
    pub fn get_records(&self, from_index: u64, limit: u32) -> Vec<Record> {
        (from_index
            ..from_index
                .saturating_add(limit.min(50) as u64)
                .min(self.records.len()))
            .map(|i| self.records.get(i).expect("record"))
            .collect()
    }
    pub fn is_spent(&self, nullifier: String) -> bool {
        self.spent.contains(&parse(&nullifier))
    }
    pub fn get_payout(&self, nullifier: String) -> Option<Payout> {
        self.payouts.get(&parse(&nullifier))
    }

    #[payable]
    pub fn deposit(&mut self, commitment: String, disclosure_root: String) -> u64 {
        require!(
            env::attached_deposit().as_yoctonear() == self.denomination + FEE,
            "Attach denomination plus storage fee"
        );
        Self::validate_disclosure(&disclosure_root);
        let start = env::storage_usage();
        let leaf = self.append(parse(&commitment));
        self.outstanding += 1;
        self.record("deposit", Some(commitment), None, None, disclosure_root);
        self.storage_covered(start);
        leaf
    }

    #[payable]
    pub fn transfer(
        &mut self,
        output_commitment: String,
        disclosure_root: String,
        proof: Base64VecU8,
        public_inputs: Vec<String>,
    ) -> u64 {
        Self::charge_fee();
        Self::validate_disclosure(&disclosure_root);
        let output = parse(&output_commitment);
        require!(
            output != ZERO && !self.commitments.contains(&output),
            "Invalid or duplicate output"
        );
        require!(self.leaves.len() < CAPACITY as u64, "Tree full");
        let nf = self.check_spend(
            "transfer",
            &output_commitment,
            &disclosure_root,
            &proof.0,
            &public_inputs,
        );
        let start = env::storage_usage();
        self.spent.insert(&nf);
        let leaf = self.append(output);
        self.record(
            "transfer",
            Some(output_commitment),
            Some(decimal(&nf)),
            None,
            disclosure_root,
        );
        self.storage_covered(start);
        leaf
    }

    #[payable]
    pub fn withdraw(
        &mut self,
        recipient: AccountId,
        disclosure_root: String,
        proof: Base64VecU8,
        public_inputs: Vec<String>,
    ) -> Promise {
        Self::charge_fee();
        Self::validate_disclosure(&disclosure_root);
        require!(
            recipient != env::current_account_id(),
            "Cannot withdraw to pool"
        );
        let nf = self.check_spend(
            "withdraw",
            recipient.as_str(),
            &disclosure_root,
            &proof.0,
            &public_inputs,
        );
        let start = env::storage_usage();
        self.spent.insert(&nf);
        self.payouts.insert(
            &nf,
            &Payout {
                state: PayoutState::Pending,
                recipient: recipient.clone(),
                disclosure_root: disclosure_root.clone(),
            },
        );
        self.record(
            "withdrawal_requested",
            None,
            Some(decimal(&nf)),
            Some(recipient.clone()),
            disclosure_root,
        );
        self.storage_covered(start);
        self.send(nf, recipient)
    }

    // Anyone can retry, but the destination is permanently bound to the original proof.
    #[payable]
    pub fn retry_withdrawal(&mut self, nullifier: String) -> Promise {
        Self::charge_fee();
        let nf = parse(&nullifier);
        let mut payout = self.payouts.get(&nf).expect("Unknown payout");
        require!(
            payout.state == PayoutState::Retryable,
            "Payout is not retryable"
        );
        payout.state = PayoutState::Pending;
        self.payouts.insert(&nf, &payout);
        self.send(nf, payout.recipient)
    }

    #[private]
    pub fn on_payout(
        &mut self,
        nullifier: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let nf = parse(&nullifier);
        let mut payout = self.payouts.get(&nf).expect("Unknown payout");
        require!(payout.state == PayoutState::Pending, "Not pending");
        let ok = result.is_ok();
        payout.state = if ok {
            PayoutState::Complete
        } else {
            PayoutState::Retryable
        };
        if ok {
            self.outstanding -= 1;
        }
        self.payouts.insert(&nf, &payout);
        self.record(
            if ok {
                "withdrawal_succeeded"
            } else {
                "withdrawal_failed"
            },
            None,
            Some(nullifier),
            Some(payout.recipient),
            payout.disclosure_root,
        );
        ok
    }
}

impl Pool {
    fn validate_disclosure(root: &str) {
        require!(
            root.len() == 64
                && root
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "Invalid disclosure root"
        );
    }
    fn charge_fee() {
        require!(
            env::attached_deposit().as_yoctonear() == FEE,
            "Attach exact storage fee"
        );
    }
    fn storage_covered(&self, start: u64) {
        let bytes = env::storage_usage().saturating_sub(start);
        // Reserve enough also for the later callback record of a withdrawal.
        require!(
            (bytes as u128 + 512) * env::storage_byte_cost().as_yoctonear() <= FEE,
            "Storage fee insufficient"
        );
    }
    fn append(&mut self, commitment: Field) -> u64 {
        require!(
            commitment != ZERO && !self.commitments.contains(&commitment),
            "Invalid or duplicate commitment"
        );
        let leaf = self.leaves.len();
        require!(leaf < CAPACITY as u64, "Tree full");
        self.commitments.insert(&commitment);
        self.leaves.push(&commitment);
        let mut i = CAPACITY as usize - 1 + leaf as usize;
        self.nodes[i] = commitment;
        while i > 0 {
            i = (i - 1) / 2;
            self.nodes[i] = poseidon(&self.nodes[i * 2 + 1], &self.nodes[i * 2 + 2]);
        }
        self.roots.insert(&self.nodes[0]);
        leaf
    }
    fn check_spend(
        &self,
        kind: &str,
        target: &str,
        disclosure: &str,
        proof: &[u8],
        inputs: &[String],
    ) -> Field {
        require!(inputs.len() == 5, "Expected five public inputs");
        let fields: Vec<Field> = inputs.iter().map(|x| parse(x)).collect();
        require!(fields[4] == self.domain, "Wrong pool domain");
        require!(self.roots.contains(&fields[2]), "Unknown Merkle root");
        let context = sha_field(&format!(
            "core:action:v1|{}|{}|{}|{}",
            decimal(&self.domain),
            kind,
            target,
            disclosure
        ));
        require!(fields[3] == context, "Wrong action binding");
        require!(!self.spent.contains(&fields[0]), "Note already spent");
        require!(
            crypto::verify(&self.verifier, proof, &fields),
            "Invalid Groth16 proof"
        );
        fields[0]
    }
    fn send(&self, nf: Field, recipient: AccountId) -> Promise {
        // Keep principal and the storage stake separately solvent.
        let stake =
            (env::storage_usage() as u128 + 32_768) * env::storage_byte_cost().as_yoctonear();
        require!(
            env::account_balance().as_yoctonear()
                >= self.outstanding as u128 * self.denomination + stake,
            "Insufficient reserve"
        );
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(self.denomination))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_payout(decimal(&nf)),
            )
    }
    fn record(
        &mut self,
        kind: &str,
        commitment: Option<String>,
        nullifier: Option<String>,
        recipient: Option<AccountId>,
        disclosure_root: String,
    ) {
        let record = Record {
            index: self.records.len(),
            kind: kind.into(),
            commitment,
            nullifier,
            recipient,
            disclosure_root,
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp().to_string(),
        };
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({ "standard": "core_privacy", "version": "1.0.0", "event": kind, "data": [&record] })
        ));
        self.records.push(&record);
    }
}

#[cfg(test)]
mod tests;
