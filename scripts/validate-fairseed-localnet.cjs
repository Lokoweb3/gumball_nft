// Fair-seed mint validation against a LOCAL validator (see scripts/ci-e2e.sh).
//
// Proves the reveal seed is bound to a slot fixed by the request:
//   1. request_mint stores request_slot (MintRequest is 164 bytes)
//   2. reveal BEFORE the fixed slot fails with SeedSlotNotReached
//   3. the same reveal simulated at two different later slots emits identical
//      MintSeedEvent / GumballMintedEvent (outcome independent of reveal timing)
//   4. the real reveal equals an off-chain recomputation from
//      (secret, slot hash read from the SlotHashes sysvar, user_seed, index)
//   5. every mint of a batch uses the same slot hash, with its own index
//   6. a request older than MINT_TIMEOUT is refunded by reveal_and_mint
//
// Usage (the machine's oracle field must be the throwaway ORACLE_KEYPAIR):
//   RPC=http://127.0.0.1:8899 ORACLE_KEYPAIR=<path> node scripts/validate-fairseed-localnet.cjs
// The minter is the default wallet (~/.config/solana/id.json: run with a throwaway HOME).

const {
  Connection, PublicKey, Transaction, TransactionInstruction, Keypair,
  SystemProgram, SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const REVEAL_DELAY_SLOTS = 2n;
const MINT_TIMEOUT_S = 150;

const loadKp = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
const minter = loadKp(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"));
const oracle = loadKp(process.env.ORACLE_KEYPAIR);
const connection = new Connection(RPC, "confirmed");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().slice(0, 8);
const evDisc = (n) => crypto.createHash("sha256").update(`event:${n}`).digest().slice(0, 8);
const sha256 = (...b) => crypto.createHash("sha256").update(Buffer.concat(b)).digest();
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const ata = (mint, owner) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID)[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MACHINE = pda([Buffer.from("machine")]);
const MACHINE_AUTH = pda([Buffer.from("machine_authority")]);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

// ── off-chain port of resolve_traits (lib.rs) ────────────────────────────────
const M64 = (1n << 64n) - 1n;
function lcgNext(seed, modulus) {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & M64;
  return [seed, Number((seed >> 33n) % BigInt(modulus))];
}
function resolveTraits(seed, serialParam) {
  seed = (seed * 6364136223846793005n + ((serialParam + 1n) & M64)) & M64;
  let flavor, color, special, roll;
  [seed, flavor] = lcgNext(seed, 20);
  [seed, color] = lcgNext(seed, 12);
  [seed, special] = lcgNext(seed, 8);
  [seed, roll] = lcgNext(seed, 100);
  const cuts = [60, 85, 95, 99, 100];
  let rarity = cuts.findIndex((c) => roll < c);
  if (rarity === -1) rarity = 4;
  return { flavor, color, rarity, special };
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function send(ixs, signers) {
  return sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}

async function submitCommitment(secret) {
  const slot = await connection.getSlot();
  const commitPda = pda([Buffer.from("commit"), oracle.publicKey.toBuffer(), u64(slot)]);
  const commitment = sha256(secret, oracle.publicKey.toBuffer());
  await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracle.publicKey, isSigner: true, isWritable: true },
      { pubkey: MACHINE, isSigner: false, isWritable: false },
      { pubkey: commitPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("submit_commitment"), commitment, u64(slot)]),
  })], [oracle]);
  return commitPda;
}

async function requestMint(commitPda, quantity, userSeed) {
  const machine = await connection.getAccountInfo(MACHINE);
  const treasury = new PublicKey(machine.data.slice(40, 72));
  const reqPda = pda([Buffer.from("mint_request"), minter.publicKey.toBuffer(), commitPda.toBuffer()]);
  const sig = await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: minter.publicKey, isSigner: true, isWritable: true },
      { pubkey: MACHINE, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: commitPda, isSigner: false, isWritable: true },
      { pubkey: reqPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("request_mint"), Buffer.from([quantity]), userSeed]),
  })], [minter]);
  const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { reqPda, txSlot: BigInt(tx.slot) };
}

async function buildReveal(reqPda, commitPda, secret, nftMint) {
  const machine = await connection.getAccountInfo(MACHINE);
  const treasury = new PublicKey(machine.data.slice(40, 72));
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracle.publicKey, isSigner: true, isWritable: true },
      { pubkey: MACHINE, isSigner: false, isWritable: true },
      { pubkey: MACHINE_AUTH, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: minter.publicKey, isSigner: false, isWritable: true },
      { pubkey: reqPda, isSigner: false, isWritable: true },
      { pubkey: commitPda, isSigner: false, isWritable: true },
      { pubkey: nftMint.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata(nftMint.publicKey, minter.publicKey), isSigner: false, isWritable: true },
      { pubkey: pda([Buffer.from("gumball"), nftMint.publicKey.toBuffer()]), isSigner: false, isWritable: true },
      { pubkey: pda([Buffer.from("svg"), nftMint.publicKey.toBuffer()]), isSigner: false, isWritable: true },
      { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
      { pubkey: pda([Buffer.from("nft_xnt_pool")]), isSigner: false, isWritable: true },
      { pubkey: pda([Buffer.from("lp_xnt_pool")]), isSigner: false, isWritable: true },
      { pubkey: pda([Buffer.from("season")]), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: ASSOC_PID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("reveal_and_mint"), secret]),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = oracle.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

async function simulate(tx, signers) {
  const r = await connection.simulateTransaction(tx, signers);
  return { slot: BigInt(r.context.slot), err: r.value.err, logs: r.value.logs || [] };
}

function events(logs, name) {
  const d = evDisc(name);
  return logs.filter((l) => l.startsWith("Program data: "))
    .map((l) => Buffer.from(l.slice(14), "base64"))
    .filter((b) => b.length >= 8 && b.slice(0, 8).equals(d))
    .map((b) => b.slice(8));
}
function parseSeedEvent(b) {
  return { mint: new PublicKey(b.slice(0, 32)), requestSlot: b.readBigUInt64LE(32),
           seedSlot: b.readBigUInt64LE(40), slotHash: b.slice(48, 80), mintIndex: b[80] };
}

async function waitSlot(target) {
  for (;;) {
    if (BigInt(await connection.getSlot("confirmed")) >= target) return;
    await sleep(150);
  }
}

// first sysvar entry with slot > threshold, read straight from the SlotHashes account
async function sysvarSlotHashAfter(threshold) {
  const info = await connection.getAccountInfo(SLOT_HASHES);
  const d = info.data;
  const n = Number(d.readBigUInt64LE(0));
  let best = null;
  for (let i = 0; i < n; i++) {
    const slot = d.readBigUInt64LE(8 + i * 40);
    if (slot > threshold) best = { slot, hash: d.slice(8 + i * 40 + 8, 8 + i * 40 + 40) };
    else break; // descending
  }
  return best;
}

const readMachineMinted = async () => (await connection.getAccountInfo(MACHINE)).data.readBigUInt64LE(8 + 96 + 8);

async function revealReal(reqPda, commitPda, secret) {
  const nftMint = Keypair.generate();
  const tx = await buildReveal(reqPda, commitPda, secret, nftMint);
  const sig = await sendAndConfirmTransaction(connection, tx, [oracle, nftMint], { commitment: "confirmed" });
  const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { nftMint, sig, logs: t.meta.logMessages, slot: BigInt(t.slot) };
}

(async () => {
  console.log(`Fair-seed validation — oracle ${oracle.publicKey.toBase58()}, minter ${minter.publicKey.toBase58()}`);
  const machineOracle = new PublicKey((await connection.getAccountInfo(MACHINE)).data.slice(72, 104));
  if (!machineOracle.equals(oracle.publicKey)) {
    console.log(`machine.oracle is ${machineOracle.toBase58()}, not the throwaway ORACLE_KEYPAIR: patch the machine fixture copy`);
    process.exit(2);
  }
  for (const k of [oracle, minter]) {
    const sig = await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // The timeout request goes first so its 150 s clock runs while the rest executes.
  console.log("\n[setup] request that will be left to expire (tests the refund path)");
  const secretT = crypto.randomBytes(32);
  const commitT = await submitCommitment(secretT);
  const reqT = await requestMint(commitT, 1, crypto.randomBytes(32));
  const startedT = Date.now();

  console.log("\n[1] request_mint records request_slot");
  const secret = crypto.randomBytes(32);
  const userSeed = crypto.randomBytes(32);
  const commit = await submitCommitment(secret);
  const { reqPda, txSlot } = await requestMint(commit, 2, userSeed);
  const reqInfo = await connection.getAccountInfo(reqPda);
  check("MintRequest is 164 bytes", reqInfo.data.length === 164, `len=${reqInfo.data.length}`);
  const requestSlot = reqInfo.data.readBigUInt64LE(156);
  check("request_slot equals the slot request_mint landed in", requestSlot === txSlot, `${requestSlot} vs ${txSlot}`);
  const threshold = requestSlot + REVEAL_DELAY_SLOTS;

  console.log("\n[2] reveal before the fixed slot fails");
  {
    const probe = Keypair.generate();
    const tx = await buildReveal(reqPda, commit, secret, probe);
    const s = await simulate(tx, [oracle, probe]);
    check("simulated reveal right after the request is rejected", s.err !== null, `at slot ${s.slot}`);
    check("rejection is SeedSlotNotReached", s.logs.some((l) => l.includes("SeedSlotNotReached")),
      s.logs.find((l) => l.includes("Error")) || "");
    check("simulation ran before the fixed slot", s.slot <= threshold + 1n, `slot ${s.slot}, threshold ${threshold}`);
  }

  console.log("\n[3] identical reveal simulated at two different later slots");
  await waitSlot(threshold + 3n);
  const probe = Keypair.generate();
  const tx1 = await buildReveal(reqPda, commit, secret, probe);
  const sim1 = await simulate(tx1, [oracle, probe]);
  await waitSlot(sim1.slot + 8n);
  const tx2 = await buildReveal(reqPda, commit, secret, probe);
  const sim2 = await simulate(tx2, [oracle, probe]);
  check("both simulations succeed", sim1.err === null && sim2.err === null, JSON.stringify([sim1.err, sim2.err]));
  check("simulated at different slots", sim2.slot >= sim1.slot + 8n, `${sim1.slot} then ${sim2.slot}`);
  const seedEv1 = events(sim1.logs, "MintSeedEvent")[0], seedEv2 = events(sim2.logs, "MintSeedEvent")[0];
  const mintEv1 = events(sim1.logs, "GumballMintedEvent")[0], mintEv2 = events(sim2.logs, "GumballMintedEvent")[0];
  check("MintSeedEvent identical (same seed slot and hash)", seedEv1 && seedEv2 && seedEv1.equals(seedEv2));
  check("GumballMintedEvent identical (same traits)", mintEv1 && mintEv2 && mintEv1.equals(mintEv2));

  console.log("\n[4] real reveal equals off-chain recomputation");
  const minted0 = await readMachineMinted();
  const r0 = await revealReal(reqPda, commit, secret);
  const ev0 = parseSeedEvent(events(r0.logs, "MintSeedEvent")[0]);
  const expectSlot = await sysvarSlotHashAfter(threshold);
  check("seed slot is the first recorded slot > request_slot + 2", ev0.seedSlot === expectSlot.slot,
    `event ${ev0.seedSlot}, sysvar ${expectSlot.slot}`);
  check("event slot hash equals the SlotHashes sysvar entry", ev0.slotHash.equals(expectSlot.hash));
  check("revealed at a later slot than the simulations' base", r0.slot > sim2.slot - 1n, `reveal slot ${r0.slot}`);
  check("seed slot is after the request", ev0.seedSlot > requestSlot + REVEAL_DELAY_SLOTS);
  const gd0 = (await connection.getAccountInfo(pda([Buffer.from("gumball"), r0.nftMint.publicKey.toBuffer()]))).data;
  const seed0 = sha256(secret, expectSlot.hash, userSeed, Buffer.from([0])).readBigUInt64LE(0);
  const exp0 = resolveTraits(seed0, minted0);
  check("on-chain traits equal recomputation from (secret, slot hash, user_seed, 0)",
    gd0[80] === exp0.flavor && gd0[81] === exp0.color && gd0[82] === exp0.rarity && gd0[83] === exp0.special,
    `chain [${[...gd0.slice(80, 84)]}] vs [${exp0.flavor},${exp0.color},${exp0.rarity},${exp0.special}]`);
  const simMint = mintEv1.slice(32 + 8 + 32);
  check("real mint equals the earlier simulations", simMint[0] === gd0[80] && simMint[1] === gd0[81] && simMint[2] === gd0[82] && simMint[3] === gd0[83]);

  console.log("\n[5] second mint of the batch: same slot hash, next index");
  const minted1 = await readMachineMinted();
  const r1 = await revealReal(reqPda, commit, secret);
  const ev1 = parseSeedEvent(events(r1.logs, "MintSeedEvent")[0]);
  check("same seed slot and hash for every mint in the batch", ev1.seedSlot === ev0.seedSlot && ev1.slotHash.equals(ev0.slotHash));
  check("mint_index increments", ev0.mintIndex === 0 && ev1.mintIndex === 1);
  const gd1 = (await connection.getAccountInfo(pda([Buffer.from("gumball"), r1.nftMint.publicKey.toBuffer()]))).data;
  const exp1 = resolveTraits(sha256(secret, expectSlot.hash, userSeed, Buffer.from([1])).readBigUInt64LE(0), minted1);
  check("mint #2 traits equal recomputation with index 1",
    gd1[80] === exp1.flavor && gd1[81] === exp1.color && gd1[82] === exp1.rarity && gd1[83] === exp1.special);
  check("revealed in a later slot than mint #1 yet same hash", r1.slot > r0.slot);
  check("request fulfilled", (await connection.getAccountInfo(reqPda)).data[122] === 1);

  console.log(`\n[6] expired request is refunded by reveal_and_mint (waiting for ${MINT_TIMEOUT_S}s timeout)`);
  const balBefore = await connection.getBalance(minter.publicKey);
  const probeT = Keypair.generate();
  let refundTx;
  for (;;) {
    refundTx = await buildReveal(reqT.reqPda, commitT, secretT, probeT);
    const s = await simulate(refundTx, [oracle, probeT]);
    if (s.err === null && events(s.logs, "MintRefundedEvent").length === 1) break;
    if (Date.now() - startedT > (MINT_TIMEOUT_S + 120) * 1000) { check("timeout refund observed", false); break; }
    await sleep(5000);
  }
  await sendAndConfirmTransaction(connection, refundTx, [oracle, probeT], { commitment: "confirmed" });
  const balAfter = await connection.getBalance(minter.publicKey);
  check("minter got the payment + rent back", balAfter - balBefore >= 0.01 * LAMPORTS_PER_SOL, `+${balAfter - balBefore} lamports`);
  const closed = await connection.getAccountInfo(reqT.reqPda);
  check("timed-out MintRequest no longer holds lamports", closed === null || closed.lamports === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
