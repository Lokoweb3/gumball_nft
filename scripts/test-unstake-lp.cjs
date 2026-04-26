// Unstake an LP position — claims any pending GUM, returns LP tokens, burns
// the position NFT, closes the LpStakeAccount.
//
// Usage:
//   POSITION_MINT=<pubkey> node scripts/test-unstake-lp.cjs
//   POSITION_MINT=<pubkey> AMOUNT=0.5 node scripts/test-unstake-lp.cjs   # partial
//
// AMOUNT in whole LP tokens (default = full position).

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const GUM_MINT   = new PublicKey("2KjdBhiWdCFoFcNNUbpSWqb67tGWnQpPjcMEYnescyy1");
const LP_MINT    = new PublicKey("D2bJsDoWVuvykQbMgwFeH7cvuvXZjL2scsjPMVGwNXiV");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";

const POSITION_MINT_STR = process.env.POSITION_MINT;
if (!POSITION_MINT_STR) {
  console.error("Missing POSITION_MINT env var.");
  console.error("Usage: POSITION_MINT=<pubkey> node scripts/test-unstake-lp.cjs");
  process.exit(1);
}
const POSITION_MINT = new PublicKey(POSITION_MINT_STR);

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID,
  );
  return ata;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Position mint:", POSITION_MINT.toBase58());

  const [stakeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("stake_config_v2")], PROGRAM_ID);
  const [lpVaultPda]     = PublicKey.findProgramAddressSync([Buffer.from("lp_reward_vault")], PROGRAM_ID);
  const [lpStakePda]     = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_stake_v2"), POSITION_MINT.toBuffer()], PROGRAM_ID,
  );
  const [vaultLpAta] = PublicKey.findProgramAddressSync(
    [stakeConfigPda.toBuffer(), TOKEN_PID.toBuffer(), LP_MINT.toBuffer()], ASSOC_PID,
  );
  const positionAta   = getAta(POSITION_MINT, wallet.publicKey);
  const userLpAta     = getAta(LP_MINT, wallet.publicKey);
  const claimerGumAta = getAta(GUM_MINT, wallet.publicKey);

  // Read current LP stake amount + lock
  const lpInfo = await connection.getAccountInfo(lpStakePda);
  if (!lpInfo) throw new Error(`LP stake account ${lpStakePda.toBase58()} not found`);
  // Layout: disc(8) + position_mint(32) + lp_mint(32) + amount(8) + ...
  const stakedAmount = lpInfo.data.readBigUInt64LE(8 + 32 + 32);
  const stakedAt     = lpInfo.data.readBigInt64LE(8 + 32 + 32 + 8);
  const lockUntil    = lpInfo.data.readBigInt64LE(8 + 32 + 32 + 8 + 8 + 8);
  const lockTier     = lpInfo.data.readUInt8(8 + 32 + 32 + 8 + 8 + 8 + 8 + 2);
  const now = Math.floor(Date.now() / 1000);
  const isEarly = now < Number(lockUntil);

  console.log("Staked amount:", (Number(stakedAmount) / 1e9).toFixed(4), "LP");
  console.log("Lock tier:    ", lockTier, ["Flexible","Bronze","Silver","Gold","Diamond"][lockTier] || "?");
  console.log("Early exit:   ", isEarly ? `YES (lock ends ${new Date(Number(lockUntil)*1000).toISOString()})` : "NO");

  let amount;
  if (process.env.AMOUNT) {
    amount = BigInt(Math.floor(Number(process.env.AMOUNT) * 1e9));
  } else {
    amount = stakedAmount;
  }
  console.log("Unstaking:    ", (Number(amount) / 1e9).toFixed(4), "LP", amount === stakedAmount ? "(FULL)" : "(partial)");

  // Build instruction
  const data = Buffer.alloc(8 + 8);
  disc("unstake_lp").copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // claimer
      { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  }, // stake_config
      { pubkey: lpStakePda,              isSigner: false, isWritable: true  }, // lp_stake_account
      { pubkey: POSITION_MINT,           isSigner: false, isWritable: true  }, // position_mint
      { pubkey: positionAta,             isSigner: false, isWritable: true  }, // position_ata
      { pubkey: LP_MINT,                 isSigner: false, isWritable: true  }, // lp_mint (writable: burn from vault)
      { pubkey: vaultLpAta,              isSigner: false, isWritable: true  }, // vault_lp_ata
      { pubkey: userLpAta,               isSigner: false, isWritable: true  }, // user_lp_ata
      { pubkey: GUM_MINT,                isSigner: false, isWritable: false }, // gum_mint
      { pubkey: lpVaultPda,              isSigner: false, isWritable: true  }, // lp_reward_vault
      { pubkey: claimerGumAta,           isSigner: false, isWritable: true  }, // claimer_gum_ata
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
      { pubkey: ASSOC_PID,               isSigner: false, isWritable: false }, // associated_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
    ],
    data,
  });

  const lpBalBefore = (await connection.getAccountInfo(userLpAta))?.data.readBigUInt64LE(64) || 0n;
  const gumBefore = (await connection.getAccountInfo(claimerGumAta))?.data.readBigUInt64LE(64) || 0n;

  console.log("\nUnstaking...");
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
  console.log("✅ Unstaked:", sig);

  const lpBalAfter  = (await connection.getAccountInfo(userLpAta))?.data.readBigUInt64LE(64) || 0n;
  const gumAfter    = (await connection.getAccountInfo(claimerGumAta))?.data.readBigUInt64LE(64) || 0n;
  console.log("\nLP returned:    +" + ((Number(lpBalAfter - lpBalBefore)) / 1e9).toFixed(4) + " LP");
  console.log("GUM rewards:    +" + ((Number(gumAfter - gumBefore)) / 1e6).toFixed(6) + " GUM");

  if (amount === stakedAmount) {
    console.log("(Full unstake — position NFT burned, lp_stake_account closed)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
