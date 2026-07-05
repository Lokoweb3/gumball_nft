// Shared Anchor-event decoding for gumball_nft — used by scripts/announcer.cjs
// (Telegram bot) and server.cjs (/api/activity indexer).
//
// Anchor `emit!` writes events as "Program data: <base64>" log lines:
//   [8-byte discriminator = sha256("event:<Name>")[0..8]] [borsh fields]
// Field layouts mirror the #[event] structs in programs/gumball_nft/src/lib.rs.

const { PublicKey } = require("@solana/web3.js");
const crypto = require("crypto");

function eventDisc(name) {
  return crypto.createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

const DISC_MINTED   = eventDisc("GumballMintedEvent");
const DISC_UPGRADED = eventDisc("GumballUpgradedEvent");
const DISC_SOLD     = eventDisc("GumballSoldEvent");
const DISC_LISTED   = eventDisc("GumballListedEvent");

// Decode one "Program data:" payload (Buffer incl. discriminator).
// Returns { type, ...fields } or null for event types we don't track.
function decodeEvent(raw) {
  if (raw.length < 8) return null;
  const disc = raw.subarray(0, 8);
  const d = raw.subarray(8);
  try {
    if (disc.equals(DISC_MINTED)) {
      // minter(32) serial(u64) mint(32) flavor(u8) color(u8) rarity(u8) special(u8) total_minted(u64)
      return {
        type: "mint",
        minter: new PublicKey(d.subarray(0, 32)).toBase58(),
        serial: Number(d.readBigUInt64LE(32)),
        mint: new PublicKey(d.subarray(40, 72)).toBase58(),
        flavor: d.readUInt8(72),
        color: d.readUInt8(73),
        rarity: d.readUInt8(74),
        special: d.readUInt8(75),
        totalMinted: Number(d.readBigUInt64LE(76)),
      };
    }
    if (disc.equals(DISC_UPGRADED)) {
      // burner(32) burned_rarity(u8) burned_count(u8) new_serial(u64) new_rarity(u8) new_mint(32) flavor color special
      return {
        type: "upgrade",
        burner: new PublicKey(d.subarray(0, 32)).toBase58(),
        burnedRarity: d.readUInt8(32),
        burnedCount: d.readUInt8(33),
        newSerial: Number(d.readBigUInt64LE(34)),
        newRarity: d.readUInt8(42),
        newMint: new PublicKey(d.subarray(43, 75)).toBase58(),
      };
    }
    if (disc.equals(DISC_SOLD)) {
      // seller(32) buyer(32) nft_mint(32) price(u64) royalty(u64)
      return {
        type: "sale",
        seller: new PublicKey(d.subarray(0, 32)).toBase58(),
        buyer: new PublicKey(d.subarray(32, 64)).toBase58(),
        mint: new PublicKey(d.subarray(64, 96)).toBase58(),
        price: Number(d.readBigUInt64LE(96)),
        royalty: Number(d.readBigUInt64LE(104)),
      };
    }
    if (disc.equals(DISC_LISTED)) {
      // seller(32) nft_mint(32) price(u64)
      return {
        type: "list",
        seller: new PublicKey(d.subarray(0, 32)).toBase58(),
        mint: new PublicKey(d.subarray(32, 64)).toBase58(),
        price: Number(d.readBigUInt64LE(64)),
      };
    }
  } catch { /* truncated/foreign payload — ignore */ }
  return null;
}

// Extract all tracked events from a transaction's log messages.
function eventsFromLogs(logMessages) {
  const out = [];
  for (const log of logMessages || []) {
    if (!log.startsWith("Program data: ")) continue;
    const ev = decodeEvent(Buffer.from(log.slice("Program data: ".length), "base64"));
    if (ev) out.push(ev);
  }
  return out;
}

module.exports = { eventDisc, decodeEvent, eventsFromLogs };
