// Creates a new SPL token named GUM with 1,000,000,000 supply, then revokes
// mint authority so supply is permanently fixed.
//
// Steps performed in a single transaction:
//   1. Create mint account (6 decimals, mint authority = wallet, no freeze authority)
//   2. Create Metaplex metadata (name "GUM", symbol "GUM", immutable)
//   3. Create the wallet's associated token account
//   4. Mint 1,000,000,000 GUM to the wallet
//   5. Revoke mint authority (set to None)
//
// Usage:
//   node scripts/create-gum-token.cjs
//   WALLET=/path/to/keypair.json node scripts/create-gum-token.cjs
//   RPC=https://rpc.testnet.x1.xyz node scripts/create-gum-token.cjs
//
// Outputs:
//   gum-mint-keypair.json — saved BEFORE the transaction is sent so the mint
//                           keypair is never lost. Add to .gitignore.

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── Constants ───────────────────────────────────────────────────────────────
const TOKEN_PID    = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID    = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const METAPLEX_PID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const MINT_ACCOUNT_SIZE = 82;
const DECIMALS = 6;
const SUPPLY = BigInt(1_000_000_000) * BigInt(10) ** BigInt(DECIMALS); // 1B with 6 decimals

const NAME = "GUM";
const SYMBOL = "GUM";
const URI = "";

// ── Config ──────────────────────────────────────────────────────────────────
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";
const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

// ── Helpers ─────────────────────────────────────────────────────────────────
function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()],
    ASSOC_PID,
  );
  return ata;
}

// SPL Token: InitializeMint2 (instruction 20)
function ixInitializeMint2(mint, decimals, mintAuthority, freezeAuthority) {
  const data = Buffer.alloc(1 + 1 + 32 + 1 + 32);
  let o = 0;
  data.writeUInt8(20, o); o += 1;
  data.writeUInt8(decimals, o); o += 1;
  mintAuthority.toBuffer().copy(data, o); o += 32;
  if (freezeAuthority) {
    data.writeUInt8(1, o); o += 1;
    freezeAuthority.toBuffer().copy(data, o);
  } else {
    data.writeUInt8(0, o); o += 1;
    // remaining 32 bytes left zero
  }
  return new TransactionInstruction({
    programId: TOKEN_PID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// SPL Token: MintTo (instruction 7)
function ixMintTo(mint, dest, authority, amount) {
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: TOKEN_PID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// SPL Token: SetAuthority (instruction 6). authorityType 0 = MintTokens.
function ixSetAuthority(account, currentAuthority, authorityType, newAuthority) {
  const data = Buffer.alloc(1 + 1 + 1 + 32);
  data.writeUInt8(6, 0);
  data.writeUInt8(authorityType, 1);
  if (newAuthority) {
    data.writeUInt8(1, 2);
    newAuthority.toBuffer().copy(data, 3);
  } else {
    data.writeUInt8(0, 2);
  }
  return new TransactionInstruction({
    programId: TOKEN_PID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: currentAuthority, isSigner: true, isWritable: false },
    ],
    data: data.slice(0, newAuthority ? 35 : 3),
  });
}

// Associated Token Account: Create (instruction 0 — payer creates ATA for owner)
function ixCreateAta(payer, owner, mint, ata) {
  return new TransactionInstruction({
    programId: ASSOC_PID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

// Metaplex: CreateMetadataAccountV3 (discriminator 33)
function ixCreateMetadataV3(metadataPda, mint, mintAuthority, payer, updateAuthority) {
  const nameBytes = Buffer.from(NAME, "utf8");
  const symbolBytes = Buffer.from(SYMBOL, "utf8");
  const uriBytes = Buffer.from(URI, "utf8");

  const parts = [];
  parts.push(Buffer.from([33])); // CreateMetadataAccountV3 discriminator
  // DataV2.name
  const nameLen = Buffer.alloc(4); nameLen.writeUInt32LE(nameBytes.length, 0);
  parts.push(nameLen, nameBytes);
  // DataV2.symbol
  const symLen = Buffer.alloc(4); symLen.writeUInt32LE(symbolBytes.length, 0);
  parts.push(symLen, symbolBytes);
  // DataV2.uri
  const uriLen = Buffer.alloc(4); uriLen.writeUInt32LE(uriBytes.length, 0);
  parts.push(uriLen, uriBytes);
  // seller_fee_basis_points u16
  parts.push(Buffer.from([0, 0]));
  // creators: None
  parts.push(Buffer.from([0]));
  // collection: None
  parts.push(Buffer.from([0]));
  // uses: None
  parts.push(Buffer.from([0]));
  // is_mutable
  parts.push(Buffer.from([0])); // false — metadata immutable
  // collection_details: None
  parts.push(Buffer.from([0]));

  return new TransactionInstruction({
    programId: METAPLEX_PID,
    keys: [
      { pubkey: metadataPda,     isSigner: false, isWritable: true  },
      { pubkey: mint,            isSigner: false, isWritable: false },
      { pubkey: mintAuthority,   isSigner: true,  isWritable: false },
      { pubkey: payer,           isSigner: true,  isWritable: true  },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: Buffer.concat(parts),
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, "confirmed");

  console.log("RPC:    ", RPC);
  console.log("Wallet: ", wallet.publicKey.toBase58());
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("Balance:", balance / 1e9, "XNT");
  if (balance < 0.05 * 1e9) {
    throw new Error("Wallet needs at least ~0.05 XNT for rent + fees");
  }

  // 1. Generate the mint keypair and save it BEFORE sending
  const mint = Keypair.generate();
  const keypairOut = path.join(__dirname, "..", "gum-mint-keypair.json");
  fs.writeFileSync(keypairOut, JSON.stringify(Array.from(mint.secretKey)));
  console.log("\nMint:        ", mint.publicKey.toBase58());
  console.log("Keypair saved:", keypairOut, "(gitignored)");

  // 2. Derive PDAs and ATA
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PID.toBuffer(), mint.publicKey.toBuffer()],
    METAPLEX_PID,
  );
  const ata = getAta(mint.publicKey, wallet.publicKey);

  console.log("Metadata PDA:", metadataPda.toBase58());
  console.log("Wallet ATA:  ", ata.toBase58());

  // 3. Get rent-exempt minimum for mint account
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_ACCOUNT_SIZE);

  // 4. Build the transaction
  const tx = new Transaction();

  // Create mint account
  tx.add(SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: mint.publicKey,
    lamports: mintRent,
    space: MINT_ACCOUNT_SIZE,
    programId: TOKEN_PID,
  }));

  // Initialize mint (no freeze authority)
  tx.add(ixInitializeMint2(mint.publicKey, DECIMALS, wallet.publicKey, null));

  // Create Metaplex metadata
  tx.add(ixCreateMetadataV3(
    metadataPda,
    mint.publicKey,
    wallet.publicKey, // mint authority
    wallet.publicKey, // payer
    wallet.publicKey, // update authority
  ));

  // Create the wallet's ATA
  tx.add(ixCreateAta(wallet.publicKey, wallet.publicKey, mint.publicKey, ata));

  // Mint full supply
  tx.add(ixMintTo(mint.publicKey, ata, wallet.publicKey, SUPPLY));

  // Revoke mint authority (set to None)
  tx.add(ixSetAuthority(mint.publicKey, wallet.publicKey, 0, null));

  console.log("\nSending transaction with", tx.instructions.length, "instructions...");
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet, mint], {
    commitment: "confirmed",
    skipPreflight: false,
  });

  console.log("\n✅ Done");
  console.log("Signature:", sig);
  console.log("Mint:     ", mint.publicKey.toBase58());
  console.log("Supply:   ", SUPPLY.toString(), "(1,000,000,000 GUM)");
  console.log("Decimals: ", DECIMALS);
  console.log("Mint auth:  REVOKED");
  console.log("Freeze auth: none");
  console.log("\nExplorer: https://explorer.testnet.x1.xyz/address/" + mint.publicKey.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
