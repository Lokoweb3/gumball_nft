// Diagnostic: simulate a stake() call and dump full Anchor logs.
// Usage:
//   WALLET=/tmp/recover-wallet.json NFT_MINT=<mint> node scripts/debug-stake.cjs

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const PROGRAM = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN   = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC   = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC     = process.env.RPC || "https://rpc.testnet.x1.xyz";

const WALLET_PATH = process.env.WALLET || "/tmp/recover-wallet.json";
const NFT_MINT_STR = process.env.NFT_MINT || "CUWz7B5BfupbkTX3GWPt19QC3Nz9upBonKPQR76P9v8Z";

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"))));
const mint = new PublicKey(NFT_MINT_STR);

function getAta(m, o) {
  return PublicKey.findProgramAddressSync([o.toBuffer(), TOKEN.toBuffer(), m.toBuffer()], ASSOC)[0];
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("NFT mint:", mint.toBase58());

  const [cfg]   = PublicKey.findProgramAddressSync([Buffer.from("stake_config_v2")], PROGRAM);
  const [stk]   = PublicKey.findProgramAddressSync([Buffer.from("stake_v2"), mint.toBuffer()], PROGRAM);
  const [gd]    = PublicKey.findProgramAddressSync([Buffer.from("gumball"),  mint.toBuffer()], PROGRAM);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("nft_reward_vault")], PROGRAM);
  const userAta  = getAta(mint, wallet.publicKey);
  const vaultAta = PublicKey.findProgramAddressSync([cfg.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ASSOC)[0];

  console.log("\n── PDAs ──");
  console.log("stake_config:    ", cfg.toBase58());
  console.log("stake_account:   ", stk.toBase58());
  console.log("gumball_data:    ", gd.toBase58());
  console.log("nft_reward_vault:", vault.toBase58());
  console.log("user_ata:        ", userAta.toBase58());
  console.log("vault_ata:       ", vaultAta.toBase58());

  // Print sizes for diagnosis
  for (const [name, pk] of [["stake_config", cfg], ["gumball_data", gd], ["nft_reward_vault", vault], ["user_ata", userAta], ["nft_mint", mint]]) {
    const info = await c.getAccountInfo(pk);
    console.log(`  ${name.padEnd(20)} → ${info ? `${info.data.length} bytes, owner ${info.owner.toBase58().slice(0,8)}…` : "DOES NOT EXIST"}`);
  }

  const disc = crypto.createHash("sha256").update("global:stake").digest().slice(0, 8);
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
      { pubkey: cfg,                     isSigner: false, isWritable: true  },
      { pubkey: stk,                     isSigner: false, isWritable: true  },
      { pubkey: gd,                      isSigner: false, isWritable: false },
      { pubkey: mint,                    isSigner: false, isWritable: false },
      { pubkey: userAta,                 isSigner: false, isWritable: true  },
      { pubkey: vaultAta,                isSigner: false, isWritable: true  },
      { pubkey: vault,                   isSigner: false, isWritable: false },
      { pubkey: TOKEN,                   isSigner: false, isWritable: false },
      { pubkey: ASSOC,                   isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: disc,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(wallet);

  const sim = await c.simulateTransaction(tx);
  console.log("\n── SIM RESULT ──");
  console.log("ERR:", JSON.stringify(sim.value.err));
  console.log("LOGS:");
  (sim.value.logs || []).forEach(l => console.log("  " + l));
}

main().catch(e => { console.error(e); process.exit(1); });
