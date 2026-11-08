// Writes <outDir>/oracle.json (a fresh THROWAWAY keypair) and <outDir>/machine.json (a copy of
// the machine fixture whose `oracle` field is that keypair). The shared fixtures are not touched.
// The live oracle key is never available to CI, so the fair-seed test signs reveals with this one.
// Usage: node scripts/make-fairseed-fixtures.cjs <fixturesDir> <outDir>
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@solana/web3.js");

const [fixturesDir, outDir] = process.argv.slice(2);
if (!fixturesDir || !outDir) { console.error("usage: make-fairseed-fixtures.cjs <fixturesDir> <outDir>"); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
const kp = Keypair.generate();
fs.writeFileSync(path.join(outDir, "oracle.json"), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });

const machine = JSON.parse(fs.readFileSync(path.join(fixturesDir, "machine.json"), "utf-8"));
const data = Buffer.from(machine.account.data[0], "base64");
kp.publicKey.toBuffer().copy(data, 8 + 32 + 32); // Machine.oracle: after disc, authority, treasury
machine.account.data = [data.toString("base64"), "base64"];
fs.writeFileSync(path.join(outDir, "machine.json"), JSON.stringify(machine));
console.log(`throwaway oracle ${kp.publicKey.toBase58()} patched into ${path.join(outDir, "machine.json")}`);
