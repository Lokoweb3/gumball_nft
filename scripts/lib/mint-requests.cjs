// Scan the program's MintRequest accounts. Two layouts exist: 164 bytes (current,
// request_slot appended) and 156 bytes (legacy). Common offsets, discriminator
// included: minter 8..40, commitment 72..104, paid 106..114, requested_at 114..122,
// fulfilled 122.
const crypto = require("crypto");
const { PublicKey } = require("@solana/web3.js");

const MINT_REQUEST_LEN = 164;
const LEGACY_MINT_REQUEST_LEN = 156;
const bs58 = require("bs58");

const accountDisc = () => crypto.createHash("sha256").update("account:MintRequest").digest().subarray(0, 8);

// Returns [{ pubkey, len, minter, paid (BigInt), requestedAt (BigInt), fulfilled }], both layouts.
async function fetchMintRequests(conn, programId, { sizes = [MINT_REQUEST_LEN, LEGACY_MINT_REQUEST_LEN] } = {}) {
  const disc = accountDisc();
  const out = [];
  for (const size of sizes) {
    const accts = await conn.getProgramAccounts(new PublicKey(programId), {
      filters: [{ dataSize: size }, { memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });
    for (const { pubkey, account } of accts) {
      const d = account.data;
      out.push({
        pubkey, len: d.length, lamports: account.lamports,
        minter: new PublicKey(d.subarray(8, 40)),
        paid: d.readBigUInt64LE(106),
        requestedAt: d.readBigInt64LE(114),
        fulfilled: d[122] !== 0,
      });
    }
  }
  return out;
}

module.exports = { fetchMintRequests, MINT_REQUEST_LEN, LEGACY_MINT_REQUEST_LEN };
