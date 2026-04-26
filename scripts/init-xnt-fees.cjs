// Phase 2: one-time admin call to initialize the four PDAs that power XNT
// fee sharing (nft_xnt_pool, lp_xnt_pool, nft_xnt_state, lp_xnt_state).
//
// Must be called by the staking authority (same wallet that ran initialize_staking).
//
// Usage:
//   node scripts/init-xnt-fees.cjs

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());

  const [stakeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("stake_config_v2")], PROGRAM_ID);
  const [nftPool]        = PublicKey.findProgramAddressSync([Buffer.from("nft_xnt_pool")],     PROGRAM_ID);
  const [lpPool]         = PublicKey.findProgramAddressSync([Buffer.from("lp_xnt_pool")],      PROGRAM_ID);
  const [nftState]       = PublicKey.findProgramAddressSync([Buffer.from("xnt_fee_state_nft")], PROGRAM_ID);
  const [lpState]        = PublicKey.findProgramAddressSync([Buffer.from("xnt_fee_state_lp")],  PROGRAM_ID);

  console.log("nft_xnt_pool:    ", nftPool.toBase58());
  console.log("lp_xnt_pool:     ", lpPool.toBase58());
  console.log("nft_xnt_state:   ", nftState.toBase58());
  console.log("lp_xnt_state:    ", lpState.toBase58());

  const existing = await connection.getAccountInfo(nftPool);
  if (existing) {
    console.log("\n⚠️  XNT fee state already initialized — skipping.");
    return;
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // authority
      { pubkey: stakeConfigPda,          isSigner: false, isWritable: false }, // stake_config
      { pubkey: nftPool,                 isSigner: false, isWritable: true  }, // nft_xnt_pool
      { pubkey: lpPool,                  isSigner: false, isWritable: true  }, // lp_xnt_pool
      { pubkey: nftState,                isSigner: false, isWritable: true  }, // nft_xnt_state
      { pubkey: lpState,                 isSigner: false, isWritable: true  }, // lp_xnt_state
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data: disc("initialize_xnt_fees"),
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
  console.log("\n✅ XNT fee sharing initialized:", sig);
  console.log("\nFrom now on, the following auto-flow into the staker pools:");
  console.log("  Mint revenue:        50% treasury / 40% NFT pool / 10% LP pool");
  console.log("  Burn-to-upgrade fee: 50% treasury / 40% NFT pool / 10% LP pool");
  console.log("  Marketplace royalty: 50% treasury / 25% NFT pool / 25% LP pool");
  console.log("\nStakers claim with claim_xnt_fees_nft / claim_xnt_fees_lp.");
}

main().catch((e) => { console.error(e); process.exit(1); });
