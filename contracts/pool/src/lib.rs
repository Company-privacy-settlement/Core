mod crypto;
mod fees;
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
    pub amount: U128,
    pub protocol_fee_charged: U128,
    pub protocol_fee_earned: U128,
    pub storage_fee_charged: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub protocol: String,
    pub network: String,
    pub denomination: U128,
    pub storage_fee: U128,
    pub deposit_fee_bps: u16,
    pub withdrawal_fee_bps: u16,
    pub deposit_protocol_fee: U128,
    pub withdrawal_protocol_fee: U128,
    pub deposit_attached: U128,
    pub withdrawal_attached: U128,
    pub withdrawal_received: U128,
    pub fee_recipient: AccountId,
    pub accrued_protocol_fees: U128,
    pub pending_withdrawal_fees: U128,
    pub fee_payout_in_flight: U128,
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
    fn on_fee_payout(
        &mut self,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool;
    fn on_payout(
        &mut self,
        nullifier: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool;
}

// No owner, pause, sweep, upgrade, verifier setter, or privileged spending methods.
// Direct deployments remove their keys separately; factory deployments start keyless.
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
    fee_recipient: AccountId,
    accrued_protocol_fees: u128,
    pending_withdrawal_fees: u128,
    fee_payout_in_flight: u128,
}

#[near]
impl Pool {
    #[init]
    #[payable]
    pub fn new(
        network: String,
        denomination: U128,
        verification_key: Base64VecU8,
        fee_recipient: AccountId,
    ) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Initialize from contract account"
        );
        Self::initialize(network, denomination, verification_key, fee_recipient)
    }

    // Used in the factory's atomic create → fund → deploy → initialize batch.
    // An arbitrary caller or ancestor cannot initialize a vault.
    #[init]
    #[payable]
    pub fn new_from_factory(
        network: String,
        denomination: U128,
        verification_key: Base64VecU8,
        fee_recipient: AccountId,
    ) -> Self {
        let current = env::current_account_id();
        let predecessor = env::predecessor_account_id();
        require!(
            current.get_parent_account_id() == Some(predecessor.as_ref()),
            "Only the direct parent factory may initialize"
        );
        Self::initialize(network, denomination, verification_key, fee_recipient)
    }
}

impl Pool {
    fn initialize(
        network: String,
        denomination: U128,
        verification_key: Base64VecU8,
        fee_recipient: AccountId,
    ) -> Self {
        require!(
            fee_recipient != env::current_account_id(),
            "Fee recipient cannot be the vault itself"
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
            fee_recipient,
            accrued_protocol_fees: 0,
            pending_withdrawal_fees: 0,
            fee_payout_in_flight: 0,
        }
    }
}

#[near]
impl Pool {
    pub fn get_config(&self) -> Config {
        Config {
            protocol: "core-v1".into(),
            network: self.network.clone(),
            denomination: U128(self.denomination),
            storage_fee: U128(FEE),
            deposit_fee_bps: fees::DEPOSIT_FEE_BPS,
            withdrawal_fee_bps: fees::WITHDRAWAL_FEE_BPS,
            deposit_protocol_fee: U128(fees::deposit_fee(self.denomination)),
            withdrawal_protocol_fee: U128(fees::withdrawal_fee(self.denomination)),
            deposit_attached: U128(self.denomination + fees::deposit_fee(self.denomination) + FEE),
            withdrawal_attached: U128(fees::withdrawal_fee(self.denomination) + FEE),
            withdrawal_received: U128(self.denomination),
            fee_recipient: self.fee_recipient.clone(),
            accrued_protocol_fees: U128(self.accrued_protocol_fees),
            pending_withdrawal_fees: U128(self.pending_withdrawal_fees),
            fee_payout_in_flight: U128(self.fee_payout_in_flight),
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
            env::attached_deposit().as_yoctonear()
                == self.denomination + fees::deposit_fee(self.denomination) + FEE,
            "Attach denomination plus protocol fee and storage fee"
        );
        Self::validate_disclosure(&disclosure_root);
        let start = env::storage_usage();
        let leaf = self.append(parse(&commitment));
        self.outstanding += 1;
        self.accrued_protocol_fees += fees::deposit_fee(self.denomination);
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
        require!(
            env::attached_deposit().as_yoctonear() == FEE + fees::withdrawal_fee(self.denomination),
            "Attach withdrawal protocol fee plus storage fee"
        );
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
        self.pending_withdrawal_fees += fees::withdrawal_fee(self.denomination);
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
        let start = env::storage_usage();
        self.payouts.insert(&nf, &payout);
        self.record(
            "withdrawal_retried",
            None,
            Some(nullifier),
            Some(payout.recipient.clone()),
            payout.disclosure_root.clone(),
        );
        self.storage_covered(start);
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
            let fee = fees::withdrawal_fee(self.denomination);
            self.pending_withdrawal_fees -= fee;
            self.accrued_protocol_fees += fee;
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

    // Anyone may trigger collection; the recipient is immutable and only earned fees move.
    #[payable]
    pub fn collect_protocol_fees(&mut self) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            "Attach 1 yoctoNEAR"
        );
        require!(
            self.fee_payout_in_flight == 0,
            "Fee collection already in flight"
        );
        require!(self.accrued_protocol_fees > 0, "No earned protocol fees");
        self.ensure_solvent();
        let amount = self.accrued_protocol_fees;
        self.accrued_protocol_fees = 0;
        self.fee_payout_in_flight = amount;
        Promise::new(self.fee_recipient.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_fee_payout(U128(amount)),
            )
    }

    #[private]
    pub fn on_fee_payout(
        &mut self,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        require!(
            amount.0 > 0 && self.fee_payout_in_flight == amount.0,
            "Fee collection is not in flight"
        );
        self.fee_payout_in_flight = 0;
        let ok = result.is_ok();
        if !ok {
            self.accrued_protocol_fees += amount.0;
        }
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "core_privacy", "version": "1.0.0", "event": if ok { "protocol_fees_collected" } else { "protocol_fee_collection_failed" },
                "data": [{ "recipient": self.fee_recipient, "amount": amount }]
            })
        ));
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
        self.ensure_solvent();
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(self.denomination))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_payout(decimal(&nf)),
            )
    }
    fn ensure_solvent(&self) {
        // Keep principal and the storage stake separately solvent.
        let stake =
            (env::storage_usage() as u128 + 32_768) * env::storage_byte_cost().as_yoctonear();
        require!(
            env::account_balance().as_yoctonear()
                >= self.outstanding as u128 * self.denomination
                    + self.pending_withdrawal_fees
                    + self.accrued_protocol_fees
                    + self.fee_payout_in_flight
                    + stake,
            "Insufficient reserve"
        );
    }
    fn record(
        &mut self,
        kind: &str,
        commitment: Option<String>,
        nullifier: Option<String>,
        recipient: Option<AccountId>,
        disclosure_root: String,
    ) {
        let (charged, earned, storage) = match kind {
            "deposit" => {
                let f = fees::deposit_fee(self.denomination);
                (f, f, FEE)
            }
            "withdrawal_requested" => (fees::withdrawal_fee(self.denomination), 0, FEE),
            "withdrawal_succeeded" => (0, fees::withdrawal_fee(self.denomination), 0),
            "transfer" | "withdrawal_retried" => (0, 0, FEE),
            _ => (0, 0, 0),
        };
        let record = Record {
            index: self.records.len(),
            kind: kind.into(),
            commitment,
            nullifier,
            recipient,
            disclosure_root,
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp().to_string(),
            amount: U128(self.denomination),
            protocol_fee_charged: U128(charged),
            protocol_fee_earned: U128(earned),
            storage_fee_charged: U128(storage),
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
