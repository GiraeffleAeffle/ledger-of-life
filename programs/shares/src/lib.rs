use anchor_lang::prelude::*;
pub mod common;
pub mod token;
pub mod lending;
pub mod escrow;
pub use token::*;
pub use lending::*;
pub use escrow::*;
declare_id!("97j5CWWKUALG2XRUBoZ1spqtN5YWJPVdTiRLNN5CWYkQ");
#[program]
pub mod shares {
    use super::*;
    pub fn initialize_shares(ctx:Context<InitializeShares>,price_usd_e6:u64,published_at:i64)->Result<()> {token::initialize_shares(ctx,price_usd_e6,published_at)}
    pub fn faucet(ctx:Context<Faucet>)->Result<()> {token::faucet(ctx)}
    pub fn set_price(ctx:Context<SetPrice>,price_usd_e6:u64,published_at:i64)->Result<()> {token::set_price(ctx,price_usd_e6,published_at)}
    pub fn initialize_pool(ctx:Context<InitializePool>)->Result<()> {lending::initialize_pool(ctx)}
    pub fn lend(ctx:Context<PoolAction>,amount:u64)->Result<()> {lending::lend(ctx,amount)}
    pub fn withdraw_lending(ctx:Context<PoolAction>,amount:u64)->Result<()> {lending::withdraw_lending(ctx,amount)}
    pub fn redeem_lending(ctx:Context<PoolAction>,shares:u128)->Result<()> {lending::redeem_lending(ctx,shares)}
    pub fn deposit_collateral(ctx:Context<PoolAction>,amount:u64)->Result<()> {lending::deposit_collateral(ctx,amount)}
    pub fn withdraw_collateral(ctx:Context<PoolAction>,amount:u64)->Result<()> {lending::withdraw_collateral(ctx,amount)}
    pub fn borrow(ctx:Context<PoolAction>,amount:u64)->Result<()> {lending::borrow(ctx,amount)}
    pub fn repay(ctx:Context<PoolAction>,max_amount:u64)->Result<()> {lending::repay(ctx,max_amount)}
    pub fn liquidate(ctx:Context<PoolAction>,max_repay:u64)->Result<()> {lending::liquidate(ctx,max_repay)}
    pub fn realize_bad_debt(ctx:Context<PoolAction>)->Result<()> {lending::realize_bad_debt(ctx)}
    pub fn accrue(ctx:Context<Accrue>)->Result<()> {lending::accrue(ctx)}
    pub fn initialize_escrow(ctx:Context<InitializeEscrow>,agreement_hash:[u8;32],tenant:Pubkey,arbitrator:Pubkey,deposit_value:u64,response_window:i64,return_window:i64,arbitration_window:i64)->Result<()> {escrow::initialize_escrow(ctx,agreement_hash,tenant,arbitrator,deposit_value,response_window,return_window,arbitration_window)}
    pub fn pledge(ctx:Context<EscrowAction>,shares:u64)->Result<()> {escrow::pledge(ctx,shares)}
    pub fn activate(ctx:Context<EscrowAction>)->Result<()> {escrow::activate(ctx)}
    pub fn withdraw(ctx:Context<EscrowAction>,shares:u64)->Result<()> {escrow::withdraw(ctx,shares)}
    pub fn propose_claim(ctx:Context<EscrowAction>,usd6:u64,evidence_hash:[u8;32])->Result<()> {escrow::propose_claim(ctx,usd6,evidence_hash)}
    pub fn accept_claim(ctx:Context<EscrowAction>,max_shares:u64)->Result<()> {escrow::accept_claim(ctx,max_shares)}
    pub fn contest_claim(ctx:Context<EscrowAction>)->Result<()> {escrow::contest_claim(ctx)}
    pub fn escalate_claim(ctx:Context<EscrowAction>)->Result<()> {escrow::escalate_claim(ctx)}
    pub fn lower_claim(ctx:Context<EscrowAction>,usd6:u64)->Result<()> {escrow::lower_claim(ctx,usd6)}
    pub fn request_return(ctx:Context<EscrowAction>)->Result<()> {escrow::request_return(ctx)}
    pub fn close_unclaimed(ctx:Context<EscrowAction>)->Result<()> {escrow::close_unclaimed(ctx)}
    pub fn close_unresolved(ctx:Context<EscrowAction>)->Result<()> {escrow::close_unresolved(ctx)}
    pub fn resolve_claim(ctx:Context<EscrowAction>,shares:u64)->Result<()> {escrow::resolve_claim(ctx,shares)}
    pub fn payout(ctx:Context<EscrowAction>,to_landlord:bool)->Result<()> {escrow::payout(ctx,to_landlord)}
}
