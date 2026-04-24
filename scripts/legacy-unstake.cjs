const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LP_MINT    = new PublicKey("6hgAVwfjorEkNLXUMuvfotehKK1e1Ee3ftQaipTcj5tg");

const RPC = "https://rpc.testnet.x1.xyz";
const walletPath = process.argv[2] || (require("os").homedir() + "/x1-wallet.json");
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
const wallet = Keypair.fromSecretKey(secretKey);

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

  const [stakeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config")], PROGRAM_ID
  );

  // Find all 97-byte LP stake accounts
  const accts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 97 }],
  });
  console.log(`Found ${accts.length} old (97-byte) LP stake accounts`);

  const mine = [];
  for (const a of accts) {
    const posMint = new PublicKey(a.account.data.slice(8, 40));
    const posAta = getAta(posMint, wallet.publicKey);
    const ataInfo = await connection.getAccountInfo(posAta);
    if (!ataInfo || ataInfo.data.length < 72) continue;
    const bal = Number(new DataView(ataInfo.data.buffer, ataInfo.data.byteOffset).getBigUint64(64, true));
    if (bal === 1) {
      const amount = Number(new DataView(a.account.data.buffer, a.account.data.byteOffset).getBigUint64(72, true));
      mine.push({ stakePda: a.pubkey, posMint, posAta, amount });
    }
  }
  console.log(`You own ${mine.length} legacy positions`);

  if (mine.length === 0) { console.log("Nothing to unstake"); return; }

  const vaultLpAta = getAta(LP_MINT, stakeConfigPda);
  const userLpAta = getAta(LP_MINT, wallet.publicKey);
  const discBytes = disc("legacy_unstake_lp");

  for (const p of mine) {
    console.log(`\nUnstaking ${p.amount / 1e9} LP from ${p.stakePda.toBase58().slice(0, 12)}...`);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
        { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  },
        { pubkey: p.stakePda,              isSigner: false, isWritable: true  },
        { pubkey: p.posMint,               isSigner: false, isWritable: true  },
        { pubkey: p.posAta,                isSigner: false, isWritable: true  },
        { pubkey: LP_MINT,                 isSigner: false, isWritable: false },
        { pubkey: vaultLpAta,              isSigner: false, isWritable: true  },
        { pubkey: userLpAta,               isSigner: false, isWritable: true  },
        { pubkey: TOKEN_PID,               isSigner: false, isWritable: false },
        { pubkey: ASSOC_PID,               isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
      ],
      data: discBytes,
    });
    try {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
      console.log(`  ✅ ${sig.slice(0, 20)}...`);
    } catch (e) {
      console.error(`  ❌ ${e.message}`);
    }
  }

  console.log("\n✅ Legacy unstake complete!");
}

main().catch(console.error);
