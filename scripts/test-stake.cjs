// End-to-end test for Phase 1 staking:
//   1. Finds one of your gumball NFTs
//   2. Calls `stake` (new Pattern B handler)
//   3. Waits 30 s
//   4. Calls `claim` and confirms GUM was transferred from nft_reward_vault
//
// Usage:
//   node scripts/test-stake.cjs                 # auto-pick a gumball
//   NFT_MINT=<pubkey> node scripts/test-stake.cjs   # use a specific gumball
//   WAIT_SECS=60 node scripts/test-stake.cjs        # wait longer between stake & claim

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── Constants ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const GUM_MINT   = new PublicKey("2KjdBhiWdCFoFcNNUbpSWqb67tGWnQpPjcMEYnescyy1");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";
const WAIT_SECS = Number(process.env.WAIT_SECS || 30);

const RARITY_NAMES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

// ── Helpers ─────────────────────────────────────────────────────────────────
function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function getAta(mint, owner, allowOffCurve = false) {
  const ownerBuf = owner.toBuffer();
  const [ata] = PublicKey.findProgramAddressSync(
    [ownerBuf, TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID,
  );
  return ata;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pickGumball(connection) {
  if (process.env.NFT_MINT) {
    return new PublicKey(process.env.NFT_MINT);
  }
  // Find an SPL token account owned by wallet with amount === 1 that has a GumballData PDA
  const tokens = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PID });
  let scannedNfts = 0;
  let foundGumballs = 0;
  for (const { account } of tokens.value) {
    const info = account.data.parsed.info;
    if (info.tokenAmount.amount !== "1" || info.tokenAmount.decimals !== 0) continue;
    scannedNfts++;
    const mint = new PublicKey(info.mint);
    const [gumballPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("gumball"), mint.toBuffer()], PROGRAM_ID,
    );
    const gd = await connection.getAccountInfo(gumballPda);
    if (!gd) continue;
    foundGumballs++;
    console.log(`  Found gumball mint ${mint.toBase58()} (GumballData ${gd.data.length} bytes)`);
    if (gd.data.length === 189) return mint; // v5 (current)
  }
  console.log(`Scanned ${scannedNfts} NFT-like tokens, found ${foundGumballs} gumball PDAs (none v5).`);
  return null;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());

  // ── PDAs ─────────────────────────────────────────────────────────────────
  const [stakeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config_v2")], PROGRAM_ID,
  );
  const [nftVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nft_reward_vault")], PROGRAM_ID,
  );

  // Sanity: stake_config exists + vault loaded
  const cfg = await connection.getAccountInfo(stakeConfigPda);
  if (!cfg) throw new Error("stake_config_v2 not found — run init-staking.cjs first");
  const vaultInfo = await connection.getAccountInfo(nftVaultPda);
  const vaultBalanceBefore = vaultInfo.data.readBigUInt64LE(64);
  console.log("NFT vault balance:", (Number(vaultBalanceBefore) / 1e6).toLocaleString(), "GUM");

  // ── Pick gumball ─────────────────────────────────────────────────────────
  const nftMint = await pickGumball(connection);
  if (!nftMint) throw new Error("No gumball NFT found in wallet");
  console.log("\nUsing gumball:", nftMint.toBase58());

  const [gumballDataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("gumball"), nftMint.toBuffer()], PROGRAM_ID,
  );
  const gd = await connection.getAccountInfo(gumballDataPda);
  // GumballData v5 layout: disc(8) + owner(32) + machine(32) + serial(8) + flavor(1) + color(1) + rarity(1)
  const serial = gd.data.readBigUInt64LE(8 + 32 + 32);
  const rarity = gd.data.readUInt8(8 + 32 + 32 + 8 + 1 + 1);
  console.log(`  Serial: #${serial}  Rarity: ${rarity} (${RARITY_NAMES[rarity]})`);

  const [stakeAccountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_v2"), nftMint.toBuffer()], PROGRAM_ID,
  );
  const userAta = getAta(nftMint, wallet.publicKey);
  // vault_ata is ATA(nft_mint, stake_config) — stake_config is a PDA owner
  const [vaultAta] = PublicKey.findProgramAddressSync(
    [stakeConfigPda.toBuffer(), TOKEN_PID.toBuffer(), nftMint.toBuffer()], ASSOC_PID,
  );

  // ── Step 1: stake ────────────────────────────────────────────────────────
  const stakeExisting = await connection.getAccountInfo(stakeAccountPda);
  if (stakeExisting) {
    console.log("\n⚠️  Already staked (StakeAccount exists) — skipping stake, going straight to claim.");
  } else {
    console.log("\nStaking...");
    const stakeIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // staker
        { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  }, // stake_config
        { pubkey: stakeAccountPda,         isSigner: false, isWritable: true  }, // stake_account
        { pubkey: gumballDataPda,          isSigner: false, isWritable: false }, // gumball_data
        { pubkey: nftMint,                 isSigner: false, isWritable: false }, // nft_mint
        { pubkey: userAta,                 isSigner: false, isWritable: true  }, // user_ata
        { pubkey: vaultAta,                isSigner: false, isWritable: true  }, // vault_ata
        { pubkey: nftVaultPda,             isSigner: false, isWritable: false }, // nft_reward_vault
        { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
        { pubkey: ASSOC_PID,               isSigner: false, isWritable: false }, // associated_token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
      ],
      data: disc("stake"),
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(stakeIx), [wallet]);
    console.log("✅ Staked:", sig);
  }

  // ── Step 2: wait ─────────────────────────────────────────────────────────
  console.log(`\nWaiting ${WAIT_SECS}s for emissions to accrue...`);
  await sleep(WAIT_SECS * 1000);

  // ── Step 3: claim ────────────────────────────────────────────────────────
  const stakerGumAta = getAta(GUM_MINT, wallet.publicKey);
  const gumBalBeforeInfo = await connection.getAccountInfo(stakerGumAta);
  const gumBefore = gumBalBeforeInfo ? gumBalBeforeInfo.data.readBigUInt64LE(64) : 0n;

  console.log("\nClaiming rewards...");
  const claimIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // staker
      { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  }, // stake_config
      { pubkey: stakeAccountPda,         isSigner: false, isWritable: true  }, // stake_account
      { pubkey: GUM_MINT,                isSigner: false, isWritable: false }, // gum_mint
      { pubkey: nftVaultPda,             isSigner: false, isWritable: true  }, // nft_reward_vault
      { pubkey: stakerGumAta,            isSigner: false, isWritable: true  }, // staker_gum_ata
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
      { pubkey: ASSOC_PID,               isSigner: false, isWritable: false }, // associated_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
    ],
    data: disc("claim"),
  });
  const claimSig = await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [wallet]);
  console.log("✅ Claimed:", claimSig);

  // ── Verify ───────────────────────────────────────────────────────────────
  const gumBalAfterInfo = await connection.getAccountInfo(stakerGumAta);
  const gumAfter = gumBalAfterInfo.data.readBigUInt64LE(64);
  const earned = gumAfter - gumBefore;

  const vaultAfterInfo = await connection.getAccountInfo(nftVaultPda);
  const vaultAfter = vaultAfterInfo.data.readBigUInt64LE(64);
  const vaultDrained = vaultBalanceBefore - vaultAfter;

  console.log("\n── Result ──────────────────────────────────────────────");
  console.log(`Wallet GUM: ${(Number(gumBefore)/1e6).toLocaleString()} → ${(Number(gumAfter)/1e6).toLocaleString()}`);
  console.log(`Earned:     +${(Number(earned)/1e6).toFixed(6)} GUM (raw ${earned})`);
  console.log(`Vault GUM:  ${(Number(vaultBalanceBefore)/1e6).toLocaleString()} → ${(Number(vaultAfter)/1e6).toLocaleString()}`);
  console.log(`Drained:    ${(Number(vaultDrained)/1e6).toFixed(6)} GUM`);

  if (earned > 0n && earned === vaultDrained) {
    console.log("\n✅ Phase 1 working: vault transferred GUM to staker via Pattern B accumulator.");
  } else if (earned === 0n) {
    console.log("\n⚠️  Earned 0 GUM. Likely cause: this is the only staker, accumulator only advanced for the wait window. Try a longer WAIT_SECS.");
  } else {
    console.log("\n⚠️  earned != vaultDrained — investigate.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
