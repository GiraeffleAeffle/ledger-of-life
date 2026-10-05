mod support;

use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_lang::solana_program::{instruction::Instruction, program_pack::Pack, sysvar};
use shares::{accounts, instruction, Escrow, EscrowState, ID};
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::Fixture;
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState};

const START: i64 = 1_800_000_000;
const WINDOW: i64 = 3600;
const DEPOSIT: u64 = 1_000_000_000;
const PRICE: u64 = 400_000_000;
const COVER: u64 = 3_750_000;
#[derive(Clone, Copy)]
enum Role { Tenant, Landlord, Arbitrator, Caller }
struct TestEscrow {
    f: Fixture,
    tenant: Keypair,
    landlord: Keypair,
    arbitrator: Keypair,
    caller: Keypair,
    escrow: Pubkey,
    vault: Pubkey,
    tenant_token: Pubkey,
    landlord_token: Pubkey,
    hash: [u8; 32],
}
impl TestEscrow {
    fn empty() -> Self {
        let mut f = Fixture::new();
        f.set_time(START);
        f.set_price(PRICE, START);
        let tenant = Keypair::new();
        let landlord = Keypair::new();
        let arbitrator = Keypair::new();
        let caller = Keypair::new();
        for key in [&tenant, &landlord, &arbitrator, &caller] { f.svm.airdrop(&key.pubkey(), 100_000_000).unwrap(); }
        let hash = [42; 32];
        let escrow = Pubkey::find_program_address(&[b"escrow", landlord.pubkey().as_ref(), &hash], &ID).0;
        let vault = Pubkey::find_program_address(&[b"escrow_vault", escrow.as_ref()], &ID).0;
        let tenant_token = Pubkey::new_unique();
        let landlord_token = Pubkey::new_unique();
        f.put_token(tenant_token, f.share_mint, tenant.pubkey(), 20_000_000);
        f.put_token(landlord_token, f.share_mint, landlord.pubkey(), 0);
        Self { f, tenant, landlord, arbitrator, caller, escrow, vault, tenant_token, landlord_token, hash }
    }
    fn new() -> Self { let mut t = Self::empty(); let ix = t.initialize_ix(DEPOSIT,[WINDOW;3],t.tenant.pubkey(),t.arbitrator.pubkey()); assert!(t.f.send(ix,&[&t.landlord]).is_ok()); t }
    fn initialize_ix(&self, deposit: u64, windows: [i64;3], tenant: Pubkey, arbitrator: Pubkey) -> Instruction {
        Instruction { program_id: ID, accounts: accounts::InitializeEscrow { payer: self.f.payer.pubkey(), landlord: self.landlord.pubkey(), share_mint: self.f.share_mint, escrow: self.escrow, vault: self.vault, token_program: anchor_spl::token::ID, system_program: anchor_lang::system_program::ID, rent: sysvar::rent::ID }.to_account_metas(None), data: instruction::InitializeEscrow { agreement_hash: self.hash, tenant, arbitrator, deposit_value: deposit, response_window: windows[0], return_window: windows[1], arbitration_window: windows[2] }.data() }
    }
    fn key(&self, role: Role) -> &Keypair { match role { Role::Tenant => &self.tenant, Role::Landlord => &self.landlord, Role::Arbitrator => &self.arbitrator, Role::Caller => &self.caller } }
    fn ix<T: InstructionData>(&self, role: Role, data: T, destination: Pubkey) -> Instruction {
        Instruction { program_id: ID, accounts: accounts::EscrowAction { authority: self.key(role).pubkey(), escrow: self.escrow, share_mint: self.f.share_mint, vault: self.vault, share_account: destination, price: self.f.price, token_program: anchor_spl::token::ID }.to_account_metas(None), data: data.data() }
    }
    fn send<T: InstructionData>(&mut self, role: Role, data: T) -> bool {
        let ix = self.ix(role,data,self.tenant_token);
        self.send_ix(role,ix)
    }
    fn send_ix(&mut self, role: Role, ix: Instruction) -> bool {
        let signer = match role { Role::Tenant => &self.tenant, Role::Landlord => &self.landlord, Role::Arbitrator => &self.arbitrator, Role::Caller => &self.caller };
        self.f.send(ix,&[signer]).is_ok()
    }
    fn state(&self) -> Escrow { let a = self.f.svm.get_account(&self.escrow).unwrap(); Escrow::try_deserialize(&mut a.data.as_slice()).unwrap() }
    fn active(&mut self) { assert!(self.send(Role::Tenant,instruction::Pledge { shares: 4_000_000 })); assert!(self.state().state == EscrowState::Active); }
    fn claim(&mut self, usd6: u64) { assert!(self.send(Role::Landlord,instruction::ProposeClaim { usd6, evidence_hash: [9;32] })); }
    fn payout(&mut self, landlord: bool) -> bool { let destination = if landlord { self.landlord_token } else { self.tenant_token }; let ix = self.ix(Role::Caller,instruction::Payout { to_landlord: landlord },destination); self.send_ix(Role::Caller,ix) }
}

#[test]
fn ratio_boundary_activation_and_withdrawal() {
    let mut t = TestEscrow::new();
    assert!(!t.send(Role::Caller,instruction::Activate {}));
    assert!(t.send(Role::Tenant,instruction::Pledge { shares: COVER-1 }));
    assert!(t.state().state == EscrowState::AwaitingLock);
    assert!(!t.send(Role::Caller,instruction::Activate {}));
    assert!(t.send(Role::Tenant,instruction::Pledge { shares: 1 }));
    assert!(t.state().state == EscrowState::Active);
    assert!(!t.send(Role::Tenant,instruction::Withdraw { shares: 1 }));
    assert!(t.send(Role::Tenant,instruction::Pledge { shares: 1_000_000 }));
    assert!(t.send(Role::Tenant,instruction::Withdraw { shares: 1_000_000 }));
    assert_eq!(t.f.amount(t.vault),COVER);
    assert_eq!(t.state().tracked_balance,COVER);
}
#[test]
fn stale_pledges_then_permissionless_activation_and_price_free_awaiting_withdraw() {
    let mut t = TestEscrow::new();
    t.f.set_price(PRICE,START-75*3600);
    assert!(t.send(Role::Tenant,instruction::Pledge { shares: 4_000_000 }));
    assert!(t.state().state == EscrowState::AwaitingLock);
    assert!(!t.send(Role::Caller,instruction::Activate {}));
    assert!(t.send(Role::Tenant,instruction::Withdraw { shares: 1_000_000 }));
    t.f.set_price(PRICE,START);
    assert!(!t.send(Role::Caller,instruction::Activate {}));
    // An unsolicited transfer can supply cover; permissionless activation uses actual custody.
    t.f.put_token(t.vault,t.f.share_mint,t.escrow,COVER);
    assert!(t.send(Role::Caller,instruction::Activate {}));
    assert!(t.state().state == EscrowState::Active);
    t.f.set_price(PRICE,START-75*3600);
    assert!(t.send(Role::Tenant,instruction::Pledge { shares: 1_000_000 }));
    assert!(!t.send(Role::Tenant,instruction::Withdraw { shares: 1 }));
    assert!(!t.send(Role::Landlord,instruction::ProposeClaim { usd6: 1,evidence_hash:[0;32] }));
}
#[test]
fn claim_rounding_snapshot_lowering_and_consent_cap() {
    let mut t = TestEscrow::new(); t.active();
    t.f.set_price(333_000_000,START);
    t.claim(1_000_001);
    assert_eq!(t.state().claim_shares,3004);
    assert_eq!(t.state().claim_evidence_hash,[9;32]);
    assert!(!t.send(Role::Tenant,instruction::AcceptClaim { max_shares: 3003 }));
    let response = t.state().response_deadline;
    assert!(t.send(Role::Tenant,instruction::ContestClaim {}));
    let started = t.state().arbitration_started_at;
    t.f.set_price(0,0); t.f.set_time(START+100);
    assert!(t.send(Role::Landlord,instruction::LowerClaim { usd6: 1_000_000 }));
    let e = t.state();
    assert_eq!(e.claim_shares,3003); assert_eq!(e.claim_price6,333_000_000);
    assert_eq!(e.claim_source_time,START); assert_eq!(e.response_deadline,response);
    assert_eq!(e.arbitration_started_at,started); assert!(e.arbitration_authorized);
    assert!(e.state == EscrowState::ClaimPending);
    assert!(t.send(Role::Tenant,instruction::AcceptClaim { max_shares: 3003 }));
    assert_eq!(t.state().landlord_owed,3003);
    assert!(t.payout(false)); assert!(t.payout(true));
    assert_eq!(t.f.amount(t.landlord_token),3003);
    assert_eq!(t.f.amount(t.tenant_token),20_000_000-3003);
}
#[test]
fn silent_response_escalates_never_awards_and_arbitrator_caps() {
    let mut t = TestEscrow::new(); t.active(); t.claim(120_000_000);
    assert!(!t.send(Role::Arbitrator,instruction::ResolveClaim { shares: 1 }));
    t.f.set_time(START+WINDOW-1);
    assert!(!t.send(Role::Caller,instruction::EscalateClaim {}));
    t.f.set_time(START+WINDOW);
    assert!(t.send(Role::Caller,instruction::EscalateClaim {}));
    assert_eq!(t.state().landlord_owed,0);
    assert!(t.state().state == EscrowState::ClaimContested);
    assert!(!t.send(Role::Tenant,instruction::AcceptClaim { max_shares: 300_000 }));
    assert!(!t.send(Role::Caller,instruction::EscalateClaim {}));
    t.f.set_price(0,0);
    assert!(t.send(Role::Arbitrator,instruction::ResolveClaim { shares: u64::MAX }));
    assert_eq!(t.state().landlord_owed,300_000);
    assert!(t.payout(true)); assert!(t.payout(false));
    assert_eq!(t.f.amount(t.landlord_token),300_000);
    assert_eq!(t.f.amount(t.vault),0);
}
#[test]
fn lowering_preserves_arbitration_and_response_deadlines_through_recontest() {
    let mut t = TestEscrow::new(); t.active(); t.claim(120_000_000);
    assert!(t.send(Role::Tenant,instruction::ContestClaim {}));
    let e = t.state();
    t.f.set_time(START+100); t.f.set_price(0,0);
    assert!(t.send(Role::Landlord,instruction::LowerClaim { usd6: 100_000_000 }));
    assert!(t.send(Role::Tenant,instruction::ContestClaim {}));
    assert_eq!(t.state().arbitration_started_at,e.arbitration_started_at);
    assert!(t.send(Role::Landlord,instruction::LowerClaim { usd6: 99_000_000 }));
    assert_eq!(t.state().response_deadline,e.response_deadline);
    t.f.set_time(START+WINDOW-1);
    assert!(!t.send(Role::Caller,instruction::CloseUnresolved {}));
    t.f.set_time(START+WINDOW);
    assert!(!t.send(Role::Arbitrator,instruction::ResolveClaim { shares: 1 }));
    assert!(!t.send(Role::Tenant,instruction::AcceptClaim { max_shares: 300_000 }));
    assert!(t.send(Role::Caller,instruction::CloseUnresolved {}));
    assert!(t.payout(false)); assert_eq!(t.f.amount(t.tenant_token),20_000_000);
    assert!(!t.send(Role::Caller,instruction::CloseUnresolved {}));
}
#[test]
fn pending_lowering_stays_escalatable_at_original_response_deadline() {
    let mut t = TestEscrow::new(); t.active(); t.claim(120_000_000);
    t.f.set_time(START+100);
    assert!(t.send(Role::Landlord,instruction::LowerClaim { usd6: 100_000_000 }));
    t.f.set_time(START+WINDOW);
    assert!(t.send(Role::Caller,instruction::EscalateClaim {}));
    assert_eq!(t.state().arbitration_started_at,START+WINDOW);
    t.f.set_time(START+2*WINDOW);
    assert!(t.send(Role::Caller,instruction::CloseUnresolved {}));
    assert!(t.payout(false));
}
#[test]
fn zero_claim_and_withdrawn_claim_are_price_free() {
    for contested in [false,true] {
        let mut t = TestEscrow::new(); t.active(); t.claim(120_000_000);
        if contested { assert!(t.send(Role::Tenant,instruction::ContestClaim {})); }
        t.f.set_price(0,0);
        assert!(t.send(Role::Landlord,instruction::LowerClaim { usd6: 0 }));
        assert!(t.state().state == EscrowState::Closed);
        assert_eq!(t.state().claim_shares,0);
        assert!(t.payout(false)); assert_eq!(t.f.amount(t.tenant_token),20_000_000);
    }
    let mut t = TestEscrow::new(); t.active(); t.f.set_price(0,0); t.claim(0);
    assert!(t.payout(false)); assert_eq!(t.f.amount(t.tenant_token),20_000_000);
}
#[test]
fn return_timeout_and_proposal_deadline_are_exact_and_price_free() {
    let mut t = TestEscrow::new();
    assert!(!t.send(Role::Tenant,instruction::RequestReturn {}));
    t.active();
    assert!(!t.send(Role::Caller,instruction::RequestReturn {}));
    assert!(t.send(Role::Tenant,instruction::RequestReturn {}));
    assert!(!t.send(Role::Tenant,instruction::RequestReturn {}));
    t.f.set_price(0,0); t.f.set_time(START+WINDOW-1);
    assert!(!t.send(Role::Caller,instruction::CloseUnclaimed {}));
    t.f.set_time(START+WINDOW);
    assert!(!t.send(Role::Landlord,instruction::ProposeClaim { usd6:0,evidence_hash:[0;32] }));
    assert!(t.send(Role::Caller,instruction::CloseUnclaimed {}));
    assert!(t.payout(false)); assert_eq!(t.f.amount(t.tenant_token),20_000_000);
    assert!(!t.send(Role::Caller,instruction::CloseUnclaimed {}));
}
#[test]
fn proposal_inside_return_window_cancels_return_but_not_consent() {
    let mut t = TestEscrow::new(); t.active();
    assert!(t.send(Role::Tenant,instruction::RequestReturn {}));
    t.f.set_time(START+WINDOW-1); t.claim(120_000_000);
    assert_eq!(t.state().return_deadline,0);
    t.f.set_time(START+10*86400);
    assert!(!t.send(Role::Caller,instruction::CloseUnclaimed {}));
    assert!(t.send(Role::Caller,instruction::EscalateClaim {}));
    assert!(!t.send(Role::Tenant,instruction::RequestReturn {}));
    assert!(t.send(Role::Arbitrator,instruction::ResolveClaim { shares: 0 }));
    assert!(t.payout(false));
}
#[test]
fn custody_shortfall_donations_and_independent_payouts() {
    let mut t = TestEscrow::new(); t.active();
    t.f.put_token(t.vault,t.f.share_mint,t.escrow,1_000_000);
    t.claim(DEPOSIT); assert_eq!(t.state().claim_shares,1_000_000);
    assert!(t.send(Role::Landlord,instruction::LowerClaim { usd6: 900_000_000 }));
    assert_eq!(t.state().claim_shares,1_000_000);
    assert!(t.send(Role::Tenant,instruction::AcceptClaim { max_shares: 1_000_000 }));
    t.f.put_token(t.vault,t.f.share_mint,t.escrow,500_000);
    assert!(t.payout(false)); assert_eq!(t.f.amount(t.vault),500_000);
    assert!(t.payout(true)); assert_eq!(t.f.amount(t.landlord_token),500_000);
    assert_eq!(t.state().landlord_owed,0);
    t.f.put_token(t.vault,t.f.share_mint,t.escrow,200_000);
    assert!(t.payout(false)); assert_eq!(t.f.amount(t.vault),0);
}
#[test]
fn failed_landlord_transfer_does_not_block_tenant_and_zero_payout_is_idempotent() {
    let mut t = TestEscrow::new(); t.active(); t.claim(120_000_000);
    assert!(t.send(Role::Tenant,instruction::AcceptClaim { max_shares: 300_000 }));
    // Wrong destination is rejected, not redirected to the permissionless caller.
    let ix = t.ix(Role::Caller,instruction::Payout { to_landlord:true },t.tenant_token);
    assert!(!t.send_ix(Role::Caller,ix));
    assert_eq!(t.state().landlord_owed,300_000);
    let mut account = t.f.svm.get_account(&t.landlord_token).unwrap();
    let mut token = TokenAccount::unpack(&account.data).unwrap();
    token.state = AccountState::Frozen;
    TokenAccount::pack(token, &mut account.data).unwrap();
    t.f.svm.set_account(t.landlord_token, account).unwrap();
    assert!(!t.payout(true));
    assert_eq!(t.state().landlord_owed,300_000);
    assert!(t.payout(false)); assert_eq!(t.f.amount(t.vault),300_000);
    t.f.put_token(t.vault,t.f.share_mint,t.escrow,1_300_000);
    assert!(t.payout(false)); assert_eq!(t.f.amount(t.vault),300_000);
    t.f.put_token(t.landlord_token,t.f.share_mint,t.landlord.pubkey(),0);
    assert!(t.payout(true)); assert!(t.payout(true)); assert!(t.payout(false));
    assert_eq!(t.state().tracked_balance,0);
}
#[test]
fn donation_withdrawal_preserves_tracked_custody() {
    let mut t = TestEscrow::new(); t.active();
    t.f.put_token(t.vault,t.f.share_mint,t.escrow,14_000_000);
    assert!(t.send(Role::Tenant,instruction::Withdraw { shares: 10_000_000 }));
    assert_eq!(t.state().tracked_balance,4_000_000);
    assert_eq!(t.f.amount(t.vault),4_000_000);
}
#[test]
fn roles_states_and_amount_caps() {
    let mut t = TestEscrow::new();
    assert!(!t.send(Role::Caller,instruction::Pledge { shares:1 }));
    assert!(!t.send(Role::Tenant,instruction::Pledge { shares:0 }));
    assert!(!t.send(Role::Tenant,instruction::Withdraw { shares:1 }));
    assert!(!t.send(Role::Caller,instruction::CloseUnclaimed {}));
    assert!(!t.send(Role::Caller,instruction::CloseUnresolved {}));
    t.active();
    assert!(!t.send(Role::Caller,instruction::ProposeClaim { usd6:1,evidence_hash:[0;32] }));
    assert!(!t.send(Role::Landlord,instruction::ProposeClaim { usd6:DEPOSIT+1,evidence_hash:[0;32] }));
    t.claim(120_000_000);
    assert!(!t.send(Role::Caller,instruction::AcceptClaim { max_shares:300_000 }));
    assert!(!t.send(Role::Caller,instruction::ContestClaim {}));
    assert!(!t.send(Role::Caller,instruction::LowerClaim { usd6:1 }));
    assert!(!t.send(Role::Landlord,instruction::LowerClaim { usd6:120_000_000 }));
    assert!(!t.send(Role::Landlord,instruction::LowerClaim { usd6:120_000_001 }));
    assert!(!t.send(Role::Tenant,instruction::Withdraw { shares:1 }));
    assert!(t.send(Role::Tenant,instruction::Pledge { shares:1 }));
    assert!(t.send(Role::Tenant,instruction::ContestClaim {}));
    assert!(!t.send(Role::Landlord,instruction::ResolveClaim { shares:0 }));
    assert!(t.send(Role::Tenant,instruction::Pledge { shares:2 }));
    assert!(t.send(Role::Arbitrator,instruction::ResolveClaim { shares:0 }));
    assert!(!t.send(Role::Tenant,instruction::Pledge { shares:1 }));
    assert!(!t.send(Role::Landlord,instruction::LowerClaim { usd6:0 }));
}
#[test]
fn wrong_mint_vault_price_and_source_owner_are_rejected() {
    let mut t = TestEscrow::new();
    let wrong_token = Pubkey::new_unique();
    t.f.put_token(wrong_token,t.f.share_mint,t.caller.pubkey(),4_000_000);
    let ix = t.ix(Role::Tenant,instruction::Pledge { shares:4_000_000 },wrong_token);
    assert!(!t.send_ix(Role::Tenant,ix));
    t.f.put_token(wrong_token,Pubkey::new_unique(),t.tenant.pubkey(),4_000_000);
    let ix = t.ix(Role::Tenant,instruction::Pledge { shares:4_000_000 },wrong_token);
    assert!(!t.send_ix(Role::Tenant,ix));
    let rogue_vault = Pubkey::new_unique(); t.f.put_token(rogue_vault,t.f.share_mint,t.escrow,0);
    let mut ix = t.ix(Role::Tenant,instruction::Pledge { shares:4_000_000 },t.tenant_token);
    ix.accounts[3].pubkey = rogue_vault;
    assert!(!t.send_ix(Role::Tenant,ix));
    let mut ix = t.ix(Role::Tenant,instruction::Pledge { shares:4_000_000 },t.tenant_token);
    ix.accounts[2].pubkey = Pubkey::new_unique();
    assert!(!t.send_ix(Role::Tenant,ix));
    let mut ix = t.ix(Role::Tenant,instruction::Pledge { shares:4_000_000 },t.tenant_token);
    let rogue_price = Pubkey::new_unique();
    let price_account = t.f.svm.get_account(&t.f.price).unwrap();
    t.f.svm.set_account(rogue_price,price_account).unwrap();
    ix.accounts[5].pubkey = rogue_price;
    assert!(!t.send_ix(Role::Tenant,ix));
    assert_eq!(t.f.amount(t.vault),0);
    assert_eq!(t.f.amount(t.tenant_token),20_000_000);
}
#[test]
fn windows_roles_values_and_duplicate_agreements_are_bound() {
    for index in 0..3 { for invalid in [3599,400*86400+1] {
        let mut t = TestEscrow::empty(); let mut windows = [WINDOW;3]; windows[index] = invalid;
        let ix = t.initialize_ix(DEPOSIT,windows,t.tenant.pubkey(),t.arbitrator.pubkey());
        assert!(t.f.send(ix,&[&t.landlord]).is_err());
        assert!(t.f.svm.get_account(&t.escrow).is_none());
    }}
    for invalid in [999_999,10_000_000_001] {
        let mut t = TestEscrow::empty(); let ix = t.initialize_ix(invalid,[WINDOW;3],t.tenant.pubkey(),t.arbitrator.pubkey());
        assert!(t.f.send(ix,&[&t.landlord]).is_err());
    }
    let mut t = TestEscrow::empty();
    let ix = t.initialize_ix(DEPOSIT,[WINDOW;3],t.landlord.pubkey(),t.arbitrator.pubkey());
    assert!(t.f.send(ix,&[&t.landlord]).is_err());
    let ix = t.initialize_ix(DEPOSIT,[WINDOW;3],Pubkey::default(),t.arbitrator.pubkey());
    assert!(t.f.send(ix,&[&t.landlord]).is_err());
    t.hash = [0;32]; t.escrow = Pubkey::find_program_address(&[b"escrow",t.landlord.pubkey().as_ref(),&t.hash],&ID).0;
    t.vault = Pubkey::find_program_address(&[b"escrow_vault",t.escrow.as_ref()],&ID).0;
    let ix = t.initialize_ix(DEPOSIT,[WINDOW;3],t.tenant.pubkey(),t.arbitrator.pubkey());
    assert!(t.f.send(ix,&[&t.landlord]).is_err());
    let mut t = TestEscrow::new();
    let ix = t.initialize_ix(DEPOSIT,[WINDOW;3],t.tenant.pubkey(),t.arbitrator.pubkey());
    assert!(t.f.send(ix,&[&t.landlord]).is_err());
    let attacker_escrow = Pubkey::find_program_address(&[b"escrow",t.caller.pubkey().as_ref(),&t.hash],&ID).0;
    assert_ne!(attacker_escrow,t.escrow);
    let attacker_vault = Pubkey::find_program_address(&[b"escrow_vault",attacker_escrow.as_ref()],&ID).0;
    let mut ix = t.initialize_ix(DEPOSIT,[3600,400*86400,400*86400],t.tenant.pubkey(),t.arbitrator.pubkey());
    ix.accounts[1].pubkey = t.caller.pubkey(); ix.accounts[3].pubkey = attacker_escrow; ix.accounts[4].pubkey = attacker_vault;
    assert!(t.f.send(ix,&[&t.caller]).is_ok());
}
#[test]
fn arithmetic_extremes_fail_without_mutating_custody() {
    let mut t = TestEscrow::new();
    t.f.put_token(t.vault,t.f.share_mint,t.escrow,u64::MAX);
    assert!(!t.send(Role::Tenant,instruction::Pledge { shares:1 }));
    assert_eq!(t.state().tracked_balance,0);
    t.f.set_price(u64::MAX,START);
    assert!(t.send(Role::Caller,instruction::Activate {}));
    t.f.put_token(t.tenant_token,t.f.share_mint,t.tenant.pubkey(),0);
    assert!(t.send(Role::Tenant,instruction::Withdraw { shares:u64::MAX-1 }));
    assert_eq!(t.f.amount(t.vault),1);
}

#[test]
fn escrow_oracle_weekend_normal_and_future_boundaries() {
    let saturday = 2 * 86400 + 3000 * 7 * 86400;
    let monday_noon = 4 * 86400 + 3000 * 7 * 86400 + 12 * 3600;
    for (timestamp, max_age) in [(saturday,74*3600),(monday_noon,26*3600)] {
        for (age, activates) in [(max_age,true),(max_age+1,false),(-1,false)] {
            let mut t = TestEscrow::new();
            t.f.set_time(timestamp);
            t.f.set_price(PRICE,timestamp-age);
            assert!(t.send(Role::Tenant,instruction::Pledge { shares:4_000_000 }));
            assert_eq!(t.state().state == EscrowState::Active,activates);
            if !activates { assert!(!t.send(Role::Caller,instruction::Activate {})); }
        }
    }
}

#[test]
fn pledge_and_withdraw_failures_roll_back_accounting() {
    let mut t = TestEscrow::new();
    assert!(!t.send(Role::Tenant,instruction::Pledge { shares:20_000_001 }));
    assert_eq!(t.state().tracked_balance,0);
    assert_eq!(t.f.amount(t.vault),0);
    assert_eq!(t.f.amount(t.tenant_token),20_000_000);
    t.active();
    let wrong_destination = Pubkey::new_unique();
    t.f.put_token(wrong_destination,t.f.share_mint,t.caller.pubkey(),0);
    let ix = t.ix(Role::Tenant,instruction::Withdraw { shares:250_000 },wrong_destination);
    assert!(!t.send_ix(Role::Tenant,ix));
    assert_eq!(t.state().tracked_balance,4_000_000);
    assert_eq!(t.f.amount(t.vault),4_000_000);
}
