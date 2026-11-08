// Fixtures for scripts/validate-close-burned-localnet.cjs (close_burned). Run by
// scripts/ci-e2e.sh AFTER the base fixtures exist; nothing here touches the network.
//
// Writes <outDir>/cb-*.json (validator accounts, one `pubkey` each) and <outDir>/info.json
// (no `pubkey`, so ci-e2e skips it as an account). Every ball is built in the on-chain layout
// (GumballData 189 bytes, GumballSvg 8+4+1400 bytes) with the Machine from <fixturesDir>:
//   burned balls   mint supply 0, authority machine_authority, GumballData.owner zeroed
//     b1 (+1000 donated lamports), b3, b4 .... closable (b2 is the 93-byte legacy GumballData)
//   refusal cases  live ball (supply 1), supply 0 with a non-zero owner, mint authority not
//     machine_authority / none, forged GumballData (system-owned, other machine, bad
//     discriminator), forged GumballSvg (system-owned, bad discriminator)
//   live balls     7 balls owned by the wallet (rarity 2 x2 for burn_to_upgrade, rarity 0 x5 for
//     burn_multi) that the suite burns on-chain, so the closed balls come from the real burn paths
//
// Usage: node scripts/make-close-burned-fixtures.cjs <fixturesDir> <outDir>
// The wallet is WALLET, else ~/.config/solana/id.json (run with a throwaway HOME / WALLET).
const { PublicKey, Keypair } = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [fixturesDir, outDir] = process.argv.slice(2);
if (!fixturesDir || !outDir) { console.error("usage: make-close-burned-fixtures.cjs <fixturesDir> <outDir>"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PID = new PublicKey("11111111111111111111111111111111");
const GD_SIZE = 189, GD_LEGACY_SIZE = 93, SVG_SIZE = 8 + 4 + 1400;

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"))));
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
const ata = (mint, owner) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PID.toBuffer(), mint.toBuffer()], ASSOC_PID)[0];
const accDisc = (name) => crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const rent = (size) => (128 + size) * 6960; // default rent: 3480 lamports/byte-year x 2 years

const machineJson = JSON.parse(fs.readFileSync(path.join(fixturesDir, "machine.json"), "utf-8"));
const treasury = new PublicKey(Buffer.from(machineJson.account.data[0], "base64").subarray(40, 72));
const [machine] = pda([Buffer.from("machine")]);
const [machineAuth] = pda([Buffer.from("machine_authority")]);

function save(name, pubkey, owner, data, lamports) {
  fs.writeFileSync(path.join(outDir, name + ".json"), JSON.stringify({
    pubkey: pubkey.toBase58(),
    account: { lamports, data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0 },
  }));
}
function mintData(supply, authority) {
  const d = Buffer.alloc(82);
  if (authority) { d.writeUInt32LE(1, 0); authority.toBuffer().copy(d, 4); } // COption<Pubkey>
  d.writeBigUInt64LE(BigInt(supply), 36);
  d.writeUInt8(0, 44);  // decimals
  d.writeUInt8(1, 45);  // is_initialized
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
function gdData({ owner, machineKey = machine, serial, rarity, bump, size = GD_SIZE, disc = accDisc("GumballData") }) {
  const d = Buffer.alloc(size);
  disc.copy(d, 0);
  if (owner) owner.toBuffer().copy(d, 8);
  machineKey.toBuffer().copy(d, 40);
  d.writeBigUInt64LE(BigInt(serial), 72);
  d.writeUInt8(rarity, 82);
  d.writeUInt8(bump, 92);
  return d;
}
function svgData(disc = accDisc("GumballSvg")) {
  const d = Buffer.alloc(SVG_SIZE);
  disc.copy(d, 0);
  const body = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
  d.writeUInt32LE(body.length, 8);
  body.copy(d, 12);
  return d;
}

const info = { wallet: wallet.publicKey.toBase58(), treasury: treasury.toBase58(), cases: {}, rare: [], common: [] };
let serial = 9000;

// kind: how the ball looks. Returns the mint/gd/svg addresses and the lamports each holds.
function ball(name, { supply = 0, authority = machineAuth, owner = null, gdOwner = PROGRAM_ID, gdSize = GD_SIZE,
  gdMachine = machine, gdDisc, svgOwner = PROGRAM_ID, svgDisc, extra = 0, rarity = 0, held = false } = {}) {
  const mint = Keypair.generate().publicKey;
  const [gd, gdBump] = pda([Buffer.from("gumball"), mint.toBuffer()]);
  const [svg] = pda([Buffer.from("svg"), mint.toBuffer()]);
  save(`cb-${name}-mint`, mint, TOKEN_PID, mintData(supply, authority), 1461600);
  const gdLamports = rent(gdSize) + extra, svgLamports = rent(SVG_SIZE);
  save(`cb-${name}-gd`, gd, gdOwner, gdData({ owner, machineKey: gdMachine, serial: serial++, rarity, bump: gdBump, size: gdSize, disc: gdDisc }), gdLamports);
  save(`cb-${name}-svg`, svg, svgOwner, svgData(svgDisc), svgLamports);
  if (held) save(`cb-${name}-ata`, ata(mint, wallet.publicKey), TOKEN_PID, tokenData(mint, wallet.publicKey, 1), 2039280);
  const c = { mint: mint.toBase58(), gd: gd.toBase58(), svg: svg.toBase58(), gdLamports, svgLamports, rarity };
  if (held) c.ata = ata(mint, wallet.publicKey).toBase58();
  info.cases[name] = c;
  return c;
}

// closable burned balls
ball("b1", { extra: 1000 });                 // happy path; donated lamports must move too
ball("b2", { gdSize: GD_LEGACY_SIZE });      // legacy GumballData layout
ball("b3");                                  // closed by a caller that is not the burner
ball("b4");                                  // closed in a multi-ball batch with b5
ball("b5");
// refusals
ball("live", { supply: 1, owner: wallet.publicKey, held: true }); // not burned: supply 1, owner set
ball("stale", { supply: 0, owner: wallet.publicKey });            // token gone, owner field still set
ball("foreign", { authority: Keypair.generate().publicKey });      // authority is some other key
ball("noauth", { authority: null });                               // authority revoked
ball("fgd_sys", { gdOwner: SYSTEM_PID });                          // GumballData not program-owned
ball("fgd_machine", { gdMachine: Keypair.generate().publicKey });  // GumballData names another machine
ball("fgd_disc", { gdDisc: accDisc("GumballSvg") });               // wrong discriminator
ball("fsvg_sys", { svgOwner: SYSTEM_PID });                        // GumballSvg not program-owned
ball("fsvg_disc", { svgDisc: accDisc("GumballData") });            // wrong discriminator
// live balls the suite burns through the real instructions
for (let i = 0; i < 2; i++) info.rare.push(ball(`rare${i}`, { supply: 1, owner: wallet.publicKey, rarity: 2, held: true, authority: machineAuth }));
for (let i = 0; i < 5; i++) info.common.push(ball(`common${i}`, { supply: 1, owner: wallet.publicKey, rarity: 0, held: true, authority: machineAuth }));

fs.writeFileSync(path.join(outDir, "info.json"), JSON.stringify(info, null, 1));
console.log(`close_burned fixtures in ${outDir}: ${Object.keys(info.cases).length} balls, wallet ${info.wallet}, treasury ${info.treasury}`);
