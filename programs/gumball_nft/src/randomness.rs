use crate::*;

#[derive(Default)]
pub(crate) struct Traits { pub(crate) flavor: u8, pub(crate) color: u8, pub(crate) rarity: u8, pub(crate) special: u8 }

/// Result of looking up the request's fixed seed slot in the SlotHashes sysvar.
#[derive(Debug, PartialEq)]
pub(crate) enum SlotLookup {
    /// (slot, hash) of the first recorded slot > request_slot + REVEAL_DELAY_SLOTS
    Found(u64, [u8; 32]),
    /// that slot has not been produced yet: retry later
    NotYet,
    /// the window has moved past it: the request can never be revealed
    AgedOut,
}

/// Find the first slot strictly greater than `request_slot + REVEAL_DELAY_SLOTS`
/// in raw SlotHashes data (`u64 len`, then `len` x (`u64 slot`, `[u8;32] hash`),
/// newest first). Reads the bytes in place and binary-searches them: no deserialization,
/// so the 32 KB heap is untouched. Skipped slots are handled: the result is the first
/// slot that actually exists after the threshold.
pub(crate) fn lookup_fixed_slot_hash(data: &[u8], request_slot: u64) -> SlotLookup {
    const ENTRY: usize = 40;
    let threshold = request_slot.saturating_add(REVEAL_DELAY_SLOTS);
    let count = match data.get(..8) {
        Some(b) => u64::from_le_bytes(b.try_into().unwrap_or([0; 8])) as usize,
        None => return SlotLookup::NotYet,
    };
    let count = count.min((data.len() - 8) / ENTRY);
    if count == 0 { return SlotLookup::NotYet; }
    let slot_at = |i: usize| -> u64 {
        let o = 8 + i * ENTRY;
        u64::from_le_bytes(data[o..o + 8].try_into().unwrap_or([0; 8]))
    };
    if slot_at(0) <= threshold { return SlotLookup::NotYet; }
    // The oldest entry must not sit beyond threshold+1, or the true first slot
    // after the threshold may already have been dropped from the window.
    if slot_at(count - 1) > threshold.saturating_add(1) { return SlotLookup::AgedOut; }
    // slots are strictly descending: find the largest index with slot > threshold
    let (mut lo, mut hi) = (0usize, count - 1);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if slot_at(mid) > threshold { lo = mid; } else { hi = mid - 1; }
    }
    let o = 8 + lo * ENTRY;
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[o + 8..o + 40]);
    SlotLookup::Found(slot_at(lo), hash)
}

pub(crate) fn resolve_traits(mut seed: u64, serial: u64) -> Result<Traits> {
    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(serial.wrapping_add(1));
    let flavor  = lcg_next(&mut seed, FLAVORS.len()  as u64) as u8;
    let color   = lcg_next(&mut seed, COLORS.len()   as u64) as u8;
    let special = lcg_next(&mut seed, SPECIALS.len() as u64) as u8;
    let roll    = lcg_next(&mut seed, 100) as u8;
    let rarity  = RARITY_CUTS.iter().position(|&c| roll < c).unwrap_or(4) as u8;
    Ok(Traits { flavor, color, rarity, special })
}

pub(crate) fn lcg_next(seed: &mut u64, modulus: u64) -> u64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (*seed >> 33) % modulus
}

/// Remap flavor/color into the active season window. Lenient by design:
/// an uninitialized/foreign/expired season account is a no-op, so the mint
/// path never depends on set_season having been called. The caller's seeds
/// constraint guarantees the address is THE season PDA — only set_season can
/// have written data there, so raw offsets are safe without a disc check.
/// Layout: disc(8) flavor_start(8) flavor_count(9) color_start(10)
///         color_count(11) ends_at i64 (12..20) label(20..32) bump(32)
pub(crate) fn apply_season(mut t: Traits, season_info: &AccountInfo) -> Result<Traits> {
    if season_info.data_len() != 8 + SeasonConfig::LEN || season_info.owner != &crate::ID {
        return Ok(t);
    }
    let data = season_info.try_borrow_data()?;
    let ends_at = i64::from_le_bytes(
        data[12..20].try_into().map_err(|_| error!(GumballError::InvalidAccount))?,
    );
    if ends_at <= Clock::get()?.unix_timestamp {
        return Ok(t);
    }
    let (fs, fc, cs, cc) = (data[8], data[9], data[10], data[11]);
    if fc > 0 { t.flavor = fs + (t.flavor % fc); }
    if cc > 0 { t.color  = cs + (t.color  % cc); }
    Ok(t)
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build raw SlotHashes data: `slots` newest first, hash = [slot as u8; 32].
    fn slot_hashes_data(slots: &[u64]) -> Vec<u8> {
        let mut d = (slots.len() as u64).to_le_bytes().to_vec();
        for s in slots {
            d.extend_from_slice(&s.to_le_bytes());
            d.extend_from_slice(&[*s as u8; 32]);
        }
        d
    }

    #[test]
    fn slot_lookup_found_is_first_slot_after_threshold() {
        // request_slot 100 -> threshold 102 -> first slot > 102 is 103
        let slots: Vec<u64> = (90..=110).rev().collect();
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&slots), 100),
                   SlotLookup::Found(103, [103u8; 32]));
        // identical answer whether the sysvar is 1 or 7 slots further on
        let later: Vec<u64> = (90..=117).rev().collect();
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&later), 100),
                   SlotLookup::Found(103, [103u8; 32]));
    }

    #[test]
    fn slot_lookup_skips_missing_slots() {
        // 103 and 104 were skipped: the first recorded slot after 102 is 105
        let slots = [110u64, 109, 108, 107, 106, 105, 102, 101, 100, 99];
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&slots), 100),
                   SlotLookup::Found(105, [105u8; 32]));
    }

    #[test]
    fn slot_lookup_not_yet() {
        // newest recorded slot is 102 == threshold: hash for >102 doesn't exist yet
        let slots = [102u64, 101, 100, 99];
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&slots), 100), SlotLookup::NotYet);
        // request slot itself is the newest (reveal right after request)
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&[99u64, 98]), 100), SlotLookup::NotYet);
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&[]), 100), SlotLookup::NotYet);
        assert_eq!(lookup_fixed_slot_hash(&[], 100), SlotLookup::NotYet);
    }

    #[test]
    fn slot_lookup_aged_out() {
        // full 512-entry window 1000..=1511; request at 100 is long gone
        let slots: Vec<u64> = (1000..1512).rev().collect();
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&slots), 100), SlotLookup::AgedOut);
        // boundary: oldest entry is threshold+1 -> still resolvable
        let slots: Vec<u64> = (103..615).rev().collect();
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&slots), 100),
                   SlotLookup::Found(103, [103u8; 32]));
        // one slot later the true first slot (103) has been dropped
        let slots: Vec<u64> = (104..616).rev().collect();
        assert_eq!(lookup_fixed_slot_hash(&slot_hashes_data(&slots), 100), SlotLookup::AgedOut);
    }

    #[test]
    fn slot_lookup_tolerates_truncated_data() {
        let mut d = slot_hashes_data(&[110u64, 109, 108, 103, 102]);
        d.truncate(8 + 40 * 3 + 5); // header claims 5 entries, only 3 whole ones present
        assert_eq!(lookup_fixed_slot_hash(&d, 100), SlotLookup::AgedOut);
    }

    #[test]
    fn season_window_remap_stays_in_bounds() {
        // The apply_season remap: out = start + (trait % count). For every
        // valid window accepted by set_season's require!, the result must land
        // inside [start, start+count) and inside the trait array.
        for fs in 0..FLAVORS.len() as u8 {
            for fc in 1..=(FLAVORS.len() as u8 - fs) {
                for flavor in 0..FLAVORS.len() as u8 {
                    let out = fs + (flavor % fc);
                    assert!(out >= fs && out < fs + fc);
                    assert!((out as usize) < FLAVORS.len());
                }
            }
        }
    }
}
