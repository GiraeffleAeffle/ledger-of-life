use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use crate::common::ErrorCode;
pub const PRICE_AUTHORITY: Pubkey = pubkey!("3AoHstmog6FiCcBaVAh8jnB8iVc2v9oUvN2Pnn76YtbH");
pub const CASH_MINT: Pubkey = pubkey!("BCgqGAUvbGobqXrJtEDS437i8r1FffVSGcnwCsHcN2oE");
pub const INITIALIZER: Pubkey = pubkey!("HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G");
pub const DAILY_FAUCET_BUDGET: u64 = 50_000_000;
pub const DEBT_EXPOSURE_CAP: u64 = 2_000_000_000;
#[account]
#[derive(InitSpace)]
pub struct Price { pub authority:Pubkey, pub share_mint:Pubkey, pub price_usd_e6:u64, pub published_at:i64, pub copied_at:i64, pub initial_price_usd_e6:u64, pub initial_published_at:i64, pub bump:u8 }
#[account]
#[derive(InitSpace)]
pub struct FaucetCooldown { pub owner:Pubkey, pub last_claim:i64, pub bump:u8 }
#[account]
#[derive(InitSpace)]
pub struct FaucetBudget { pub share_mint:Pubkey, pub day:i64, pub minted_today:u64, pub total_minted:u64, pub daily_limit:u64, pub bump:u8 }
#[derive(Accounts)]
pub struct InitializeShares<'info> {
    #[account(mut,address=INITIALIZER @ ErrorCode::Unauthorized)] pub payer:Signer<'info>,
    #[account(init,payer=payer,seeds=[b"share_mint"],bump,mint::decimals=6,mint::authority=share_mint)] pub share_mint:Account<'info,Mint>,
    #[account(init,payer=payer,space=8+Price::INIT_SPACE,seeds=[b"price",share_mint.key().as_ref()],bump)] pub price:Account<'info,Price>,
    #[account(init,payer=payer,space=8+FaucetBudget::INIT_SPACE,seeds=[b"faucet_budget",share_mint.key().as_ref()],bump)] pub budget:Account<'info,FaucetBudget>,
    pub token_program:Program<'info,Token>,pub system_program:Program<'info,System>,pub rent:Sysvar<'info,Rent>,
}
#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)] pub payer:Signer<'info>, pub owner:Signer<'info>,
    #[account(address=PRICE_AUTHORITY @ ErrorCode::Unauthorized)] pub issuer:Signer<'info>,
    #[account(mut,seeds=[b"share_mint"],bump,mint::decimals=6,mint::authority=share_mint)] pub share_mint:Account<'info,Mint>,
    #[account(init_if_needed,payer=payer,space=8+FaucetCooldown::INIT_SPACE,seeds=[b"faucet",share_mint.key().as_ref(),owner.key().as_ref()],bump)] pub cooldown:Account<'info,FaucetCooldown>,
    #[account(mut,token::mint=share_mint,token::authority=owner)] pub destination:Account<'info,TokenAccount>,
    #[account(mut,seeds=[b"faucet_budget",share_mint.key().as_ref()],bump=budget.bump,has_one=share_mint,constraint=budget.daily_limit==DAILY_FAUCET_BUDGET @ ErrorCode::InvalidConfiguration)] pub budget:Account<'info,FaucetBudget>,
    pub token_program:Program<'info,Token>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub authority:Signer<'info>,
    #[account(mut,seeds=[b"price",share_mint.key().as_ref()],bump=price.bump,has_one=authority,has_one=share_mint)] pub price:Account<'info,Price>,
    #[account(seeds=[b"share_mint"],bump)] pub share_mint:Account<'info,Mint>,
}
pub fn initialize_shares(ctx:Context<InitializeShares>,price_usd_e6:u64,published_at:i64)->Result<()> {
    let now=Clock::get()?.unix_timestamp;
    require!(price_usd_e6>0 && price_usd_e6<=1_000_000_000_000 && published_at>0 && published_at<=now,ErrorCode::InvalidConfiguration);
    *ctx.accounts.price=Price{authority:PRICE_AUTHORITY,share_mint:ctx.accounts.share_mint.key(),price_usd_e6,published_at,copied_at:now,initial_price_usd_e6:price_usd_e6,initial_published_at:published_at,bump:ctx.bumps.price};
    *ctx.accounts.budget=FaucetBudget{share_mint:ctx.accounts.share_mint.key(),day:now/86400,minted_today:0,total_minted:0,daily_limit:DAILY_FAUCET_BUDGET,bump:ctx.bumps.budget};Ok(())
}
pub fn faucet(ctx:Context<Faucet>)->Result<()> {
    let now=Clock::get()?.unix_timestamp;
    let c=&mut ctx.accounts.cooldown;
    let budget=&mut ctx.accounts.budget;
    if budget.day!=now/86400 {budget.day=now/86400;budget.minted_today=0;}
    let next=budget.minted_today.checked_add(5_000_000).ok_or(error!(ErrorCode::Overflow))?;
    require!(next<=budget.daily_limit,ErrorCode::FaucetBudgetExceeded);
    budget.minted_today=next;
    budget.total_minted=budget.total_minted.checked_add(5_000_000).ok_or(error!(ErrorCode::Overflow))?;
    require!(c.last_claim==0 || now.checked_sub(c.last_claim).ok_or(error!(ErrorCode::Overflow))?>=86400,ErrorCode::Cooldown);
    c.owner=ctx.accounts.owner.key();c.last_claim=now;c.bump=ctx.bumps.cooldown;
    let bump=[ctx.bumps.share_mint]; let seeds:&[&[u8]]=&[b"share_mint",&bump];
    token::mint_to(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),MintTo{mint:ctx.accounts.share_mint.to_account_info(),to:ctx.accounts.destination.to_account_info(),authority:ctx.accounts.share_mint.to_account_info()},&[seeds]),5_000_000)
}
pub fn set_price(ctx:Context<SetPrice>,price_usd_e6:u64,published_at:i64)->Result<()> {
    let now=Clock::get()?.unix_timestamp;let p=&mut ctx.accounts.price;
    require!(price_usd_e6>0 && price_usd_e6<=1_000_000_000_000,ErrorCode::InvalidAmount);
    require!(published_at>p.published_at && published_at<=now.checked_add(300).ok_or(error!(ErrorCode::Overflow))?,ErrorCode::InvalidAmount);
    require!(now-p.copied_at>=3600,ErrorCode::PushTooSoon);
    require!((price_usd_e6.abs_diff(p.price_usd_e6) as u128)*10000<=(p.price_usd_e6 as u128)*2000,ErrorCode::StepTooLarge);
    p.price_usd_e6=price_usd_e6;p.published_at=published_at;p.copied_at=now;Ok(())
}
