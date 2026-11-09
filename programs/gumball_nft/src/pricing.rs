use crate::*;

pub(crate) fn stake_weight(rarity: u8, serial: u64) -> u64 {
    let base = RARITY_WEIGHT[rarity as usize % 5];
    let capped = serial.min(MINT_BONUS_SUPPLY);
    let bonus_bps = MINT_BONUS_MAX_BPS * (MINT_BONUS_SUPPLY - capped) / MINT_BONUS_SUPPLY;
    // max: 591 * 15_000 — nowhere near u64 overflow
    base * (BPS_DENOMINATOR + bonus_bps) / BPS_DENOMINATOR
}

/// Exponential mint price: 0.03 * 4^(total_minted / 10000) XNT
/// Uses a 11-point lookup table of 4^(x/10) scaled by 10000, with linear
/// interpolation between points. No floating point needed.
/// Returns price in lamports.
pub(crate) fn get_mint_price(total_minted: u64) -> u64 {
    // 4^(i/10) * 10000, for i = 0..=10
    // 4^0.0=1.0, 4^0.1=1.1487, 4^0.2=1.3195, ..., 4^1.0=4.0
    const TABLE: [u64; 11] = [
        10000, 11487, 13195, 15157, 17411,
        20000, 22974, 26390, 30314, 34822,
        40000,
    ];
    if total_minted >= MAX_SUPPLY {
        return MAX_PRICE;
    }
    // Map total_minted (0..10000) to table index (0..10)
    // bucket = total_minted * 10 / MAX_SUPPLY
    let scaled = total_minted.checked_mul(10).unwrap_or(u64::MAX);
    if scaled == u64::MAX { return MAX_PRICE; }
    let bucket = (scaled / MAX_SUPPLY) as usize; // 0..9
    let remainder = scaled % MAX_SUPPLY;         // fractional position within bucket

    if bucket >= 10 {
        return MAX_PRICE;
    }

    // Linear interpolation between TABLE[bucket] and TABLE[bucket+1]
    let lo = TABLE[bucket];
    let hi = TABLE[bucket + 1];
    let interp = lo + (hi - lo) * remainder / MAX_SUPPLY;

    // price = BASE_PRICE * interp / 10000
    BASE_PRICE * interp / 10000
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_price_curve_endpoints_and_monotonic() {
        assert_eq!(get_mint_price(0), BASE_PRICE);              // 0.03 XNT at mint #1
        assert_eq!(get_mint_price(MAX_SUPPLY), MAX_PRICE);      // capped at supply
        assert_eq!(get_mint_price(u64::MAX), MAX_PRICE);        // overflow-safe
        let mut last = 0u64;
        for m in (0..=MAX_SUPPLY).step_by(250) {
            let p = get_mint_price(m);
            assert!(p >= last, "price must be monotonic at {m}: {p} < {last}");
            assert!(p >= BASE_PRICE && p <= MAX_PRICE);
            last = p;
        }
        // midpoint: 4^0.5 = 2 → exactly 2× base
        assert_eq!(get_mint_price(MAX_SUPPLY / 2), BASE_PRICE * 2);
    }

    #[test]
    fn stake_weight_bonus_curve() {
        // serial 1 ≈ +50% (bonus_bps = 5000*(9999)/10000 = 4999)
        assert_eq!(stake_weight(4, 1), 591 * 14999 / 10000);    // Legendary
        assert_eq!(stake_weight(2, 100), 70);                    // Rare, serial 100 (validated on-chain)
        // at/after supply cap: no bonus
        assert_eq!(stake_weight(4, 10_000), 591);
        assert_eq!(stake_weight(4, 999_999), 591);
        assert_eq!(stake_weight(0, 999_999), 1);
        // monotonic decay: earlier serial never earns less
        let mut last = u64::MAX;
        for s in [1u64, 100, 1000, 5000, 9999, 10_000] {
            let w = stake_weight(4, s);
            assert!(w <= last);
            last = w;
        }
        // rarity index wraps safely (defensive % 5)
        assert_eq!(stake_weight(7, 10_000), RARITY_WEIGHT[2]);
    }
}
