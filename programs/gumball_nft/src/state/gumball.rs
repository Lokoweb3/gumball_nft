use crate::*;

#[account]
pub struct GumballData {
    pub owner:           Pubkey,
    pub machine:         Pubkey,
    pub serial:          u64,
    pub flavor:          u8,
    pub color:           u8,
    pub rarity:          u8,
    pub special:         u8,
    pub minted_at:       u64,
    pub bump:            u8,
    // v4: proof fields for verify.html — enables full hash verification
    pub commitment_hash: [u8; 32],  // sha256(secret || oracle_pubkey) from OracleCommit
    pub user_seed:       [u8; 32],  // user-provided entropy from MintRequest
    // v5: oracle secret stored after reveal — enables trustless auto-verification
    pub oracle_secret:   [u8; 32],  // revealed oracle secret (zeroed for upgrades)
}

impl GumballData {
    pub const LEN: usize = 32+32+8+1+1+1+1+8+1+32+32+32;
    pub fn flavor_name(&self)  -> &'static str { FLAVORS [self.flavor  as usize % FLAVORS.len()]  }
    pub fn color_name(&self)   -> &'static str { COLORS  [self.color   as usize % COLORS.len()]   }
    pub fn rarity_name(&self)  -> &'static str { RARITY_NAMES[self.rarity as usize % 5]           }
    pub fn special_name(&self) -> &'static str { SPECIALS[self.special as usize % SPECIALS.len()] }
}

/// Separate PDA holding the on-chain SVG — not loaded by burn instructions
#[account]
pub struct GumballSvg {
    pub svg: Vec<u8>,
}

impl GumballSvg {
    pub const LEN: usize = 4 + MAX_SVG_LEN;
}
