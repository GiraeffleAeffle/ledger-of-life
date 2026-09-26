use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod accounting;
pub mod lending;
pub mod state;
use state::{Phase, Tenancy};

declare_id!("DuFehTh7HJVxTmBhdJiDxsDrd6xXMnQW35jzLPxBeDfb");

pub const TEST_USDC: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

fn payout_address(party: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            party.as_ref(),
            anchor_spl::token::ID.as_ref(),
            mint.as_ref(),
        ],
        &ASSOCIATED_TOKEN_PROGRAM,
    )
    .0
}

#[program]
pub mod rental_escrow {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        initialize_tenancy(
            &mut ctx.accounts.tenancy,
            &ctx.accounts.reserve,
            &ctx.accounts.market,
            ctx.accounts.tenant.key(),
            ctx.accounts.landlord.key(),
            ctx.accounts.deposit_mint.key(),
            ctx.accounts.receipt_mint.key(),
            ctx.accounts.tenant_destination.key(),
            ctx.accounts.landlord_destination.key(),
            ctx.bumps.tenancy,
            args,
        )
    }

    pub fn initialize_staged(ctx: Context<InitializeStaged>, args: InitializeArgs) -> Result<()> {
        initialize_tenancy(
            &mut ctx.accounts.tenancy,
            &ctx.accounts.reserve,
            &ctx.accounts.market,
            ctx.accounts.tenant.key(),
            ctx.accounts.landlord.key(),
            ctx.accounts.deposit_mint.key(),
            ctx.accounts.receipt_mint.key(),
            ctx.accounts.tenant_destination.key(),
            ctx.accounts.landlord_destination.key(),
            ctx.bumps.tenancy,
            args,
        )
    }

    pub fn fund(ctx: Context<Fund>, nonce: u64) -> Result<()> {
        let t = &ctx.accounts.tenancy;
        t.tenant_only(ctx.accounts.tenant.key())?;
        t.check_nonce(nonce)?;
        require!(t.phase == Phase::AwaitingFunding, EscrowError::InvalidPhase);
        let amount = t.required_security;
        let before = ctx.accounts.cash.amount;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.deposit_mint.to_account_info(),
                    to: ctx.accounts.cash.to_account_info(),
                    authority: ctx.accounts.tenant.to_account_info(),
                },
            ),
            amount,
            6,
        )?;
        ctx.accounts.cash.reload()?;
        require!(
            ctx.accounts.cash.amount.checked_sub(before) == Some(amount),
            EscrowError::UnexpectedTokenDelta
        );
        let t = &mut ctx.accounts.tenancy;
        t.accounted_idle = amount;
        t.phase = Phase::Active;
        t.advance()?;
        emit!(FinanceEvent {
            tenancy: t.key(),
            nonce,
            kind: EventKind::Funded,
            amount
        });
        Ok(())
    }

    pub fn supply<'info>(
        ctx: Context<'_, '_, '_, 'info, Finance<'info>>,
        amount: u64,
        nonce: u64,
    ) -> Result<()> {
        let t = &ctx.accounts.tenancy;
        t.tenant_only(ctx.accounts.actor.key())?;
        t.check_nonce(nonce)?;
        require!(t.phase == Phase::Active, EscrowError::InvalidPhase);
        require!(
            amount > 0
                && amount <= t.accounted_idle
                && t.accounted_idle <= ctx.accounts.cash.amount,
            EscrowError::InvalidAmount
        );
        let before_cash = ctx.accounts.cash.amount;
        let before_receipts = ctx.accounts.receipts.amount;
        lending::supply(&ctx.accounts, ctx.remaining_accounts, amount)?;
        ctx.accounts.cash.reload()?;
        ctx.accounts.receipts.reload()?;
        // KLend rounds a requested deposit down to the amount backing whole receipt units.
        let spent = before_cash
            .checked_sub(ctx.accounts.cash.amount)
            .ok_or_else(|| error!(EscrowError::UnexpectedTokenDelta))?;
        require!(
            spent > 0 && spent <= amount,
            EscrowError::UnexpectedTokenDelta
        );
        let received = ctx
            .accounts
            .receipts
            .amount
            .checked_sub(before_receipts)
            .ok_or_else(|| error!(EscrowError::UnexpectedTokenDelta))?;
        require!(received > 0, EscrowError::UnexpectedTokenDelta);
        let t = &mut ctx.accounts.tenancy;
        t.accounted_idle = accounting::checked_sub(t.accounted_idle, spent)?;
        t.accounted_receipts = accounting::checked_add(t.accounted_receipts, received)?;
        t.advance()?;
        emit!(FinanceEvent {
            tenancy: t.key(),
            nonce,
            kind: EventKind::Supplied,
            amount: spent
        });
        Ok(())
    }

    pub fn redeem<'info>(
        ctx: Context<'_, '_, '_, 'info, Finance<'info>>,
        receipt_amount: u64,
        minimum_received: u64,
        nonce: u64,
    ) -> Result<()> {
        let t = &ctx.accounts.tenancy;
        t.check_nonce(nonce)?;
        if t.phase == Phase::Active {
            t.tenant_only(ctx.accounts.actor.key())?;
        } else {
            require!(t.phase == Phase::Settling, EscrowError::InvalidPhase);
            t.party(ctx.accounts.actor.key())?;
        }
        require!(
            receipt_amount > 0
                && receipt_amount <= t.accounted_receipts
                && t.accounted_receipts <= ctx.accounts.receipts.amount,
            EscrowError::InvalidAmount
        );
        let before_cash = ctx.accounts.cash.amount;
        let before_receipts = ctx.accounts.receipts.amount;
        lending::redeem(&ctx.accounts, ctx.remaining_accounts, receipt_amount)?;
        ctx.accounts.cash.reload()?;
        ctx.accounts.receipts.reload()?;
        require!(
            before_receipts.checked_sub(ctx.accounts.receipts.amount) == Some(receipt_amount),
            EscrowError::UnexpectedTokenDelta
        );
        let received = ctx
            .accounts
            .cash
            .amount
            .checked_sub(before_cash)
            .ok_or_else(|| error!(EscrowError::UnexpectedTokenDelta))?;
        require!(
            received > 0 && received >= minimum_received,
            EscrowError::Slippage
        );
        let t = &mut ctx.accounts.tenancy;
        t.accounted_idle = accounting::checked_add(t.accounted_idle, received)?;
        t.accounted_receipts = accounting::checked_sub(t.accounted_receipts, receipt_amount)?;
        t.advance()?;
        emit!(FinanceEvent {
            tenancy: t.key(),
            nonce,
            kind: EventKind::Redeemed,
            amount: received
        });
        Ok(())
    }

    pub fn release_earnings<'info>(
        ctx: Context<'_, '_, '_, 'info, Finance<'info>>,
        amount: u64,
        nonce: u64,
    ) -> Result<()> {
        let t = &ctx.accounts.tenancy;
        t.tenant_only(ctx.accounts.actor.key())?;
        t.check_nonce(nonce)?;
        require_keys_eq!(
            ctx.accounts.destination.key(),
            t.tenant_destination,
            EscrowError::InvalidRecipient
        );
        require_keys_eq!(
            *ctx.accounts.destination.owner,
            token::ID,
            EscrowError::InvalidRecipient
        );
        let destination =
            TokenAccount::try_deserialize(&mut ctx.accounts.destination.data.borrow().as_ref())?;
        require_keys_eq!(destination.owner, t.tenant, EscrowError::InvalidRecipient);
        require_keys_eq!(
            destination.mint,
            t.deposit_mint,
            EscrowError::InvalidRecipient
        );
        require!(
            ctx.accounts.cash.amount >= t.accounted_idle
                && ctx.accounts.receipts.amount >= t.accounted_receipts,
            EscrowError::UnexpectedTokenDelta
        );
        let reserve = lending::refresh(&ctx.accounts, ctx.remaining_accounts)?;
        require!(reserve.healthy, EscrowError::ProtocolUnavailable);
        let value =
            accounting::receipt_value(t.accounted_receipts, reserve.supply, reserve.net_sf)?;
        let limit = accounting::release_limit(
            t.accounted_idle,
            value,
            t.required_security,
            t.release_permitted,
            t.phase == Phase::Active,
        )?;
        require!(amount > 0 && amount <= limit, EscrowError::ExcessiveRelease);
        transfer_from_escrow(
            &ctx.accounts.tenancy,
            &ctx.accounts.cash,
            ctx.accounts.destination.to_account_info(),
            &ctx.accounts.deposit_mint,
            &ctx.accounts.token_program,
            amount,
        )?;
        let t = &mut ctx.accounts.tenancy;
        t.accounted_idle = accounting::checked_sub(t.accounted_idle, amount)?;
        t.released_earnings = accounting::checked_add(t.released_earnings, amount)?;
        t.advance()?;
        emit!(FinanceEvent {
            tenancy: t.key(),
            nonce,
            kind: EventKind::EarningsReleased,
            amount
        });
        Ok(())
    }

    /// TEST DEPLOYMENTS ONLY: stand-in for lending interest on test networks without borrowers.
    /// Anyone may transfer test USDC into an active escrow as accounted earnings; it can only be
    /// released to the tenant's fixed account or returned to the tenant at settlement.
    pub fn test_credit_yield(ctx: Context<TestCreditYield>, amount: u64) -> Result<()> {
        require!(cfg!(feature = "test-deployment"), EscrowError::DeploymentDisabled);
        let t = &ctx.accounts.tenancy;
        require!(t.phase == Phase::Active, EscrowError::InvalidPhase);
        require!(amount > 0 && amount <= 100_000_000, EscrowError::InvalidAmount);
        let before = ctx.accounts.cash.amount;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.deposit_mint.to_account_info(),
                    to: ctx.accounts.cash.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
            6,
        )?;
        ctx.accounts.cash.reload()?;
        require!(
            ctx.accounts.cash.amount.checked_sub(before) == Some(amount),
            EscrowError::UnexpectedTokenDelta
        );
        let t = &mut ctx.accounts.tenancy;
        t.accounted_idle = accounting::checked_add(t.accounted_idle, amount)?;
        Ok(())
    }

    pub fn propose_claim(ctx: Context<Party>, amount: u64, nonce: u64) -> Result<()> {
        ctx.accounts
            .tenancy
            .propose_claim(ctx.accounts.actor.key(), amount, nonce)
    }
    pub fn respond_to_claim(ctx: Context<Party>, accept: bool, nonce: u64) -> Result<()> {
        ctx.accounts
            .tenancy
            .respond(ctx.accounts.actor.key(), accept, nonce)
    }
    pub fn resolve_claim(ctx: Context<Party>, amount: u64, nonce: u64) -> Result<()> {
        ctx.accounts
            .tenancy
            .decide(ctx.accounts.actor.key(), amount, nonce)
    }
    pub fn settle(ctx: Context<Settle>, nonce: u64) -> Result<()> {
        let t = &ctx.accounts.tenancy;
        t.party(ctx.accounts.actor.key())?;
        t.check_nonce(nonce)?;
        require!(t.phase == Phase::Settling, EscrowError::InvalidPhase);
        require!(
            ctx.accounts.cash.amount >= t.accounted_idle,
            EscrowError::UnexpectedTokenDelta
        );
        let (landlord_amount, tenant_amount) = accounting::settlement(
            t.accounted_idle,
            t.accounted_receipts,
            t.approved_claim,
            t.claim_amount,
            t.required_security,
        )?;
        let t = &mut ctx.accounts.tenancy;
        t.tenant_owed = tenant_amount;
        t.landlord_owed = landlord_amount;
        t.phase = Phase::Closed;
        t.advance()?;
        emit!(FinanceEvent {
            tenancy: t.key(),
            nonce,
            kind: EventKind::Settled,
            amount: landlord_amount
        });
        Ok(())
    }

    pub fn payout(ctx: Context<Payout>, landlord: bool, nonce: u64) -> Result<()> {
        let t = &ctx.accounts.tenancy;
        t.check_nonce(nonce)?;
        require!(t.phase == Phase::Closed, EscrowError::InvalidPhase);
        let (amount, recipient) = if landlord {
            (t.landlord_owed, t.landlord)
        } else {
            (t.tenant_owed, t.tenant)
        };
        require!(amount > 0, EscrowError::InvalidAmount);
        require_keys_eq!(
            ctx.accounts.destination.owner,
            recipient,
            EscrowError::InvalidRecipient
        );
        require!(
            ctx.accounts.cash.amount >= t.accounted_idle,
            EscrowError::UnexpectedTokenDelta
        );
        transfer_from_escrow(
            t,
            &ctx.accounts.cash,
            ctx.accounts.destination.to_account_info(),
            &ctx.accounts.deposit_mint,
            &ctx.accounts.token_program,
            amount,
        )?;
        let t = &mut ctx.accounts.tenancy;
        t.accounted_idle = accounting::checked_sub(t.accounted_idle, amount)?;
        if landlord {
            t.landlord_owed = 0;
        } else {
            t.tenant_owed = 0;
        }
        t.advance()?;
        emit!(FinanceEvent {
            tenancy: t.key(),
            nonce,
            kind: EventKind::PaidOut,
            amount
        });
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn initialize_tenancy(
    t: &mut Account<Tenancy>,
    reserve: &AccountInfo,
    market: &AccountInfo,
    tenant: Pubkey,
    landlord: Pubkey,
    deposit_mint: Pubkey,
    receipt_mint: Pubkey,
    tenant_destination: Pubkey,
    landlord_destination: Pubkey,
    bump: u8,
    args: InitializeArgs,
) -> Result<()> {
    require!(
        cfg!(feature = "test-deployment"),
        EscrowError::DeploymentDisabled
    );
    require_keys_eq!(deposit_mint, TEST_USDC, EscrowError::InvalidAsset);
    require!(
        args.required_security > 0 && args.required_security <= 10_000_000_000,
        EscrowError::InvalidAmount
    );
    require!(args.policy_hash != [0; 32], EscrowError::InvalidPolicy);
    require!(
        tenant != landlord
            && args.arbitrator != tenant
            && args.arbitrator != landlord
            && args.arbitrator != Pubkey::default(),
        EscrowError::InvalidParties
    );
    require_keys_eq!(
        tenant_destination,
        payout_address(&tenant, &deposit_mint),
        EscrowError::InvalidRecipient
    );
    require_keys_eq!(
        landlord_destination,
        payout_address(&landlord, &deposit_mint),
        EscrowError::InvalidRecipient
    );
    t.lease_id = args.lease_id;
    t.tenant = tenant;
    t.landlord = landlord;
    t.arbitrator = args.arbitrator;
    t.deposit_mint = deposit_mint;
    t.reserve = *reserve.key;
    t.market = *market.key;
    t.receipt_mint = receipt_mint;
    t.liquidity_supply = args.liquidity_supply;
    t.market_authority = args.market_authority;
    t.tenant_destination = tenant_destination;
    t.landlord_destination = landlord_destination;
    t.policy_hash = args.policy_hash;
    t.release_permitted = args.release_permitted;
    t.required_security = args.required_security;
    t.accounted_idle = 0;
    t.accounted_receipts = 0;
    t.released_earnings = 0;
    t.next_nonce = 0;
    t.claim_amount = 0;
    t.approved_claim = 0;
    t.tenant_owed = 0;
    t.landlord_owed = 0;
    t.phase = Phase::AwaitingFunding;
    t.bump = bump;
    let snapshot = lending::inspect(reserve, market, t)?;
    require!(snapshot.healthy, EscrowError::ProtocolUnavailable);
    emit!(FinanceEvent {
        tenancy: t.key(),
        nonce: 0,
        kind: EventKind::Initialized,
        amount: args.required_security
    });
    Ok(())
}

fn transfer_from_escrow<'info>(
    t: &Account<'info, Tenancy>,
    from: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let bump = [t.bump];
    let seeds: &[&[u8]] = &[b"tenancy", t.tenant.as_ref(), &t.lease_id, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority: t.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        6,
    )
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub lease_id: [u8; 32],
    pub arbitrator: Pubkey,
    pub required_security: u64,
    pub policy_hash: [u8; 32],
    pub release_permitted: bool,
    pub liquidity_supply: Pubkey,
    pub market_authority: Pubkey,
}

#[derive(Accounts)]
#[instruction(args:InitializeArgs)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub tenant: Signer<'info>,
    pub landlord: Signer<'info>,
    #[account(init,payer=payer,space=8+Tenancy::INIT_SPACE,seeds=[b"tenancy",tenant.key().as_ref(),&args.lease_id],bump)]
    pub tenancy: Account<'info, Tenancy>,
    #[account(mint::decimals = 6)]
    pub deposit_mint: Account<'info, Mint>,
    pub receipt_mint: Account<'info, Mint>,
    #[account(init,payer=payer,seeds=[b"cash",tenancy.key().as_ref()],bump,token::mint=deposit_mint,token::authority=tenancy)]
    pub cash: Account<'info, TokenAccount>,
    #[account(init,payer=payer,seeds=[b"receipts",tenancy.key().as_ref()],bump,token::mint=receipt_mint,token::authority=tenancy)]
    pub receipts: Account<'info, TokenAccount>,
    #[account(address=payout_address(&tenant.key(), &deposit_mint.key()),token::mint=deposit_mint,token::authority=tenant)]
    pub tenant_destination: Account<'info, TokenAccount>,
    #[account(address=payout_address(&landlord.key(), &deposit_mint.key()),token::mint=deposit_mint,token::authority=landlord)]
    pub landlord_destination: Account<'info, TokenAccount>,
    /// CHECK: KLend owner, discriminator, fields and derived accounts verified by lending::inspect.
    #[account(owner=klend_interface::KLEND_PROGRAM_ID)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: KLend owner and discriminator verified by lending::inspect.
    #[account(owner=klend_interface::KLEND_PROGRAM_ID)]
    pub market: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args:InitializeArgs)]
pub struct InitializeStaged<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The tenant key fixes the PDA and payout authority. No tenant funds move here;
    /// the tenant must later sign `fund` after reviewing every stored term.
    pub tenant: UncheckedAccount<'info>,
    pub landlord: Signer<'info>,
    #[account(init,payer=payer,space=8+Tenancy::INIT_SPACE,seeds=[b"tenancy",tenant.key().as_ref(),&args.lease_id],bump)]
    pub tenancy: Account<'info, Tenancy>,
    #[account(mint::decimals = 6)]
    pub deposit_mint: Account<'info, Mint>,
    pub receipt_mint: Account<'info, Mint>,
    #[account(init,payer=payer,seeds=[b"cash",tenancy.key().as_ref()],bump,token::mint=deposit_mint,token::authority=tenancy)]
    pub cash: Account<'info, TokenAccount>,
    #[account(init,payer=payer,seeds=[b"receipts",tenancy.key().as_ref()],bump,token::mint=receipt_mint,token::authority=tenancy)]
    pub receipts: Account<'info, TokenAccount>,
    #[account(address=payout_address(&tenant.key(), &deposit_mint.key()),token::mint=deposit_mint,token::authority=tenant)]
    pub tenant_destination: Account<'info, TokenAccount>,
    #[account(address=payout_address(&landlord.key(), &deposit_mint.key()),token::mint=deposit_mint,token::authority=landlord)]
    pub landlord_destination: Account<'info, TokenAccount>,
    /// CHECK: KLend owner, discriminator, fields and derived accounts verified by lending::inspect.
    #[account(owner=klend_interface::KLEND_PROGRAM_ID)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: KLend owner and discriminator verified by lending::inspect.
    #[account(owner=klend_interface::KLEND_PROGRAM_ID)]
    pub market: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    pub tenant: Signer<'info>,
    #[account(mut,seeds=[b"tenancy",tenancy.tenant.as_ref(),&tenancy.lease_id],bump=tenancy.bump)]
    pub tenancy: Account<'info, Tenancy>,
    #[account(address=tenancy.deposit_mint)]
    pub deposit_mint: Account<'info, Mint>,
    #[account(mut,token::mint=deposit_mint,token::authority=tenant)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut,seeds=[b"cash",tenancy.key().as_ref()],bump,token::mint=deposit_mint,token::authority=tenancy)]
    pub cash: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Finance<'info> {
    pub actor: Signer<'info>,
    #[account(mut,seeds=[b"tenancy",tenancy.tenant.as_ref(),&tenancy.lease_id],bump=tenancy.bump)]
    pub tenancy: Account<'info, Tenancy>,
    #[account(address=tenancy.deposit_mint)]
    pub deposit_mint: Account<'info, Mint>,
    #[account(mut,address=tenancy.receipt_mint)]
    pub receipt_mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"cash",tenancy.key().as_ref()],bump,token::mint=deposit_mint,token::authority=tenancy)]
    pub cash: Account<'info, TokenAccount>,
    #[account(mut,seeds=[b"receipts",tenancy.key().as_ref()],bump,token::mint=receipt_mint,token::authority=tenancy)]
    pub receipts: Account<'info, TokenAccount>,
    /// CHECK: Only earnings release needs a live token account; supply/redeem remain
    /// available if a party closes or changes ownership of their own payout ATA.
    #[account(mut,address=tenancy.tenant_destination)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: pinned KLend account and data verified before every CPI.
    #[account(mut,address=tenancy.reserve,owner=klend_interface::KLEND_PROGRAM_ID)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: pinned KLend account and data verified before every CPI.
    #[account(address=tenancy.market,owner=klend_interface::KLEND_PROGRAM_ID)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: derived and pinned from the validated market.
    #[account(address=tenancy.market_authority)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut,address=tenancy.liquidity_supply,token::mint=deposit_mint,token::authority=market_authority)]
    pub liquidity_supply: Account<'info, TokenAccount>,
    /// CHECK: constant program identity plus executable check; no arbitrary program forwarding.
    #[account(address=klend_interface::KLEND_PROGRAM_ID,executable)]
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: exact native instructions sysvar required by KLend.
    #[account(address=anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TestCreditYield<'info> {
    pub funder: Signer<'info>,
    #[account(mut,seeds=[b"tenancy",tenancy.tenant.as_ref(),&tenancy.lease_id],bump=tenancy.bump)]
    pub tenancy: Account<'info, Tenancy>,
    #[account(address=tenancy.deposit_mint)]
    pub deposit_mint: Account<'info, Mint>,
    #[account(mut,token::mint=deposit_mint,token::authority=funder)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut,seeds=[b"cash",tenancy.key().as_ref()],bump,token::mint=deposit_mint,token::authority=tenancy)]
    pub cash: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Party<'info> {
    pub actor: Signer<'info>,
    #[account(mut,seeds=[b"tenancy",tenancy.tenant.as_ref(),&tenancy.lease_id],bump=tenancy.bump)]
    pub tenancy: Account<'info, Tenancy>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub actor: Signer<'info>,
    #[account(mut,seeds=[b"tenancy",tenancy.tenant.as_ref(),&tenancy.lease_id],bump=tenancy.bump)]
    pub tenancy: Account<'info, Tenancy>,
    #[account(address=tenancy.deposit_mint)]
    pub deposit_mint: Account<'info, Mint>,
    #[account(seeds=[b"cash",tenancy.key().as_ref()],bump,token::mint=deposit_mint,token::authority=tenancy)]
    pub cash: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(landlord: bool)]
pub struct Payout<'info> {
    pub actor: Signer<'info>,
    #[account(mut,seeds=[b"tenancy",tenancy.tenant.as_ref(),&tenancy.lease_id],bump=tenancy.bump)]
    pub tenancy: Account<'info, Tenancy>,
    #[account(address=tenancy.deposit_mint)]
    pub deposit_mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"cash",tenancy.key().as_ref()],bump,token::mint=deposit_mint,token::authority=tenancy)]
    pub cash: Account<'info, TokenAccount>,
    #[account(mut,address=if landlord { tenancy.landlord_destination } else { tenancy.tenant_destination },token::mint=deposit_mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum EventKind {
    Initialized,
    Funded,
    Supplied,
    Redeemed,
    EarningsReleased,
    Settled,
    PaidOut,
}
#[event]
pub struct FinanceEvent {
    pub tenancy: Pubkey,
    pub nonce: u64,
    pub kind: EventKind,
    pub amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg(
        "Deployment is disabled; only the explicit test build can initialize test USDC escrows."
    )]
    DeploymentDisabled,
    #[msg("The actor does not have this authority.")]
    Unauthorized,
    #[msg("Operation nonce was already used or is out of order.")]
    Replay,
    #[msg("This action is unavailable in the current tenancy phase.")]
    InvalidPhase,
    #[msg("Wrong token mint or token program.")]
    InvalidAsset,
    #[msg("Invalid amount.")]
    InvalidAmount,
    #[msg("Parties must be distinct, nonzero identities.")]
    InvalidParties,
    #[msg("A nonempty agreed policy hash is required.")]
    InvalidPolicy,
    #[msg("Protocol account identity or state did not validate.")]
    InvalidProtocolAccount,
    #[msg("A protocol account required for CPI is missing.")]
    MissingProtocolAccount,
    #[msg("The protocol is not available for this action.")]
    ProtocolUnavailable,
    #[msg("Reserve valuation is stale.")]
    StaleReserve,
    #[msg("Reserve lacks immediately redeemable liquidity.")]
    InsufficientLiquidity,
    #[msg("Recipient does not match the tenancy's fixed payout account.")]
    InvalidRecipient,
    #[msg("Observed token changes did not match the instruction.")]
    UnexpectedTokenDelta,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Balance is insufficient.")]
    InsufficientBalance,
    #[msg("Invalid receipt conversion state.")]
    InvalidExchangeRate,
    #[msg("The policy or tenancy state prohibits earnings release.")]
    ReleaseNotAllowed,
    #[msg("Required rental security is underfunded.")]
    SecurityShortfall,
    #[msg("Release exceeds realized surplus.")]
    ExcessiveRelease,
    #[msg("Claim or allocation exceeds its bounds.")]
    ClaimExceedsLimit,
    #[msg("Redeem the remaining lending receipts before settlement.")]
    RedemptionRequired,
    #[msg("Redemption returned less than authorized.")]
    Slippage,
}
