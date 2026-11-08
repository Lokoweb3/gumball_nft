# Gumball Machine NFT — Mainnet Deployment Checklist

This is the go-live runbook. It is ordered: each phase assumes the one before
it is done. Testnet state today: program `AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy`,
frontend on Railway, oracle forked by `server.cjs`.

Tick every box in Phase 0 before spending a single lamport on mainnet.

---

## Phase 0 — Blockers (do not deploy with any of these open)

### 0.1 One hot key holds everything  ← C1, the headline risk
Verified on chain: **one** key, `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`
(`~/.config/solana/id.json`), is simultaneously

| role | consequence if the key leaks |
|---|---|
| program upgrade authority | attacker redeploys the program and drains every escrow, pool and stake |
| `machine.authority` | pause/unpause, set oracle, set season, sweep pools |
| `machine.treasury` | receives all revenue |
| `machine.oracle` | signs every reveal — and it is **online 24/7** under PM2 |

The oracle is the one role that *must* be a hot key. The other three must not be.

**Second exposure (2026-11-08): the oracle key `53fT...` is ALSO the X1 mainnet upgrade
authority of a separate program, the TEST vault (`D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW`).**
The gumball oracle is online 24/7, so a leak of that hot key hands over the vault program's code
too. Rotating the gumball oracle off `53fT` is urgent and does not need to wait for the rest of
this checklist: `node scripts/set-oracle.cjs --cluster mainnet --oracle <NEW_ORACLE_PUBKEY>`
(preview by default; `--live` sends it, signed by the machine authority; refuses a wrong-cluster RPC via
a genesis-hash check, and refuses `--live` while any MintRequest is pending unless `--force-pending`).
Then restart the oracle with `ORACLE_WALLET` pointing at the new key. (Upgrade-authority claim for the
TEST vault was read on chain 2026-11-08: X1 mainnet programData 8TwYZi2zFMs1hg5xTHAYyaTyMCp4xR6wUqoCLq5jmFzt, upgrade authority 53fT…RxKy.)

- [ ] Generate a **dedicated oracle keypair** (hot, on the oracle host only, funded with just fees)
- [ ] Generate a **deployer/upgrade keypair** (cold — hardware wallet or offline machine)
- [ ] Create the **multisig** (Squads if deployed on X1 mainnet; otherwise any m-of-n) for admin + treasury
- [ ] Prove the multisig can execute a no-op transaction *before* pointing anything at it
- [ ] Rotate `ORACLE_ENCRYPTION_KEY` (the old `oracle-secrets.json` was web-exposed on testnet)
- [ ] Rotate the SSH key `SHA256:7KRV9+PiDl+sy/gpzjvV6eCEbJ7npW69jI6QiXHiVio` — it was committed to the public repo as `yes`

### 0.2 Pending program changes — one redeploy, frontend and program TOGETHER
These are committed to `main` but **not on chain** yet:

| change | why it matters |
|---|---|
| `buy_gumball(max_price)` / `accept_offer(min_amount)` | closes the delist-relist front-run (H1). **Breaking**: `marketplace.html` now sends the argument — deploy page + program in the same window |
| `accept_offer` CPI reorder | the offer flow was **unusable** (UnbalancedInstruction) on the current binary |
| `withdraw` removed | could never work once treasury ≠ authority |
| `generate_svg` rewrite | −86 % heap allocations on the burn path; golden-tested byte-identical |

- [ ] `cargo test` green (11 passed on 2026-11-08 at security-fixes HEAD 0855f78, incl. the SVG golden test)
- [ ] `bash scripts/ci-e2e.sh` green with the 3.1 Solana tools (LiteSVM 0.7 cannot load 4.3-built binaries). Counts from the lead's run and an independent fresh-clone run on 2026-11-08: staking 35, fairseed 22, legacy refund 15, auction 11+6, init-gate 8
- [ ] marketplace suite guard scenarios report **6025 / 6026** on the fresh build (codes unchanged: new errors were appended, 6027 InvalidLpMint, 6028 SeedSlotNotReached)
- [ ] Verifiable build hash recorded (Phase 3)

### 0.3 Decide the mainnet economics (all in `programs/gumball_nft/src/constants.rs` — need a rebuild)
| constant | testnet value | constants.rs line | decide |
|---|---|---|---|
| `BASE_PRICE` / `MAX_PRICE` | 0.01 → 0.04 XNT | 39–41 | mainnet curve (testnet was set low for the faucet) |
| `MAX_SUPPLY` | 10 000 | 11 | final |
| `MAX_PER_TX` | 10 | 13 | final |
| `MINT_TIMEOUT` | 150 s | 25 | refund window; oracle SLA must beat it |
| `ROYALTY_BPS` + 50/25/25 split | 5 % | 45, 126–128 | final |
| `REROLL_COST_GUM` | 25 GUM | 60 | GUM sink price |
| `EMISSION_BPS_PER_DAY` | 0.3 % | 81 | staking emission |
| `METADATA_BASE_URI` | Railway URL | 65 | **see 0.4** |

### 0.4 Metadata URI is a permanent dependency on one host
`METADATA_BASE_URI` is baked into every NFT's Metaplex metadata and there is
**no instruction to change it** after `attach_metadata`. If that host dies,
every wallet shows a broken image forever.
- [ ] Point it at a domain **you own** (not `*.up.railway.app`) with a plan to keep it up, **or**
- [ ] add an authority-gated `update_metadata_uri` instruction, **or**
- [ ] embed the on-chain SVG as a `data:` URI at attach time (fully on-chain, no host)

### 0.5 Security batch on branch `security-fixes`: FIXED IN CODE, PENDING DEPLOY
None of these is on chain until the program is redeployed (steps in 0.6).

| ID | Issue | Fix in code |
|---|---|---|
| S1 | `reveal_and_mint` could mint past `max_supply` | supply check at reveal; user recovers payment by timeout refund |
| S2 | first caller of `initialize_machine` became `machine.authority` | signer must be the program's upgrade authority |
| S3 | oracle chose the reveal slot | seed = hash of first slot > `request_slot + 2` (REVEAL_DELAY_SLOTS); MintRequest 156 -> 164 bytes; `MINT_TIMEOUT` 150 s; `MintSeedEvent`; verify.html recomputes from it |
| B1 / B2 | `unstake` / `unstake_lp` mint accounts not bound to the stake account | constrained to the stake account |
| B3 | `stake_lp` accepted any mint as LP | only the mint set via `set_lp_mint` (`LpMintConfig` PDA `["lp_mint_config"]`); `stake_lp` takes it as a trailing account |
| L3 | auction `start_price` below rent-exempt minimum froze outbids | `create_auction` requires `start_price >=` rent-exempt minimum for a 0-byte account |
| - | stranded 156-byte requests | `refund_legacy_mint` (permissionless, funds go to the stored minter) |

**Residual risk that remains by design (selective abort):** the oracle can still withhold a
reveal for a request whose outcome it dislikes (it can compute the outcome before revealing).
The user is refunded after `MINT_TIMEOUT` (150 s), so the cost is delay, not loss. Mitigation:
a non-oracle party (monitor, team wallet, or the user) should call `refund_mint` promptly after
the timeout; do not rely on the oracle operator to refund. The oracle can also grind as an
ordinary user with its own wallet and seeds.

### 0.6 Pre-deploy checklist for the security batch (owner runs; order matters)
Use the same RPC and program id for every step (`RPC=<RPC>`, program `<PROGRAM_ID>`).

- [ ] **(a) Drain requests.** `node scripts/admin.cjs --cluster <testnet|mainnet> set-active false` (preview, then
      `--live`; signer = machine authority). Then wait **more than 300 s (allow 6 min)**: until (c) the
      deployed program is the OLD one, whose `MINT_TIMEOUT` is 300 s (strict `>`); the new 150 s applies
      only after (c). The old oracle keeps revealing while you wait, so most requests simply complete.
      Primary path — no old-program refunds needed: anything still unfulfilled is a 156-byte request;
      after (c), refund each with `RPC=<RPC> node scripts/refund-legacy-mints.cjs` (preview) then `--live`
      (sends the NEW program's `refund_legacy_mint`; anyone may send it, funds go to the stored minter).
      Step (e) refuses to resume minting while any 156-byte request is unrefunded, so this can't be skipped.
      164-byte requests only exist after (c); those are refunded with `refund_mint` after 150 s.
      Have a non-oracle party do the refunds; do not wait for the oracle operator.
- [ ] **(b) Scan LP stakes.** Every `lp_stake_v2` account must use the real LP mint (GUM/XNT LP
      `D2bJsDoWVuvykQbMgwFeH7cvuvXZjL2scsjPMVGwNXiV` on testnet; on 2026-11-08 all 14 testnet accounts use it,
      read on chain in this pass). Re-run right before deploy:
      `RPC=<RPC> node -e 'const{Connection,PublicKey}=require("@solana/web3.js");(async()=>{const c=new Connection(process.env.RPC);const a=await c.getProgramAccounts(new PublicKey("<PROGRAM_ID>"),{filters:[{dataSize:140}]});const m={};for(const x of a){const k=new PublicKey(x.account.data.subarray(40,72)).toBase58();m[k]=(m[k]||0)+1}console.log(a.length,m)})()'`
      (`LpStakeAccount` is 140 bytes with the discriminator, `lp_mint` at offset 40.) **Mainnet:** write the real
      mainnet LP mint here before launch; D2bJ… is the testnet value only. `set-lp-mint` cannot tell a real LP
      mint from any other mint, so the value you pass is the check. Any other mint in the
      output means a position staked with a fake mint: stop and investigate before deploy.
- [ ] **(c) Deploy program + oracle + frontend together** (MintRequest grew to 164 bytes; the old oracle
      and frontends cannot read it; `stake_lp` callers must pass the new trailing `lp_mint_config`).
- [ ] **(d) Immediately call `set_lp_mint(<real LP mint>)`** (signer: `stake_config.authority`; accounts:
      authority, `stake_config_v2`, `lp_mint_config` PDA, system program). `stake_lp` is **off** until this
      is done. `node scripts/admin.cjs --cluster <testnet|mainnet> set-lp-mint <LP_MINT>` (preview, then `--live`;
      it reads the value back).
- [ ] **(e) `set_active(true)`.** `node scripts/admin.cjs --cluster <testnet|mainnet> set-active true --live`
      (it refuses while any 156-byte legacy request is still unrefunded). `scripts/initialize.cjs` is retired.

**On mainnet, `initialize_machine` must be sent by the program's upgrade authority** (the account passed
as `program_data` is checked against the signer): `node scripts/admin.cjs --cluster mainnet init-machine <TREASURY>`. Do this in Phase 4, before Phase 5 hands the
upgrade authority to the multisig. (`scripts/initialize.cjs` is retired: it sent only 3 accounts and
ran its "FORCE" `main()` twice; `admin.cjs init-machine` passes `program` + `program_data`.)

---

## Phase 1 — Flip the code from testnet to mainnet

Endpoints and ids are hardcoded in **44 files** (39 hardcode the RPC). Do not
hand-edit; centralize first.

- [ ] Frontend: make `public/js/gumball-common.js` the *only* place for `RPC`, `EXPLORER`, `PROGRAM_ID_STR`, `MACHINE_PDA_STR`, GUM mint; remove the copies in `index/landing/leaderboard/staking/verify.html`
- [ ] Server: `server.cjs` + `server-security.cjs` read `RPC_URL` / `RPC_HOST` from env (the CSP `connect-src` is built from `RPC_HOST`)
- [ ] Scripts: every `scripts/*.cjs` already honours `RPC` / `WALLET` env vars — run them with those set, never edit defaults
- [ ] `Anchor.toml`: `[programs.mainnet]` + `[provider] cluster`
- [ ] `lib.rs`: `declare_id!` → the **new** mainnet program id (fresh keypair, never the testnet one)
- [ ] Remove/disable testnet-only surfaces: `faucet.html`, `/api/faucet`, the `[ FAUCET ]` nav link on all pages
- [ ] Grep to prove nothing testnet remains:
  ```bash
  grep -rn "testnet" public scripts server*.cjs Anchor.toml programs | grep -v node_modules
  ```

---

## Phase 2 — Keys and environment on the hosts

Two hosts: the **web/API host** (Railway or your own) and the **oracle host**.
They may be the same machine, but the oracle key must exist **only** there.

### Environment variables (complete inventory)
| var | used by | notes |
|---|---|---|
| `PORT` | server | Railway sets it |
| `RPC_HOST` | server-security | mainnet RPC host — feeds the CSP |
| `RPC_URL` / `RPC_URLS` | oracle | primary + comma-separated failover list |
| `ORACLE_WALLET_KEY` **or** `ORACLE_WALLET` | server → oracle | JSON secret-key array in env, or a path. Prefer env; the file variant lands in `/tmp` |
| `ORACLE_ENCRYPTION_KEY` | oracle | AES-256-GCM key for `oracle-secrets.json` — **rotate for mainnet** |
| `SECRETS_FILE` | oracle | put it **outside** the web root (it defaults to `./`) |
| `TELEGRAM_TOKEN`, `TELEGRAM_CHAT` | monitor | alerts + `/restart` |
| `TELEGRAM_ANNOUNCE_CHAT`, `ANNOUNCE_POLL_MS`, `ANNOUNCER_STATE_FILE` | announcer | optional public channel |
| `INDEXER_STATE_FILE` | server | **mount a volume** — Railway wipes the FS on redeploy |
| `TURNSTILE_SITE_KEY/SECRET_KEY`, `FAUCET_*` | faucet | testnet only — unset on mainnet |

- [ ] `.env` on the oracle host is `chmod 600`, owned by the service user, **outside** `public/`
- [ ] Railway/host env has **no** faucet vars and **no** upgrade-authority key — the oracle key only
- [ ] Persistent volume mounted; `INDEXER_STATE_FILE` and `SECRETS_FILE` point into it
- [ ] Never commit: `oracle-secrets.json`, `*-wallet.json`, `gum-mint-keypair.json`, `.env`, `*.pem`, `target/` (all gitignored — verify with `git status --ignored`)

---

## Phase 3 — Build, verify, deploy the program

```bash
# 1. deterministic build (pinned dockerized toolchain)
solana-verify build --library-name gumball_nft

# 2. record the hash BEFORE deploying
solana-verify get-executable-hash target/deploy/gumball_nft.so

# 3. deploy with the COLD deployer key, to the NEW program id
anchor deploy --provider.cluster <MAINNET_RPC> --provider.wallet <deployer.json>

# 4. prove on-chain == local
solana-verify get-program-hash -u <MAINNET_RPC> <MAINNET_PROGRAM_ID>

# 5. publish verification so explorers show "verified"
solana-verify verify-from-repo -u <MAINNET_RPC> --program-id <MAINNET_PROGRAM_ID> \
  https://github.com/Lokoweb3/gumball_nft --library-name gumball_nft
```
- [ ] hashes match; verification published
- [ ] `verified-build.yml` is green on the deployed commit (it currently fails on a toolchain `edition2024` issue — fix the pinned image before relying on it)

---

## Phase 4 — Initialize on-chain state (order matters)

Run with `RPC=<MAINNET_RPC> WALLET=<deployer.json>` unless noted. Each script is idempotent-ish but **do not** re-run `initialize`.

1. `node scripts/admin.cjs --cluster mainnet init-machine <TREASURY>` (signer = upgrade authority) — creates the Machine PDA; then `node scripts/set-oracle.cjs --cluster mainnet --oracle <DEDICATED_ORACLE>`. `is_active` starts `false`.
2. `node scripts/create-gum-token.cjs` — mint GUM, then **revoke mint + freeze authority** (testnet `2Kjd…` has both revoked; confirm the same on mainnet with `spl-token display`)
3. `node scripts/init-staking.cjs` — `GUM_MINT=<mainnet mint>`; funds reward vaults via `NFT_FUND` / `LP_FUND`
4. `node scripts/init-xnt-fees.cjs` — **must precede any stake/unstake**; creates the XNT pool PDAs
5. `node scripts/create-pool.cjs` — only after 2; it now refuses to run unless `GUM_MINT == stake_config.gum_mint`
6. (optional) `node scripts/set-season.cjs`
7. Start the oracle → it submits the first commitment
8. Flip `set_active(true)` from the **multisig**, not the deployer

- [ ] every PDA exists: Machine, stake_config_v2, nft/lp reward vaults, nft/lp xnt pools + fee states
- [ ] `spl-token display <GUM_MINT>` shows `Mint authority: (not set)` and `Freeze authority: (not set)`

---

## Phase 5 — Hand over authority (irreversible — read twice)

```bash
# a) machine admin + treasury -> multisig (current authority signs ONCE)
#    transfer_authority(new_authority = <MULTISIG>, new_treasury = <MULTISIG or treasury wallet>)

# b) program upgrade authority -> multisig (or burn it once you are certain)
solana program set-upgrade-authority <MAINNET_PROGRAM_ID> \
  --new-upgrade-authority <MULTISIG_ADDRESS> -u <MAINNET_RPC> -k <deployer.json>
```
- [ ] the multisig executed a real no-op on this cluster **before** step (a)
- [ ] after (a), confirm `machine.authority` and `machine.treasury` read back as the multisig
- [ ] after (b), `solana program show <id>` reports the multisig as upgrade authority
- [ ] the deployer key is now **cold storage only** and appears in no `.env`, no PM2 config, no CI secret

A wrong address in (a) permanently bricks admin ops. A lost upgrade authority permanently freezes the code.

---

## Phase 6 — Web host, oracle, monitoring

- [ ] `server.cjs` serves **only** `public/` (never `__dirname`); nginx `root` is `$APP_DIR/public` — `setup.sh` is already correct
- [ ] `curl -sI https://<domain>/` shows `content-security-policy`, `strict-transport-security`, no `x-powered-by`
- [ ] `curl https://<domain>/oracle-secrets.json` → **404**; same for `.env`, `*-wallet.json`
- [ ] `/api/metadata/<any mint>` returns `ratelimit-limit: 60`
- [ ] Oracle under PM2 with `pm2 save && pm2 startup`; heartbeat file fresh; `monitor.cjs` alerting to Telegram
- [ ] Oracle balance alert threshold set (it pays rent for every `OracleCommit` PDA — they are never closed; budget ~0.0015 XNT per mint or add a close path)
- [ ] `RPC_URLS` failover list has ≥2 providers

---

## Phase 7 — Go-live smoke test (with real XNT, small amounts)

- [ ] Mint 1 → oracle fulfils within `MINT_TIMEOUT`; `verify.html` auto-verifies the commitment
- [ ] Mint 10 in one tx → all 10 land; `paid_amount` sweep leaves the MintRequest at rent
- [ ] Let one request time out → `refund_mint` returns the full amount
- [ ] List → buy at shown price; then list → delist → relist higher → buy with the old `max_price` → **rejected (6025)**
- [ ] Make offer → accept; then shrink offer under a pending accept → **rejected (6026)**
- [ ] Auction: bid, outbid (refund arrives), settle after end; settle-early rejected
- [ ] Stake NFT, deposit fee, claim; unstake closes `XntDebt` and refunds rent
- [ ] Burn-to-upgrade ×1 and `burn_multi` ×5 — no heap OOM
- [ ] Re-roll costs exactly 25 GUM; rarity unchanged
- [ ] `set_active(false)` from the multisig halts minting (**note: it halts minting only** — marketplace/staking/auctions have no pause; add one if you want a real circuit breaker)

---

## Phase 8 — After launch

- [ ] Update README + `CLAUDE.md` deployed-addresses table with the mainnet ids
- [ ] Announcer pointed at the public channel
- [ ] Weekly: `sweep_xnt_pool_*` only when a stream's total weight is 0; check oracle balance; `pm2 logs` for `Failed to reveal`
- [ ] Keep the litesvm suite running in CI even though it is non-blocking — every guard has passed on the fresh build at least once

---

## Emergency

| symptom | action |
|---|---|
| oracle not revealing | `pm2 restart gumball-oracle`; users can `refund_mint` after `MINT_TIMEOUT` |
| oracle key compromised | multisig: `set_oracle(<new key>)` immediately — the old key cannot upgrade the program if Phase 5 is done |
| bug in a marketplace instruction | there is **no pause** for it; the only lever is a multisig-approved upgrade |
| site down | Railway redeploy / `pm2 restart all`; the chain keeps working — users can call instructions directly |

---

## Appendix — Self-hosted server setup (Hetzner + nginx + PM2)

Still valid if you run your own box instead of Railway. `setup.sh` automates it.

1. **Server**: CX22, Ubuntu 24.04, add your SSH key, note the IP.
2. **Domain**: A records `@` and `www` → server IP; wait for `ping` to resolve.
3. **Copy**: `setup.sh` plus the oracle wallet (never via git) to the server.
4. **Run** `bash setup.sh` — installs Node, nginx (root = `$APP_DIR/public`, dotfiles and `*.json/*.pem/*.key/*.cjs` denied), certbot, PM2, ufw.
5. **Wallet**: move the oracle keypair to `$APP_DIR`, `chmod 600`, owned by `gumball`.
6. **`.env`**: the variables from Phase 2, `chmod 600`.
7. **Start**: `pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`.
8. **Verify**: `pm2 status`, `pm2 logs gumball-oracle --lines 30` → `Commitment submitted!`.
9. **Harden**: `PermitRootLogin no`, `ufw status`, `unattended-upgrades`.

Updating later: `git pull && pm2 restart all` (frontend is static — no build step).
