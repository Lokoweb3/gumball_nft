// Withdraws ALL liquidity from an XDEX pool and unwraps WSOL.
//
// Usage:
//   node scripts/withdraw-pool.cjs <pool-state-pubkey>
//
// Defaults to the pool we just created (200K GUM + 10 XNT).

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── Constants ───────────────────────────────────────────────────────────────
const XDEX_PID    = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const TOKEN_PID   = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022  = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOC_PID   = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PID    = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const WSOL_MINT   = new PublicKey("So11111111111111111111111111111111111111112");

// ── Config ──────────────────────────────────────────────────────────────────
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";
const POOL_STATE = new PublicKey(process.argv[2] || "AyQV1DggndVqonebqcG1jNyU29cyySLNGMpHKkqrZyGL");
const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

// ── Helpers ─────────────────────────────────────────────────────────────────
function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID
  );
  return ata;
}

function readU64LE(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(RPC, "confirmed");

  console.log("RPC:        ", RPC);
  console.log("Wallet:     ", wallet.publicKey.toBase58());
  console.log("Pool state: ", POOL_STATE.toBase58());

  // Fetch pool state to get mints + lp_mint + vaults
  const poolInfo = await connection.getAccountInfo(POOL_STATE);
  if (!poolInfo) throw new Error("Pool not found");

  // Raydium CPMM PoolState layout (after 8-byte discriminator):
  // amm_config (32), pool_creator (32), token0_vault (32), token1_vault (32),
  // lp_mint (32), token0_mint (32), token1_mint (32), ...
  const d = poolInfo.data;
  const off = 8;
  const ammConfig = new PublicKey(d.slice(off,        off + 32));
  const vault0    = new PublicKey(d.slice(off + 64,   off + 96));
  const vault1    = new PublicKey(d.slice(off + 96,   off + 128));
  const lpMint    = new PublicKey(d.slice(off + 128,  off + 160));
  const mint0     = new PublicKey(d.slice(off + 160,  off + 192));
  const mint1     = new PublicKey(d.slice(off + 192,  off + 224));

  console.log("\nAMM config: ", ammConfig.toBase58());
  console.log("Mint0:      ", mint0.toBase58(), mint0.equals(WSOL_MINT) ? "(WSOL)" : "");
  console.log("Mint1:      ", mint1.toBase58(), mint1.equals(WSOL_MINT) ? "(WSOL)" : "");
  console.log("LP mint:    ", lpMint.toBase58());

  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")], XDEX_PID
  );

  const userLp = getAta(lpMint, wallet.publicKey);
  const userToken0 = getAta(mint0, wallet.publicKey);
  const userToken1 = getAta(mint1, wallet.publicKey);

  // Read user's LP balance
  const lpInfo = await connection.getAccountInfo(userLp);
  if (!lpInfo) throw new Error("User has no LP account");
  const lpAmount = readU64LE(lpInfo.data, 64);
  if (lpAmount === 0n) throw new Error("User LP balance is 0");
  console.log("\nUser LP balance:", lpAmount.toString());

  // Build withdraw instruction
  const data = Buffer.alloc(8 + 8 + 8 + 8);
  disc("withdraw").copy(data, 0);
  data.writeBigUInt64LE(lpAmount, 8);  // full balance
  data.writeBigUInt64LE(0n, 16);        // min_token0_out
  data.writeBigUInt64LE(0n, 24);        // min_token1_out

  const ix = new TransactionInstruction({
    programId: XDEX_PID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: authority,        isSigner: false, isWritable: false },
      { pubkey: POOL_STATE,       isSigner: false, isWritable: true  },
      { pubkey: userLp,           isSigner: false, isWritable: true  },
      { pubkey: userToken0,       isSigner: false, isWritable: true  },
      { pubkey: userToken1,       isSigner: false, isWritable: true  },
      { pubkey: vault0,           isSigner: false, isWritable: true  },
      { pubkey: vault1,           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PID,        isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022,       isSigner: false, isWritable: false },
      { pubkey: mint0,            isSigner: false, isWritable: false },
      { pubkey: mint1,            isSigner: false, isWritable: false },
      { pubkey: lpMint,           isSigner: false, isWritable: true  },
      { pubkey: MEMO_PID,         isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();

  // Auto-create receiving ATAs if missing
  for (const [ata, m] of [[userToken0, mint0], [userToken1, mint1]]) {
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      tx.add(new TransactionInstruction({
        programId: ASSOC_PID,
        keys: [
          { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
          { pubkey: ata,                     isSigner: false, isWritable: true  },
          { pubkey: wallet.publicKey,        isSigner: false, isWritable: false },
          { pubkey: m,                       isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PID,               isSigner: false, isWritable: false },
        ],
        data: Buffer.alloc(0),
      }));
    }
  }
  tx.add(ix);

  console.log("\nWithdrawing all liquidity...");
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log("✅ Withdrawn:", sig);

  // Unwrap WSOL back to native XNT
  const wsolAta = mint0.equals(WSOL_MINT) ? userToken0 : userToken1;
  if (mint0.equals(WSOL_MINT) || mint1.equals(WSOL_MINT)) {
    console.log("\nUnwrapping WSOL...");
    const closeIx = new TransactionInstruction({
      programId: TOKEN_PID,
      keys: [
        { pubkey: wsolAta,          isSigner: false, isWritable: true  },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: true  },
        { pubkey: wallet.publicKey, isSigner: true,  isWritable: false },
      ],
      data: Buffer.from([9]), // CloseAccount
    });
    const closeSig = await sendAndConfirmTransaction(connection, new Transaction().add(closeIx), [wallet]);
    console.log("✅ WSOL unwrapped:", closeSig);
  }

  console.log("\n✅ Done — all liquidity returned to wallet");
}

main().catch((e) => { console.error(e); process.exit(1); });
