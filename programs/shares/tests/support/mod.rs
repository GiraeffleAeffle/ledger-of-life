#![allow(dead_code)]
use anchor_lang::{prelude::*,AccountDeserialize,InstructionData,ToAccountMetas,solana_program::{instruction::Instruction,program_option::COption,program_pack::Pack}};
use anchor_spl::token::spl_token::state::{Account as TokenAccount,AccountState,Mint};
use litesvm::{LiteSVM,types::TransactionResult};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use shares::{accounts,instruction,ID,token::CASH_MINT};
pub const NOW:i64=1791201600;
pub fn put(svm:&mut LiteSVM,key:Pubkey,owner:Pubkey,data:Vec<u8>) {svm.set_account(key,Account{lamports:svm.minimum_balance_for_rent_exemption(data.len()),data,owner,executable:false,rent_epoch:0}).unwrap();}
pub fn token_data(mint:Pubkey,owner:Pubkey,amount:u64)->Vec<u8> {
    let mut data=vec![0;TokenAccount::LEN];TokenAccount::pack(TokenAccount{mint,owner,amount,delegate:COption::None,state:AccountState::Initialized,is_native:COption::None,delegated_amount:0,close_authority:COption::None},&mut data).unwrap();data
}
pub fn mint_data(authority:Pubkey,supply:u64)->Vec<u8> {
    let mut data=vec![0;Mint::LEN];Mint::pack(Mint{mint_authority:COption::Some(authority),supply,decimals:6,is_initialized:true,freeze_authority:COption::None},&mut data).unwrap();data
}
pub fn set_time(svm:&mut LiteSVM,t:i64) {let mut clock=svm.get_sysvar::<Clock>();clock.unix_timestamp=t;svm.set_sysvar(&clock);svm.expire_blockhash();}
pub fn send(svm:&mut LiteSVM,payer:&Keypair,signers:&[&Keypair],instructions:&[Instruction])->TransactionResult {
    let mut keys=vec![payer];for signer in signers {if signer.pubkey()!=payer.pubkey() {keys.push(*signer);}}
    let tx=Transaction::new(&keys,Message::new(instructions,Some(&payer.pubkey())),svm.latest_blockhash());
    let r=svm.send_transaction(tx);svm.expire_blockhash();r
}
// Test-only authority impersonation for the two fixed production public keys.
// No production key is loaded. Only these fixture transactions skip Ed25519;
// Anchor signer/address constraints still execute, then crypto verification is restored.
pub fn send_authorized(svm:&mut LiteSVM,payer:Pubkey,signers:&[&Keypair],instructions:&[Instruction])->TransactionResult {
    let mut tx=Transaction::new_unsigned(Message::new(instructions,Some(&payer)));
    tx.message.recent_blockhash=svm.latest_blockhash();
    tx.partial_sign(signers,svm.latest_blockhash());
    // Keep history IDs unique even when the unavailable fixed payer has no real signature.
    tx.signatures[0]=Keypair::new().sign_message(&tx.message.serialize());
    *svm=std::mem::take(svm).with_sigverify(false);
    let r=svm.send_transaction(tx);
    *svm=std::mem::take(svm).with_sigverify(true);
    svm.expire_blockhash();r
}
pub fn new_svm()->LiteSVM {let mut svm=LiteSVM::new();svm.add_program_from_file(ID,std::env::var("SHARES_PROGRAM_SO").expect("set SHARES_PROGRAM_SO to built shares.so")).unwrap();set_time(&mut svm,NOW);svm}
pub fn ix<A:ToAccountMetas,D:InstructionData>(accounts:A,data:D)->Instruction {Instruction{program_id:ID,accounts:accounts.to_account_metas(None),data:data.data()}}
pub struct Fixture {pub svm:LiteSVM,pub payer:Keypair,pub owner:Keypair,pub share_mint:Pubkey,pub price:Pubkey,pub budget:Pubkey,pub pool:Pubkey,pub cash_vault:Pubkey,pub collateral_vault:Pubkey,pub cash_account:Pubkey,pub share_account:Pubkey}
impl Fixture {
    pub fn new()->Self {
        let mut svm=new_svm();let payer=Keypair::new();let owner=Keypair::new();svm.airdrop(&payer.pubkey(),10_000_000_000).unwrap();svm.airdrop(&owner.pubkey(),1_000_000).unwrap();
        let share_mint=Pubkey::find_program_address(&[b"share_mint"],&ID).0;let price=Pubkey::find_program_address(&[b"price",share_mint.as_ref()],&ID).0;
        let budget=Pubkey::find_program_address(&[b"faucet_budget",share_mint.as_ref()],&ID).0;
        svm.airdrop(&shares::token::INITIALIZER,10_000_000_000).unwrap();
        svm.airdrop(&shares::token::PRICE_AUTHORITY,1_000_000).unwrap();
        send_authorized(&mut svm,shares::token::INITIALIZER,&[],&[ix(accounts::InitializeShares{payer:shares::token::INITIALIZER,share_mint,price,budget,token_program:anchor_spl::token::ID,system_program:anchor_lang::system_program::ID,rent:anchor_lang::solana_program::sysvar::rent::ID},instruction::InitializeShares{price_usd_e6:400_000_000,published_at:NOW})]).unwrap();
        put(&mut svm,CASH_MINT,anchor_spl::token::ID,mint_data(payer.pubkey(),1_000_000_000_000));
        let pool=Pubkey::find_program_address(&[b"pool",share_mint.as_ref()],&ID).0;let cash_vault=Pubkey::find_program_address(&[b"pool_cash",pool.as_ref()],&ID).0;let collateral_vault=Pubkey::find_program_address(&[b"pool_collateral",pool.as_ref()],&ID).0;
        send_authorized(&mut svm,shares::token::INITIALIZER,&[],&[ix(accounts::InitializePool{payer:shares::token::INITIALIZER,share_mint,cash_mint:CASH_MINT,pool,cash_vault,collateral_vault,token_program:anchor_spl::token::ID,system_program:anchor_lang::system_program::ID,rent:anchor_lang::solana_program::sysvar::rent::ID},instruction::InitializePool{})]).unwrap();
        let cash_account=Pubkey::new_unique();let share_account=Pubkey::new_unique();put(&mut svm,cash_account,anchor_spl::token::ID,token_data(CASH_MINT,owner.pubkey(),10_000_000_000));put(&mut svm,share_account,anchor_spl::token::ID,token_data(share_mint,owner.pubkey(),100_000_000));
        Self{svm,payer,owner,share_mint,price,budget,pool,cash_vault,collateral_vault,cash_account,share_account}
    }
    pub fn send(&mut self,instruction:Instruction,signers:&[&Keypair])->TransactionResult {send(&mut self.svm,&self.payer,signers,&[instruction])}
    pub fn set_time(&mut self,t:i64) {set_time(&mut self.svm,t)}
    pub fn put_token(&mut self,key:Pubkey,mint:Pubkey,owner:Pubkey,amount:u64) {put(&mut self.svm,key,anchor_spl::token::ID,token_data(mint,owner,amount));}
    pub fn amount(&self,key:Pubkey)->u64 {TokenAccount::unpack(&self.svm.get_account(&key).unwrap().data).unwrap().amount}
    pub fn read<T:AccountDeserialize>(&self,key:Pubkey)->T {T::try_deserialize(&mut self.svm.get_account(&key).unwrap().data.as_slice()).unwrap()}
    pub fn set_price(&mut self,value:u64,timestamp:i64) {let mut a=self.svm.get_account(&self.price).unwrap();a.data[72..80].copy_from_slice(&value.to_le_bytes());a.data[80..88].copy_from_slice(&timestamp.to_le_bytes());self.svm.set_account(self.price,a).unwrap();}
    pub fn position(&self,owner:Pubkey)->Pubkey {Pubkey::find_program_address(&[b"loan",self.pool.as_ref(),owner.as_ref()],&ID).0}
    pub fn action(&self,owner:Pubkey,position_owner:Pubkey,cash_account:Pubkey,share_account:Pubkey)->accounts::PoolAction {accounts::PoolAction{payer:self.payer.pubkey(),owner,pool:self.pool,position:self.position(position_owner),position_owner,cash_account,share_account,cash_vault:self.cash_vault,collateral_vault:self.collateral_vault,price:self.price,token_program:anchor_spl::token::ID,system_program:anchor_lang::system_program::ID}}
    pub fn own_action<D:InstructionData>(&mut self,data:D)->TransactionResult {let a=self.action(self.owner.pubkey(),self.owner.pubkey(),self.cash_account,self.share_account);send(&mut self.svm,&self.payer,&[&self.owner],&[ix(a,data)])}
}
