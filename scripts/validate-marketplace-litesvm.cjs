// In-process validation of the marketplace + auction instructions.
//
// Companion to scripts/validate-staking-localnet.cjs, which covers staking and
// XNT fee accounting against a real validator. This suite covers the
// value-bearing instructions that previously had NO automated coverage:
// list_gumball, delist_gumball, buy_gumball, create_auction, bid and
// settle_auction.
//
// Runs on LiteSVM rather than solana-test-validator: no validator process, no
// ledger, ~1s total, and the clock can be warped — the only practical way to
// test auction expiry. It also reports compute units per instruction.
//
// Each scenario runs in its OWN CHILD PROCESS with its own LiteSVM instance.
// That is good test hygiene, and here it is mandatory: LiteSVM 0.7 aborts the
// process with std::bad_alloc during teardown after any *failed* program
// invocation. Minimal reproducer:
//
//   svm.addProgramFromFile(PID, so);           // any Anchor program
//   ...send an instruction with a bogus discriminator...
//   // -> the error is returned correctly, then the process dies on teardown
//
// The error is delivered before the abort, so results printed by a child are
// trustworthy; the parent tolerates a non-zero child exit as long as the child
// reported SCENARIO_DONE. This is what makes the negative/rejection tests
// (which deliberately fail transactions) possible at all.
//
// Usage:
//   node scripts/make-localnet-fixtures.cjs        # once, clones live X1 state
//   node scripts/validate-marketplace-litesvm.cjs
//
// Requires a CURRENT target/deploy/gumball_nft.so (anchor build / cargo
// build-sbf). The slippage scenarios assert on specific Anchor error codes, so
// a stale binary fails them loudly rather than passing for the wrong reason.
const { LiteSVM } = require("litesvm");
const {
  PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RENT_PID   = new PublicKey("SysvarRent111111111111111111111111111111111");
const SO_PATH    = path.join(__dirname, "..", "target", "deploy", "gumball_nft.so");
const FIXTURES   = process.env.OUT_DIR || path.join(__dirname, "..", "localnet-fixtures");

const ROYALTY_BPS   = 500n;  // 5%
const FEE_NFT_ROYAL = 2500n; // 25% of the royalty
const FEE_LP_ROYAL  = 2500n; // 25% of the royalty

let passed = 0, failed = 0;
const cuReport = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const pda  = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const ata  = (mint, owner) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID)[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

const NFT_MINT = new PublicKey(
  fs.readFileSync(path.join(FIXTURES, "nft-mint-pubkey.txt"), "utf8").trim());

// Addresses are fixture-independent
const machinePda      = pda([Buffer.from("machine")]);
const gumballData     = pda([Buffer.from("gumball"), NFT_MINT.toBuffer()]);
const escrowAuthority = pda([Buffer.from("escrow"),  NFT_MINT.toBuffer()]);
const escrowAta       = ata(NFT_MINT, escrowAuthority);
const listing         = pda([Buffer.from("listing"), NFT_MINT.toBuffer()]);
const offerPda = (buyerPk) =>
  pda([Buffer.from("offer"), NFT_MINT.toBuffer(), buyerPk.toBuffer()]);
const auction         = pda([Buffer.from("auction"), NFT_MINT.toBuffer()]);
const nftXntPool      = pda([Buffer.from("nft_xnt_pool")]);
const lpXntPool       = pda([Buffer.from("lp_xnt_pool")]);

function loadFixture(name) {
  const j = JSON.parse(fs.readFileSync(path.join(FIXTURES, name + ".json"), "utf8"));
  return { pubkey: new PublicKey(j.pubkey), account: j.account };
}

// ── a fresh, fully seeded environment ───────────────────────────────────────
function newEnv() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM_ID, SO_PATH);

  const seller  = Keypair.generate();
  const buyer   = Keypair.generate();
  const bidder  = Keypair.generate();
  const bidder2 = Keypair.generate();
  for (const kp of [seller, buyer, bidder, bidder2]) {
    svm.airdrop(kp.publicKey, 100n * 1_000_000_000n);
  }

  const put = (name, patch) => {
    const { pubkey, account } = loadFixture(name);
    const data = Buffer.from(account.data[0], "base64");
    if (patch) patch(data);
    svm.setAccount(pubkey, {
      lamports: account.lamports, data,
      owner: new PublicKey(account.owner),
      executable: account.executable, rentEpoch: 0,
    });
  };
  for (const n of ["machine", "nft_mint", "nft_xnt_pool", "lp_xnt_pool"]) put(n);

  const dataOf = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
  const treasury = new PublicKey(dataOf(machinePda).subarray(40, 72));
  svm.airdrop(treasury, 1_000_000_000n); // must be rent-exempt to receive royalty

  // Rebind the fabricated gumball to a throwaway seller — the fixtures are
  // generated against the operator's own wallet and we never sign with it.
  put("gumball_data", (d) => { seller.publicKey.toBuffer().copy(d, 8); });
  const sellerAta = ata(NFT_MINT, seller.publicKey);
  {
    const { account } = loadFixture("user_ata");
    const d = Buffer.from(account.data[0], "base64");
    seller.publicKey.toBuffer().copy(d, 32);   // SPL token account: owner @32
    svm.setAccount(sellerAta, {
      lamports: account.lamports, data: d,
      owner: new PublicKey(account.owner), executable: false, rentEpoch: 0,
    });
  }

  // Placeholder for `prev_bidder` on the first bid: the handler only validates
  // it once a previous bid exists. Must NOT be the System Program — marking an
  // executable account writable is rejected before the program ever runs.
  const noBidder = Keypair.generate().publicKey;
  const env = { svm, seller, buyer, bidder, bidder2, treasury, sellerAta, dataOf, noBidder };

  env.send = (ix, signers, label) => {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const res = svm.sendTransaction(tx);
    svm.expireBlockhash();
    if (res && typeof res.err === "function" && res.err()) {
      throw new Error(String(res.toString()).slice(0, 300));
    }
    if (label && res && typeof res.computeUnitsConsumed === "function") {
      // Reading CU off some results trips the same LiteSVM teardown bug; the
      // measurement is a nice-to-have, never a reason to lose a scenario.
      try { cuReport.push([label, res.computeUnitsConsumed()]); } catch { /* skip */ }
    }
    return res;
  };
  env.bal = (pk) => BigInt(svm.getBalance(pk) ?? 0n);
  env.tokenAmount = (pk) => { const d = dataOf(pk); return d ? d.readBigUInt64LE(64) : null; };
  env.exists = (pk) => {
    const a = svm.getAccount(pk);
    return !!a && a.data.length > 0 && BigInt(a.lamports) > 0n;
  };
  env.warp = (secs) => {
    const c = svm.getClock();
    c.unixTimestamp = c.unixTimestamp + BigInt(secs);
    svm.setClock(c);
  };
  return env;
}

// ── instruction builders ────────────────────────────────────────────────────
const listIx = (e, price) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("list_gumball"), u64(price)]),
  keys: [
    meta(e.seller.publicKey, true, true), meta(machinePda, false, false),
    meta(NFT_MINT, false, false), meta(e.sellerAta, false, true),
    meta(escrowAuthority, false, false), meta(escrowAta, false, true),
    meta(listing, false, true), meta(gumballData, false, true),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(RENT_PID, false, false),
  ],
});

const delistIx = (e) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: disc("delist_gumball"),
  keys: [
    meta(e.seller.publicKey, true, true), meta(NFT_MINT, false, false),
    meta(listing, false, true), meta(escrowAuthority, false, false),
    meta(escrowAta, false, true), meta(e.sellerAta, false, true),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(RENT_PID, false, false),
  ],
});

// maxPrice defaults to the listed price — i.e. an honest buyer paying what
// they were shown. Pass a lower value to simulate a seller raising the price
// after the buyer committed.
const buyIx = (e, who, maxPrice = PRICE) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("buy_gumball"), u64(maxPrice)]),
  keys: [
    meta(who.publicKey, true, true), meta(e.seller.publicKey, false, true),
    meta(machinePda, false, false), meta(e.treasury, false, true),
    meta(NFT_MINT, false, false), meta(listing, false, true),
    meta(escrowAuthority, false, false), meta(escrowAta, false, true),
    meta(ata(NFT_MINT, who.publicKey), false, true), meta(gumballData, false, true),
    meta(nftXntPool, false, true), meta(lpXntPool, false, true),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(RENT_PID, false, false),
  ],
});

const makeOfferIx = (e, who, amount, expireSecs) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("make_offer"), u64(amount), i64(expireSecs)]),
  keys: [
    meta(who.publicKey, true, true), meta(NFT_MINT, false, false),
    meta(offerPda(who.publicKey), false, true),
    meta(SystemProgram.programId, false, false),
  ],
});

// minAmount defaults to the offer amount — an honest seller accepting what they
// were shown. A higher value simulates the buyer shrinking the offer first.
const acceptOfferIx = (e, buyerKp, amount, minAmount = amount) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("accept_offer"), u64(minAmount)]),
  keys: [
    meta(e.seller.publicKey, true, true), meta(buyerKp.publicKey, false, true),
    meta(machinePda, false, false), meta(e.treasury, false, true),
    meta(NFT_MINT, false, false), meta(offerPda(buyerKp.publicKey), false, true),
    meta(e.sellerAta, false, true), meta(ata(NFT_MINT, buyerKp.publicKey), false, true),
    meta(gumballData, false, true),
    meta(nftXntPool, false, true), meta(lpXntPool, false, true),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(RENT_PID, false, false),
  ],
});

const createAuctionIx = (e, startPrice, duration) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("create_auction"), u64(startPrice), i64(duration)]),
  keys: [
    meta(e.seller.publicKey, true, true), meta(NFT_MINT, false, false),
    meta(e.sellerAta, false, true), meta(escrowAuthority, false, false),
    meta(escrowAta, false, true), meta(auction, false, true),
    meta(gumballData, false, false),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(RENT_PID, false, false),
  ],
});

const bidIx = (who, amount, prevBidder) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([disc("bid"), u64(amount)]),
  keys: [
    meta(who.publicKey, true, true), meta(auction, false, true),
    meta(prevBidder, false, true), meta(SystemProgram.programId, false, false),
  ],
});

const settleIx = (e, payer, winner) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: disc("settle_auction"),
  keys: [
    meta(payer.publicKey, true, true), meta(auction, false, true),
    meta(e.seller.publicKey, false, true), meta(winner, false, true),
    meta(NFT_MINT, false, false), meta(escrowAuthority, false, false),
    meta(escrowAta, false, true), meta(ata(NFT_MINT, winner), false, true),
    meta(gumballData, false, true), meta(machinePda, false, false),
    meta(e.treasury, false, true),
    meta(nftXntPool, false, true), meta(lpXntPool, false, true),
    meta(TOKEN_PID, false, false), meta(ASSOC_PID, false, false),
    meta(SystemProgram.programId, false, false), meta(RENT_PID, false, false),
  ],
});

// Anchor custom error codes (6000 + variant index in GumballError)
const ERR = { PriceAboveMax: 6025, AmountBelowMin: 6026 };

// Run `fn`, expecting it to fail with a SPECIFIC program error. Asserting on
// the code matters here: against a program built before these arguments
// existed, the instruction also fails — but on argument deserialization, not on
// the guard. Only the code distinguishes "the guard worked" from "this binary
// predates the guard".
function expectErr(label, code, fn) {
  let msg = null;
  try { fn(); } catch (e) { msg = String(e.message); }
  if (msg === null) return check(label, false, "transaction unexpectedly succeeded");
  const hit = msg.includes(`Custom(${code})`) || msg.includes(`custom program error: 0x${code.toString(16)}`);
  check(label, hit, hit ? `error ${code}` : `wrong failure: ${msg.slice(0, 140)}`);
}

const PRICE = 2_000_000_000n; // 2 XNT
const splitOf = (amount) => {
  const royalty = amount * ROYALTY_BPS / 10_000n;
  const toNft = royalty * FEE_NFT_ROYAL / 10_000n;
  const toLp  = royalty * FEE_LP_ROYAL / 10_000n;
  return { royalty, toNft, toLp, toTreasury: royalty - toNft - toLp, toSeller: amount - royalty };
};

// ── scenarios ───────────────────────────────────────────────────────────────
function testListEscrow() {
  console.log("\nTEST 1 — list_gumball escrows the NFT and records the price");
  const e = newEnv();
  e.send(listIx(e, PRICE), [e.seller], "list_gumball");
  check("NFT left the seller ATA", e.tokenAmount(e.sellerAta) === 0n);
  check("NFT sits in the escrow ATA", e.tokenAmount(escrowAta) === 1n);
  check("Listing PDA created", e.exists(listing));
  check("listing.price recorded", e.dataOf(listing).readBigUInt64LE(72) === PRICE,
    `price=${e.dataOf(listing).readBigUInt64LE(72)}`);
  check("listing.seller recorded",
    new PublicKey(e.dataOf(listing).subarray(8, 40)).equals(e.seller.publicKey));
}

function testDelistReturns() {
  console.log("\nTEST 2 — delist_gumball returns the NFT and closes the Listing");
  const e = newEnv();
  e.send(listIx(e, PRICE), [e.seller]);
  const before = e.bal(e.seller.publicKey);
  e.send(delistIx(e), [e.seller], "delist_gumball");
  check("NFT back with the seller", e.tokenAmount(e.sellerAta) === 1n);
  check("Listing PDA closed", !e.exists(listing));
  check("listing rent refunded to the seller", e.bal(e.seller.publicKey) > before,
    `Δ +${e.bal(e.seller.publicKey) - before}`);
}

function testDelistNotSeller() {
  console.log("\nTEST 3 — only the lister can delist");
  const e = newEnv();
  e.send(listIx(e, PRICE), [e.seller]);
  const ix = delistIx(e);
  ix.keys[0] = meta(e.buyer.publicKey, true, true);                 // impostor signer
  ix.keys[5] = meta(ata(NFT_MINT, e.buyer.publicKey), false, true); // ...to their own ATA
  let rejected = false;
  try { e.send(ix, [e.buyer]); } catch { rejected = true; }
  check("delist by a non-seller rejected", rejected);
  check("NFT still escrowed", e.tokenAmount(escrowAta) === 1n);
}

function testBuyRoyaltySplit() {
  console.log("\nTEST 4 — buy_gumball pays the seller and splits the 5% royalty 50/25/25");
  const e = newEnv();
  e.send(listIx(e, PRICE), [e.seller]);
  const s = splitOf(PRICE);
  const sellerBefore = e.bal(e.seller.publicKey);
  const treasBefore  = e.bal(e.treasury);
  const nftBefore    = e.bal(nftXntPool);
  const lpBefore     = e.bal(lpXntPool);
  e.send(buyIx(e, e.buyer), [e.buyer], "buy_gumball");

  check("seller received price minus royalty (plus listing rent)",
    e.bal(e.seller.publicKey) - sellerBefore >= s.toSeller,
    `+${e.bal(e.seller.publicKey) - sellerBefore} >= ${s.toSeller}`);
  check("treasury received 50% of the royalty",
    e.bal(e.treasury) - treasBefore === s.toTreasury,
    `+${e.bal(e.treasury) - treasBefore} expected ${s.toTreasury}`);
  check("NFT staker pool received 25% of the royalty",
    e.bal(nftXntPool) - nftBefore === s.toNft,
    `+${e.bal(nftXntPool) - nftBefore} expected ${s.toNft}`);
  check("LP staker pool received 25% of the royalty",
    e.bal(lpXntPool) - lpBefore === s.toLp,
    `+${e.bal(lpXntPool) - lpBefore} expected ${s.toLp}`);
  check("royalty fully accounted for — no lamports lost",
    (e.bal(e.treasury) - treasBefore) + (e.bal(nftXntPool) - nftBefore)
      + (e.bal(lpXntPool) - lpBefore) === s.royalty, `royalty=${s.royalty}`);
  check("buyer holds the NFT", e.tokenAmount(ata(NFT_MINT, e.buyer.publicKey)) === 1n);
  check("escrow emptied", e.tokenAmount(escrowAta) === 0n);
  check("Listing PDA closed", !e.exists(listing));
  check("gumball_data.owner synced to the buyer",
    new PublicKey(e.dataOf(gumballData).subarray(8, 40)).equals(e.buyer.publicKey));
}

function testBuyWrongSellerRejected() {
  console.log("\nTEST 5 — buy_gumball cannot redirect the seller's proceeds");
  const e = newEnv();
  e.send(listIx(e, PRICE), [e.seller]);
  const ix = buyIx(e, e.buyer);
  ix.keys[1] = meta(e.bidder.publicKey, false, true);  // attacker-substituted payee
  let rejected = false;
  try { e.send(ix, [e.buyer]); } catch { rejected = true; }
  check("substituted seller account rejected", rejected);
  check("NFT still escrowed", e.tokenAmount(escrowAta) === 1n);
}

// NOTE ON SCENARIO SHAPE: LiteSVM 0.7 aborts the process shortly after a failed
// program invocation, so a scenario may contain AT MOST ONE deliberately
// failing transaction, and it must be the last thing it does. Negative cases
// therefore each get their own scenario.

function testAuctionLifecycle() {
  console.log("\nTEST 6 — auction: escrow, bid, outbid refund, settle payout");
  const e = newEnv();
  const START = 1_000_000_000n; // 1 XNT
  e.send(createAuctionIx(e, START, 3600), [e.seller], "create_auction");
  check("NFT escrowed by the auction", e.tokenAmount(escrowAta) === 1n);
  check("Auction PDA created", e.exists(auction));

  const auctionBase = e.bal(auction);
  e.send(bidIx(e.bidder, START, e.noBidder), [e.bidder]);
  check("first bid escrowed in the Auction PDA",
    e.bal(auction) - auctionBase === START, `+${e.bal(auction) - auctionBase}`);

  const prevBal = e.bal(e.bidder.publicKey);
  const RAISE = START + START / 20n; // exactly +5%
  e.send(bidIx(e.bidder2, RAISE, e.bidder.publicKey), [e.bidder2]);
  check("outbid bidder refunded in full",
    e.bal(e.bidder.publicKey) - prevBal === START,
    `+${e.bal(e.bidder.publicKey) - prevBal} expected ${START}`);
  check("escrow holds exactly the winning bid",
    e.bal(auction) - auctionBase === RAISE, `+${e.bal(auction) - auctionBase}`);

  e.warp(3601);
  const s = splitOf(RAISE);
  const sellerPre = e.bal(e.seller.publicKey);
  const treasPre  = e.bal(e.treasury);
  const nftPre    = e.bal(nftXntPool);
  const lpPre     = e.bal(lpXntPool);
  e.send(settleIx(e, e.buyer, e.bidder2.publicKey), [e.buyer]); // permissionless crank
  check("winner received the NFT", e.tokenAmount(ata(NFT_MINT, e.bidder2.publicKey)) === 1n);
  check("seller paid the bid minus royalty (plus auction rent)",
    e.bal(e.seller.publicKey) - sellerPre >= s.toSeller,
    `+${e.bal(e.seller.publicKey) - sellerPre} >= ${s.toSeller}`);
  check("auction royalty split matches buy_gumball routing",
    (e.bal(e.treasury) - treasPre) === s.toTreasury
      && (e.bal(nftXntPool) - nftPre) === s.toNft
      && (e.bal(lpXntPool) - lpPre) === s.toLp,
    `treasury+${e.bal(e.treasury) - treasPre} nft+${e.bal(nftXntPool) - nftPre} lp+${e.bal(lpXntPool) - lpPre}`);
  check("Auction PDA closed", !e.exists(auction));
  check("gumball_data.owner synced to the winner",
    new PublicKey(e.dataOf(gumballData).subarray(8, 40)).equals(e.bidder2.publicKey));
}

function testAuctionMinRaise() {
  console.log("\nTEST 7 — a bid below the +5% minimum raise is rejected");
  const e = newEnv();
  const START = 1_000_000_000n;
  e.send(createAuctionIx(e, START, 3600), [e.seller]);
  e.send(bidIx(e.bidder, START, e.noBidder), [e.bidder]);
  const escrowed = e.bal(auction);
  let rejected = false;
  try { e.send(bidIx(e.bidder2, START + 1n, e.bidder.publicKey), [e.bidder2]); }
  catch { rejected = true; }
  check("bid below +5% rejected (BidTooLow)", rejected);
  check("escrow unchanged by the rejected bid", e.bal(auction) === escrowed);
}

function testAuctionEarlySettle() {
  console.log("\nTEST 8 — settle before the end time is rejected");
  const e = newEnv();
  const START = 1_000_000_000n;
  e.send(createAuctionIx(e, START, 3600), [e.seller]);
  e.send(bidIx(e.bidder, START, e.noBidder), [e.bidder]);
  let rejected = false;
  try { e.send(settleIx(e, e.buyer, e.bidder.publicKey), [e.buyer]); }
  catch { rejected = true; }
  check("early settle rejected (AuctionNotEnded)", rejected);
  check("NFT still escrowed", e.tokenAmount(escrowAta) === 1n);
}

function testAuctionNoBidsReturnsNft() {
  console.log("\nTEST 9 — an auction with no bids returns the NFT to the seller");
  const e = newEnv();
  e.send(createAuctionIx(e, 1_000_000_000n, 3600), [e.seller]);
  e.warp(3601);
  e.send(settleIx(e, e.buyer, e.seller.publicKey), [e.buyer]);
  check("NFT returned to the seller", e.tokenAmount(e.sellerAta) === 1n);
  check("Auction PDA closed", !e.exists(auction));
}

function testAuctionWrongWinnerRejected() {
  console.log("\nTEST 10 — settle cannot hand the NFT to a non-winner");
  const e = newEnv();
  const START = 1_000_000_000n;
  e.send(createAuctionIx(e, START, 3600), [e.seller]);
  e.send(bidIx(e.bidder, START, e.noBidder), [e.bidder]);
  e.warp(3601);
  let rejected = false;
  try { e.send(settleIx(e, e.buyer, e.buyer.publicKey), [e.buyer]); } catch { rejected = true; }
  check("settling to a non-winner rejected", rejected);
  check("NFT still escrowed", e.tokenAmount(escrowAta) === 1n);
}

function testBuySlippageGuard() {
  console.log("\nTEST 11 — H1: buy_gumball rejects a price above the buyer's max");
  const e = newEnv();
  // The real-world vector is delist + relist at a higher price: the Listing PDA
  // is derived from the mint alone, so it is recreated at the SAME address and
  // an in-flight buy still resolves against it. That close+reinit sequence trips
  // the LiteSVM abort documented above, so the guard is exercised directly —
  // list high, then buy with the max_price the victim would have been shown.
  const SHOWN = PRICE;
  const RAISED = PRICE * 100n;
  e.send(listIx(e, RAISED), [e.seller]);
  const buyerBefore = e.bal(e.buyer.publicKey);
  const treasBefore = e.bal(e.treasury);
  expectErr("buy above max_price rejected (PriceAboveMax)", ERR.PriceAboveMax,
    () => e.send(buyIx(e, e.buyer, SHOWN), [e.buyer]));
  // The buyer still pays the transaction fee; what must not move is the price.
  const spent = buyerBefore - e.bal(e.buyer.publicKey);
  check("buyer was not charged the listing price", spent < 1_000_000n, `spent=${spent} lamports`);
  check("no royalty reached the treasury", e.bal(e.treasury) === treasBefore);
  check("NFT still escrowed", e.tokenAmount(escrowAta) === 1n);
}

function testOfferAcceptPays() {
  console.log("\nTEST 12 — make_offer escrows and accept_offer pays out");
  const e = newEnv();
  const AMOUNT = 1_500_000_000n;
  e.send(makeOfferIx(e, e.buyer, AMOUNT, 3600), [e.buyer], "make_offer");
  check("Offer PDA created", e.exists(offerPda(e.buyer.publicKey)));
  check("offer escrowed the XNT",
    e.bal(offerPda(e.buyer.publicKey)) >= AMOUNT, `escrow=${e.bal(offerPda(e.buyer.publicKey))}`);

  const s = splitOf(AMOUNT);
  const sellerPre = e.bal(e.seller.publicKey);
  const treasPre  = e.bal(e.treasury);
  const nftPre    = e.bal(nftXntPool);
  const lpPre     = e.bal(lpXntPool);
  const res = e.send(acceptOfferIx(e, e.buyer, AMOUNT), [e.seller], "accept_offer");
  // Exact accounting. The seller signs (pays the 5000-lamport fee) AND funds
  // the buyer's ATA: AcceptOffer declares buyer_ata `init_if_needed, payer =
  // seller`. So seller delta == toSeller - buyerAtaRent - fee, to the lamport.
  // (Contrast buy_gumball, where the buyer pays for their own ATA.)
  const buyerAtaRent = e.bal(ata(NFT_MINT, e.buyer.publicKey));
  const sellerDelta  = e.bal(e.seller.publicKey) - sellerPre;
  const fee = 5000n;
  check("seller received offer minus royalty, minus the buyer-ATA rent it funded, minus fee",
    sellerDelta === s.toSeller - buyerAtaRent - fee,
    `delta=${sellerDelta} == ${s.toSeller} - ${buyerAtaRent} - ${fee}`);
  check("offer royalty split matches buy_gumball routing",
    (e.bal(e.treasury) - treasPre) === s.toTreasury
      && (e.bal(nftXntPool) - nftPre) === s.toNft
      && (e.bal(lpXntPool) - lpPre) === s.toLp,
    `treasury+${e.bal(e.treasury) - treasPre} nft+${e.bal(nftXntPool) - nftPre} lp+${e.bal(lpXntPool) - lpPre}`);
  check("buyer received the NFT", e.tokenAmount(ata(NFT_MINT, e.buyer.publicKey)) === 1n);
  check("gumball_data.owner synced to the buyer",
    new PublicKey(e.dataOf(gumballData).subarray(8, 40)).equals(e.buyer.publicKey));
}

function testOfferSlippageGuard() {
  console.log("\nTEST 13 — H1: accept_offer rejects an amount below the seller's min");
  const e = newEnv();
  const SHRUNK = 1_000_000n;      // what the buyer actually left on chain
  const SHOWN  = 1_500_000_000n;  // what the seller was shown
  e.send(makeOfferIx(e, e.buyer, SHRUNK, 3600), [e.buyer]);
  const sellerBefore = e.bal(e.seller.publicKey);
  expectErr("accept below min_amount rejected (AmountBelowMin)", ERR.AmountBelowMin,
    () => e.send(acceptOfferIx(e, e.buyer, SHRUNK, SHOWN), [e.seller]));
  check("seller still holds the NFT", e.tokenAmount(e.sellerAta) === 1n);
  // Seller pays only the transaction fee; the shrunken offer is not credited.
  const gained = e.bal(e.seller.publicKey) - sellerBefore;
  check("seller was not paid the shrunken amount", gained <= 0n, `delta=${gained}`);
}

const SCENARIOS = {
  list:             testListEscrow,
  delist:           testDelistReturns,
  "delist-auth":    testDelistNotSeller,
  "buy-royalty":    testBuyRoyaltySplit,
  "buy-auth":       testBuyWrongSellerRejected,
  auction:            testAuctionLifecycle,
  "auction-minraise": testAuctionMinRaise,
  "auction-early":    testAuctionEarlySettle,
  "auction-nobids":   testAuctionNoBidsReturnsNft,
  "auction-auth":     testAuctionWrongWinnerRejected,
  "buy-slippage":     testBuySlippageGuard,
  "offer-accept":     testOfferAcceptPays,
  "offer-slippage":   testOfferSlippageGuard,
};

function runChildScenario(name) {
  SCENARIOS[name]();
  for (const [label, cu] of cuReport) console.log(`CU ${cu} ${label}`);
  console.log(`SCENARIO_DONE ${passed} ${failed}`);
  // Do not fall through to teardown-sensitive cleanup; see header note.
  process.stdout.write("", () => process.kill(process.pid, "SIGKILL"));
}

function runSuite() {
  const { spawnSync } = require("child_process");
  console.log("LiteSVM marketplace + auction validation");
  console.log("program :", PROGRAM_ID.toBase58());
  console.log("nft mint:", NFT_MINT.toBase58());

  let totalPass = 0, totalFail = 0;
  const cus = [];
  const ATTEMPTS = Number(process.env.SCENARIO_ATTEMPTS || 4);
  for (const name of Object.keys(SCENARIOS)) {
    // The LiteSVM abort is non-deterministic, so retry a scenario that dies
    // before reporting. A scenario that completes is authoritative; only the
    // abort is flaky, never the assertions.
    let r, out, done;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      r = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, SCENARIO: name }, encoding: "utf8",
      });
      out = (r.stdout || "").split("\n");
      done = out.find((l) => l.startsWith("SCENARIO_DONE"));
      if (done) break;
    }
    for (const line of out) {
      if (line.startsWith("CU ")) { const [, cu, ...lbl] = line.split(" "); cus.push([lbl.join(" "), cu]); }
      else if (line.trim() && !line.startsWith("SCENARIO_DONE")) console.log(line);
    }
    if (!done) {
      totalFail++;
      console.log(`  FAIL  scenario "${name}" did not complete`);
      if (r.stderr) console.log("        " + r.stderr.trim().split("\n").slice(-2).join(" | "));
      continue;
    }
    const [, p, f] = done.split(" ");
    totalPass += Number(p); totalFail += Number(f);
  }

  if (cus.length) {
    console.log("\nCompute units");
    for (const [label, cu] of cus) console.log(`  ${String(cu).padStart(7)}  ${label}`);
  }
  console.log(`\n══ RESULT: ${totalPass} passed, ${totalFail} failed ══`);
  process.exit(totalFail === 0 ? 0 : 1);
}

if (process.env.SCENARIO) runChildScenario(process.env.SCENARIO);
else runSuite();
