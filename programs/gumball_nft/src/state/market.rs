use crate::*;

/// Marketplace listing — seller lists NFT at a fixed price
#[account]
pub struct Listing {
    pub seller:     Pubkey,  // 32
    pub nft_mint:   Pubkey,  // 32
    pub price:      u64,     //  8
    pub created_at: i64,     //  8
    pub bump:       u8,      //  1
}

impl Listing { pub const LEN: usize = 32+32+8+8+1; }

/// Marketplace offer — buyer bids on an NFT with escrowed XNT
#[account]
pub struct Offer {
    pub buyer:      Pubkey,  // 32
    pub nft_mint:   Pubkey,  // 32
    pub amount:     u64,     //  8
    pub created_at: i64,     //  8
    pub expires_at: i64,     //  8 — 0 means no expiry (legacy compat)
    pub bump:       u8,      //  1
}

impl Offer { pub const LEN: usize = 32+32+8+8+8+1; }
