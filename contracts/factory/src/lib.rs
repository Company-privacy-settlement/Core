use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

// Built from the pool source before compiling the factory.
// The bytes and verifier are pinned per factory; no setter or upgrade method.
const VAULT_WASM: &[u8] = include_bytes!("../../../artifacts/core_pool.wasm");
const REGISTRATION_FEE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
const INIT_RESERVE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
const STATE_BUFFER: u128 = 65_536;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum VaultState {
    Pending,
    Ready,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct VaultRecord {
    pub index: u64,
    pub account_id: AccountId,
    pub creator: AccountId,
    pub state: VaultState,
    pub funding: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct RefundBalance {
    pub available: U128,
    pub in_flight: U128,
}

#[near(serializers = [json])]
pub struct FactoryConfig {
    pub protocol: String,
    pub network: String,
    pub denomination: U128,
    pub vault_wasm_sha256: String,
    pub verifier_sha256: String,
    pub vault_funding: U128,
    pub registration_fee: U128,
    pub creation_deposit: U128,
    pub vault_count: u64,
    pub pending_funding: U128,
    pub refund_liability: U128,
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_created(
        &mut self,
        index: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool;
    fn on_refund(
        &mut self,
        creator: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    network: String,
    denomination: u128,
    verification_key: Vec<u8>,
    funding: u128,
    vaults: Vector<VaultRecord>,
    indexes: LookupMap<AccountId, u64>,
    refunds: LookupMap<AccountId, RefundBalance>,
    pending_funding: u128,
    refund_liability: u128,
}

#[near]
impl Factory {
    #[init]
    #[payable]
    pub fn new(network: String, denomination: U128, verification_key: Base64VecU8) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Initialize from factory account"
        );
        require!(
            env::current_account_id().as_str().len() <= 30,
            "Factory account ID exceeds 30 characters"
        );
        require!(
            network == "testnet" || network == "sandbox",
            "Invalid network label"
        );
        require!(
            denomination.0 > 0 && denomination.0 <= u128::MAX / 256,
            "Invalid denomination"
        );
        require!(
            verification_key.0.len() == 832,
            "Expected five-input Groth16 key"
        );
        require!(
            env::attached_deposit().as_yoctonear() >= INIT_RESERVE,
            "Attach 1 NEAR factory reserve"
        );
        let funding = (VAULT_WASM.len() as u128 + STATE_BUFFER)
            * env::storage_byte_cost().as_yoctonear()
            + INIT_RESERVE;
        Self {
            network,
            denomination: denomination.0,
            verification_key: verification_key.0,
            funding,
            vaults: Vector::new(b"v"),
            indexes: LookupMap::new(b"i"),
            refunds: LookupMap::new(b"r"),
            pending_funding: 0,
            refund_liability: 0,
        }
    }

    pub fn get_config(&self) -> FactoryConfig {
        FactoryConfig {
            protocol: "core-factory-v1".into(),
            network: self.network.clone(),
            denomination: U128(self.denomination),
            vault_wasm_sha256: hex::encode(env::sha256(VAULT_WASM)),
            verifier_sha256: hex::encode(env::sha256(&self.verification_key)),
            vault_funding: U128(self.funding),
            registration_fee: U128(REGISTRATION_FEE),
            creation_deposit: U128(self.funding + REGISTRATION_FEE),
            vault_count: self.vaults.len(),
            pending_funding: U128(self.pending_funding),
            refund_liability: U128(self.refund_liability),
        }
    }

    pub fn predict_vault(&self, creator: AccountId, salt: String) -> AccountId {
        require!(
            salt.len() == 64
                && salt
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Salt must be 32-byte lowercase hex"
        );
        let digest = hex::encode(env::sha256(
            format!("core:vault:v1|{}|{}", creator, salt).as_bytes(),
        ));
        format!("v{}.{}", &digest[..32], env::current_account_id())
            .parse()
            .expect("Valid child account")
    }

    pub fn list_vaults(&self, from_index: u64, limit: u32) -> Vec<VaultRecord> {
        (from_index
            ..from_index
                .saturating_add(limit.min(50) as u64)
                .min(self.vaults.len()))
            .map(|index| self.vaults.get(index).expect("Vault record"))
            .collect()
    }

    pub fn get_vault(&self, account_id: AccountId) -> Option<VaultRecord> {
        self.indexes
            .get(&account_id)
            .and_then(|index| self.vaults.get(index))
    }

    pub fn get_refund(&self, creator: AccountId) -> RefundBalance {
        self.refunds.get(&creator).unwrap_or_default()
    }

    // Only bootstrapping funds pass through here. Settlement deposits go directly to vaults.
    #[payable]
    pub fn create_vault(&mut self, salt: String) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() == self.funding + REGISTRATION_FEE,
            "Attach exact creation deposit from get_config"
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(220),
            "Attach at least 220 Tgas"
        );
        let creator = env::predecessor_account_id();
        let account_id = self.predict_vault(creator.clone(), salt);
        require!(
            self.indexes.get(&account_id).is_none(),
            "Creation already requested; use a fresh salt"
        );
        let index = self.vaults.len();
        let start = env::storage_usage();
        self.indexes.insert(&account_id, &index);
        self.vaults.push(&VaultRecord {
            index,
            account_id: account_id.clone(),
            creator,
            state: VaultState::Pending,
            funding: U128(self.funding),
        });
        self.pending_funding += self.funding;
        require!(
            (env::storage_usage().saturating_sub(start) as u128 + 1024)
                * env::storage_byte_cost().as_yoctonear()
                <= REGISTRATION_FEE,
            "Registration fee does not cover storage"
        );
        self.emit("vault_requested", index);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "network": self.network, "denomination": U128(self.denomination), "verification_key": Base64VecU8(self.verification_key.clone())
        })).expect("Initialization arguments");
        // Never add any full-access or function-call key to the child.
        Promise::new(account_id)
            .create_account()
            .transfer(NearToken::from_yoctonear(self.funding - INIT_RESERVE))
            .deploy_contract(VAULT_WASM.to_vec())
            .function_call(
                "new_from_factory",
                args,
                NearToken::from_yoctonear(INIT_RESERVE),
                Gas::from_tgas(80),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .on_created(index),
            )
    }

    #[private]
    pub fn on_created(
        &mut self,
        index: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let mut record = self.vaults.get(index).expect("Unknown creation");
        require!(
            record.state == VaultState::Pending,
            "Creation is not pending"
        );
        self.pending_funding -= record.funding.0;
        let ok = result.is_ok();
        record.state = if ok {
            VaultState::Ready
        } else {
            VaultState::Failed
        };
        if !ok {
            let mut refund = self.get_refund(record.creator.clone());
            refund.available.0 += record.funding.0;
            self.refund_liability += record.funding.0;
            self.refunds.insert(&record.creator, &refund);
        }
        self.vaults.replace(index, &record);
        self.emit(if ok { "vault_ready" } else { "vault_failed" }, index);
        ok
    }

    // Pull refunds: an automatic protocol refund may arrive after on_created.
    // Destination is always the original creator, never a caller-supplied address.
    #[payable]
    pub fn claim_refund(&mut self) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            "Attach 1 yoctoNEAR"
        );
        let creator = env::predecessor_account_id();
        let mut refund = self.get_refund(creator.clone());
        require!(refund.available.0 > 0, "No available refund");
        require!(refund.in_flight.0 == 0, "Refund is already in flight");
        let stake =
            (env::storage_usage() as u128 + STATE_BUFFER) * env::storage_byte_cost().as_yoctonear();
        require!(
            env::account_balance().as_yoctonear()
                >= stake + self.refund_liability + self.pending_funding,
            "Protocol refunds have not settled; retry later"
        );
        let amount = refund.available;
        refund.available = U128(0);
        refund.in_flight = amount;
        self.refunds.insert(&creator, &refund);
        Promise::new(creator.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_refund(creator, amount),
            )
    }

    #[private]
    pub fn on_refund(
        &mut self,
        creator: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let mut refund = self.get_refund(creator.clone());
        require!(
            amount.0 > 0 && refund.in_flight == amount,
            "Refund is not in flight"
        );
        refund.in_flight = U128(0);
        let ok = result.is_ok();
        if ok {
            self.refund_liability -= amount.0;
        } else {
            refund.available.0 += amount.0;
        }
        self.refunds.insert(&creator, &refund);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "core_factory", "version": "1.0.0", "event": if ok { "refund_succeeded" } else { "refund_failed" },
                "data": [{ "creator": creator, "amount": amount }]
            })
        ));
        ok
    }
}

impl Factory {
    fn emit(&self, kind: &str, index: u64) {
        let record = self.vaults.get(index).expect("Vault record");
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "core_factory", "version": "1.0.0", "event": kind, "data": [&record]
            })
        ));
    }
}

#[cfg(test)]
mod tests;
