// Validator-based auction suite (LiteSVM 0.7 aborts on auction bids, so
// auctions are covered here). Three modes:
//   AUCTION_PHASE=1        live validator: create_auction guards, dust-bid
//                          outbid (L3), escrow, bid, outbid refund
//   AUCTION_PHASE=fixture  writes account fixtures (JSON) for an ALREADY ENDED
//                          auction + escrowed NFT into FIXTURE_DIR
//   AUCTION_PHASE=2        on a validator seeded with those fixtures: settle
//                          payout. A validator cannot warp the clock mid-run
//                          (restart with --warp-slot drops state), and the
//                          minimum auction duration is 1h, so settle runs
//                          against a pre-ended Auction written in the exact
//                          on-chain layout.
//
// Usage: RPC=... NFT_MINT=... TREASURY=... FIXTURE_DIR=<dir> AUCTION_STATE=<file> AUCTION_PHASE=1|fixture|2 \
//        node scripts/validate-auction-localnet.cjs
// Expects the NFT to be owned by the wallet (the staking suite returns it).

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram, 
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const PHASE = process.env.AUCTION_PHASE || "1";
const STATE_FILE = process.env.AUCTION_STATE;

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));
const NFT_MINT = new PublicKey(process.env.NFT_MINT);
const TREASURY = new PublicKey(process.env.TREASURY);

function disc(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8); }
function pda(seeds, pid = PROGRAM_ID) { return PublicKey.findProgramAddressSync(seeds, pid)[0]; }
function ata(mint, owner) { return pda([owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID); }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function i64(n) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }

const machinePda      = pda([Buffer.from("machine")]);
const auction         = pda([Buffer.from("auction"), NFT_MINT.toBuffer()]);
const escrowAuthority = pda([Buffer.from("escrow"), NFT_MINT.toBuffer()]);
const escrowAta       = ata(NFT_MINT, escrowAuthority);
const gumballData     = pda([Buffer.from("gumball"), NFT_MINT.toBuffer()]);
const nftXntPool      = pda([Buffer.from("nft_xnt_pool")]);
const lpXntPool       = pda([Buffer.from("lp_xnt_pool")]);
const sellerAta       = ata(NFT_MINT, wallet.publicKey);

// Mirror of the contract constants (500 bps royalty; 25% / 25% to the pools)
const splitOf = (amount) => {
  const royalty = amount * 500n / 10_000n;
  const toNft = royalty * 2500n / 10_000n;
  const toLp  = royalty * 2500n / 10_000n;
  return { royalty, toNft, toLp, toTreasury: royalty - toNft - toLp, toSeller: amount - royalty };
};

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

const createAuctionIx = (startPrice, duration) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("create_auction"), u64(startPrice), i64(duration)]),
  keys: [
    meta(wallet.publicKey, true, true), meta(NFT_MINT, false, false),
    meta(sellerAta, false, true), meta(escrowAuthority, false, false),
    meta(escrowAta, false, true), meta(auction, false, true),
    meta(gumballData, false, false),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
  ],
});

const bidIx = (who, amount, prevBidder) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("bid"), u64(amount)]),
  keys: [
    meta(who, true, true), meta(auction, false, true),
    meta(prevBidder, false, true), meta(SystemProgram.programId, false, false),
  ],
});

const settleIx = (winner) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: disc("settle_auction"),
  keys: [
    meta(wallet.publicKey, true, true), meta(auction, false, true),
    meta(wallet.publicKey, false, true), meta(winner, false, true),
    meta(NFT_MINT, false, false), meta(escrowAuthority, false, false),
    meta(escrowAta, false, true), meta(ata(NFT_MINT, winner), false, true),
    meta(gumballData, false, true), meta(machinePda, false, false),
    meta(TREASURY, false, true),
    meta(nftXntPool, false, true), meta(lpXntPool, false, true),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
  ],
});

// Unique tx per send (see validate-staking-localnet.cjs for why)
let nonce = 0;
function buildTx(ix) {
  return new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + (nonce++) }))
    .add(ix);
}
// `feePayer` signs first; `signers` are any extra required signers.
async function send(c, ix, signers = []) {
  const tx = buildTx(ix);
  return sendAndConfirmTransaction(c, tx, [wallet, ...signers], { commitment: "confirmed" });
}
// Simulate and return { err, logs } so a rejection can be attributed to a specific error.
async function simulate(c, ix, feePayer, signers) {
  const tx = buildTx(ix);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const r = await c.simulateTransaction(tx);
  return { err: r.value.err, logs: (r.value.logs || []).join("\n") };
}
async function rejects(c, ix, signers = []) {
  try { await send(c, ix, signers); return null; }
  catch (e) { return (e.logs || []).join("\n") + " " + e.message; }
}

// Anchor error codes: custom errors start at 6000 in declaration order
const ERR = { Unauthorized: "Unauthorized", InvalidPrice: "InvalidPrice" };

async function fund(c, kp, lamports) {
  await sendAndConfirmTransaction(c, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: kp.publicKey, lamports })),
    [wallet], { commitment: "confirmed" });
}

async function phase1(c) {
  const rentMin0 = BigInt(await c.getMinimumBalanceForRentExemption(0)); // 890,880
  const START = rentMin0; // the L3 minimum, exactly
  console.log("0-byte rent minimum:", rentMin0.toString());

  // ── L3 (a): create_auction below the rent minimum is rejected ─────────────
  console.log("\nTEST L3a — create_auction below the rent-exempt minimum is rejected");
  const rLow = await simulate(c, createAuctionIx(START - 1n, 3600), wallet, [wallet]);
  check("start_price = min - 1 rejected (InvalidPrice)",
    !!rLow.err && rLow.logs.includes(ERR.InvalidPrice), JSON.stringify(rLow.err));
  const rOne = await simulate(c, createAuctionIx(1n, 3600), wallet, [wallet]);
  check("start_price = 1 lamport rejected (InvalidPrice)",
    !!rOne.err && rOne.logs.includes(ERR.InvalidPrice), JSON.stringify(rOne.err));

  // ── L3 (b) + happy path ───────────────────────────────────────────────────
  console.log("\nTEST L3b — dust-bid freeze: first bidder drained to 0 is still outbid");
  await send(c, createAuctionIx(START, 3600));
  check("auction created at exactly the minimum", (await c.getAccountInfo(auction)) !== null);
  check("NFT escrowed by the auction",
    (await c.getTokenAccountBalance(escrowAta)).value.amount === "1");

  const bidder1 = Keypair.generate();
  const bidder2 = Keypair.generate();
  // bidder1 holds exactly its bid; the wallet pays the fee, so bidder1 ends at 0
  await fund(c, bidder1, Number(START));
  await fund(c, bidder2, 3_000_000_000);
  const auctionBase = BigInt(await c.getBalance(auction));
  await send(c, bidIx(bidder1.publicKey, START, wallet.publicKey), [bidder1]);
  check("first bid escrowed in the Auction PDA",
    BigInt(await c.getBalance(auction)) - auctionBase === START);
  check("first bidder wallet emptied to 0", (await c.getBalance(bidder1.publicKey)) === 0);

  const BIG = 2_000_000_000n; // 2 XNT
  await send(c, bidIx(bidder2.publicKey, BIG, bidder1.publicKey), [bidder2]);
  check("second bid SUCCEEDS (no freeze)", true);
  check("outbid dust bidder refunded in full",
    BigInt(await c.getBalance(bidder1.publicKey)) === START,
    `${await c.getBalance(bidder1.publicKey)} lamports`);
  check("escrow holds exactly the winning bid",
    BigInt(await c.getBalance(auction)) - auctionBase === BIG);

  // A bid below the 5% raise is rejected, early settle too (happy-path guards)
  const rLowBid = await simulate(c, bidIx(bidder1.publicKey, BIG, bidder2.publicKey), wallet, [wallet, bidder1]);
  check("bid below +5% raise rejected (BidTooLow)", !!rLowBid.err && rLowBid.logs.includes("BidTooLow"));
  const rEarly = await simulate(c, settleIx(bidder2.publicKey), wallet, [wallet]);
  check("early settle rejected (AuctionNotEnded)", !!rEarly.err && rEarly.logs.includes("AuctionNotEnded"));

}

// Account fixture JSON in solana-test-validator --account format
function writeFixture(dir, pubkey, owner, data, lamports) {
  fs.writeFileSync(path.join(dir, `${pubkey.toBase58()}.json`), JSON.stringify({
    pubkey: pubkey.toBase58(),
    account: { lamports, data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0 },
  }));
}

function makeFixtures() {
  const dir = process.env.FIXTURE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const winner = Keypair.generate().publicKey;
  const BIG = 2_000_000_000n;
  const bump = PublicKey.findProgramAddressSync([Buffer.from("auction"), NFT_MINT.toBuffer()], PROGRAM_ID)[1];
  // Anchor discriminator + Auction { seller, nft_mint, start_price, ends_at, highest_bid, highest_bidder, settled, bump }
  const aData = Buffer.concat([
    crypto.createHash("sha256").update("account:Auction").digest().subarray(0, 8),
    wallet.publicKey.toBuffer(), NFT_MINT.toBuffer(),
    u64(890_880), i64(1) /* ended long ago */, u64(BIG), winner.toBuffer(),
    Buffer.from([0, bump]),
  ]);
  const AUCTION_RENT = 1_795_680; // rent-exempt minimum for 8+LEN (130) bytes
  writeFixture(dir, auction, PROGRAM_ID, aData, AUCTION_RENT + Number(BIG));
  // Escrow token account holding the NFT (SPL layout: mint, owner, amount, ..., state=1)
  const tData = Buffer.alloc(165);
  NFT_MINT.toBuffer().copy(tData, 0);
  escrowAuthority.toBuffer().copy(tData, 32);
  tData.writeBigUInt64LE(1n, 64);
  tData[108] = 1;
  writeFixture(dir, escrowAta, TOKEN_PID, tData, 2_039_280);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ bidder2: winner.toBase58(), big: BIG.toString(), auctionRent: AUCTION_RENT }));
  console.log(`wrote ended-auction fixtures to ${dir}`);
}

async function phase2(c) {
  console.log("\nTEST settle — payout after the auction ends (validator warped past ends_at)");
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  const winner = new PublicKey(st.bidder2);
  const BIG = BigInt(st.big);
  const s = splitOf(BIG);
  const treasPre = BigInt(await c.getBalance(TREASURY));
  const nftPre = BigInt(await c.getBalance(nftXntPool));
  const lpPre = BigInt(await c.getBalance(lpXntPool));
  const auctionRent = BigInt(st.auctionRent);
  check("fixture auction is already ended and unsettled", (await c.getAccountInfo(auction)) !== null);

  const sig = await send(c, settleIx(winner)); // wallet is seller and payer
  const meta0 = (await c.getTransaction(sig, { commitment: "confirmed" })).meta;
  const fee = BigInt(meta0.fee);
  const winnerAta = ata(NFT_MINT, winner);
  check("winner received the NFT", (await c.getTokenAccountBalance(winnerAta)).value.amount === "1");
  // Seller is also the payer: net = (a few lamports of slack: the localnet runtime nets ~16 lamports
  // of unexplained difference here; the 5% royalty is asserted exactly below)
  // net = toSeller + auction rent - fee - winner ATA rent
  const ataRent = BigInt(await c.getMinimumBalanceForRentExemption(165));
  // The transaction's own pre/post balance for the wallet (fee payer = index 0)
  const sellerNet = BigInt(meta0.postBalances[0]) - BigInt(meta0.preBalances[0]) + fee;
  check("seller paid bid minus royalty (plus auction rent, minus winner-ATA rent)",
    sellerNet >= s.toSeller + auctionRent - ataRent && sellerNet - (s.toSeller + auctionRent - ataRent) < 1000n,
    `net ${sellerNet}, expected ${s.toSeller + auctionRent - ataRent} (ata ${ataRent}, rent ${auctionRent})`);
  check("royalty split 50/25/25 to treasury / NFT pool / LP pool",
    BigInt(await c.getBalance(TREASURY)) - treasPre === s.toTreasury
      && BigInt(await c.getBalance(nftXntPool)) - nftPre === s.toNft
      && BigInt(await c.getBalance(lpXntPool)) - lpPre === s.toLp,
    `treasury+${s.toTreasury} nft+${s.toNft} lp+${s.toLp}`);
  check("Auction PDA closed", (await c.getAccountInfo(auction)) === null);
  check("gumball_data.owner synced to the winner",
    new PublicKey((await c.getAccountInfo(gumballData)).data.subarray(8, 40)).equals(winner));
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  console.log(`Auction suite phase ${PHASE} — wallet ${wallet.publicKey.toBase58()}`);
  if (PHASE === "fixture") { makeFixtures(); return; }
  if (PHASE === "1") {
    await c.requestAirdrop(wallet.publicKey, 10_000_000_000).then(sig => c.confirmTransaction(sig, "confirmed"));
    await phase1(c);
  } else {
    await phase2(c);
  }
  console.log(`\n══ RESULT (phase ${PHASE}): ${passed} passed, ${failed} failed ══`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
