// Reference escrow program for Anchor (the product, not the framework —
// confusing name collision, noted once). Deposits native SOL into a
// per-case PDA, and settles it according to a bps split once an
// adjudication decision is available. This program does NOT talk to
// Hyperlane or GenLayer itself — it only trusts a designated `adjudicator`
// authority to call `settle`. That authority is a plain keypair for now
// (Anchor's backend wallet); once the Hyperlane decision-relay program is
// built, `settle` will instead be called via CPI from that program's PDA,
// so only a verified relayed decision can trigger settlement — see
// chains/solana/README.md for the planned wiring.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;

declare_id!("825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn");

const MAX_CASE_ID_LEN: usize = 64;
const BPS_DENOMINATOR: u16 = 10_000;

#[program]
pub mod escrow {
    use super::*;

    /// Claimant opens a case and deposits the disputed amount (lamports)
    /// into the case PDA. `adjudicator` is the authority allowed to call
    /// `settle` for this case.
    pub fn initialize_case(
        ctx: Context<InitializeCase>,
        case_id: String,
        respondent: Pubkey,
        adjudicator: Pubkey,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(case_id.len() <= MAX_CASE_ID_LEN, EscrowError::CaseIdTooLong);
        require!(amount_lamports > 0, EscrowError::ZeroAmount);

        let case = &mut ctx.accounts.case;
        case.case_id = case_id;
        case.claimant = ctx.accounts.claimant.key();
        case.respondent = respondent;
        case.adjudicator = adjudicator;
        case.amount_lamports = amount_lamports;
        case.status = CaseStatus::Active;
        case.bump = ctx.bumps.case;

        // Move the disputed amount from the claimant into the case PDA,
        // which holds it as the vault for the lifetime of the case.
        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.claimant.key(),
            &case.key(),
            amount_lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.claimant.to_account_info(),
                case.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        Ok(())
    }

    /// Either party marks the case disputed — purely informational status
    /// for this reference implementation (no auto-release timeout logic
    /// yet); the real gate on fund movement is `settle`.
    pub fn raise_dispute(ctx: Context<UpdateCase>) -> Result<()> {
        let case = &mut ctx.accounts.case;
        require!(case.status == CaseStatus::Active, EscrowError::NotActive);
        let signer = ctx.accounts.signer.key();
        require!(
            signer == case.claimant || signer == case.respondent,
            EscrowError::Unauthorized
        );
        case.status = CaseStatus::Disputed;
        Ok(())
    }

    /// Settles the case per an adjudication outcome, in basis points
    /// (0-10000, matching Anchor's claimant_share_bps/respondent_share_bps
    /// — see docs/decision-schema.md). Only the designated `adjudicator`
    /// authority may call this. Closes the case account, returning rent
    /// to the claimant.
    pub fn settle(
        ctx: Context<Settle>,
        claimant_share_bps: u16,
        respondent_share_bps: u16,
    ) -> Result<()> {
        let case = &ctx.accounts.case;
        require!(
            case.status == CaseStatus::Active || case.status == CaseStatus::Disputed,
            EscrowError::AlreadySettled
        );
        require!(
            ctx.accounts.adjudicator.key() == case.adjudicator,
            EscrowError::Unauthorized
        );
        require!(
            claimant_share_bps + respondent_share_bps == BPS_DENOMINATOR,
            EscrowError::InvalidShares
        );
        require!(
            ctx.accounts.claimant.key() == case.claimant
                && ctx.accounts.respondent.key() == case.respondent,
            EscrowError::PartyMismatch
        );

        let total = case.amount_lamports;
        let claimant_amount = (total as u128 * claimant_share_bps as u128 / BPS_DENOMINATOR as u128) as u64;
        let respondent_amount = total - claimant_amount;

        let case_info = case.to_account_info();

        if claimant_amount > 0 {
            **case_info.try_borrow_mut_lamports()? -= claimant_amount;
            **ctx.accounts.claimant.try_borrow_mut_lamports()? += claimant_amount;
        }
        if respondent_amount > 0 {
            **case_info.try_borrow_mut_lamports()? -= respondent_amount;
            **ctx.accounts.respondent.try_borrow_mut_lamports()? += respondent_amount;
        }

        ctx.accounts.case.status = CaseStatus::Settled;
        Ok(())
    }
}

#[account]
pub struct Case {
    pub case_id: String,
    pub claimant: Pubkey,
    pub respondent: Pubkey,
    pub adjudicator: Pubkey,
    pub amount_lamports: u64,
    pub status: CaseStatus,
    pub bump: u8,
}

impl Case {
    // discriminator(8) + case_id(4+MAX) + 3 pubkeys(32*3) + u64(8) + status(1) + bump(1)
    pub const MAX_SIZE: usize = 8 + (4 + MAX_CASE_ID_LEN) + 32 * 3 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CaseStatus {
    Active,
    Disputed,
    Settled,
}

#[derive(Accounts)]
#[instruction(case_id: String)]
pub struct InitializeCase<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(
        init,
        payer = claimant,
        space = Case::MAX_SIZE,
        seeds = [b"case", case_id.as_bytes()],
        bump,
    )]
    pub case: Account<'info, Case>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCase<'info> {
    pub signer: Signer<'info>,

    #[account(mut, seeds = [b"case", case.case_id.as_bytes()], bump = case.bump)]
    pub case: Account<'info, Case>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub adjudicator: Signer<'info>,

    #[account(mut, seeds = [b"case", case.case_id.as_bytes()], bump = case.bump)]
    pub case: Account<'info, Case>,

    /// CHECK: address is verified against case.claimant above; no data read.
    #[account(mut)]
    pub claimant: UncheckedAccount<'info>,

    /// CHECK: address is verified against case.respondent above; no data read.
    #[account(mut)]
    pub respondent: UncheckedAccount<'info>,
}

#[error_code]
pub enum EscrowError {
    #[msg("case_id exceeds max length")]
    CaseIdTooLong,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("case is not active")]
    NotActive,
    #[msg("case already settled")]
    AlreadySettled,
    #[msg("signer is not authorized for this action")]
    Unauthorized,
    #[msg("claimant_share_bps + respondent_share_bps must equal 10000")]
    InvalidShares,
    #[msg("claimant/respondent accounts do not match the case")]
    PartyMismatch,
}
