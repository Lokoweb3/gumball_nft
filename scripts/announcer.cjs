// Public announcement bot — posts mints, upgrades, and sales to a PUBLIC
// Telegram channel (separate from the private ops monitor).
//
// Polls the program's transaction signatures, decodes Anchor events from
// "Program data:" logs, and announces:
//   🎉 GumballMintedEvent    — every mint (rarity-flavored message)
//   ⬆️ GumballUpgradedEvent  — burn-to-upgrade results
//   💰 GumballSoldEvent      — marketplace sales (listing buys + accepted offers)
//
// Setup:
//   1. Create a public channel, add your bot (same TELEGRAM_TOKEN) as admin
//   2. Set TELEGRAM_ANNOUNCE_CHAT to the channel handle (@gumballs_x1) or -100... id
//   3. pm2 start ecosystem.config.cjs  (runs as gumball-announcer)
//
// State (last processed signature) persists to announcer-state.json so
// restarts don't re-announce or skip events.

const { Connection, PublicKey } = require("@solana/web3.js");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";
const EXPLORER = "https://explorer.testnet.x1.xyz";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANNOUNCE_CHAT = process.env.TELEGRAM_ANNOUNCE_CHAT;
const POLL_MS = Number(process.env.ANNOUNCE_POLL_MS || 30_000);
const STATE_FILE = process.env.ANNOUNCER_STATE_FILE || path.join(__dirname, "..", "announcer-state.json");

if (!TELEGRAM_TOKEN || !ANNOUNCE_CHAT) {
  console.log("Announcer disabled: set TELEGRAM_TOKEN and TELEGRAM_ANNOUNCE_CHAT to enable.");
  process.exit(0);
}

const RARITY = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
const RARITY_EMOJI = ["⚪", "🟢", "🔵", "🟣", "🟡"];
const FLAVORS = ["Cherry","Grape","Watermelon","Blueberry","Sour Apple","Bubblegum","Orange Cream","Lemon Drop","Cotton Candy","Root Beer","Strawberry","Mint","Peach","Black Licorice","Mango","Raspberry","Pineapple","Coconut","Cinnamon","Mystery"];

const connection = new Connection(RPC, "confirmed");

// Anchor event discriminator: sha256("event:<Name>")[0..8]
function eventDisc(name) {
  return crypto.createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}
const DISC_MINTED   = eventDisc("GumballMintedEvent");
const DISC_UPGRADED = eventDisc("GumballUpgradedEvent");
const DISC_SOLD     = eventDisc("GumballSoldEvent");

function short(pk) { return pk.slice(0, 4) + ".." + pk.slice(-4); }
function xnt(lamports) { return (Number(lamports) / 1e9).toFixed(lamports < 1_000_000_000n ? 4 : 2); }

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: ANNOUNCE_CHAT,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  const req = https.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, (res) => {
    let data = "";
    res.on("data", d => data += d);
    res.on("end", () => {
      if (res.statusCode !== 200) console.error(`Telegram error ${res.statusCode}: ${data}`);
    });
  });
  req.on("error", e => console.error("Telegram request failed:", e.message));
  req.write(body);
  req.end();
}

// ── Event decoding (borsh layouts match the #[event] structs in lib.rs) ─────
function decodeMinted(d) {
  // minter(32) serial(u64) mint(32) flavor(u8) color(u8) rarity(u8) special(u8) total_minted(u64)
  return {
    minter: new PublicKey(d.subarray(0, 32)).toBase58(),
    serial: d.readBigUInt64LE(32),
    mint: new PublicKey(d.subarray(40, 72)).toBase58(),
    flavor: d.readUInt8(72),
    rarity: d.readUInt8(74),
    totalMinted: d.readBigUInt64LE(76),
  };
}
function decodeUpgraded(d) {
  // burner(32) burned_rarity(u8) burned_count(u8) new_serial(u64) new_rarity(u8) new_mint(32) flavor color special
  return {
    burner: new PublicKey(d.subarray(0, 32)).toBase58(),
    burnedRarity: d.readUInt8(32),
    burnedCount: d.readUInt8(33),
    newSerial: d.readBigUInt64LE(34),
    newRarity: d.readUInt8(42),
  };
}
function decodeSold(d) {
  // seller(32) buyer(32) nft_mint(32) price(u64) royalty(u64)
  return {
    seller: new PublicKey(d.subarray(0, 32)).toBase58(),
    buyer: new PublicKey(d.subarray(32, 64)).toBase58(),
    price: d.readBigUInt64LE(96),
  };
}

function formatEvent(disc, data, sig) {
  const link = `<a href="${EXPLORER}/tx/${sig}">tx</a>`;
  if (disc.equals(DISC_MINTED)) {
    const e = decodeMinted(data);
    const r = e.rarity % 5;
    const hype = r >= 4 ? "🚨 LEGENDARY PULL! 🚨\n" : r === 3 ? "🔥 Epic pull!\n" : "";
    return `${hype}🎉 Gumball <b>#${e.serial}</b> minted — ${RARITY_EMOJI[r]} <b>${RARITY[r]}</b> ${FLAVORS[e.flavor % FLAVORS.length]}\nby ${short(e.minter)} · ${e.totalMinted}/10000 minted · ${link}`;
  }
  if (disc.equals(DISC_UPGRADED)) {
    const e = decodeUpgraded(data);
    return `⬆️ ${short(e.burner)} burned ${e.burnedCount}× ${RARITY[e.burnedRarity % 5]} → ${RARITY_EMOJI[e.newRarity % 5]} <b>${RARITY[e.newRarity % 5]} #${e.newSerial}</b> · ${link}`;
  }
  if (disc.equals(DISC_SOLD)) {
    const e = decodeSold(data);
    return `💰 Gumball sold for <b>${xnt(e.price)} XNT</b>\n${short(e.seller)} → ${short(e.buyer)} · ${link}`;
  }
  return null;
}

// ── Polling loop ─────────────────────────────────────────────────────────────
let lastSig = null;
try { lastSig = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).lastSig || null; } catch {}

function saveState() {
  fs.writeFile(STATE_FILE, JSON.stringify({ lastSig }), () => {});
}

async function poll() {
  try {
    // Newest-first; `until` stops at the last signature we processed
    const sigs = await connection.getSignaturesForAddress(
      PROGRAM_ID,
      { limit: 50, until: lastSig || undefined },
      "confirmed",
    );
    if (sigs.length === 0) return;

    // First run: don't spam history — just set the high-water mark
    if (!lastSig) {
      lastSig = sigs[0].signature;
      saveState();
      console.log("Initialized at", lastSig.slice(0, 16));
      return;
    }

    // Process oldest -> newest so announcements are in order
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      const tx = await connection.getTransaction(s.signature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages || [];
      for (const log of logs) {
        if (!log.startsWith("Program data: ")) continue;
        const raw = Buffer.from(log.slice("Program data: ".length), "base64");
        if (raw.length < 8) continue;
        const msg = formatEvent(raw.subarray(0, 8), raw.subarray(8), s.signature);
        if (msg) {
          console.log("Announcing:", msg.split("\n")[0]);
          sendTelegram(msg);
        }
      }
    }
    lastSig = sigs[sigs.length - 1].signature;
    saveState();
  } catch (e) {
    console.error("Poll error:", e.message);
  }
}

console.log(`Announcer running — channel ${ANNOUNCE_CHAT}, polling every ${POLL_MS / 1000}s`);
poll();
setInterval(poll, POLL_MS);
