// Initializes Phase-1 staking (Pattern B) and funds both reward vaults.
//
// Steps:
//   1. Derive stake_config_v2, nft_reward_vault, lp_reward_vault PDAs
//   2. Call initialize_staking — creates stake_config + both PDA-owned vaults
//   3. Fund nft_reward_vault with 50M GUM (regular SPL transfer from wallet's ATA)
//   4. Fund lp_reward_vault  with 30M GUM
//
// Usage:
//   node scripts/init-staking.cjs
//
// Env overrides:
//   WALLET   — path to authority keypair (default ~/.config/solana/id.json)
//   GUM_MINT — GUM mint pubkey (default: the new fixed-supply GUM)
//   NFT_FUND — GUM (whole units) to send to NFT vault (default 50_000_000)
//   LP_FUND  — GUM (whole units) to send to LP vault  (default 30_000_000)

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
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";

const GUM_MINT = new PublicKey(process.env.GUM_MINT || "2KjdBhiWdCFoFcNNUbpSWqb67tGWnQpPjcMEYnescyy1");
const GUM_DECIMALS = 6;

const NFT_FUND_GUM = BigInt(process.env.NFT_FUND || "50000000"); // 50M GUM
const LP_FUND_GUM  = BigInt(process.env.LP_FUND  || "30000000"); // 30M GUM

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

// ── Helpers ─────────────────────────────────────────────────────────────────
function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID,
  );
  return ata;
}

// SPL Token: Transfer (instruction 3)
function ixSplTransfer(source, dest, owner, amount) {
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: TOKEN_PID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest,   isSigner: false, isWritable: true },
      { pubkey: owner,  isSigner: true,  isWritable: false },
    ],
    data,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("RPC:        ", RPC);
  console.log("Wallet:     ", wallet.publicKey.toBase58());
  console.log("GUM mint:   ", GUM_MINT.toBase58());
  console.log("Balance:    ", (await connection.getBalance(wallet.publicKey)) / 1e9, "XNT");

  const [stakeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config_v2")], PROGRAM_ID,
  );
  const [nftVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nft_reward_vault")], PROGRAM_ID,
  );
  const [lpVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_reward_vault")], PROGRAM_ID,
  );
  // HIGH-2 FIX: InitializeStaking now requires the Machine PDA + matching authority
  const [machinePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("machine")], PROGRAM_ID,
  );

  console.log("\nMachine PDA:        ", machinePda.toBase58());
  console.log("StakeConfig PDA:    ", stakeConfigPda.toBase58());
  console.log("NFT reward vault:   ", nftVaultPda.toBase58());
  console.log("LP reward vault:    ", lpVaultPda.toBase58());

  // ── Step 1: initialize_staking ─────────────────────────────────────────────
  const existing = await connection.getAccountInfo(stakeConfigPda);
  if (existing) {
    console.log("\n⚠️  StakeConfig already initialized — skipping init.");
  } else {
    console.log("\nInitializing staking...");
    const initIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // authority (must == machine.authority)
        { pubkey: machinePda,              isSigner: false, isWritable: false }, // machine (HIGH-2 fix)
        { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  }, // stake_config
        { pubkey: GUM_MINT,                isSigner: false, isWritable: false }, // gum_mint
        { pubkey: nftVaultPda,             isSigner: false, isWritable: true  }, // nft_reward_vault
        { pubkey: lpVaultPda,              isSigner: false, isWritable: true  }, // lp_reward_vault
        { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
      ],
      data: disc("initialize_staking"),
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [wallet]);
    console.log("✅ Initialized:", sig);
  }

  // ── Step 2: fund NFT vault ─────────────────────────────────────────────────
  const walletGumAta = getAta(GUM_MINT, wallet.publicKey);
  const nftVaultBalanceInfo = await connection.getAccountInfo(nftVaultPda);
  if (!nftVaultBalanceInfo) throw new Error("NFT vault PDA not found after init");
  const nftBal = nftVaultBalanceInfo.data.readBigUInt64LE(64);
  if (nftBal > 0n) {
    console.log(`\nNFT vault already has ${(Number(nftBal) / 10 ** GUM_DECIMALS).toLocaleString()} GUM — skipping fund.`);
  } else {
    const amount = NFT_FUND_GUM * BigInt(10 ** GUM_DECIMALS);
    console.log(`\nFunding NFT vault with ${NFT_FUND_GUM.toLocaleString()} GUM...`);
    const ix = ixSplTransfer(walletGumAta, nftVaultPda, wallet.publicKey, amount);
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log("✅ NFT vault funded:", sig);
  }

  // ── Step 3: fund LP vault ──────────────────────────────────────────────────
  const lpVaultBalanceInfo = await connection.getAccountInfo(lpVaultPda);
  if (!lpVaultBalanceInfo) throw new Error("LP vault PDA not found after init");
  const lpBal = lpVaultBalanceInfo.data.readBigUInt64LE(64);
  if (lpBal > 0n) {
    console.log(`\nLP vault already has ${(Number(lpBal) / 10 ** GUM_DECIMALS).toLocaleString()} GUM — skipping fund.`);
  } else {
    const amount = LP_FUND_GUM * BigInt(10 ** GUM_DECIMALS);
    console.log(`\nFunding LP vault with ${LP_FUND_GUM.toLocaleString()} GUM...`);
    const ix = ixSplTransfer(walletGumAta, lpVaultPda, wallet.publicKey, amount);
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log("✅ LP vault funded:", sig);
  }

  console.log("\n🎉 Staking system live!");
  console.log("   StakeConfig:      ", stakeConfigPda.toBase58());
  console.log("   NFT reward vault: ", nftVaultPda.toBase58());
  console.log("   LP reward vault:  ", lpVaultPda.toBase58());
  console.log("   GUM mint:         ", GUM_MINT.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
