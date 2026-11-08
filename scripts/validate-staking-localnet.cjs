// End-to-end validation of the XNT fee-sharing fixes against a LOCAL validator
// seeded with cloned X1 testnet state (see scratchpad make-fixtures.cjs) and the
// freshly built program. Exercises:
//   1. sweep_xnt_pool_nft / _lp with zero stakers (recovers live stranded surplus)
//   2. stake -> xnt_debt created with correct accumulator snapshot
//   3. fee deposit -> claim_xnt_fees_nft pays the exact pro-rata share
//   4. claim with nothing pending -> Ok, no transfer
//   5. sweep while staked -> rejected with PoolHasStakers
//   6. unstake -> NFT returned, StakeAccount closed, XntDebt CLOSED (rent refunded)
//   7. zero-staker fee deposit -> re-stake absorbs it (flash-stake protection),
//      claim pays nothing, unstake again clean
//   9. B1: unstake with someone else's NFT mint is rejected
//  10. B2: unstake_lp with a different lp_mint than the position's is rejected
//  11. B3: set_lp_mint is authority-only; stake_lp only accepts the registered mint
// Tests 9-11 need the extra fixtures from scripts/make-staking-attack-fixtures.cjs
// (ci-e2e.sh builds them and passes ATTACK_INFO); they are skipped without it.
//
// Usage: RPC=http://127.0.0.1:8899 NFT_MINT=<mint> TREASURY=<pubkey> node scripts/validate-staking-localnet.cjs

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const GUM_MINT   = new PublicKey("2KjdBhiWdCFoFcNNUbpSWqb67tGWnQpPjcMEYnescyy1");
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const ACC_SCALE = 1_000_000_000_000n;

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));
const NFT_MINT = new PublicKey(process.env.NFT_MINT);
const TREASURY = new PublicKey(process.env.TREASURY);

function disc(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8); }
function pda(seeds, pid = PROGRAM_ID) { return PublicKey.findProgramAddressSync(seeds, pid)[0]; }
function ata(mint, owner) { return pda([owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID); }
function readU128LE(buf, off) { return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n); }

const machinePda   = pda([Buffer.from("machine")]);
const stakeConfig  = pda([Buffer.from("stake_config_v2")]);
const nftVault     = pda([Buffer.from("nft_reward_vault")]);
const nftPool      = pda([Buffer.from("nft_xnt_pool")]);
const lpPool       = pda([Buffer.from("lp_xnt_pool")]);
const nftState     = pda([Buffer.from("xnt_fee_state_nft")]);
const lpState      = pda([Buffer.from("xnt_fee_state_lp")]);
const stakeAccount = pda([Buffer.from("stake_v2"), NFT_MINT.toBuffer()]);
const gumballData  = pda([Buffer.from("gumball"), NFT_MINT.toBuffer()]);
const xntDebt      = pda([Buffer.from("xnt_debt_nft"), NFT_MINT.toBuffer()]);
const userAta      = ata(NFT_MINT, wallet.publicKey);
const vaultAta     = ata(NFT_MINT, stakeConfig);
const stakerGumAta = ata(GUM_MINT, wallet.publicKey);
const lpRewardVault = pda([Buffer.from("lp_reward_vault")]);
const lpMintConfig  = pda([Buffer.from("lp_mint_config")]);
const METAPLEX_PID  = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
// Anchor custom error codes are 6000 + enum index. Read the index from the
// GumballError enum in lib.rs so adding another error elsewhere can't break this.
const ERR_INVALID_LP_MINT = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "programs", "gumball_nft", "src", "lib.rs"), "utf8");
  const body = src.slice(src.indexOf("pub enum GumballError"));
  const names = [...body.slice(body.indexOf("{") + 1, body.indexOf("\n}")).matchAll(/(?:^|[\s\]])([A-Z][A-Za-z0-9]*)\s*,/g)].map((m) => m[1]);
  const idx = names.indexOf("InvalidLpMint");
  if (idx < 0) throw new Error("InvalidLpMint not found in GumballError");
  return "0x" + (6000 + idx).toString(16);
})();

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

// Per-transaction balance deltas straight from the ledger. The pool delta is
// what actually matters for these assertions: "did this claim move fee-pool
// lamports?" A wallet-side comparison via two getBalance calls also picks up
// rent refunds and anything else in the transaction, which is what made the
// old TEST 4 / TEST 7 assertions read as failures.
async function poolDelta(c, sig, poolPk) {
  const tx = await c.getTransaction(sig, { commitment: "confirmed" });
  const keys = tx.transaction.message.staticAccountKeys
    ?? tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.toBase58() === poolPk.toBase58());
  const { preBalances, postBalances, fee } = tx.meta;
  return {
    pool: idx < 0 ? 0n : BigInt(postBalances[idx]) - BigInt(preBalances[idx]),
    wallet: BigInt(postBalances[0]) - BigInt(preBalances[0]),
    fee: BigInt(fee),
  };
}

async function xntStateOf(c, pk) {
  const info = await c.getAccountInfo(pk);
  return { acc: readU128LE(info.data, 9), lastSeen: info.data.readBigUInt64LE(25) };
}

function stakeIx() {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: stakeConfig,             isSigner: false, isWritable: true  },
      { pubkey: stakeAccount,            isSigner: false, isWritable: true  },
      { pubkey: gumballData,             isSigner: false, isWritable: false },
      { pubkey: NFT_MINT,                isSigner: false, isWritable: false },
      { pubkey: userAta,                 isSigner: false, isWritable: true  },
      { pubkey: vaultAta,                isSigner: false, isWritable: true  },
      { pubkey: nftVault,                isSigner: false, isWritable: false },
      { pubkey: nftState,                isSigner: false, isWritable: true  },
      { pubkey: nftPool,                 isSigner: false, isWritable: false },
      { pubkey: xntDebt,                 isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false },
      { pubkey: ASSOC_PID,               isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: disc("stake"),
  });
}

function unstakeIx() {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: stakeConfig,             isSigner: false, isWritable: true  },
      { pubkey: stakeAccount,            isSigner: false, isWritable: true  },
      { pubkey: NFT_MINT,                isSigner: false, isWritable: false },
      { pubkey: vaultAta,                isSigner: false, isWritable: true  },
      { pubkey: userAta,                 isSigner: false, isWritable: true  },
      { pubkey: GUM_MINT,                isSigner: false, isWritable: false },
      { pubkey: nftVault,                isSigner: false, isWritable: true  },
      { pubkey: stakerGumAta,            isSigner: false, isWritable: true  },
      { pubkey: nftState,                isSigner: false, isWritable: true  },
      { pubkey: nftPool,                 isSigner: false, isWritable: true  },
      { pubkey: xntDebt,                 isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false },
      { pubkey: ASSOC_PID,               isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: disc("unstake"),
  });
}

function claimXntIx() {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: stakeConfig,             isSigner: false, isWritable: false },
      { pubkey: stakeAccount,            isSigner: false, isWritable: false },
      { pubkey: nftPool,                 isSigner: false, isWritable: true  },
      { pubkey: nftState,                isSigner: false, isWritable: true  },
      { pubkey: xntDebt,                 isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("claim_xnt_fees_nft"),
  });
}

function sweepIx(which) {
  const [state, pool, name] = which === "nft"
    ? [nftState, nftPool, "sweep_xnt_pool_nft"]
    : [lpState, lpPool, "sweep_xnt_pool_lp"];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: machinePda,       isSigner: false, isWritable: false },
      { pubkey: TREASURY,         isSigner: false, isWritable: true  },
      { pubkey: stakeConfig,      isSigner: false, isWritable: false },
      { pubkey: state,            isSigner: false, isWritable: true  },
      { pubkey: pool,             isSigner: false, isWritable: true  },
    ],
    data: disc(name),
  });
}

// Several tests deliberately re-send an IDENTICAL instruction (e.g. claiming
// again with nothing pending). Same instruction + same signer + a blockhash
// that has not rolled over produces a byte-identical transaction, which the
// cluster de-duplicates: no second execution, no second fee — and assertions of
// the form `after === before - fee` then fail by exactly the fee, reporting a
// bug that does not exist. A per-send nonce in a compute-budget instruction
// keeps every transaction unique. 400k only RAISES the default 200k limit, so
// it cannot change whether an instruction succeeds.
let sendNonce = 0;
async function send(c, ix, extraSigners = []) {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + (sendNonce++) }))
    .add(ix);
  return sendAndConfirmTransaction(c, tx, [wallet, ...extraSigners], { commitment: "confirmed" });
}

// Send an attack transaction; resolve to { ok, text } where text is the error
// message plus program logs (so callers can assert WHY it was rejected).
async function attempt(c, ix, extraSigners = []) {
  try { await send(c, ix, extraSigners); return { ok: true, text: "" }; }
  catch (e) { return { ok: false, text: String(e.message) + " " + JSON.stringify(e.logs || e.transactionLogs || []) }; }
}
// Short reason from an error text: Anchor "Error Code: X" if present, else the
// first "Error processing Instruction" / program failure fragment.
function why(text) {
  const m = text.match(/Error Code: (\w+)\. Error Number: (\d+)/) || text.match(/(custom program error: 0x[0-9a-f]+)/i)
    || text.match(/(Unsupported program id|insufficient funds|[A-Za-z ]*failed[^"\\]*)/);
  return m ? m.slice(1).join(" ") || m[0] : text.replace(/\s+/g, " ").slice(0, 80);
}
async function tokenAmount(c, pk) {
  try { return BigInt((await c.getTokenAccountBalance(pk)).value.amount); } catch { return null; }
}
function meta(pubkey, isSigner, isWritable) { return { pubkey, isSigner, isWritable }; }

async function main() {
  const c = new Connection(RPC, "confirmed");
  console.log("RPC:      ", RPC);
  console.log("Wallet:   ", wallet.publicKey.toBase58());
  console.log("NFT mint: ", NFT_MINT.toBase58());

  await c.requestAirdrop(wallet.publicKey, 10_000_000_000).then(sig => c.confirmTransaction(sig, "confirmed"));
  console.log("Airdropped 10 XNT. Balance:", (await c.getBalance(wallet.publicKey)) / 1e9);

  const rentMinPool = await c.getMinimumBalanceForRentExemption(8 + 1); // 8 + XntPool::LEN

  // ── TEST 1: sweep with zero stakers recovers surplus to treasury ──────────
  console.log("\nTEST 1 — sweep with zero stakers (real cloned pool balances)");
  for (const which of ["nft", "lp"]) {
    const pool = which === "nft" ? nftPool : lpPool;
    const state = which === "nft" ? nftState : lpState;
    const before = await c.getBalance(pool);
    const tBefore = await c.getBalance(TREASURY);
    await send(c, sweepIx(which));
    const after = await c.getBalance(pool);
    const tAfter = await c.getBalance(TREASURY);
    const st = await xntStateOf(c, state);
    check(`${which} pool swept to rent floor`, after === rentMinPool, `${before} -> ${after} lamports (rent_min ${rentMinPool})`);
    check(`${which} surplus arrived in treasury`, tAfter - tBefore === before - after, `+${(tAfter - tBefore) / 1e9} XNT`);
    check(`${which} last_seen re-baselined`, st.lastSeen === BigInt(after), `last_seen=${st.lastSeen}`);
  }

  // ── TEST 2: stake — xnt_debt snapshot + Phase 3 early-mint weight bonus ────
  console.log("\nTEST 2 — stake creates xnt_debt with accumulator snapshot");
  const gdInfo = await c.getAccountInfo(gumballData);
  const gdSerial = gdInfo.data.readBigUInt64LE(72);
  const gdRarity = gdInfo.data.readUInt8(82);
  const accAtStake = (await xntStateOf(c, nftState)).acc;
  await send(c, stakeIx());
  const sa = await c.getAccountInfo(stakeAccount);
  const weight = sa.data.readBigUInt64LE(8 + 32 + 32 + 1);
  const dbt = await c.getAccountInfo(xntDebt);
  const debtVal = readU128LE(dbt.data, 8);
  const debtBump = dbt.data.readUInt8(24);
  check("StakeAccount created", !!sa, `weight=${weight}`);
  // Mirror of the contract's stake_weight(): base × (10000 + bonus_bps) / 10000,
  // bonus_bps = 5000 × (10000 − min(serial, 10000)) / 10000
  const RW = [1n, 9n, 47n, 156n, 591n];
  const capped = gdSerial > 10000n ? 10000n : gdSerial;
  const bonusBps = 5000n * (10000n - capped) / 10000n;
  const expectedWeight = RW[gdRarity % 5] * (10000n + bonusBps) / 10000n;
  check("Phase 3 early-mint bonus applied", weight === expectedWeight,
    `serial=${gdSerial} rarity=${gdRarity} -> weight ${weight} (expected ${expectedWeight})`);
  check("xnt_debt = weight × acc / SCALE", debtVal === (BigInt(weight) * accAtStake) / ACC_SCALE, `debt=${debtVal}`);
  check("xnt_debt bump set (not first-init sentinel)", debtBump !== 0, `bump=${debtBump}`);

  // ── TEST 3: fee deposit then claim pays exact share ────────────────────────
  console.log("\nTEST 3 — deposit 0.01 XNT fee, claim pays full share (sole staker)");
  const DEPOSIT = 10_000_000n;
  await send(c, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: nftPool, lamports: Number(DEPOSIT) }));
  const balBeforeClaim = BigInt(await c.getBalance(wallet.publicKey));
  const sig3 = await send(c, claimXntIx());
  const fee3 = BigInt((await c.getTransaction(sig3, { commitment: "confirmed" })).meta.fee);
  const balAfterClaim = BigInt(await c.getBalance(wallet.publicKey));
  const received = balAfterClaim - balBeforeClaim + fee3;
  const dust = DEPOSIT - received;
  check("claim paid the deposited fee (≤ rounding dust)", received > 0n && dust >= 0n && dust < 1000n,
    `received ${received} of ${DEPOSIT} lamports (dust ${dust})`);
  const st3 = await xntStateOf(c, nftState);
  check("last_seen matches pool balance after claim", st3.lastSeen === BigInt(await c.getBalance(nftPool)),
    `last_seen=${st3.lastSeen}`);

  // ── TEST 4: claim again with nothing pending succeeds, no transfer ─────────
  console.log("\nTEST 4 — claim with nothing pending");
  const sig4 = await send(c, claimXntIx());
  // Assert on the transaction's OWN pre/post balances rather than two separate
  // getBalance calls: that is the ledger's record of this instruction alone,
  // with no interference from anything else that touched the wallet.
  const m4 = await poolDelta(c, sig4, nftPool);
  const st4 = await xntStateOf(c, nftState);
  check("no lamports left the fee pool", m4.pool === 0n,
    `pool delta=${m4.pool} wallet delta=${m4.wallet} fee=${m4.fee} last_seen=${st4.lastSeen}`);

  // ── TEST 5: sweep while staked is rejected ─────────────────────────────────
  console.log("\nTEST 5 — sweep while staked must fail (PoolHasStakers)");
  let sweepRejected = false, sweepErr = "";
  try { await send(c, sweepIx("nft")); } catch (e) { sweepRejected = true; sweepErr = e.message.slice(0, 200); }
  check("sweep rejected", sweepRejected, sweepErr.includes("PoolHasStakers") || sweepErr.includes("custom program error") ? "gate enforced" : sweepErr);

  // ── TEST 6: unstake — NFT back, StakeAccount + XntDebt closed ──────────────
  console.log("\nTEST 6 — unstake closes StakeAccount AND xnt_debt, returns NFT");
  const debtRent = (await c.getAccountInfo(xntDebt)).lamports;
  const balBefore6 = BigInt(await c.getBalance(wallet.publicKey));
  const sig6 = await send(c, unstakeIx());
  const meta6 = (await c.getTransaction(sig6, { commitment: "confirmed" })).meta;
  const nftBack = (await c.getTokenAccountBalance(userAta)).value.amount === "1";
  check("NFT returned to wallet", nftBack);
  check("StakeAccount closed", (await c.getAccountInfo(stakeAccount)) === null);
  check("xnt_debt CLOSED (rent-leak fix)", (await c.getAccountInfo(xntDebt)) === null, `rent ${debtRent} refunded`);
  const balAfter6 = BigInt(await c.getBalance(wallet.publicKey));
  check("wallet net gained rent refunds", balAfter6 > balBefore6, `Δ +${balAfter6 - balBefore6} lamports (fee ${meta6.fee})`);

  // ── TEST 7: zero-staker deposit is absorbed on re-stake (flash-stake guard) ─
  console.log("\nTEST 7 — fees deposited with zero stakers are absorbed at next stake");
  await send(c, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: nftPool, lamports: 5_000_000 }));
  await send(c, stakeIx()); // re-stake: init_if_needed re-creates xnt_debt after close
  check("re-stake after close works (init_if_needed)", (await c.getAccountInfo(xntDebt)) !== null);
  const sig7 = await send(c, claimXntIx());
  const m7 = await poolDelta(c, sig7, nftPool);
  const st7 = await xntStateOf(c, nftState);
  check("flash-stake cannot capture the zero-staker backlog", m7.pool === 0n,
    `pool delta=${m7.pool} wallet delta=${m7.wallet} fee=${m7.fee} last_seen=${st7.lastSeen}`);
  await send(c, unstakeIx());
  check("second unstake clean", (await c.getAccountInfo(stakeAccount)) === null && (await c.getAccountInfo(xntDebt)) === null);
  const stFinal = await xntStateOf(c, nftState);
  check("final last_seen consistent with pool", stFinal.lastSeen === BigInt(await c.getBalance(nftPool)),
    `pool=${await c.getBalance(nftPool)} last_seen=${stFinal.lastSeen}`);

  // ── TEST 8: transfer_authority — multisig handover path ────────────────────
  console.log("\nTEST 8 — transfer_authority moves machine admin + treasury and back");
  const newAdmin = Keypair.generate();
  function transferAuthIx(signer, newAuthority, newTreasury) {
    const data = Buffer.concat([disc("transfer_authority"), newAuthority.toBuffer(), newTreasury.toBuffer()]);
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: signer,     isSigner: true,  isWritable: false },
        { pubkey: machinePda, isSigner: false, isWritable: true  },
      ],
      data,
    });
  }
  await send(c, transferAuthIx(wallet.publicKey, newAdmin.publicKey, newAdmin.publicKey));
  let mi = await c.getAccountInfo(machinePda);
  check("authority + treasury moved to new key",
    new PublicKey(mi.data.subarray(8, 40)).equals(newAdmin.publicKey) &&
    new PublicKey(mi.data.subarray(40, 72)).equals(newAdmin.publicKey));
  // Old authority must now be rejected
  let oldRejected = false;
  try { await send(c, transferAuthIx(wallet.publicKey, wallet.publicKey, TREASURY)); }
  catch { oldRejected = true; }
  check("old authority rejected after transfer", oldRejected);
  // New authority signs the transfer back (wallet pays the fee)
  await sendAndConfirmTransaction(c,
    new Transaction().add(transferAuthIx(newAdmin.publicKey, wallet.publicKey, TREASURY)),
    [wallet, newAdmin], { commitment: "confirmed" });
  mi = await c.getAccountInfo(machinePda);
  check("authority + treasury restored",
    new PublicKey(mi.data.subarray(8, 40)).equals(wallet.publicKey) &&
    new PublicKey(mi.data.subarray(40, 72)).equals(TREASURY));


  // ── TESTS 9-11: staking vulnerability regressions (B1 / B2 / B3) ───────────
  const attackInfo = process.env.ATTACK_INFO && fs.existsSync(process.env.ATTACK_INFO)
    ? JSON.parse(fs.readFileSync(process.env.ATTACK_INFO, "utf-8")) : null;
  if (!attackInfo) {
    console.log("\nTESTS 9-11 skipped — ATTACK_INFO fixtures not provided (run via scripts/ci-e2e.sh)");
  } else {
    const Y  = new PublicKey(attackInfo.victimMint);
    const L  = new PublicKey(attackInfo.lpMint);
    const F  = new PublicKey(attackInfo.junkMint);
    const P  = new PublicKey(attackInfo.posMint);
    const lpVaultAmount = BigInt(attackInfo.lpVaultAmount);

    // ── TEST 9: B1 — unstake must bind nft_mint to stake_account.nft_mint ────
    console.log("\nTEST 9 — B1: stake own NFT X, unstake X's StakeAccount against victim's NFT Y");
    const victimVault = ata(Y, stakeConfig);
    await send(c, stakeIx()); // attacker stakes the cheap NFT X
    const attackerYAta = ata(Y, wallet.publicKey);
    const b1Ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        meta(wallet.publicKey, true, true), meta(stakeConfig, false, true),
        meta(stakeAccount, false, true),                       // X's StakeAccount
        meta(Y, false, false),                                 // victim's mint
        meta(victimVault, false, true),                        // vault holding Y
        meta(attackerYAta, false, true),                       // attacker ATA for Y
        meta(GUM_MINT, false, false), meta(nftVault, false, true), meta(stakerGumAta, false, true),
        meta(nftState, false, true), meta(nftPool, false, true),
        meta(pda([Buffer.from("xnt_debt_nft"), Y.toBuffer()]), false, true),
        meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
        meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
      ],
      data: disc("unstake"),
    });
    const r1 = await attempt(c, b1Ix);
    const vaultY = await tokenAmount(c, victimVault);
    const stolenY = await tokenAmount(c, attackerYAta);
    console.log(`     attack ${r1.ok ? "SUCCEEDED" : "rejected"}; victim vault=${vaultY} attacker Y balance=${stolenY}`);
    check("B1 mismatched-mint unstake rejected", !r1.ok, r1.ok ? "ATTACK SUCCEEDED" : why(r1.text));
    check("B1 victim NFT still in the vault, none reached attacker", vaultY === 1n && !(stolenY > 0n));
    if (!r1.ok) await send(c, unstakeIx()); // clean up X with the matching mint
    check("B1 matching-mint unstake still works", (await c.getAccountInfo(stakeAccount)) === null);

    // ── TEST 10: B2 — unstake_lp must bind lp_mint to lp_stake_account.lp_mint ─
    console.log("\nTEST 10 — B2: position staked with junk mint F, unstake against real LP mint L");
    const lpStakePda = pda([Buffer.from("lp_stake_v2"), P.toBuffer()]);
    const realVault = ata(L, stakeConfig);
    const myLpAta = ata(L, wallet.publicKey);
    const b2Data = Buffer.alloc(16);
    disc("unstake_lp").copy(b2Data, 0);
    b2Data.writeBigUInt64LE(lpVaultAmount, 8);
    const b2Ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        meta(wallet.publicKey, true, true), meta(stakeConfig, false, true),
        meta(lpStakePda, false, true), meta(P, false, true), meta(ata(P, wallet.publicKey), false, true),
        meta(L, false, true),                                  // real LP mint (position says F)
        meta(realVault, false, true), meta(myLpAta, false, true),
        meta(GUM_MINT, false, false), meta(lpRewardVault, false, true), meta(stakerGumAta, false, true),
        meta(lpState, false, true), meta(lpPool, false, true),
        meta(pda([Buffer.from("xnt_debt_lp"), P.toBuffer()]), false, true),
        meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
        meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
      ],
      data: b2Data,
    });
    const myLpBefore = await tokenAmount(c, myLpAta);
    const r2 = await attempt(c, b2Ix);
    const vaultL = await tokenAmount(c, realVault);
    const myLpAfter = await tokenAmount(c, myLpAta);
    console.log(`     attack ${r2.ok ? "SUCCEEDED" : "rejected"}; real LP vault=${vaultL} attacker LP ${myLpBefore} -> ${myLpAfter}`);
    check("B2 mismatched-lp_mint unstake_lp rejected", !r2.ok, r2.ok ? "ATTACK SUCCEEDED" : why(r2.text));
    check("B2 real LP vault untouched", vaultL === lpVaultAmount && myLpAfter === myLpBefore, `vault=${vaultL}`);

    // ── TEST 11: B3 — only the registered LP mint can be staked ──────────────
    console.log("\nTEST 11 — B3: set_lp_mint is authority-only; stake_lp rejects unregistered mints");
    function setLpMintIx(signer, mint) {
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [meta(signer, true, true), meta(stakeConfig, false, false),
               meta(lpMintConfig, false, true), meta(SystemProgram.programId, false, false)],
        data: Buffer.concat([disc("set_lp_mint"), mint.toBuffer()]),
      });
    }
    const stranger = Keypair.generate();
    await send(c, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger.publicKey, lamports: 100_000_000 }));
    // The stranger pays and signs; the wallet is only the (unrelated) first signer of send().
    const rNon = await (async () => {
      try {
        await sendAndConfirmTransaction(c, new Transaction().add(setLpMintIx(stranger.publicKey, F)), [stranger], { commitment: "confirmed" });
        return { ok: true, text: "" };
      } catch (e) { return { ok: false, text: String(e.message) + JSON.stringify(e.logs || []) }; }
    })();
    check("B3 non-authority set_lp_mint rejected", !rNon.ok && (await c.getAccountInfo(lpMintConfig)) === null,
      rNon.ok ? "NON-AUTHORITY SUCCEEDED" : why(rNon.text));
    await send(c, setLpMintIx(wallet.publicKey, L));
    const cfgInfo = await c.getAccountInfo(lpMintConfig);
    check("B3 authority set_lp_mint stores the mint", !!cfgInfo && new PublicKey(cfgInfo.data.subarray(8, 40)).equals(L));
    const rNon2 = await (async () => {
      try {
        await sendAndConfirmTransaction(c, new Transaction().add(setLpMintIx(stranger.publicKey, F)), [stranger], { commitment: "confirmed" });
        return true;
      } catch { return false; }
    })();
    const cfgAfter = await c.getAccountInfo(lpMintConfig);
    check("B3 non-authority cannot overwrite the registered mint", !rNon2 && new PublicKey(cfgAfter.data.subarray(8, 40)).equals(L));

    function stakeLpIx(mint, positionMint) {
      const data = Buffer.alloc(8 + 8 + 1);
      disc("stake_lp").copy(data, 0);
      data.writeBigUInt64LE(1_000_000_000n, 8);
      data.writeUInt8(0, 16);
      const metadata = pda([Buffer.from("metadata"), METAPLEX_PID.toBuffer(), positionMint.toBuffer()], METAPLEX_PID);
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          meta(wallet.publicKey, true, true), meta(stakeConfig, false, true),
          meta(pda([Buffer.from("lp_stake_v2"), positionMint.toBuffer()]), false, true),
          meta(positionMint, true, true), meta(ata(positionMint, wallet.publicKey), false, true),
          meta(mint, false, false), meta(ata(mint, wallet.publicKey), false, true), meta(ata(mint, stakeConfig), false, true),
          meta(lpRewardVault, false, false), meta(lpState, false, true), meta(lpPool, false, false),
          meta(pda([Buffer.from("xnt_debt_lp"), positionMint.toBuffer()]), false, true),
          meta(metadata, false, true), meta(METAPLEX_PID, false, false),
          meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
          meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
          meta(lpMintConfig, false, false),
        ],
        data,
      });
    }
    const posF = Keypair.generate();
    const rF = await attempt(c, stakeLpIx(F, posF.publicKey), [posF]);
    check("B3 stake_lp with unregistered (junk) mint rejected with InvalidLpMint",
      !rF.ok && rF.text.includes(ERR_INVALID_LP_MINT), rF.ok ? "ATTACK SUCCEEDED" : why(rF.text));
    // Control: the registered mint gets PAST the mint check. The local validator
    // has no Metaplex program, so it is expected to fail later at the metadata
    // CPI — what matters is that the failure is not InvalidLpMint.
    const posL = Keypair.generate();
    const rL = await attempt(c, stakeLpIx(L, posL.publicKey), [posL]);
    check("B3 stake_lp with registered mint passes the mint check", !rL.text.includes(ERR_INVALID_LP_MINT),
      rL.ok ? "staked" : why(rL.text));
  }

  console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
