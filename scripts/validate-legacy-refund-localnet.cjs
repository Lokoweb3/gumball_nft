// refund_legacy_mint validation against a LOCAL validator (see scripts/ci-e2e.sh).
//
// Legacy MintRequests (156 bytes, pre request_slot) cannot be deserialized by
// reveal_and_mint / refund_mint. refund_legacy_mint refunds them by hand-validating
// the account. Fixtures come from scripts/make-legacy-request-fixtures.cjs.
//
// Usage: RPC=... LEGACY_DIR=<fixtures dir> node scripts/validate-legacy-refund-localnet.cjs
// The caller is the default wallet (run with a throwaway HOME / WALLET).

const {
  Connection, PublicKey, Transaction, TransactionInstruction, Keypair,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { errCode } = require("./lib/gumball-errors.cjs");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const info = JSON.parse(fs.readFileSync(path.join(process.env.LEGACY_DIR, "info.json"), "utf-8"));
const MINTER = new PublicKey(info.minter);
const caller = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));
const c = new Connection(RPC, "confirmed");
const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().slice(0, 8);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

function refundIx(request, minter = MINTER) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: minter, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(request), isSigner: false, isWritable: true },
    ],
    data: disc("refund_legacy_mint"),
  });
}
async function attempt(ix) {
  try {
    await sendAndConfirmTransaction(c, new Transaction().add(ix), [caller], { commitment: "confirmed" });
    return { ok: true, text: "" };
  } catch (e) { return { ok: false, text: String(e.message) + JSON.stringify(e.logs || []) }; }
}
// Anchor errors log "Error Number: <n>"; custom codes also show as "custom program error: 0x<hex>"
const hasCode = (text, code) => text.includes(`Error Number: ${code}`) || text.includes(`custom program error: 0x${code.toString(16)}`);

(async () => {
  console.log(`refund_legacy_mint validation — caller ${caller.publicKey.toBase58()}, stored minter ${MINTER.toBase58()}`);
  const bal = (pk) => c.getBalance(new PublicKey(pk));
  const addr = (n) => info.cases[n].address;

  console.log("\nfixtures are in the OLD layout");
  for (const n of ["fresh", "expired", "fulfilled", "wrongseed"]) {
    const a = await c.getAccountInfo(new PublicKey(addr(n)));
    check(`${n}: 156 bytes, program-owned, funded`, !!a && a.data.length === 156 && a.owner.equals(PROGRAM_ID) && a.lamports === info.cases[n].lamports);
  }

  console.log("\nrejections (exact codes)");
  const minterBefore = await bal(MINTER);
  let r = await attempt(refundIx(addr("fresh")));
  check("before timeout rejected with RequestExpired", !r.ok && hasCode(r.text, errCode("RequestExpired")), r.ok ? "SUCCEEDED" : String(errCode("RequestExpired")));
  r = await attempt(refundIx(addr("len164")));
  check("164-byte request rejected with InvalidAccount", !r.ok && hasCode(r.text, errCode("InvalidAccount")), r.ok ? "SUCCEEDED" : String(errCode("InvalidAccount")));
  r = await attempt(refundIx(addr("wrongseed")));
  check("wrong-seed account rejected with InvalidAccount", !r.ok && hasCode(r.text, errCode("InvalidAccount")), r.ok ? "SUCCEEDED" : String(errCode("InvalidAccount")));
  r = await attempt(refundIx(addr("fulfilled")));
  check("fulfilled request rejected with AlreadyFulfilled", !r.ok && hasCode(r.text, errCode("AlreadyFulfilled")), r.ok ? "SUCCEEDED" : String(errCode("AlreadyFulfilled")));
  r = await attempt(refundIx(addr("expired"), caller.publicKey));
  check("payout to a non-stored minter rejected with Unauthorized", !r.ok && hasCode(r.text, errCode("Unauthorized")), r.ok ? "SUCCEEDED" : String(errCode("Unauthorized")));
  // a program-owned account that is not a MintRequest at all (the Machine PDA)
  const machine = PublicKey.findProgramAddressSync([Buffer.from("machine")], PROGRAM_ID)[0];
  r = await attempt(refundIx(machine));
  check("non-MintRequest program account rejected with InvalidAccount", !r.ok && hasCode(r.text, errCode("InvalidAccount")), r.ok ? "SUCCEEDED" : String(errCode("InvalidAccount")));
  check("nothing moved by the rejected calls", (await bal(MINTER)) === minterBefore
    && (await bal(addr("fresh"))) === info.cases.fresh.lamports
    && (await bal(addr("expired"))) === info.cases.expired.lamports);

  console.log("\nrefund after timeout");
  const want = info.cases.expired.lamports;
  r = await attempt(refundIx(addr("expired")));
  check("timed-out legacy request refunded", r.ok, r.ok ? "" : r.text.slice(0, 200));
  check("minter received exactly the account's lamports", (await bal(MINTER)) - minterBefore === want, `+${(await bal(MINTER)) - minterBefore} of ${want}`);
  const closed = await c.getAccountInfo(new PublicKey(addr("expired")));
  check("request closed (0 lamports, data zeroed incl. discriminator)", closed === null || (closed.lamports === 0 && closed.data.every((b) => b === 0)));
  r = await attempt(refundIx(addr("expired")));
  check("second refund of the closed request fails", !r.ok);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
