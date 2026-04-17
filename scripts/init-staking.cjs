const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs     = require("fs");

const PROGRAM_ID  = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC         = "https://rpc.testnet.x1.xyz";
const TOKEN_PID   = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
const walletPath  = process.env.WALLET || (require("os").homedir() + "/.config/solana/id.json");
const secretKey   = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
const wallet      = Keypair.fromSecretKey(secretKey);

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("Wallet:     ", wallet.publicKey.toBase58());
  console.log("Balance:    ", await connection.getBalance(wallet.publicKey) / 1e9, "XNT");

  // Derive PDAs
  const [stakeConfigPda, stakeConfigBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config")], PROGRAM_ID
  );
  const [gumMintPda, gumMintBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("gum_mint")], PROGRAM_ID
  );

  console.log("StakeConfig PDA:", stakeConfigPda.toBase58());
  console.log("GUM Mint PDA:   ", gumMintPda.toBase58());

  // Check if already initialized
  const existing = await connection.getAccountInfo(stakeConfigPda);
  if (existing) {
    console.log("\nStaking already initialized!");
    console.log("  StakeConfig:", stakeConfigPda.toBase58());
    console.log("  GUM Mint:   ", gumMintPda.toBase58());
    return;
  }

  console.log("\nInitializing staking system...");

  const data = disc("initialize_staking");

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // authority
      { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  }, // stake_config
      { pubkey: gumMintPda,              isSigner: false, isWritable: true  }, // gum_mint
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: RENT_SYSVAR,             isSigner: false, isWritable: false }, // rent
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log("✅ Staking initialized!");
  console.log("   TX:", sig);
  console.log("   StakeConfig:", stakeConfigPda.toBase58());
  console.log("   GUM Mint:   ", gumMintPda.toBase58());
  console.log("\n🪙 GUM token is live!");
  console.log("   Decimals: 6");
  console.log("   Max Supply: 1,000,000,000 GUM");
  console.log("   Mint Authority: StakeConfig PDA (program-controlled)");
}

main().catch(console.error);
