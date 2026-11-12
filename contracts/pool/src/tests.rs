use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::{test_utils::VMContextBuilder, testing_env};

fn vector() -> Value {
    serde_json::from_str(include_str!("../../../test-vectors/spend.json")).unwrap()
}
fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap().into()
}
fn context(predecessor: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("pool.test.near".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}
fn init(v: &Value) -> Pool {
    context("pool.test.near", 10u128.pow(24));
    Pool::new(
        "sandbox".into(),
        U128(10u128.pow(24)),
        serde_json::from_value(v["verificationKey"].clone()).unwrap(),
        "treasury.test.near".parse().unwrap(),
    )
}
fn args(v: &Value, name: &str) -> (Base64VecU8, Vec<String>) {
    (
        serde_json::from_value(v[name]["proof"].clone()).unwrap(),
        serde_json::from_value(v[name]["public_inputs"].clone()).unwrap(),
    )
}
fn deposited(v: &Value) -> Pool {
    let mut p = init(v);
    context(
        "sender.test.near",
        10u128.pow(24) + fees::deposit_fee(10u128.pow(24)) + FEE,
    );
    p.deposit(text(v, "inputCommitment"), text(v, "disclosureRoot"));
    assert_eq!(p.get_config().root, text(v, "root"));
    p
}
#[test]
fn real_proofs_transfer_and_withdraw() {
    let v = vector();
    let mut p = deposited(&v);
    assert_eq!(p.get_config().domain, text(&v, "domain"));
    let (proof, inputs) = args(&v, "transfer");
    context("relayer.test.near", FEE);
    p.transfer(
        text(&v, "outputCommitment"),
        text(&v, "disclosureRoot"),
        proof,
        inputs,
    );
    assert_eq!(p.get_config().root, text(&v, "nextRoot"));
    assert_eq!(p.outstanding, 1);
    let (proof, inputs) = args(&v, "withdrawal");
    context(
        "other-relayer.test.near",
        FEE + fees::withdrawal_fee(p.denomination),
    );
    p.withdraw(
        "receiver.test.near".parse().unwrap(),
        text(&v, "disclosureRoot"),
        proof,
        inputs.clone(),
    )
    .detach();
    assert!(p.is_spent(inputs[0].clone()));
    context("pool.test.near", 0);
    assert!(p.on_payout(inputs[0].clone(), Ok(())));
    assert_eq!(p.outstanding, 0);
    assert_eq!(p.pending_withdrawal_fees, 0);
    assert_eq!(
        p.accrued_protocol_fees,
        2 * fees::deposit_fee(p.denomination)
    );
    assert_eq!(
        p.get_payout(inputs[0].clone()).unwrap().state,
        PayoutState::Complete
    );
}
#[test]
fn failed_payout_retries_same_recipient_without_unspending() {
    let v = vector();
    let mut p = deposited(&v);
    let (proof, inputs) = args(&v, "transfer");
    context("relay.test.near", FEE);
    p.transfer(
        text(&v, "outputCommitment"),
        text(&v, "disclosureRoot"),
        proof,
        inputs,
    );
    let (proof, inputs) = args(&v, "withdrawal");
    context(
        "relay.test.near",
        FEE + fees::withdrawal_fee(p.denomination),
    );
    p.withdraw(
        "receiver.test.near".parse().unwrap(),
        text(&v, "disclosureRoot"),
        proof,
        inputs.clone(),
    )
    .detach();
    context("pool.test.near", 0);
    assert!(!p.on_payout(inputs[0].clone(), Err(PromiseError::Failed)));
    assert!(p.is_spent(inputs[0].clone()));
    assert_eq!(p.outstanding, 1);
    assert_eq!(
        p.pending_withdrawal_fees,
        fees::withdrawal_fee(p.denomination)
    );
    assert_eq!(p.accrued_protocol_fees, fees::deposit_fee(p.denomination));
    context("anyone.test.near", FEE);
    p.retry_withdrawal(inputs[0].clone()).detach();
    assert_eq!(
        p.get_payout(inputs[0].clone()).unwrap().recipient.as_str(),
        "receiver.test.near"
    );
    context("pool.test.near", 0);
    assert!(p.on_payout(inputs[0].clone(), Ok(())));
    assert_eq!(p.outstanding, 0);
    assert_eq!(p.pending_withdrawal_fees, 0);
    assert_eq!(
        p.accrued_protocol_fees,
        2 * fees::deposit_fee(p.denomination)
    );
}

#[test]
fn quotes_add_both_fees_without_reducing_the_principal() {
    let p = init(&vector());
    let c = p.get_config();
    assert_eq!(c.deposit_fee_bps, 15);
    assert_eq!(c.withdrawal_fee_bps, 15);
    assert_eq!(c.deposit_protocol_fee.0, 1_500_000_000_000_000_000_000);
    assert_eq!(c.deposit_attached.0, 1_021_500_000_000_000_000_000_000);
    assert_eq!(c.withdrawal_attached.0, 21_500_000_000_000_000_000_000);
    assert_eq!(c.withdrawal_received.0, p.denomination);
    assert_eq!(fees::deposit_fee(9_999), 14);
    assert_eq!(fees::withdrawal_fee(10_000), 15);
    assert_eq!(fees::deposit_fee(1), 0);
    assert!(fees::deposit_fee(u128::MAX) < u128::MAX);
}

#[test]
#[should_panic(expected = "Attach denomination plus protocol fee")]
fn rejects_deposit_that_omits_the_add_on_fee() {
    let v = vector();
    let mut p = init(&v);
    context("sender.test.near", p.denomination + FEE);
    p.deposit(text(&v, "inputCommitment"), text(&v, "disclosureRoot"));
}

#[test]
#[should_panic(expected = "Attach withdrawal protocol fee")]
fn rejects_withdrawal_that_omits_the_add_on_fee() {
    let v = vector();
    let mut p = deposited(&v);
    let (proof, inputs) = args(&v, "transfer");
    context("relay.test.near", FEE);
    p.transfer(
        text(&v, "outputCommitment"),
        text(&v, "disclosureRoot"),
        proof,
        inputs,
    );
    let (proof, inputs) = args(&v, "withdrawal");
    context("relay.test.near", FEE);
    p.withdraw(
        "receiver.test.near".parse().unwrap(),
        text(&v, "disclosureRoot"),
        proof,
        inputs,
    )
    .detach();
}

#[test]
fn collection_moves_only_earned_fees_to_the_fixed_recipient_and_restores_failures() {
    use near_sdk::{mock::MockAction, test_utils::get_created_receipts};
    let v = vector();
    let mut p = deposited(&v);
    let expected = fees::deposit_fee(p.denomination);
    context("anyone.test.near", 1);
    p.collect_protocol_fees().detach();
    assert_eq!(p.outstanding, 1);
    assert_eq!(p.accrued_protocol_fees, 0);
    assert_eq!(p.fee_payout_in_flight, expected);
    assert!(get_created_receipts().iter().any(|r| {
        r.receiver_id == p.fee_recipient && r.actions.iter().any(|a|
        matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == expected))
    }));
    context("pool.test.near", 0);
    assert!(!p.on_fee_payout(U128(expected), Err(PromiseError::Failed)));
    assert_eq!(p.accrued_protocol_fees, expected);
    assert_eq!(p.fee_payout_in_flight, 0);
    context("anyone.test.near", 1);
    p.collect_protocol_fees().detach();
    context("pool.test.near", 0);
    assert!(p.on_fee_payout(U128(expected), Ok(())));
    assert_eq!(p.accrued_protocol_fees, 0);
    assert_eq!(p.fee_payout_in_flight, 0);
    assert_eq!(p.outstanding, 1);
}

#[test]
#[should_panic(expected = "Fee collection already in flight")]
fn cannot_collect_fees_twice_while_transfer_is_pending() {
    let mut p = deposited(&vector());
    context("anyone.test.near", 1);
    p.collect_protocol_fees().detach();
    context("anyone.test.near", 1);
    p.collect_protocol_fees().detach();
}

#[test]
#[should_panic(expected = "Fee collection is not in flight")]
fn fee_callback_cannot_be_settled_twice() {
    let mut p = deposited(&vector());
    let expected = p.accrued_protocol_fees;
    context("anyone.test.near", 1);
    p.collect_protocol_fees().detach();
    context("pool.test.near", 0);
    p.on_fee_payout(U128(expected), Ok(()));
    p.on_fee_payout(U128(expected), Ok(()));
}
#[test]
#[should_panic(expected = "Wrong action binding")]
fn rejects_changed_output() {
    let v = vector();
    let mut p = deposited(&v);
    let (proof, inputs) = args(&v, "transfer");
    context("relay.test.near", FEE);
    p.transfer("123".into(), text(&v, "disclosureRoot"), proof, inputs);
}
#[test]
#[should_panic(expected = "Note already spent")]
fn rejects_double_spend() {
    let v = vector();
    let mut p = deposited(&v);
    let (proof, inputs) = args(&v, "transfer");
    context("relay.test.near", FEE);
    p.spent.insert(&parse(&inputs[0]));
    p.transfer(
        text(&v, "outputCommitment"),
        text(&v, "disclosureRoot"),
        proof,
        inputs,
    );
}
#[test]
fn rejects_forged_proof_and_malleable_fields() {
    let v = vector();
    let p = deposited(&v);
    let (proof, inputs) = args(&v, "transfer");
    let fields: Vec<Field> = inputs.iter().map(|x| parse(x)).collect();
    let mut changed = fields.clone();
    changed[1] = parse("42");
    assert!(!crypto::verify(&p.verifier, &proof.0, &changed));
    assert!(!crypto::verify(&p.verifier, &[0u8; 256], &fields));
    assert!(std::panic::catch_unwind(|| parse("01")).is_err());
    assert!(std::panic::catch_unwind(|| parse(
        "21888242871839275222246405745257275088548364400416034343698204186575808495617"
    ))
    .is_err());
}
#[test]
#[should_panic(expected = "Wrong pool domain")]
fn rejects_cross_pool_replay() {
    let v = vector();
    let mut p = deposited(&v);
    let (proof, mut inputs) = args(&v, "transfer");
    inputs[4] = "42".into();
    context("relay.test.near", FEE);
    p.transfer(
        text(&v, "outputCommitment"),
        text(&v, "disclosureRoot"),
        proof,
        inputs,
    );
}
#[test]
#[should_panic(expected = "Attach denomination plus protocol fee and storage fee")]
fn rejects_underfunded_deposit() {
    let v = vector();
    let mut p = init(&v);
    context("sender.test.near", FEE);
    p.deposit(text(&v, "inputCommitment"), text(&v, "disclosureRoot"));
}

#[test]
fn factory_bootstrap_accepts_only_direct_parent_and_preserves_domain() {
    let v = vector();
    context("test.near", INIT_RESERVE_FOR_TEST);
    let p = Pool::new_from_factory(
        "sandbox".into(),
        U128(10u128.pow(24)),
        near_sdk::serde_json::from_value(v["verificationKey"].clone()).unwrap(),
        "treasury.test.near".parse().unwrap(),
    );
    assert_eq!(p.get_config().domain, text(&v, "domain"));
    assert_eq!(p.get_config().outstanding_notes, 0);
}

const INIT_RESERVE_FOR_TEST: u128 = 1_000_000_000_000_000_000_000_000;

#[test]
#[should_panic(expected = "Only the direct parent factory")]
fn rejects_bootstrap_from_unrelated_account() {
    let v = vector();
    context("other.test.near", INIT_RESERVE_FOR_TEST);
    Pool::new_from_factory(
        "sandbox".into(),
        U128(10u128.pow(24)),
        near_sdk::serde_json::from_value(v["verificationKey"].clone()).unwrap(),
        "treasury.test.near".parse().unwrap(),
    );
}

#[test]
#[should_panic(expected = "Only the direct parent factory")]
fn rejects_bootstrap_from_ancestor_account() {
    let v = vector();
    context("near", INIT_RESERVE_FOR_TEST);
    Pool::new_from_factory(
        "sandbox".into(),
        U128(10u128.pow(24)),
        near_sdk::serde_json::from_value(v["verificationKey"].clone()).unwrap(),
        "treasury.test.near".parse().unwrap(),
    );
}
