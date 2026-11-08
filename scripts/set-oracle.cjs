#!/usr/bin/env node
// Point the machine at a new oracle key (set_oracle). Preview by default.
//
//   node scripts/set-oracle.cjs --cluster testnet --oracle <NEW_ORACLE_PUBKEY>         # preview: checks, nothing sent
//   node scripts/set-oracle.cjs --cluster testnet --oracle <NEW_ORACLE_PUBKEY> --live  # send it
//
// --cluster testnet|mainnet is required: the RPC's genesis hash must match the known hash for that
// cluster, so a wrong RPC (or a wrong WALLET/cluster pairing) is refused before anything is signed.
// Rotating the oracle strands every pending MintRequest's reveal (they can only be refunded after
// the timeout), so --live is refused while any exist unless --force-pending is given.
//
// Signs with the machine authority: WALLET env var, else ~/.config/solana/id.json.
// The new oracle key only needs its PUBLIC key here; its secret belongs on the oracle host alone.
// After it lands, restart the oracle with ORACLE_WALLET pointing at the new key, or reveals stop.
// RPC defaults to the public RPC of --cluster; set RPC=… to override (the genesis check still applies).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { fetchMintRequests } = require("./lib/mint-requests.cjs");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
// Genesis hashes read from getGenesisHash on the public RPCs (read-only).
const CLUSTERS = {
  testnet: { rpc: "https://rpc.testnet.x1.xyz", genesis: "C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho" },
  mainnet: { rpc: "https://rpc.mainnet.x1.xyz", genesis: "4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN" },
};
const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const live = argv.includes("--live");
const forcePending = argv.includes("--force-pending");

function fail(msg) { console.error(msg); process.exit(1); }

const clusterName = flag("--cluster");
if (!CLUSTERS[clusterName]) fail("usage: node scripts/set-oracle.cjs --cluster testnet|mainnet --oracle <NEW_ORACLE_PUBKEY> [--live] [--force-pending]");
const RPC = process.env.RPC || CLUSTERS[clusterName].rpc;

let newOracle;
try { newOracle = new PublicKey(flag("--oracle") || ""); } catch { fail("usage: node scripts/set-oracle.cjs --cluster testnet|mainnet --oracle <NEW_ORACLE_PUBKEY> [--live] [--force-pending]"); }

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
if (newOracle.equals(authority.publicKey)) fail("refusing: the new oracle is the authority key itself — the point is to separate them");

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const [machine] = PublicKey.findProgramAddressSync([Buffer.from("machine")], PROGRAM_ID);

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  console.log(`cluster   ${RPC}`);
  console.log(`genesis   ${genesis} (expected for ${clusterName}: ${CLUSTERS[clusterName].genesis})`);
  if (genesis !== CLUSTERS[clusterName].genesis) fail(`refusing: genesis hash does not match --cluster ${clusterName}; nothing sent`);
  const info = await conn.getAccountInfo(machine);
  if (!info || !info.owner.equals(PROGRAM_ID)) fail(`machine ${machine.toBase58()} not found on ${RPC}`);
  // Machine layout: 8 discriminator, authority @8, treasury @40, oracle @72
  const onAuthority = new PublicKey(info.data.subarray(8, 40));
  const onOracle = new PublicKey(info.data.subarray(72, 104));
  console.log(`machine   ${machine.toBase58()}`);
  console.log(`authority ${onAuthority.toBase58()} (signer ${authority.publicKey.toBase58()})`);
  console.log(`oracle    ${onOracle.toBase58()} -> ${newOracle.toBase58()}`);
  if (!onAuthority.equals(authority.publicKey)) fail("the signer is not machine.authority; nothing sent");
  if (onOracle.equals(newOracle)) { console.log("already set; nothing to do"); return; }

  // Pending = not fulfilled, in either layout (164 current, 156 legacy). After rotation the new
  // oracle cannot reveal them (reveal checks the commitment's oracle); they refund after MINT_TIMEOUT.
  const pending = (await fetchMintRequests(conn, PROGRAM_ID)).filter((r) => !r.fulfilled);
  if (pending.length > 0) {
    const paid = pending.reduce((a, r) => a + r.paid, 0n);
    console.warn(`WARNING: ${pending.length} pending MintRequest(s) (${pending.filter((r) => r.len === 164).length} x 164 bytes, ` +
      `${pending.filter((r) => r.len === 156).length} x 156 bytes), ${paid} lamports paid.`);
    console.warn("Rotating the oracle strands their reveals: they can only be refunded after the timeout.");
    for (const r of pending.slice(0, 10)) console.warn(`  ${r.pubkey.toBase58()} minter ${r.minter.toBase58()} paid ${r.paid}`);
    if (live && !forcePending) fail("refusing to send: pending requests exist; re-run with --force-pending to proceed anyway");
    if (!live) console.warn("(--live would require --force-pending)");
  } else {
    console.log("no pending MintRequests");
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: machine, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("set_oracle"), newOracle.toBuffer()]),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, [authority]);
  if (sim.value.err) fail(`simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-5).join("\n")}`);
  console.log("simulation passed");
  if (!live) { console.log("preview: nothing sent (add --live to send)"); return; }
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority]);
  const after = new PublicKey((await conn.getAccountInfo(machine)).data.subarray(72, 104));
  console.log(`sent: ${sig}\noracle is now ${after.toBase58()}`);
  if (!after.equals(newOracle)) fail("WARNING: read-back does not match");
})().catch((e) => fail(e.message || String(e)));
