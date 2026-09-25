// gumball-common.js — single source of truth for constants + helpers shared
// by the frontend pages. Load AFTER the solanaWeb3 bundle and BEFORE the
// page's own script:
//   <script src="js/gumball-common.js"></script>
//
// Everything here is top-level `const`/`function` on purpose (same scope the
// pages used before extraction) — a page must NOT re-declare any of these.
// Trait arrays mirror programs/gumball_nft/src/lib.rs — if the contract
// changes, this is now the ONLY frontend copy to update.

const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } = solanaWeb3;

const PROGRAM_ID_STR  = "AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy";
const MACHINE_PDA_STR = "Ge8524seSpQ2BLRiMAnk5tg7YRKCTxVscQSxBvPvoyxY";
const RPC = "https://rpc.testnet.x1.xyz";

const PROGRAM_ID  = new PublicKey(PROGRAM_ID_STR);
const MACHINE_PDA = new PublicKey(MACHINE_PDA_STR);
const connection  = new Connection(RPC, { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });

const TOKEN_PID       = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_PID       = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SLOT_HASHES_PID = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const RENT_SYSVAR_PID = new PublicKey("SysvarRent111111111111111111111111111111111");

// ── Trait arrays (must match lib.rs FLAVORS/COLORS/SPECIALS/RARITY_NAMES) ────
const FLAVORS = ["Cherry","Grape","Watermelon","Blueberry","Strawberry","Lemon","Lime","Orange","Bubblegum","Cotton Candy","Peach","Pineapple","Raspberry","Mint","Cinnamon","Root Beer","Banana","Green Apple","Mango","Mystery"];
const COLORS = ["Cherry Red","Grape Purple","Melon Pink","Berry Blue","Rose Gold","Citrus Yellow","Lime Green","Tangerine","Cotton White","Midnight Black","Shimmer Silver","Rainbow"];
const SPECIALS = ["None","None","None","None","Glitter","Double Bubble","Holographic","Crystal"];
const RARITY = ["Common","Uncommon","Rare","Epic","Legendary"];
const RARITY_CLASSES = ["r-common","r-uncommon","r-rare","r-epic","r-legendary"];
const BALL_COLORS = {
  "Cherry Red":"#e82040","Grape Purple":"#8b35cc","Melon Pink":"#ff7aab",
  "Berry Blue":"#2266ee","Rose Gold":"#e8927a","Citrus Yellow":"#f5c842",
  "Lime Green":"#44cc44","Tangerine":"#ff8822","Cotton White":"#eeeeee",
  "Midnight Black":"#222244","Shimmer Silver":"#ccccee","Rainbow":"#ff44aa"
};

// ── Helpers ──────────────────────────────────────────────────────────────────
// Anchor instruction discriminator: sha256("global:<name>")[0..8]
async function disc(name) {
  const enc = new TextEncoder().encode("global:" + name);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return new Uint8Array(buf).slice(0, 8);
}

function strToU8(s) { return new TextEncoder().encode(s); }

function getAta(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PID.toBytes(), mint.toBytes()], ASSOC_PID
  );
  return ata;
}

// Render an on-chain SVG as an <img> data URI instead of injecting it with
// innerHTML. Scripts and event handlers never execute inside an <img>, so a
// future contract change (or a compromised upgrade key) cannot turn the
// artwork into XSS against every visitor's wallet session. Each <img> is also
// its own document, so gradient ids can no longer collide across cards — the
// per-card id-rewriting this replaces is unnecessary.
//   clip: true hides the text bar at the bottom of the 300x300 artwork (the
//   old rewrap-with-viewBox trick), for round thumbnails.
function svgImgHtml(svgStr, size, { clip = false, style = "" } = {}) {
  let s = String(svgStr);
  if (clip) s = s.replace(/viewBox="0 0 300 300"/, 'viewBox="0 0 300 248"');
  const src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(s)));
  const dim = typeof size === "number" ? `width="${size}" height="${size}"` : `width="${size}" height="${size}"`;
  return `<img src="${src}" ${dim} alt="" draggable="false" style="display:block;${style}">`;
}
