use crate::*;

// ─── Phase 2: XNT Fee Sharing State ─────────────────────────────────────────

/// Lamport-holding PDA for a fee-sharing pool. Owned by the program.
/// Two instances:
///   nft_xnt_pool — accrues NFT-staker share of all fees
///   lp_xnt_pool  — accrues LP-staker share of all fees
#[account]
pub struct XntPool {
    pub bump: u8,
}

impl XntPool { pub const LEN: usize = 1; }

/// Accumulator state for one fee-sharing stream (NFT or LP).
/// `last_seen_balance` lets us know how many new lamports arrived since the
/// last accumulator update, even though deposits happen out-of-band.
#[account]
pub struct XntFeeState {
    pub stake_type:        u8,    //  1 — 0 = NFT, 1 = LP (informational)
    pub acc_xnt_per_weight: u128, // 16 — scaled by ACC_SCALE
    pub last_seen_balance:  u64,  //  8 — pool lamports observed last update
    pub bump:              u8,    //  1
}

impl XntFeeState { pub const LEN: usize = 1 + 16 + 8 + 1; }

/// Per-position XNT debt — created lazily on first claim_xnt_fees call.
/// Sibling PDA to the v2 StakeAccount / LpStakeAccount so we don't have to
/// migrate existing positions to add a field.
#[account]
pub struct XntDebt {
    pub debt: u128, // 16 — scaled by ACC_SCALE
    pub bump: u8,   //  1
}

impl XntDebt { pub const LEN: usize = 16 + 1; }
