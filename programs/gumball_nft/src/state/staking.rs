use crate::*;

// ─── Staking State ───────────────────────────────────────────────────────────

#[account]
pub struct StakeConfig {
    pub authority:                  Pubkey,  // 32 — admin wallet
    pub gum_mint:                   Pubkey,  // 32 — the fixed-supply GUM mint
    pub nft_reward_vault:           Pubkey,  // 32 — ATA(gum_mint, stake_config) for NFT rewards
    pub lp_reward_vault:            Pubkey,  // 32 — ATA(gum_mint, stake_config) for LP rewards
    pub total_staked:               u64,     //  8 — # of NFTs staked (informational)
    pub total_claimed:              u64,     //  8 — total GUM emitted (informational)
    pub total_nft_weight:           u128,    // 16 — sum of all active NFT stakers' weights
    pub total_lp_weight:            u128,    // 16 — sum of all active LP positions' weights
    pub acc_nft_reward_per_weight:  u128,    // 16 — accumulator (scaled by ACC_SCALE)
    pub acc_lp_reward_per_weight:   u128,    // 16 — accumulator (scaled by ACC_SCALE)
    pub last_nft_emission_update:   i64,     //  8 — last accumulator-update timestamp
    pub last_lp_emission_update:    i64,     //  8 — last accumulator-update timestamp
    pub bump:                       u8,      //  1
}

impl StakeConfig {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 8 + 8 + 16 + 16 + 16 + 16 + 8 + 8 + 1;
}

#[account]
pub struct StakeAccount {
    pub owner:        Pubkey,  // 32
    pub nft_mint:     Pubkey,  // 32
    pub rarity:       u8,      //  1
    pub weight:       u64,     //  8 — cached: stake_weight(rarity, serial) — rarity weight × early-mint bonus
    pub staked_at:    i64,     //  8
    pub last_claimed: i64,     //  8 — informational only; not used in Pattern B math
    pub reward_debt:  u128,    // 16 — accumulator snapshot at last claim (scaled by ACC_SCALE)
    pub bump:         u8,      //  1
}

impl StakeAccount { pub const LEN: usize = 32 + 32 + 1 + 8 + 8 + 8 + 16 + 1; }

#[account]
pub struct LpStakeAccount {
    pub position_mint:    Pubkey,  // 32 — NFT mint representing this position
    pub lp_mint:          Pubkey,  // 32
    pub amount:           u64,     //  8 — raw LP tokens staked
    pub staked_at:        i64,     //  8
    pub last_claimed:     i64,     //  8 — informational
    pub lock_until:       i64,     //  8 — unix timestamp when lock expires
    pub lock_multiplier:  u16,     //  2 — bps copy of LOCK_MULTIPLIER_BPS[tier] (100=1×)
    pub lock_tier:        u8,      //  1 — index into LOCK_DAYS / LOCK_MULTIPLIER_BPS / EARLY_EXIT_PENALTY_BPS
    pub weight:           u128,    // 16 — cached: amount × multiplier / 100
    pub reward_debt:      u128,    // 16 — accumulator snapshot at last claim
    pub bump:             u8,      //  1
}

impl LpStakeAccount { pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 2 + 1 + 16 + 16 + 1; }
