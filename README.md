# Gumball Machine NFT — X1

A fully on-chain NFT gumball machine built on Solana/X1. Each NFT is a unique SVG gumball with randomized traits, generated and verified entirely on-chain via a commit-reveal oracle.

**Security Grade: A-** — 5 rounds of audit, all findings resolved.

---

## Deployed Contracts

| | Address |
|---|---|
| **Program ID** | `Bsbc5gd22aRWHgHGJXwNugHHHDAR6Q2Hmoj1xB88QmKK` |
| **Machine PDA** | `AV8PXFSuVuZaYSBuVf2qcqF9TKfThRJaiUg4U2MVRWcj` |
| **Network** | X1 Testnet (`https://rpc.testnet.x1.xyz`) |
| **Explorer** | `https://explorer.testnet.x1.xyz` |
| **Mint Price** | 0.25 – 1.00 XNT (exponential curve) |
| **Max Supply** | 10,000 |
| **Max Per Tx** | 10 mints per transaction |
| **Mint Timeout** | 300 seconds (5 min) before refund eligible |

---

## Oracle Transparency

Randomness is generated via a **commit-reveal scheme**:

1. Oracle generates a random secret off-chain
2. Oracle submits `sha256(secret || oracle_pubkey)` on-chain before any mint request
3. User pays and locks the commitment with a random `user_seed` (unknown to oracle)
4. Oracle reveals the secret — contract derives traits from `sha256(secret || slot_hash || user_seed || mint_index)`

The oracle cannot predict or manipulate outcomes: slot hash (32 bytes) is unknown at commit time, user seed is unknown until after commit is submitted.

| | |
|---|---|
| **Oracle wallet** | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` |

---

## Trait System

| Trait | Options | Notes |
|---|---|---|
| **Flavor** | 20 (Cherry, Grape, Watermelon, Blueberry...) | |
| **Color** | 12 (Cherry Red, Grape Purple, Rose Gold...) | |
| **Special** | None, Glitter, Double Bubble, Holographic, Crystal | |
| **Rarity** | Common / Uncommon / Rare / Epic / Legendary | Weighted random |

### Rarity Odds

| Rarity | Drop Rate | Score Weight |
|---|---|---|
| Common | 60% | 1 pt |
| Uncommon | 25% | 4 pt |
| Rare | 10% | 10 pt |
| Epic | 4% | 40 pt |
| Legendary | 1% | 100 pt |

---

## Burn to Upgrade

All four upgrade paths are fully implemented and tested:

| From | To | Burns Required | Instruction |
|---|---|---|---|
| Common | Uncommon | 5 | `burn_multi` |
| Uncommon | Rare | 3 | `burn_multi` |
| Rare | Epic | 2 | `burn_to_upgrade` |
| Epic | Legendary | 2 | `burn_to_upgrade` |

Each upgrade charges an **upgrade fee** equal to the current dynamic mint price, sent to treasury. Upgrading costs the same as minting a new NFT — but you get a **guaranteed** rarity increase instead of random odds.

Burned PDAs auto-reclaim rent to the burner immediately. No zombie PDAs.

Burns are blocked once `total_minted >= max_supply` — no new serial numbers can be issued when sold out.

---

## Instructions

| Instruction | Caller | Description |
|---|---|---|
| `initialize_machine` | Admin | Set up the gumball machine |
| `set_active` | Admin | Enable/disable minting |
| `set_oracle` | Admin | Rotate oracle wallet |
| `set_mint_price` | Admin | Update base mint price |
| `withdraw` | Admin | Withdraw treasury funds |
| `migrate_machine` | Admin | Migrate machine account to new struct size |
| `submit_commitment` | Oracle | Submit randomness commitment pre-mint |
| `request_mint` | User | Pay and lock 1-10 mints in one transaction |
| `reveal_and_mint` | Oracle | Reveal secret and mint NFT (loops for multi-mint) |
| `refund_mint` | User | Reclaim XNT after oracle timeout (5 min) |
| `burn_to_upgrade` | User | Burn 2 gumballs + fee (Rare to Epic or Epic to Legendary) |
| `burn_multi` | User | Burn 3-5 gumballs + fee (Common to Uncommon or Uncommon to Rare) |
| `update_owner` | Anyone | Sync gumball owner to current token holder after trade |

---

## Security Audit Status

5 rounds of security audit completed. All findings resolved.

| ID | Issue | Severity | Status |
|---|---|---|---|
| C-1 | Free upgrade exploit — no PDA seed constraints | Critical | Fixed |
| C-2 | Oracle randomness manipulation | Critical | Fixed (commit-reveal) |
| C-3 | Oracle brute-force user seed at reveal | Critical | Fixed (user seed mixed post-commit) |
| M-1 | Oracle pubkey hardcoded | Medium | Fixed (rotatable via set_oracle) |
| M-2 | No mint timeout / stuck funds | Medium | Fixed (5 min timeout + refund_mint) |
| H-2 | Traded NFTs non-upgradeable | High | Fixed (update_owner) |
| H-4 | Raw lamport manipulation | High | Fixed |
| A-1 | Payment division rounding in batch mints | High | Fixed (last mint sweeps remainder) |
| A-2 | Oracle secrets stored in plaintext | High | Fixed (AES-256-GCM encryption) |
| A-3 | Double refund via reveal_and_mint timeout | Medium | Fixed (sets fulfilled = true) |
| A-4 | Missing bounds checks in burn instructions | Medium | Fixed (InvalidAccount error) |
| A-5 | Command injection in monitor script | Critical | Fixed (execFile + whitelist) |
| A-6 | Unsafe .unwrap() in seed derivation | Critical | Fixed (.map_err) |
| A-7 | Silent slot hash fallback in burns | High | Fixed (error on failure) |
| A-8 | Rent sweep returns 0 on insufficient lamports | High | Fixed (require > 0) |
| A-9 | Unchecked integer multiply in pricing | High | Fixed (checked_mul) |
| MED-4 | Inconsistent slot hash entropy in burn_to_upgrade | Medium | Fixed (32-byte hash) |

**Final audit: CLEAN — A- grade, mainnet ready.**

---

## Running the Oracle

The oracle persists secrets (AES-256-GCM encrypted) to `oracle-secrets.json` and recovers pending requests on restart. It auto-submits a new commitment after each fulfilled batch.

```bash
# Run directly
node scripts/oracle.cjs

# Run with PM2 (auto-restart on crash)
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs gumball-oracle
pm2 status
```

Logs are written to `logs/oracle-out.log` and `logs/oracle-error.log`.

### Telegram Monitoring

A monitoring bot runs alongside the oracle and sends alerts to Telegram:

| Alert | Trigger |
|---|---|
| Oracle down | PM2 status changes from online to stopped/errored |
| Oracle recovered | Comes back online after being down |
| Mint request expiring | Unfulfilled request < 60s from 5-min timeout |
| Low oracle balance | Oracle wallet below 0.5 XNT |

Telegram commands:

| Command | Description |
|---|---|
| `/status` | Oracle status, balance, pending requests, total minted/burned |
| `/restart` | Restart the oracle process |
| `/stop` | Stop the oracle process |
| `/balance` | Check oracle wallet balance |
| `/help` | Show available commands |

Setup: create a Telegram bot via @BotFather, add `TELEGRAM_TOKEN` and `TELEGRAM_CHAT` to `.env`, then start the monitor via PM2.

### Environment Variables

Create a `.env` file (gitignored) with:

```
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_CHAT=your_chat_id
ORACLE_ENCRYPTION_KEY=your_256bit_hex_key
```

Generate an encryption key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Load env before starting: `export $(cat .env | xargs) && pm2 start ecosystem.config.cjs`

---

## Development

```bash
# Build and deploy
anchor build
anchor deploy --provider.cluster https://rpc.testnet.x1.xyz --provider.wallet ~/.config/solana/id.json

# Initialize machine (first time only)
node scripts/initialize.cjs

# Migrate machine account (after Machine struct changes)
node scripts/initialize.cjs --migrate
```

---

## Frontend

Serve `index.html` over HTTPS — required for wallet connections:

```bash
# Install mkcert (one time)
mkcert -install && mkcert localhost

# Serve with HTTPS
npx serve . -p 3001 --ssl-cert localhost.pem --ssl-key localhost-key.pem
```

Open `https://localhost:3001` and connect your X1 Wallet or Phantom.

### Features

- Batch minting — up to 10 NFTs with a single wallet approval
- Dynamic pricing — live price display updates from on-chain state
- Live collection — on-chain SVG rendering with rarity-colored borders
- Rarity filters — filter by Common / Uncommon / Rare / Epic / Legendary
- Burn to upgrade — all 4 upgrade paths with upgrade fee display and pre-simulation
- Automatic rent reclaim — burned PDAs return rent to burner immediately
- Refund expired — claim XNT back if oracle was down during your mint
- Oracle countdown — live timer showing mint request timeout
- Leaderboard — top holders, rarity distribution, auto-refreshes every 60s
- Provably fair verification — verify.html with on-chain proof fields

---

## Supply and Economics

- Total supply: 10,000 hard cap enforced on-chain
- Treasury: all mint + upgrade fee proceeds sent to treasury wallet, withdrawable by admin
- Burns: reduce circulating supply; total_burned tracked on-chain
- Upgrades: consume input tokens + upgrade fee, mint new serial at higher rarity; blocked at max supply

### Dynamic Mint Pricing

Mint price follows an exponential curve: `price = 0.25 * 4^(total_minted / 10,000)` XNT.

Early minters pay less. Price increases as supply fills up.

| Mint # | Price |
|---|---|
| 1 | 0.2500 XNT |
| 1,000 | 0.2872 XNT |
| 2,500 | 0.3536 XNT |
| 5,000 | 0.5000 XNT |
| 7,500 | 0.7071 XNT |
| 9,000 | 0.8706 XNT |
| 10,000 | 1.0000 XNT |

Batch mints (up to 10) sum each mint's individual price. Upgrade fees also follow this curve.

Total projected revenue at full sellout: **~4,080 XNT** from mints + upgrade fees.

---

## Verification

Visit `verify.html?serial=42` to independently verify any gumball's provable fairness.

For v4 gumballs, the commitment hash and user seed are stored on-chain. Anyone can paste the oracle secret to confirm `sha256(secret + oracle_pubkey)` matches the stored commitment — proving the oracle could not have manipulated the outcome.

---

## Architecture

```
GumballData  seeds: [b"gumball", mint.key()]  — 157 bytes (v4, traits + proof fields)
GumballSvg   seeds: [b"svg", mint.key()]       — 788 bytes (on-chain SVG artwork)
```

SVG is stored in a separate PDA to keep GumballData lean for burn instructions (32KB SBF heap limit). Burns load 3-5 GumballData accounts simultaneously — at 157 bytes each, well within limits.

---

## Known Limitations

- Oracle must be running for mints to fulfill — PM2 auto-restarts on crash, Telegram monitor alerts if down. Users can reclaim XNT via refund after 5 minutes
- `update_owner` only works on v4 gumballs (157 bytes) — not an issue on mainnet (fresh deploy, all v4)
- Oracle can choose when to reveal within the 5-min window (slot timing), but cannot predict or control traits (slot hash + user seed are unknown at commit time)

---

## Files

| File | Purpose |
|---|---|
| `programs/gumball_nft/src/lib.rs` | Anchor smart contract |
| `scripts/oracle.cjs` | Commit-reveal oracle (encrypted secrets) |
| `scripts/monitor.cjs` | Telegram monitoring + remote commands |
| `scripts/initialize.cjs` | Machine init / migration script |
| `index.html` | Main frontend (mint + collection + burns) |
| `leaderboard.html` | Leaderboard (top holders, rarity breakdown) |
| `verify.html` | Provably fair verification page |
| `ecosystem.config.cjs` | PM2 config for oracle + monitor |
| `setup.sh` | Automated server setup script |
| `DEPLOY.md` | Server deployment checklist |
| `NOTES.md` | Technical architecture notes |
| `CLAUDE.md` | Development context and changelog |
