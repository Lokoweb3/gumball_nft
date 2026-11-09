#!/usr/bin/env node
// Admin instructions for the deploy checklist (DEPLOY.md 0.6). Preview by default; --live sends.
//
//   node scripts/admin.cjs --cluster testnet set-active false            # pause minting
//   node scripts/admin.cjs --cluster testnet set-active true             # resume
//   node scripts/admin.cjs --cluster testnet set-lp-mint <LP_MINT>       # register the one stakeable LP mint
//   node scripts/admin.cjs --cluster mainnet init-machine <TREASURY>     # fresh deploy only; signer = upgrade authority
//   ... add --live to send
//
// --cluster testnet|mainnet is required and the RPC's genesis hash must match it.
// Signs with WALLET env var, else ~/.config/solana/id.json. Every command checks the signer
// against the on-chain authority it needs, simulates, and reads the result back after sending.
// (scripts/set-oracle.cjs rotates the oracle; scripts/refund-legacy-mints.cjs refunds old requests.)
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { fetchMintRequests } = require("./lib/mint-requests.cjs");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const CLUSTERS = {
  testnet: { rpc: "https://rpc.testnet.x1.xyz", genesis: "C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho" },
  mainnet: { rpc: "https://rpc.mainnet.x1.xyz", genesis: "4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN" },
  localnet: { rpc: "http://127.0.0.1:8899", genesis: null }, // tests only: genesis varies, RPC must be loopback
};
const USAGE = "usage: node scripts/admin.cjs --cluster testnet|mainnet|localnet <set-active true|false | set-lp-mint <MINT> | init-machine <TREASURY>> [--live]";

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const ci = argv.indexOf("--cluster");
const clusterName = ci >= 0 ? argv[ci + 1] : undefined;
const pos = argv.filter((a, i) => !a.startsWith("--") && !(ci >= 0 && i === ci + 1));
const [cmd, arg] = pos;

function fail(msg) { console.error(msg); process.exit(1); }
if (!CLUSTERS[clusterName] || !cmd) fail(USAGE);

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), PROGRAM_ID)[0];
const pubkeyArg = (s, what) => { try { return new PublicKey(s || ""); } catch { fail(`${what}: not a public key\n${USAGE}`); } };

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
const machine = pda("machine");
const stakeConfig = pda("stake_config_v2");
const lpMintConfig = pda("lp_mint_config");

async function build(conn) {
  if (cmd === "set-active") {
    if (arg !== "true" && arg !== "false") fail(USAGE);
    const info = await conn.getAccountInfo(machine);
    if (!info) fail("machine not found");
    const authority = new PublicKey(info.data.subarray(8, 40));
    if (!authority.equals(signer.publicKey)) fail(`signer ${signer.publicKey.toBase58()} is not machine.authority ${authority.toBase58()}`);
    if (arg === "true") {
      const pending = (await fetchMintRequests(conn, PROGRAM_ID)).filter((r) => !r.fulfilled && r.len === 156);
      if (pending.length) fail(`refusing to resume: ${pending.length} legacy 156-byte request(s) unrefunded — run scripts/refund-legacy-mints.cjs first`);
    }
    return {
      what: `set_active(${arg}) on machine ${machine.toBase58()}`,
      ix: new TransactionInstruction({ programId: PROGRAM_ID, keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: machine, isSigner: false, isWritable: true },
      ], data: Buffer.concat([disc("set_active"), Buffer.from([arg === "true" ? 1 : 0])]) }),
      // Machine: authority@8 treasury@40 oracle@72 mint_price@104 total_minted@112 max_supply@120 is_active@128
      check: async () => (await conn.getAccountInfo(machine)).data[128] === (arg === "true" ? 1 : 0),
    };
  }
  if (cmd === "set-lp-mint") {
    const lpMint = pubkeyArg(arg, "LP mint");
    const sc = await conn.getAccountInfo(stakeConfig);
    if (!sc) fail("stake_config_v2 not found");
    const authority = new PublicKey(sc.data.subarray(8, 40)); // StakeConfig: authority is the first field
    if (!authority.equals(signer.publicKey)) fail(`signer is not stake_config.authority ${authority.toBase58()}`);
    const mintInfo = await conn.getAccountInfo(lpMint);
    // stake_lp uses classic SPL Token: require a Tokenkeg-owned account of exactly mint size
    if (!mintInfo || !mintInfo.owner.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) || mintInfo.data.length !== 82)
      fail(`${lpMint.toBase58()} is not a classic SPL token mint on this cluster`);
    const cur = await conn.getAccountInfo(lpMintConfig);
    console.log(`lp_mint_config ${lpMintConfig.toBase58()}: ${cur ? "currently " + new PublicKey(cur.data.subarray(8, 40)).toBase58() : "not created yet"}`);
    return {
      what: `set_lp_mint(${lpMint.toBase58()})`,
      ix: new TransactionInstruction({ programId: PROGRAM_ID, keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: stakeConfig, isSigner: false, isWritable: false },
        { pubkey: lpMintConfig, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.concat([disc("set_lp_mint"), lpMint.toBuffer()]) }),
      check: async () => new PublicKey((await conn.getAccountInfo(lpMintConfig)).data.subarray(8, 40)).equals(lpMint),
    };
  }
  if (cmd === "init-machine") {
    const treasury = pubkeyArg(arg, "treasury");
    if (await conn.getAccountInfo(machine)) fail(`machine ${machine.toBase58()} already exists; nothing to do`);
    const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE)[0];
    const pdInfo = await conn.getAccountInfo(programData);
    if (!pdInfo) fail("program data account not found — is the program deployed upgradeable?");
    // ProgramData: u32 tag(3) | u64 slot | u8 option | [32] authority
    const upgradeAuth = pdInfo.data[12] === 1 ? new PublicKey(pdInfo.data.subarray(13, 45)) : null;
    if (!upgradeAuth || !upgradeAuth.equals(signer.publicKey)) fail(`signer is not the upgrade authority (${upgradeAuth ? upgradeAuth.toBase58() : "none"})`);
    const price = Buffer.alloc(8); price.writeBigUInt64LE(30_000_000n); // stored but unused: pricing is get_mint_price()
    return {
      what: `initialize_machine(treasury ${treasury.toBase58()})`,
      ix: new TransactionInstruction({ programId: PROGRAM_ID, keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: machine, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: programData, isSigner: false, isWritable: false },
      ], data: Buffer.concat([disc("initialize_machine"), price, treasury.toBuffer()]) }),
      check: async () => new PublicKey((await conn.getAccountInfo(machine)).data.subarray(8, 40)).equals(signer.publicKey),
    };
  }
  fail(USAGE);
}

(async () => {
  const rpc = process.env.RPC || CLUSTERS[clusterName].rpc;
  if (clusterName === "localnet") {
    let host; try { host = new URL(rpc).hostname; } catch { host = ""; }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) fail("localnet requires a loopback RPC");
  }
  const conn = new Connection(rpc, "confirmed");
  const genesis = await conn.getGenesisHash();
  const known = Object.entries(CLUSTERS).find(([, c]) => c.genesis === genesis);
  if (clusterName === "localnet" ? known : genesis !== CLUSTERS[clusterName].genesis) fail(`refusing: genesis ${genesis} is not ${clusterName}; nothing sent`);
  console.log(`cluster ${clusterName} (genesis ok), signer ${signer.publicKey.toBase58()}`);
  const { what, ix, check } = await build(conn);
  const tx = new Transaction().add(ix);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx, [signer]);
  if (sim.value.err) fail(`${what}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-5).join("\n")}`);
  console.log(`${what}: simulation passed`);
  if (!live) { console.log("preview: nothing sent (add --live to send)"); return; }
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer]);
  console.log(`sent: ${sig}`);
  if (check && !(await check())) fail("WARNING: read-back does not match");
  if (check) console.log("read-back ok");
})().catch((e) => fail(e.message || String(e)));
