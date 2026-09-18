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
// Config PDA seed — a single, program-wide singleton account holding
// emergency_refund_timeout_seconds as a RUNTIME value, not a compiled-in
// constant. Mirrors what EVM's Escrow.sol should have done: there,
// emergencyRefundTimeoutSeconds is `immutable`, set once in the
// constructor, so changing it means deploying a whole new Escrow
// contract (see docs/incidents/ for the real redeploys that caused).
// Config here is update-authority-gated instead, so a future timeout
// change is one instruction, not a redeploy.
const CONFIG_SEED: &[u8] = b"config";
const DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS: i64 = 3600; // 1 hour

#[program]
pub mod escrow {
    use super::*;

    /// One-time, program-wide setup for the emergency-refund timeout
    /// config singleton. Must run once before any `emergency_refund`
    /// call; `initialize_case` does not depend on it (deposits work
    /// identically with or without it — this only gates the escape
    /// hatch, never the normal deposit/settle path).
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.emergency_refund_timeout_seconds = DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Updates the timeout for all FUTURE emergency_refund eligibility
    /// checks. Only the config's own recorded authority may call this —
    /// deliberately not `decisionRelay`/the escrow_authority PDA, since
    /// that would let the same M-of-N attestor set that authorizes a
    /// refund also shorten its own waiting period; kept as a genuinely
    /// separate authority key. Already-eligible or already-elapsed
    /// waits for existing deposits are computed live against
    /// `deposited_at` at emergency_refund time, so a change here applies
    /// retroactively to every not-yet-refunded deposit, not just future
    /// ones — this is a deliberate difference from EVM, where an
    /// immutable per-contract timeout can never do that.
    pub fn update_emergency_refund_timeout(
        ctx: Context<UpdateConfig>,
        new_timeout_seconds: i64,
    ) -> Result<()> {
        require!(new_timeout_seconds > 0, EscrowError::InvalidTimeout);
        ctx.accounts.config.emergency_refund_timeout_seconds = new_timeout_seconds;
        Ok(())
    }

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
        case.deposited_at = Clock::get()?.unix_timestamp;
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

    /// The governed escape hatch for a deposit that is stuck: no
    /// decision ever reached (case genuinely UNDETERMINED), or one was
    /// reached but delivery/settlement never completed. Mirrors EVM's
    /// `Escrow.sol emergencyRefund()` exactly: same `onlyDecisionRelay`-
    /// equivalent boundary (only the designated `adjudicator` authority
    /// — decision-relay's escrow_authority PDA in production — may call
    /// this; `decision-relay::emergency_refund` independently verifies
    /// the same M-of-N attestor threshold before ever reaching here, so
    /// there is no unilateral-withdrawal path distinct from the one
    /// `settle` already has), same real on-chain timeout gate (elapsed
    /// since the ORIGINAL deposit, never reset by anything), same
    /// always-100%-to-claimant payout (the party whose funds these are,
    /// in this domain's REFUND_FULL vocabulary). Safe by construction:
    /// `initialize_case` requires the claimant to be the depositing
    /// signer, so there is no respondent-or-third-party-funded case
    /// this could misdirect.
    /// One-time migration for a Case account created before `deposited_at`
    /// existed on this struct (every case deposited before this program's
    /// 2026-09-18 upgrade — see docs/incidents/ for the finding). Those
    /// accounts are still allocated at the OLD `Case::MAX_SIZE` (8 bytes
    /// short of the current one), which means Anchor's typed
    /// `Account<'info, Case>` can't even deserialize them anymore — Borsh
    /// fails outright on a too-short buffer before any instruction body
    /// or `realloc` constraint gets a chance to run. `emergency_refund`
    /// would fail on every pre-upgrade case for that reason alone,
    /// independent of whether the real timeout had elapsed. This
    /// instruction works around that by taking `case` as a raw,
    /// PDA-verified `UncheckedAccount` instead: extends the account's
    /// lamports and length by exactly 8 bytes, then appends
    /// `deposited_at` as the new trailing field — every other field's
    /// byte offset is unchanged since `deposited_at` was added at the
    /// END of the struct, so this never touches claimant/respondent/
    /// adjudicator/amount/status/bump. `deposited_at` should be set to
    /// the real, independently-known deposit time (this program has no
    /// way to recover the original transaction's own timestamp after
    /// the fact) — the backend passes CaseSettlement.depositConfirmedAt
    /// from Postgres, the closest real record of when the deposit
    /// actually happened. Guarded by the same config-authority key as
    /// `update_emergency_refund_timeout` (never decisionRelay's
    /// escrow_authority PDA — same separation-of-authority reasoning as
    /// that instruction), and only runs once per account: an account
    /// already at the current size is rejected rather than silently
    /// overwriting a `deposited_at` some earlier migration already set.
    pub fn migrate_case_deposited_at(
        ctx: Context<MigrateCaseDepositedAt>,
        case_id: String,
        deposited_at: i64,
    ) -> Result<()> {
        require!(deposited_at > 0, EscrowError::InvalidTimeout);

        let case_info = ctx.accounts.case.to_account_info();
        let (expected_case_key, _bump) =
            Pubkey::find_program_address(&[b"case", case_id.as_bytes()], ctx.program_id);
        require_keys_eq!(case_info.key(), expected_case_key, EscrowError::Unauthorized);
        require_keys_eq!(*case_info.owner, crate::ID, EscrowError::Unauthorized);

        let old_len = case_info.data_len();
        require!(old_len == Case::MAX_SIZE - 8, EscrowError::AlreadyMigrated);

        let new_len = Case::MAX_SIZE;
        let rent = Rent::get()?;
        let new_minimum_balance = rent.minimum_balance(new_len);
        let additional_rent = new_minimum_balance.saturating_sub(case_info.lamports());
        if additional_rent > 0 {
            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(&ctx.accounts.authority.key(), &case_info.key(), additional_rent),
                &[
                    ctx.accounts.authority.to_account_info(),
                    case_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
        case_info.realloc(new_len, false)?;

        let mut data = case_info.try_borrow_mut_data()?;
        data[old_len..new_len].copy_from_slice(&deposited_at.to_le_bytes());

        Ok(())
    }

    pub fn emergency_refund(ctx: Context<EmergencyRefund>) -> Result<()> {
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
            ctx.accounts.claimant.key() == case.claimant,
            EscrowError::PartyMismatch
        );

        let ready_at = case
            .deposited_at
            .checked_add(ctx.accounts.config.emergency_refund_timeout_seconds)
            .ok_or(EscrowError::InvalidTimeout)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ready_at, EscrowError::TimeoutNotElapsed);

        let amount = case.amount_lamports;
        let case_info = case.to_account_info();
        if amount > 0 {
            **case_info.try_borrow_mut_lamports()? -= amount;
            **ctx.accounts.claimant.try_borrow_mut_lamports()? += amount;
        }

        ctx.accounts.case.status = CaseStatus::Refunded;
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
    /// Unix timestamp of `initialize_case`'s own execution — the ORIGINAL
    /// deposit time, never reset by anything (a `raise_dispute` call, a
    /// failed settle attempt, none of it moves this). `emergency_refund`'s
    /// only timeout check is against this field, exactly mirroring
    /// EVM's `Deposit.depositedAt`.
    pub deposited_at: i64,
}

impl Case {
    // discriminator(8) + case_id(4+MAX) + 3 pubkeys(32*3) + u64(8) + status(1) + bump(1) + deposited_at(8)
    pub const MAX_SIZE: usize = 8 + (4 + MAX_CASE_ID_LEN) + 32 * 3 + 8 + 1 + 1 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CaseStatus {
    Active,
    Disputed,
    Settled,
    Refunded,
}

/// Program-wide singleton — see `initialize_config`'s doc comment for
/// why this exists instead of a compiled-in constant.
#[account]
pub struct Config {
    pub authority: Pubkey,
    pub emergency_refund_timeout_seconds: i64,
    pub bump: u8,
}

impl Config {
    pub const MAX_SIZE: usize = 8 + 32 + 8 + 1;
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

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Config::MAX_SIZE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(constraint = authority.key() == config.authority @ EscrowError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(case_id: String)]
pub struct MigrateCaseDepositedAt<'info> {
    #[account(mut, constraint = authority.key() == config.authority @ EscrowError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: PDA derivation and current owner are verified in the
    /// instruction body — raw bytes, not `Account<'info, Case>`, because
    /// Anchor can't typed-deserialize a pre-migration (too-short) Case
    /// account at all. See `migrate_case_deposited_at`'s own doc comment.
    #[account(mut)]
    pub case: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EmergencyRefund<'info> {
    // Same account type/pattern as Settle's `adjudicator` above — a bare
    // Signer, not seed-constrained here, because in production this is
    // decision-relay's escrow_authority PDA arriving via invoke_signed,
    // never a plain wallet; the real access-control check is
    // `adjudicator.key() == case.adjudicator` in the instruction body.
    pub adjudicator: Signer<'info>,

    #[account(mut, seeds = [b"case", case.case_id.as_bytes()], bump = case.bump)]
    pub case: Account<'info, Case>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: address is verified against case.claimant above; no data read.
    #[account(mut)]
    pub claimant: UncheckedAccount<'info>,
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
    #[msg("emergency refund timeout must be greater than zero")]
    InvalidTimeout,
    #[msg("emergency refund timeout has not yet elapsed since deposit")]
    TimeoutNotElapsed,
    #[msg("this case account was already migrated to the current size")]
    AlreadyMigrated,
}
