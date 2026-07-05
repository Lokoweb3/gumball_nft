// Backfill: attach Metaplex metadata to every gumball that doesn't have it,
// so they display in wallet galleries. Permissionless — the wallet running
// this pays the metadata rent (~0.0056 XNT per NFT).
//
// Usage:
//   node scripts/attach-metadata.cjs            # attach for all gumballs missing metadata
//   DRY_RUN=1 node scripts/attach-metadata.cjs  # just report what would be attached
//   NFT_MINT=<pubkey> node scripts/attach-metadata.cjs   # single mint

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram, SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const METAPLEX_PID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";
const DRY = !!process.env.DRY_RUN;

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

function disc(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8); }

async function main() {
  const c = new Connection(RPC, "confirmed");
  console.log("Payer:", wallet.publicKey.toBase58());

  const [machineAuth] = PublicKey.findProgramAddressSync([Buffer.from("machine_authority")], PROGRAM_ID);

  let mints;
  if (process.env.NFT_MINT) {
    mints = [new PublicKey(process.env.NFT_MINT)];
  } else {
    // Every gumball mint was created with mint::authority = machine_authority,
    // so they're enumerable straight off the SPL Token program:
    //   Mint layout: authority COption tag (0..4) + authority pubkey (4..36)
    const TOKEN_PID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const mintAccounts = await c.getProgramAccounts(TOKEN_PID, {
      filters: [
        { dataSize: 82 },
        { memcmp: { offset: 4, bytes: machineAuth.toBase58() } },
      ],
    });
    mints = mintAccounts.map(a => a.pubkey);
  }
  console.log(`Checking ${mints.length} mint(s)...`);

  let attached = 0, skipped = 0, failed = 0;
  for (const mint of mints) {
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METAPLEX_PID.toBuffer(), mint.toBuffer()], METAPLEX_PID,
    );
    const [gumballPda] = PublicKey.findProgramAddressSync([Buffer.from("gumball"), mint.toBuffer()], PROGRAM_ID);

    const [meta, gd] = await Promise.all([c.getAccountInfo(metadataPda), c.getAccountInfo(gumballPda)]);
    if (!gd) { console.log(`  ${mint.toBase58().slice(0,8)}: not a gumball — skip`); skipped++; continue; }
    if (meta) { skipped++; continue; } // already has metadata

    if (DRY) { console.log(`  ${mint.toBase58().slice(0,8)}: WOULD attach`); attached++; continue; }

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // payer
        { pubkey: machineAuth,             isSigner: false, isWritable: false }, // machine_authority
        { pubkey: mint,                    isSigner: false, isWritable: false }, // nft_mint
        { pubkey: gumballPda,              isSigner: false, isWritable: false }, // gumball_data
        { pubkey: metadataPda,             isSigner: false, isWritable: true  }, // metadata_account
        { pubkey: METAPLEX_PID,            isSigner: false, isWritable: false }, // metadata_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
      ],
      data: disc("attach_metadata"),
    });
    try {
      const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [wallet]);
      console.log(`  ✅ ${mint.toBase58().slice(0,8)}: attached (${sig.slice(0,12)})`);
      attached++;
    } catch (e) {
      console.log(`  ❌ ${mint.toBase58().slice(0,8)}: ${e.message.slice(0,100)}`);
      failed++;
    }
  }
  console.log(`\nDone: ${attached} attached, ${skipped} skipped, ${failed} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
