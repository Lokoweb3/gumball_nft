#!/usr/bin/env node
// Point the machine at a new oracle key (set_oracle). Preview by default.
//
//   node scripts/set-oracle.cjs --oracle <NEW_ORACLE_PUBKEY>            # preview: checks, nothing sent
//   node scripts/set-oracle.cjs --oracle <NEW_ORACLE_PUBKEY> --live     # send it
//
// Signs with the machine authority: WALLET env var, else ~/.config/solana/id.json.
// The new oracle key only needs its PUBLIC key here; its secret belongs on the oracle host alone.
// After it lands, restart the oracle with ORACLE_WALLET pointing at the new key, or reveals stop.
// RPC defaults to testnet; set RPC=… for another cluster.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";
const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const live = argv.includes("--live");

function fail(msg) { console.error(msg); process.exit(1); }

let newOracle;
try { newOracle = new PublicKey(flag("--oracle") || ""); } catch { fail("usage: node scripts/set-oracle.cjs --oracle <NEW_ORACLE_PUBKEY> [--live]"); }

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
if (newOracle.equals(authority.publicKey)) fail("refusing: the new oracle is the authority key itself — the point is to separate them");

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const [machine] = PublicKey.findProgramAddressSync([Buffer.from("machine")], PROGRAM_ID);

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const info = await conn.getAccountInfo(machine);
  if (!info || !info.owner.equals(PROGRAM_ID)) fail(`machine ${machine.toBase58()} not found on ${RPC}`);
  // Machine layout: 8 discriminator, authority @8, treasury @40, oracle @72
  const onAuthority = new PublicKey(info.data.subarray(8, 40));
  const onOracle = new PublicKey(info.data.subarray(72, 104));
  console.log(`cluster   ${RPC}`);
  console.log(`machine   ${machine.toBase58()}`);
  console.log(`authority ${onAuthority.toBase58()} (signer ${authority.publicKey.toBase58()})`);
  console.log(`oracle    ${onOracle.toBase58()} -> ${newOracle.toBase58()}`);
  if (!onAuthority.equals(authority.publicKey)) fail("the signer is not machine.authority; nothing sent");
  if (onOracle.equals(newOracle)) { console.log("already set; nothing to do"); return; }

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
