use crate::*;

// ─── SVG Generator ────────────────────────────────────────────────────────────

pub(crate) fn generate_svg(serial: u64, flavor: u8, color: u8, rarity: u8, special: u8) -> Vec<u8> {
    use core::fmt::Write as _;

    let ci = color   as usize % 12;
    let ri = rarity  as usize % 5;
    let si = special as usize % 8;
    let fi = flavor  as usize % 20;

    let hi = BALL_HI[ci]; let sh = BALL_SH[ci];
    let gl = BALL_GL[ci]; let rc = RARITY_RC[ri];
    let bg = RARITY_BG[ri];
    let fl = FLAVORS[fi];  let rn = RARITY_NAMES[ri];

    // Dispatch on the trait INDEX, not the display name. SPECIALS[0..=3] are
    // all "None"; 4..=7 carry artwork. Matching on `si` avoids a string
    // compare per branch and decouples the artwork from the label text.
    let special_el: &str = match si {
        4 => r##"<circle cx="125" cy="115" r="2" fill="#fff" opacity=".9"/><circle cx="170" cy="130" r="1.5" fill="#fff" opacity=".8"/><circle cx="140" cy="160" r="2" fill="#fff" opacity=".7"/><circle cx="165" cy="110" r="1.5" fill="#fff" opacity=".85"/>"##, // Glitter
        5 => r##"<circle cx="205" cy="90" r="45" fill="url(#b)" opacity=".5"/><ellipse cx="192" cy="78" rx="12" ry="8" fill="#fff" opacity=".3"/>"##, // Double Bubble
        6 => r##"<circle cx="150" cy="145" r="85" fill="none" stroke="url(#hl)" stroke-width="4" opacity=".4"/>"##, // Holographic
        7 => r##"<polygon points="150,60 195,115 185,170 150,190 115,170 105,115" fill="none" stroke="#fff" stroke-width="1" opacity=".25"/>"##, // Crystal
        _ => "",
    };

    let holo_grad = if si == 6 {
        r##"<linearGradient id="hl"><stop offset="0%" stop-color="#f4a"/><stop offset="50%" stop-color="#4af"/><stop offset="100%" stop-color="#4fa"/></linearGradient>"##
    } else { "" };

    let legend_el = if ri == 4 {
        r##"<circle cx="150" cy="145" r="115" fill="none" stroke="#fc0" stroke-width="1" stroke-dasharray="5 3" opacity=".5"/>"##
    } else { "" };

    // `write!` formats directly into `svg`. The previous `push_str(&format!(..))`
    // allocated a throwaway String per fragment — and the SBF bump allocator
    // never reclaims a freed allocation, so each temporary held heap for the
    // whole instruction. burn_multi builds up to 5 of these in one call.
    let mut svg = String::with_capacity(MAX_SVG_LEN);
    svg.push_str(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">"#);
    let _ = write!(svg, r#"<defs><radialGradient id="b" cx="35%" cy="30%" r="65%"><stop offset="0%" stop-color="{hi}"/><stop offset="70%" stop-color="{gl}"/><stop offset="100%" stop-color="{sh}"/></radialGradient>{holo_grad}</defs>"#);
    let _ = write!(svg, r#"<rect width="300" height="300" fill="{bg}"/>"#);
    svg.push_str(legend_el);
    let _ = write!(svg, r#"<circle cx="150" cy="145" r="106" fill="{gl}" opacity=".08"/>"#);
    svg.push_str(r##"<ellipse cx="150" cy="250" rx="55" ry="7" fill="#000" opacity=".3"/>"##);
    svg.push_str(r##"<circle cx="150" cy="145" r="100" fill="url(#b)"/>"##);
    svg.push_str(special_el);
    svg.push_str(r##"<ellipse cx="120" cy="110" rx="28" ry="18" fill="#fff" opacity=".4" transform="rotate(-30,120,110)"/>"##);
    let _ = write!(svg, r##"<circle cx="150" cy="145" r="100" fill="none" stroke="{rc}" stroke-width="2" opacity=".4"/>"##);
    svg.push_str(r##"<rect x="0" y="250" width="300" height="50" fill="#000" opacity=".6"/>"##);
    let _ = write!(svg, r##"<text x="150" y="270" text-anchor="middle" font-family="monospace" font-size="13" font-weight="bold" fill="#fff">{fl}</text>"##);
    let _ = write!(svg, r##"<text x="150" y="288" text-anchor="middle" font-family="monospace" font-size="9" fill="{rc}">{rn} #{serial:04}</text>"##);
    svg.push_str("</svg>");

    // Truncate in place — the old `bytes[..MAX].to_vec()` allocated a second
    // buffer. All emitted bytes are ASCII, so a byte-boundary cut is safe.
    let mut bytes = svg.into_bytes();
    bytes.truncate(MAX_SVG_LEN);
    bytes
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden fixtures for `generate_svg`.
    ///
    /// The on-chain SVG IS the artwork — a byte that changes here changes what
    /// every holder sees, and `reroll_cosmetics` rewrites live accounts in
    /// place. These hashes pin the exact output of every branch (each special,
    /// each rarity, the Legendary ring, the Holographic gradient, serial-width
    /// formatting and the modulo-wrap defence) so the generator can be
    /// optimized without altering a single rendered pixel.
    ///
    /// If one of these fails, the output changed. Do not re-bake the hash
    /// unless the change was intended.
    #[test]
    fn generate_svg_golden_output() {
        // (serial, flavor, color, rarity, special, expected_len, expected_hash)
        const GOLDEN: &[(u64, u8, u8, u8, u8, usize, &str)] = &[
            // every `special` branch — SPECIALS[0..=3] are all "None"
            (42, 3, 5, 2, 0, 1006, "8ZDos2cM5tZrucsNj5xnAhtiAmbvSFi46VHxygaVTa1y"),
            (42, 3, 5, 2, 1, 1006, "8ZDos2cM5tZrucsNj5xnAhtiAmbvSFi46VHxygaVTa1y"),
            (42, 3, 5, 2, 2, 1006, "8ZDos2cM5tZrucsNj5xnAhtiAmbvSFi46VHxygaVTa1y"),
            (42, 3, 5, 2, 3, 1006, "8ZDos2cM5tZrucsNj5xnAhtiAmbvSFi46VHxygaVTa1y"),
            (42, 3, 5, 2, 4, 1243, "DP21Gz6FBaq4drLxDci6i1eHrFA8uzRpFbG6e3YPb83E"), // Glitter
            (42, 3, 5, 2, 5, 1134, "BvX11iVyPsMqSZEH9bp871BHVNpcx2zbFbdL8pr8Zk3n"), // Double Bubble
            (42, 3, 5, 2, 6, 1255, "DSeKJzYRvXcNhZRs3my93eogR8GtcQo12pW8nw8arYhe"), // Holographic (+gradient)
            (42, 3, 5, 2, 7, 1129, "99y8a5YrFdSwMeWjWvJi3eorsyEHZfUYnSJJKXz9KPcD"), // Crystal
            // every rarity — index 4 adds the Legendary ring
            (7, 1, 9, 0, 0, 1004, "2SEd7CoQ1WFwQ91FQY9SYwvjKCcE282ABXdu3kkG5H12"),
            (7, 1, 9, 1, 0, 1006, "6Wh8s7wYekcDKMPviK45iz159oVoUKUEmUENX2qW3caq"),
            (7, 1, 9, 2, 0, 1002, "DeDvAydikW4BcShxFEEJCZmd5CHRtebFyyAdcN4jkQwQ"),
            (7, 1, 9, 3, 0, 1002, "jzTDrxTkc3TjVBvepXMV9kgCiuJKbFkTjpKimJgCgYk"),
            (7, 1, 9, 4, 0, 1121, "3bY3rUJK7CbNPLHNaNCpkDEL1cwvn3tyb4hC1tsm1jGr"),
            // serial formatting: {serial:04} pads below 1000 and grows beyond 9999
            (1, 0, 0, 0, 0, 1005, "AT27mwgAQ3YiFjHH6ztouiWc9H6hSpvjBzoVzM2acTuR"),
            (9999, 19, 11, 4, 7, 1246, "EnaQxSZQLqSDoADam3m3bbKrCMN5vqYfNWyc71r4rnFC"),
            (10_000, 19, 11, 4, 2, 1124, "F8Hc5Gto2my6KbWJEyHJvY8Es2udC2UFTuwNY5jPi28t"),
            (123_456_789, 5, 5, 4, 1, 1126, "HGDFFfxPaQd2XMbduDLChTJobK2D59szJuMu9x9YmFen"),
            // out-of-range trait bytes must still wrap safely (defensive `%`)
            (0, 255, 255, 255, 255, 1131, "9m1A1pEamxVyjCkC8qcVuP6LRFYiNJDmHpXSUZnMGPnH"),
        ];

        for &(serial, flavor, color, rarity, special, want_len, want_hash) in GOLDEN {
            let svg = generate_svg(serial, flavor, color, rarity, special);
            let got = anchor_lang::solana_program::hash::hash(&svg).to_string();
            assert_eq!(
                svg.len(), want_len,
                "length changed for (serial {serial}, f {flavor}, c {color}, r {rarity}, sp {special})"
            );
            assert_eq!(
                got, want_hash,
                "SVG bytes changed for (serial {serial}, f {flavor}, c {color}, r {rarity}, sp {special})"
            );
            // Must always be a well-formed, storable SVG.
            assert!(svg.len() <= MAX_SVG_LEN, "SVG exceeds the GumballSvg account cap");
            assert!(svg.starts_with(b"<svg "), "missing opening tag");
            assert!(svg.ends_with(b"</svg>"), "missing closing tag");
        }
    }
}
