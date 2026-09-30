//! Executable SBF integration tests. Requires an explicit, read-only public KLend snapshot.
//! Only the reserve mint and test token balances are replaced. No network calls occur in these tests.
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program_option::COption,
        program_pack::Pack,
    },
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
use base64::Engine;
use klend_interface::{state::Reserve, KLEND_PROGRAM_ID};
use litesvm::{types::TransactionResult, LiteSVM};
use rental_escrow::{
    accounts, instruction,
    state::{Phase, Tenancy},
    InitializeArgs, ID, LEDGER_TEST_USDC, TEST_USDC,
};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{path::PathBuf, str::FromStr};

const PRINCIPAL: u64 = 3_000_000_000;
const CLAIM: u64 = 120_000_000;
fn ata(owner: Pubkey) -> Pubkey {
    ata_for_mint(owner, TEST_USDC)
}
fn ata_for_mint(owner: Pubkey, mint: Pubkey) -> Pubkey {
    let program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap();
    Pubkey::find_program_address(
        &[
            owner.as_ref(),
            anchor_spl::token::ID.as_ref(),
            mint.as_ref(),
        ],
        &program,
    )
    .0
}
struct Fixture {
    svm: LiteSVM,
    payer: Keypair,
    tenant: Keypair,
    landlord: Keypair,
    arbitrator: Keypair,
    tenancy: Pubkey,
    cash: Pubkey,
    receipts: Pubkey,
    tenant_token: Pubkey,
    landlord_token: Pubkey,
    market: Pubkey,
    reserve: Pubkey,
    receipt_mint: Pubkey,
    supply: Pubkey,
    market_authority: Pubkey,
    oracles: Vec<Pubkey>,
}
fn token_data(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(
        TokenAccount {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    data
}
fn mint_data(authority: Pubkey, supply: u64) -> Vec<u8> {
    let mut data = vec![0; Mint::LEN];
    Mint::pack(
        Mint {
            mint_authority: COption::Some(authority),
            supply,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    data
}
fn put(svm: &mut LiteSVM, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
    svm.set_account(
        key,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}
impl Fixture {
    fn new() -> Self {
        let binary = PathBuf::from(
            std::env::var("RENTAL_ESCROW_SBF")
                .expect("set RENTAL_ESCROW_SBF to the test-deployment SBF binary"),
        );
        let dir = PathBuf::from(
            std::env::var("KAMINO_FIXTURE_DIR")
                .expect("set KAMINO_FIXTURE_DIR to the public read-only snapshot directory"),
        );
        let snapshot: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("accounts.json")).unwrap()).unwrap();
        let provenance: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("provenance.json")).unwrap()).unwrap();
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(ID, binary).unwrap();
        svm.add_program_from_file(KLEND_PROGRAM_ID, dir.join("klend.so"))
            .unwrap();
        let mut clock: Option<anchor_lang::prelude::Clock> = None;
        for (key, value) in snapshot["accounts"].as_object().unwrap() {
            let key = Pubkey::from_str(key).unwrap();
            let data = base64::engine::general_purpose::STANDARD
                .decode(value["data"][0].as_str().unwrap())
                .unwrap();
            if key == anchor_lang::solana_program::sysvar::clock::ID {
                clock = Some(bincode::deserialize(&data).unwrap());
                continue;
            }
            svm.set_account(
                key,
                Account {
                    lamports: value["lamports"].as_u64().unwrap(),
                    data,
                    owner: value["owner"].as_str().unwrap().parse().unwrap(),
                    executable: value["executable"].as_bool().unwrap(),
                    rent_epoch: 0,
                },
            )
            .unwrap();
        }
        svm.set_sysvar(&clock.unwrap());
        let market = Pubkey::from_str("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF").unwrap();
        let reserve = Pubkey::from_str("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59").unwrap();
        let market_authority =
            klend_interface::pda::lending_market_authority(&KLEND_PROGRAM_ID, &market).0;
        let mut reserve_account = svm.get_account(&reserve).unwrap();
        let state = bytemuck::from_bytes_mut::<Reserve>(&mut reserve_account.data[8..]);
        state.liquidity.mint_pubkey = TEST_USDC;
        let supply = state.liquidity.supply_vault;
        let receipt_mint = state.collateral.mint_pubkey;
        let available = state.liquidity.total_available_amount;
        let collateral_supply = state.collateral.mint_total_supply;
        svm.set_account(reserve, reserve_account).unwrap();
        put(
            &mut svm,
            TEST_USDC,
            anchor_spl::token::ID,
            mint_data(market_authority, available + PRINCIPAL),
        );
        put(
            &mut svm,
            receipt_mint,
            anchor_spl::token::ID,
            mint_data(market_authority, collateral_supply),
        );
        put(
            &mut svm,
            supply,
            anchor_spl::token::ID,
            token_data(TEST_USDC, market_authority, available),
        );
        let payer = Keypair::new();
        let tenant = Keypair::new();
        let landlord = Keypair::new();
        let arbitrator = Keypair::new();
        svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();
        for key in [tenant.pubkey(), landlord.pubkey(), arbitrator.pubkey()] {
            svm.airdrop(&key, 1_000_000).unwrap();
        }
        let tenancy =
            Pubkey::find_program_address(&[b"tenancy", tenant.pubkey().as_ref(), &[1; 32]], &ID).0;
        let cash = Pubkey::find_program_address(&[b"cash", tenancy.as_ref()], &ID).0;
        let receipts = Pubkey::find_program_address(&[b"receipts", tenancy.as_ref()], &ID).0;
        let tenant_token = ata(tenant.pubkey());
        let landlord_token = ata(landlord.pubkey());
        put(
            &mut svm,
            tenant_token,
            anchor_spl::token::ID,
            token_data(TEST_USDC, tenant.pubkey(), PRINCIPAL),
        );
        put(
            &mut svm,
            landlord_token,
            anchor_spl::token::ID,
            token_data(TEST_USDC, landlord.pubkey(), 0),
        );
        let oracles = provenance["oracleAccounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().parse().unwrap())
            .collect();
        Self {
            svm,
            payer,
            tenant,
            landlord,
            arbitrator,
            tenancy,
            cash,
            receipts,
            tenant_token,
            landlord_token,
            market,
            reserve,
            receipt_mint: receipt_mint,
            supply: supply,
            market_authority,
            oracles,
        }
    }
    fn send(&mut self, ix: Instruction, role: &str) -> TransactionResult {
        // A fresh transaction signature ensures replay failures exercise our nonce, not SVM's cache.
        self.svm.expire_blockhash();
        let mut signers = vec![&self.payer];
        match role {
            "both" => {
                signers.push(&self.tenant);
                signers.push(&self.landlord);
            }
            "tenant" => signers.push(&self.tenant),
            "landlord" => signers.push(&self.landlord),
            "arbitrator" => signers.push(&self.arbitrator),
            _ => {}
        }
        let tx = Transaction::new(
            &signers,
            Message::new(&[ix], Some(&self.payer.pubkey())),
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }
    fn prepare_deposit_mint(&mut self, mint: Pubkey) {
        put(&mut self.svm, mint, anchor_spl::token::ID, mint_data(self.tenant.pubkey(), PRINCIPAL));
        self.tenant_token = ata_for_mint(self.tenant.pubkey(), mint);
        self.landlord_token = ata_for_mint(self.landlord.pubkey(), mint);
        put(&mut self.svm, self.tenant_token, anchor_spl::token::ID, token_data(mint, self.tenant.pubkey(), PRINCIPAL));
        put(&mut self.svm, self.landlord_token, anchor_spl::token::ID, token_data(mint, self.landlord.pubkey(), 0));
    }
    fn initialize(&mut self) {
        self.initialize_with_mint(TEST_USDC).unwrap();
    }
    fn initialize_with_mint(&mut self, mint: Pubkey) -> TransactionResult {
        let ix = Instruction {
            program_id: ID,
            accounts: accounts::Initialize {
                payer: self.payer.pubkey(),
                tenant: self.tenant.pubkey(),
                landlord: self.landlord.pubkey(),
                tenancy: self.tenancy,
                deposit_mint: mint,
                receipt_mint: self.receipt_mint,
                cash: self.cash,
                receipts: self.receipts,
                tenant_destination: self.tenant_token,
                landlord_destination: self.landlord_token,
                reserve: self.reserve,
                market: self.market,
                token_program: anchor_spl::token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::Initialize {
                args: InitializeArgs {
                    lease_id: [1; 32],
                    arbitrator: self.arbitrator.pubkey(),
                    required_security: PRINCIPAL,
                    policy_hash: [2; 32],
                    release_permitted: true,
                    liquidity_supply: self.supply,
                    market_authority: self.market_authority,
                },
            }
            .data(),
        };
        self.send(ix, "both")
    }
    fn staged_initialize(&mut self, role: &str) -> TransactionResult {
        self.staged_initialize_with_mint(TEST_USDC, role)
    }
    fn staged_initialize_with_mint(&mut self, mint: Pubkey, role: &str) -> TransactionResult {
        let ix = Instruction {
            program_id: ID,
            accounts: accounts::InitializeStaged {
                payer: self.payer.pubkey(),
                tenant: self.tenant.pubkey(),
                landlord: self.landlord.pubkey(),
                tenancy: self.tenancy,
                deposit_mint: mint,
                receipt_mint: self.receipt_mint,
                cash: self.cash,
                receipts: self.receipts,
                tenant_destination: self.tenant_token,
                landlord_destination: self.landlord_token,
                reserve: self.reserve,
                market: self.market,
                token_program: anchor_spl::token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::InitializeStaged {
                args: InitializeArgs {
                    lease_id: [1; 32],
                    arbitrator: self.arbitrator.pubkey(),
                    required_security: PRINCIPAL,
                    policy_hash: [2; 32],
                    release_permitted: true,
                    liquidity_supply: self.supply,
                    market_authority: self.market_authority,
                },
            }
            .data(),
        };
        self.send(ix, role)
    }
    fn fund(&mut self) {
        let ix = Instruction {
            program_id: ID,
            accounts: accounts::Fund {
                tenant: self.tenant.pubkey(),
                tenancy: self.tenancy,
                deposit_mint: TEST_USDC,
                source: self.tenant_token,
                cash: self.cash,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
            data: instruction::Fund { nonce: 0 }.data(),
        };
        self.send(ix, "tenant").unwrap();
    }
    fn finance(&self, data: Vec<u8>, actor: Pubkey) -> Instruction {
        let mut accounts = accounts::Finance {
            actor,
            tenancy: self.tenancy,
            deposit_mint: TEST_USDC,
            receipt_mint: self.receipt_mint,
            cash: self.cash,
            receipts: self.receipts,
            destination: self.tenant_token,
            reserve: self.reserve,
            market: self.market,
            market_authority: self.market_authority,
            liquidity_supply: self.supply,
            klend_program: KLEND_PROGRAM_ID,
            instructions_sysvar: anchor_lang::solana_program::sysvar::instructions::ID,
            token_program: anchor_spl::token::ID,
        }
        .to_account_metas(None);
        accounts.extend(
            self.oracles
                .iter()
                .map(|key| AccountMeta::new_readonly(*key, false)),
        );
        Instruction {
            program_id: ID,
            accounts,
            data,
        }
    }
    fn party(&self, actor: Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::Party {
                actor,
                tenancy: self.tenancy,
            }
            .to_account_metas(None),
            data,
        }
    }
    fn state(&self) -> Tenancy {
        Tenancy::try_deserialize(&mut self.svm.get_account(&self.tenancy).unwrap().data.as_slice())
            .unwrap()
    }
    fn balance(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.svm.get_account(&key).unwrap().data)
            .unwrap()
            .amount
    }
    fn controlled_yield_fixture(&mut self, target_cash: u64) {
        // This is an explicitly synthetic protocol-accrual fixture, never a claimed market return.
        let t = self.state();
        let mut account = self.svm.get_account(&self.reserve).unwrap();
        let r = bytemuck::from_bytes_mut::<Reserve>(&mut account.data[8..]);
        let target = target_cash - t.accounted_idle;
        let original = r.liquidity.total_available_amount;
        let net = |available| {
            rental_escrow::accounting::net_liquidity_sf(
                available,
                u128::from(r.liquidity.borrowed_amount_sf),
                u128::from(r.liquidity.accumulated_protocol_fees_sf),
                u128::from(r.liquidity.accumulated_referrer_fees_sf),
                u128::from(r.liquidity.pending_referrer_fees_sf),
            )
            .unwrap()
        };
        let value = |available| {
            rental_escrow::accounting::receipt_value(
                t.accounted_receipts,
                r.collateral.mint_total_supply,
                net(available),
            )
            .unwrap()
        };
        let mut low = original;
        let mut high = original
            + ((20_000_000u128 * r.collateral.mint_total_supply as u128)
                / (t.accounted_receipts as u128)) as u64;
        assert!(value(high) >= target);
        while low < high {
            let mid = low + (high - low) / 2;
            if value(mid) < target {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        assert_eq!(value(low), target);
        r.liquidity.total_available_amount = low;
        self.svm.set_account(self.reserve, account).unwrap();
        put(
            &mut self.svm,
            self.supply,
            anchor_spl::token::ID,
            token_data(TEST_USDC, self.market_authority, low),
        );
    }
    fn settle(&self, nonce: u64) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::Settle {
                actor: self.tenant.pubkey(),
                tenancy: self.tenancy,
                deposit_mint: TEST_USDC,
                cash: self.cash,
            }
            .to_account_metas(None),
            data: instruction::Settle { nonce }.data(),
        }
    }
    fn payout(&self, destination: Pubkey, landlord: bool, nonce: u64) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::Payout {
                actor: self.payer.pubkey(),
                tenancy: self.tenancy,
                deposit_mint: TEST_USDC,
                cash: self.cash,
                destination,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
            data: instruction::Payout { landlord, nonce }.data(),
        }
    }
}

#[test]
#[ignore = "requires explicit SBF and public KLend fixture paths; see program README"]
fn ledger_test_usdc_initializes_with_existing_reserve_keys() {
    for staged in [false, true] {
        let mut f = Fixture::new();
        f.prepare_deposit_mint(LEDGER_TEST_USDC);
        if staged {
            f.staged_initialize_with_mint(LEDGER_TEST_USDC, "landlord").unwrap();
        } else {
            f.initialize_with_mint(LEDGER_TEST_USDC).unwrap();
        }
        let t = f.state();
        assert_eq!(t.deposit_mint, LEDGER_TEST_USDC);
        assert_eq!(t.reserve, f.reserve);
        assert_eq!(t.market, f.market);
        assert_eq!(t.receipt_mint, f.receipt_mint);
        assert_eq!(t.liquidity_supply, f.supply);
        assert_eq!(t.market_authority, f.market_authority);
        assert_eq!(t.phase, Phase::AwaitingFunding);
        let reserve = f.svm.get_account(&f.reserve).unwrap();
        let reserve = bytemuck::from_bytes::<Reserve>(&reserve.data[8..]);
        assert_eq!(reserve.liquidity.mint_pubkey, TEST_USDC);
    }
}

#[test]
#[ignore = "requires explicit SBF and public KLend fixture paths; see program README"]
fn initialization_rejects_a_third_six_decimal_classic_token_mint() {
    for staged in [false, true] {
        let mut f = Fixture::new();
        let mint = Pubkey::new_unique();
        f.prepare_deposit_mint(mint);
        let result = if staged {
            f.staged_initialize_with_mint(mint, "landlord")
        } else {
            f.initialize_with_mint(mint)
        };
        let failure = result.unwrap_err();
        assert!(failure.meta.logs.iter().any(|line| line.contains("Error Code: InvalidAsset")));
        assert!(f.svm.get_account(&f.tenancy).is_none());
    }
}
#[test]
#[ignore = "requires explicit SBF and public KLend fixture paths; see program README"]
fn circle_initialization_still_rejects_a_mismatched_reserve_mint() {
    for staged in [false, true] {
        let mut f = Fixture::new();
        let mut reserve = f.svm.get_account(&f.reserve).unwrap();
        bytemuck::from_bytes_mut::<Reserve>(&mut reserve.data[8..]).liquidity.mint_pubkey = LEDGER_TEST_USDC;
        f.svm.set_account(f.reserve, reserve).unwrap();
        let result = if staged {
            f.staged_initialize("landlord")
        } else {
            f.initialize_with_mint(TEST_USDC)
        };
        let failure = result.unwrap_err();
        assert!(failure.meta.logs.iter().any(|line| line.contains("Error Code: InvalidAsset")));
        assert!(f.svm.get_account(&f.tenancy).is_none());
    }
}

#[test]
#[ignore = "requires explicit SBF and public KLend fixture paths; see program README"]
fn ledger_cash_dispute_and_payout_work_but_circle_supply_is_rejected() {
    let mut f = Fixture::new();
    f.prepare_deposit_mint(LEDGER_TEST_USDC);
    f.staged_initialize_with_mint(LEDGER_TEST_USDC, "landlord").unwrap();
    let ix = Instruction {
        program_id: ID,
        accounts: accounts::Fund {
            tenant: f.tenant.pubkey(),
            tenancy: f.tenancy,
            deposit_mint: LEDGER_TEST_USDC,
            source: f.tenant_token,
            cash: f.cash,
            token_program: anchor_spl::token::ID,
        }.to_account_metas(None),
        data: instruction::Fund { nonce: 0 }.data(),
    };
    f.send(ix, "tenant").unwrap();
    let mut supply = f.finance(instruction::Supply { amount: PRINCIPAL, nonce: 1 }.data(), f.tenant.pubkey());
    for account in &mut supply.accounts {
        if account.pubkey == TEST_USDC {
            account.pubkey = LEDGER_TEST_USDC;
        }
    }
    let failure = f.send(supply, "tenant").unwrap_err();
    assert!(failure.meta.logs.iter().any(|line| line.contains("Error Code: ConstraintTokenMint")));
    assert_eq!(f.balance(f.cash), PRINCIPAL);
    assert_eq!(f.state().accounted_receipts, 0);
    assert_eq!(f.state().next_nonce, 1);
    let ix = f.party(f.landlord.pubkey(), instruction::ProposeClaim { amount: CLAIM, nonce: 1 }.data());
    f.send(ix, "landlord").unwrap();
    let ix = f.party(f.tenant.pubkey(), instruction::RespondToClaim { accept: false, nonce: 2 }.data());
    f.send(ix, "tenant").unwrap();
    assert_eq!(f.state().phase, Phase::Disputed);
    let ix = f.party(f.arbitrator.pubkey(), instruction::ResolveClaim { amount: CLAIM, nonce: 3 }.data());
    f.send(ix, "arbitrator").unwrap();
    let mut settle = f.settle(4);
    for account in &mut settle.accounts {
        if account.pubkey == TEST_USDC {
            account.pubkey = LEDGER_TEST_USDC;
        }
    }
    f.send(settle, "tenant").unwrap();
    assert_eq!(f.state().tenant_owed, PRINCIPAL - CLAIM);
    assert_eq!(f.state().landlord_owed, CLAIM);
    for (destination, landlord, nonce) in [(f.landlord_token, true, 5), (f.tenant_token, false, 6)] {
        let mut payout = f.payout(destination, landlord, nonce);
        for account in &mut payout.accounts {
            if account.pubkey == TEST_USDC {
                account.pubkey = LEDGER_TEST_USDC;
            }
        }
        f.send(payout, "tenant").unwrap();
    }
    assert_eq!(f.balance(f.landlord_token), CLAIM);
    assert_eq!(f.balance(f.tenant_token), PRINCIPAL - CLAIM);
    assert_eq!(f.balance(f.cash), 0);
    assert_eq!(f.state().accounted_idle, 0);
    assert_eq!(f.state().tenant_owed, 0);
    assert_eq!(f.state().landlord_owed, 0);
}


#[test]
#[ignore = "requires a newly built staged SBF and public KLend fixture paths; see program README"]
fn staged_setup_is_landlord_only_and_does_not_fund_security() {
    let mut f = Fixture::new();
    let metas = accounts::InitializeStaged {
        payer: f.payer.pubkey(),
        tenant: f.tenant.pubkey(),
        landlord: f.landlord.pubkey(),
        tenancy: f.tenancy,
        deposit_mint: TEST_USDC,
        receipt_mint: f.receipt_mint,
        cash: f.cash,
        receipts: f.receipts,
        tenant_destination: f.tenant_token,
        landlord_destination: f.landlord_token,
        reserve: f.reserve,
        market: f.market,
        token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    assert!(!metas[1].is_signer);
    assert!(metas[2].is_signer);
    f.staged_initialize("landlord").unwrap();
    assert_eq!(f.state().phase, Phase::AwaitingFunding);
    assert_eq!(f.state().accounted_idle, 0);
    assert_eq!(f.balance(f.cash), 0);
    f.fund();
    assert_eq!(f.state().phase, Phase::Active);
    assert_eq!(f.state().accounted_idle, PRINCIPAL);
    assert_eq!(f.balance(f.cash), PRINCIPAL);
}

#[test]
#[ignore = "requires explicit SBF and public KLend fixture paths; see program README"]
fn executable_escrow_checks_authority_claim_replay_recipient_and_settlement() {
    let mut f = Fixture::new();
    f.initialize();
    f.fund();
    let ix = f.party(
        f.tenant.pubkey(),
        instruction::ProposeClaim {
            amount: CLAIM,
            nonce: 1,
        }
        .data(),
    );
    assert!(f.send(ix, "tenant").is_err());
    let ix = f.party(
        f.landlord.pubkey(),
        instruction::ProposeClaim {
            amount: CLAIM,
            nonce: 1,
        }
        .data(),
    );
    f.send(ix.clone(), "landlord").unwrap();
    assert!(f.send(ix, "landlord").is_err());
    let ix = f.party(
        f.landlord.pubkey(),
        instruction::RespondToClaim {
            accept: true,
            nonce: 2,
        }
        .data(),
    );
    assert!(f.send(ix, "landlord").is_err());
    let ix = f.party(
        f.tenant.pubkey(),
        instruction::RespondToClaim {
            accept: false,
            nonce: 2,
        }
        .data(),
    );
    f.send(ix, "tenant").unwrap();
    let ix = f.party(
        f.arbitrator.pubkey(),
        instruction::ResolveClaim {
            amount: CLAIM + 1,
            nonce: 3,
        }
        .data(),
    );
    assert!(f.send(ix, "arbitrator").is_err());
    let ix = f.party(
        f.arbitrator.pubkey(),
        instruction::ResolveClaim {
            amount: CLAIM,
            nonce: 3,
        }
        .data(),
    );
    f.send(ix, "arbitrator").unwrap();
    let wrong = Pubkey::new_unique();
    put(
        &mut f.svm,
        wrong,
        anchor_spl::token::ID,
        token_data(TEST_USDC, f.tenant.pubkey(), 0),
    );
    f.send(f.settle(4), "tenant").unwrap();
    assert_eq!(f.state().tenant_owed, PRINCIPAL - CLAIM);
    assert_eq!(f.state().landlord_owed, CLAIM);
    assert_eq!(f.balance(f.cash), PRINCIPAL);
    assert_eq!(f.state().phase, Phase::Closed);
    assert!(f.send(f.payout(wrong, false, 5), "payer").is_err());
    f.send(f.payout(f.landlord_token, true, 5), "payer")
        .unwrap();
    f.send(f.payout(f.tenant_token, false, 6), "payer").unwrap();
    assert_eq!(f.balance(f.landlord_token), CLAIM);
    assert_eq!(f.balance(f.tenant_token), PRINCIPAL - CLAIM);
    assert_eq!(f.balance(f.cash), 0);
    assert_eq!(f.state().tenant_owed, 0);
    assert_eq!(f.state().landlord_owed, 0);
    assert!(f.send(f.settle(7), "tenant").is_err());
}

#[test]
#[ignore = "requires explicit SBF and public KLend fixture paths; see program README"]
fn real_klend_cpi_supplies_and_redeems_restricted_receipts() {
    let mut f = Fixture::new();
    f.initialize();
    f.fund();
    let ix = f.finance(
        instruction::Supply {
            amount: PRINCIPAL,
            nonce: 1,
        }
        .data(),
        f.landlord.pubkey(),
    );
    assert!(f.send(ix, "landlord").is_err());
    let ix = f.finance(
        instruction::Supply {
            amount: PRINCIPAL,
            nonce: 1,
        }
        .data(),
        f.tenant.pubkey(),
    );
    let result = f.send(ix, "tenant").unwrap();
    assert!(result
        .logs
        .iter()
        .any(|line| line.contains("DepositReserveLiquidity")));
    assert!(f.state().accounted_idle <= 2);
    let shares = f.state().accounted_receipts;
    assert!(shares > 0);
    assert_eq!(f.balance(f.receipts), shares);
    let saved_reserve = f.svm.get_account(&f.reserve).unwrap();
    let saved_supply = f.svm.get_account(&f.supply).unwrap();
    let mut drained = saved_reserve.clone();
    bytemuck::from_bytes_mut::<Reserve>(&mut drained.data[8..])
        .liquidity
        .total_available_amount = 0;
    f.svm.set_account(f.reserve, drained).unwrap();
    put(
        &mut f.svm,
        f.supply,
        anchor_spl::token::ID,
        token_data(TEST_USDC, f.market_authority, 0),
    );
    let ix = f.finance(
        instruction::Redeem {
            receipt_amount: shares,
            minimum_received: 0,
            nonce: 2,
        }
        .data(),
        f.tenant.pubkey(),
    );
    assert!(f.send(ix, "tenant").is_err());
    assert_eq!(f.state().accounted_receipts, shares);
    f.svm.set_account(f.reserve, saved_reserve).unwrap();
    f.svm.set_account(f.supply, saved_supply).unwrap();
    let ix = f.finance(
        instruction::ReleaseEarnings {
            amount: 1,
            nonce: 2,
        }
        .data(),
        f.tenant.pubkey(),
    );
    assert!(f.send(ix, "tenant").is_err());
    let ix = f.finance(
        instruction::Redeem {
            receipt_amount: shares,
            minimum_received: PRINCIPAL + 1,
            nonce: 2,
        }
        .data(),
        f.tenant.pubkey(),
    );
    assert!(f.send(ix, "tenant").is_err());
    assert_eq!(f.state().accounted_receipts, shares);
    let ix = f.finance(
        instruction::Redeem {
            receipt_amount: shares,
            minimum_received: PRINCIPAL - 2,
            nonce: 2,
        }
        .data(),
        f.tenant.pubkey(),
    );
    f.send(ix, "tenant").unwrap();
    assert_eq!(f.state().accounted_receipts, 0);
    assert!(f.state().accounted_idle >= PRINCIPAL - 2);
    assert!(f.state().accounted_idle <= PRINCIPAL);
}

#[test]
#[ignore = "requires explicit SBF and public KLend fixture paths; accrual is a controlled fixture"]
fn controlled_earnings_release_then_claim_settlement_preserves_personal_cash() {
    let mut f = Fixture::new();
    f.initialize();
    f.fund();
    let ix = f.finance(
        instruction::Supply {
            amount: PRINCIPAL,
            nonce: 1,
        }
        .data(),
        f.tenant.pubkey(),
    );
    f.send(ix, "tenant").unwrap();
    f.controlled_yield_fixture(PRINCIPAL + 10_000_000);
    let shares = f.state().accounted_receipts;
    let ix = f.finance(
        instruction::Redeem {
            receipt_amount: shares,
            minimum_received: PRINCIPAL + 9_999_998,
            nonce: 2,
        }
        .data(),
        f.tenant.pubkey(),
    );
    f.send(ix, "tenant").unwrap();
    assert_eq!(f.state().accounted_idle, PRINCIPAL + 10_000_000);
    let ix = f.finance(
        instruction::ReleaseEarnings {
            amount: 10_000_001,
            nonce: 3,
        }
        .data(),
        f.tenant.pubkey(),
    );
    assert!(f.send(ix, "tenant").is_err());
    let ix = f.finance(
        instruction::ReleaseEarnings {
            amount: 10_000_000,
            nonce: 3,
        }
        .data(),
        f.tenant.pubkey(),
    );
    f.send(ix, "tenant").unwrap();
    assert_eq!(f.balance(f.tenant_token), 10_000_000);
    assert_eq!(f.state().accounted_idle, PRINCIPAL);
    let ix = f.party(
        f.landlord.pubkey(),
        instruction::ProposeClaim {
            amount: CLAIM,
            nonce: 4,
        }
        .data(),
    );
    f.send(ix, "landlord").unwrap();
    let ix = f.party(
        f.tenant.pubkey(),
        instruction::RespondToClaim {
            accept: true,
            nonce: 5,
        }
        .data(),
    );
    f.send(ix, "tenant").unwrap();
    f.send(f.settle(6), "tenant").unwrap();
    f.send(f.payout(f.landlord_token, true, 7), "payer")
        .unwrap();
    f.send(f.payout(f.tenant_token, false, 8), "payer").unwrap();
    assert_eq!(f.balance(f.landlord_token), CLAIM);
    assert_eq!(f.balance(f.tenant_token), 10_000_000 + PRINCIPAL - CLAIM);
    assert_eq!(f.state().released_earnings, 10_000_000);
    assert_eq!(f.state().phase, Phase::Closed);
}

fn settle_claim(f: &mut Fixture, amount: u64) {
    f.staged_initialize("landlord").unwrap();
    f.fund();
    let ix = f.party(
        f.landlord.pubkey(),
        instruction::ProposeClaim { amount, nonce: 1 }.data(),
    );
    f.send(ix, "landlord").unwrap();
    let ix = f.party(
        f.tenant.pubkey(),
        instruction::RespondToClaim {
            accept: true,
            nonce: 2,
        }
        .data(),
    );
    f.send(ix, "tenant").unwrap();
    f.send(f.settle(3), "tenant").unwrap();
    assert_eq!(f.state().phase, Phase::Closed);
}

#[test]
#[ignore = "requires new custody SBF and public KLend fixture paths"]
fn audit_landlord_owner_change_cannot_block_tenant_payout() {
    let mut f = Fixture::new();
    settle_claim(&mut f, 0);
    let change = anchor_spl::token::spl_token::instruction::set_authority(
        &anchor_spl::token::ID,
        &f.landlord_token,
        Some(&Pubkey::new_unique()),
        anchor_spl::token::spl_token::instruction::AuthorityType::AccountOwner,
        &f.landlord.pubkey(),
        &[],
    )
    .unwrap();
    f.send(change, "landlord").unwrap();
    f.send(f.payout(f.tenant_token, false, 4), "payer").unwrap();
    assert_eq!(f.balance(f.tenant_token), PRINCIPAL);
    assert_eq!(f.balance(f.cash), 0);
}

#[test]
#[ignore = "requires new custody SBF and public KLend fixture paths"]
fn audit_tenant_owner_change_cannot_block_landlord_payout() {
    let mut f = Fixture::new();
    f.staged_initialize("landlord").unwrap();
    f.fund();
    let ix = f.finance(
        instruction::Supply {
            amount: PRINCIPAL,
            nonce: 1,
        }
        .data(),
        f.tenant.pubkey(),
    );
    f.send(ix, "tenant").unwrap();
    let shares = f.state().accounted_receipts;
    let ix = f.party(
        f.landlord.pubkey(),
        instruction::ProposeClaim {
            amount: CLAIM,
            nonce: 2,
        }
        .data(),
    );
    f.send(ix, "landlord").unwrap();
    let ix = f.party(
        f.tenant.pubkey(),
        instruction::RespondToClaim {
            accept: true,
            nonce: 3,
        }
        .data(),
    );
    f.send(ix, "tenant").unwrap();
    let change = anchor_spl::token::spl_token::instruction::set_authority(
        &anchor_spl::token::ID,
        &f.tenant_token,
        Some(&Pubkey::new_unique()),
        anchor_spl::token::spl_token::instruction::AuthorityType::AccountOwner,
        &f.tenant.pubkey(),
        &[],
    )
    .unwrap();
    f.send(change, "tenant").unwrap();
    let ix = f.finance(
        instruction::Redeem {
            receipt_amount: shares,
            minimum_received: PRINCIPAL - 2,
            nonce: 4,
        }
        .data(),
        f.landlord.pubkey(),
    );
    f.send(ix, "landlord").unwrap();
    assert_eq!(f.state().accounted_receipts, 0);
    f.send(f.settle(5), "tenant").unwrap();
    let tenant_due = f.state().tenant_owed;
    assert!(f.send(f.payout(f.tenant_token, false, 6), "payer").is_err());
    f.send(f.payout(f.landlord_token, true, 6), "payer")
        .unwrap();
    assert_eq!(f.balance(f.landlord_token), CLAIM);
    assert_eq!(f.balance(f.cash), tenant_due);
    assert_eq!(f.state().tenant_owed, tenant_due);
}

#[test]
#[ignore = "requires new custody SBF and public KLend fixture paths"]
fn audit_staged_and_joint_reject_non_ata_destinations() {
    let mut f = Fixture::new();
    let canonical = f.tenant_token;
    let hostile = Pubkey::new_unique();
    put(
        &mut f.svm,
        hostile,
        anchor_spl::token::ID,
        token_data(TEST_USDC, f.landlord.pubkey(), 0),
    );
    let set_close = anchor_spl::token::spl_token::instruction::set_authority(
        &anchor_spl::token::ID,
        &hostile,
        Some(&f.landlord.pubkey()),
        anchor_spl::token::spl_token::instruction::AuthorityType::CloseAccount,
        &f.landlord.pubkey(),
        &[],
    )
    .unwrap();
    f.send(set_close, "landlord").unwrap();
    let set_owner = anchor_spl::token::spl_token::instruction::set_authority(
        &anchor_spl::token::ID,
        &hostile,
        Some(&f.tenant.pubkey()),
        anchor_spl::token::spl_token::instruction::AuthorityType::AccountOwner,
        &f.landlord.pubkey(),
        &[],
    )
    .unwrap();
    f.send(set_owner, "landlord").unwrap();
    let account = TokenAccount::unpack(&f.svm.get_account(&hostile).unwrap().data).unwrap();
    assert_eq!(account.close_authority, COption::Some(f.landlord.pubkey()));
    f.tenant_token = hostile;
    assert!(f.staged_initialize("landlord").is_err());
    // Joint initialization rejects the same owner-correct, landlord-closable destination.
    let joint = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.initialize()));
    assert!(joint.is_err());
    assert!(f.svm.get_account(&f.tenancy).is_none());
    f.tenant_token = canonical;
    f.staged_initialize("landlord").unwrap();
}

#[test]
#[ignore = "requires new custody SBF and public KLend fixture paths"]
fn audit_closed_canonical_ata_can_be_recreated_for_payout() {
    let mut f = Fixture::new();
    f.staged_initialize("landlord").unwrap();
    f.fund();
    let ix = f.finance(
        instruction::Supply {
            amount: PRINCIPAL,
            nonce: 1,
        }
        .data(),
        f.tenant.pubkey(),
    );
    f.send(ix, "tenant").unwrap();
    let shares = f.state().accounted_receipts;
    let ix = f.party(
        f.landlord.pubkey(),
        instruction::ProposeClaim {
            amount: 0,
            nonce: 2,
        }
        .data(),
    );
    f.send(ix, "landlord").unwrap();
    let ix = f.party(
        f.tenant.pubkey(),
        instruction::RespondToClaim {
            accept: true,
            nonce: 3,
        }
        .data(),
    );
    f.send(ix, "tenant").unwrap();
    let close = anchor_spl::token::spl_token::instruction::close_account(
        &anchor_spl::token::ID,
        &f.tenant_token,
        &f.tenant.pubkey(),
        &f.tenant.pubkey(),
        &[],
    )
    .unwrap();
    f.send(close, "tenant").unwrap();
    let ix = f.finance(
        instruction::Redeem {
            receipt_amount: shares,
            minimum_received: PRINCIPAL - 2,
            nonce: 4,
        }
        .data(),
        f.landlord.pubkey(),
    );
    f.send(ix, "landlord").unwrap();
    f.send(f.settle(5), "tenant").unwrap();
    let due = f.state().tenant_owed;
    assert!(f.send(f.payout(f.tenant_token, false, 6), "payer").is_err());
    assert!(due >= PRINCIPAL - 2);
    let create_ata = Instruction {
        program_id: Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap(),
        accounts: vec![
            AccountMeta::new(f.payer.pubkey(), true),
            AccountMeta::new(f.tenant_token, false),
            AccountMeta::new_readonly(f.tenant.pubkey(), false),
            AccountMeta::new_readonly(TEST_USDC, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
        ],
        data: vec![0],
    };
    f.send(create_ata, "payer").unwrap();
    f.send(f.payout(f.tenant_token, false, 6), "payer").unwrap();
    assert_eq!(f.balance(f.tenant_token), due);
    assert_eq!(f.balance(f.cash), 0);
}
