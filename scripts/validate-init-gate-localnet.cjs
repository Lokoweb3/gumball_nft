// S2: initialize_machine must be callable only by the program's upgrade
// authority. Needs a validator with NO Machine PDA (anchor `init` runs before
// the gate constraints, so against an existing machine every caller fails on
// "already in use" and the gate cannot be observed). ci-e2e.sh starts a clean
// validator with the program loaded as upgradeable (authority = local wallet).
//
// Usage: RPC=... TREASURY=<pubkey> node scripts/validate-init-gate-localnet.cjs

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));
const TREASURY = new PublicKey(process.env.TREASURY);

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().slice(0, 8);
const pda = (seeds, pid = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const machinePda = pda([Buffer.from("machine")]);
const programData = pda([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE);
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

function initMachineIx(signer, programDataKey = programData) {
  const price = Buffer.alloc(8);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc("initialize_machine"), price, TREASURY.toBuffer()]),
    keys: [
      meta(signer, true, true), meta(machinePda, false, true),
      meta(SystemProgram.programId, false, false),
      meta(PROGRAM_ID, false, false), meta(programDataKey, false, false),
    ],
  });
}

async function simulate(c, ix, payer) {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const r = await c.simulateTransaction(tx);
  return { err: r.value.err, logs: (r.value.logs || []).join("\n") };
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  await c.requestAirdrop(wallet.publicKey, 10_000_000_000).then(sig => c.confirmTransaction(sig, "confirmed"));

  console.log("\nTEST S2 — initialize_machine upgrade-authority gate (clean validator)");
  const pd = await c.getAccountInfo(programData);
  check("program is upgradeable with the local wallet as authority",
    !!pd && pd.data[12] === 1 && new PublicKey(pd.data.subarray(13, 45)).equals(wallet.publicKey));
  check("no Machine exists yet", (await c.getAccountInfo(machinePda)) === null);

  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(c, new Transaction().add(SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: stranger.publicKey, lamports: 1_000_000_000 })), [wallet]);

  const sStr = await simulate(c, initMachineIx(stranger.publicKey), stranger);
  check("stranger initialize_machine rejected (Unauthorized)",
    !!sStr.err && sStr.logs.includes("Unauthorized"), JSON.stringify(sStr.err));
  // Stranger passing a ProgramData that does not belong to the program
  const sFake = await simulate(c, initMachineIx(stranger.publicKey, stranger.publicKey), stranger);
  check("stranger with a bogus program_data account rejected", !!sFake.err);
  // Even the real authority cannot pair itself with a bogus program_data
  const sFake2 = await simulate(c, initMachineIx(wallet.publicKey, stranger.publicKey), wallet);
  check("authority with a bogus program_data account rejected", !!sFake2.err);
  check("Machine still not created by the failed attempts", (await c.getAccountInfo(machinePda)) === null);

  await sendAndConfirmTransaction(c, new Transaction().add(initMachineIx(wallet.publicKey)), [wallet],
    { commitment: "confirmed" });
  const m = await c.getAccountInfo(machinePda);
  check("upgrade authority initialize_machine succeeds", !!m);
  check("machine.authority = upgrade authority",
    !!m && new PublicKey(m.data.subarray(8, 40)).equals(wallet.publicKey));

  console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
