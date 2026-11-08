// Extra validator fixtures for the staking-vulnerability tests (B1/B2/B3) in
// scripts/validate-staking-localnet.cjs. Run by scripts/ci-e2e.sh AFTER the
// base fixtures exist; nothing here touches the network.
//
//  - stake_config.json: copy of the base fixture with authority -> test wallet
//    (the cloned one belongs to the live admin key, so set_lp_mint could never
//    be called locally). Overrides the base file of the same name.
//  - B1: a victim's staked NFT "Y" (mint, StakeAccount owned by a stranger,
//    vault ATA holding 1).
//  - B2: the real LP mint "L" with a funded vault, plus an attacker position
//    whose LpStakeAccount says lp_mint = junk mint "F" (lock expired, weight 0
//    so total_lp_weight stays 0 and the earlier sweep checks are unaffected).
//  - B3: wallet token accounts for L and F so stake_lp can be attempted.
//
// Usage: FIXTURES=localnet-fixtures OUT_DIR=<dir> node scripts/make-staking-attack-fixtures.cjs
// Writes <OUT_DIR>/attack-info.json (no `pubkey` field, so ci-e2e skips it as
// an account) holding the pubkeys the test needs.
const { PublicKey, Keypair } = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const FIXTURES = process.env.FIXTURES || "localnet-fixtures";
const OUT = process.env.OUT_DIR;
if (!OUT) { console.error("OUT_DIR required"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));

function pda(seeds, pid = PROGRAM_ID) { return PublicKey.findProgramAddressSync(seeds, pid); }
function ata(mint, owner) { return pda([owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID)[0]; }
function accDisc(name) { return crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8); }
function save(name, pubkey, owner, data, lamports = 10_000_000) {
  fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify({
    pubkey: pubkey.toBase58(),
    account: { lamports, data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0 },
  }));
}
function mintData(supply, decimals) {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(BigInt(supply), 36);
  d.writeUInt8(decimals, 44);
  d.writeUInt8(1, 45);
  return d;
}
function tokenData(mint, owner, amount) {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(BigInt(amount), 64);
  d.writeUInt8(1, 108);
  return d;
}

const [stakeConfig] = pda([Buffer.from("stake_config_v2")]);

// stake_config with authority = test wallet (offset 8)
const sc = JSON.parse(fs.readFileSync(path.join(FIXTURES, "stake_config.json"), "utf-8"));
const scData = Buffer.from(sc.account.data[0], "base64");
wallet.publicKey.toBuffer().copy(scData, 8);
sc.account.data[0] = scData.toString("base64");
fs.writeFileSync(path.join(OUT, "stake_config.json"), JSON.stringify(sc));

// ── B1: victim's staked NFT ────────────────────────────────────────────────
const victim = Keypair.generate().publicKey;
const victimMint = Keypair.generate().publicKey;
save("b1_victim_mint", victimMint, TOKEN_PID, mintData(1, 0), 1461600);
save("b1_victim_vault", ata(victimMint, stakeConfig), TOKEN_PID, tokenData(victimMint, stakeConfig, 1), 2039280);
const [victimStake, victimStakeBump] = pda([Buffer.from("stake_v2"), victimMint.toBuffer()]);
const sa = Buffer.alloc(8 + 106);
accDisc("StakeAccount").copy(sa, 0);
victim.toBuffer().copy(sa, 8);
victimMint.toBuffer().copy(sa, 40);
sa.writeUInt8(0, 72);                 // rarity
sa.writeBigUInt64LE(1n, 73);          // weight
sa.writeUInt8(victimStakeBump, 8 + 105);
save("b1_victim_stake", victimStake, PROGRAM_ID, sa);

// ── B2/B3: real LP mint L, junk mint F ─────────────────────────────────────
const lpMint = Keypair.generate().publicKey;
const junkMint = Keypair.generate().publicKey;
const LP_VAULT_AMOUNT = 1_000_000_000_000n; // 1000 LP (9 dec) held by the stake vault
save("lp_real_mint", lpMint, TOKEN_PID, mintData(5_000_000_000_000n, 9), 1461600);
save("lp_junk_mint", junkMint, TOKEN_PID, mintData(5_000_000_000_000n, 9), 1461600);
save("lp_real_vault", ata(lpMint, stakeConfig), TOKEN_PID, tokenData(lpMint, stakeConfig, LP_VAULT_AMOUNT), 2039280);
save("lp_real_wallet_ata", ata(lpMint, wallet.publicKey), TOKEN_PID, tokenData(lpMint, wallet.publicKey, 100_000_000_000n), 2039280);
save("lp_junk_wallet_ata", ata(junkMint, wallet.publicKey), TOKEN_PID, tokenData(junkMint, wallet.publicKey, 100_000_000_000n), 2039280);

// Attacker position: staked JUNK mint F, held by the test wallet
const posMint = Keypair.generate().publicKey;
save("lp_pos_mint", posMint, TOKEN_PID, mintData(1, 0), 1461600);
save("lp_pos_ata", ata(posMint, wallet.publicKey), TOKEN_PID, tokenData(posMint, wallet.publicKey, 1), 2039280);
const [lpStake, lpStakeBump] = pda([Buffer.from("lp_stake_v2"), posMint.toBuffer()]);
const ls = Buffer.alloc(8 + 140);
accDisc("LpStakeAccount").copy(ls, 0);
posMint.toBuffer().copy(ls, 8);
junkMint.toBuffer().copy(ls, 40);
ls.writeBigUInt64LE(LP_VAULT_AMOUNT, 72);  // claims the whole real vault
ls.writeBigInt64LE(1n, 80);                // staked_at
ls.writeBigInt64LE(1n, 88);                // last_claimed
ls.writeBigInt64LE(1n, 96);                // lock_until (long expired)
ls.writeUInt16LE(0, 104);                  // multiplier 0 -> weight 0, total_lp_weight untouched
ls.writeUInt8(0, 106);                     // tier
ls.writeUInt8(lpStakeBump, 139);
save("lp_pos_stake", lpStake, PROGRAM_ID, ls);

fs.writeFileSync(path.join(OUT, "attack-info.json"), JSON.stringify({
  victimMint: victimMint.toBase58(),
  lpMint: lpMint.toBase58(),
  junkMint: junkMint.toBase58(),
  posMint: posMint.toBase58(),
  lpVaultAmount: LP_VAULT_AMOUNT.toString(),
}));
console.log("wrote staking attack fixtures to", OUT);
