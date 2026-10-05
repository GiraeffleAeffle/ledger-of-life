mod support;
use support::*;
use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use shares::{instruction,Pool,LoanPosition};
fn setup()->Fixture {let mut f=Fixture::new();f.own_action(instruction::Lend{amount:2_000_000_000}).unwrap();f.own_action(instruction::DepositCollateral{amount:10_000_000}).unwrap();f}
#[test]
fn lend_borrow_repay_withdraw_and_redeem_in_kind() {
    let mut f=setup();f.own_action(instruction::Borrow{amount:1_000_000_000}).unwrap();assert_eq!(f.amount(f.cash_vault),1_000_000_000);
    assert!(f.own_action(instruction::WithdrawCollateral{amount:6_000_000}).is_err());
    f.own_action(instruction::Repay{max_amount:400_000_000}).unwrap();let p:LoanPosition=f.read(f.position(f.owner.pubkey()));assert!(p.borrow_shares>0);
    f.own_action(instruction::Repay{max_amount:u64::MAX}).unwrap();assert_eq!(f.read::<Pool>(f.pool).total_borrow_assets,0);
    f.own_action(instruction::WithdrawCollateral{amount:10_000_000}).unwrap();assert_eq!(f.amount(f.collateral_vault),0);
    f.own_action(instruction::WithdrawLending{amount:500_000_000}).unwrap();let p:LoanPosition=f.read(f.position(f.owner.pubkey()));
    f.own_action(instruction::RedeemLending{shares:p.balance}).unwrap();assert_eq!(f.read::<LoanPosition>(f.position(f.owner.pubkey())).balance,0);
}
#[test]
fn cash_limits_utilization_caps_amounts_and_stale_price() {
    let mut f=setup();assert!(f.own_action(instruction::Borrow{amount:999_999}).is_err());
    assert!(f.own_action(instruction::Borrow{amount:1_900_000_000}).is_err());
    f.own_action(instruction::Borrow{amount:1_000_000_000}).unwrap();assert!(f.own_action(instruction::WithdrawLending{amount:1_000_000_001}).is_err());
    assert!(f.own_action(instruction::Lend{amount:0}).is_err());assert!(f.own_action(instruction::DepositCollateral{amount:0}).is_err());
    assert!(f.own_action(instruction::WithdrawCollateral{amount:11_000_000}).is_err());assert!(f.own_action(instruction::Repay{max_amount:0}).is_err());
    f.set_time(NOW+75*3600);assert!(f.own_action(instruction::Borrow{amount:1_000_000}).is_err());assert!(f.own_action(instruction::WithdrawCollateral{amount:1}).is_err());
    f.own_action(instruction::Repay{max_amount:u64::MAX}).unwrap();f.own_action(instruction::WithdrawCollateral{amount:10_000_000}).unwrap();
}
#[test]
fn continuous_interest_accrual_matches_nominal_year() {
    let mut f=setup();f.own_action(instruction::Borrow{amount:1_000_000_000}).unwrap();f.set_time(NOW+365*86400);
    let i=ix(shares::accounts::Accrue{pool:f.pool},instruction::Accrue{});f.send(i,&[]).unwrap();let p:Pool=f.read(f.pool);
    assert_eq!(p.total_borrow_assets,1_051_271_096);assert!(p.interest_remainder>0);
    f.own_action(instruction::Repay{max_amount:u64::MAX}).unwrap();assert_eq!(f.read::<Pool>(f.pool).interest_remainder,0);
}
#[test]
fn liquidation_half_close_bonus_and_bad_debt() {
    let mut f=setup();f.own_action(instruction::Borrow{amount:1_000_000_000}).unwrap();
    let liquidator=Keypair::new();f.svm.airdrop(&liquidator.pubkey(),1_000_000).unwrap();let cash=Pubkey::new_unique();let stock=Pubkey::new_unique();
    f.put_token(cash,shares::token::CASH_MINT,liquidator.pubkey(),2_000_000_000);f.put_token(stock,f.share_mint,liquidator.pubkey(),0);
    let a=f.action(liquidator.pubkey(),f.owner.pubkey(),cash,stock);
    assert!(send(&mut f.svm,&f.payer,&[&liquidator],&[ix(a,instruction::Liquidate{max_repay:u64::MAX})]).is_err());
    f.set_price(100_000_000,NOW);let a=f.action(liquidator.pubkey(),f.owner.pubkey(),cash,stock);
    send(&mut f.svm,&f.payer,&[&liquidator],&[ix(a,instruction::Liquidate{max_repay:u64::MAX})]).unwrap();assert_eq!(f.amount(stock),5_500_000);
    assert_eq!(f.read::<Pool>(f.pool).total_borrow_assets,500_000_000);
    f.set_price(1_000_000,NOW);let a=f.action(liquidator.pubkey(),f.owner.pubkey(),cash,stock);
    send(&mut f.svm,&f.payer,&[&liquidator],&[ix(a,instruction::Liquidate{max_repay:u64::MAX})]).unwrap();
    assert_eq!(f.amount(stock),10_000_000);assert_eq!(f.read::<Pool>(f.pool).total_borrow_assets,0);assert_eq!(f.read::<LoanPosition>(f.position(f.owner.pubkey())).collateral,0);
    let a=f.action(liquidator.pubkey(),f.owner.pubkey(),cash,stock);send(&mut f.svm,&f.payer,&[&liquidator],&[ix(a,instruction::RealizeBadDebt{})]).unwrap();
}
#[test]
fn permissionless_bad_debt_rejects_valuable_collateral_and_writes_off_dust() {
    let mut f=setup();f.own_action(instruction::Borrow{amount:1_000_000_000}).unwrap();assert!(f.own_action(instruction::RealizeBadDebt{}).is_err());
    // Tiny collateral value rounds below one cash atomic and is not realizable.
    let key=f.position(f.owner.pubkey());let mut a=f.svm.get_account(&key).unwrap();a.data[104..112].copy_from_slice(&1u64.to_le_bytes());f.svm.set_account(key,a).unwrap();f.set_price(1,NOW);
    f.own_action(instruction::RealizeBadDebt{}).unwrap();assert_eq!(f.read::<Pool>(f.pool).total_borrow_assets,0);
}
#[test]
fn rejects_wrong_signer_mint_and_vault() {
    let mut f=setup();let attacker=Keypair::new();f.svm.airdrop(&attacker.pubkey(),1_000_000).unwrap();
    let cash=Pubkey::new_unique();let stock=Pubkey::new_unique();f.put_token(cash,shares::token::CASH_MINT,attacker.pubkey(),10_000_000);f.put_token(stock,f.share_mint,attacker.pubkey(),1_000_000);
    let a=f.action(attacker.pubkey(),f.owner.pubkey(),cash,stock);assert!(send(&mut f.svm,&f.payer,&[&attacker],&[ix(a,instruction::Borrow{amount:1_000_000})]).is_err());
    let wrong=Pubkey::new_unique();f.put_token(wrong,Pubkey::new_unique(),f.owner.pubkey(),10_000_000);let mut a=f.action(f.owner.pubkey(),f.owner.pubkey(),wrong,f.share_account);
    assert!(send(&mut f.svm,&f.payer,&[&f.owner],&[ix(a,instruction::Lend{amount:1})]).is_err());
    a=f.action(f.owner.pubkey(),f.owner.pubkey(),f.cash_account,f.share_account);a.cash_vault=f.cash_account;assert!(send(&mut f.svm,&f.payer,&[&f.owner],&[ix(a,instruction::Lend{amount:1})]).is_err());
    let mut a=f.action(f.owner.pubkey(),f.owner.pubkey(),f.cash_account,f.share_account);a.collateral_vault=f.share_account;assert!(send(&mut f.svm,&f.payer,&[&f.owner],&[ix(a,instruction::DepositCollateral{amount:1})]).is_err());
}
#[test]
fn debt_and_share_overflow_rejected_without_mutation() {
    let mut f=setup();let mut p=f.svm.get_account(&f.pool).unwrap();p.data[80..96].copy_from_slice(&u128::MAX.to_le_bytes());f.svm.set_account(f.pool,p).unwrap();
    assert!(f.own_action(instruction::Lend{amount:1}).is_err());
}

#[test]
fn lender_can_credit_receiver_and_withdraw_to_selected_cash_recipient() {
    let mut f=Fixture::new();let receiver=Keypair::new();f.svm.airdrop(&receiver.pubkey(),1_000_000).unwrap();
    let a=f.action(f.owner.pubkey(),receiver.pubkey(),f.cash_account,f.share_account);
    send(&mut f.svm,&f.payer,&[&f.owner],&[ix(a,instruction::Lend{amount:100_000_000})]).unwrap();
    assert!(f.svm.get_account(&f.position(f.owner.pubkey())).is_none());
    assert!(f.read::<LoanPosition>(f.position(receiver.pubkey())).balance>0);
    let stock=Pubkey::new_unique();f.put_token(stock,f.share_mint,receiver.pubkey(),0);
    let a=f.action(receiver.pubkey(),receiver.pubkey(),f.cash_account,stock);
    send(&mut f.svm,&f.payer,&[&receiver],&[ix(a,instruction::WithdrawLending{amount:100_000_000})]).unwrap();
    assert_eq!(f.amount(f.cash_vault),0);
}
