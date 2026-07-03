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
//
// Usage: RPC=http://127.0.0.1:8899 NFT_MINT=<mint> TREASURY=<pubkey> node scripts/validate-staking-localnet.cjs

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
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

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
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

async function send(c, ix) {
  return sendAndConfirmTransaction(c, new Transaction().add(ix), [wallet], { commitment: "confirmed" });
}

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
  const balBefore4 = BigInt(await c.getBalance(wallet.publicKey));
  const sig4 = await send(c, claimXntIx());
  const fee4 = BigInt((await c.getTransaction(sig4, { commitment: "confirmed" })).meta.fee);
  const balAfter4 = BigInt(await c.getBalance(wallet.publicKey));
  check("no lamports moved", balAfter4 === balBefore4 - fee4, "Ok() with zero pending");

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
  const balBefore7 = BigInt(await c.getBalance(wallet.publicKey));
  const sig7 = await send(c, claimXntIx());
  const fee7 = BigInt((await c.getTransaction(sig7, { commitment: "confirmed" })).meta.fee);
  const balAfter7 = BigInt(await c.getBalance(wallet.publicKey));
  check("flash-stake cannot capture zero-staker backlog", balAfter7 === balBefore7 - fee7, "claim paid 0");
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

  console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
