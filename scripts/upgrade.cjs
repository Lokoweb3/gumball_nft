/**
 * upgrade.cjs — Burn N gumballs to get 1 of the next rarity tier
 *
 * Usage:
 *   node scripts/upgrade.cjs            ← shows your collection + upgrade options
 *   node scripts/upgrade.cjs <rarity>   ← performs the upgrade (0=Common, 1=Uncommon, etc.)
 *
 * Examples:
 *   node scripts/upgrade.cjs 0   ← burn 5 Commons → 1 Uncommon
 *   node scripts/upgrade.cjs 1   ← burn 3 Uncommons → 1 Rare
 *   node scripts/upgrade.cjs 2   ← burn 2 Rares → 1 Epic
 *   node scripts/upgrade.cjs 3   ← burn 2 Epics → 1 Legendary
 */

const {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const fs  = require("fs");
const crypto = require("crypto");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PROGRAM_ID  = new PublicKey("2V4iVvbNFXAa44frz12YUZJgJiQhcYTxbok9CNUUruC4");
const MACHINE_PDA = new PublicKey("BJkm8LoVYwB34e4QWrxhg6tMYRcQdhKK9swXeUYtc5KX");
const RPC         = "https://rpc.testnet.x1.xyz";

const TOKEN_PROGRAM_ID            = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SLOT_HASHES                 = new PublicKey("SysvarS1otHashes111111111111111111111111111");

const RARITY   = ["Common","Uncommon","Rare","Epic","Legendary"];
const FLAVORS  = ["Cherry","Grape","Watermelon","Blueberry","Strawberry","Lemon","Lime","Orange","Bubblegum","Cotton Candy","Peach","Pineapple","Raspberry","Mint","Cinnamon","Root Beer","Banana","Green Apple","Mango","Mystery"];
const COLORS   = ["Cherry Red","Grape Purple","Melon Pink","Berry Blue","Rose Gold","Citrus Yellow","Lime Green","Tangerine","Cotton White","Midnight Black","Shimmer Silver","Rainbow"];
const SPECIALS = ["None","None","None","None","Glitter","Double Bubble","Holographic","Crystal"];
const BURNS_REQUIRED = [5, 3, 2, 2]; // indexed by rarity

const walletPath = process.env.ANCHOR_WALLET || (require("os").homedir() + "/.config/solana/id.json");
const secretKey  = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
const wallet     = Keypair.fromSecretKey(secretKey);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function getGumballPda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("gumball"), mint.toBytes()],
    PROGRAM_ID
  );
  return pda;
}

// ── FETCH COLLECTION ──────────────────────────────────────────────────────────

async function fetchCollection(connection) {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: 8+32+32+8+1+1+1+1+8+1 },
      { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
    ],
  });

  return accounts.map(({ pubkey, account }) => {
    const d  = account.data;
    const dv = new DataView(d.buffer, d.byteOffset);
    return {
      pda:     pubkey,
      serial:  Number(dv.getBigUint64(8+32+32, true)),
      flavor:  FLAVORS [d[8+32+32+8]]   || "?",
      color:   COLORS  [d[8+32+32+8+1]] || "?",
      rarity:  d[8+32+32+8+2],
      special: SPECIALS[d[8+32+32+8+3]] || "?",
    };
  }).sort((a, b) => a.serial - b.serial);
}

// ── SHOW COLLECTION + UPGRADE OPTIONS ────────────────────────────────────────

async function showCollection(connection) {
  const gumballs = await fetchCollection(connection);

  console.log(`\n🎰 YOUR COLLECTION (${gumballs.length} gumballs)\n`);
  console.log("─".repeat(65));
  gumballs.forEach(g => {
    console.log(`  #${String(g.serial).padStart(4,"0")} | ${RARITY[g.rarity].padEnd(10)} | ${g.flavor.padEnd(14)} | ${g.color.padEnd(15)} | ${g.special}`);
  });

  console.log("\n🔥 UPGRADE OPTIONS\n");
  console.log("─".repeat(65));

  const byRarity = [0,1,2,3].map(r => ({
    rarity: r,
    name:   RARITY[r],
    next:   RARITY[r+1],
    needed: BURNS_REQUIRED[r],
    have:   gumballs.filter(g => g.rarity === r).length,
  }));

  byRarity.forEach(b => {
    const canUpgrade = b.have >= b.needed;
    const status = canUpgrade
      ? `✅ CAN UPGRADE (${b.have}/${b.needed})`
      : `❌ Need ${b.needed - b.have} more ${b.name}`;
    console.log(`  Burn ${b.needed}x ${b.name.padEnd(10)} → 1 ${b.next.padEnd(10)} | You have ${b.have} | ${status}`);
  });

  console.log("\nTo upgrade, run:");
  console.log("  node scripts/upgrade.cjs 0   ← burn 5 Commons → 1 Uncommon");
  console.log("  node scripts/upgrade.cjs 1   ← burn 3 Uncommons → 1 Rare");
  console.log("  node scripts/upgrade.cjs 2   ← burn 2 Rares → 1 Epic");
  console.log("  node scripts/upgrade.cjs 3   ← burn 2 Epics → 1 Legendary\n");
}

// ── PERFORM UPGRADE ───────────────────────────────────────────────────────────

async function performUpgrade(connection, burnRarity) {
  const gumballs   = await fetchCollection(connection);
  const toburn     = gumballs.filter(g => g.rarity === burnRarity);
  const needed     = BURNS_REQUIRED[burnRarity];

  if (toburn.length < needed) {
    console.log(`\n❌ Not enough ${RARITY[burnRarity]} gumballs.`);
    console.log(`   Have: ${toburn.length} | Need: ${needed}\n`);
    process.exit(1);
  }

  const selected = toburn.slice(0, needed);
  console.log(`\n🔥 Burning ${needed}x ${RARITY[burnRarity]} → 1x ${RARITY[burnRarity+1]}`);
  console.log("─".repeat(50));
  selected.forEach(g => console.log(`  Burning #${String(g.serial).padStart(4,"0")} | ${g.flavor} | ${g.color}`));

  // Get mint addresses from token accounts
  // We need to find the mint for each GumballData PDA
  // The PDA seeds are [b"gumball", mint], so we can't reverse-derive the mint
  // Instead, look up the token accounts for the wallet and match
  const tokenAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });

  // Find mints with balance = 1 that correspond to our gumballs
  // Match by finding ATAs that have balance 1 and are gumball mints
  const mintMap = new Map();
  for (const { pubkey, account } of tokenAccounts.value) {
    const mintBytes = account.data.slice(0, 32);
    const mint      = new PublicKey(mintBytes);
    const amtBytes  = account.data.slice(64, 72);
    const dv        = new DataView(amtBytes.buffer, amtBytes.byteOffset);
    const amount    = Number(dv.getBigUint64(0, true));
    if (amount === 1) {
      const gbPda = getGumballPda(mint);
      mintMap.set(gbPda.toBase58(), mint);
    }
  }

  // Match selected gumballs to their mints
  const burnData = selected.map(g => {
    const mint = mintMap.get(g.pda.toBase58());
    if (!mint) throw new Error(`Could not find mint for gumball #${g.serial}`);
    return { ...g, mint, ata: getAta(mint, wallet.publicKey) };
  });

  // New mint for upgraded gumball
  const newMintKp  = Keypair.generate();
  const newAta     = getAta(newMintKp.publicKey, wallet.publicKey);
  const newGbPda   = getGumballPda(newMintKp.publicKey);

  const [machineAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("machine_authority")], PROGRAM_ID
  );

  // Build instruction data: discriminator only (no args)
  const data = disc("burn_to_upgrade");

  // Build account keys
  // Named accounts: burner, machine, machine_authority, gumball_a, mint_a, ata_a, gumball_b, mint_b, ata_b, new_mint, new_ata, new_gumball_data, slot_hashes, token_program, assoc_token, system, rent
  const keys = [
    { pubkey: wallet.publicKey,         isSigner: true,  isWritable: true  },
    { pubkey: MACHINE_PDA,              isSigner: false, isWritable: true  },
    { pubkey: machineAuthority,         isSigner: false, isWritable: false },
    { pubkey: burnData[0].pda,          isSigner: false, isWritable: true  },
    { pubkey: burnData[0].mint,         isSigner: false, isWritable: true  },
    { pubkey: burnData[0].ata,          isSigner: false, isWritable: true  },
    { pubkey: burnData[1].pda,          isSigner: false, isWritable: true  },
    { pubkey: burnData[1].mint,         isSigner: false, isWritable: true  },
    { pubkey: burnData[1].ata,          isSigner: false, isWritable: true  },
    { pubkey: newMintKp.publicKey,      isSigner: true,  isWritable: true  },
    { pubkey: newAta,                   isSigner: false, isWritable: true  },
    { pubkey: newGbPda,                 isSigner: false, isWritable: true  },
    { pubkey: SLOT_HASHES,              isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
  ];

  // Add remaining burns as triplets (gumball_pda, mint, ata)
  const remaining = [];
  for (let i = 2; i < burnData.length; i++) {
    remaining.push({ pubkey: burnData[i].pda,  isSigner: false, isWritable: true });
    remaining.push({ pubkey: burnData[i].mint, isSigner: false, isWritable: true });
    remaining.push({ pubkey: burnData[i].ata,  isSigner: false, isWritable: true });
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [...keys, ...remaining],
    data: Buffer.from(data),
  });

  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const signers = [wallet, newMintKp];
  console.log("\nSending transaction...");
  const sig = await sendAndConfirmTransaction(connection, tx, signers);

  console.log(`\n✅ UPGRADE SUCCESSFUL!`);
  console.log(`   Burned: ${needed}x ${RARITY[burnRarity]}`);
  console.log(`   Received: 1x ${RARITY[burnRarity+1]}`);
  console.log(`   New mint: ${newMintKp.publicKey.toBase58()}`);
  console.log(`   TX: ${sig}\n`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const arg = process.argv[2];

  if (arg === undefined) {
    await showCollection(connection);
  } else {
    const burnRarity = parseInt(arg);
    if (isNaN(burnRarity) || burnRarity < 0 || burnRarity > 3) {
      console.log("Usage: node scripts/upgrade.cjs <rarity 0-3>");
      process.exit(1);
    }
    await performUpgrade(connection, burnRarity);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
