// close_burned validation against a LOCAL validator (see scripts/ci-e2e.sh).
//
// close_burned is permissionless: it closes ONE burned ball's GumballData + GumballSvg and sends all
// their lamports to machine.treasury (never to the caller). This suite proves
//   1. every refusal, with its exact error code, and that a refused call moves nothing:
//        live ball, token burned but owner field still set, mint authority not machine_authority
//        or revoked, forged GumballData / GumballSvg (not program-owned, other machine, bad
//        discriminator), wrong treasury, a GumballData / GumballSvg / machine_authority of another
//        address, an nft_mint that is not a token mint
//   2. happy path: the treasury gains exactly the two accounts' lamports (including donated ones),
//      both accounts are gone, the event reports it, and the rent counters on Machine are untouched
//   3. a closed account cannot be revived (a later transfer to the address leaves a system account
//      with no data) and a second close is refused
//   4. a legacy 93-byte GumballData closes too
//   5. a caller that is NOT the burner works and only pays the fee; the burner's balance is unchanged
//   6. several balls close in one transaction
//   7. balls burned by the real burn_to_upgrade (2 balls) and burn_multi (5 balls) are closable, and
//      the upgrade's output ball is refused (it is not burned)
//
// Usage: RPC=http://127.0.0.1:8899 CB_DIR=<make-close-burned-fixtures.cjs outDir> node scripts/validate-close-burned-localnet.cjs
// The wallet (default key, or WALLET) must be the one the fixtures were built for: it owns the live
// balls and pays for the burns. Run with a throwaway HOME / WALLET.

const {
  Connection, PublicKey, Transaction, TransactionInstruction, Keypair, SystemProgram,
  SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { errCode } = require("./lib/gumball-errors.cjs");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const CONSTRAINT_SEEDS = 2006; // Anchor ConstraintSeeds

const info = JSON.parse(fs.readFileSync(path.join(process.env.CB_DIR, "info.json"), "utf-8"));
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));
const c = new Connection(RPC, "confirmed");
const pk = (s) => new PublicKey(s);
const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().slice(0, 8);
const evDisc = (n) => crypto.createHash("sha256").update(`event:${n}`).digest().slice(0, 8);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const ata = (mint, owner) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID)[0];
const MACHINE = pda([Buffer.from("machine")]);
const MACHINE_AUTH = pda([Buffer.from("machine_authority")]);
const TREASURY = pk(info.treasury);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else      { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

const gdOf = (mint) => pda([Buffer.from("gumball"), mint.toBuffer()]);
const svgOf = (mint) => pda([Buffer.from("svg"), mint.toBuffer()]);
const bal = (a) => c.getBalance(typeof a === "string" ? pk(a) : a);

// close_burned accounts: machine, machine_authority, treasury(w), nft_mint, gumball_data(w), gumball_svg(w)
function closeIx(ball, o = {}) {
  const mint = o.mint || pk(ball.mint);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: MACHINE, isSigner: false, isWritable: false },
      { pubkey: o.machineAuth || MACHINE_AUTH, isSigner: false, isWritable: false },
      { pubkey: o.treasury || TREASURY, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: o.gd || pk(ball.gd), isSigner: false, isWritable: true },
      { pubkey: o.svg || pk(ball.svg), isSigner: false, isWritable: true },
    ],
    data: disc("close_burned"),
  });
}
async function attempt(ixs, signer = wallet) {
  try {
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(...ixs), [signer], { commitment: "confirmed" });
    return { ok: true, sig, text: "" };
  } catch (e) { return { ok: false, text: String(e.message) + JSON.stringify(e.logs || e.transactionLogs || []) }; }
}
const hasCode = (text, code) => text.includes(`Error Number: ${code}`) || text.includes(`custom program error: 0x${code.toString(16)}`);
async function logsOf(sig) {
  const tx = await c.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { logs: tx.meta.logMessages, fee: tx.meta.fee, cu: tx.meta.computeUnitsConsumed };
}
// BurnedClosedEvent: nft_mint(32) lamports(u64)
function closedEvents(logs) {
  const d = evDisc("BurnedClosedEvent");
  return logs.filter((l) => l.startsWith("Program data: ")).map((l) => Buffer.from(l.slice(14), "base64"))
    .filter((b) => b.subarray(0, 8).equals(d))
    .map((b) => ({ mint: new PublicKey(b.subarray(8, 40)).toBase58(), lamports: Number(b.readBigUInt64LE(40)) }));
}
const lamportsOf = async (ball) => (await bal(ball.gd)) + (await bal(ball.svg));
const gone = async (a) => (await c.getAccountInfo(typeof a === "string" ? pk(a) : a)) === null;
const machineBurned = async () => Number((await c.getAccountInfo(MACHINE)).data.readBigUInt64LE(130));

// ── real burns ───────────────────────────────────────────────────────────────
async function burn(kind, balls) {
  const newMint = Keypair.generate();
  const newAta = ata(newMint.publicKey, wallet.publicKey);
  const machine = await c.getAccountInfo(MACHINE);
  // burn_to_upgrade: head, (gumball, mint, ata) x2, new_*; burn_multi: head, (gumball, mint, ata), new_*, remaining (mint, ata, gumball) x4
  const keysHead = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: MACHINE, isSigner: false, isWritable: true },
    { pubkey: MACHINE_AUTH, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(machine.data.subarray(40, 72)), isSigner: false, isWritable: true },
  ];
  const ballKeys = (b) => [
    { pubkey: pk(b.gd), isSigner: false, isWritable: true },
    { pubkey: pk(b.mint), isSigner: false, isWritable: true },
    { pubkey: pk(b.ata), isSigner: false, isWritable: true },
  ];
  const keysNew = [
    { pubkey: newMint.publicKey, isSigner: true, isWritable: true },
    { pubkey: newAta, isSigner: false, isWritable: true },
    { pubkey: gdOf(newMint.publicKey), isSigner: false, isWritable: true },
    { pubkey: svgOf(newMint.publicKey), isSigner: false, isWritable: true },
    { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from("nft_xnt_pool")]), isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from("lp_xnt_pool")]), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    { pubkey: ASSOC_PID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  let keys;
  if (kind === "burn_to_upgrade") keys = [...keysHead, ...ballKeys(balls[0]), ...ballKeys(balls[1]), ...keysNew];
  else keys = [...keysHead, ...ballKeys(balls[0]), ...keysNew,
    ...balls.slice(1).flatMap((b) => [
      { pubkey: pk(b.mint), isSigner: false, isWritable: true },
      { pubkey: pk(b.ata), isSigner: false, isWritable: true },
      { pubkey: pk(b.gd), isSigner: false, isWritable: true },
    ])];
  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([disc(kind), crypto.randomBytes(32)]) });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [wallet, newMint], { commitment: "confirmed" });
  return { sig, newMint: newMint.publicKey };
}

(async () => {
  console.log(`close_burned validation — wallet/burner ${wallet.publicKey.toBase58()}, treasury ${TREASURY.toBase58()}`);
  if (wallet.publicKey.toBase58() !== info.wallet) { console.error("wallet is not the one the fixtures were built for"); process.exit(2); }
  const K = info.cases;

  console.log("\nfixtures are in the on-chain layout");
  for (const n of ["b1", "b2", "live"]) {
    const gd = await c.getAccountInfo(pk(K[n].gd)), svg = await c.getAccountInfo(pk(K[n].svg));
    check(`${n}: GumballData ${n === "b2" ? 93 : 189} bytes + GumballSvg 1412 bytes, both program-owned`,
      gd && svg && gd.data.length === (n === "b2" ? 93 : 189) && svg.data.length === 1412 && gd.owner.equals(PROGRAM_ID) && svg.owner.equals(PROGRAM_ID));
  }
  check("b1 holds the donated 1000 lamports on top of rent", (await bal(K.b1.gd)) === (128 + 189) * 6960 + 1000);

  console.log("\nrefusals (exact codes) — nothing may move");
  const tracked = ["b1", "b3", "live", "stale", "foreign", "noauth", "fgd_sys", "fgd_machine", "fgd_disc", "fsvg_sys", "fsvg_disc"];
  const snap = async () => { const o = { treasury: await bal(TREASURY) }; for (const n of tracked) o[n] = await lamportsOf(K[n]); return o; };
  const before = await snap();
  const refuse = async (label, ix, code) => {
    const r = await attempt([ix]);
    check(`${label} refused with ConstraintSeeds`, !r.ok && hasCode(r.text, code), r.ok ? "SUCCEEDED" : (hasCode(r.text, code) ? String(code) : r.text.slice(0, 160)));
  };
  const named = async (label, ball, name, o) => {
    const r = await attempt([closeIx(K[ball], o)]);
    check(`${label} refused with ${name}`, !r.ok && hasCode(r.text, errCode(name)), r.ok ? "SUCCEEDED" : String(errCode(name)));
  };
  await named("live ball (supply 1)", "live", "NotBurned");
  await named("token burned but owner field still set", "stale", "NotBurned");
  await named("mint authority is another key", "foreign", "NotGumballMint");
  await named("mint authority revoked", "noauth", "NotGumballMint");
  await named("GumballData not program-owned", "fgd_sys", "InvalidAccount");
  await named("GumballData names another machine", "fgd_machine", "InvalidAccount");
  await named("GumballData with the wrong discriminator", "fgd_disc", "InvalidAccount");
  await named("GumballSvg not program-owned", "fsvg_sys", "InvalidAccount");
  await named("GumballSvg with the wrong discriminator", "fsvg_disc", "InvalidAccount");
  await named("wrong treasury (the burner)", "b1", "InvalidTreasury", { treasury: wallet.publicKey });
  await refuse("GumballData of another ball", closeIx(K.b3, { gd: pk(K.b1.gd) }), CONSTRAINT_SEEDS);
  await refuse("GumballSvg of another ball", closeIx(K.b3, { svg: pk(K.b1.svg) }), CONSTRAINT_SEEDS);
  await refuse("GumballData and GumballSvg swapped", closeIx(K.b3, { gd: pk(K.b3.svg), svg: pk(K.b3.gd) }), CONSTRAINT_SEEDS);
  await refuse("machine_authority that is not the PDA", closeIx(K.b3, { machineAuth: wallet.publicKey }), CONSTRAINT_SEEDS);
  const notMint = closeIx(K.b3, { mint: wallet.publicKey, gd: gdOf(wallet.publicKey), svg: svgOf(wallet.publicKey) });
  let r = await attempt([notMint]);
  check("nft_mint that is not a token mint refused", !r.ok, r.ok ? "SUCCEEDED" : r.text.slice(0, 120));
  const after = await snap();
  check("no refused call moved a lamport", JSON.stringify(before) === JSON.stringify(after));

  console.log("\nhappy path (ball b1)");
  const burnedBefore = await machineBurned();
  const want1 = await lamportsOf(K.b1), t1 = await bal(TREASURY), w1 = await bal(wallet.publicKey);
  r = await attempt([closeIx(K.b1)]);
  check("close_burned accepted", r.ok, r.ok ? "" : r.text.slice(0, 200));
  const { logs, fee } = await logsOf(r.sig);
  check("treasury gained exactly GumballData + GumballSvg lamports", (await bal(TREASURY)) - t1 === want1, `+${(await bal(TREASURY)) - t1} of ${want1}`);
  check("both accounts gone", (await gone(K.b1.gd)) && (await gone(K.b1.svg)));
  const w1After = await bal(wallet.publicKey);
  // <= : this wallet is also the validator's faucet/upgrade key and can receive a few lamports of cluster rewards between reads
  check("caller paid at most the fee", w1 - w1After <= fee, `fee ${fee}, balance dropped ${w1 - w1After}`);
  const ev = closedEvents(logs);
  check("BurnedClosedEvent reports the mint and the total", ev.length === 1 && ev[0].mint === K.b1.mint && ev[0].lamports === want1, JSON.stringify(ev));
  check("Machine.total_burned untouched by a close", (await machineBurned()) === burnedBefore);

  console.log("\nno revival, no double close");
  await sendAndConfirmTransaction(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pk(K.b1.gd), lamports: 1_000_000 })), [wallet]);
  const poked = await c.getAccountInfo(pk(K.b1.gd));
  check("lamports sent to the closed address leave a plain system account", poked && poked.owner.equals(SystemProgram.programId) && poked.data.length === 0 && poked.lamports === 1_000_000);
  // a cheap unrelated instruction keeps this transaction's id distinct from the first close (same bytes would be "already processed")
  r = await attempt([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: TREASURY, lamports: 1 }), closeIx(K.b1)]);
  check("second close refused with InvalidAccount", !r.ok && hasCode(r.text, errCode("InvalidAccount")), r.ok ? "SUCCEEDED" : r.text.slice(0, 400));

  console.log("\nlegacy 93-byte GumballData (ball b2)");
  const want2 = await lamportsOf(K.b2), t2 = await bal(TREASURY);
  r = await attempt([closeIx(K.b2)]);
  check("legacy ball closed", r.ok, r.ok ? "" : r.text.slice(0, 200));
  check("treasury gained both accounts' lamports, both gone", (await bal(TREASURY)) - t2 === want2 && (await gone(K.b2.gd)) && (await gone(K.b2.svg)), `+${(await bal(TREASURY)) - t2} of ${want2}`);

  console.log("\ncaller is not the burner (ball b3)");
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger.publicKey, lamports: LAMPORTS_PER_SOL / 10 })), [wallet]);
  const want3 = await lamportsOf(K.b3), t3 = await bal(TREASURY), s3 = await bal(stranger.publicKey), w3 = await bal(wallet.publicKey);
  r = await attempt([closeIx(K.b3)], stranger);
  check("stranger closes the ball", r.ok, r.ok ? "" : r.text.slice(0, 200));
  const fee3 = (await logsOf(r.sig)).fee;
  check("treasury gained the lamports, not the caller", (await bal(TREASURY)) - t3 === want3 && s3 - (await bal(stranger.publicKey)) === fee3, `caller paid ${fee3} (fee only)`);
  check("burner's balance did not move", (await bal(wallet.publicKey)) === w3);
  check("both accounts gone", (await gone(K.b3.gd)) && (await gone(K.b3.svg)));

  console.log("\nseveral balls in one transaction (b4 + b5)");
  const want45 = (await lamportsOf(K.b4)) + (await lamportsOf(K.b5)), t45 = await bal(TREASURY);
  r = await attempt([closeIx(K.b4), closeIx(K.b5)]);
  check("two closes in one tx accepted", r.ok, r.ok ? "" : r.text.slice(0, 200));
  check("treasury gained both balls' lamports, all four accounts gone", (await bal(TREASURY)) - t45 === want45 && (await gone(K.b4.gd)) && (await gone(K.b4.svg)) && (await gone(K.b5.gd)) && (await gone(K.b5.svg)), `+${(await bal(TREASURY)) - t45} of ${want45}`);
  if (r.ok) console.log(`     (${(await logsOf(r.sig)).cu} compute units for 2 closes)`);

  console.log("\nballs burned by burn_to_upgrade (2 balls)");
  const [ra, rb] = info.rare;
  const burned0 = await machineBurned();
  let b = await burn("burn_to_upgrade", [ra, rb]);
  check("burn_to_upgrade ran; Machine.total_burned +2", (await machineBurned()) - burned0 === 2);
  check("burned GumballData/GumballSvg are still on chain until closed", !(await gone(ra.gd)) && !(await gone(ra.svg)) && !(await gone(rb.gd)));
  const wantR = (await lamportsOf(ra)) + (await lamportsOf(rb)), tR = await bal(TREASURY);
  r = await attempt([closeIx(ra), closeIx(rb)]);
  check("both burned balls closed", r.ok, r.ok ? "" : r.text.slice(0, 200));
  check("treasury gained exactly their lamports", (await bal(TREASURY)) - tR === wantR && (await gone(ra.gd)) && (await gone(ra.svg)) && (await gone(rb.gd)) && (await gone(rb.svg)), `+${(await bal(TREASURY)) - tR} of ${wantR}`);
  const out = { mint: b.newMint.toBase58(), gd: gdOf(b.newMint).toBase58(), svg: svgOf(b.newMint).toBase58() };
  r = await attempt([closeIx(out)]);
  check("the upgrade's output ball is refused (NotBurned)", !r.ok && hasCode(r.text, errCode("NotBurned")) && !(await gone(out.gd)) && !(await gone(out.svg)));

  console.log("\nballs burned by burn_multi (5 balls)");
  const burned1 = await machineBurned();
  b = await burn("burn_multi", info.common);
  check("burn_multi ran; Machine.total_burned +5", (await machineBurned()) - burned1 === 5);
  const wantC = (await Promise.all(info.common.map(lamportsOf))).reduce((x, y) => x + y, 0), tC = await bal(TREASURY);
  r = await attempt(info.common.map((x) => closeIx(x)));
  check("all five burned balls closed in one tx", r.ok, r.ok ? "" : r.text.slice(0, 200));
  let allGone = true;
  for (const x of info.common) allGone = allGone && (await gone(x.gd)) && (await gone(x.svg));
  check("treasury gained exactly their lamports, ten accounts gone", (await bal(TREASURY)) - tC === wantC && allGone, `+${(await bal(TREASURY)) - tC} of ${wantC}`);
  if (r.ok) console.log(`     (${(await logsOf(r.sig)).cu} compute units for 5 closes)`);
  const outM = { mint: b.newMint.toBase58(), gd: gdOf(b.newMint).toBase58(), svg: svgOf(b.newMint).toBase58() };
  check("the upgrade output of burn_multi is intact", !(await gone(outM.gd)) && !(await gone(outM.svg)));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
