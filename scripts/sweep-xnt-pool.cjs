// Admin: sweep unattributed lamports from the XNT fee pools to the machine
// treasury. Only allowed while the corresponding stream has ZERO stakers
// (total_nft_weight == 0 for the NFT pool, total_lp_weight == 0 for the LP
// pool) — with no live entitlements the sweep cannot touch any staker's share.
//
// Unattributed lamports accumulate from: fees deposited while nobody was
// staked (absorbed at next stake), shares forfeited by pre-XntDebt legacy
// positions, unpayable remainders of closed positions, and rounding dust.
// The sweep leaves the pool's rent-exempt minimum and re-baselines last_seen.
//
// Usage:
//   node scripts/sweep-xnt-pool.cjs          # sweep both pools (skips non-empty streams)
//   node scripts/sweep-xnt-pool.cjs nft      # sweep only the NFT pool
//   node scripts/sweep-xnt-pool.cjs lp       # sweep only the LP pool

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction,
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
  const which = (process.argv[2] || "both").toLowerCase();
  const connection = new Connection(RPC, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());

  const [machinePda]     = PublicKey.findProgramAddressSync([Buffer.from("machine")],           PROGRAM_ID);
  const [stakeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("stake_config_v2")],   PROGRAM_ID);
  const [nftPool]        = PublicKey.findProgramAddressSync([Buffer.from("nft_xnt_pool")],      PROGRAM_ID);
  const [lpPool]         = PublicKey.findProgramAddressSync([Buffer.from("lp_xnt_pool")],       PROGRAM_ID);
  const [nftState]       = PublicKey.findProgramAddressSync([Buffer.from("xnt_fee_state_nft")], PROGRAM_ID);
  const [lpState]        = PublicKey.findProgramAddressSync([Buffer.from("xnt_fee_state_lp")],  PROGRAM_ID);

  // Machine layout: disc(8) + authority(32) + treasury(32) + ...
  const machineInfo = await connection.getAccountInfo(machinePda);
  if (!machineInfo) throw new Error("Machine PDA not found");
  const treasury = new PublicKey(machineInfo.data.slice(8 + 32, 8 + 32 + 32));
  console.log("Treasury:", treasury.toBase58());

  // StakeConfig layout: disc(8) + authority(32) + gum_mint(32) + vaults(64)
  //                     + total_staked(8) + total_claimed(8)
  //                     + total_nft_weight(16) + total_lp_weight(16) + ...
  const cfgInfo = await connection.getAccountInfo(stakeConfigPda);
  if (!cfgInfo) throw new Error("stake_config_v2 not found");
  const weightOff = 8 + 32 + 32 + 32 + 32 + 8 + 8;
  const totalNftWeight = cfgInfo.data.readBigUInt64LE(weightOff)      | (cfgInfo.data.readBigUInt64LE(weightOff + 8) << 64n);
  const totalLpWeight  = cfgInfo.data.readBigUInt64LE(weightOff + 16) | (cfgInfo.data.readBigUInt64LE(weightOff + 24) << 64n);

  const targets = [];
  if (which === "nft" || which === "both") {
    targets.push({ name: "NFT", ix: "sweep_xnt_pool_nft", state: nftState, pool: nftPool, weight: totalNftWeight });
  }
  if (which === "lp" || which === "both") {
    targets.push({ name: "LP", ix: "sweep_xnt_pool_lp", state: lpState, pool: lpPool, weight: totalLpWeight });
  }
  if (targets.length === 0) throw new Error(`Unknown target "${which}" — use nft, lp, or omit for both`);

  for (const t of targets) {
    const poolInfo = await connection.getAccountInfo(t.pool);
    const balance = poolInfo ? poolInfo.lamports : 0;
    console.log(`\n${t.name} pool: ${(balance / 1e9).toFixed(6)} XNT, total weight ${t.weight}`);
    if (t.weight !== 0n) {
      console.log(`  ⚠️  Stream has active stakers — sweep would be rejected on-chain, skipping.`);
      continue;
    }
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  }, // authority
        { pubkey: machinePda,       isSigner: false, isWritable: false }, // machine
        { pubkey: treasury,         isSigner: false, isWritable: true  }, // treasury
        { pubkey: stakeConfigPda,   isSigner: false, isWritable: false }, // stake_config
        { pubkey: t.state,          isSigner: false, isWritable: true  }, // xnt_state
        { pubkey: t.pool,           isSigner: false, isWritable: true  }, // xnt_pool
      ],
      data: disc(t.ix),
    });
    try {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
      const after = (await connection.getAccountInfo(t.pool)).lamports;
      console.log(`  ✅ Swept ${((balance - after) / 1e9).toFixed(6)} XNT to treasury: ${sig}`);
    } catch (e) {
      console.log(`  ❌ Sweep failed: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
