use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Discriminator};
use house::{House, Position, instruction};
fn hex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2], 16).unwrap()).collect() }
#[test]
fn typescript_golden_accounts_match_rust_borsh_layout() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("layout.json")).unwrap();
    let house_bytes = hex(fixture["house"].as_str().unwrap()); let position_bytes = hex(fixture["position"].as_str().unwrap());
    assert_eq!(house_bytes.len(), House::LEN); assert_eq!(position_bytes.len(), Position::LEN);
    let h = House::try_deserialize(&mut house_bytes.as_slice()).unwrap(); let p = Position::try_deserialize(&mut position_bytes.as_slice()).unwrap();
    assert_eq!(h.id_len, 8); assert_eq!(&h.id[..8], b"workshop"); assert_eq!(h.price_cash_per_unit, 1_000_000); assert_eq!(h.sell_cap_units, 100_000_000); assert_eq!(h.total_staked, 4_000_000); assert_eq!(h.reward_per_unit_stored, 2_000_000_000_000); assert_eq!(h.revenue_by_source, [1,2,3,4]); assert_eq!(h.staker_count, 2);
    assert_eq!(h.reward_duration, 604800); assert_eq!(h.reward_rate, 4_000_000_000_000); assert_eq!(h.period_finish, 200); assert_eq!(h.last_update_time, 100); assert_eq!(h.stream_remaining_scaled, 400_000_000_000_000); assert_eq!(h.undistributed_scaled, 9_000_000_000_000); assert_eq!(h.reward_remainder_scaled, 1);
    assert_eq!(p.staked, 1_000_000); assert_eq!(p.reward_debt, 1_000_000_000_000); assert_eq!(p.owed, 7); assert_eq!(p.claimed_total, 8); assert_eq!(p.bump, 250); assert_eq!(p.reward_fraction, 500_000_000_000);
    let mut encoded = Vec::new(); h.try_serialize(&mut encoded).unwrap(); assert_eq!(encoded, house_bytes); encoded.clear(); p.try_serialize(&mut encoded).unwrap(); assert_eq!(encoded, position_bytes);
}
#[test]
fn typescript_instruction_bytes_match_rust_anchor_layout() {
    let mut buy = vec![166,179,34,247,254,181,5,159]; buy.extend(123u64.to_le_bytes()); assert_eq!(instruction::BuyUnits { units: 123 }.data(), buy);
    let mut deposit = vec![52,249,112,72,206,161,196,1]; deposit.extend(7u64.to_le_bytes()); deposit.push(1); assert_eq!(instruction::DepositRewards { amount: 7, source: 1 }.data(), deposit);
    assert_eq!(instruction::SellUnits::DISCRIMINATOR, &[19,236,169,25,155,72,9,192]); assert_eq!(instruction::Stake::DISCRIMINATOR, &[206,176,202,18,200,209,179,108]); assert_eq!(instruction::Unstake::DISCRIMINATOR, &[90,95,107,42,205,124,50,225]); assert_eq!(instruction::Claim::DISCRIMINATOR, &[62,198,214,193,213,159,108,210]); assert_eq!(instruction::InitializeHouse::DISCRIMINATOR, &[180,46,86,125,135,107,214,28]);
}
