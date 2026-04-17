const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

// ── Config ──────────────────────────────────────────────────────────────────
const XDEX_PID      = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const AMM_CONFIG     = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY"); // index 1, 0.13 SOL fee
const GUM_MINT       = new PublicKey("47wsxrZymUoKp5ALEMWsWbaN2F5MFzn6kKedWEsLV82G");
const WSOL_MINT      = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PID      = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID      = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CREATE_POOL_FEE = new PublicKey("DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS"); // protocolOwner

const RPC = "https://rpc.testnet.x1.xyz";
const walletPath = process.env.WALLET || (require("os").homedir() + "/.config/solana/id.json");
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
const wallet = Keypair.fromSecretKey(secretKey);

// ── Initial liquidity ───────────────────────────────────────────────────────
// Seed pool with initial amounts — this sets the price
// Example: 10000 GUM (6 dec) + 1 XNT (9 dec) = 1 GUM ≈ 0.0001 XNT
const INIT_GUM = BigInt(process.argv[2] || "10000") * 1_000_000n;  // GUM amount (6 decimals)
const INIT_XNT = BigInt(process.argv[3] || "1") * 1_000_000_000n;  // XNT amount (9 decimals)

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID
  );
  return ata;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(wallet.publicKey)) / 1e9, "XNT");

  // Sort mints — token0 must be smaller pubkey
  const mint0 = WSOL_MINT.toBuffer().compare(GUM_MINT.toBuffer()) < 0 ? WSOL_MINT : GUM_MINT;
  const mint1 = WSOL_MINT.toBuffer().compare(GUM_MINT.toBuffer()) < 0 ? GUM_MINT : WSOL_MINT;
  const isGumToken0 = mint0.equals(GUM_MINT);

  console.log("\nToken0 (smaller):", mint0.toBase58(), isGumToken0 ? "(GUM)" : "(WSOL)");
  console.log("Token1 (larger):", mint1.toBase58(), isGumToken0 ? "(WSOL)" : "(GUM)");

  const initAmount0 = isGumToken0 ? INIT_GUM : INIT_XNT;
  const initAmount1 = isGumToken0 ? INIT_XNT : INIT_GUM;
  console.log("Init amount0:", initAmount0.toString());
  console.log("Init amount1:", initAmount1.toString());

  // Derive PDAs
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")], XDEX_PID
  );
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), AMM_CONFIG.toBuffer(), mint0.toBuffer(), mint1.toBuffer()], XDEX_PID
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), poolState.toBuffer()], XDEX_PID
  );
  const [vault0] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), poolState.toBuffer(), mint0.toBuffer()], XDEX_PID
  );
  const [vault1] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), poolState.toBuffer(), mint1.toBuffer()], XDEX_PID
  );
  const [observation] = PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), poolState.toBuffer()], XDEX_PID
  );

  console.log("\nPool PDA:", poolState.toBase58());
  console.log("LP Mint:", lpMint.toBase58());
  console.log("Vault0:", vault0.toBase58());
  console.log("Vault1:", vault1.toBase58());
  console.log("Authority:", authority.toBase58());

  // Check if pool already exists
  const existing = await connection.getAccountInfo(poolState);
  if (existing) {
    console.log("\n⚠️  Pool already exists!");
    return;
  }

  // Creator's token accounts
  const creatorToken0 = getAta(mint0, wallet.publicKey);
  const creatorToken1 = getAta(mint1, wallet.publicKey);
  const creatorLpToken = getAta(lpMint, wallet.publicKey);

  console.log("\nCreator token0 ATA:", creatorToken0.toBase58());
  console.log("Creator token1 ATA:", creatorToken1.toBase58());
  console.log("Creator LP ATA:", creatorLpToken.toBase58());

  // Build initialize instruction
  const discBytes = disc("initialize");
  const data = Buffer.alloc(8 + 8 + 8 + 8);
  discBytes.copy(data, 0);
  data.writeBigUInt64LE(initAmount0, 8);
  data.writeBigUInt64LE(initAmount1, 16);
  data.writeBigUInt64LE(BigInt(0), 24); // openTime = 0 (immediate)

  const ix = new TransactionInstruction({
    programId: XDEX_PID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // creator
      { pubkey: AMM_CONFIG,              isSigner: false, isWritable: false }, // ammConfig
      { pubkey: authority,               isSigner: false, isWritable: false }, // authority
      { pubkey: poolState,               isSigner: false, isWritable: true  }, // poolState
      { pubkey: mint0,                   isSigner: false, isWritable: false }, // token0Mint
      { pubkey: mint1,                   isSigner: false, isWritable: false }, // token1Mint
      { pubkey: lpMint,                  isSigner: false, isWritable: true  }, // lpMint
      { pubkey: creatorToken0,           isSigner: false, isWritable: true  }, // creatorToken0
      { pubkey: creatorToken1,           isSigner: false, isWritable: true  }, // creatorToken1
      { pubkey: creatorLpToken,          isSigner: false, isWritable: true  }, // creatorLpToken
      { pubkey: vault0,                  isSigner: false, isWritable: true  }, // token0Vault
      { pubkey: vault1,                  isSigner: false, isWritable: true  }, // token1Vault
      { pubkey: CREATE_POOL_FEE,         isSigner: false, isWritable: true  }, // createPoolFee
      { pubkey: observation,             isSigner: false, isWritable: true  }, // observationState
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // tokenProgram
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token0Program
      { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token1Program
      { pubkey: ASSOC_PID,               isSigner: false, isWritable: false }, // associatedTokenProgram
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // systemProgram
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
    ],
    data,
  });

  console.log("\nCreating GUM/XNT pool on XDEX...");
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);

  console.log("✅ Pool created!");
  console.log("   TX:", sig);
  console.log("   Pool:", poolState.toBase58());
  console.log("   LP Mint:", lpMint.toBase58());
  console.log("\n🪙 GUM is now tradeable on XDEX!");
  console.log("   Initial price: 1 GUM ≈", Number(INIT_XNT) / Number(INIT_GUM) * (isGumToken0 ? 1 : 1), "XNT");
}

main().catch(console.error);
