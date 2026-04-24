const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const STAKE_ACCOUNT_SIZE = 90; // 8 disc + 32 owner + 32 nft_mint + 1 rarity + 8 staked_at + 8 last_claimed + 1 bump

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
  const [gumMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("gum_mint")], PROGRAM_ID
  );
  const stakerGumAta = getAta(gumMintPda, wallet.publicKey);

  // Find all StakeAccounts owned by this wallet
  const accts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: STAKE_ACCOUNT_SIZE },
      { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
    ],
  });
  console.log(`Found ${accts.length} staked NFT positions\n`);

  if (accts.length === 0) {
    console.log("Nothing to unstake");
    return;
  }

  const discBytes = disc("unstake");
  let success = 0, failed = 0;

  // One unstake per transaction (12 accounts each — too many for batching)
  for (let i = 0; i < accts.length; i++) {
    const a = accts[i];
    const nftMint = new PublicKey(a.account.data.slice(8 + 32, 8 + 32 + 32));
    const rarity = a.account.data[8 + 32 + 32];
    const rarities = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
    const vaultAta = getAta(nftMint, stakeConfigPda);
    const userAta = getAta(nftMint, wallet.publicKey);

    process.stdout.write(`[${i+1}/${accts.length}] Unstaking ${rarities[rarity] || '?'} ${nftMint.toBase58().slice(0,8)}... `);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
        { pubkey: stakeConfigPda,          isSigner: false, isWritable: true  },
        { pubkey: a.pubkey,                isSigner: false, isWritable: true  },
        { pubkey: nftMint,                 isSigner: false, isWritable: false },
        { pubkey: vaultAta,                isSigner: false, isWritable: true  },
        { pubkey: userAta,                 isSigner: false, isWritable: true  },
        { pubkey: gumMintPda,              isSigner: false, isWritable: true  },
        { pubkey: stakerGumAta,            isSigner: false, isWritable: true  },
        { pubkey: TOKEN_PID,               isSigner: false, isWritable: false },
        { pubkey: ASSOC_PID,               isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
      ],
      data: discBytes,
    });

    try {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
      console.log(`✅ ${sig.slice(0, 16)}...`);
      success++;
    } catch (e) {
      console.log(`❌ ${(e.message || '').slice(0, 60)}`);
      failed++;
    }
  }

  console.log(`\n✅ ${success} unstaked, ❌ ${failed} failed`);
}

main().catch(console.error);
