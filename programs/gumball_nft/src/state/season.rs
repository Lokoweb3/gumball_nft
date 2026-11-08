use crate::*;

/// Seasonal trait window — while ends_at is in the future, new mints draw
/// flavor/color from [start, start+count) sub-ranges of the trait arrays.
#[account]
pub struct SeasonConfig {
    pub flavor_start: u8,      //  1
    pub flavor_count: u8,      //  1 — 0 = flavor unwindowed
    pub color_start:  u8,      //  1
    pub color_count:  u8,      //  1 — 0 = color unwindowed
    pub ends_at:      i64,     //  8 — unix ts; <= now disables
    pub label:        [u8; 12],// 12 — short ASCII tag, e.g. "WINTER-24"
    pub bump:         u8,      //  1
}

impl SeasonConfig { pub const LEN: usize = 1 + 1 + 1 + 1 + 8 + 12 + 1; }
