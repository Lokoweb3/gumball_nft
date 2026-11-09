#!/usr/bin/env node
// Measure what one mint really costs the oracle vs what the project earns from it. READ-ONLY:
// no key is loaded, nothing is signed or sent.
//
//   node scripts/measure-mint-cost.cjs --cluster testnet [--limit 300]
//
// 1. Rent model: getMinimumBalanceForRentExemption for every account a mint creates, by who pays.
// 2. Measured: the oracle's last --limit transactions (submit_commitment / reveal_and_mint), with
//    the oracle's real balance change and fee per transaction (pre/post balances).
// 3. Verdict: per-mint oracle outlay vs the treasury's 50% share of the current price, and the
//    price floor at which the treasury share covers the oracle (break-even) and covers it 2x.
const crypto = require("crypto");
const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default || require("bs58");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const CLUSTERS = {
  testnet: { rpc: "https://rpc.testnet.x1.xyz", genesis: "C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho" },
  mainnet: { rpc: "https://rpc.mainnet.x1.xyz", genesis: "4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN" },
};
// Account sizes (bytes incl. 8-byte discriminator where Anchor): state/*.rs, constants.rs
const SIZES = {
  oracle_commit: 8 + 82,         // OracleCommit::LEN, payer oracle, never closed
  nft_mint: 82,                  // SPL mint, payer oracle, can't be closed (classic SPL)
  minter_ata: 165,               // ATA, payer oracle (init_if_needed); the holder can close it once empty
  gumball_data: 8 + 181,         // GumballData::LEN, payer oracle
  mint_request: 8 + 156,         // MintRequest (164 bytes), payer minter, refunded to minter at the end
};
// Dropped by the traits-art program: the picture is drawn from the traits, so no GumballSvg is created.
// Legacy balls still hold one; shown only to price what each mint saves.
const LEGACY_GUMBALL_SVG = 8 + 4 + 1400; // GumballSvg::LEN (MAX_SVG_LEN 1400), was paid by the oracle
const TREASURY_BPS = 5000n;       // FEE_TREASURY_BPS_MINT; 40% NFT pool, 10% LP pool
const BASE_PRICE = 30_000_000n, MAX_PRICE = 120_000_000n, MAX_SUPPLY = 10_000n;
const TABLE = [10000n, 11487n, 13195n, 15157n, 17411n, 20000n, 22974n, 26390n, 30314n, 34822n, 40000n];
function getMintPrice(n) { // port of pricing.rs get_mint_price
  if (n >= MAX_SUPPLY) return MAX_PRICE;
  const scaled = n * 10n, bucket = scaled / MAX_SUPPLY, rem = scaled % MAX_SUPPLY;
  if (bucket >= 10n) return MAX_PRICE;
  const lo = TABLE[bucket], hi = TABLE[bucket + 1n];
  return (BASE_PRICE * (lo + ((hi - lo) * rem) / MAX_SUPPLY)) / 10000n;
}
const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
const IX = { [disc("submit_commitment")]: "commit", [disc("reveal_and_mint")]: "reveal" };
const xnt = (l) => (Number(l) / 1e9).toFixed(6);

const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const clusterName = flag("--cluster");
const limit = Math.min(Number(flag("--limit") || 300), 1000);
if (!CLUSTERS[clusterName]) { console.error("usage: node scripts/measure-mint-cost.cjs --cluster testnet|mainnet [--limit N]"); process.exit(1); }

(async () => {
  const conn = new Connection(process.env.RPC || CLUSTERS[clusterName].rpc, "confirmed");
  if ((await conn.getGenesisHash()) !== CLUSTERS[clusterName].genesis) throw new Error(`genesis is not ${clusterName}`);
  const [machine] = PublicKey.findProgramAddressSync([Buffer.from("machine")], PROGRAM_ID);
  const m = await conn.getAccountInfo(machine);
  // No machine yet (e.g. mainnet before launch): rent model at total_minted 0, nothing measured.
  const treasury = m ? new PublicKey(m.data.subarray(40, 72)) : PublicKey.default;
  const oracle = m ? new PublicKey(m.data.subarray(72, 104)) : null;
  const totalMinted = m ? m.data.readBigUInt64LE(112) : 0n;
  const price = getMintPrice(totalMinted);

  console.log(`cluster ${clusterName}  machine ${machine.toBase58()}${m ? "" : " (not created: rent model only)"}  total_minted ${totalMinted}`);
  if (m) console.log(`oracle ${oracle.toBase58()}  treasury ${treasury.toBase58()}${treasury.equals(oracle) ? "  (same key)" : ""}`);
  console.log("");

  // 1. Rent model
  const rent = {};
  for (const [k, size] of Object.entries(SIZES)) rent[k] = BigInt(await conn.getMinimumBalanceForRentExemption(size));
  const oracleRent = rent.oracle_commit + rent.nft_mint + rent.minter_ata + rent.gumball_data;
  const legacySvgRent = BigInt(await conn.getMinimumBalanceForRentExemption(LEGACY_GUMBALL_SVG));
  console.log("Rent per mint (lamports locked, by payer):");
  for (const k of Object.keys(SIZES)) console.log(`  ${k.padEnd(14)} ${String(SIZES[k]).padStart(5)} B  ${xnt(rent[k])} XNT  ${k === "mint_request" ? "minter, refunded" : "oracle"}`);
  console.log(`  oracle total                ${xnt(oracleRent)} XNT  (commit amortised 1:1; a quantity-N request shares one commit)`);
  console.log(`  (the old program also created a ${LEGACY_GUMBALL_SVG} B GumballSvg per ball: ${xnt(legacySvgRent)} XNT, total ${xnt(oracleRent + legacySvgRent)} XNT; no longer created)`);
  // Expected on a cluster with the standard rent (3480 lamports/byte-year x 2 years): oracle total 0.007224 XNT
  // (commit 0.001517 + mint 0.001462 + ATA 0.002039 + GumballData 0.002206), vs 0.017943 XNT with the GumballSvg.
  console.log("");

  // 2. Measured from the oracle's own transactions
  // Public RPCs often keep little or no history: then only the rent model is reported (rent is fixed
  // by account size, so it is exact; tx fees add ~0.00001 XNT per mint).
  const sigs = oracle ? (await conn.getSignaturesForAddress(oracle, { limit })).filter((s) => !s.err) : [];
  const stats = { commit: { n: 0, delta: 0n, fee: 0n }, reveal: { n: 0, delta: 0n, fee: 0n }, other: { n: 0, delta: 0n, fee: 0n } };
  let first, last;
  for (let i = 0; i < sigs.length; i += 25) {
    const txs = await Promise.all(sigs.slice(i, i + 25).map((s) => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })));
    for (const tx of txs) {
      if (!tx || !tx.meta) continue;
      const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
      const oi = keys.findIndex((k) => k.equals(oracle));
      if (oi < 0) continue;
      const kinds = new Set();
      for (const ix of tx.transaction.message.compiledInstructions || tx.transaction.message.instructions) {
        if (!keys[ix.programIdIndex].equals(PROGRAM_ID)) continue;
        const data = typeof ix.data === "string" ? Buffer.from(bs58.decode(ix.data)) : Buffer.from(ix.data);
        kinds.add(IX[data.subarray(0, 8).toString("hex")] || "other");
      }
      const kind = kinds.size === 1 ? [...kinds][0] : "other";
      const s = stats[kind];
      s.n++;
      // pre - post = what the oracle spent in this tx (negative if it received, e.g. treasury share when treasury==oracle)
      s.delta += BigInt(tx.meta.preBalances[oi]) - BigInt(tx.meta.postBalances[oi]);
      s.fee += oi === 0 ? BigInt(tx.meta.fee) : 0n;
      first = Math.min(first ?? tx.blockTime, tx.blockTime); last = Math.max(last ?? tx.blockTime, tx.blockTime);
    }
  }
  const avg = (s, f) => (s.n ? s[f] / BigInt(s.n) : 0n);
  const when = (t) => new Date(t * 1000).toLocaleString("en-US", { timeZone: "America/New_York" });
  console.log(`Measured: last ${sigs.length} oracle txs${first ? `, ${when(first)} → ${when(last)} ET` : ""}`);
  for (const k of ["commit", "reveal", "other"]) {
    const s = stats[k];
    console.log(`  ${k.padEnd(7)} ${String(s.n).padStart(4)} txs  avg net spend ${xnt(avg(s, "delta"))} XNT  avg fee ${xnt(avg(s, "fee"))} XNT`);
  }
  if (!stats.reveal.n) console.log("  no reveal transactions available from this RPC: verdict below uses the rent model");

  // 3. Verdict. The oracle's measured reveal spend is net of anything it received in the same tx, so
  //    when treasury == oracle it already includes the treasury's share; separate it back out.
  const treasuryShare = (price * TREASURY_BPS) / 10000n;
  const commitsPerReveal = stats.reveal.n ? Number(stats.commit.n) / Number(stats.reveal.n) : 1;
  const revealGross = stats.reveal.n ? avg(stats.reveal, "delta") + (oracle && treasury.equals(oracle) ? treasuryShare : 0n) : rent.nft_mint + rent.minter_ata + rent.gumball_data;
  const commitCost = stats.commit.n ? avg(stats.commit, "delta") : rent.oracle_commit;
  const perMint = revealGross + BigInt(Math.round(Number(commitCost) * Math.min(commitsPerReveal, 1)));
  const breakEven = (perMint * 10000n) / TREASURY_BPS;
  console.log(`\nPer mint at total_minted ${totalMinted}:`);
  console.log(`  price paid by minter      ${xnt(price)} XNT  (treasury 50% = ${xnt(treasuryShare)}, NFT pool 40%, LP pool 10%)`);
  console.log(`  oracle outlay             ${xnt(perMint)} XNT  (${stats.reveal.n ? "measured" : "rent model"}; commits/reveal ${commitsPerReveal.toFixed(2)})`);
  console.log(`  treasury net per mint     ${xnt(treasuryShare - perMint)} XNT`);
  console.log(`  break-even price          ${xnt(breakEven)} XNT  (treasury share = oracle outlay)`);
  console.log(`  price for 2x cover        ${xnt(breakEven * 2n)} XNT`);
  console.log("\nNotes: GumballData (+ the GumballSvg of legacy balls) rent comes back to the treasury only if burned balls are closed;");
  console.log("measured reveals made by the OLD program (before the upgrade) still include the GumballSvg rent.");
  console.log("OracleCommit rent is never returned by the current program; XNT price in $ is not included.");
})().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
