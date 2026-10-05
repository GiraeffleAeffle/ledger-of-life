use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("CWUN8LKoKNEBJ6SQAVAqDFrb3rDP7vbVXMcf2EoAqjQM");
pub const SCALE: u128 = 1_000_000_000_000;
pub const UNIT: u128 = 1_000_000;
pub const CASH_MINT: Pubkey = pubkey!("BCgqGAUvbGobqXrJtEDS437i8r1FffVSGcnwCsHcN2oE");
pub const ADMIN: Pubkey = pubkey!("HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G");
pub const REWARD_DURATION: u64 = 604_800; // Same seven-day window as the deployed EVM distributor.

#[program]
pub mod house {
    use super::*;
    pub fn initialize_house(ctx: Context<InitializeHouse>, id: String, price_cash_per_unit: u64, sell_cap_units: u64) -> Result<()> {
        require!(!id.is_empty() && id.len() <= 32 && id.bytes().all(|b| (33..=126).contains(&b)), HouseError::InvalidId);
        require!(price_cash_per_unit > 0 && sell_cap_units > 0, HouseError::InvalidAmount);
        let h = &mut ctx.accounts.house;
        h.admin = ctx.accounts.admin.key(); h.cash_mint = ctx.accounts.cash_mint.key(); h.unit_mint = ctx.accounts.unit_mint.key();
        h.id[..id.len()].copy_from_slice(id.as_bytes()); h.id_len = id.len() as u8;
        h.bump = ctx.bumps.house; h.unit_mint_bump = ctx.bumps.unit_mint; h.desk_vault_bump = ctx.bumps.desk_vault; h.reward_vault_bump = ctx.bumps.reward_vault; h.stake_vault_bump = ctx.bumps.stake_vault;
        h.price_cash_per_unit = price_cash_per_unit; h.sell_cap_units = sell_cap_units;
        h.reward_duration = REWARD_DURATION;
        h.last_update_time = Clock::get()?.unix_timestamp;
        Ok(())
    }
    pub fn buy_units(ctx: Context<Trade>, units: u64) -> Result<()> {
        require!(units > 0, HouseError::InvalidAmount);
        let product = (units as u128).checked_mul(ctx.accounts.house.price_cash_per_unit as u128).ok_or(HouseError::Overflow)?;
        let cash = narrow(product.checked_add(UNIT - 1).ok_or(HouseError::Overflow)? / UNIT)?;
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.user_cash.to_account_info(), to: ctx.accounts.desk_vault.to_account_info(), authority: ctx.accounts.actor.to_account_info() }), cash)?;
        let h = &ctx.accounts.house;
        let seeds: &[&[u8]] = &[b"house", &h.id[..h.id_len as usize], &[h.bump]];
        token::mint_to(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), MintTo { mint: ctx.accounts.unit_mint.to_account_info(), to: ctx.accounts.user_units.to_account_info(), authority: h.to_account_info() }, &[seeds]), units)
    }
    pub fn sell_units(ctx: Context<Trade>, units: u64) -> Result<()> {
        let h = &ctx.accounts.house;
        require!(units > 0 && units <= h.sell_cap_units, HouseError::SellCap);
        let cash = narrow((units as u128).checked_mul(h.price_cash_per_unit as u128).ok_or(HouseError::Overflow)? / UNIT)?;
        require!(ctx.accounts.desk_vault.amount >= cash, HouseError::DeskShort);
        token::burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn { mint: ctx.accounts.unit_mint.to_account_info(), from: ctx.accounts.user_units.to_account_info(), authority: ctx.accounts.actor.to_account_info() }), units)?;
        let seeds: &[&[u8]] = &[b"house", &h.id[..h.id_len as usize], &[h.bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.desk_vault.to_account_info(), to: ctx.accounts.user_cash.to_account_info(), authority: h.to_account_info() }, &[seeds]), cash)
    }
    pub fn stake(ctx: Context<Stake>, units: u64) -> Result<()> {
        require!(units > 0, HouseError::InvalidAmount);
        let h = &mut ctx.accounts.house; let p = &mut ctx.accounts.position;
        let now = Clock::get()?.unix_timestamp;
        accrue(h, now)?;
        if p.house == Pubkey::default() { p.house = h.key(); p.owner = ctx.accounts.owner.key(); p.bump = ctx.bumps.position; p.reward_debt = h.reward_per_unit_stored; }
        require_keys_eq!(p.house, h.key(), HouseError::WrongPosition); require_keys_eq!(p.owner, ctx.accounts.owner.key(), HouseError::WrongPosition);
        settle(h, p)?;
        if p.staked == 0 { h.staker_count = h.staker_count.checked_add(1).ok_or(HouseError::Overflow)?; }
        let was_empty = h.total_staked == 0;
        p.staked = p.staked.checked_add(units).ok_or(HouseError::Overflow)?;
        h.total_staked = h.total_staked.checked_add(units).ok_or(HouseError::Overflow)?;
        if was_empty && (h.undistributed_scaled > 0 || (now >= h.period_finish && h.stream_remaining_scaled > 0)) {
            let budget = h.stream_remaining_scaled.checked_add(h.undistributed_scaled).ok_or(HouseError::Overflow)?;
            let duration = h.reward_duration;
            schedule(h, budget, duration, now)?;
        }
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.user_units.to_account_info(), to: ctx.accounts.stake_vault.to_account_info(), authority: ctx.accounts.owner.to_account_info() }), units)
    }
    pub fn unstake(ctx: Context<Unstake>, units: u64) -> Result<()> {
        require!(units > 0, HouseError::InvalidAmount);
        let h = &mut ctx.accounts.house; let p = &mut ctx.accounts.position;
        let now = Clock::get()?.unix_timestamp;
        accrue(h, now)?;
        settle(h, p)?;
        p.staked = p.staked.checked_sub(units).ok_or(HouseError::InvalidAmount)?;
        h.total_staked = h.total_staked.checked_sub(units).ok_or(HouseError::Overflow)?;
        let mut recycled = 0;
        if p.staked == 0 {
            h.staker_count = h.staker_count.checked_sub(1).ok_or(HouseError::Overflow)?;
            recycled = p.reward_fraction;
            p.reward_fraction = 0;
            h.undistributed_scaled = h.undistributed_scaled.checked_add(recycled).ok_or(HouseError::Overflow)?;
        }
        if h.total_staked == 0 {
            h.undistributed_scaled = h.undistributed_scaled.checked_add(h.reward_remainder_scaled).ok_or(HouseError::Overflow)?;
            h.reward_remainder_scaled = 0;
        } else if recycled > 0 {
            let duration = if h.period_finish > now { u64::try_from(h.period_finish.checked_sub(now).ok_or(HouseError::Overflow)?).map_err(|_| error!(HouseError::Overflow))? } else { h.reward_duration };
            let budget = h.stream_remaining_scaled.checked_add(h.undistributed_scaled).ok_or(HouseError::Overflow)?;
            schedule(h, budget, duration, now)?;
        }
        let seeds: &[&[u8]] = &[b"house", &h.id[..h.id_len as usize], &[h.bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.stake_vault.to_account_info(), to: ctx.accounts.user_units.to_account_info(), authority: h.to_account_info() }, &[seeds]), units)
    }
    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64, source: u8) -> Result<()> {
        require!(source < 4, HouseError::InvalidSource);
        // Zero is valid when a rent payment's 20% share rounds below one cash atom.
        // SPL Token enforces source ownership OR its approved delegate and allowance.
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.source.to_account_info(), to: ctx.accounts.reward_vault.to_account_info(), authority: ctx.accounts.authority.to_account_info() }), amount)?;
        let h = &mut ctx.accounts.house;
        let now = Clock::get()?.unix_timestamp;
        accrue(h, now)?;
        h.revenue_total = h.revenue_total.checked_add(amount).ok_or(HouseError::Overflow)?;
        h.revenue_by_source[source as usize] = h.revenue_by_source[source as usize].checked_add(amount).ok_or(HouseError::Overflow)?;
        if amount > 0 {
            let incoming = (amount as u128).checked_mul(SCALE).ok_or(HouseError::Overflow)?;
            let budget = h.stream_remaining_scaled.checked_add(h.undistributed_scaled).and_then(|n| n.checked_add(incoming)).ok_or(HouseError::Overflow)?;
            let duration = h.reward_duration;
            schedule(h, budget, duration, now)?;
        }
        emit!(RewardsDeposited { house: h.key(), source, amount, authority: ctx.accounts.authority.key() });
        Ok(())
    }
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let h = &mut ctx.accounts.house; let p = &mut ctx.accounts.position;
        accrue(h, Clock::get()?.unix_timestamp)?;
        settle(h, p)?; let amount = p.owed;
        p.claimed_total = p.claimed_total.checked_add(amount).ok_or(HouseError::Overflow)?; p.owed = 0;
        let seeds: &[&[u8]] = &[b"house", &h.id[..h.id_len as usize], &[h.bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.reward_vault.to_account_info(), to: ctx.accounts.user_cash.to_account_info(), authority: h.to_account_info() }, &[seeds]), amount)
    }
}
fn narrow(n: u128) -> Result<u64> { u64::try_from(n).map_err(|_| error!(HouseError::Overflow)) }
fn accrue(h: &mut House, now: i64) -> Result<()> {
    let applicable = now.min(h.period_finish);
    if applicable <= h.last_update_time { return Ok(()); }
    let elapsed = u128::try_from(applicable.checked_sub(h.last_update_time).ok_or(HouseError::Overflow)?).map_err(|_| error!(HouseError::Overflow))?;
    let emitted = if applicable == h.period_finish { h.stream_remaining_scaled } else { elapsed.checked_mul(h.reward_rate).ok_or(HouseError::Overflow)? };
    h.last_update_time = applicable;
    h.stream_remaining_scaled = h.stream_remaining_scaled.checked_sub(emitted).ok_or(HouseError::Overflow)?;
    if h.total_staked == 0 {
        h.undistributed_scaled = h.undistributed_scaled.checked_add(emitted).ok_or(HouseError::Overflow)?;
    } else {
        let available = emitted.checked_add(h.reward_remainder_scaled).ok_or(HouseError::Overflow)?;
        h.reward_per_unit_stored = h.reward_per_unit_stored.checked_add(available / h.total_staked as u128).ok_or(HouseError::Overflow)?;
        h.reward_remainder_scaled = available % h.total_staked as u128;
    }
    Ok(())
}
fn schedule(h: &mut House, budget: u128, duration: u64, now: i64) -> Result<()> {
    require!(duration > 0, HouseError::InvalidAmount);
    h.stream_remaining_scaled = budget;
    h.undistributed_scaled = 0;
    h.reward_rate = budget.checked_div(duration as u128).ok_or(HouseError::Overflow)?;
    h.last_update_time = now;
    h.period_finish = now.checked_add(i64::try_from(duration).map_err(|_| error!(HouseError::Overflow))?).ok_or(HouseError::Overflow)?;
    Ok(())
}
fn settle(h: &House, p: &mut Position) -> Result<()> {
    let delta = h.reward_per_unit_stored.checked_sub(p.reward_debt).ok_or(HouseError::Overflow)?;
    let scaled = (p.staked as u128).checked_mul(delta).and_then(|n| n.checked_add(p.reward_fraction)).ok_or(HouseError::Overflow)?;
    p.owed = p.owed.checked_add(narrow(scaled / SCALE)?).ok_or(HouseError::Overflow)?;
    p.reward_fraction = scaled % SCALE;
    p.reward_debt = h.reward_per_unit_stored;
    Ok(())
}
#[account]
pub struct House {
    pub admin: Pubkey, pub cash_mint: Pubkey, pub unit_mint: Pubkey,
    pub id: [u8; 32], pub id_len: u8,
    pub bump: u8, pub unit_mint_bump: u8, pub desk_vault_bump: u8, pub reward_vault_bump: u8, pub stake_vault_bump: u8,
    pub price_cash_per_unit: u64, pub sell_cap_units: u64, pub total_staked: u64,
    pub reward_per_unit_stored: u128, pub revenue_total: u64, pub revenue_by_source: [u64; 4], pub staker_count: u32,
    pub reward_duration: u64, pub reward_rate: u128, pub period_finish: i64, pub last_update_time: i64,
    pub stream_remaining_scaled: u128, pub undistributed_scaled: u128, pub reward_remainder_scaled: u128,
}
impl House { pub const LEN: usize = 314; }
#[account]
pub struct Position { pub house: Pubkey, pub owner: Pubkey, pub staked: u64, pub reward_debt: u128, pub owed: u64, pub claimed_total: u64, pub bump: u8, pub reward_fraction: u128 }
impl Position { pub const LEN: usize = 129; }
#[event]
pub struct RewardsDeposited { pub house: Pubkey, pub source: u8, pub amount: u64, pub authority: Pubkey }

#[derive(Accounts)]
#[instruction(id: String)]
pub struct InitializeHouse<'info> {
    #[account(mut, address = ADMIN)] pub admin: Signer<'info>,
    #[account(init, payer = admin, space = House::LEN, seeds = [b"house", id.as_bytes()], bump)] pub house: Account<'info, House>,
    #[account(address = CASH_MINT, constraint = cash_mint.decimals == 6)] pub cash_mint: Account<'info, Mint>,
    #[account(init, payer = admin, seeds = [b"units", house.key().as_ref()], bump, mint::decimals = 6, mint::authority = house)] pub unit_mint: Account<'info, Mint>,
    #[account(init, payer = admin, seeds = [b"desk", house.key().as_ref()], bump, token::mint = cash_mint, token::authority = house)] pub desk_vault: Account<'info, TokenAccount>,
    #[account(init, payer = admin, seeds = [b"rewards", house.key().as_ref()], bump, token::mint = cash_mint, token::authority = house)] pub reward_vault: Account<'info, TokenAccount>,
    #[account(init, payer = admin, seeds = [b"stake", house.key().as_ref()], bump, token::mint = unit_mint, token::authority = house)] pub stake_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>, pub system_program: Program<'info, System>, pub rent: Sysvar<'info, Rent>,
}
#[derive(Accounts)]
pub struct Trade<'info> {
    pub actor: Signer<'info>,
    #[account(mut, seeds = [b"house", &house.id[..house.id_len as usize]], bump = house.bump)] pub house: Account<'info, House>,
    #[account(mut, seeds = [b"units", house.key().as_ref()], bump = house.unit_mint_bump, address = house.unit_mint, mint::authority = house, mint::decimals = 6)] pub unit_mint: Account<'info, Mint>,
    #[account(mut, token::mint = house.cash_mint, token::authority = actor)] pub user_cash: Account<'info, TokenAccount>,
    #[account(mut, token::mint = unit_mint, token::authority = actor)] pub user_units: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"desk", house.key().as_ref()], bump = house.desk_vault_bump, token::mint = house.cash_mint, token::authority = house)] pub desk_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct Stake<'info> {
    pub owner: Signer<'info>, #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, seeds = [b"house", &house.id[..house.id_len as usize]], bump = house.bump)] pub house: Account<'info, House>,
    #[account(init_if_needed, payer = payer, space = Position::LEN, seeds = [b"position", house.key().as_ref(), owner.key().as_ref()], bump)] pub position: Account<'info, Position>,
    #[account(mut, token::mint = house.unit_mint, token::authority = owner)] pub user_units: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"stake", house.key().as_ref()], bump = house.stake_vault_bump, token::mint = house.unit_mint, token::authority = house)] pub stake_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>, pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"house", &house.id[..house.id_len as usize]], bump = house.bump)] pub house: Account<'info, House>,
    #[account(mut, seeds = [b"position", house.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = house, has_one = owner)] pub position: Account<'info, Position>,
    #[account(mut, token::mint = house.unit_mint, token::authority = owner)] pub user_units: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"stake", house.key().as_ref()], bump = house.stake_vault_bump, token::mint = house.unit_mint, token::authority = house)] pub stake_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct DepositRewards<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"house", &house.id[..house.id_len as usize]], bump = house.bump)] pub house: Account<'info, House>,
    #[account(mut, token::mint = house.cash_mint)] pub source: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"rewards", house.key().as_ref()], bump = house.reward_vault_bump, token::mint = house.cash_mint, token::authority = house)] pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct Claim<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"house", &house.id[..house.id_len as usize]], bump = house.bump)] pub house: Account<'info, House>,
    #[account(mut, seeds = [b"position", house.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = house, has_one = owner)] pub position: Account<'info, Position>,
    #[account(mut, token::mint = house.cash_mint, token::authority = owner)] pub user_cash: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"rewards", house.key().as_ref()], bump = house.reward_vault_bump, token::mint = house.cash_mint, token::authority = house)] pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[error_code]
pub enum HouseError {
    #[msg("House id must be 1–32 printable ASCII bytes")] InvalidId,
    #[msg("Invalid amount")] InvalidAmount,
    #[msg("Checked arithmetic overflow")] Overflow,
    #[msg("Sell-back amount exceeds the transaction cap")] SellCap,
    #[msg("Test cash desk has insufficient liquidity")] DeskShort,
    #[msg("Invalid revenue source")] InvalidSource,
    #[msg("Position owner or house mismatch")] WrongPosition,
}
