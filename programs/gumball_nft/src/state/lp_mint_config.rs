use crate::*;

/// The one LP mint stake_lp accepts. Sibling PDA (seeds [b"lp_mint_config"]) so
/// StakeConfig keeps its layout. Written only by set_lp_mint.
#[account]
pub struct LpMintConfig {
    pub lp_mint: Pubkey, // 32
    pub bump:    u8,     //  1
}

impl LpMintConfig { pub const LEN: usize = 32 + 1; }
