# Technical Notes — Gumball Machine NFT

---

## Architecture Evolution

### The Problem: BPF Heap Overflow

Early in development we attempted to add `commitment: [u8;32]` and `user_seed: [u8;32]`
to `GumballData` to enable provably fair on-chain verification. This caused all burn
instructions to fail with `memory allocation failed, out of memory` at only ~5,000 compute
units — before any real logic ran.

**Root cause:** The SBF runtime has a fixed 32KB heap. GumballData was ~865 bytes
(containing an inline SVG). Burn instructions load 3–5 GumballData accounts simultaneously:

  865 bytes x 5 accounts = 4,325 bytes + runtime overhead = heap exhausted

Adding 64 bytes for proof fields pushed it over the edge. The crash happened during
account deserialization, before the entrypoint even started running.

---

### The Fix: Separate SVG PDA

**What we did:** Moved the SVG out of `GumballData` into a separate `GumballSvg` PDA.

```
BEFORE (one account per NFT, ~865 bytes):
┌─────────────────────────────────────┐
│ GumballData PDA                     │
│ seeds: [b"gumball", mint.key()]     │
│                                     │
│ owner:     Pubkey  (32)             │
│ machine:   Pubkey  (32)             │
│ serial:    u64     (8)              │
│ flavor:    u8      (1)              │
│ color:     u8      (1)              │
│ rarity:    u8      (1)              │
│ special:   u8      (1)              │
│ minted_at: u64     (8)              │
│ bump:      u8      (1)              │
│ svg:       Vec<u8> (4 + 768 = 772)  │ <-- the problem
│                                     │
│ TOTAL: ~865 bytes                   │
└─────────────────────────────────────┘

AFTER (two accounts per NFT, 93 + 788 bytes):
┌──────────────────────────────┐   ┌──────────────────────────────────┐
│ GumballData PDA              │   │ GumballSvg PDA                   │
│ seeds: [b"gumball", mint]    │   │ seeds: [b"svg", mint.key()]      │
│                              │   │                                  │
│ owner:     Pubkey  (32)      │   │ svg: Vec<u8> (4 + 768 = 772)     │
│ machine:   Pubkey  (32)      │   │                                  │
│ serial:    u64     (8)       │   │ TOTAL: ~788 bytes                │
│ flavor:    u8      (1)       │   │                                  │
│ color:     u8      (1)       │   │ Never loaded by burn instructions│
│ rarity:    u8      (1)       │   │ Fetched on demand by frontend    │
│ special:   u8      (1)       │   └──────────────────────────────────┘
│ minted_at: u64     (8)       │
│ bump:      u8      (1)       │
│                              │
│ TOTAL: ~85 bytes             │ <-- 10x smaller
└──────────────────────────────┘
```

**Why this works:** Burn instructions only load `GumballData`. They never need the SVG.
The `GumballSvg` PDA exists on-chain permanently but is only fetched by the frontend
when a user clicks a gumball to view it.

**The SVG is still 100% on-chain** — stored in a program-owned PDA on X1 blockchain.
It cannot be changed. Anyone can read it directly from the chain.

Burn instructions now load: 85 bytes x 5 accounts = 425 bytes. Well within heap limits.

---

### Now Safe: Proof Fields (v4) + Oracle Secret (v5) — DEPLOYED

With `GumballData` lean at 85 bytes, we safely added the proof fields that previously
caused the heap overflow:

```
GumballData v5 (current)
────────────────────────────────────
owner:           Pubkey    (32)
machine:         Pubkey    (32)
serial:          u64       (8)
flavor:          u8        (1)
color:           u8        (1)
rarity:          u8        (1)
special:         u8        (1)
minted_at:       u64       (8)
bump:            u8        (1)
commitment_hash: [u8; 32]  (32)  <- sha256(secret || oracle_pubkey)
user_seed:       [u8; 32]  (32)  <- user-provided entropy
oracle_secret:   [u8; 32]  (32)  <- revealed oracle secret (v5)
────────────────────────────────────
TOTAL: 181 bytes (+ 8 disc = 189)
```

Burn instructions with v5: 189 bytes x 5 = 945 bytes — still well within heap limits.

`commitment_hash`, `user_seed`, and `oracle_secret` are set to `[0; 32]` for
upgrade-created gumballs (no commit-reveal for burns). `verify.html` detects this
and shows appropriate messaging.

This enables fully trustless on-chain verification:
  sha256(oracle_secret || oracle_pubkey) == commitment_hash (stored on gumball)

Anyone can independently verify any gumball's randomness without trusting the oracle.
The oracle secret is stored on-chain after reveal — `verify.html` auto-verifies v5
gumballs with no user input needed.

---

## Dynamic Mint Pricing

### Formula

```
price = BASE_PRICE * 4^(total_minted / 10,000) XNT
```

Testnet: starts at 0.01 XNT, ends at 0.04 XNT. The multiplier is 4x over the full supply.

### On-chain Implementation

No floating point. Uses an 11-point lookup table of `4^(i/10) * 10000` with linear
interpolation between points:

```rust
const TABLE: [u64; 11] = [
    10000, 11487, 13195, 15157, 17411,
    20000, 22974, 26390, 30314, 34822,
    40000,
];
```

Steps:
1. Map `total_minted` (0–10,000) to a bucket index (0–9)
2. Linearly interpolate between `TABLE[bucket]` and `TABLE[bucket+1]`
3. Multiply by `BASE_PRICE` (10,000,000 lamports on testnet) and divide by 10,000

For batch mints, the contract sums each mint's individual price:
```rust
for i in 0..quantity {
    total_cost += get_mint_price(total_minted + i);
}
```

### Frontend Mirror

JavaScript replicates the exact same table and interpolation logic so the displayed
price matches the on-chain calculation to the lamport.

### Revenue Projection

| Sellout % | Revenue |
|---|---|
Testnet (0.01 base):
| Sellout % | Revenue |
|---|---|
| 25% (2,500) | ~28 XNT |
| 50% (5,000) | ~71 XNT |
| 75% (7,500) | ~112 XNT |
| 100% (10,000) | ~163 XNT |

---

## X1 Mainnet Considerations

X1 uses the same BPF VM as Solana (rbpf). The heap constraint is baked into the runtime.

| Factor | Value | Notes |
|---|---|---|
| Heap size | 32KB | Fixed in SBF runtime, same as Solana |
| Account overhead | 64+ bytes per account | On top of data size |
| Compute limit | 1.4M default | Burns use ~80K CUs — fine |
| Rent cost | Lower than Solana | XNT is cheaper per byte |

With the current architecture (93-byte GumballData), burns work reliably on both
testnet and mainnet. The heap issue is fully resolved.

---

## Account Sizes Reference

| Account | Size | Notes |
|---|---|---|
| `Machine` | 138 bytes | Global state |
| `OracleCommit` | 66 bytes | Per commitment |
| `MintRequest` | 164 bytes | Per mint batch |
| `GumballData` v1 | 1,129 bytes | Original (inline SVG, MAX_SVG_LEN=1024) |
| `GumballData` v2 | 873 bytes | Reduced SVG (MAX_SVG_LEN=768) |
| `GumballData` v3 | 93 bytes | Legacy — SVG moved to separate PDA, no proof fields |
| `GumballData` v4 | 157 bytes | Legacy — v3 + commitment_hash + user_seed |
| `GumballSvg` | 788 bytes | Current — holds SVG, never loaded by burns |
| `GumballData` v5 | 189 bytes | Current — v4 + oracle_secret for trustless verification |

All five GumballData versions (v1, v2, v3, v4, v5) coexist on testnet. The frontend handles
all versions via multiple `dataSize` filters in `getProgramAccounts`.

---

## Frontend Version Handling

```javascript
const GD_V1 = 8+32+32+8+1+1+1+1+8+1+4+1024; // 1129 - original
const GD_V2 = 8+32+32+8+1+1+1+1+8+1+4+768;  // 873  - reduced SVG
const GD_V3 = 8+32+32+8+1+1+1+1+8+1;         // 93   - legacy (SVG separate, no proof)
const GD_V4 = 8+32+32+8+1+1+1+1+8+1+32+32;   // 157  - legacy (with proof fields)
const GD_V5 = 8+32+32+8+1+1+1+1+8+1+32+32+32; // 189 - current (with oracle_secret)
```

SVG loading per version:
- **v1/v2:** SVG inline in GumballData at offset `8+32+32+8+1+1+1+1+8+1`
- **v3/v4/v5:** SVG fetched lazily from `GumballSvg` PDA when user opens modal

---

## Security Audit Checklist (Pre-Mainnet)

### Instruction Constraints
- [x] `request_mint` — oracle commitment must be unused, quantity <= MAX_PER_TX
- [x] `reveal_and_mint` — oracle must match machine.oracle, commitment verified
- [x] `burn_to_upgrade` — owner validated manually from raw data (UncheckedAccount)
- [x] `burn_multi` — owner and rarity validated manually from raw data
- [x] `refund_mint` — only after MINT_TIMEOUT, only unfulfilled requests
- [x] `reclaim_burned` — owner field must be all zeros (zombie PDA check)
- [x] `withdraw` — only admin/authority
- [x] `set_oracle` — only admin/authority
- [x] **Review:** `burn_multi` remaining_accounts validated via PDA seed check + owner + rarity
- [x] **Review:** `update_owner` safe — reads ATA balance, only syncs to actual token holder
- [x] `reveal_and_mint` — timeout path sets fulfilled = true (prevents double refund)
- [x] Bounds checks on all raw account data reads (InvalidAccount error)
- [x] Auto rent reclaim on burns (no zombie PDAs)

### Code Safety (Audit Rounds 3-5)
- [x] No unsafe `.unwrap()` on fallible operations — all use `.map_err()`
- [x] No silent `.unwrap_or()` fallbacks on slot hashes — all error on failure
- [x] Integer overflow protected: `checked_mul(10)` in `get_mint_price()`
- [x] Rent sweep validated: `require!(sweep > 0)` on last-mint treasury forward
- [x] No division-by-zero possible (all divisors validated or constant)
- [x] All array access bounds-checked via modulo or explicit require
- [x] No reentrancy risk (token program CPI does not callback)
- [x] MED-4: burn_to_upgrade standardized to 32-byte slot hash [16..48] (was 8-byte)
- [x] `reclaim_burned` removed — eliminates attack surface, burns auto-reclaim
- [x] Final audit (round 5): CLEAN — no remaining issues

### Economic
- [x] Mint pricing — exponential curve 0.01 → 0.04 XNT testnet (deployed)
- [ ] Decide max supply (currently 10,000)
- [ ] Decide burn ratios (currently 5/3/2/2)
- [x] Upgrade fee = current mint price (deployed)
- [x] Payment division fix — last mint sweeps remaining lamports
- [ ] Treasury withdrawal access control review

### Operational
- [ ] Upgrade authority is currently the oracle wallet — separate before mainnet
- [ ] Multi-sig for admin instructions on mainnet
- [ ] Oracle wallet should hold minimal funds (rent + fees only)
- [x] Telegram monitoring + remote commands (deployed)
- [x] Oracle secrets encrypted with AES-256-GCM
- [x] Command injection fix in monitor (execFile + whitelist)

---

## Mainnet Deployment Checklist

- [x] Add proof fields to GumballData (v4 upgrade — deployed)
- [x] Add oracle_secret to GumballData (v5 upgrade — trustless verification)
- [x] Dynamic exponential mint pricing (0.01 → 0.04 XNT testnet — deployed)
- [x] Testnet faucet (0.1 XNT per wallet per 24h, separate faucet wallet)
- [x] Security audit rounds 1-3 — all findings fixed, final audit clean
- [x] Oracle monitoring via Telegram
- [x] Oracle secret encryption
- [x] Push all final code to GitHub
- [ ] Deploy program to mainnet with fresh program ID
- [ ] Initialize machine with mainnet treasury wallet
- [ ] Separate upgrade authority from oracle wallet
- [ ] Run oracle on dedicated server (PM2 + uptime monitoring)
- [ ] Verify verify.html works end-to-end on mainnet RPC
- [ ] Update README with mainnet program ID and explorer links