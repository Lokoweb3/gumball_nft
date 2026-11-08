#!/usr/bin/env node
// Closes the GumballData + GumballSvg of every burned ball and sends their rent to machine.treasury
// (close_burned is permissionless; the signer only pays fees). Preview by default; --live sends.
//
//   node scripts/close-burned.cjs --cluster testnet            # list burned balls, total reclaimable, simulate
//   node scripts/close-burned.cjs --cluster mainnet --live     # send
//   options: --batch N   closes per transaction (default 8, the most that fits the 1,232-byte limit)
//            --limit N   stop after N balls (default: all)
//
// --cluster testnet|mainnet is required and the RPC's genesis hash must match it.
// Signs with WALLET env var, else ~/.config/solana/id.json; the key needs only enough XNT for fees.
//
// A burned ball is a gumball mint (classic SPL, mint authority = machine_authority PDA) with supply 0
// whose GumballData has a zeroed owner field and this machine. The mint is not stored in GumballData,
// so balls are found from their mints and cross-checked against the GumballData scan (32 zero bytes at
// offset 8): a zeroed GumballData with no burned mint is reported and skipped.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bs58 = require("bs58");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const CLUSTERS = {
  testnet: { rpc: "https://rpc.testnet.x1.xyz", genesis: "C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho" },
  mainnet: { rpc: "https://rpc.mainnet.x1.xyz", genesis: "4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN" },
  localnet: { rpc: "http://127.0.0.1:8899", genesis: null }, // tests only: genesis varies, RPC must be loopback
};
const USAGE = "usage: node scripts/close-burned.cjs --cluster testnet|mainnet|localnet [--batch N] [--limit N] [--live]";
const MAX_BATCH = 8; // 1 payer + 4 shared keys + 3 per ball: 8 balls = 1,166 bytes, 9 would be 1,279

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const optArg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const clusterName = optArg("--cluster");
function fail(msg) { console.error(msg); process.exit(1); }
if (!CLUSTERS[clusterName]) fail(USAGE);
const intOpt = (name, dflt) => {
  const v = optArg(name);
  if (v === undefined) return dflt;
  if (!/^[1-9][0-9]*$/.test(v)) fail(`${name}: positive integer expected\n${USAGE}`);
  return Number(v);
};
const batchSize = Math.min(intOpt("--batch", MAX_BATCH), MAX_BATCH);
const limit = intOpt("--limit", Infinity);

const disc = (name, kind = "global") => crypto.createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), PROGRAM_ID)[0];
const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
const machine = pda("machine");
const machineAuth = pda("machine_authority");

function closeIx(mint, treasury) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: machine, isSigner: false, isWritable: false },
    { pubkey: machineAuth, isSigner: false, isWritable: false },
    { pubkey: treasury, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: pda("gumball", mint.toBuffer()), isSigner: false, isWritable: true },
    { pubkey: pda("svg", mint.toBuffer()), isSigner: false, isWritable: true },
  ], data: disc("close_burned") });
}

async function getMultiple(conn, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  return out;
}

// Burned gumball mints: Mint = COption tag(4) authority(32 @4) supply(u64 @36), 82 bytes
async function findBurnedMints(conn) {
  const accts = await conn.getProgramAccounts(TOKEN_PID, { dataSlice: { offset: 0, length: 0 }, filters: [
    { dataSize: 82 },
    { memcmp: { offset: 4, bytes: machineAuth.toBase58() } }, // mint_authority (the RPC only takes 32-byte filters at 0/4)
    { memcmp: { offset: 36, bytes: bs58.encode(Buffer.alloc(8)) } },
  ] });
  return accts.map((a) => a.pubkey);
}

async function scan(conn) {
  const mints = await findBurnedMints(conn);
  const gds = await getMultiple(conn, mints.map((m) => pda("gumball", m.toBuffer())));
  const svgs = await getMultiple(conn, mints.map((m) => pda("svg", m.toBuffer())));
  const balls = [];
  let alreadyClosed = 0;
  mints.forEach((mint, i) => {
    const gd = gds[i], svg = svgs[i];
    if (!gd && !svg) { alreadyClosed++; return; }
    const ok = gd && svg && gd.owner.equals(PROGRAM_ID) && svg.owner.equals(PROGRAM_ID)
      && gd.data.length >= 72 && gd.data.subarray(0, 8).equals(disc("GumballData", "account"))
      && gd.data.subarray(8, 40).every((b) => b === 0) && gd.data.subarray(40, 72).equals(machine.toBuffer())
      && svg.data.length >= 8 && svg.data.subarray(0, 8).equals(disc("GumballSvg", "account"));
    if (!ok) { console.log(`skipping ${mint.toBase58()}: GumballData/GumballSvg missing or not as expected`); return; }
    balls.push({ mint, lamports: gd.lamports + svg.lamports });
  });
  // Cross-check: GumballData with a zeroed owner on this machine, whatever its size (legacy layouts included)
  const zeroed = await conn.getProgramAccounts(PROGRAM_ID, { dataSlice: { offset: 0, length: 0 }, filters: [
    { memcmp: { offset: 0, bytes: bs58.encode(disc("GumballData", "account")) } },
    { memcmp: { offset: 8, bytes: bs58.encode(Buffer.alloc(32)) } },
    { memcmp: { offset: 40, bytes: machine.toBase58() } },
  ] });
  const known = new Set(balls.map((b) => pda("gumball", b.mint.toBuffer()).toBase58()));
  const unmatched = zeroed.filter((z) => !known.has(z.pubkey.toBase58()));
  return { balls, alreadyClosed, zeroedCount: zeroed.length, unmatched };
}

(async () => {
  const rpc = process.env.RPC || CLUSTERS[clusterName].rpc;
  if (clusterName === "localnet" && !/^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc)) fail("localnet requires a loopback RPC");
  const conn = new Connection(rpc, "confirmed");
  const genesis = await conn.getGenesisHash();
  const known = Object.entries(CLUSTERS).find(([, c]) => c.genesis === genesis);
  if (clusterName === "localnet" ? known : genesis !== CLUSTERS[clusterName].genesis) fail(`refusing: genesis ${genesis} is not ${clusterName}; nothing sent`);
  console.log(`cluster ${clusterName} (genesis ok), signer ${signer.publicKey.toBase58()} (pays fees only)`);

  const mInfo = await conn.getAccountInfo(machine);
  if (!mInfo) fail("machine not found");
  const treasury = new PublicKey(mInfo.data.subarray(40, 72)); // Machine: authority@8 treasury@40
  console.log(`rent goes to machine.treasury ${treasury.toBase58()}`);

  const { balls, alreadyClosed, zeroedCount, unmatched } = await scan(conn);
  const targets = balls.slice(0, limit);
  const total = targets.reduce((s, b) => s + b.lamports, 0);
  console.log(`burned balls with accounts still open: ${balls.length}` + (alreadyClosed ? ` (${alreadyClosed} more already closed)` : ""));
  console.log(`zeroed-owner GumballData accounts on this machine: ${zeroedCount}` + (unmatched.length ? `; ${unmatched.length} have no burned mint (skipped): ${unmatched.slice(0, 5).map((u) => u.pubkey.toBase58()).join(", ")}${unmatched.length > 5 ? " ..." : ""}` : ""));
  console.log(`selected ${targets.length}, reclaimable ${total} lamports (${(total / 1e9).toFixed(6)} XNT) -> treasury`);
  if (!targets.length) return;

  const batches = [];
  for (let i = 0; i < targets.length; i += batchSize) batches.push(targets.slice(i, i + batchSize));
  const buildTx = async (batch) => {
    const tx = new Transaction().add(...batch.map((b) => closeIx(b.mint, treasury)));
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    return tx;
  };
  const sim = await conn.simulateTransaction(await buildTx(batches[0]), [signer]);
  if (sim.value.err) fail(`close_burned (first batch of ${batches[0].length}): simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-5).join("\n")}`);
  console.log(`close_burned x${batches[0].length} (first of ${batches.length} transaction(s)): simulation passed, ${sim.value.unitsConsumed} compute units`);
  if (!live) { console.log("preview: nothing sent (add --live to send)"); return; }

  let closed = 0, moved = 0;
  for (const batch of batches) {
    const before = await conn.getBalance(treasury);
    const sig = await sendAndConfirmTransaction(conn, await buildTx(batch), [signer]);
    const want = batch.reduce((s, b) => s + b.lamports, 0);
    const left = (await getMultiple(conn, batch.flatMap((b) => [pda("gumball", b.mint.toBuffer()), pda("svg", b.mint.toBuffer())]))).filter(Boolean).length;
    const gained = (await conn.getBalance(treasury)) - before;
    console.log(`sent ${sig}: ${batch.length} balls, treasury +${gained} (expected ${want}), ${left} account(s) still open`);
    // the treasury may also receive unrelated deposits, so only a shortfall is an error
    if (left !== 0 || gained < want) fail("WARNING: read-back does not match");
    closed += batch.length; moved += want;
  }
  console.log(`read-back ok: closed ${closed} balls, ${moved} lamports (${(moved / 1e9).toFixed(6)} XNT) to the treasury`);
})().catch((e) => fail(e.message || String(e)));
