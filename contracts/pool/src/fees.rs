pub const DEPOSIT_FEE_BPS: u16 = 15;
pub const WITHDRAWAL_FEE_BPS: u16 = 15;
const BPS_DENOMINATOR: u128 = 10_000;

// Integer yoctoNEAR, rounded down. Division first avoids u128 multiplication overflow.
fn calculate(amount: u128, bps: u16) -> u128 {
    amount / BPS_DENOMINATOR * bps as u128
        + amount % BPS_DENOMINATOR * bps as u128 / BPS_DENOMINATOR
}
pub fn deposit_fee(amount: u128) -> u128 {
    calculate(amount, DEPOSIT_FEE_BPS)
}
pub fn withdrawal_fee(amount: u128) -> u128 {
    calculate(amount, WITHDRAWAL_FEE_BPS)
}
