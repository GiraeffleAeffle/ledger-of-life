//! Restricted Kamino CPI. Every instruction is built here; callers cannot forward arbitrary bytes.
use crate::{accounting, EscrowError, Finance, Tenancy};
use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use klend_interface::{
    state::{from_account_data, LendingMarket, Reserve},
    ReserveInfo, KLEND_PROGRAM_ID,
};

// KLend treats this key as an absent oracle. The pinned klend-interface's
// ReserveInfo::from_reserve only filters Pubkey::default(), so forwarding its
// Some(NULL_PUBKEY) to RefreshReserve fails oracle configuration validation.
const NULL_ORACLE: Pubkey = pubkey!("nu11111111111111111111111111111111111111111");

fn configured_oracle(key: Option<Pubkey>) -> Option<Pubkey> {
    key.filter(|value| *value != NULL_ORACLE)
}

pub struct Snapshot {
    pub info: ReserveInfo,
    pub net_sf: u128,
    pub supply: u64,
    pub available: u64,
    pub healthy: bool,
}

pub fn inspect(
    reserve_account: &AccountInfo,
    market_account: &AccountInfo,
    tenancy: &Tenancy,
) -> Result<Snapshot> {
    require_keys_eq!(
        *reserve_account.owner,
        KLEND_PROGRAM_ID,
        EscrowError::InvalidProtocolAccount
    );
    require_keys_eq!(
        *market_account.owner,
        KLEND_PROGRAM_ID,
        EscrowError::InvalidProtocolAccount
    );
    require_keys_eq!(
        *reserve_account.key,
        tenancy.reserve,
        EscrowError::InvalidProtocolAccount
    );
    require_keys_eq!(
        *market_account.key,
        tenancy.market,
        EscrowError::InvalidProtocolAccount
    );
    let reserve_data = reserve_account.try_borrow_data()?;
    let reserve = from_account_data::<Reserve>(&reserve_data)
        .map_err(|_| error!(EscrowError::InvalidProtocolAccount))?;
    let market_data = market_account.try_borrow_data()?;
    let market = from_account_data::<LendingMarket>(&market_data)
        .map_err(|_| error!(EscrowError::InvalidProtocolAccount))?;
    require_keys_eq!(
        reserve.lending_market,
        tenancy.market,
        EscrowError::InvalidProtocolAccount
    );
    require_keys_eq!(
        reserve.liquidity.mint_pubkey,
        tenancy.deposit_mint,
        EscrowError::InvalidAsset
    );
    require_keys_eq!(
        reserve.liquidity.token_program,
        anchor_spl::token::ID,
        EscrowError::InvalidAsset
    );
    require_keys_eq!(
        reserve.liquidity.supply_vault,
        tenancy.liquidity_supply,
        EscrowError::InvalidProtocolAccount
    );
    require_keys_eq!(
        reserve.collateral.mint_pubkey,
        tenancy.receipt_mint,
        EscrowError::InvalidAsset
    );
    // Legacy reserves store canonical vault/mint keys; current new-reserve PDA helpers do not apply.
    let (authority, _) =
        klend_interface::pda::lending_market_authority(&KLEND_PROGRAM_ID, &tenancy.market);
    require_keys_eq!(
        authority,
        tenancy.market_authority,
        EscrowError::InvalidProtocolAccount
    );
    require!(
        reserve.liquidity.mint_decimals == 6,
        EscrowError::InvalidAsset
    );
    let net_sf = accounting::net_liquidity_sf(
        reserve.liquidity.total_available_amount,
        u128::from(reserve.liquidity.borrowed_amount_sf),
        u128::from(reserve.liquidity.accumulated_protocol_fees_sf),
        u128::from(reserve.liquidity.accumulated_referrer_fees_sf),
        u128::from(reserve.liquidity.pending_referrer_fees_sf),
    )?;
    Ok(Snapshot {
        info: ReserveInfo::from_reserve(*reserve_account.key, reserve),
        net_sf,
        supply: reserve.collateral.mint_total_supply,
        available: reserve.liquidity.total_available_amount,
        healthy: reserve.config.status == 0
            && !reserve.is_emergency_mode()
            && !market.is_emergency_mode()
            && reserve.config.permissioned_ops == 0
            && market.permissioned_ops == 0,
    })
}

fn invoke_built<'info>(
    accounts: &Finance<'info>,
    remaining: &[AccountInfo<'info>],
    instruction: &Instruction,
) -> Result<()> {
    require_keys_eq!(
        instruction.program_id,
        KLEND_PROGRAM_ID,
        EscrowError::InvalidProtocolAccount
    );
    let mut all = accounts.to_account_infos();
    all.extend_from_slice(remaining);
    let mut ordered = Vec::with_capacity(instruction.accounts.len() + 1);
    for meta in &instruction.accounts {
        let info = all
            .iter()
            .find(|x| x.key == &meta.pubkey)
            .ok_or_else(|| error!(EscrowError::MissingProtocolAccount))?;
        if meta.is_writable {
            require!(info.is_writable, EscrowError::InvalidProtocolAccount);
        }
        if meta.is_signer {
            require_keys_eq!(
                meta.pubkey,
                accounts.tenancy.key(),
                EscrowError::Unauthorized
            );
        }
        ordered.push(info.clone());
    }
    ordered.push(accounts.klend_program.to_account_info());
    let t = &accounts.tenancy;
    let bump = [t.bump];
    let seeds: &[&[u8]] = &[b"tenancy", t.tenant.as_ref(), &t.lease_id, &bump];
    invoke_signed(instruction, &ordered, &[seeds])?;
    Ok(())
}

pub fn refresh<'info>(
    accounts: &Finance<'info>,
    remaining: &[AccountInfo<'info>],
) -> Result<Snapshot> {
    let before = inspect(&accounts.reserve, &accounts.market, &accounts.tenancy)?;
    let ix = klend_interface::instructions::refresh::refresh_reserve(
        klend_interface::instructions::refresh::RefreshReserveAccounts {
            reserve: before.info.address,
            lending_market: before.info.lending_market,
            pyth_oracle: configured_oracle(before.info.pyth_oracle),
            switchboard_price_oracle: configured_oracle(before.info.switchboard_price_oracle),
            switchboard_twap_oracle: configured_oracle(before.info.switchboard_twap_oracle),
            scope_prices: configured_oracle(before.info.scope_prices),
        },
    );
    invoke_built(accounts, remaining, &ix)?;
    let state = accounts.reserve.try_borrow_data()?;
    let reserve = from_account_data::<Reserve>(&state)
        .map_err(|_| error!(EscrowError::InvalidProtocolAccount))?;
    require!(
        reserve.last_update.stale == 0 && reserve.last_update.slot == Clock::get()?.slot,
        EscrowError::StaleReserve
    );
    drop(state);
    inspect(&accounts.reserve, &accounts.market, &accounts.tenancy)
}

pub fn supply<'info>(
    accounts: &Finance<'info>,
    remaining: &[AccountInfo<'info>],
    amount: u64,
) -> Result<()> {
    let state = refresh(accounts, remaining)?;
    require!(state.healthy, EscrowError::ProtocolUnavailable);
    let ix = klend_interface::instructions::deposit::deposit_reserve_liquidity(
        klend_interface::instructions::deposit::DepositReserveLiquidityAccounts {
            owner: accounts.tenancy.key(),
            reserve: state.info.address,
            lending_market: state.info.lending_market,
            lending_market_authority: accounts.tenancy.market_authority,
            reserve_liquidity_mint: accounts.tenancy.deposit_mint,
            reserve_liquidity_supply: accounts.tenancy.liquidity_supply,
            reserve_collateral_mint: accounts.tenancy.receipt_mint,
            user_source_liquidity: accounts.cash.key(),
            user_destination_collateral: accounts.receipts.key(),
            liquidity_token_program: anchor_spl::token::ID,
        },
        amount,
    );
    invoke_built(accounts, remaining, &ix)
}

pub fn redeem<'info>(
    accounts: &Finance<'info>,
    remaining: &[AccountInfo<'info>],
    receipts: u64,
) -> Result<()> {
    let state = refresh(accounts, remaining)?;
    let expected = accounting::receipt_value(receipts, state.supply, state.net_sf)?;
    require!(
        expected > 0 && expected <= state.available && expected <= accounts.liquidity_supply.amount,
        EscrowError::InsufficientLiquidity
    );
    let ix = klend_interface::instructions::withdraw::redeem_reserve_collateral(
        klend_interface::instructions::withdraw::RedeemReserveCollateralAccounts {
            owner: accounts.tenancy.key(),
            reserve: state.info.address,
            lending_market: state.info.lending_market,
            lending_market_authority: accounts.tenancy.market_authority,
            reserve_liquidity_mint: accounts.tenancy.deposit_mint,
            reserve_liquidity_supply: accounts.tenancy.liquidity_supply,
            reserve_collateral_mint: accounts.tenancy.receipt_mint,
            user_source_collateral: accounts.receipts.key(),
            user_destination_liquidity: accounts.cash.key(),
            liquidity_token_program: anchor_spl::token::ID,
        },
        receipts,
    );
    invoke_built(accounts, remaining, &ix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_oracle_sentinel_is_omitted_from_kamino_refresh() {
        assert_eq!(configured_oracle(Some(NULL_ORACLE)), None);
        assert_eq!(
            configured_oracle(Some(Pubkey::default())),
            Some(Pubkey::default())
        );
        let real = pubkey!("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX");
        assert_eq!(configured_oracle(Some(real)), Some(real));
        let ix = klend_interface::instructions::refresh::refresh_reserve(
            klend_interface::instructions::refresh::RefreshReserveAccounts {
                reserve: Pubkey::new_unique(),
                lending_market: Pubkey::new_unique(),
                pyth_oracle: configured_oracle(Some(NULL_ORACLE)),
                switchboard_price_oracle: configured_oracle(Some(NULL_ORACLE)),
                switchboard_twap_oracle: configured_oracle(Some(NULL_ORACLE)),
                scope_prices: configured_oracle(Some(real)),
            },
        );
        assert!(ix.accounts[2..5]
            .iter()
            .all(|account| account.pubkey == KLEND_PROGRAM_ID));
        assert_eq!(ix.accounts[5].pubkey, real);
    }

    use klend_interface::state::{
        LendingMarket, Reserve, ReserveCollateral, ReserveConfig, ReserveLiquidity, TokenInfo,
    };
    #[test]
    fn client_binary_layout_is_pinned_to_the_protocol_interface() {
        assert_eq!(std::mem::size_of::<Reserve>() + 8, 8624);
        assert_eq!(std::mem::size_of::<LendingMarket>() + 8, 4664);
        assert_eq!(crate::state::Tenancy::INIT_SPACE + 8, 499);
        assert_eq!(std::mem::offset_of!(Reserve, liquidity) + 8, 128);
        assert_eq!(
            std::mem::offset_of!(ReserveLiquidity, total_available_amount),
            96
        );
        assert_eq!(
            std::mem::offset_of!(ReserveLiquidity, borrowed_amount_sf),
            104
        );
        assert_eq!(
            std::mem::offset_of!(ReserveLiquidity, accumulated_protocol_fees_sf),
            216
        );
        assert_eq!(
            std::mem::offset_of!(ReserveLiquidity, accumulated_referrer_fees_sf),
            232
        );
        assert_eq!(
            std::mem::offset_of!(ReserveLiquidity, pending_referrer_fees_sf),
            248
        );
        assert_eq!(std::mem::offset_of!(ReserveLiquidity, token_program), 280);
        assert_eq!(std::mem::offset_of!(Reserve, collateral) + 8, 2560);
        assert_eq!(
            std::mem::offset_of!(ReserveCollateral, mint_total_supply),
            32
        );
        assert_eq!(std::mem::offset_of!(Reserve, config) + 8, 4856);
        assert_eq!(std::mem::offset_of!(ReserveConfig, permissioned_ops), 944);
        assert_eq!(std::mem::offset_of!(ReserveConfig, token_info), 176);
        assert_eq!(std::mem::offset_of!(TokenInfo, scope_configuration), 80);
        assert_eq!(
            std::mem::offset_of!(TokenInfo, switchboard_configuration),
            128
        );
        assert_eq!(std::mem::offset_of!(TokenInfo, pyth_configuration), 192);
        assert_eq!(
            std::mem::offset_of!(LendingMarket, permissioned_ops) + 8,
            3432
        );
    }
    use anchor_lang::Space;
}
