// Proves public/js/gumball-svg.js (browser + server renderer) is BYTE-IDENTICAL to the Rust
// reference renderer (programs/gumball_nft/src/svg.rs generate_svg).
//
// 1. runs the ignored Rust test `dump_svg_matrix` (writes serial/traits/len/sha256 per case)
// 2. renders every case with the JS module and compares length + sha256
// 3. checks the golden hashes in svg.rs (the bytes the old program stored on chain)
//
// Usage: node scripts/test-svg-identity.cjs   (needs cargo on PATH; ~1 min the first time)
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { generateSvg } = require("../public/js/gumball-svg.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "svg-matrix-")), "matrix.txt");
const root = path.join(__dirname, "..");
console.log("running the Rust reference renderer...");
execFileSync("cargo", ["test", "--lib", "--", "--ignored", "dump_svg_matrix", "--test-threads=1"], {
  cwd: path.join(root, "programs/gumball_nft"),
  env: { ...process.env, SVG_MATRIX_OUT: out },
  stdio: ["ignore", "ignore", "inherit"],
});

const lines = fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
let bad = 0, firstBad = null;
for (const line of lines) {
  const [serial, f, c, r, sp, len, hex] = line.split(" ");
  const svg = generateSvg(BigInt(serial), +f, +c, +r, +sp);
  const buf = Buffer.from(svg, "utf8");
  if (buf.length !== svg.length) { bad++; firstBad ||= `non-ASCII output for ${line}`; continue; }
  if (buf.length !== +len || crypto.createHash("sha256").update(buf).digest("hex") !== hex) {
    bad++; firstBad ||= `mismatch for ${line}`;
  }
}
check(`JS renderer == Rust renderer on ${lines.length} (serial, flavor, color, rarity, special) cases`, lines.length > 70000 && bad === 0, bad ? `${bad} differ; first: ${firstBad}` : "");
check("Number and BigInt serials render the same", generateSvg(42, 3, 5, 2, 4) === generateSvg(42n, 3, 5, 2, 4));

// The golden table in svg.rs pins the exact bytes the OLD program wrote on chain for these
// traits (base58 sha256). The repo holds no real on-chain GumballSvg dumps, so this is the link
// to what live legacy accounts contain: JS must reproduce every golden entry too.
const bs58 = require("bs58");
const src = fs.readFileSync(path.join(root, "programs/gumball_nft/src/svg.rs"), "utf8");
const golden = [...src.matchAll(/\(([\d_]+), (\d+), (\d+), (\d+), (\d+), (\d+), "([1-9A-HJ-NP-Za-km-z]+)"\)/g)];
let goldenBad = 0;
for (const m of golden) {
  const [, serial, f, c, r, sp, len, b58] = m;
  const buf = Buffer.from(generateSvg(BigInt(serial.replace(/_/g, "")), +f, +c, +r, +sp), "utf8");
  if (buf.length !== +len || bs58.encode(crypto.createHash("sha256").update(buf).digest()) !== b58) goldenBad++;
}
check(`JS renderer reproduces all ${golden.length} golden hashes of the on-chain artwork (svg.rs)`, golden.length >= 15 && goldenBad === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
