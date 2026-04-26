// End-to-end test for Phase 1 LP staking:
//   1. Stakes a tiny amount of LP tokens with Flexible tier (lock_tier=0)
//   2. Waits 30 s
//   3. Calls claim_lp and confirms GUM was transferred from lp_reward_vault
//
// Usage:
//   node scripts/test-lp-stake.cjs
//   STAKE_AMOUNT=1 LOCK_TIER=4 WAIT_SECS=60 node scripts/test-lp-stake.cjs

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
const METAPLEX   = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const GUM_MINT   = new PublicKey("2KjdBhiWdCFoFcNNUbpSWqb67tGWnQpPjcMEYnescyy1");
const LP_MINT    = new PublicKey("D2bJsDoWVuvykQbMgwFeH7cvuvXZjL2scsjPMVGwNXiV");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";

const STAKE_AMOUNT_LP = Number(process.env.STAKE_AMOUNT || 1); // whole LP tokens (9 decimals)
const LOCK_TIER       = Number(process.env.LOCK_TIER || 0);    // 0=Flexible, 1=Bronze...4=Diamond
const WAIT_SECS       = Number(process.env.WAIT_SECS || 30);

const LOCK_NAMES = ["Flexible", "Bronze", "Silver", "Gold", "Diamond"];

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Stake amount:", STAKE_AMOUNT_LP, "LP   Tier:", LOCK_TIER, `(${LOCK_NAMES[LOCK_TIER]})`);

  const [stakeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("stake_config_v2")], PROGRAM_ID);
  const [lpVaultPda]     = PublicKey.findProgramAddressSync([Buffer.from("lp_reward_vault")], PROGRAM_ID);

  const lpVaultInfo = await connection.getAccountInfo(lpVaultPda);
  const lpVaultBefore = lpVaultInfo.data.readBigUInt64LE(64);
  console.log("LP vault GUM:", (Number(lpVaultBefore) / 1e6).toLocaleString());

  // Check user has LP balance
  const userLpAta = getAta(LP_MINT, wallet.publicKey);
  const userLpInfo = await connection.getAccountInfo(userLpAta);
  if (!userLpInfo) throw new Error(`User has no LP token account at ${userLpAta.toBase58()}`);
  const userLpBal = userLpInfo.data.readBigUInt64LE(64);
  const stakeAmountRaw = BigInt(STAKE_AMOUNT_LP) * 1_000_000_000n; // 9 dec
  console.log("User LP balance:", (Number(userLpBal) / 1e9).toFixed(4));
  if (userLpBal < stakeAmountRaw) throw new Error("Not enough LP tokens to stake requested amount");

  // ── Generate position NFT mint + derive PDAs ─────────────────────────────
  const positionMint = Keypair.generate();
  console.log("\nNew position mint:", positionMint.publicKey.toBase58());

  const [lpStakePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_stake_v2"), positionMint.publicKey.toBuffer()], PROGRAM_ID,
  );
  const positionAta = getAta(positionMint.publicKey, wallet.publicKey);
  const [vaultLpAta] = PublicKey.findProgramAddressSync(
    [stakeConfigPda.toBuffer(), TOKEN_PID.toBuffer(), LP_MINT.toBuffer()], ASSOC_PID,
  );
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX.toBuffer(), positionMint.publicKey.toBuffer()], METAPLEX,
  );

  // ── Step 1: stake_lp(amount, lock_tier) ──────────────────────────────────
  console.log(`\nStaking ${STAKE_AMOUNT_LP} LP at tier ${LOCK_TIER}...`);
  const stakeData = Buffer.alloc(8 + 8 + 1);
  disc("stake_lp").copy(stakeData, 0);
  stakeData.writeBigUInt64LE(stakeAmountRaw, 8);
  stakeData.writeUInt8(LOCK_TIER, 16);

  const stakeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // staker
      { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  }, // stake_config
      { pubkey: lpStakePda,              isSigner: false, isWritable: true  }, // lp_stake_account
      { pubkey: positionMint.publicKey,  isSigner: true,  isWritable: true  }, // position_mint
      { pubkey: positionAta,             isSigner: false, isWritable: true  }, // position_ata
      { pubkey: LP_MINT,                 isSigner: false, isWritable: false }, // lp_mint
      { pubkey: userLpAta,               isSigner: false, isWritable: true  }, // user_lp_ata
      { pubkey: vaultLpAta,              isSigner: false, isWritable: true  }, // vault_lp_ata
      { pubkey: lpVaultPda,              isSigner: false, isWritable: false }, // lp_reward_vault
      { pubkey: metadataPda,             isSigner: false, isWritable: true  }, // metadata_account
      { pubkey: METAPLEX,                isSigner: false, isWritable: false }, // metadata_program
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
      { pubkey: ASSOC_PID,               isSigner: false, isWritable: false }, // associated_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
    ],
    data: stakeData,
  });

  const stakeSig = await sendAndConfirmTransaction(connection, new Transaction().add(stakeIx), [wallet, positionMint]);
  console.log("✅ Staked:", stakeSig);

  // ── Step 2: wait ─────────────────────────────────────────────────────────
  console.log(`\nWaiting ${WAIT_SECS}s...`);
  await sleep(WAIT_SECS * 1000);

  // ── Step 3: claim_lp ─────────────────────────────────────────────────────
  const claimerGumAta = getAta(GUM_MINT, wallet.publicKey);
  const gumBeforeInfo = await connection.getAccountInfo(claimerGumAta);
  const gumBefore = gumBeforeInfo ? gumBeforeInfo.data.readBigUInt64LE(64) : 0n;

  console.log("\nClaiming...");
  const claimIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // claimer
      { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  }, // stake_config
      { pubkey: lpStakePda,              isSigner: false, isWritable: true  }, // lp_stake_account
      { pubkey: positionAta,             isSigner: false, isWritable: false }, // position_ata
      { pubkey: GUM_MINT,                isSigner: false, isWritable: false }, // gum_mint
      { pubkey: lpVaultPda,              isSigner: false, isWritable: true  }, // lp_reward_vault
      { pubkey: claimerGumAta,           isSigner: false, isWritable: true  }, // claimer_gum_ata
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
      { pubkey: ASSOC_PID,               isSigner: false, isWritable: false }, // associated_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
    ],
    data: disc("claim_lp"),
  });
  const claimSig = await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [wallet]);
  console.log("✅ Claimed:", claimSig);

  // ── Verify ───────────────────────────────────────────────────────────────
  const gumAfterInfo = await connection.getAccountInfo(claimerGumAta);
  const gumAfter = gumAfterInfo.data.readBigUInt64LE(64);
  const earned = gumAfter - gumBefore;

  const lpVaultAfterInfo = await connection.getAccountInfo(lpVaultPda);
  const lpVaultAfter = lpVaultAfterInfo.data.readBigUInt64LE(64);
  const drained = lpVaultBefore - lpVaultAfter;

  console.log("\n── Result ──────────────────────────────────────────────");
  console.log(`Wallet GUM: ${(Number(gumBefore)/1e6).toFixed(6)} → ${(Number(gumAfter)/1e6).toFixed(6)}`);
  console.log(`Earned:     +${(Number(earned)/1e6).toFixed(6)} GUM (raw ${earned})`);
  console.log(`Vault GUM:  ${(Number(lpVaultBefore)/1e6).toLocaleString()} → ${(Number(lpVaultAfter)/1e6).toLocaleString()}`);
  console.log(`Drained:    ${(Number(drained)/1e6).toFixed(6)} GUM`);

  if (earned > 0n && earned === drained) {
    console.log("\n✅ Phase 1 LP staking working: vault → staker via Pattern B accumulator.");
  } else if (earned === 0n) {
    console.log("\n⚠️  Earned 0 GUM. Try a longer WAIT_SECS or higher STAKE_AMOUNT.");
  } else {
    console.log("\n⚠️  earned != drained — investigate.");
  }

  console.log("\nPosition NFT:", positionMint.publicKey.toBase58());
  console.log("LP stake account:", lpStakePda.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
