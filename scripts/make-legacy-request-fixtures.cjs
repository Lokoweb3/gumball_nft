// Writes validator account fixtures for the refund_legacy_mint tests into <outDir>:
// hand-built MintRequests in the OLD 156-byte layout (before `request_slot` was
// appended), with the correct seeds, owner and discriminator, holding funds.
// The minter is a random key nobody holds, so the test can prove funds go to the
// STORED minter and not to the caller. Shared fixtures are not touched.
//
// Layout (incl. 8-byte discriminator): minter 8..40, machine 40..72, commitment 72..104,
// quantity 104, remaining 105, paid 106..114, requested_at 114..122, fulfilled 122,
// bump 123, user_seed 124..156.
//
// Usage: node scripts/make-legacy-request-fixtures.cjs <outDir>
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Keypair, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const outDir = process.argv[2];
if (!outDir) { console.error("usage: make-legacy-request-fixtures.cjs <outDir>"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const accountDisc = crypto.createHash("sha256").update("account:MintRequest").digest().slice(0, 8);
const FAR_FUTURE = 4_000_000_000n; // requested_at far ahead of the validator clock: never timed out
const LONG_AGO = 1_000n;           // timed out

function build({ len, minter, commitment, requestedAt, fulfilled, paid, bump }) {
  const d = Buffer.alloc(len);
  accountDisc.copy(d, 0);
  minter.toBuffer().copy(d, 8);
  PublicKey.default.toBuffer().copy(d, 40);          // machine (unused by the refund)
  commitment.toBuffer().copy(d, 72);
  d[104] = 1; d[105] = 1;                            // quantity, remaining
  d.writeBigUInt64LE(paid, 106);
  d.writeBigInt64LE(requestedAt, 114);
  d[122] = fulfilled ? 1 : 0;
  d[123] = bump;
  crypto.randomBytes(32).copy(d, 124);               // user_seed
  return d;
}

const minter = Keypair.generate().publicKey;
const info = { minter: minter.toBase58(), cases: {} };
function add(name, { address, seedsOk = true, ...fields }) {
  const commitment = Keypair.generate().publicKey;
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_request"), minter.toBuffer(), commitment.toBuffer()], PROGRAM_ID);
  const key = seedsOk ? pda : Keypair.generate().publicKey;
  const data = build({ ...fields, minter, commitment, bump });
  const lamports = 10_000_000 + Number(fields.paid) % 1000; // distinctive amount
  fs.writeFileSync(path.join(outDir, `legacy-${name}.json`), JSON.stringify({
    pubkey: key.toBase58(),
    account: { lamports, data: [data.toString("base64"), "base64"], owner: PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
  }));
  info.cases[name] = { address: key.toBase58(), lamports, len: data.length };
}

add("fresh",     { len: 156, requestedAt: FAR_FUTURE, fulfilled: false, paid: 9_000_001n });
add("expired",   { len: 156, requestedAt: LONG_AGO,   fulfilled: false, paid: 9_000_002n });
add("fulfilled", { len: 156, requestedAt: LONG_AGO,   fulfilled: true,  paid: 9_000_003n });
add("wrongseed", { len: 156, requestedAt: LONG_AGO,   fulfilled: false, paid: 9_000_004n, seedsOk: false });
add("len164",    { len: 164, requestedAt: LONG_AGO,   fulfilled: false, paid: 9_000_005n });
fs.writeFileSync(path.join(outDir, "info.json"), JSON.stringify(info));
console.log(`legacy MintRequest fixtures written to ${outDir} (minter ${info.minter})`);
