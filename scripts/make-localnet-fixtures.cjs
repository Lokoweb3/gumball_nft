// Builds solana-test-validator account fixtures for local validation
// (companion to scripts/validate-staking-localnet.cjs):
//  - clones live X1 testnet state (machine, stake_config, vaults, pools, fee states, GUM mint)
//  - patches machine.authority/treasury to local test wallets
//  - zeroes stake_config total weights (no StakeAccounts exist on localnet)
//  - fabricates a gumball NFT (mint + GumballData PDA + user ATA) owned by the test wallet
//
// Usage:
//   OUT_DIR=/tmp/fixtures node scripts/make-localnet-fixtures.cjs
//   solana-test-validator --reset --bpf-program <PROGRAM_ID> target/deploy/gumball_nft.so \
//     --account <pubkey> <fixture.json> ...        # one pair per fixture file
//   RPC=http://127.0.0.1:8899 NFT_MINT=$(cat <out>/nft-mint-pubkey.txt) TREASURY=<pubkey> \
//     node scripts/validate-staking-localnet.cjs
//
// Note (Windows): solana-test-validator fails unpacking its genesis archive on
// Windows — run the validator inside WSL against these same fixture files.
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = process.env.OUT_DIR || path.join(__dirname, "..", "localnet-fixtures");
fs.mkdirSync(OUT, { recursive: true });

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const GUM_MINT   = new PublicKey("2KjdBhiWdCFoFcNNUbpSWqb67tGWnQpPjcMEYnescyy1");
const RPC = "https://rpc.testnet.x1.xyz";

const testWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));
const treasuryKp = Keypair.generate();
fs.writeFileSync(path.join(OUT, "treasury-keypair.json"), JSON.stringify(Array.from(treasuryKp.secretKey)));

function pda(seeds, pid = PROGRAM_ID) { return PublicKey.findProgramAddressSync(seeds, pid); }
function accountJson(pubkey, { lamports, data, owner, executable = false }) {
  return {
    pubkey: pubkey.toBase58(),
    account: {
      lamports,
      data: [data.toString("base64"), "base64"],
      owner: owner.toBase58(),
      executable,
      rentEpoch: 0,
    },
  };
}
function save(name, obj) {
  fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify(obj, null, 1));
  console.log("wrote", name, "->", obj.pubkey);
}

async function main() {
  const c = new Connection(RPC, "confirmed");

  const [machinePda]   = pda([Buffer.from("machine")]);
  const [stakeConfig]  = pda([Buffer.from("stake_config_v2")]);
  const [nftVault]     = pda([Buffer.from("nft_reward_vault")]);
  const [lpVault]      = pda([Buffer.from("lp_reward_vault")]);
  const [nftPool]      = pda([Buffer.from("nft_xnt_pool")]);
  const [lpPool]       = pda([Buffer.from("lp_xnt_pool")]);
  const [nftState]     = pda([Buffer.from("xnt_fee_state_nft")]);
  const [lpState]      = pda([Buffer.from("xnt_fee_state_lp")]);

  const clones = [
    ["machine", machinePda], ["stake_config", stakeConfig],
    ["nft_reward_vault", nftVault], ["lp_reward_vault", lpVault],
    ["nft_xnt_pool", nftPool], ["lp_xnt_pool", lpPool],
    ["nft_xnt_state", nftState], ["lp_xnt_state", lpState],
    ["gum_mint", GUM_MINT],
  ];

  for (const [name, pk] of clones) {
    const info = await c.getAccountInfo(pk);
    if (!info) throw new Error(`live account missing: ${name} ${pk.toBase58()}`);
    let data = Buffer.from(info.data);
    if (name === "machine") {
      // authority (8..40) -> test wallet, treasury (40..72) -> local treasury
      testWallet.publicKey.toBuffer().copy(data, 8);
      treasuryKp.publicKey.toBuffer().copy(data, 40);
    }
    if (name === "stake_config") {
      // zero total_nft_weight + total_lp_weight (u128 x2 at offset 8+32*4+8+8=152)
      data.fill(0, 152, 152 + 32);
    }
    save(name, accountJson(pk, { lamports: info.lamports, data, owner: info.owner }));
  }

  // ── Fabricated gumball NFT owned by the test wallet ───────────────────────
  const nftMintKp = Keypair.generate();
  const nftMint = nftMintKp.publicKey;
  fs.writeFileSync(path.join(OUT, "nft-mint-pubkey.txt"), nftMint.toBase58());

  // SPL mint: 82 bytes — authority COption(None), supply 1, decimals 0, initialized
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(1n, 36);   // supply
  mintData.writeUInt8(0, 44);          // decimals
  mintData.writeUInt8(1, 45);          // is_initialized
  save("nft_mint", accountJson(nftMint, { lamports: 1461600, data: mintData, owner: TOKEN_PID }));

  // User ATA: 165 bytes — mint, owner, amount 1, state=1
  const [ata] = pda([testWallet.publicKey.toBuffer(), TOKEN_PID.toBuffer(), nftMint.toBuffer()], ASSOC_PID);
  const ataData = Buffer.alloc(165);
  nftMint.toBuffer().copy(ataData, 0);
  testWallet.publicKey.toBuffer().copy(ataData, 32);
  ataData.writeBigUInt64LE(1n, 64);    // amount
  ataData.writeUInt8(1, 108);          // state = initialized
  save("user_ata", accountJson(ata, { lamports: 2039280, data: ataData, owner: TOKEN_PID }));

  // GumballData v5 PDA: 189 bytes
  const [gumballPda, gumballBump] = pda([Buffer.from("gumball"), nftMint.toBuffer()]);
  const gd = Buffer.alloc(189);
  crypto.createHash("sha256").update("account:GumballData").digest().copy(gd, 0, 0, 8);
  testWallet.publicKey.toBuffer().copy(gd, 8);       // owner
  machinePda.toBuffer().copy(gd, 40);                // machine
  gd.writeBigUInt64LE(100n, 72);                     // serial — early mint, exercises Phase 3 bonus
  gd.writeUInt8(0, 80);                              // flavor
  gd.writeUInt8(0, 81);                              // color
  gd.writeUInt8(2, 82);                              // rarity = Rare (weight 47)
  gd.writeUInt8(0, 83);                              // special
  gd.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 84); // minted_at
  gd.writeUInt8(gumballBump, 92);                    // bump
  save("gumball_data", accountJson(gumballPda, { lamports: 2205360, data: gd, owner: PROGRAM_ID }));

  console.log("\ntest wallet:", testWallet.publicKey.toBase58());
  console.log("treasury:   ", treasuryKp.publicKey.toBase58());
  console.log("nft mint:   ", nftMint.toBase58());
  console.log("gumball PDA:", gumballPda.toBase58(), "bump", gumballBump);
}

main().catch((e) => { console.error(e); process.exit(1); });
