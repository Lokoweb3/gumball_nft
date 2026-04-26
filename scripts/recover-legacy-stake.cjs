// One-shot recovery of NFTs staked under the v1 (pre-Phase-1) StakeAccount layout.
// Auto-discovers all v1 stake accounts owned by the wallet, recovers each one.
//
// Usage:
//   node scripts/recover-legacy-stake.cjs
//   WALLET=/path/to/owner-wallet.json node scripts/recover-legacy-stake.cjs

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
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";

const V1_STAKE_ACCOUNT_SIZE = 90; // disc(8) + owner(32) + nft_mint(32) + rarity(1) + staked_at(8) + last_claimed(8) + bump(1)

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

  const [legacyStakeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config")], PROGRAM_ID,
  );
  console.log("v1 StakeConfig PDA:", legacyStakeConfig.toBase58());

  // Sanity — old config still on chain?
  const cfgInfo = await connection.getAccountInfo(legacyStakeConfig);
  if (!cfgInfo) {
    console.log("v1 StakeConfig PDA does not exist — nothing to recover.");
    return;
  }
  console.log("v1 StakeConfig data length:", cfgInfo.data.length, "bytes (expected 89)");

  // Find all v1 StakeAccounts owned by this wallet via dataSize + memcmp
  console.log("\nScanning for v1 stake accounts owned by this wallet...");
  const accts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: V1_STAKE_ACCOUNT_SIZE },
      { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } }, // owner field
    ],
  });
  console.log(`Found ${accts.length} v1 stake account(s).`);

  if (accts.length === 0) return;

  for (const { pubkey, account } of accts) {
    const nftMintBytes = account.data.slice(40, 72);
    const nftMint = new PublicKey(nftMintBytes);
    const rarity = account.data[72];
    const RARITY_NAMES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
    console.log(`\n  ─── ${nftMint.toBase58()} (${RARITY_NAMES[rarity] || "?"}) ───`);
    console.log(`     v1 StakeAccount: ${pubkey.toBase58()}`);

    const legacyVaultAta = getAta(nftMint, legacyStakeConfig);
    const userAta = getAta(nftMint, wallet.publicKey);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // user
        { pubkey: legacyStakeConfig,       isSigner: false, isWritable: false }, // legacy_stake_config
        { pubkey: pubkey,                  isSigner: false, isWritable: true  }, // legacy_stake_account
        { pubkey: nftMint,                 isSigner: false, isWritable: false }, // nft_mint
        { pubkey: legacyVaultAta,          isSigner: false, isWritable: true  }, // legacy_vault_ata
        { pubkey: userAta,                 isSigner: false, isWritable: true  }, // user_ata
        { pubkey: TOKEN_PID,               isSigner: false, isWritable: false }, // token_program
        { pubkey: ASSOC_PID,               isSigner: false, isWritable: false }, // associated_token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false }, // rent
      ],
      data: disc("recover_legacy_v1_stake"),
    });

    try {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
      console.log(`     ✅ Recovered: ${sig}`);
    } catch (e) {
      console.log(`     ❌ Failed: ${e.message?.slice(0, 200)}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
