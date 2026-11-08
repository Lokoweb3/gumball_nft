use crate::*;

// ─── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct Machine {
    pub authority:    Pubkey,  // 32
    pub treasury:     Pubkey,  // 32
    pub oracle:       Pubkey,  // 32 — M-1 fix: rotatable oracle

    pub mint_price:   u64,     //  8
    pub total_minted: u64,     //  8 — total ever created (mints + upgrade outputs)
    pub max_supply:   u64,     //  8
    pub is_active:    bool,    //  1
    pub bump:         u8,      //  1
    pub total_burned: u64,     //  8 — total ever destroyed via burns
}

impl Machine { pub const LEN: usize = 32+32+32+8+8+8+1+1+8; }
