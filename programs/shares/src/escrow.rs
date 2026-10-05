use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::{common::fresh_price, token::Price};

pub const INITIAL_RATIO_BPS: u64 = 15_000;
pub const TOP_UP_RATIO_BPS: u64 = 12_500;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowState { AwaitingLock, Active, ClaimPending, ClaimContested, Closed }

#[account]
pub struct Escrow {
    pub tenant: Pubkey,
    pub landlord: Pubkey,
    pub arbitrator: Pubkey,
    pub share_mint: Pubkey,
    pub agreement_hash: [u8; 32],
    pub deposit_value: u64,
    pub response_window: i64,
    pub return_window: i64,
    pub arbitration_window: i64,
    pub response_deadline: i64,
    pub return_deadline: i64,
    pub arbitration_started_at: i64,
    pub arbitration_authorized: bool,
    pub state: EscrowState,
    pub tracked_balance: u64,
    pub landlord_owed: u64,
    pub claim_usd6: u64,
    pub claim_shares: u64,
    pub claim_evidence_hash: [u8; 32],
    pub claim_price6: u64,
    pub claim_source_time: i64,
    pub bump: u8,
    pub vault_bump: u8,
}
impl Escrow { pub const SPACE: usize = 8 + 4 * 32 + 32 + 8 + 6 * 8 + 2 + 4 * 8 + 32 + 8 + 8 + 2; }

#[derive(Accounts)]
#[instruction(agreement_hash: [u8; 32])]
pub struct InitializeEscrow<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    pub landlord: Signer<'info>,
    #[account(seeds = [b"share_mint"], bump, mint::decimals = 6)]
    pub share_mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = Escrow::SPACE, seeds = [b"escrow", landlord.key().as_ref(), agreement_hash.as_ref()], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(init, payer = payer, seeds = [b"escrow_vault", escrow.key().as_ref()], bump, token::mint = share_mint, token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct EscrowAction<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow.landlord.as_ref(), escrow.agreement_hash.as_ref()], bump = escrow.bump, has_one = share_mint)]
    pub escrow: Account<'info, Escrow>,
    #[account(seeds = [b"share_mint"], bump, mint::decimals = 6)]
    pub share_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"escrow_vault", escrow.key().as_ref()], bump = escrow.vault_bump, token::mint = share_mint, token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = share_mint, constraint = share_account.key() != vault.key() @ EscrowError::InvalidConfiguration)]
    pub share_account: Account<'info, TokenAccount>,
    #[account(seeds = [b"price", share_mint.key().as_ref()], bump = price.bump, has_one = share_mint)]
    pub price: Account<'info, Price>,
    pub token_program: Program<'info, Token>,
}

pub fn initialize_escrow(ctx: Context<InitializeEscrow>, agreement_hash: [u8; 32], tenant: Pubkey, arbitrator: Pubkey, deposit_value: u64, response_window: i64, return_window: i64, arbitration_window: i64) -> Result<()> {
    let landlord = ctx.accounts.landlord.key();
    require!(tenant != Pubkey::default() && arbitrator != Pubkey::default() && landlord != Pubkey::default() && tenant != landlord && tenant != arbitrator && landlord != arbitrator && agreement_hash != [0;32] && (1_000_000..=10_000_000_000).contains(&deposit_value), EscrowError::InvalidConfiguration);
    for window in [response_window, return_window, arbitration_window] { require!((3600..=400 * 86400).contains(&window), EscrowError::InvalidConfiguration); }
    let e = &mut ctx.accounts.escrow;
    e.tenant = tenant; e.landlord = landlord; e.arbitrator = arbitrator;
    e.share_mint = ctx.accounts.share_mint.key(); e.agreement_hash = agreement_hash;
    e.deposit_value = deposit_value; e.response_window = response_window;
    e.return_window = return_window; e.arbitration_window = arbitration_window;
    e.state = EscrowState::AwaitingLock; e.bump = ctx.bumps.escrow; e.vault_bump = ctx.bumps.vault;
    emit!(EscrowInitialized { escrow: e.key(), agreement_hash, tenant, landlord, arbitrator, deposit_value });
    Ok(())
}
fn now() -> Result<i64> { Ok(Clock::get()?.unix_timestamp) }
fn deadline(start: i64, window: i64) -> Result<i64> { start.checked_add(window).ok_or_else(|| error!(EscrowError::Overflow)) }
fn actor(ctx: &Context<EscrowAction>, expected: Pubkey) -> Result<()> { require_keys_eq!(ctx.accounts.authority.key(), expected, EscrowError::Unauthorized); Ok(()) }
fn shares_for(usd: u64, price: u64, ceil: bool) -> Result<u64> {
    require!(price > 0, EscrowError::InvalidAmount);
    let n = (usd as u128) * 1_000_000;
    let q = if ceil { n.div_ceil(price as u128) } else { n / price as u128 };
    u64::try_from(q).map_err(|_| error!(EscrowError::Overflow))
}
fn covered(e: &Escrow, balance: u64, price: u64) -> bool {
    let numerator = (e.deposit_value as u128) * (INITIAL_RATIO_BPS as u128) * 1_000_000;
    let denominator = (price as u128) * 10_000;
    denominator != 0 && (balance as u128) >= numerator.div_ceil(denominator)
}
fn push(ctx: &Context<EscrowAction>, recipient: Pubkey, amount: u64) -> Result<()> {
    require_keys_eq!(ctx.accounts.share_account.owner, recipient, EscrowError::Unauthorized);
    if amount == 0 { return Ok(()); }
    let e = &ctx.accounts.escrow;
    let bump = [e.bump];
    let seeds: &[&[u8]] = &[b"escrow", e.landlord.as_ref(), e.agreement_hash.as_ref(), &bump];
    token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.share_account.to_account_info(), authority: e.to_account_info() }, &[seeds]), amount)
}
fn close(e: &mut Account<Escrow>, decision_maker: Pubkey, shares: u64) {
    e.state = EscrowState::Closed; e.landlord_owed = shares; e.response_deadline = 0; e.return_deadline = 0; e.arbitration_authorized = false;
    emit!(EscrowClosed { escrow: e.key(), decision_maker, landlord_shares: shares });
}
fn authorize(e: &mut Escrow, timestamp: i64) { if !e.arbitration_authorized { e.arbitration_authorized = true; e.arbitration_started_at = timestamp; } }

pub fn pledge(ctx: Context<EscrowAction>, shares: u64) -> Result<()> {
    actor(&ctx, ctx.accounts.escrow.tenant)?;
    require!(ctx.accounts.escrow.state != EscrowState::Closed, EscrowError::InvalidState);
    require!(shares > 0, EscrowError::InvalidAmount);
    require_keys_eq!(ctx.accounts.share_account.owner, ctx.accounts.escrow.tenant, EscrowError::Unauthorized);
    let balance = ctx.accounts.vault.amount.checked_add(shares).ok_or(EscrowError::Overflow)?;
    let tracked = ctx.accounts.escrow.tracked_balance.checked_add(shares).ok_or(EscrowError::Overflow)?;
    token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.share_account.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.authority.to_account_info() }), shares)?;
    let e = &mut ctx.accounts.escrow;
    e.tracked_balance = tracked;
    // Pledges remain available even while the oracle is stale; only activation needs freshness.
    if e.state == EscrowState::AwaitingLock {
        if let Ok(p) = fresh_price(&ctx.accounts.price) { if covered(e, balance, p) { e.state = EscrowState::Active; emit!(EscrowActivated { escrow: e.key(), balance, price6: p, source_time: ctx.accounts.price.published_at }); } }
    }
    emit!(EscrowPledged { escrow: e.key(), shares, price6: ctx.accounts.price.price_usd_e6, source_time: ctx.accounts.price.published_at });
    Ok(())
}
pub fn activate(ctx: Context<EscrowAction>) -> Result<()> {
    require!(ctx.accounts.escrow.state == EscrowState::AwaitingLock, EscrowError::InvalidState);
    let p = fresh_price(&ctx.accounts.price)?;
    require!(covered(&ctx.accounts.escrow, ctx.accounts.vault.amount, p), EscrowError::Undercollateralized);
    ctx.accounts.escrow.state = EscrowState::Active;
    emit!(EscrowActivated { escrow: ctx.accounts.escrow.key(), balance: ctx.accounts.vault.amount, price6: p, source_time: ctx.accounts.price.published_at }); Ok(())
}
pub fn withdraw(ctx: Context<EscrowAction>, shares: u64) -> Result<()> {
    actor(&ctx, ctx.accounts.escrow.tenant)?;
    let e = &ctx.accounts.escrow;
    require!(matches!(e.state, EscrowState::AwaitingLock | EscrowState::Active), EscrowError::InvalidState);
    require!(shares > 0 && shares <= ctx.accounts.vault.amount, EscrowError::InvalidAmount);
    let remainder = ctx.accounts.vault.amount - shares;
    let (p,t) = if e.state == EscrowState::Active { let p = fresh_price(&ctx.accounts.price)?; require!(covered(e, remainder, p), EscrowError::Undercollateralized); (p,ctx.accounts.price.published_at) } else { (0,0) };
    push(&ctx, e.tenant, shares)?;
    ctx.accounts.escrow.tracked_balance = ctx.accounts.escrow.tracked_balance.min(remainder);
    emit!(EscrowWithdrawn { escrow: ctx.accounts.escrow.key(), shares, price6: p, source_time: t }); Ok(())
}
pub fn propose_claim(ctx: Context<EscrowAction>, usd6: u64, evidence_hash: [u8;32]) -> Result<()> {
    actor(&ctx, ctx.accounts.escrow.landlord)?;
    let timestamp = now()?;
    let e = &mut ctx.accounts.escrow;
    require!(e.state == EscrowState::Active && (e.return_deadline == 0 || timestamp < e.return_deadline), EscrowError::InvalidState);
    require!(usd6 <= e.deposit_value, EscrowError::InvalidAmount);
    let (shares,p,t) = if usd6 == 0 { (0,0,0) } else { let p = fresh_price(&ctx.accounts.price)?; (shares_for(usd6,p,true)?.min(ctx.accounts.vault.amount),p,ctx.accounts.price.published_at) };
    e.claim_usd6 = usd6; e.claim_shares = shares; e.claim_evidence_hash = evidence_hash; e.claim_price6 = p; e.claim_source_time = t; e.return_deadline = 0;
    emit!(EscrowClaimProposed { escrow: e.key(), usd6, shares, evidence_hash, price6: p, source_time: t });
    if usd6 == 0 { close(e,ctx.accounts.authority.key(),0); } else { e.state = EscrowState::ClaimPending; e.response_deadline = deadline(timestamp,e.response_window)?; } Ok(())
}
pub fn accept_claim(ctx: Context<EscrowAction>, max_shares: u64) -> Result<()> {
    actor(&ctx,ctx.accounts.escrow.tenant)?;
    let e = &mut ctx.accounts.escrow;
    require!(e.state == EscrowState::ClaimPending, EscrowError::InvalidState);
    require!(e.claim_shares <= max_shares, EscrowError::InvalidAmount);
    require!(!e.arbitration_authorized || now()? < deadline(e.arbitration_started_at,e.arbitration_window)?, EscrowError::InvalidState);
    let shares = e.claim_shares; close(e,ctx.accounts.authority.key(),shares); Ok(())
}
pub fn contest_claim(ctx: Context<EscrowAction>) -> Result<()> {
    actor(&ctx,ctx.accounts.escrow.tenant)?;
    let e = &mut ctx.accounts.escrow;
    require!(e.state == EscrowState::ClaimPending, EscrowError::InvalidState);
    authorize(e,now()?); e.state = EscrowState::ClaimContested;
    emit!(EscrowClaimContested { escrow: e.key() }); Ok(())
}
pub fn escalate_claim(ctx: Context<EscrowAction>) -> Result<()> {
    let timestamp = now()?; let e = &mut ctx.accounts.escrow;
    require!(e.state == EscrowState::ClaimPending && timestamp >= e.response_deadline, EscrowError::InvalidState);
    authorize(e,timestamp); e.state = EscrowState::ClaimContested;
    emit!(EscrowClaimEscalated { escrow: e.key() }); Ok(())
}
pub fn lower_claim(ctx: Context<EscrowAction>, usd6: u64) -> Result<()> {
    actor(&ctx,ctx.accounts.escrow.landlord)?;
    let e = &mut ctx.accounts.escrow;
    require!(matches!(e.state, EscrowState::ClaimPending | EscrowState::ClaimContested), EscrowError::InvalidState);
    require!(usd6 < e.claim_usd6, EscrowError::InvalidAmount);
    let shares = shares_for(usd6,e.claim_price6,false)?.min(e.claim_shares);
    e.claim_usd6 = usd6; e.claim_shares = shares;
    if usd6 == 0 { close(e,ctx.accounts.authority.key(),0); } else { e.state = EscrowState::ClaimPending; }
    emit!(EscrowClaimLowered { escrow: e.key(), usd6, shares, price6: e.claim_price6, source_time: e.claim_source_time, response_deadline: e.response_deadline }); Ok(())
}
pub fn request_return(ctx: Context<EscrowAction>) -> Result<()> {
    actor(&ctx,ctx.accounts.escrow.tenant)?; let e = &mut ctx.accounts.escrow;
    require!(e.state == EscrowState::Active && e.return_deadline == 0, EscrowError::InvalidState);
    e.return_deadline = deadline(now()?,e.return_window)?;
    emit!(EscrowReturnRequested { escrow: e.key(), deadline: e.return_deadline }); Ok(())
}
pub fn close_unclaimed(ctx: Context<EscrowAction>) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    require!(e.state == EscrowState::Active && e.return_deadline != 0 && now()? >= e.return_deadline, EscrowError::InvalidState);
    close(e,ctx.accounts.authority.key(),0); Ok(())
}
pub fn close_unresolved(ctx: Context<EscrowAction>) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    require!(e.arbitration_authorized && matches!(e.state, EscrowState::ClaimPending | EscrowState::ClaimContested) && now()? >= deadline(e.arbitration_started_at,e.arbitration_window)?, EscrowError::InvalidState);
    close(e,ctx.accounts.authority.key(),0); Ok(())
}
pub fn resolve_claim(ctx: Context<EscrowAction>, shares: u64) -> Result<()> {
    actor(&ctx,ctx.accounts.escrow.arbitrator)?; let e = &mut ctx.accounts.escrow;
    require!(e.arbitration_authorized && matches!(e.state, EscrowState::ClaimPending | EscrowState::ClaimContested) && now()? < deadline(e.arbitration_started_at,e.arbitration_window)?, EscrowError::InvalidState);
    let award = shares.min(e.claim_shares); close(e,ctx.accounts.authority.key(),award); Ok(())
}
pub fn payout(ctx: Context<EscrowAction>, to_landlord: bool) -> Result<()> {
    let e = &ctx.accounts.escrow;
    require!(e.state == EscrowState::Closed, EscrowError::InvalidState);
    let reserved = e.landlord_owed.min(ctx.accounts.vault.amount);
    let amount = if to_landlord { reserved } else { ctx.accounts.vault.amount - reserved };
    let recipient = if to_landlord { e.landlord } else { e.tenant };
    push(&ctx,recipient,amount)?;
    let e = &mut ctx.accounts.escrow;
    if to_landlord { e.tracked_balance = e.tracked_balance.saturating_sub(e.landlord_owed); e.landlord_owed = 0; } else { e.tracked_balance = e.landlord_owed; }
    emit!(EscrowPaid { escrow: e.key(), recipient, shares: amount }); Ok(())
}

#[error_code]
pub enum EscrowError {
    #[msg("Unauthorized escrow actor or recipient")] Unauthorized,
    #[msg("Invalid immutable escrow terms")] InvalidConfiguration,
    #[msg("Invalid escrow state or deadline")] InvalidState,
    #[msg("Invalid amount or exceeded consent cap")] InvalidAmount,
    #[msg("Shares do not provide 150 percent cover")] Undercollateralized,
    #[msg("Arithmetic overflow")] Overflow,
}
#[event] pub struct EscrowInitialized { pub escrow: Pubkey, pub agreement_hash: [u8;32], pub tenant: Pubkey, pub landlord: Pubkey, pub arbitrator: Pubkey, pub deposit_value: u64 }
#[event] pub struct EscrowPledged { pub escrow: Pubkey, pub shares: u64, pub price6: u64, pub source_time: i64 }
#[event] pub struct EscrowActivated { pub escrow: Pubkey, pub balance: u64, pub price6: u64, pub source_time: i64 }
#[event] pub struct EscrowWithdrawn { pub escrow: Pubkey, pub shares: u64, pub price6: u64, pub source_time: i64 }
#[event] pub struct EscrowClaimProposed { pub escrow: Pubkey, pub usd6: u64, pub shares: u64, pub evidence_hash: [u8;32], pub price6: u64, pub source_time: i64 }
#[event] pub struct EscrowClaimContested { pub escrow: Pubkey }
#[event] pub struct EscrowClaimEscalated { pub escrow: Pubkey }
#[event] pub struct EscrowClaimLowered { pub escrow: Pubkey, pub usd6: u64, pub shares: u64, pub price6: u64, pub source_time: i64, pub response_deadline: i64 }
#[event] pub struct EscrowReturnRequested { pub escrow: Pubkey, pub deadline: i64 }
#[event] pub struct EscrowClosed { pub escrow: Pubkey, pub decision_maker: Pubkey, pub landlord_shares: u64 }
#[event] pub struct EscrowPaid { pub escrow: Pubkey, pub recipient: Pubkey, pub shares: u64 }
