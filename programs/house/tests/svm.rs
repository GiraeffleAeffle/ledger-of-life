use anchor_lang::{prelude::{Pubkey, Clock}, solana_program::{instruction::Instruction, program_option::COption, program_pack::Pack}, AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
use house::{accounts, instruction, House, Position, ADMIN, CASH_MINT, ID, REWARD_DURATION, SCALE};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn put(svm: &mut LiteSVM, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
    svm.set_account(key, Account { lamports: svm.minimum_balance_for_rent_exemption(data.len()), data, owner, executable: false, rent_epoch: 0 }).unwrap();
}
fn token(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(TokenAccount { mint, owner, amount, delegate: COption::None, state: AccountState::Initialized, is_native: COption::None, delegated_amount: 0, close_authority: COption::None }, &mut data).unwrap(); data
}
fn mint() -> Vec<u8> {
    let mut data = vec![0; Mint::LEN];
    Mint::pack(Mint { mint_authority: COption::Some(Pubkey::new_unique()), supply: 1_000_000_000, decimals: 6, is_initialized: true, freeze_authority: COption::None }, &mut data).unwrap(); data
}
struct User { key: Keypair, cash: Pubkey, units: Pubkey, position: Pubkey }
struct F { svm: LiteSVM, payer: Keypair, house: Pubkey, unit_mint: Pubkey, desk: Pubkey, rewards: Pubkey, stake: Pubkey, users: [User; 2] }
impl F {
    fn new() -> Self {
        let mut svm = LiteSVM::new(); svm.add_program_from_file(ID, std::env::var("HOUSE_PROGRAM_SO").expect("set HOUSE_PROGRAM_SO to compiled house.so")).unwrap();
        let mut clock: Clock = svm.get_sysvar(); clock.unix_timestamp = 1_700_000_000; svm.set_sysvar(&clock);
        let payer = Keypair::new(); svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        put(&mut svm, CASH_MINT, anchor_spl::token::ID, mint());
        let house = Pubkey::find_program_address(&[b"house", b"neighbourhood-homes"], &ID).0;
        let pda = |seed: &[u8]| Pubkey::find_program_address(&[seed, house.as_ref()], &ID).0;
        let unit_mint = pda(b"units"); let desk = pda(b"desk"); let rewards = pda(b"rewards"); let stake = pda(b"stake");
        let users = std::array::from_fn(|_| { let key = Keypair::new(); let position = Pubkey::find_program_address(&[b"position", house.as_ref(), key.pubkey().as_ref()], &ID).0; svm.airdrop(&key.pubkey(), 1_000_000).unwrap(); User { key, cash: Pubkey::new_unique(), units: Pubkey::new_unique(), position } });
        // Impersonate only the public admin address for setup; never load a production secret.
        // Restore actual signature verification for every user/negative transaction.
        svm.airdrop(&ADMIN, 10_000_000_000).unwrap();
        let init = Instruction { program_id: ID, accounts: accounts::InitializeHouse { admin: ADMIN, house, cash_mint: CASH_MINT, unit_mint, desk_vault: desk, reward_vault: rewards, stake_vault: stake, token_program: anchor_spl::token::ID, system_program: anchor_lang::system_program::ID, rent: anchor_lang::solana_program::sysvar::rent::ID }.to_account_metas(None), data: instruction::InitializeHouse { id: "neighbourhood-homes".into(), price_cash_per_unit: 1_000_000, sell_cap_units: 100_000_000 }.data() };
        svm = svm.with_sigverify(false);
        let mut tx = Transaction::new_unsigned(Message::new(&[init], Some(&ADMIN))); tx.message.recent_blockhash = svm.latest_blockhash(); svm.send_transaction(tx).unwrap();
        svm = svm.with_sigverify(true);
        let mut f = Self { svm, payer, house, unit_mint, desk, rewards, stake, users };
        for u in &f.users { put(&mut f.svm, u.cash, anchor_spl::token::ID, token(CASH_MINT, u.key.pubkey(), 1_000_000_000)); put(&mut f.svm, u.units, anchor_spl::token::ID, token(unit_mint, u.key.pubkey(), 0)); }
        f
    }
    fn send(&mut self, ixs: Vec<Instruction>, users: &[usize]) -> TransactionResult {
        self.svm.expire_blockhash();
        let mut keys = vec![&self.payer]; for &i in users { keys.push(&self.users[i].key); }
        let tx = Transaction::new(&keys, Message::new(&ixs, Some(&self.payer.pubkey())), self.svm.latest_blockhash()); self.svm.send_transaction(tx)
    }
    fn trade(&self, u: usize, amount: u64, buy: bool) -> Instruction {
        let u = &self.users[u]; Instruction { program_id: ID, accounts: accounts::Trade { actor: u.key.pubkey(), house: self.house, unit_mint: self.unit_mint, user_cash: u.cash, user_units: u.units, desk_vault: self.desk, token_program: anchor_spl::token::ID }.to_account_metas(None), data: if buy { instruction::BuyUnits { units: amount }.data() } else { instruction::SellUnits { units: amount }.data() } }
    }
    fn stake_ix(&self, u: usize, amount: u64) -> Instruction {
        let u = &self.users[u]; Instruction { program_id: ID, accounts: accounts::Stake { owner: u.key.pubkey(), payer: self.payer.pubkey(), house: self.house, position: u.position, user_units: u.units, stake_vault: self.stake, token_program: anchor_spl::token::ID, system_program: anchor_lang::system_program::ID }.to_account_metas(None), data: instruction::Stake { units: amount }.data() }
    }
    fn unstake_ix(&self, u: usize, amount: u64) -> Instruction {
        let u = &self.users[u]; Instruction { program_id: ID, accounts: accounts::Unstake { owner: u.key.pubkey(), house: self.house, position: u.position, user_units: u.units, stake_vault: self.stake, token_program: anchor_spl::token::ID }.to_account_metas(None), data: instruction::Unstake { units: amount }.data() }
    }
    fn deposit(&self, u: usize, amount: u64, source: u8) -> Instruction {
        Instruction { program_id: ID, accounts: accounts::DepositRewards { authority: self.users[u].key.pubkey(), house: self.house, source: self.users[u].cash, reward_vault: self.rewards, token_program: anchor_spl::token::ID }.to_account_metas(None), data: instruction::DepositRewards { amount, source }.data() }
    }
    fn claim(&self, u: usize) -> Instruction {
        let u = &self.users[u]; Instruction { program_id: ID, accounts: accounts::Claim { owner: u.key.pubkey(), house: self.house, position: u.position, user_cash: u.cash, reward_vault: self.rewards, token_program: anchor_spl::token::ID }.to_account_metas(None), data: instruction::Claim {}.data() }
    }
    fn h(&self) -> House { House::try_deserialize(&mut self.svm.get_account(&self.house).unwrap().data.as_slice()).unwrap() }
    fn p(&self, u: usize) -> Position { Position::try_deserialize(&mut self.svm.get_account(&self.users[u].position).unwrap().data.as_slice()).unwrap() }
    fn amount(&self, key: Pubkey) -> u64 { TokenAccount::unpack(&self.svm.get_account(&key).unwrap().data).unwrap().amount }
    fn set_house(&mut self, h: House) { let mut data = Vec::new(); h.try_serialize(&mut data).unwrap(); put(&mut self.svm, self.house, ID, data); }
    fn advance(&mut self, seconds: u64) { let mut clock: Clock = self.svm.get_sysvar(); clock.unix_timestamp += seconds as i64; self.svm.set_sysvar(&clock); }
}
#[test]
fn every_instruction_and_atomic_reinvest() {
    let mut f = F::new(); assert_eq!(f.svm.get_account(&f.house).unwrap().data.len(), House::LEN);
    f.send(vec![f.trade(0, 10_000_000, true), f.stake_ix(0, 10_000_000)], &[0]).unwrap();
    f.send(vec![f.deposit(1, 4_000_000, 0)], &[1]).unwrap();
    f.advance(REWARD_DURATION);
    f.send(vec![f.claim(0), f.trade(0, 4_000_000, true), f.stake_ix(0, 4_000_000)], &[0]).unwrap();
    assert_eq!(f.p(0).claimed_total, 4_000_000); assert_eq!(f.p(0).staked, 14_000_000); assert_eq!(f.h().staker_count, 1);
    f.send(vec![f.unstake_ix(0, 14_000_000), f.trade(0, 14_000_000, false)], &[0]).unwrap();
    assert_eq!(f.h().total_staked, 0); assert_eq!(f.h().staker_count, 0); assert_eq!(f.amount(f.users[0].units), 0); assert_eq!(f.amount(f.desk), 0);
}
#[test]
fn zero_stakers_then_first_stake_restarts_idle_cash_as_stream() {
    let mut f = F::new(); f.send(vec![f.deposit(1, 6_000_000, 2)], &[1]).unwrap();
    f.advance(REWARD_DURATION);
    f.send(vec![f.trade(0, 2_000_000, true), f.stake_ix(0, 2_000_000), f.claim(0)], &[0]).unwrap();
    assert_eq!(f.p(0).claimed_total, 0); assert_eq!(f.h().undistributed_scaled, 0); assert_eq!(f.h().stream_remaining_scaled, 6_000_000 * SCALE);
    f.advance(REWARD_DURATION);
    f.send(vec![f.claim(0)], &[0]).unwrap();
    assert_eq!(f.p(0).claimed_total, 6_000_000); assert_eq!(f.h().revenue_by_source, [0, 0, 6_000_000, 0]);
}
#[test]
fn two_stakers_receive_pro_rata_without_historical_rewards() {
    let mut f = F::new(); f.send(vec![f.trade(0, 1_000_000, true), f.stake_ix(0, 1_000_000)], &[0]).unwrap();
    f.send(vec![f.deposit(0, 1_000_000, 0)], &[0]).unwrap();
    f.advance(REWARD_DURATION);
    f.send(vec![f.claim(0)], &[0]).unwrap();
    f.send(vec![f.trade(1, 3_000_000, true), f.stake_ix(1, 3_000_000), f.deposit(1, 8_000_000, 1)], &[1]).unwrap();
    f.advance(REWARD_DURATION);
    f.send(vec![f.claim(0), f.claim(1)], &[0, 1]).unwrap(); assert_eq!(f.p(0).claimed_total, 3_000_000); assert_eq!(f.p(1).claimed_total, 6_000_000);
}
#[test]
fn delegate_deposit_enforces_allowance() {
    let mut f = F::new();
    let approve = anchor_spl::token::spl_token::instruction::approve(&anchor_spl::token::ID, &f.users[0].cash, &f.users[1].key.pubkey(), &f.users[0].key.pubkey(), &[], 2_000_000).unwrap();
    f.send(vec![approve], &[0]).unwrap();
    let mut deposit = f.deposit(0, 1_500_000, 1); deposit.accounts[0].pubkey = f.users[1].key.pubkey();
    f.send(vec![deposit.clone()], &[1]).unwrap(); assert_eq!(f.h().revenue_total, 1_500_000);
    assert!(f.send(vec![deposit], &[1]).is_err()); assert_eq!(f.h().revenue_total, 1_500_000);
}
#[test]
fn wrong_signer_vault_mint_and_token_program_are_rejected() {
    let mut f = F::new();
    let mut buy = f.trade(0, 1_000_000, true); buy.accounts[0].pubkey = f.users[1].key.pubkey(); assert!(f.send(vec![buy], &[1]).is_err());
    let mut buy = f.trade(0, 1_000_000, true); buy.accounts[5].pubkey = f.rewards; assert!(f.send(vec![buy], &[0]).is_err());
    let mut buy = f.trade(0, 1_000_000, true); buy.accounts[6].pubkey = anchor_lang::system_program::ID; assert!(f.send(vec![buy], &[0]).is_err());
    let wrong_cash = Pubkey::new_unique(); put(&mut f.svm, wrong_cash, anchor_spl::token::ID, token(Pubkey::new_unique(), f.users[0].key.pubkey(), 10_000_000));
    let mut dep = f.deposit(0, 1, 0); dep.accounts[2].pubkey = wrong_cash; assert!(f.send(vec![dep], &[0]).is_err());
    let mut dep = f.deposit(0, 1, 0); dep.accounts[3].pubkey = f.desk; assert!(f.send(vec![dep], &[0]).is_err());
    let mut dep = f.deposit(0, 1, 0); dep.accounts[0].pubkey = f.users[1].key.pubkey(); assert!(f.send(vec![dep], &[1]).is_err());
    f.send(vec![f.trade(0, 1_000_000, true), f.stake_ix(0, 1_000_000)], &[0]).unwrap();
    let mut claim = f.claim(0); claim.accounts[0].pubkey = f.users[1].key.pubkey(); assert!(f.send(vec![claim], &[1]).is_err());
    let mut claim = f.claim(0); claim.accounts[4].pubkey = f.desk; assert!(f.send(vec![claim], &[0]).is_err());
    let mut unstake = f.unstake_ix(0, 1); unstake.accounts[4].pubkey = f.users[0].units; assert!(f.send(vec![unstake], &[0]).is_err());
}
#[test]
fn caps_zero_inputs_desk_short_and_checked_overflow_roll_back() {
    let mut f = F::new(); assert!(f.send(vec![f.trade(0, 0, true)], &[0]).is_err()); assert!(f.send(vec![f.trade(0, 100_000_001, false)], &[0]).is_err());
    assert!(f.send(vec![f.deposit(0, 1, 4)], &[0]).is_err()); f.send(vec![f.deposit(0, 0, 0)], &[0]).unwrap(); assert_eq!(f.h().revenue_total, 0);
    f.send(vec![f.trade(0, 1_000_000, true), f.stake_ix(0, 1_000_000)], &[0]).unwrap();
    assert!(f.send(vec![f.unstake_ix(0, 1_000_001)], &[0]).is_err());
    let mut h = f.h(); h.revenue_total = u64::MAX; f.set_house(h); assert!(f.send(vec![f.deposit(0, 1, 0)], &[0]).is_err()); assert_eq!(f.amount(f.rewards), 0);
    let mut h = f.h(); h.revenue_total = 0; h.stream_remaining_scaled = u128::MAX; f.set_house(h); assert!(f.send(vec![f.deposit(0, 1, 0)], &[0]).is_err());
    let mut h = f.h(); h.stream_remaining_scaled = 0; h.reward_per_unit_stored = u128::MAX; f.set_house(h); assert!(f.send(vec![f.claim(0)], &[0]).is_err());
    let mut h = f.h(); h.reward_per_unit_stored = 0; h.price_cash_per_unit = u64::MAX; f.set_house(h); assert!(f.send(vec![f.trade(0, u64::MAX, true)], &[0]).is_err());
    let mut h = f.h(); h.price_cash_per_unit = 2_000_000; f.set_house(h); f.send(vec![f.unstake_ix(0, 1_000_000)], &[0]).unwrap(); assert!(f.send(vec![f.trade(0, 1_000_000, false)], &[0]).is_err()); assert_eq!(f.amount(f.users[0].units), 1_000_000);
}
#[test]
fn price_rounding_ceil_buy_floor_sell_keeps_dust() {
    let mut f = F::new(); let mut h = f.h(); h.price_cash_per_unit = 1_000_001; f.set_house(h);
    f.send(vec![f.trade(0, 1, true)], &[0]).unwrap(); assert_eq!(f.amount(f.desk), 2);
    f.send(vec![f.trade(0, 1, false)], &[0]).unwrap(); assert_eq!(f.amount(f.desk), 1);
}

#[test]
fn unauthorized_initializer_cannot_squat_public_house_id() {
    let mut f = F::new(); let id = "workshop"; let house = Pubkey::find_program_address(&[b"house", id.as_bytes()], &ID).0;
    let pda = |seed: &[u8]| Pubkey::find_program_address(&[seed, house.as_ref()], &ID).0;
    f.svm.airdrop(&f.users[0].key.pubkey(), 1_000_000_000).unwrap();
    let init = Instruction { program_id: ID, accounts: accounts::InitializeHouse { admin: f.users[0].key.pubkey(), house, cash_mint: CASH_MINT, unit_mint: pda(b"units"), desk_vault: pda(b"desk"), reward_vault: pda(b"rewards"), stake_vault: pda(b"stake"), token_program: anchor_spl::token::ID, system_program: anchor_lang::system_program::ID, rent: anchor_lang::solana_program::sysvar::rent::ID }.to_account_metas(None), data: instruction::InitializeHouse { id: id.into(), price_cash_per_unit: 1, sell_cap_units: u64::MAX }.data() };
    let failure = f.send(vec![init], &[0]).unwrap_err();
    assert!(failure.meta.logs.iter().any(|log| log.contains("ConstraintAddress"))); assert!(f.svm.get_account(&house).is_none());
}

#[test]
fn same_transaction_sandwich_gets_no_reward_and_elapsed_capture_is_bounded() {
    let mut f = F::new();
    f.send(vec![f.trade(0, 1_000_000, true), f.stake_ix(0, 1_000_000)], &[0]).unwrap();
    let before = f.amount(f.users[1].cash);
    f.send(vec![f.trade(1, 99_000_000, true), f.stake_ix(1, 99_000_000), f.deposit(0, 10_000_000, 0), f.claim(1), f.unstake_ix(1, 99_000_000), f.trade(1, 99_000_000, false)], &[0, 1]).unwrap();
    assert_eq!(f.p(1).claimed_total, 0); assert_eq!(f.amount(f.users[1].cash), before);
    f.send(vec![f.trade(1, 99_000_000, true), f.stake_ix(1, 99_000_000)], &[1]).unwrap();
    f.advance(60);
    f.send(vec![f.claim(1), f.unstake_ix(1, 99_000_000), f.trade(1, 99_000_000, false)], &[1]).unwrap();
    assert!(f.p(1).claimed_total <= 10_000_000 * 60 / REWARD_DURATION);
    assert!(f.p(1).claimed_total > 0);
}

#[test]
fn new_revenue_extends_only_unstreamed_budget() {
    let mut f = F::new(); f.send(vec![f.trade(0, 1_000_000, true), f.stake_ix(0, 1_000_000), f.deposit(1, 8_000_000, 0)], &[0, 1]).unwrap();
    let old_finish = f.h().period_finish;
    f.advance(REWARD_DURATION / 2);
    f.send(vec![f.claim(0), f.deposit(1, 2_000_000, 1)], &[0, 1]).unwrap();
    assert_eq!(f.p(0).claimed_total, 3_999_999); // Rate division remainder is paid at finish.
    assert_eq!(f.h().period_finish, old_finish + (REWARD_DURATION / 2) as i64);
    let earned = f.p(0).claimed_total;
    f.advance(REWARD_DURATION);
    f.send(vec![f.claim(0)], &[0]).unwrap(); assert_eq!(f.p(0).claimed_total, 10_000_000); assert!(earned < f.p(0).claimed_total);
}

#[test]
fn nondivisible_repeated_one_atom_deposits_preserve_both_remainders() {
    let mut f = F::new(); f.send(vec![f.trade(0, 3, true), f.stake_ix(0, 3)], &[0]).unwrap();
    for _ in 0..3 {
        f.send(vec![f.deposit(1, 1, 3)], &[1]).unwrap(); f.advance(REWARD_DURATION);
        f.send(vec![f.claim(0)], &[0]).unwrap();
    }
    assert_eq!(f.p(0).claimed_total, 3); assert_eq!(f.p(0).reward_fraction, 0); assert_eq!(f.h().reward_remainder_scaled, 0); assert_eq!(f.amount(f.rewards), 0);
}

#[test]
fn full_exit_recycles_fraction_without_extending_active_finish() {
    let mut f = F::new();
    f.send(vec![f.trade(0, 1, true), f.stake_ix(0, 1), f.trade(1, 2, true), f.stake_ix(1, 2), f.deposit(0, 1, 0)], &[0, 1]).unwrap();
    let finish = f.h().period_finish; f.advance(REWARD_DURATION / 2);
    f.send(vec![f.unstake_ix(0, 1)], &[0]).unwrap();
    assert_eq!(f.h().period_finish, finish); assert_eq!(f.p(0).reward_fraction, 0);
    f.advance(REWARD_DURATION / 2);
    f.send(vec![f.claim(1), f.unstake_ix(1, 2)], &[1]).unwrap();
    f.send(vec![f.stake_ix(1, 2)], &[1]).unwrap(); f.advance(REWARD_DURATION);
    f.send(vec![f.claim(1)], &[1]).unwrap();
    assert_eq!(f.p(0).claimed_total + f.p(1).claimed_total, 1); assert_eq!(f.amount(f.rewards), 0);
}
