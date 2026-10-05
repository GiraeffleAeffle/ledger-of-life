use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::{common::*, token::{Price,CASH_MINT,INITIALIZER,DEBT_EXPOSURE_CAP}};
use crate::common::ErrorCode;
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub share_mint:Pubkey,pub cash_mint:Pubkey,pub cash:u64,pub total_supply:u128,
    pub total_borrow_assets:u64,pub total_borrow_shares:u128,pub total_collateral:u64,
    pub last_accrual:i64,pub interest_remainder:u128,pub debt_exposure_cap:u64,pub bump:u8,
}
#[account]
#[derive(InitSpace)]
pub struct LoanPosition {pub pool:Pubkey,pub owner:Pubkey,pub balance:u128,pub net_contributed:i128,pub collateral:u64,pub borrow_shares:u128,pub bump:u8}
#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut,address=INITIALIZER @ ErrorCode::Unauthorized)]pub payer:Signer<'info>,
    #[account(seeds=[b"share_mint"],bump,mint::decimals=6)]pub share_mint:Account<'info,Mint>,
    #[account(address=CASH_MINT,mint::decimals=6)]pub cash_mint:Account<'info,Mint>,
    #[account(init,payer=payer,space=8+Pool::INIT_SPACE,seeds=[b"pool",share_mint.key().as_ref()],bump)]pub pool:Account<'info,Pool>,
    #[account(init,payer=payer,seeds=[b"pool_cash",pool.key().as_ref()],bump,token::mint=cash_mint,token::authority=pool)]pub cash_vault:Account<'info,TokenAccount>,
    #[account(init,payer=payer,seeds=[b"pool_collateral",pool.key().as_ref()],bump,token::mint=share_mint,token::authority=pool)]pub collateral_vault:Account<'info,TokenAccount>,
    pub token_program:Program<'info,Token>,pub system_program:Program<'info,System>,pub rent:Sysvar<'info,Rent>,
}
#[derive(Accounts)]
pub struct PoolAction<'info> {
    #[account(mut)]pub payer:Signer<'info>,pub owner:Signer<'info>,
    #[account(mut,seeds=[b"pool",pool.share_mint.as_ref()],bump=pool.bump,constraint=pool.cash_mint==CASH_MINT)]pub pool:Account<'info,Pool>,
    #[account(init_if_needed,payer=payer,space=8+LoanPosition::INIT_SPACE,seeds=[b"loan",pool.key().as_ref(),position_owner.key().as_ref()],bump)]pub position:Account<'info,LoanPosition>,
    /// CHECK: PDA seed; owner signs withdrawals/loans, lenders can credit a receiver, liquidation targets a borrower.
    pub position_owner:UncheckedAccount<'info>,
    #[account(mut,token::mint=pool.cash_mint)]pub cash_account:Account<'info,TokenAccount>,
    #[account(mut,token::mint=pool.share_mint,token::authority=owner)]pub share_account:Account<'info,TokenAccount>,
    #[account(mut,seeds=[b"pool_cash",pool.key().as_ref()],bump,token::mint=pool.cash_mint,token::authority=pool)]pub cash_vault:Account<'info,TokenAccount>,
    #[account(mut,seeds=[b"pool_collateral",pool.key().as_ref()],bump,token::mint=pool.share_mint,token::authority=pool)]pub collateral_vault:Account<'info,TokenAccount>,
    #[account(seeds=[b"price",pool.share_mint.as_ref()],bump=price.bump,constraint=price.share_mint==pool.share_mint)]pub price:Account<'info,Price>,
    pub token_program:Program<'info,Token>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct Accrue<'info> {#[account(mut,seeds=[b"pool",pool.share_mint.as_ref()],bump=pool.bump)]pub pool:Account<'info,Pool>}
pub fn initialize_pool(ctx:Context<InitializePool>)->Result<()> {
    *ctx.accounts.pool=Pool{share_mint:ctx.accounts.share_mint.key(),cash_mint:ctx.accounts.cash_mint.key(),cash:0,total_supply:0,total_borrow_assets:0,total_borrow_shares:0,total_collateral:0,last_accrual:Clock::get()?.unix_timestamp,interest_remainder:0,debt_exposure_cap:DEBT_EXPOSURE_CAP,bump:ctx.bumps.pool};Ok(())
}
pub fn compounded(elapsed:u128)->Result<u128> {
    let mut exponent=mul_div(elapsed,500*RAY,365*86400*10000)?;let mut squares=0;
    while exponent>RAY/2 {exponent/=2;squares+=1;}
    let mut term=RAY;let mut sum=RAY;
    for i in 1..=28 {term=mul_div(term,exponent,RAY*i)?;if term==0 {break;}sum=add(sum,term)?;}
    for _ in 0..squares {sum=mul_div(sum,sum,RAY)?;}sub(sum,RAY)
}
pub fn accrue_pool(p:&mut Pool)->Result<()> {
    let now=Clock::get()?.unix_timestamp;let elapsed=now.checked_sub(p.last_accrual).ok_or(error!(ErrorCode::Overflow))?;
    require!(elapsed>=0,ErrorCode::InvalidState);
    if p.total_borrow_assets==0 {p.interest_remainder=0;} else if elapsed>0 {
        let growth=compounded(elapsed as u128)?;
        let interest=mul_div(p.total_borrow_assets as u128,growth,RAY)?;
        // Wide multiplication remainder without overflowing u128.
        let fraction=crate::common::remainder(p.total_borrow_assets as u128,growth,RAY)?;
        let fraction=add(fraction,mul_div(p.interest_remainder,add(RAY,growth)?,RAY)?)?;
        p.total_borrow_assets=as_u64(add(add(p.total_borrow_assets as u128,interest)?,fraction/RAY)?)?;
        p.interest_remainder=fraction%RAY;
    }
    p.last_accrual=now;Ok(())
}
pub fn accrue(ctx:Context<Accrue>)->Result<()> {accrue_pool(&mut ctx.accounts.pool)}
fn prepare(a:&mut PoolAction,bump:u8,own:bool)->Result<()> {
    if own {require_keys_eq!(a.owner.key(),a.position_owner.key(),ErrorCode::Unauthorized);}
    if a.position.pool==Pubkey::default() {*a.position=LoanPosition{pool:a.pool.key(),owner:a.position_owner.key(),balance:0,net_contributed:0,collateral:0,borrow_shares:0,bump};}
    require_keys_eq!(a.position.pool,a.pool.key(),ErrorCode::InvalidConfiguration);
    require_keys_eq!(a.position.owner,a.position_owner.key(),ErrorCode::InvalidConfiguration);
    accrue_pool(&mut a.pool)
}
fn move_in<'info>(a:&PoolAction<'info>,cash:bool,amount:u64)->Result<()> {
    let (from,to)=if cash {(&a.cash_account,&a.cash_vault)} else {(&a.share_account,&a.collateral_vault)};
    require_keys_eq!(from.owner,a.owner.key(),ErrorCode::Unauthorized);
    token::transfer(CpiContext::new(a.token_program.to_account_info(),Transfer{from:from.to_account_info(),to:to.to_account_info(),authority:a.owner.to_account_info()}),amount)
}
fn move_out<'info>(a:&PoolAction<'info>,cash:bool,amount:u64)->Result<()> {
    let (from,to)=if cash {(&a.cash_vault,&a.cash_account)} else {(&a.collateral_vault,&a.share_account)};
    let bump=[a.pool.bump];let seeds:&[&[u8]]=&[b"pool",a.pool.share_mint.as_ref(),&bump];
    token::transfer(CpiContext::new_with_signer(a.token_program.to_account_info(),Transfer{from:from.to_account_info(),to:to.to_account_info(),authority:a.pool.to_account_info()},&[seeds]),amount)
}
fn assets(p:&Pool)->Result<u128> {add(p.cash as u128,p.total_borrow_assets as u128)}
fn debt(p:&Pool,pos:&LoanPosition)->Result<u128> {if pos.borrow_shares==0 {Ok(0)} else {up(pos.borrow_shares,p.total_borrow_assets as u128,p.total_borrow_shares)}}
fn value(collateral:u64,price:u64)->Result<u128> {mul_div(collateral as u128,price as u128,SCALE)}
pub fn lend(mut ctx:Context<PoolAction>,amount:u64)->Result<()> {
    require!(amount>0 && ctx.accounts.position_owner.key()!=Pubkey::default(),ErrorCode::InvalidAmount);prepare(&mut ctx.accounts,ctx.bumps.position,false)?;
    let shares=mul_div(amount as u128,add(ctx.accounts.pool.total_supply,OFFSET)?,add(assets(&ctx.accounts.pool)?,1)?)?;
    require!(shares>0,ErrorCode::InvalidAmount);move_in(&ctx.accounts,true,amount)?;
    let a=&mut ctx.accounts;a.pool.cash=as_u64(add(a.pool.cash as u128,amount as u128)?)?;a.pool.total_supply=add(a.pool.total_supply,shares)?;a.position.balance=add(a.position.balance,shares)?;
    a.position.net_contributed=a.position.net_contributed.checked_add(amount as i128).ok_or(error!(ErrorCode::Overflow))?;Ok(())
}
fn withdraw(a:&mut PoolAction,amount:u64,shares:u128)->Result<()> {
    require!(amount>0 && shares>0,ErrorCode::InvalidAmount);require!(amount<=a.pool.cash,ErrorCode::InsufficientLiquidity);
    a.position.balance=sub(a.position.balance,shares)?;a.pool.total_supply=sub(a.pool.total_supply,shares)?;a.pool.cash-=amount;
    a.position.net_contributed=a.position.net_contributed.checked_sub(amount as i128).ok_or(error!(ErrorCode::Overflow))?;move_out(a,true,amount)
}
pub fn withdraw_lending(mut ctx:Context<PoolAction>,amount:u64)->Result<()> {
    prepare(&mut ctx.accounts,ctx.bumps.position,true)?;let p=&ctx.accounts.pool;
    let shares=up(amount as u128,add(p.total_supply,OFFSET)?,add(assets(p)?,1)?)?;withdraw(&mut ctx.accounts,amount,shares)
}
pub fn redeem_lending(mut ctx:Context<PoolAction>,shares:u128)->Result<()> {
    prepare(&mut ctx.accounts,ctx.bumps.position,true)?;let p=&ctx.accounts.pool;
    let amount=as_u64(mul_div(shares,add(assets(p)?,1)?,add(p.total_supply,OFFSET)?)?)?;withdraw(&mut ctx.accounts,amount,shares)
}
pub fn deposit_collateral(mut ctx:Context<PoolAction>,amount:u64)->Result<()> {
    require!(amount>0,ErrorCode::InvalidAmount);prepare(&mut ctx.accounts,ctx.bumps.position,true)?;move_in(&ctx.accounts,false,amount)?;
    let a=&mut ctx.accounts;a.position.collateral=as_u64(add(a.position.collateral as u128,amount as u128)?)?;a.pool.total_collateral=as_u64(add(a.pool.total_collateral as u128,amount as u128)?)?;Ok(())
}
pub fn withdraw_collateral(mut ctx:Context<PoolAction>,amount:u64)->Result<()> {
    require!(amount>0,ErrorCode::InvalidAmount);prepare(&mut ctx.accounts,ctx.bumps.position,true)?;let a=&mut ctx.accounts;
    let remaining=a.position.collateral.checked_sub(amount).ok_or(error!(ErrorCode::InvalidAmount))?;
    if a.position.borrow_shares>0 {let price=fresh_price(&a.price)?;require!(debt(&a.pool,&a.position)?<=mul_div(value(remaining,price)?,5000,10000)?,ErrorCode::Undercollateralized);}
    a.position.collateral=remaining;a.pool.total_collateral=a.pool.total_collateral.checked_sub(amount).ok_or(error!(ErrorCode::Overflow))?;move_out(a,false,amount)
}
pub fn borrow(mut ctx:Context<PoolAction>,amount:u64)->Result<()> {
    require!(amount>=1_000_000,ErrorCode::InvalidAmount);prepare(&mut ctx.accounts,ctx.bumps.position,true)?;let a=&mut ctx.accounts;let price=fresh_price(&a.price)?;
    require_keys_eq!(a.cash_account.owner,a.owner.key(),ErrorCode::Unauthorized);
    require!(amount<=a.pool.cash,ErrorCode::InsufficientLiquidity);
    let shares=if a.pool.total_borrow_shares==0 {(amount as u128)*OFFSET} else {up(amount as u128,a.pool.total_borrow_shares,a.pool.total_borrow_assets as u128)?};
    let next_assets=add(a.pool.total_borrow_assets as u128,amount as u128)?;let next_shares=add(a.pool.total_borrow_shares,shares)?;
    require!(a.pool.debt_exposure_cap==DEBT_EXPOSURE_CAP,ErrorCode::InvalidConfiguration);
    require!(next_assets<=a.pool.debt_exposure_cap as u128,ErrorCode::DebtExposureExceeded);
    require!(up(add(a.position.borrow_shares,shares)?,next_assets,next_shares)?<=mul_div(value(a.position.collateral,price)?,5000,10000)?,ErrorCode::Undercollateralized);
    require!(next_assets<=mul_div(assets(&a.pool)?,9000,10000)?,ErrorCode::UtilizationExceeded);
    a.pool.total_borrow_assets=as_u64(next_assets)?;a.pool.total_borrow_shares=next_shares;a.position.borrow_shares=add(a.position.borrow_shares,shares)?;a.pool.cash-=amount;move_out(a,true,amount)
}
fn repay_position(a:&mut PoolAction,cap:u64)->Result<u64> {
    let owned=a.position.borrow_shares;require!(owned>0 && cap>0,ErrorCode::InvalidAmount);
    let shares=if cap as u128>=debt(&a.pool,&a.position)? {owned} else {mul_div(cap as u128,a.pool.total_borrow_shares,a.pool.total_borrow_assets as u128)?};require!(shares>0,ErrorCode::InvalidAmount);
    let paid=as_u64(up(shares,a.pool.total_borrow_assets as u128,a.pool.total_borrow_shares)?)?;
    let removed=as_u64(mul_div(shares,a.pool.total_borrow_assets as u128,a.pool.total_borrow_shares)?)?;
    move_in(a,true,paid)?;a.position.borrow_shares=sub(owned,shares)?;a.pool.total_borrow_shares=sub(a.pool.total_borrow_shares,shares)?;a.pool.total_borrow_assets-=removed;a.pool.cash=as_u64(add(a.pool.cash as u128,paid as u128)?)?;
    if a.pool.total_borrow_shares==0 {a.pool.total_borrow_assets=0;a.pool.interest_remainder=0;}Ok(paid)
}
pub fn repay(mut ctx:Context<PoolAction>,max_amount:u64)->Result<()> {prepare(&mut ctx.accounts,ctx.bumps.position,true)?;repay_position(&mut ctx.accounts,max_amount)?;Ok(())}
fn write_off(a:&mut PoolAction)->Result<()> {
    let shares=a.position.borrow_shares;if shares==0 {return Ok(());}
    let loss=as_u64(mul_div(shares,a.pool.total_borrow_assets as u128,a.pool.total_borrow_shares)?)?;
    a.position.borrow_shares=0;a.pool.total_borrow_shares=sub(a.pool.total_borrow_shares,shares)?;a.pool.total_borrow_assets-=loss;
    if a.pool.total_borrow_shares==0 {a.pool.total_borrow_assets=0;a.pool.interest_remainder=0;}Ok(())
}
pub fn liquidate(mut ctx:Context<PoolAction>,max_repay:u64)->Result<()> {
    require!(max_repay>0,ErrorCode::InvalidAmount);prepare(&mut ctx.accounts,ctx.bumps.position,false)?;let a=&mut ctx.accounts;let price=fresh_price(&a.price)?;
    let d=debt(&a.pool,&a.position)?;let collateral=a.position.collateral;let v=value(collateral,price)?;
    require!(d>0 && d>=up(v,8000,10000)?,ErrorCode::NotLiquidatable);
    let collateral_cap=mul_div(v,10000,11000)?;let cap=(max_repay as u128).min((d/2).min(collateral_cap));let mut seized=0;
    if collateral_cap!=0 {let paid=repay_position(a,as_u64(cap)?)?;seized=as_u64(up(paid as u128,11000*SCALE,(price as u128)*10000)?)?.min(collateral);}
    if cap==collateral_cap && max_repay as u128>=collateral_cap && d/2>=collateral_cap {seized=collateral;}
    a.position.collateral-=seized;a.pool.total_collateral-=seized;move_out(a,false,seized)?;if a.position.collateral==0 {write_off(a)?;}Ok(())
}
pub fn realize_bad_debt(mut ctx:Context<PoolAction>)->Result<()> {
    prepare(&mut ctx.accounts,ctx.bumps.position,false)?;let a=&mut ctx.accounts;
    if a.position.collateral!=0 {let price=fresh_price(&a.price)?;require!(mul_div(value(a.position.collateral,price)?,10000,11000)?==0,ErrorCode::Undercollateralized);}write_off(a)
}
