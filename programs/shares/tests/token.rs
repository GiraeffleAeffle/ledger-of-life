mod support;
use support::*;
use anchor_lang::{prelude::Pubkey,solana_program::instruction::{Instruction,AccountMeta}};
use solana_keypair::Keypair;
use solana_signer::Signer;
use shares::{accounts,instruction,FaucetCooldown,FaucetBudget,Price,token::{INITIALIZER,PRICE_AUTHORITY,DAILY_FAUCET_BUDGET}};
pub fn faucet_for(f:&Fixture,owner:Pubkey,destination:Pubkey)->Instruction {ix(accounts::Faucet{payer:f.payer.pubkey(),owner,issuer:PRICE_AUTHORITY,share_mint:f.share_mint,cooldown:Pubkey::find_program_address(&[b"faucet",f.share_mint.as_ref(),owner.as_ref()],&shares::ID).0,destination,budget:f.budget,token_program:anchor_spl::token::ID,system_program:anchor_lang::system_program::ID},instruction::Faucet{})}
fn faucet_ix(f:&Fixture)->Instruction {faucet_for(f,f.owner.pubkey(),f.share_account)}
#[test]
fn issuer_cosigned_pda_faucet_amount_and_per_wallet_cooldown() {
    let mut f=Fixture::new();let initial=f.amount(f.share_account);let i=faucet_ix(&f);send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&f.owner],&[i]).unwrap();assert_eq!(f.amount(f.share_account),initial+5_000_000);
    assert!(f.svm.get_sigverify());let i=faucet_ix(&f);assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&f.owner],&[i]).is_err());
    f.set_time(NOW+86399);let i=faucet_ix(&f);assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&f.owner],&[i]).is_err());
    f.set_time(NOW+86400);let i=faucet_ix(&f);send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&f.owner],&[i]).unwrap();assert_eq!(f.amount(f.share_account),initial+10_000_000);
    let cooldown=Pubkey::find_program_address(&[b"faucet",f.share_mint.as_ref(),f.owner.pubkey().as_ref()],&shares::ID).0;assert_eq!(f.read::<FaucetCooldown>(cooldown).last_claim,NOW+86400);
    let budget:FaucetBudget=f.read(f.budget);assert_eq!(budget.minted_today,5_000_000);assert_eq!(budget.total_minted,10_000_000);assert_eq!(budget.daily_limit,DAILY_FAUCET_BUDGET);
}
#[test]
fn faucet_requires_issuer_and_owner_and_correct_mint_budget_destination() {
    let mut f=Fixture::new();let mut i=faucet_ix(&f);i.accounts[2].is_signer=false;assert!(send(&mut f.svm,&f.payer,&[&f.owner],&[i]).is_err());
    let mut i=faucet_ix(&f);i.accounts[2]=AccountMeta::new_readonly(f.payer.pubkey(),true);assert!(send(&mut f.svm,&f.payer,&[&f.owner],&[i]).is_err());
    let mut i=faucet_ix(&f);i.accounts[1].is_signer=false;assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer],&[i]).is_err());
    let wrong=Pubkey::new_unique();f.put_token(wrong,shares::token::CASH_MINT,f.owner.pubkey(),0);let mut i=faucet_ix(&f);i.accounts[5].pubkey=wrong;assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&f.owner],&[i]).is_err());
    let mut i=faucet_ix(&f);i.accounts[3].pubkey=shares::token::CASH_MINT;assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&f.owner],&[i]).is_err());
    let mut i=faucet_ix(&f);i.accounts[6].pubkey=f.price;assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&f.owner],&[i]).is_err());
    assert_eq!(f.read::<FaucetBudget>(f.budget).total_minted,0);
}
#[test]
fn mirror_authority_step_timestamp_and_hourly_rules() {
    let mut f=Fixture::new();assert_eq!(f.read::<Price>(f.price).authority,PRICE_AUTHORITY);
    let builder=|f:&Fixture,v,t|ix(accounts::SetPrice{authority:PRICE_AUTHORITY,price:f.price,share_mint:f.share_mint},instruction::SetPrice{price_usd_e6:v,published_at:t});
    let i=builder(&f,410_000_000,NOW+1);assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer],&[i]).is_err());
    f.set_time(NOW+3600);let i=builder(&f,481_000_000,NOW+3600);assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer],&[i]).is_err());
    let i=builder(&f,480_000_000,NOW+3901);assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer],&[i]).is_err());
    let i=builder(&f,480_000_000,NOW);assert!(send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer],&[i]).is_err());
    let i=builder(&f,480_000_000,NOW+3600);send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer],&[i]).unwrap();let p:Price=f.read(f.price);assert_eq!(p.price_usd_e6,480_000_000);assert_eq!(p.initial_price_usd_e6,400_000_000);assert_eq!(p.initial_published_at,NOW);
    let mut i=builder(&f,480_000_000,NOW+3601);i.accounts[0].pubkey=f.payer.pubkey();assert!(send(&mut f.svm,&f.payer,&[],&[i]).is_err());
}
#[test]
fn initializer_squatting_is_rejected_before_any_state_exists() {
    let mut svm=new_svm();let attacker=Keypair::new();svm.airdrop(&attacker.pubkey(),10_000_000_000).unwrap();
    let mint=Pubkey::find_program_address(&[b"share_mint"],&shares::ID).0;let price=Pubkey::find_program_address(&[b"price",mint.as_ref()],&shares::ID).0;let budget=Pubkey::find_program_address(&[b"faucet_budget",mint.as_ref()],&shares::ID).0;
    let a=accounts::InitializeShares{payer:attacker.pubkey(),share_mint:mint,price,budget,token_program:anchor_spl::token::ID,system_program:anchor_lang::system_program::ID,rent:anchor_lang::solana_program::sysvar::rent::ID};
    assert!(send(&mut svm,&attacker,&[],&[ix(a,instruction::InitializeShares{price_usd_e6:1,published_at:NOW})]).is_err());assert!(svm.get_account(&mint).is_none());assert!(svm.get_account(&price).is_none());assert!(svm.get_account(&budget).is_none());
}
#[test]
fn initialization_single_use_and_pool_authority_are_bound() {
    let mut f=Fixture::new();let i=ix(accounts::InitializeShares{payer:INITIALIZER,share_mint:f.share_mint,price:f.price,budget:f.budget,token_program:anchor_spl::token::ID,system_program:anchor_lang::system_program::ID,rent:anchor_lang::solana_program::sysvar::rent::ID},instruction::InitializeShares{price_usd_e6:400_000_000,published_at:NOW});assert!(send_authorized(&mut f.svm,INITIALIZER,&[],&[i]).is_err());
    let i=ix(accounts::InitializePool{payer:f.payer.pubkey(),share_mint:f.share_mint,cash_mint:shares::token::CASH_MINT,pool:f.pool,cash_vault:f.cash_vault,collateral_vault:f.collateral_vault,token_program:anchor_spl::token::ID,system_program:anchor_lang::system_program::ID,rent:anchor_lang::solana_program::sysvar::rent::ID},instruction::InitializePool{});assert!(f.send(i,&[]).is_err());
    assert_eq!(shares::common::max_price_age(NOW),26*3600);assert_eq!(shares::common::max_price_age(NOW-86400),74*3600);
}
#[test]
fn multi_wallet_faucet_aggregation_stops_at_global_budget_and_pool_exposure_cap() {
    let mut f=Fixture::new();f.put_token(f.share_account,f.share_mint,f.owner.pubkey(),0);f.own_action(instruction::Lend{amount:8_000_000_000}).unwrap();
    for _ in 0..10 {
        let wallet=Keypair::new();f.svm.airdrop(&wallet.pubkey(),1_000_000).unwrap();let token=Pubkey::new_unique();f.put_token(token,f.share_mint,wallet.pubkey(),0);
        let mut without_issuer=faucet_for(&f,wallet.pubkey(),token);without_issuer.accounts[2].is_signer=false;
        assert!(send(&mut f.svm,&f.payer,&[&wallet],&[without_issuer]).is_err());
        let i=faucet_for(&f,wallet.pubkey(),token);send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&wallet],&[i]).unwrap();
        let transfer=anchor_spl::token::spl_token::instruction::transfer(&anchor_spl::token::ID,&token,&f.share_account,&wallet.pubkey(),&[],5_000_000).unwrap();send(&mut f.svm,&f.payer,&[&wallet],&[transfer]).unwrap();
    }
    assert_eq!(f.amount(f.share_account),50_000_000);assert_eq!(f.read::<FaucetBudget>(f.budget).minted_today,DAILY_FAUCET_BUDGET);
    let eleventh=Keypair::new();f.svm.airdrop(&eleventh.pubkey(),1_000_000).unwrap();let token=Pubkey::new_unique();f.put_token(token,f.share_mint,eleventh.pubkey(),0);
    let i=faucet_for(&f,eleventh.pubkey(),token);let error=send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&eleventh],&[i]).unwrap_err();assert!(error.meta.logs.iter().any(|log|log.contains("FaucetBudgetExceeded")));assert_eq!(f.amount(token),0);
    f.own_action(instruction::DepositCollateral{amount:50_000_000}).unwrap();f.own_action(instruction::Borrow{amount:2_000_000_000}).unwrap();
    let error=f.own_action(instruction::Borrow{amount:1_000_000}).unwrap_err();assert!(error.meta.logs.iter().any(|log|log.contains("DebtExposureExceeded")));assert_eq!(f.read::<shares::Pool>(f.pool).cash,6_000_000_000);
    f.set_time(NOW+86400);f.set_price(400_000_000,NOW+86400);let i=faucet_for(&f,eleventh.pubkey(),token);send_authorized(&mut f.svm,f.payer.pubkey(),&[&f.payer,&eleventh],&[i]).unwrap();assert_eq!(f.read::<FaucetBudget>(f.budget).minted_today,5_000_000);
    let second_cash=Pubkey::new_unique();f.put_token(second_cash,shares::token::CASH_MINT,eleventh.pubkey(),0);
    let a=f.action(eleventh.pubkey(),eleventh.pubkey(),second_cash,token);
    send(&mut f.svm,&f.payer,&[&eleventh],&[ix(a,instruction::DepositCollateral{amount:5_000_000})]).unwrap();
    let a=f.action(eleventh.pubkey(),eleventh.pubkey(),second_cash,token);
    let error=send(&mut f.svm,&f.payer,&[&eleventh],&[ix(a,instruction::Borrow{amount:1_000_000})]).unwrap_err();
    assert!(error.meta.logs.iter().any(|log|log.contains("DebtExposureExceeded")));
    assert!(f.own_action(instruction::Borrow{amount:1_000_000}).is_err());
    let i=ix(accounts::Accrue{pool:f.pool},instruction::Accrue{});f.send(i,&[]).unwrap();assert!(f.read::<shares::Pool>(f.pool).total_borrow_assets>2_000_000_000);
    f.own_action(instruction::Repay{max_amount:10_000_000}).unwrap();f.own_action(instruction::Borrow{amount:1_000_000}).unwrap();assert!(f.read::<shares::Pool>(f.pool).total_borrow_assets<=2_000_000_000);
}

#[test]
fn issuer_signature_is_cryptographically_required_with_runtime_verification_enabled() {
    let mut f=Fixture::new();assert!(f.svm.get_sigverify());
    let i=faucet_ix(&f);let mut tx=solana_transaction::Transaction::new_unsigned(solana_message::Message::new(&[i],Some(&f.payer.pubkey())));
    tx.partial_sign(&[&f.payer,&f.owner],f.svm.latest_blockhash());
    let error=f.svm.send_transaction(tx).unwrap_err();
    assert!(format!("{:?}",error.err).contains("SignatureFailure"));
    assert_eq!(f.read::<FaucetBudget>(f.budget).total_minted,0);
}
