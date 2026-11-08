#!/usr/bin/env node
// Refund pre-upgrade 156-byte MintRequests that reveal_and_mint / refund_mint can no longer read.
// Preview by default: lists unfulfilled 156-byte requests with minter, amount and whether the
// timeout has passed. --live sends one refund_legacy_mint per timed-out request; the funds always
// go to the stored minter, so any funded wallet may pay the fee.
//
//   node scripts/refund-legacy-mints.cjs                # preview
//   node scripts/refund-legacy-mints.cjs --live         # send refunds
//
// Fee payer: WALLET env var, else ~/.config/solana/id.json. RPC defaults to testnet.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { fetchMintRequests, LEGACY_MINT_REQUEST_LEN } = require("./lib/mint-requests.cjs");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";
const MINT_TIMEOUT = 150n; // seconds, as in lib.rs
const live = process.argv.includes("--live");
const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const fail = (m) => { console.error(m); process.exit(1); };

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const slot = await conn.getSlot();
  const now = BigInt(await conn.getBlockTime(slot));
  const legacy = (await fetchMintRequests(conn, PROGRAM_ID, { sizes: [LEGACY_MINT_REQUEST_LEN] })).filter((r) => !r.fulfilled);
  console.log(`cluster ${RPC}; ${legacy.length} unfulfilled legacy (156-byte) request(s)`);
  for (const r of legacy) {
    const ready = now - r.requestedAt > MINT_TIMEOUT;
    console.log(`  ${r.pubkey.toBase58()} minter ${r.minter.toBase58()} paid ${r.paid} lamports (account ${r.lamports}) ` +
      (ready ? "REFUNDABLE" : `not yet (${MINT_TIMEOUT - (now - r.requestedAt)}s left)`));
  }
  const ready = legacy.filter((r) => now - r.requestedAt > MINT_TIMEOUT);
  if (!live) { console.log(`preview: nothing sent (add --live to refund ${ready.length})`); return; }
  const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  console.log(`fee payer ${payer.publicKey.toBase58()}`);
  for (const r of ready) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: r.minter, isSigner: false, isWritable: true },
        { pubkey: r.pubkey, isSigner: false, isWritable: true },
      ],
      data: disc("refund_legacy_mint"),
    });
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
      console.log(`refunded ${r.pubkey.toBase58()} -> ${r.minter.toBase58()}: ${sig}`);
    } catch (e) { console.error(`FAILED ${r.pubkey.toBase58()}: ${e.message}`); process.exitCode = 1; }
  }
})().catch((e) => fail(e.message || String(e)));
