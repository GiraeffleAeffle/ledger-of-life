use crate::{accounting, EscrowError};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Phase {
    AwaitingFunding,
    Active,
    ClaimProposed,
    Disputed,
    Settling,
    Closed,
}

#[account]
#[derive(InitSpace)]
pub struct Tenancy {
    pub lease_id: [u8; 32],
    pub tenant: Pubkey,
    pub landlord: Pubkey,
    pub arbitrator: Pubkey,
    pub deposit_mint: Pubkey,
    pub reserve: Pubkey,
    pub market: Pubkey,
    pub receipt_mint: Pubkey,
    pub liquidity_supply: Pubkey,
    pub market_authority: Pubkey,
    pub tenant_destination: Pubkey,
    pub landlord_destination: Pubkey,
    pub policy_hash: [u8; 32],
    pub release_permitted: bool,
    pub required_security: u64,
    pub accounted_idle: u64,
    pub accounted_receipts: u64,
    pub released_earnings: u64,
    pub next_nonce: u64,
    pub claim_amount: u64,
    pub approved_claim: u64,
    pub phase: Phase,
    pub bump: u8,
    pub tenant_owed: u64,
    pub landlord_owed: u64,
}

impl Tenancy {
    pub fn check_nonce(&self, nonce: u64) -> Result<()> {
        require!(nonce == self.next_nonce, EscrowError::Replay);
        Ok(())
    }
    pub fn advance(&mut self) -> Result<()> {
        self.next_nonce = accounting::checked_add(self.next_nonce, 1)?;
        Ok(())
    }
    pub fn tenant_only(&self, actor: Pubkey) -> Result<()> {
        require_keys_eq!(actor, self.tenant, EscrowError::Unauthorized);
        Ok(())
    }
    pub fn party(&self, actor: Pubkey) -> Result<()> {
        require!(
            actor == self.tenant || actor == self.landlord || actor == self.arbitrator,
            EscrowError::Unauthorized
        );
        Ok(())
    }
    pub fn propose_claim(&mut self, actor: Pubkey, amount: u64, nonce: u64) -> Result<()> {
        require_keys_eq!(actor, self.landlord, EscrowError::Unauthorized);
        self.check_nonce(nonce)?;
        require!(self.phase == Phase::Active, EscrowError::InvalidPhase);
        require!(
            amount <= self.required_security,
            EscrowError::ClaimExceedsLimit
        );
        self.advance()?;
        self.claim_amount = amount;
        self.phase = Phase::ClaimProposed;
        Ok(())
    }
    pub fn respond(&mut self, actor: Pubkey, accept: bool, nonce: u64) -> Result<()> {
        self.tenant_only(actor)?;
        self.check_nonce(nonce)?;
        require!(
            self.phase == Phase::ClaimProposed,
            EscrowError::InvalidPhase
        );
        self.advance()?;
        if accept {
            self.approved_claim = self.claim_amount;
            self.phase = Phase::Settling;
        } else {
            self.phase = Phase::Disputed;
        }
        Ok(())
    }
    pub fn decide(&mut self, actor: Pubkey, amount: u64, nonce: u64) -> Result<()> {
        require_keys_eq!(actor, self.arbitrator, EscrowError::Unauthorized);
        self.check_nonce(nonce)?;
        require!(self.phase == Phase::Disputed, EscrowError::InvalidPhase);
        require!(amount <= self.claim_amount, EscrowError::ClaimExceedsLimit);
        self.advance()?;
        self.approved_claim = amount;
        self.phase = Phase::Settling;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> Tenancy {
        Tenancy {
            lease_id: [1; 32],
            tenant: Pubkey::new_unique(),
            landlord: Pubkey::new_unique(),
            arbitrator: Pubkey::new_unique(),
            deposit_mint: Pubkey::new_unique(),
            reserve: Pubkey::new_unique(),
            market: Pubkey::new_unique(),
            receipt_mint: Pubkey::new_unique(),
            liquidity_supply: Pubkey::new_unique(),
            market_authority: Pubkey::new_unique(),
            tenant_destination: Pubkey::new_unique(),
            landlord_destination: Pubkey::new_unique(),
            policy_hash: [2; 32],
            release_permitted: true,
            required_security: 3_000_000_000,
            accounted_idle: 3_000_000_000,
            accounted_receipts: 0,
            released_earnings: 0,
            next_nonce: 0,
            claim_amount: 0,
            approved_claim: 0,
            phase: Phase::Active,
            bump: 1,
            tenant_owed: 0,
            landlord_owed: 0,
        }
    }
    #[test]
    fn claimant_cannot_approve_own_claim_or_spend_portfolio() {
        let mut t = fixture();
        assert!(t.propose_claim(t.tenant, 120_000_000, 0).is_err());
        t.propose_claim(t.landlord, 120_000_000, 0).unwrap();
        assert!(t.respond(t.landlord, true, 1).is_err());
        assert!(t.tenant_only(t.arbitrator).is_err());
        assert!(t.decide(t.arbitrator, 120_000_000, 1).is_err());
        t.respond(t.tenant, false, 1).unwrap();
        assert!(t.decide(Pubkey::new_unique(), 120_000_000, 2).is_err());
        assert!(t.decide(t.arbitrator, 120_000_001, 2).is_err());
        t.decide(t.arbitrator, 120_000_000, 2).unwrap();
        assert_eq!(t.phase, Phase::Settling);
        assert!(t.decide(t.arbitrator, 120_000_000, 2).is_err());
    }
    #[test]
    fn accepted_claim_advances_nonce_once_and_never_changes_wallets() {
        let mut t = fixture();
        let destinations = (t.tenant_destination, t.landlord_destination);
        t.propose_claim(t.landlord, 120_000_000, 0).unwrap();
        assert!(t.respond(t.tenant, true, 0).is_err());
        t.respond(t.tenant, true, 1).unwrap();
        assert_eq!(t.next_nonce, 2);
        assert_eq!((t.tenant_destination, t.landlord_destination), destinations);
        assert!(t.respond(t.tenant, true, 1).is_err());
    }
}
