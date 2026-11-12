use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;

fn context(caller: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("factory.test.near".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .signer_account_id(caller.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}
fn factory() -> Factory {
    context("factory.test.near", INIT_RESERVE);
    let v: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(include_str!("../../../test-vectors/spend.json")).unwrap();
    Factory::new(
        "sandbox".into(),
        U128(INIT_RESERVE),
        near_sdk::serde_json::from_value(v["verificationKey"].clone()).unwrap(),
        "treasury.test.near".parse().unwrap(),
    )
}
fn request(f: &mut Factory, caller: &str, salt: &str) {
    context(caller, f.funding + REGISTRATION_FEE);
    f.create_vault(salt.into()).detach();
}

#[test]
fn creation_batch_is_keyless_and_fully_funded() {
    let mut f = factory();
    request(&mut f, "alice.test.near", &"ab".repeat(32));
    let receipts = get_created_receipts();
    let record = f.vaults.get(0).unwrap();
    let batch = receipts
        .iter()
        .find(|r| r.receiver_id == record.account_id)
        .unwrap();
    assert_eq!(batch.actions.len(), 4);
    assert!(matches!(batch.actions[0], MockAction::CreateAccount { .. }));
    assert!(
        matches!(&batch.actions[2], MockAction::DeployContract { code, .. } if code == VAULT_WASM)
    );
    assert!(
        matches!(&batch.actions[3], MockAction::FunctionCallWeight { method_name, attached_deposit, .. }
        if method_name == b"new_from_factory" && attached_deposit.as_yoctonear() == INIT_RESERVE)
    );
    let sent: u128 = batch
        .actions
        .iter()
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            MockAction::FunctionCallWeight {
                attached_deposit, ..
            } => attached_deposit.as_yoctonear(),
            _ => 0,
        })
        .sum();
    assert_eq!(sent, f.funding);
    assert_eq!(record.state, VaultState::Pending);
    context("factory.test.near", 0);
    assert!(f.on_created(0, Ok(())));
    assert_eq!(f.vaults.get(0).unwrap().state, VaultState::Ready);
    assert_eq!(f.pending_funding, 0);
    assert_eq!(f.refund_liability, 0);
}

#[test]
fn failed_creation_refund_is_bound_to_creator_and_restored_on_transfer_failure() {
    let mut f = factory();
    request(&mut f, "alice.test.near", &"ab".repeat(32));
    context("factory.test.near", 0);
    assert!(!f.on_created(0, Err(PromiseError::Failed)));
    assert_eq!(f.vaults.get(0).unwrap().state, VaultState::Failed);
    assert_eq!(
        f.get_refund("alice.test.near".parse().unwrap()).available.0,
        f.funding
    );
    assert_eq!(
        f.get_refund("mallory.test.near".parse().unwrap())
            .available
            .0,
        0
    );
    assert_eq!(f.refund_liability, f.funding);
    context("alice.test.near", 1);
    f.claim_refund().detach();
    let receipts = get_created_receipts();
    assert!(receipts.iter().any(|r| {
        r.receiver_id.as_str() == "alice.test.near" && r.actions.iter().any(|a|
        matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == f.funding))
    }));
    context("factory.test.near", 0);
    assert!(!f.on_refund(
        "alice.test.near".parse().unwrap(),
        U128(f.funding),
        Err(PromiseError::Failed)
    ));
    assert_eq!(
        f.get_refund("alice.test.near".parse().unwrap()).available.0,
        f.funding
    );
    context("alice.test.near", 1);
    f.claim_refund().detach();
    context("factory.test.near", 0);
    assert!(f.on_refund("alice.test.near".parse().unwrap(), U128(f.funding), Ok(())));
    assert_eq!(f.refund_liability, 0);
    let refund = f.get_refund("alice.test.near".parse().unwrap());
    assert_eq!(refund.available.0, 0);
    assert_eq!(refund.in_flight.0, 0);
}

#[test]
fn same_salt_cannot_front_run_a_different_creator() {
    let f = factory();
    let salt = "ab".repeat(32);
    let a = f.predict_vault("alice.test.near".parse().unwrap(), salt.clone());
    let b = f.predict_vault("bob.test.near".parse().unwrap(), salt);
    assert_ne!(a, b);
    assert!(a.as_str().ends_with(".factory.test.near"));
    assert!(a.as_str().len() <= 64);
}

#[test]
#[should_panic(expected = "Creation already requested")]
fn rejects_duplicate_creation_in_flight() {
    let mut f = factory();
    let salt = "ab".repeat(32);
    request(&mut f, "alice.test.near", &salt);
    request(&mut f, "alice.test.near", &salt);
}

#[test]
#[should_panic(expected = "Creation is not pending")]
fn callback_cannot_credit_refund_twice() {
    let mut f = factory();
    request(&mut f, "alice.test.near", &"ab".repeat(32));
    context("factory.test.near", 0);
    f.on_created(0, Err(PromiseError::Failed));
    f.on_created(0, Err(PromiseError::Failed));
}

#[test]
#[should_panic(expected = "Refund is already in flight")]
fn rejects_concurrent_refund_claims_even_when_new_credits_arrive() {
    let mut f = factory();
    request(&mut f, "alice.test.near", &"ab".repeat(32));
    context("factory.test.near", 0);
    f.on_created(0, Err(PromiseError::Failed));
    context("alice.test.near", 1);
    f.claim_refund().detach();
    request(&mut f, "alice.test.near", &"cd".repeat(32));
    context("factory.test.near", 0);
    f.on_created(1, Err(PromiseError::Failed));
    context("alice.test.near", 1);
    f.claim_refund().detach();
}

#[test]
#[should_panic(expected = "No available refund")]
fn other_user_cannot_claim_failed_creation_funds() {
    let mut f = factory();
    request(&mut f, "alice.test.near", &"ab".repeat(32));
    context("factory.test.near", 0);
    f.on_created(0, Err(PromiseError::Failed));
    context("mallory.test.near", 1);
    f.claim_refund().detach();
}

#[test]
#[should_panic(expected = "Attach exact creation deposit")]
fn rejects_underfunded_creation() {
    let mut f = factory();
    context("alice.test.near", f.funding);
    f.create_vault("ab".repeat(32)).detach();
}
