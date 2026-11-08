use crate::*;

/// English auction — NFT escrowed in the shared listing escrow; the highest
/// bid escrows as lamports in this PDA (refunded on outbid).
#[account]
pub struct Auction {
    pub seller:         Pubkey, // 32
    pub nft_mint:       Pubkey, // 32
    pub start_price:    u64,    //  8 — minimum first bid
    pub ends_at:        i64,    //  8 — extended by anti-snipe bids
    pub highest_bid:    u64,    //  8 — 0 = no bids yet
    pub highest_bidder: Pubkey, // 32
    pub settled:        bool,   //  1
    pub bump:           u8,     //  1
}

impl Auction { pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 32 + 1 + 1; }
