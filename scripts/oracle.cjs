/**
 * oracle.cjs — Gumball Machine Commit-Reveal Oracle
 *
 * C-2 FIX: Implements commit-reveal randomness scheme.
 *
 * Flow:
 *   1. Oracle generates secret = random_bytes()
 *   2. Computes commitment = sha256(secret || oracle_pubkey)
 *   3. Submits commitment on-chain (submit_commitment)
 *   4. Watches for MintRequest accounts referencing this commitment
 *   5. Reveals secret on-chain (reveal_and_mint) — contract verifies
 *      sha256(secret || oracle_pubkey) == stored_commitment, then
 *      derives seed from sha256(secret || slot_hash)
 *
 * Usage:
 *   node scripts/oracle.cjs
 *
 * Setup:
 *   Fund the oracle wallet (53fTZR...) with XNT for tx fees
 */

const {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs     = require("fs");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PROGRAM_ID  = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const MACHINE_PDA = new PublicKey("Ge8524seSpQ2BLRiMAnk5tg7YRKCTxVscQSxBvPvoyxY");
const RPC         = process.env.RPC_URL || "https://rpc.testnet.x1.xyz";
const POLL_MS     = 2000;
const MAX_AGE_S   = 270; // slightly less than MINT_TIMEOUT (300s)

const TOKEN_PROGRAM_ID            = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SLOT_HASHES                 = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const SYSVAR_RENT                 = new PublicKey("SysvarRent111111111111111111111111111111111");

// Secret store — persists commitment secrets across restarts (AES-256-GCM encrypted)
const SECRETS_FILE = process.env.SECRETS_FILE || "./oracle-secrets.json";
const ENCRYPTION_KEY = process.env.ORACLE_ENCRYPTION_KEY || "";

function _encrypt(secret) {
  if (!ENCRYPTION_KEY) return secret.toString("hex"); // fallback: plaintext (legacy)
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(secret);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString("hex"), data: encrypted.toString("hex"), tag: tag.toString("hex") });
}

function _decrypt(stored) {
  // Handle legacy plaintext hex string
  if (typeof stored === "string" && !stored.startsWith("{")) {
    return Buffer.from(stored, "hex");
  }
  const obj = typeof stored === "string" ? JSON.parse(stored) : stored;
  // Handle Node Buffer JSON format: { type: "Buffer", data: [11, 22, ...] }
  if (obj.type === "Buffer" && Array.isArray(obj.data)) {
    return Buffer.from(obj.data);
  }
  // Handle legacy object without encryption fields
  if (!obj.iv || !obj.tag) {
    if (typeof stored === "string") return Buffer.from(stored, "hex");
    return Buffer.from(JSON.stringify(stored), "hex");
  }
  // Encrypted format: { iv, data, tag }
  if (!ENCRYPTION_KEY) throw new Error("ORACLE_ENCRYPTION_KEY required to decrypt secrets");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.from(obj.iv, "hex"));
  decipher.setAuthTag(Buffer.from(obj.tag, "hex"));
  let decrypted = decipher.update(Buffer.from(obj.data, "hex"));
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted;
}

function loadSecrets() {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
      const out = {};
      for (const [k, v] of Object.entries(raw)) {
        try { out[k] = _decrypt(v); }
        catch(e) { console.error(`Failed to decrypt secret ${k.slice(0,8)}...: ${e.message}`); }
      }
      return out;
    }
  } catch(e) { console.error("Failed to load secrets:", e.message); }
  return {};
}

function saveSecret(commitPdaStr, secret) {
  const secrets = loadSecrets();
  // Re-load raw file to preserve encrypted format for other entries
  let rawFile = {};
  try { if (fs.existsSync(SECRETS_FILE)) rawFile = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8")); } catch(e) {}
  rawFile[commitPdaStr] = ENCRYPTION_KEY ? JSON.parse(_encrypt(secret)) : secret.toString("hex");
  try { fs.writeFileSync(SECRETS_FILE, JSON.stringify(rawFile, null, 2), { mode: 0o600 }); }
  catch(e) { console.error("Failed to save secret:", e.message); }
  secrets[commitPdaStr] = secret;
}

// Oracle wallet — must match machine.oracle on-chain
// Supports: ORACLE_WALLET_KEY env var (JSON array string) or ORACLE_WALLET file path
let oracleKeypair;
if (process.env.ORACLE_WALLET_KEY) {
  oracleKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.ORACLE_WALLET_KEY))
  );
} else {
  const walletPath = process.env.ORACLE_WALLET || (require("os").homedir() + "/.config/solana/id.json");
  oracleKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
}
console.log(`Oracle wallet: ${oracleKeypair.publicKey.toBase58()}`);

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

// Compute commitment = sha256(secret || oracle_pubkey)
function computeCommitment(secret) {
  return crypto.createHash("sha256")
    .update(Buffer.concat([secret, oracleKeypair.publicKey.toBytes()]))
    .digest();
}

// Derive OracleCommit PDA
function getCommitPda(oraclePubkey, slot) {
  const slotBytes = Buffer.alloc(8);
  slotBytes.writeBigUInt64LE(BigInt(slot));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("commit"), oraclePubkey.toBytes(), slotBytes],
    PROGRAM_ID
  );
  return pda;
}

// Derive MintRequest PDA
function getMintRequestPda(minter, commitPda) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_request"), minter.toBytes(), commitPda.toBytes()],
    PROGRAM_ID
  );
  return pda;
}

// ── STEP 1: SUBMIT COMMITMENT ─────────────────────────────────────────────────

async function submitCommitment(connection, secret) {
  const commitment = computeCommitment(secret);

  // Get current slot for PDA seed
  const slot = await connection.getSlot();
  const commitPda = getCommitPda(oracleKeypair.publicKey, slot);

  const slotBytes = Buffer.alloc(8);
  slotBytes.writeBigUInt64LE(BigInt(slot));

  // Data: discriminator (8) + commitment (32) + slot (8)
  const data = Buffer.concat([disc("submit_commitment"), commitment, slotBytes]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracleKeypair.publicKey, isSigner: true,  isWritable: true  }, // oracle
      { pubkey: MACHINE_PDA,             isSigner: false, isWritable: false }, // machine
      { pubkey: commitPda,               isSigner: false, isWritable: true  }, // oracle_commit
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = oracleKeypair.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [oracleKeypair]);
  console.log(`\n✅ Commitment submitted!`);
  console.log(`   PDA:    ${commitPda.toBase58()}`);
  console.log(`   Slot:   ${slot}`);
  console.log(`   TX:     ${sig}`);

  // Persist secret so restarts can still reveal this commitment
  saveSecret(commitPda.toBase58(), secret);

  return { commitPda, slot, secret, commitment };
}

// ── STEP 2: FIND PENDING MINT REQUESTS ───────────────────────────────────────

// MintRequest layout:
// 8  disc
// 32 minter
// 32 machine
// 32 commitment (OracleCommit pubkey)
// 1  quantity
// 8  paid_amount
// 8  requested_at
// 1  fulfilled
// 1  bump

function parseMintRequest(data) {
  if (data.length < 156) return null; // 8+32+32+32+1+1+8+8+1+1+32 = 156
  const dv = new DataView(data.buffer, data.byteOffset);
  return {
    minter:             new PublicKey(data.slice(8, 40)),
    machine:            new PublicKey(data.slice(40, 72)),
    commitment:         new PublicKey(data.slice(72, 104)),
    quantity:           data[104],
    remaining_quantity: data[105],
    paidAmount:         Number(dv.getBigUint64(106, true)),
    requestedAt:        Number(dv.getBigInt64(114, true)),
    fulfilled:          data[122] === 1,
    bump:               data[123],
    userSeed:           data.slice(124, 156),
  };
}

async function findPendingRequests(connection, commitPda) {
  // MintRequest size is 156 bytes: 8+32+32+32+1+1+8+8+1+1+32
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: 156 }, // FIXED: was 157, actual size is 156
      { memcmp: { offset: 72, bytes: commitPda.toBase58() } },
    ],
  });

  const now = Math.floor(Date.now() / 1000);
  return accounts
    .map(({ pubkey, account }) => ({
      pubkey,
      request: parseMintRequest(account.data),
    }))
    .filter(({ request }) =>
      request !== null &&
      !request.fulfilled &&
      request.remaining_quantity > 0 &&
      now - request.requestedAt < MAX_AGE_S
    );
}

// Find ALL pending requests across ALL commitments (used on startup)
async function findAllPendingRequests(connection) {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 156 }],
  });

  const now = Math.floor(Date.now() / 1000);
  return accounts
    .map(({ pubkey, account }) => ({
      pubkey,
      request: parseMintRequest(account.data),
    }))
    .filter(({ request }) =>
      request !== null &&
      !request.fulfilled &&
      request.remaining_quantity > 0 &&
      now - request.requestedAt < MAX_AGE_S
    );
}

// ── STEP 3: REVEAL AND MINT ───────────────────────────────────────────────────

async function revealAndMint(connection, mintRequestPubkey, request, commitPda, commitSlot, secret) {
  console.log(`\nRevealing for request ${mintRequestPubkey.toBase58().slice(0, 8)}...`);
  console.log(`  Minter:   ${request.minter.toBase58().slice(0, 8)}`);
  console.log(`  Quantity: ${request.quantity}`);

  // Generate a new NFT mint keypair
  const nftMint = Keypair.generate();

  const [machineAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("machine_authority")], PROGRAM_ID
  );

  const [gumballData] = PublicKey.findProgramAddressSync(
    [Buffer.from("gumball"), nftMint.publicKey.toBytes()], PROGRAM_ID
  );

  const [gumballSvg] = PublicKey.findProgramAddressSync(
    [Buffer.from("svg"), nftMint.publicKey.toBytes()], PROGRAM_ID
  );

  const minterAta = getAta(nftMint.publicKey, request.minter);

  const machineInfo    = await connection.getAccountInfo(MACHINE_PDA);
  const treasuryPubkey = new PublicKey(machineInfo.data.slice(8 + 32, 8 + 32 + 32));

  // Data: discriminator (8) + secret (32)
  const data = Buffer.concat([disc("reveal_and_mint"), Buffer.from(secret)]);

  const slotBytes = Buffer.alloc(8);
  slotBytes.writeBigUInt64LE(BigInt(commitSlot));

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracleKeypair.publicKey,    isSigner: true,  isWritable: true  }, // oracle
      { pubkey: MACHINE_PDA,                isSigner: false, isWritable: true  }, // machine
      { pubkey: machineAuthority,           isSigner: false, isWritable: false }, // machine_authority
      { pubkey: treasuryPubkey,             isSigner: false, isWritable: true  }, // treasury
      { pubkey: request.minter,             isSigner: false, isWritable: true  }, // minter
      { pubkey: mintRequestPubkey,          isSigner: false, isWritable: true  }, // mint_request
      { pubkey: commitPda,                  isSigner: false, isWritable: true  }, // oracle_commit
      { pubkey: nftMint.publicKey,          isSigner: true,  isWritable: true  }, // nft_mint
      { pubkey: minterAta,                  isSigner: false, isWritable: true  }, // minter_ata
      { pubkey: gumballData,                isSigner: false, isWritable: true  }, // gumball_data
      { pubkey: gumballSvg,                 isSigner: false, isWritable: true  }, // gumball_svg
      { pubkey: SLOT_HASHES,                isSigner: false, isWritable: false }, // slot_hashes
      { pubkey: TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT,                isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = oracleKeypair.publicKey;

  const sig = await sendAndConfirmTransaction(
    connection, tx, [oracleKeypair, nftMint]
  );

  console.log(`  ✅ Revealed and minted!`);
  console.log(`  Mint:    ${nftMint.publicKey.toBase58()}`);
  console.log(`  Gumball: ${gumballData.toBase58()}`);
  console.log(`  Svg PDA: ${gumballSvg.toBase58()}`);
  console.log(`  TX:      ${sig}`);
  return sig;
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC, "confirmed");

  console.log("\n🎰 Gumball Commit-Reveal Oracle");
  console.log("─".repeat(50));
  console.log(`Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`Machine:  ${MACHINE_PDA.toBase58()}`);
  console.log(`RPC:      ${RPC}`);
  console.log("─".repeat(50));

  // Load persisted secrets from previous sessions
  const knownSecrets = loadSecrets(); // { commitPdaStr → Buffer }
  console.log(`\nLoaded ${Object.keys(knownSecrets).length} persisted commitment secret(s).`);

  // Track active commitment and fulfilled requests this session
  let activeCommit = null;
  const fulfilled  = new Set();

  // On startup: check for any pending requests from previous oracle sessions
  console.log("Scanning for any pending requests from previous sessions...");
  try {
    const oldPending = await findAllPendingRequests(connection);
    if (oldPending.length > 0) {
      console.log(`Found ${oldPending.length} pending request(s) from previous sessions!`);
      for (const { pubkey, request } of oldPending) {
        const commitStr = request.commitment.toBase58();
        const secret = knownSecrets[commitStr];
        if (!secret) {
          console.log(`  ⚠️  No secret for commitment ${commitStr.slice(0,8)}... — cannot fulfill (timed out)`);
          continue;
        }
        // Reconstruct the commit slot from the PDA (derive it from on-chain account)
        const commitInfo = await connection.getAccountInfo(request.commitment);
        if (!commitInfo) { console.log(`  ⚠️  Commit PDA not found on-chain`); continue; }
        const dv = new DataView(commitInfo.data.buffer, commitInfo.data.byteOffset);
        const commitSlot = Number(dv.getBigUint64(8 + 32 + 32, true)); // submitted_slot field

        console.log(`  ▶ Fulfilling old request ${pubkey.toBase58().slice(0,8)}...`);
        try {
          let currentRequest = request;
          let mintCount = 0;
          while (!currentRequest.fulfilled && currentRequest.remaining_quantity > 0) {
            await revealAndMint(connection, pubkey, currentRequest, request.commitment, commitSlot, secret);
            mintCount++;
            await new Promise(r => setTimeout(r, 1000));
            const updated = await connection.getAccountInfo(pubkey);
            if (!updated) break;
            const parsed = parseMintRequest(updated.data);
            if (!parsed || parsed.fulfilled || parsed.remaining_quantity === 0) break;
            currentRequest = parsed;
          }
          console.log(`  ✅ Fulfilled old request — ${mintCount} NFT(s) minted`);
          fulfilled.add(pubkey.toBase58());
        } catch(e) {
          console.error(`  ❌ Failed to fulfill old request: ${e.message}`);
        }
      }
    } else {
      console.log("No pending requests from previous sessions.");
    }
  } catch(e) {
    console.error(`Startup scan failed: ${e.message}`);
  }

  while (true) {
    try {
      // Step 1: Submit a new commitment if we don't have one
      if (!activeCommit) {
        console.log("\nGenerating new secret and submitting commitment...");
        const secret = crypto.randomBytes(32);
        try {
          activeCommit = await submitCommitment(connection, secret);
          // Also add to in-memory secrets map
          knownSecrets[activeCommit.commitPda.toBase58()] = secret;
          console.log("Watching for mint requests...");
        } catch(e) {
          console.error(`Failed to submit commitment: ${e.message}`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
      }

      // Step 2: Look for pending mint requests across ALL known commitments
      // Users may submit requests against any unused commitment, not just the latest one
      const allPending = await findAllPendingRequests(connection);
      const pending = allPending.filter(({ request }) => {
        const commitKey = request.commitment.toBase58();
        return knownSecrets[commitKey] !== undefined;
      });

      let mintedAny = false;
      for (const { pubkey, request } of pending) {
        const key = pubkey.toBase58();
        if (fulfilled.has(key)) continue;

        const commitKey = request.commitment.toBase58();
        const secret = knownSecrets[commitKey];
        if (!secret) continue;

        // Get commit slot from on-chain data
        const commitInfo = await connection.getAccountInfo(request.commitment);
        if (!commitInfo) { console.log(`  ⚠️  Commit PDA not found: ${commitKey.slice(0,8)}`); continue; }
        const cdv = new DataView(commitInfo.data.buffer, commitInfo.data.byteOffset);
        const commitSlot = Number(cdv.getBigUint64(8 + 32 + 32, true));

        try {
          let currentRequest = request;
          let mintCount = 0;

          while (!currentRequest.fulfilled && currentRequest.remaining_quantity > 0) {
            console.log(`  Minting ${mintCount + 1}/${currentRequest.quantity}...`);
            await revealAndMint(
              connection,
              pubkey,
              currentRequest,
              request.commitment,
              commitSlot,
              secret,
            );
            mintCount++;

            await new Promise(r => setTimeout(r, 1000));
            const updated = await connection.getAccountInfo(pubkey);
            if (!updated) break;
            const parsed = parseMintRequest(updated.data);
            if (!parsed || parsed.fulfilled || parsed.remaining_quantity === 0) break;
            currentRequest = parsed;
          }

          console.log(`  ✅ All ${mintCount} NFT(s) minted for ${key.slice(0,8)}`);
          fulfilled.add(key);
          mintedAny = true;

          // Generate new commitment for next user
          console.log("\nGenerating new commitment for next mint...");
          const newSecret = crypto.randomBytes(32);
          try {
            activeCommit = await submitCommitment(connection, newSecret);
            knownSecrets[activeCommit.commitPda.toBase58()] = newSecret;
          } catch(e) {
            console.error(`Failed to submit next commitment: ${e.message}`);
            activeCommit = null;
          }
        } catch(e) {
          console.error(`Failed to reveal for ${key.slice(0, 8)}: ${e.message}`);
        }
      }

      if (!mintedAny) {
        process.stdout.write(".");
      }

    } catch(e) {
      console.error(`\nPolling error: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(console.error);