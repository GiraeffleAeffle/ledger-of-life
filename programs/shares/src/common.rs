use anchor_lang::prelude::*;
use crate::token::Price;
pub const SCALE: u128 = 1_000_000;
pub const OFFSET: u128 = 1_000_000_000_000;
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;
mod wide { uint::construct_uint! { pub struct U256(4); } }
use wide::U256;
pub fn mul_div(a: u128, b: u128, d: u128) -> Result<u128> {
    require!(d != 0, ErrorCode::Overflow);
    let n = U256::from(a) * U256::from(b) / U256::from(d);
    require!(n <= U256::from(u128::MAX), ErrorCode::Overflow);
    Ok(n.as_u128())
}
pub fn remainder(a:u128,b:u128,d:u128)->Result<u128> {
    require!(d!=0,ErrorCode::Overflow);
    Ok(((U256::from(a)*U256::from(b))%U256::from(d)).as_u128())
}
pub fn up(a: u128, b: u128, d: u128) -> Result<u128> {
    let floor = mul_div(a,b,d)?;
    let remainder = (U256::from(a) * U256::from(b)) % U256::from(d);
    floor.checked_add(if remainder.is_zero() { 0 } else { 1 }).ok_or(error!(ErrorCode::Overflow))
}
pub fn add(a: u128,b: u128)->Result<u128> { a.checked_add(b).ok_or(error!(ErrorCode::Overflow)) }
pub fn sub(a: u128,b: u128)->Result<u128> { a.checked_sub(b).ok_or(error!(ErrorCode::InvalidAmount)) }
pub fn as_u64(a:u128)->Result<u64> { u64::try_from(a).map_err(|_|error!(ErrorCode::Overflow)) }
pub fn max_price_age(now:i64)->i64 {
    let weekday=(now/86400+4)%7;
    if weekday==6 || weekday==0 || (weekday==1 && now%86400<43200) {74*3600} else {26*3600}
}
pub fn fresh_price(p:&Price)->Result<u64> {
    let now=Clock::get()?.unix_timestamp;
    require!(p.price_usd_e6>0 && p.published_at>0 && p.published_at<=now && now-p.published_at<=max_price_age(now),ErrorCode::StaleOracle);
    Ok(p.price_usd_e6)
}
#[error_code]
pub enum ErrorCode {
    #[msg("The signer is not authorized")] Unauthorized,
    #[msg("Invalid configuration")] InvalidConfiguration,
    #[msg("Invalid state or deadline")] InvalidState,
    #[msg("Invalid amount")] InvalidAmount,
    #[msg("Arithmetic overflow")] Overflow,
    #[msg("Price is stale or unavailable")] StaleOracle,
    #[msg("Insufficient collateral")] Undercollateralized,
    #[msg("Insufficient pool cash")] InsufficientLiquidity,
    #[msg("Pool utilization exceeds 90 percent")] UtilizationExceeded,
    #[msg("Position is not liquidatable")] NotLiquidatable,
    #[msg("Faucet cooldown has not elapsed")] Cooldown,
    #[msg("Price updates must be at least one hour apart")] PushTooSoon,
    #[msg("Price change exceeds twenty percent")] StepTooLarge,
    #[msg("Global daily share faucet budget exhausted")] FaucetBudgetExceeded,
    #[msg("Aggregate faucet-backed pool debt exposure cap exceeded")] DebtExposureExceeded,
}
