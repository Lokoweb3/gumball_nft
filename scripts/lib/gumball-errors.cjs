// Anchor custom error codes are 6000 + the variant's index in GumballError.
// Read the index from lib.rs so adding or moving a variant can't leave a test
// asserting a stale number.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "programs", "gumball_nft", "src", "lib.rs");

function errorNames() {
  const src = fs.readFileSync(SRC, "utf8");
  const body = src.slice(src.indexOf("pub enum GumballError"));
  const inner = body.slice(body.indexOf("{") + 1, body.indexOf("\n}"));
  return [...inner.matchAll(/(?:^|[\s\]])([A-Z][A-Za-z0-9]*)\s*,/g)].map((m) => m[1]);
}

// Numeric code (e.g. 6016) for a GumballError variant name.
function errCode(name) {
  const idx = errorNames().indexOf(name);
  if (idx < 0) throw new Error(`${name} not found in GumballError`);
  return 6000 + idx;
}

// "0x…" form as it appears in "custom program error: 0x…".
const errHex = (name) => "0x" + errCode(name).toString(16);

module.exports = { errorNames, errCode, errHex };
