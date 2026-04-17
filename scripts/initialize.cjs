const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs     = require("fs");

const PROGRAM_ID  = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC         = "https://rpc.testnet.x1.xyz";
const walletPath  = process.env.WALLET || (require("os").homedir() + "/.config/solana/id.json");
const secretKey   = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
const wallet      = Keypair.fromSecretKey(secretKey);

const FORCE   = process.argv.includes("--force");
const MIGRATE = process.argv.includes("--migrate");

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");

  console.log("Wallet:     ", wallet.publicKey.toBase58());
  console.log("Balance:    ", await connection.getBalance(wallet.publicKey) / 1e9, "SOL");

  const [machinePda] = PublicKey.findProgramAddressSync([Buffer.from("machine")], PROGRAM_ID);
  console.log("Machine PDA:", machinePda.toBase58());

  const existing = await connection.getAccountInfo(machinePda);
  const EXPECTED_SIZE = 8 + 130; // disc(8) + Machine::LEN(130)

  // ── MIGRATE existing account to new struct size ───────────────────────────
  if (MIGRATE && existing) {
    console.log(`\nMigrating Machine PDA (${existing.data.length} → ${EXPECTED_SIZE} bytes)...`);
    const migrateData = disc("migrate_machine");
    const migrateIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: machinePda,              isSigner: false, isWritable: true  },
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: migrateData,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(migrateIx), [wallet]);
    console.log("✅ Migration tx:", sig);
    console.log("   Machine account resized and total_burned initialized to 0.");
    // Fall through to activation
  }

  // ── INITIALIZE fresh machine ──────────────────────────────────────────────
  const currentInfo = await connection.getAccountInfo(machinePda);
  if (!currentInfo) {
    console.log("\nInitializing new Machine...");
    const mintPrice = Buffer.alloc(8);
    mintPrice.writeBigUInt64LE(BigInt(10_000_000), 0);
    const treasury = wallet.publicKey.toBuffer();
    const data = Buffer.concat([disc("initialize_machine"), mintPrice, treasury]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
        { pubkey: machinePda,              isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log("✅ Init tx:", sig);
  } else {
    const size = currentInfo.data.length;
    if (size < EXPECTED_SIZE && !MIGRATE) {
      console.log(`\n⚠️  Machine struct mismatch: ${size} bytes on-chain, expected ${EXPECTED_SIZE}.`);
      console.log("   The struct changed (added total_burned field).");
      console.log("   Run migration first:\n");
      console.log("   node scripts/initialize.cjs --migrate\n");
      return;
    }
    console.log(`\nMachine exists (${size} bytes) ✅`);
  }

  // ── SET ORACLE ────────────────────────────────────────────────────────────
  console.log("\nSetting oracle...");
  try {
    const oracleIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true,  isWritable: true },
        { pubkey: machinePda,       isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([disc("set_oracle"), wallet.publicKey.toBuffer()]),
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(oracleIx), [wallet]);
    console.log("✅ Oracle set:", sig);
  } catch(e) {
    console.log("   Oracle set skipped:", e.message?.slice(0, 60));
  }

  // ── ACTIVATE ─────────────────────────────────────────────────────────────
  console.log("\nActivating machine...");
  const activateIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true,  isWritable: true },
      { pubkey: machinePda,       isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("set_active"), Buffer.from([1])]),
  });
  const sig2 = await sendAndConfirmTransaction(connection, new Transaction().add(activateIx), [wallet]);
  console.log("✅ Activate tx:", sig2);
  console.log("\n🎰 Gumball machine is LIVE!");
  console.log("   Program:     AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
  console.log("   Machine PDA:", machinePda.toBase58());
}

main().catch(console.error);


function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");

  console.log("Wallet:     ", wallet.publicKey.toBase58());
  console.log("Balance:    ", await connection.getBalance(wallet.publicKey) / 1e9, "SOL");

  const [machinePda] = PublicKey.findProgramAddressSync([Buffer.from("machine")], PROGRAM_ID);
  console.log("Machine PDA:", machinePda.toBase58());

  const existing = await connection.getAccountInfo(machinePda);

  // ── FORCE: close old account via system transfer trick ───────────────────
  // The program must have a close_machine instruction OR we use lamport drain.
  // Since we don't have one, we reassign the account by redeploying and using
  // the program's own realloc — simplest path: just send a 0-lamport drain tx
  // to move rent back, then the account will be auto-closed on next epoch.
  // ACTUALLY: the cleanest way on Solana devnet/testnet is to use
  // `solana account close` via CLI, but since we're in a script, we'll
  // drain lamports by having the authority withdraw them.

  if (existing && FORCE) {
    console.log("\n⚠️  --force: closing old Machine PDA...");
    console.log("   Old size:", existing.data.length, "bytes");

    // We need to close the PDA via the program — add a close_machine ix
    // Since lib.rs doesn't have close_machine, we use a workaround:
    // Transfer all lamports out using system program (only works if we own it)
    // The machine PDA is owned by the PROGRAM, not wallet — so we can't
    // drain it directly. We need to use `solana program close` or add an ix.
    //
    // Best testnet approach: use `solana account` to wipe it.
    // Let's try calling the program with a migrate instruction instead.
    // Since that doesn't exist, we'll use the Solana CLI approach:

    console.log("\n   Machine PDA is owned by the program.");
    console.log("   Run this CLI command to close it, then re-run this script:\n");
    console.log(`   solana account close ${machinePda.toBase58()} --url https://rpc.testnet.x1.xyz --keypair ${walletPath}\n`);
    console.log("   If that fails, use:\n");
    console.log(`   solana program close AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy --url https://rpc.testnet.x1.xyz\n`);
    console.log("   Then re-run: node scripts/initialize.cjs");

    // Try to realloc + reinit by calling initialize_machine which will fail
    // if account exists — instead try the migrate approach:
    await tryMigrate(connection, machinePda);
    return;
  }

  // ── INITIALIZE ────────────────────────────────────────────────────────────
  if (!existing) {
    console.log("\nInitializing new Machine...");
    const mintPrice = Buffer.alloc(8);
    mintPrice.writeBigUInt64LE(BigInt(10_000_000), 0); // 0.01 XNT
    const treasury = wallet.publicKey.toBuffer();
    const data = Buffer.concat([disc("initialize_machine"), mintPrice, treasury]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  },
        { pubkey: machinePda,              isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log("✅ Init tx:", sig);
  } else {
    const size = existing.data.length;
    console.log(`\nMachine already exists (${size} bytes).`);

    // Expected size: 8 (disc) + 32+32+32+8+8+8+1+1+8 = 8 + 130 = 138
    const EXPECTED = 8 + 130;
    if (size < EXPECTED) {
      console.log(`⚠️  Size mismatch! Expected ${EXPECTED} bytes, got ${size}.`);
      console.log("   The Machine struct changed (added total_burned field).");
      console.log("   Re-run with --force to migrate:\n");
      console.log("   node scripts/initialize.cjs --force\n");
      return;
    }
  }

  // ── SET ORACLE ────────────────────────────────────────────────────────────
  console.log("\nSetting oracle to wallet...");
  try {
    const oracleData = Buffer.concat([disc("set_oracle"), wallet.publicKey.toBuffer()]);
    const oracleIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: machinePda,       isSigner: false, isWritable: true  },
      ],
      data: oracleData,
    });
    const sig3 = await sendAndConfirmTransaction(connection, new Transaction().add(oracleIx), [wallet]);
    console.log("✅ Oracle set:", sig3);
  } catch(e) {
    console.log("   Oracle already set or skipped:", e.message?.slice(0, 60));
  }

  // ── ACTIVATE ─────────────────────────────────────────────────────────────
  console.log("\nActivating machine...");
  const activateData = Buffer.concat([disc("set_active"), Buffer.from([1])]);
  const activateIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: machinePda,       isSigner: false, isWritable: true  },
    ],
    data: activateData,
  });
  const sig2 = await sendAndConfirmTransaction(connection, new Transaction().add(activateIx), [wallet]);
  console.log("✅ Activate tx:", sig2);
  console.log("\n🎰 Gumball machine is LIVE on X1 testnet!");
  console.log("   Program:     AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
  console.log("   Machine PDA:", machinePda.toBase58());
}

// ── MIGRATE: realloc the machine account to new size via system workaround ──
// Since we don't have a migrate instruction, on testnet the easiest path is
// to have the authority drain the old PDA lamports. But since the PDA is
// program-owned, only the program can move lamports out.
// So we need to add a `migrate_machine` instruction — or just wipe the account.
async function tryMigrate(connection, machinePda) {
  console.log("\nAttempting migration via realloc workaround...");
  console.log("Since the Machine PDA is program-owned, migration requires");
  console.log("one of these approaches:\n");
  console.log("OPTION A — Easiest (testnet only):");
  console.log("  1. Comment out the existing Machine account check in lib.rs");
  console.log("  2. Add a migrate_machine instruction that reallocs + sets total_burned=0");
  console.log("  3. Rebuild and redeploy\n");
  console.log("OPTION B — Close via CLI (if you have close authority):");
  console.log(`  solana program close-account ${machinePda.toBase58()} --url https://rpc.testnet.x1.xyz\n`);
  console.log("OPTION C — Add migrate_machine to lib.rs (recommended):");
  console.log("  See the migrate_machine instruction below.\n");
  console.log("─".repeat(60));
  console.log("Add this to lib.rs inside #[program]:\n");
  console.log(`
    pub fn migrate_machine(ctx: Context<MigrateMachine>) -> Result<()> {
        ctx.accounts.machine.total_burned = 0;
        Ok(())
    }
  `);
  console.log("\nAnd add this account struct:\n");
  console.log(`
    #[derive(Accounts)]
    pub struct MigrateMachine<'info> {
        #[account(
            mut,
            seeds = [b"machine"],
            bump = machine.bump,
            constraint = machine.authority == authority.key() @ GumballError::Unauthorized,
            realloc = 8 + Machine::LEN,
            realloc::payer = authority,
            realloc::zero = false,
        )]
        pub machine: Account<'info, Machine>,
        #[account(mut)]
        pub authority: Signer<'info>,
        pub system_program: Program<'info, System>,
    }
  `);
  console.log("─".repeat(60));
  console.log("\nAfter adding migrate_machine, rebuild, redeploy, then run:");
  console.log("  node scripts/initialize.cjs --migrate");
}

main().catch(console.error);