# CLAUDE.md — Gumball Machine NFT

This file helps Claude understand the project context, architecture decisions, and how to approach common tasks.

---

## Project Purpose

A fully on-chain NFT gumball machine on X1 (Solana-compatible) blockchain. Users pay XNT to mint randomized SVG gumballs with provably fair randomness via a commit-reveal oracle. Gumballs can be burned to upgrade rarity.

**Key properties:**
- SVG artwork stored 100% on-chain (no IPFS, no centralized storage)
- Provably fair randomness — oracle cannot manipulate outcomes
- Burn-to-upgrade mechanic across 5 rarity tiers
- Single wallet approval for up to 10 mints

---

## Stack

| Layer | Technology |
|---|---|
| Smart contract | Anchor (Rust), deployed on X1 Testnet |
| Randomness | Commit-reveal oracle (Node.js, oracle.cjs) |
| Frontend | Vanilla JS + HTML, no framework |
| Process manager | PM2 (oracle auto-restart) |
| RPC | `https://rpc.testnet.x1.xyz` |
| Explorer | `https://explorer.testnet.x1.xyz` |

---

## Deployed Addresses

| | Address |
|---|---|
| Program ID | `AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy` |
| Machine PDA | `Ge8524seSpQ2BLRiMAnk5tg7YRKCTxVscQSxBvPvoyxY` |
| Oracle wallet | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` |
| Faucet wallet | `BW74FxoPQua2WRMB2hXXK4EegPpXFjEKoPoD38XY9iDJ` |

---

## Key Architecture Decisions

### 1. GumballData is split into two PDAs

Each NFT creates two on-chain accounts:

```
GumballData  seeds: [b"gumball", mint.key()]  — 189 bytes (v5, metadata + proof fields + oracle_secret)
GumballSvg   seeds: [b"svg", mint.key()]       — 788 bytes (on-chain SVG)
```

**Why:** Burn instructions load 3–5 GumballData accounts simultaneously. The SBF runtime
has a 32KB heap. With SVG inline (~865 bytes each), 5 accounts = heap overflow at ~5K CUs.
With SVG separate (93 bytes each), 5 accounts = 465 bytes — no problem.

The SVG is still 100% on-chain. It's just in a sibling PDA that burn instructions never load.

### 2. GumballData is v5 only

Current deployment uses a single format:

```
v5 = 189 bytes  (metadata + commitment_hash + user_seed + oracle_secret)
```

The frontend queries only `dataSize: 189`. Previous testnet iterations had v1–v4 formats
but those were removed in the fresh deploy (new Program ID `AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy`).
If a future struct change is needed, add a new dataSize filter alongside v5.

### 3. UncheckedAccount for burn PDAs

`gumball_a` and `gumball_b` in `BurnToUpgrade`, and `gumball_a` in `BurnMulti` are
`UncheckedAccount<'info>` instead of `Account<'info, GumballData>`. This avoids
Anchor auto-deserialization which loads the full struct into heap.

Owner, rarity, and machine are validated manually in the instruction body:
```rust
let data_a = ctx.accounts.gumball_a.try_borrow_data()?;
let owner_a = Pubkey::try_from(&data_a[8..40]).unwrap();
require!(owner_a == ctx.accounts.burner.key(), GumballError::Unauthorized);
let burn_rarity = data_a[8+32+32+8+1+1]; // rarity offset
```

### 4. Commit-reveal randomness

```
Oracle submits: sha256(secret || oracle_pubkey) on-chain BEFORE user pays
User pays with: random user_seed (unknown to oracle)
Oracle reveals: secret -> contract verifies commitment, derives traits from
                sha256(secret || slot_hash || user_seed || mint_index)
```

Neither party can manipulate outcome: oracle committed before seeing user_seed,
user doesn't know secret or slot_hash.

### 5. Multi-mint with single approval

User requests N mints in one transaction. Oracle loops through N reveals, each
minting one GumballData + GumballSvg pair. The `remaining_quantity` field in
`MintRequest` tracks progress.

### 6. oracle-secrets.json

The oracle persists commitment secrets (AES-256-GCM encrypted) to `oracle-secrets.json`.
On restart it scans for unfulfilled requests from previous sessions. This file must
NEVER be committed to GitHub — it's in `.gitignore`. Encryption key is in `.env` as
`ORACLE_ENCRYPTION_KEY`.

---

## GumballData Layout (v5, current)

```
Offset  Size  Field
0       8     Anchor discriminator
8       32    owner (Pubkey)
40      32    machine (Pubkey)
72      8     serial (u64, little-endian)
80      1     flavor (u8, index into FLAVORS array)
81      1     color (u8, index into COLORS array)
82      1     rarity (u8, 0=Common 1=Uncommon 2=Rare 3=Epic 4=Legendary)
83      1     special (u8, index into SPECIALS array)
84      8     minted_at (u64, unix timestamp)
92      1     bump (u8)
93      32    commitment_hash ([u8; 32], sha256(secret || oracle_pubkey) — zeroed for upgrades)
125     32    user_seed ([u8; 32], user-provided entropy — zeroed for upgrades)
157     32    oracle_secret ([u8; 32], revealed oracle secret — zeroed for upgrades)
```

GumballSvg layout:
```
Offset  Size  Field
0       8     Anchor discriminator
8       4     svg vec length (u32, little-endian)
12      N     svg bytes (UTF-8 SVG string)
```

---

## Common Tasks

### Debugging oracle issues

1. Check `pm2 logs gumball-oracle --lines 50`
2. Look for `Failed to reveal` — indicates simulation failure
3. Common causes:
   - Wrong account order in instruction keys
   - `paid_amount` overflow (must divide by quantity for multi-mint)
   - `oracle_commit.used` constraint blocking subsequent reveals
   - Missing new accounts after contract changes (e.g. `gumball_svg`)

### Debugging frontend collection loading

1. Check `dataSize` filters match current `GumballData::LEN`
2. Check `gumballMintMap` — built from token accounts with `amount === 1`
3. Check version handling — v3 has no inline SVG, fetches lazily
4. Run in console: `collection.forEach(g => console.log(g.serial, g.version, g.mintPubkey?.toBase58()?.slice(0,8)))`

### Adding a new instruction

1. Add instruction function in `lib.rs` inside `#[program]` block
2. Add `#[derive(Accounts)]` struct for the instruction
3. Build: `anchor build`
4. Update frontend: compute discriminator with `disc("instruction_name")`, build keys array matching struct order exactly
5. If oracle calls it, update `oracle.cjs` with new PDA derivations and keys
6. Deploy: `anchor deploy --provider.cluster https://rpc.testnet.x1.xyz --provider.wallet ~/.config/solana/id.json`
7. Restart oracle: `pm2 restart gumball-oracle`

### Changing GumballData struct

1. Update struct in `lib.rs`
2. Update `GumballData::LEN`
3. Add migration instruction if existing accounts need updating
4. Add new `dataSize` filter in frontend alongside existing v5 filter
5. Update SVG offset parsing if fields added before SVG
6. Update leaderboard `GD_SIZE` constant
7. Run `node scripts/initialize.cjs --migrate` if Machine struct changed
8. For clean slate: deploy new Program ID + `reset_counts` or fresh `initialize_machine`

### Deploying contract changes

```bash
anchor build
anchor deploy --provider.cluster https://rpc.testnet.x1.xyz --provider.wallet ~/.config/solana/id.json
pm2 restart gumball-oracle
```

No migration needed unless Machine struct changed.

### Adding a new frontend page

1. Copy header/footer structure from `index.html`
2. Add nav link to all pages (`index.html`, `leaderboard.html`, `verify.html`, `faucet.html`)
3. Use same constants: `PROGRAM_ID_STR`, `MACHINE_PDA_STR`, `RPC`, `EXPLORER`
4. Use same trait arrays: `FLAVORS`, `COLORS`, `RARITY`, `SPECIALS`, `BALL_COLORS`

---

## Files Overview

| File | Purpose |
|---|---|
| `programs/gumball_nft/src/lib.rs` | Anchor smart contract (mint, burn, marketplace) |
| `scripts/oracle.cjs` | Commit-reveal oracle (Node.js, encrypted secrets) |
| `scripts/monitor.cjs` | Telegram monitoring bot + remote commands |
| `scripts/initialize.cjs` | Machine init / migration script |
| `server.cjs` | Express server for Railway deployment + faucet API |
| `landing.html` | Project homepage with live mint counter |
| `index.html` | Main frontend (mint + collection + burns) |
| `marketplace.html` | Marketplace (list, buy, sell, offers, 5% royalty) |
| `activity.html` | Activity feed + collection analytics |
| `leaderboard.html` | Leaderboard (top holders, rarity breakdown) |
| `verify.html` | Provably fair verification page (auto-verifies v5 gumballs) |
| `faucet.html` | Testnet XNT faucet (0.1 XNT per wallet per 24h) |
| `favicon.svg` | SVG gumball icon for browser tabs |
| `ecosystem.config.cjs` | PM2 config for oracle + monitor |
| `.env` | Secrets (Telegram token, encryption key, faucet wallet) — gitignored |
| `faucet-wallet.json` | Faucet wallet keypair — gitignored |
| `NOTES.md` | Technical decisions and architecture notes |
| `DEPLOY.md` | Server deployment checklist |
| `setup.sh` | Automated server setup script |

---

## What NOT to do

- **Never commit** `oracle-secrets.json`, `oracle-wallet.json`, `faucet-wallet.json`, `*.pem`, `.env`, `target/`
- **Never add SVG back inline** to `GumballData` — it will cause heap OOM in burns
- **Never change GumballData struct** without adding a new dataSize filter for the new size
- **Never call `.close()`** manually on Anchor accounts that have `close = X` in struct
- **Never use `Box<Account<'info, GumballData>>`** in burn instruction structs — use `UncheckedAccount` and validate manually
- **Never deploy** without running `anchor build` first and checking for errors
- **Never use `exec()`** in monitor/scripts for shell commands — use `execFile()` with array args
- **Never use `.unwrap()`** on raw account data slices — use `.map_err()` with `InvalidAccount`
- **Never hardcode** wallet paths — use `os.homedir()` or env vars

---

## Environment

```bash
# Run oracle
node scripts/oracle.cjs
# or via PM2
pm2 start ecosystem.config.cjs && pm2 save

# Serve frontend (HTTPS required for wallet)
npx serve . -p 3001 --ssl-cert localhost.pem --ssl-key localhost-key.pem

# Build and deploy
anchor build
anchor deploy --provider.cluster https://rpc.testnet.x1.xyz --provider.wallet ~/.config/solana/id.json

# Migrate machine (after Machine struct changes only)
node scripts/initialize.cjs --migrate
```

---

## Changelog

Each entry documents what changed, which files were affected, and why the change was made.

---

### [2026-04-05] GumballData refactor — separate SVG PDA

**Files:** `lib.rs`, `oracle.cjs`, `index.html`, `leaderboard.html`

**What:** Removed `svg: Vec<u8>` from `GumballData` struct and moved it into a new
`GumballSvg` PDA keyed by `[b"svg", mint.key()]`. Added `gumball_svg` account to
`RevealAndMint`, `BurnToUpgrade`, and `BurnMulti` instruction structs. Updated oracle
to derive and pass the `GumballSvg` PDA. Updated frontend to fetch SVG lazily from
the separate PDA when a user opens the modal.

**Why:** Burn instructions load 3–5 GumballData accounts simultaneously. With inline SVG
(~865 bytes each), this caused heap overflow (OOM) at ~5K compute units before any logic
ran. Separating the SVG shrinks GumballData to 93 bytes, making burns fast and reliable.
The SVG is still 100% on-chain — just in a sibling PDA.

---

### [2026-04-05] BurnToUpgrade / BurnMulti — UncheckedAccount fix

**Files:** `lib.rs`

**What:** Changed `gumball_a` and `gumball_b` in `BurnToUpgrade`, and `gumball_a` in
`BurnMulti` from `Box<Account<'info, GumballData>>` to `UncheckedAccount<'info>`.
Added manual validation of owner, rarity, and machine fields by reading raw bytes.
Replaced `close = burner` Anchor attribute with manual lamport transfer.

**Why:** Even with `Box<>`, Anchor still fully deserializes `GumballData` into heap
during account validation. With large accounts this caused OOM. `UncheckedAccount`
skips auto-deserialization — we borrow the raw data only when needed, keeping heap usage
minimal.

---

### [2026-04-05] refund_mint instruction

**Files:** `lib.rs`, `index.html`

**What:** Added `refund_mint` instruction that lets users reclaim XNT after the oracle
fails to reveal within 5 minutes. Removed `treasury` from `RefundMint` accounts struct.
Fixed instruction body to return lamports from the `MintRequest` PDA directly (not from
treasury). Added **💸 CLAIM MINT REFUND** button in frontend that appears automatically
after 5 minutes.

**Why:** The payment is locked in the `MintRequest` PDA at `request_mint` time — NOT sent
to treasury. Earlier implementation tried to debit treasury which failed with
`instruction spent from the balance of an account it does not own`.

---

### [2026-04-05] reclaim_burned instruction

**Files:** `lib.rs`, `index.html`

**What:** Added `reclaim_burned` instruction that closes zombie GumballData PDAs left by
`burn_multi`. Burn instructions zero the owner field instead of closing extra accounts
(to avoid `UnbalancedInstruction`). Added **♻ RECLAIM BURN RENT** button in frontend
that batches all zombie PDAs into one transaction.

**Why:** `burn_multi` zeros owner bytes on extra PDAs rather than closing them (direct
lamport manipulation of `remaining_accounts` causes `UnbalancedInstruction`). This leaves
orphaned PDAs holding ~0.009 SOL each. `reclaim_burned` allows recovery of that rent.

---

### [2026-04-05] Multi-mint batch — 1 wallet approval for N mints

**Files:** `lib.rs`, `oracle.cjs`, `index.html`

**What:** Updated `request_mint` to accept `quantity: u8` (up to 10). Oracle loops through
N reveals for the same request, decrementing `remaining_quantity` each time. Frontend
takes a snapshot of existing accounts before sending the request, then polls for new
accounts after. Fixed `paid_amount / quantity` division bug that caused overflow on
subsequent reveals.

**Why:** Previously each mint required a separate wallet approval. With batch minting,
1 approval locks XNT for all N mints and the oracle fulfills them sequentially.

---

### [2026-04-05] verify.html — provably fair verification page

**Files:** `verify.html`, `index.html`, `leaderboard.html`

**What:** Created `verify.html` allowing anyone to verify a gumball's provable fairness
by serial number or PDA address. Shows 5 verification steps: traits on-chain, oracle
identity (checked via Machine PDA), commitment PDA, full hash verification (coming soon),
and open source program. Page URL includes serial number for sharing
(`verify.html?serial=42`).

**Why:** Non-technical users need a simple way to verify fairness without understanding
hash functions. The oracle identity step checks the Machine PDA directly (not TX parsing)
because X1 RPC doesn't reliably return full transaction account keys.

---

### [2026-04-05] Leaderboard improvements

**Files:** `leaderboard.html`

**What:** Added `dataSize` filter to `getProgramAccounts` call (was fetching all program
accounts including MintRequest and OracleCommit). Fixed Machine PDA offset for
`total_minted` (was off by 32 bytes — missing oracle pubkey field). Added `circulating`
stat, auto-refresh every 60 seconds, last-updated timestamp. Fixed burned count to read
from `total_burned` in Machine state rather than inferring from account count.

**Why:** Without `dataSize` filter the leaderboard fetched every program account and
filtered client-side — very slow. Wrong offset showed incorrect minted count. Burned count
was wrong because it counted missing PDAs rather than reading on-chain state.

---

### [2026-04-05] Collection display — gradient ID collision fix

**Files:** `index.html`

**What:** Added unique suffix to SVG gradient IDs when rendering collection cards
(`id="b"` → `id="b_g42"`). Rewrote SVG rendering to strip the outer `<svg>` tag and
re-wrap with a controlled viewBox (`0 0 300 248`) to clip the text bar at the bottom
of each on-chain SVG.

**Why:** HTML document IDs must be unique. All on-chain SVGs use `id="b"` for their
radial gradient. When multiple SVGs rendered on the same page, they all referenced the
first gradient — showing the same gray color for every gumball.

---

### [2026-04-05] Burn heap OOM — root cause and fix history

**Files:** `lib.rs`

**What:** Three separate attempts before the final fix:
1. Removed `assign()` + `realloc()` calls → still OOM
2. Changed lamport zeroing to owner-field zeroing → still OOM  
3. Removed `close = burner` from struct, added manual lamport transfer → still OOM
4. **Final fix:** `UncheckedAccount` + separate SVG PDA → resolved

**Why:** Each attempt addressed a symptom. The real cause was account size. Even
`Box<Account<'info, GumballData>>` deserializes the full struct into heap. The only
solution was shrinking GumballData itself.

---

### [2026-04-05] Oracle secret persistence + startup scan

**Files:** `oracle.cjs`

**What:** Added `oracle-secrets.json` persistence for commitment secrets. On startup,
oracle scans for all pending (unfulfilled) MintRequest accounts from previous sessions
and fulfills them using the stored secrets. Secrets are saved after each commitment
submission.

**Why:** If the oracle restarts between `submit_commitment` and `reveal_and_mint`, the
secret is lost and the commitment can never be fulfilled — user's XNT is stuck until
the 5-minute timeout. Persistence allows recovery across restarts.

---

### [2026-04-05] PM2 oracle process management

**Files:** `ecosystem.config.cjs`

**What:** Added PM2 configuration for the oracle with auto-restart on crash,
3-second restart delay, 200MB memory limit, and log rotation to `logs/` directory.

**Why:** Without PM2, if the oracle crashes (RPC timeout, network issue, etc.) mints
are stuck until someone manually restarts it. PM2 brings it back automatically within
seconds.

---

### [2026-04-05] GumballData v4 — proof fields for verify.html

**Files:** `lib.rs`, `index.html`, `leaderboard.html`, `verify.html`

**What:** Added `commitment_hash: [u8; 32]` and `user_seed: [u8; 32]` to GumballData
struct (LEN: 85 → 149, on-chain: 93 → 157 bytes). `reveal_and_mint` stores the oracle
commitment and user seed into each gumball. `burn_to_upgrade` and `burn_multi` set both
fields to zeros (upgrades have no commit-reveal). Frontend updated with `GD_V4 = 157`
filter across all pages. `verify.html` upgraded with full interactive hash verification:
reads proof fields from v4 accounts, lets users paste oracle secret, computes
`sha256(secret + oracle_pubkey)` client-side, and verifies it matches stored commitment.

**Why:** verify.html previously showed "COMING SOON" for hash verification because the
commitment hash and user seed were only stored in ephemeral MintRequest/OracleCommit PDAs.
By persisting them in GumballData, anyone can independently verify fairness at any time
without needing to parse transaction history.

**Note:** `update_owner` uses typed `Account<'info, GumballData>` deserialization, so it
only works on v4 gumballs (157 bytes) after redeployment. Pre-v4 gumballs will fail
Anchor deserialization. This is acceptable for testnet; for mainnet, consider switching
`update_owner` to `UncheckedAccount` if backward compat is needed.

---

### [2026-04-05] Exponential dynamic mint pricing

**Files:** `lib.rs`, `index.html`

**What:** Replaced fixed `MINT_PRICE` (0.25 XNT) with exponential curve:
`price = 0.01 * 4^(total_minted / 10000)` XNT. Price starts at 0.01 XNT (mint #1)
and reaches 0.04 XNT (mint #10,000). Uses 11-point lookup table with linear
interpolation — no floating point on-chain. `request_mint` sums per-mint prices
for batch mints. Frontend mirrors the formula in JS and updates price display
live from `total_minted` in Machine PDA. `machine.mint_price` field still exists
but is unused by the dynamic curve — kept for backward compat with `set_mint_price`.

**Why:** Flat pricing undervalues later mints when supply is scarce. Exponential curve
rewards early minters with cheap prices while capturing more revenue as demand proves
itself. Testnet pricing set low (0.01 XNT) for easy testing.

**Price curve (testnet):**
| Mint # | Price |
|---|---|
| 1 | 0.01 XNT |
| 2,500 | 0.014 XNT |
| 5,000 | 0.02 XNT |
| 7,500 | 0.028 XNT |
| 10,000 | 0.04 XNT |

---

### [2026-04-05] Upgrade fee on burn-to-upgrade

**Files:** `lib.rs`, `index.html`

**What:** Added upgrade fee to `burn_to_upgrade` and `burn_multi` instructions. Fee equals
the current dynamic mint price (`get_mint_price(total_minted)`), transferred from burner to
treasury via CPI. Added `treasury` account (validated against `machine.treasury`) to both
`BurnToUpgrade` and `BurnMulti` account structs. Frontend updated to pass treasury key and
display the fee on upgrade cards and status messages.

**Why:** Burns were free — users paid for original mints but upgrades created new NFTs at no
cost. Upgrade fee = current mint price means the user pays the same as minting fresh but gets
a guaranteed rarity increase. This adds revenue without punishing holders (they still benefit
from guaranteed outcomes vs random mint odds).

---

### [2026-04-05] Audit fixes — rounds 1-3

**Files:** `lib.rs`, `scripts/oracle.cjs`, `scripts/monitor.cjs`

**What (Round 1):**
- Payment division fix: last mint in batch sweeps all remaining lamports above rent
  instead of dividing evenly (avoids rounding dust with dynamic pricing)
- Oracle secret encryption: AES-256-GCM via `ORACLE_ENCRYPTION_KEY` env var, backward
  compatible with legacy plaintext format
- Bounds checks: all `.unwrap()` on raw account data replaced with `.map_err(InvalidAccount)`

**What (Round 2):**
- Command injection fix: `exec()` replaced with `execFile()` + action whitelist in monitor
- Double refund fix: `reveal_and_mint` timeout path sets `fulfilled = true` before returning

**What (Round 3):**
- Seed derivation `.unwrap()` replaced with `.map_err(InvalidSlotHash)` in reveal_and_mint
  and burn_multi
- Slot hash `.unwrap_or([42u8])` silent fallbacks replaced with `.map_err(InvalidSlotHash)`
  in burn_to_upgrade and burn_multi
- Rent sweep validation: `require!(sweep > 0)` on last-mint treasury forward
- Integer overflow protection: `checked_mul(10)` in `get_mint_price()`

**Why:** Three rounds of security audit identified panic paths, silent fallbacks, rounding
edge cases, and injection vectors. All findings fixed and verified.

---

### [2026-04-05] Auto rent reclaim on burns

**Files:** `lib.rs`

**What:** `burn_to_upgrade` and `burn_multi` now zero data and return rent from ALL burned
gumball PDAs directly to the burner. No more zombie PDAs requiring separate `reclaim_burned`
calls. `reclaim_burned` instruction kept for legacy testnet zombies only.

**Why:** Users had to manually call `reclaim_burned` to recover rent from extra PDAs left by
`burn_multi`. This was confusing UX. Auto-reclaim eliminates the extra step.

---

### [2026-04-05] Telegram oracle monitoring

**Files:** `scripts/monitor.cjs`, `ecosystem.config.cjs`, `.env`

**What:** Added Telegram bot that monitors oracle health and accepts remote commands.
Alerts: oracle down/recovered, mint request expiring (<60s to timeout), low oracle
balance (<0.5 XNT). Commands: `/status`, `/restart`, `/stop`, `/balance`, `/help`.
Only authorized chat ID can issue commands. Uses `execFile()` with action whitelist
(no shell injection). Runs as separate PM2 process (`gumball-monitor`).

**Why:** Oracle downtime means mints aren't fulfilled. Users can refund after 5 min,
but operator needs to know immediately. Remote restart via Telegram avoids SSH.

---

### [2026-04-05] MED-4 fix — standardize slot hash entropy

**Files:** `lib.rs`

**What:** Changed `burn_to_upgrade` from `slot_hash_data[8..16]` (8-byte slot number)
to `slot_hash_data[16..48]` (32-byte hash) with `hashv()` context mixing. Now matches
`burn_multi` and `reveal_and_mint`. All slot hash usage is consistent across the program.

**Why:** 8-byte slot number is weaker entropy than 32-byte hash. While only cosmetic
traits (flavor/color/special) are affected (rarity is guaranteed), consistent entropy
prevents grinding for specific cosmetic combos on upgrades.

---

### [2026-04-05] Remove reclaim_burned instruction

**Files:** `lib.rs`, `index.html`

**What:** Removed `reclaim_burned` instruction and `ReclaimBurned` accounts struct from
the smart contract. Removed zombie PDA scanning, reclaim button, and `reclaimBurned()`
function from frontend.

**Why:** Burns now auto-reclaim rent in the same transaction (lamports returned + data
zeroed). No zombie PDAs are created. `reclaim_burned` was only needed for legacy testnet
zombies and had an authorization gap (anyone could claim rent, not just the original
burner). Removing it eliminates the attack surface for mainnet.

---

### [2026-04-05] Final audit — round 5

**Status:** CLEAN — A- grade, mainnet ready.

5 rounds of security audit completed. All 17 findings resolved. No remaining
vulnerabilities. Verified: access control, arithmetic safety, commit-reveal
randomness, payment handling, secrets management, frontend security, oracle
implementation, monitoring, and file protection.

---

### [2026-04-12] Testnet mint price lowered to 0.01 XNT

**Files:** `lib.rs`, `index.html`, `landing.html`, `activity.html`, `initialize.cjs`

**What:** Changed `BASE_PRICE` from 250,000,000 (0.25 XNT) to 10,000,000 (0.01 XNT)
and `MAX_PRICE` from 1,000,000,000 (1.00 XNT) to 40,000,000 (0.04 XNT). Updated all
frontend display values, JS pricing functions, and initialize script to match.

**Why:** Testnet faucet provides 0.1 XNT per request. At 0.25 XNT per mint, users
couldn't even mint once. At 0.01 XNT, a single faucet request funds 10 mints.

---

### [2026-04-12] GumballData v5 — oracle_secret on-chain

**Files:** `lib.rs`, `index.html`, `leaderboard.html`, `activity.html`, `marketplace.html`, `verify.html`

**What:** Added `oracle_secret: [u8; 32]` to GumballData struct (LEN: 149 → 181,
on-chain: 157 → 189 bytes). `reveal_and_mint` stores the revealed oracle secret
directly in the gumball. Burns set it to zeros. Frontend updated with `GD_V5 = 189`
filter across all pages. `verify.html` now auto-verifies v5 gumballs — reads the
oracle secret from on-chain data and computes `sha256(secret + oracle_pubkey)` to
verify against the stored commitment hash. No user input needed.

**Why:** The v4 verify page required users to paste the oracle secret manually, but
regular users had no way to obtain it. The secret is already revealed to the contract
during `reveal_and_mint` and is no longer sensitive after that. Storing it on-chain
enables fully trustless, automatic verification with zero external dependencies.

---

### [2026-04-12] Testnet faucet

**Files:** `server.cjs`, `faucet.html`, all nav pages

**What:** Added `POST /api/faucet` endpoint to `server.cjs` that sends 0.1 XNT from
a dedicated faucet wallet. Rate limited to one request per wallet address per 24 hours.
Validates pubkey format, checks faucet balance before sending. Created `faucet.html`
page matching site style. Added `[ FAUCET ]` nav link to all pages. Faucet uses a
separate wallet from the oracle (`FAUCET_WALLET` or `FAUCET_WALLET_KEY` env var).

**Why:** X1 testnet does not support `requestAirdrop` via RPC. Users need free testnet
XNT to try minting. A dedicated faucet wallet prevents draining the oracle's funds.

**Faucet wallet:** `BW74FxoPQua2WRMB2hXXK4EegPpXFjEKoPoD38XY9iDJ`

---

### [2026-04-26] Phase 2 XNT fee-sharing audit fixes (CRIT-1/2/3, HIGH-1/2/3, MED-3)

**Files:** `lib.rs`, `scripts/init-staking.cjs`, `staking.html`

**What:** (Retroactive entry for commit `edb3db7`.) Audit fixes for the XNT fee-sharing
system: CRIT-1 reserve the pool PDAs' rent-exempt minimum on every payout (prevents
tombstoning); CRIT-2 seed `last_seen_balance` with the pool's initial rent balance in
`initialize_xnt_fees`; CRIT-3 snapshot per-position `XntDebt` at stake-time and detect
first-touch accounts via `bump == 0` so historical accumulator value is never credited
to new positions; HIGH-1 advance the XNT accumulator with the OLD total weight before
any weight change in stake/unstake/stake_lp/unstake_lp (new required accounts on all
four instructions); HIGH-2 gate `initialize_staking` on `machine.authority`; HIGH-3
re-snapshot `xnt_debt` after partial LP unstake; MED-3 `checked_sub` on total weights.

**Why:** Without these, a fresh staker could capture the entire historical accumulator,
a flash-staker could dilute fees deposited before their stake, anyone could front-run
`initialize_staking`, and a sole claimer could drain a pool PDA below rent exemption
and brick every fee instruction.

---

### [2026-07-03] XNT fee-sharing hardening — settle helper, rent-leak close, admin sweep

**Files:** `lib.rs`, `staking.html`, `scripts/test-stake.cjs`, `scripts/test-lp-stake.cjs`,
`scripts/test-unstake-lp.cjs`, `scripts/sweep-xnt-pool.cjs` (new)

**What:** Follow-up review of `edb3db7` found silent value-loss edges and duplication:

- **Shared `settle_xnt_fees` helper** replaces the four near-identical settle blocks
  (unstake, unstake_lp, claim_xnt_fees_nft, claim_xnt_fees_lp). Debt now advances by
  ONLY the amount actually paid, so a remainder the pool can't cover stays pending
  instead of being silently forfeited. `advance_xnt_for_stake` unifies the HIGH-1
  pre-stake sequence (zero-weight absorb + accumulator update) for stake/stake_lp.
- **Loud claim failures:** standalone claims now error with `InsufficientFunds` when
  pending exists but the pool can't pay any of it (was a silent `Ok` after `edb3db7`),
  restoring a user-visible signal. Partial payments succeed and preserve the remainder.
- **XntDebt PDAs are closed** (rent refunded) on NFT unstake and full LP unstake —
  previously every LP cycle permanently orphaned ~0.001 XNT of staker rent in a PDA
  keyed by the burned position mint.
- **`sweep_xnt_pool_nft` / `sweep_xnt_pool_lp`** admin instructions (authority =
  `machine.authority`, only when the stream's total weight is 0): recover unattributed
  pool lamports (zero-staker deposits, legacy forfeits, rounding dust) to treasury and
  re-baseline `last_seen`. Previously those lamports were stranded in the pool forever.
  Run via `node scripts/sweep-xnt-pool.cjs [nft|lp]`.
- **Read-only pools in stake paths:** dropped `mut` on `nft_xnt_pool`/`lp_xnt_pool` in
  `StakeNft`/`StakeLp` (only read for the accumulator); frontend passes them read-only.
  `StakeLp.xnt_debt` is plain `init` (position_mint is always a fresh keypair).
- **Test scripts fixed:** `test-stake.cjs`, `test-lp-stake.cjs`, `test-unstake-lp.cjs`
  now pass the XNT accounts added in `edb3db7`. (`e2e-test.cjs` and
  `unstake-all-nft.cjs` still target the legacy v1 staking layout and were already
  incompatible before `edb3db7`.)

**Why:** The `edb3db7` fixes closed the exploits but introduced accounting edges where
users' XNT silently vanished (partial payouts, legacy first-touch, zero-staker periods)
with no recovery path, plus a per-LP-cycle rent leak. Known accepted tradeoff: positions
staked before `edb3db7` still forfeit their accrued share on first touch (their stake-time
accumulator was never recorded, so any credit would be exploitable); the forfeited lamports
are now at least recoverable to treasury via the sweep.

**Deploy note:** `initialize_xnt_fees` MUST be run (scripts/init-xnt-fees.cjs) before any
stake/unstake on a fresh Program ID — all four staking instructions now require the XNT
PDAs to exist.

---

### [2026-07-03] Phase 3 early-mint bonus + faucet hardening + announcer

**Files:** `lib.rs`, `staking.html`, `server.cjs`, `faucet.html`, `scripts/announcer.cjs` (new),
`ecosystem.config.cjs`, `scripts/make-localnet-fixtures.cjs`, `scripts/validate-staking-localnet.cjs`

**What:**
- **Phase 3 bonus:** `stake_weight(rarity, serial)` boosts NFT stake weight up to +50%
  for serial #1, decaying linearly to +0% at #10,000. Applied at stake-time only and
  cached in `StakeAccount.weight`, so unstake subtracts exactly what was added (no
  drift for existing positions, which keep their un-boosted weight until re-staked).
  Frontend analytics now read the on-chain weight instead of re-deriving from rarity.
  Validation suite extended to 22 checks (fixture gumball is serial 100 → weight 70).
- **Faucet:** cooldowns + per-IP log persist to `faucet-state.json` (FAUCET_STATE_FILE);
  per-IP cap (FAUCET_IP_LIMIT, default 3/24h); optional Cloudflare Turnstile captcha
  when TURNSTILE_SITE_KEY/SECRET_KEY are set (widget served conditionally via
  /api/faucet-config). `trust proxy` enabled for real IPs behind Railway.
- **Announcer:** `scripts/announcer.cjs` polls program signatures, decodes
  GumballMinted/Upgraded/Sold events from Program-data logs, and posts to a public
  Telegram channel (TELEGRAM_ANNOUNCE_CHAT). Runs as `gumball-announcer` in PM2;
  exits cleanly when unconfigured (stop_exit_codes: [0]).

**Why:** Rewards early minters with boosted staking yield (field was reserved since
Phase 1); closes the faucet wallet-cycling loophole and restart-reset bug; turns the
already-emitted on-chain events into free community visibility.

