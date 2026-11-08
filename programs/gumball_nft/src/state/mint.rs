use crate::*;

/// Stores oracle commitment before randomness is needed — C-2 fix
#[account]
pub struct OracleCommit {
    pub oracle:         Pubkey,    // 32
    pub commitment:     [u8; 32],  // 32 — sha256(secret || oracle_pubkey)
    pub submitted_at:   i64,       //  8
    pub submitted_slot: u64,       //  8
    pub used:           bool,      //  1
    pub bump:           u8,        //  1
}

impl OracleCommit { pub const LEN: usize = 32+32+8+8+1+1; }

/// Pending mint request linking user payment to a commitment
#[account]
pub struct MintRequest {
    pub minter:             Pubkey,    // 32
    pub machine:            Pubkey,    // 32
    pub commitment:         Pubkey,    // 32 — which OracleCommit to use
    pub quantity:           u8,        //  1
    pub remaining_quantity: u8,        //  1 — CRIT-1 FIX: tracks how many still to mint
    pub paid_amount:        u64,       //  8
    pub requested_at:       i64,       //  8 — for M-2 timeout
    pub fulfilled:          bool,      //  1
    pub bump:               u8,        //  1
    pub user_seed:          [u8; 32],  // 32 — CRIT-3 FIX: user-provided entropy
    pub request_slot:       u64,       //  8 — Clock slot of request_mint; fixes the seed slot (APPENDED: old 156-byte accounts lack it)
}

impl MintRequest { pub const LEN: usize = 32+32+32+1+1+8+8+1+1+32+8; }
