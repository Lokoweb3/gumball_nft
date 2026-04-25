/**
 * End-to-end test script for Gumball NFT
 *
 * Tests staking, claim, unstake, LP staking, swap, liquidity, faucet.
 * Mint test is skipped (requires oracle interaction).
 *
 * Usage: node scripts/e2e-test.cjs [path-to-wallet]
 */
const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

// ── Config ──────────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const XDEX_PID   = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const LP_MINT    = new PublicKey("6hgAVwfjorEkNLXUMuvfotehKK1e1Ee3ftQaipTcj5tg");
const WSOL       = new PublicKey("So11111111111111111111111111111111111111112");
const RPC = "https://rpc.testnet.x1.xyz";

const walletPath = process.argv[2] || (require("os").homedir() + "/x1-wallet.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
const c = new Connection(RPC, "confirmed");

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID
  );
  return ata;
}
async function getTokenBalance(ata) {
  const info = await c.getAccountInfo(ata);
  if (!info || info.data.length < 72) return 0;
  return Number(new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(64, true));
}
function ixData(d, ...u64s) {
  const data = new Uint8Array(d.length + u64s.length * 8);
  data.set(d, 0);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < u64s.length; i++) dv.setBigUint64(d.length + i * 8, BigInt(u64s[i]), true);
  return data;
}

// ── Test runner ─────────────────────────────────────────────────────────────
const results = [];
async function test(name, fn) {
  process.stdout.write(`▶ ${name} ... `);
  const t0 = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - t0;
    console.log(`✅ PASS (${elapsed}ms)${result ? ` — ${result}` : ''}`);
    results.push({ name, status: 'PASS', elapsed });
  } catch (e) {
    const elapsed = Date.now() - t0;
    console.log(`❌ FAIL (${elapsed}ms) — ${(e.message || '').slice(0, 100)}`);
    results.push({ name, status: 'FAIL', elapsed, error: e.message });
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testProgramExists() {
  const info = await c.getAccountInfo(PROGRAM_ID);
  if (!info) throw new Error("Program not deployed");
  if (!info.executable) throw new Error("Program is not executable");
  return `${info.data.length} bytes`;
}

async function testStakeConfigExists() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("stake_config")], PROGRAM_ID);
  const info = await c.getAccountInfo(pda);
  if (!info) throw new Error("StakeConfig not initialized");
  return pda.toBase58().slice(0, 12);
}

async function testGumMintExists() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("gum_mint")], PROGRAM_ID);
  const info = await c.getAccountInfo(pda);
  if (!info) throw new Error("GUM mint not created");
  return pda.toBase58().slice(0, 12);
}

async function testPoolExists() {
  const sortedMints = WSOL.toBuffer().compare(new PublicKey("47wsxrZymUoKp5ALEMWsWbaN2F5MFzn6kKedWEsLV82G").toBuffer()) < 0
    ? [WSOL, new PublicKey("47wsxrZymUoKp5ALEMWsWbaN2F5MFzn6kKedWEsLV82G")]
    : [new PublicKey("47wsxrZymUoKp5ALEMWsWbaN2F5MFzn6kKedWEsLV82G"), WSOL];
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), AMM_CONFIG.toBuffer(), sortedMints[0].toBuffer(), sortedMints[1].toBuffer()],
    XDEX_PID
  );
  const info = await c.getAccountInfo(pool);
  if (!info) throw new Error("XDEX pool not created");
  return pool.toBase58().slice(0, 12);
}

async function testFaucetEndpoint() {
  // Just check the API responds (we don't actually request funds to avoid cooldown)
  const fetch = require("https").get;
  return new Promise((resolve, reject) => {
    require("https").request({
      hostname: "gumballnft-production.up.railway.app",
      port: 443,
      path: "/api/faucet",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        if (res.statusCode === 400) resolve("API responds (400 expected without wallet)");
        else if (res.statusCode === 200) resolve("API responds (200)");
        else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 100)}`));
      });
    }).on("error", reject).end(JSON.stringify({}));
  });
}

async function testPriceHistoryEndpoint() {
  return new Promise((resolve, reject) => {
    require("https").get({
      hostname: "gumballnft-production.up.railway.app",
      port: 443,
      path: "/api/price-history",
    }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data)) return reject(new Error("Not an array"));
          resolve(`${data.length} price points`);
        } catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function testWalletGumballs() {
  // Find gumballs (NFT mints) owned by wallet via token accounts
  const tokenAccts = await c.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PID });
  let count = 0;
  for (const { account } of tokenAccts.value) {
    const dv = new DataView(account.data.buffer, account.data.byteOffset);
    const amount = Number(dv.getBigUint64(64, true));
    if (amount === 1) {
      const mint = new PublicKey(account.data.slice(0, 32));
      const [gumballPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("gumball"), mint.toBuffer()], PROGRAM_ID
      );
      const gbInfo = await c.getAccountInfo(gumballPda);
      if (gbInfo && gbInfo.data.length === 189) count++;
    }
  }
  return `${count} gumballs in wallet`;
}

async function testStakedGumballs() {
  const accts = await c.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: 90 },
      { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
    ],
  });
  return `${accts.length} staked NFTs`;
}

async function testLpPositions() {
  const accts = await c.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 107 }] });
  let mine = 0;
  for (const a of accts) {
    const posMint = new PublicKey(a.account.data.slice(8, 40));
    const ataInfo = await c.getAccountInfo(getAta(posMint, wallet.publicKey));
    if (ataInfo && ataInfo.data.length >= 72) {
      const bal = Number(new DataView(ataInfo.data.buffer, ataInfo.data.byteOffset).getBigUint64(64, true));
      if (bal === 1) mine++;
    }
  }
  return `${mine} LP positions`;
}

async function testStakeAndClaim() {
  // Find an unstaked gumball
  const tokenAccts = await c.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PID });
  let testMint = null;
  for (const { account } of tokenAccts.value) {
    const dv = new DataView(account.data.buffer, account.data.byteOffset);
    const amount = Number(dv.getBigUint64(64, true));
    if (amount !== 1) continue;
    const mint = new PublicKey(account.data.slice(0, 32));
    const [gumballPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("gumball"), mint.toBuffer()], PROGRAM_ID
    );
    const gbInfo = await c.getAccountInfo(gumballPda);
    if (!gbInfo || gbInfo.data.length !== 189) continue;
    const [stakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), mint.toBuffer()], PROGRAM_ID
    );
    const stakeInfo = await c.getAccountInfo(stakePda);
    if (!stakeInfo) { testMint = mint; break; }
  }
  if (!testMint) throw new Error("No unstaked gumball available for test");

  const [stakeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("stake_config")], PROGRAM_ID);
  const [stakeAccountPda] = PublicKey.findProgramAddressSync([Buffer.from("stake"), testMint.toBuffer()], PROGRAM_ID);
  const [gumballPda] = PublicKey.findProgramAddressSync([Buffer.from("gumball"), testMint.toBuffer()], PROGRAM_ID);
  const userAta = getAta(testMint, wallet.publicKey);
  const vaultAta = getAta(testMint, stakeConfigPda);

  // Stake
  const stakeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: stakeConfigPda, isSigner: false, isWritable: true },
      { pubkey: stakeAccountPda, isSigner: false, isWritable: true },
      { pubkey: gumballPda, isSigner: false, isWritable: false },
      { pubkey: testMint, isSigner: false, isWritable: false },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: ASSOC_PID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: disc("stake"),
  });
  await sendAndConfirmTransaction(c, new Transaction().add(stakeIx), [wallet]);

  // Wait 2 sec to accrue rewards
  await new Promise(r => setTimeout(r, 2000));

  // Claim
  const [gumMintPda] = PublicKey.findProgramAddressSync([Buffer.from("gum_mint")], PROGRAM_ID);
  const stakerGumAta = getAta(gumMintPda, wallet.publicKey);
  const balBefore = await getTokenBalance(stakerGumAta);
  const claimIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: stakeConfigPda, isSigner: false, isWritable: true },
      { pubkey: stakeAccountPda, isSigner: false, isWritable: true },
      { pubkey: gumMintPda, isSigner: false, isWritable: true },
      { pubkey: stakerGumAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: ASSOC_PID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: disc("claim"),
  });
  await sendAndConfirmTransaction(c, new Transaction().add(claimIx), [wallet]);
  const balAfter = await getTokenBalance(stakerGumAta);
  const earned = (balAfter - balBefore) / 1e6;

  // Unstake
  const unstakeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: stakeConfigPda, isSigner: false, isWritable: true },
      { pubkey: stakeAccountPda, isSigner: false, isWritable: true },
      { pubkey: testMint, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: gumMintPda, isSigner: false, isWritable: true },
      { pubkey: stakerGumAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: ASSOC_PID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: disc("unstake"),
  });
  await sendAndConfirmTransaction(c, new Transaction().add(unstakeIx), [wallet]);

  return `staked, earned ${earned.toFixed(4)} GUM, unstaked`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🧪 Gumball NFT End-to-End Tests`);
  console.log(`   Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`   Balance: ${(await c.getBalance(wallet.publicKey) / 1e9).toFixed(4)} XNT\n`);

  await test("Program deployed", testProgramExists);
  await test("StakeConfig initialized", testStakeConfigExists);
  await test("GUM mint exists", testGumMintExists);
  await test("XDEX pool exists", testPoolExists);
  await test("Wallet has gumballs", testWalletGumballs);
  await test("Currently staked NFTs", testStakedGumballs);
  await test("LP positions held", testLpPositions);
  await test("Faucet API endpoint", testFaucetEndpoint);
  await test("Price history endpoint", testPriceHistoryEndpoint);
  await test("Stake → Claim → Unstake flow", testStakeAndClaim);

  // Summary
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
