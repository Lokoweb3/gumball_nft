const express = require("express");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");
const { Connection, Keypair, SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");

const PORT = process.env.PORT || 3000;

console.log("Starting Gumball NFT server...");
console.log("PORT:", PORT);
console.log("ORACLE_WALLET_KEY set:", !!process.env.ORACLE_WALLET_KEY);
console.log("ORACLE_ENCRYPTION_KEY set:", !!process.env.ORACLE_ENCRYPTION_KEY);
console.log("TELEGRAM_TOKEN set:", !!process.env.TELEGRAM_TOKEN);
console.log("FAUCET_WALLET configured:", !!(process.env.FAUCET_WALLET_KEY || process.env.FAUCET_WALLET));

// Write oracle wallet from env var to temp file if needed
if (process.env.ORACLE_WALLET_KEY && !process.env.ORACLE_WALLET) {
  try {
    const walletPath = path.join("/tmp", "oracle-wallet.json");
    fs.writeFileSync(walletPath, process.env.ORACLE_WALLET_KEY, { mode: 0o600 });
    process.env.ORACLE_WALLET = walletPath;
    console.log("Wrote wallet to", walletPath);
  } catch(e) {
    console.error("Failed to write wallet:", e.message);
  }
}

// Express app
const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy — needed for real client IPs

// Serve landing.html as the homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landing.html"));
});

app.use(express.static(path.join(__dirname), {
  extensions: ["html"],
}));

// ── Faucet ──────────────────────────────────────────────────────────────────
const FAUCET_AMOUNT = 0.1 * LAMPORTS_PER_SOL; // 0.10 XNT
const FAUCET_COOLDOWN = 24 * 60 * 60 * 1000;  // 24 hours
const FAUCET_IP_LIMIT = Number(process.env.FAUCET_IP_LIMIT || 3); // requests per IP per 24h (across wallets)
const faucetCooldowns = new Map(); // wallet -> timestamp
const faucetIpLog = new Map();     // ip -> [timestamps]

// Cooldowns persist to disk so a server restart doesn't reset them.
// On Railway, point FAUCET_STATE_FILE at a mounted volume to survive redeploys too.
const FAUCET_STATE_FILE = process.env.FAUCET_STATE_FILE || path.join(__dirname, "faucet-state.json");
try {
  const saved = JSON.parse(fs.readFileSync(FAUCET_STATE_FILE, "utf8"));
  for (const [w, ts] of Object.entries(saved.wallets || {})) faucetCooldowns.set(w, ts);
  for (const [ip, arr] of Object.entries(saved.ips || {})) faucetIpLog.set(ip, arr);
  console.log(`Faucet state loaded: ${faucetCooldowns.size} wallet cooldowns, ${faucetIpLog.size} IPs`);
} catch { /* first boot — no state yet */ }

let faucetSaveTimer = null;
function saveFaucetState() {
  if (faucetSaveTimer) return; // debounce bursts into one write
  faucetSaveTimer = setTimeout(() => {
    faucetSaveTimer = null;
    const state = { wallets: Object.fromEntries(faucetCooldowns), ips: Object.fromEntries(faucetIpLog) };
    fs.writeFile(FAUCET_STATE_FILE, JSON.stringify(state), (e) => {
      if (e) console.error("Faucet state save failed:", e.message);
    });
  }, 1000);
}

// Clean up expired cooldowns every hour
setInterval(() => {
  const now = Date.now();
  for (const [wallet, ts] of faucetCooldowns) {
    if (now - ts > FAUCET_COOLDOWN) faucetCooldowns.delete(wallet);
  }
  for (const [ip, arr] of faucetIpLog) {
    const fresh = arr.filter(ts => now - ts < FAUCET_COOLDOWN);
    if (fresh.length === 0) faucetIpLog.delete(ip);
    else faucetIpLog.set(ip, fresh);
  }
  saveFaucetState();
}, 60 * 60 * 1000);

// Optional Cloudflare Turnstile captcha — active only when both env vars are set.
// Create a (free) Turnstile widget at dash.cloudflare.com, then set
// TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY on the server.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || null;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || null;
const CAPTCHA_ENABLED = !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

async function verifyTurnstile(token, ip) {
  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
  });
  const result = await resp.json();
  return result.success === true;
}

let faucetKeypair = null;
try {
  // FAUCET_WALLET_KEY = JSON array of secret key bytes (env var)
  // FAUCET_WALLET = path to JSON key file
  if (process.env.FAUCET_WALLET_KEY) {
    faucetKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.FAUCET_WALLET_KEY)));
  } else if (process.env.FAUCET_WALLET) {
    faucetKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FAUCET_WALLET, "utf8"))));
  }
  if (faucetKeypair) {
    console.log("Faucet wallet loaded:", faucetKeypair.publicKey.toBase58());
  } else {
    console.warn("No faucet wallet configured. Set FAUCET_WALLET_KEY or FAUCET_WALLET env var.");
  }
} catch(e) {
  console.error("Failed to load faucet wallet:", e.message);
}

const faucetConnection = new Connection("https://rpc.testnet.x1.xyz", "confirmed");

app.use(express.json());

app.get("/api/faucet-config", (req, res) => {
  res.json({ captcha: CAPTCHA_ENABLED, siteKey: TURNSTILE_SITE_KEY });
});

app.post("/api/faucet", async (req, res) => {
  try {
    if (!faucetKeypair) return res.status(503).json({ error: "Faucet wallet not configured" });

    const { wallet, captchaToken } = req.body;
    if (!wallet || typeof wallet !== "string") return res.status(400).json({ error: "Missing wallet address" });

    // Captcha (when configured) — blocks headless wallet-cycling scripts
    if (CAPTCHA_ENABLED) {
      if (!captchaToken) return res.status(400).json({ error: "Captcha required" });
      const human = await verifyTurnstile(captchaToken, req.ip).catch(() => false);
      if (!human) return res.status(403).json({ error: "Captcha verification failed" });
    }

    // Validate pubkey
    let recipient;
    try {
      recipient = new PublicKey(wallet);
      if (!PublicKey.isOnCurve(recipient)) throw new Error();
    } catch {
      return res.status(400).json({ error: "Invalid wallet address" });
    }

    // Check wallet cooldown
    const lastRequest = faucetCooldowns.get(wallet);
    if (lastRequest) {
      const remaining = FAUCET_COOLDOWN - (Date.now() - lastRequest);
      if (remaining > 0) {
        const hours = Math.ceil(remaining / (60 * 60 * 1000));
        return res.status(429).json({ error: `Cooldown active. Try again in ~${hours}h.` });
      }
    }

    // Check per-IP limit — stops one actor cycling fresh wallets
    const ipHits = (faucetIpLog.get(req.ip) || []).filter(ts => Date.now() - ts < FAUCET_COOLDOWN);
    if (ipHits.length >= FAUCET_IP_LIMIT) {
      return res.status(429).json({ error: `IP limit reached (${FAUCET_IP_LIMIT} per 24h). Try again later.` });
    }

    // Check faucet balance
    const balance = await faucetConnection.getBalance(faucetKeypair.publicKey);
    if (balance < FAUCET_AMOUNT + 5000) {
      return res.status(503).json({ error: "Faucet is empty. Please try again later." });
    }

    // Send XNT
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: faucetKeypair.publicKey,
        toPubkey: recipient,
        lamports: FAUCET_AMOUNT,
      })
    );
    const sig = await faucetConnection.sendTransaction(tx, [faucetKeypair]);
    faucetCooldowns.set(wallet, Date.now());
    ipHits.push(Date.now());
    faucetIpLog.set(req.ip, ipHits);
    saveFaucetState();

    console.log(`Faucet: sent 0.1 XNT to ${wallet.slice(0,8)}... tx=${sig.slice(0,16)}...`);
    res.json({ success: true, signature: sig, amount: "0.1 XNT" });

  } catch(e) {
    console.error("Faucet error:", e.message);
    res.status(500).json({ error: "Faucet transaction failed. Try again." });
  }
});

// ── Event Indexer + Leaderboard API ─────────────────────────────────────────
// Polls program transactions, decodes events (mints/upgrades/sales/listings)
// into a persistent rolling log, and caches a holder leaderboard aggregated
// from GumballData accounts — so frontend pages hit one HTTP endpoint instead
// of scanning the chain client-side on every load.
const { eventsFromLogs } = require("./scripts/lib/gumball-events.cjs");
const GUMBALL_PROGRAM = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const GUMBALL_MACHINE = new PublicKey("Ge8524seSpQ2BLRiMAnk5tg7YRKCTxVscQSxBvPvoyxY");
const INDEXER_FILE = process.env.INDEXER_STATE_FILE || path.join(__dirname, "indexer-state.json");
const INDEX_POLL_MS = 20_000;
const MAX_EVENTS = 1000;

let indexer = { lastSig: null, events: [] };
try { indexer = JSON.parse(fs.readFileSync(INDEXER_FILE, "utf8")); } catch { /* first boot */ }

let indexerSaveTimer = null;
function saveIndexer() {
  if (indexerSaveTimer) return;
  indexerSaveTimer = setTimeout(() => {
    indexerSaveTimer = null;
    fs.writeFile(INDEXER_FILE, JSON.stringify(indexer), (e) => {
      if (e) console.error("Indexer save failed:", e.message);
    });
  }, 1000);
}

async function indexPoll() {
  try {
    const sigs = await faucetConnection.getSignaturesForAddress(
      GUMBALL_PROGRAM, { limit: 50, until: indexer.lastSig || undefined }, "confirmed",
    );
    if (sigs.length === 0) return;
    if (!indexer.lastSig) {
      // First run: set the high-water mark, don't backfill (RPC history is shallow)
      indexer.lastSig = sigs[0].signature;
      saveIndexer();
      return;
    }
    for (const s of sigs.reverse()) { // oldest -> newest
      if (s.err) continue;
      const tx = await faucetConnection.getTransaction(s.signature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
      });
      for (const ev of eventsFromLogs(tx?.meta?.logMessages)) {
        indexer.events.unshift({ ...ev, sig: s.signature, ts: (tx?.blockTime || 0) * 1000 });
      }
    }
    indexer.lastSig = sigs[sigs.length - 1].signature;
    if (indexer.events.length > MAX_EVENTS) indexer.events.length = MAX_EVENTS;
    saveIndexer();
  } catch (e) {
    console.error("Indexer poll error:", e.message);
  }
}
setInterval(indexPoll, INDEX_POLL_MS);
indexPoll();

app.get("/api/activity", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, MAX_EVENTS);
  const type = req.query.type; // optional: mint | upgrade | sale | list
  const events = type ? indexer.events.filter(e => e.type === type) : indexer.events;
  res.json({ events: events.slice(0, limit), lastSig: indexer.lastSig });
});

// Leaderboard cache — refreshed every 60s from on-chain state
const RARITY_SCORES = [1, 4, 10, 40, 100];
let leaderboardCache = null;

async function refreshLeaderboard() {
  try {
    const [accounts, machineInfo] = await Promise.all([
      faucetConnection.getProgramAccounts(GUMBALL_PROGRAM, { filters: [{ dataSize: 189 }] }),
      faucetConnection.getAccountInfo(GUMBALL_MACHINE),
    ]);
    const holders = new Map(); // owner -> { count, score, rarities[5] }
    const rarities = [0, 0, 0, 0, 0];
    let circulating = 0;
    for (const { account } of accounts) {
      const d = account.data;
      const owner = new PublicKey(d.subarray(8, 40)).toBase58();
      if (owner === "11111111111111111111111111111111") continue; // legacy zeroed zombie
      const rarity = d.readUInt8(82) % 5;
      circulating++;
      rarities[rarity]++;
      const h = holders.get(owner) || { owner, count: 0, score: 0, rarities: [0, 0, 0, 0, 0] };
      h.count++;
      h.score += RARITY_SCORES[rarity];
      h.rarities[rarity]++;
      holders.set(owner, h);
    }
    // Machine: disc(8) auth(32) treas(32) oracle(32) price(8) total_minted(8) max(8) active(1) bump(1) total_burned(8)
    const md = machineInfo.data;
    leaderboardCache = {
      updatedAt: Date.now(),
      totalMinted: Number(md.readBigUInt64LE(112)),
      maxSupply: Number(md.readBigUInt64LE(120)),
      totalBurned: Number(md.readBigUInt64LE(130)),
      circulating,
      rarities,
      holders: [...holders.values()].sort((a, b) => b.score - a.score).slice(0, 100),
    };
  } catch (e) {
    console.error("Leaderboard refresh failed:", e.message);
  }
}
setInterval(refreshLeaderboard, 60_000);
refreshLeaderboard();

app.get("/api/leaderboard", (req, res) => {
  if (!leaderboardCache) return res.status(503).json({ error: "warming up" });
  res.json(leaderboardCache);
});

// ── Wallet metadata (attach_metadata URIs point here) ───────────────────────
// Serves Metaplex-standard JSON for a gumball mint, with the image built from
// the ON-CHAIN GumballSvg PDA as a data URI — no off-chain artwork storage.
const NFT_FLAVORS = ["Cherry","Grape","Watermelon","Blueberry","Strawberry","Lemon","Lime","Orange","Bubblegum","Cotton Candy","Peach","Pineapple","Raspberry","Mint","Cinnamon","Root Beer","Banana","Green Apple","Mango","Mystery"];
const NFT_COLORS = ["Cherry Red","Grape Purple","Melon Pink","Berry Blue","Rose Gold","Citrus Yellow","Lime Green","Tangerine","Cotton White","Midnight Black","Shimmer Silver","Rainbow"];
const NFT_SPECIALS = ["None","None","None","None","Glitter","Double Bubble","Holographic","Crystal"];
const NFT_RARITY = ["Common","Uncommon","Rare","Epic","Legendary"];
const metadataCache = new Map(); // mint -> json (immutable on-chain data)

app.get("/api/metadata/:mint", async (req, res) => {
  try {
    const cached = metadataCache.get(req.params.mint);
    if (cached) return res.json(cached);

    let mint;
    try { mint = new PublicKey(req.params.mint); } catch { return res.status(400).json({ error: "bad mint" }); }
    const [gdPda] = PublicKey.findProgramAddressSync([Buffer.from("gumball"), mint.toBuffer()], GUMBALL_PROGRAM);
    const [svgPda] = PublicKey.findProgramAddressSync([Buffer.from("svg"), mint.toBuffer()], GUMBALL_PROGRAM);
    const [gd, svgAcc] = await Promise.all([
      faucetConnection.getAccountInfo(gdPda),
      faucetConnection.getAccountInfo(svgPda),
    ]);
    if (!gd || gd.data.length !== 189) return res.status(404).json({ error: "not a gumball" });

    const serial = Number(gd.data.readBigUInt64LE(72));
    const flavor = gd.data.readUInt8(80), color = gd.data.readUInt8(81);
    const rarity = gd.data.readUInt8(82), special = gd.data.readUInt8(83);

    let image;
    if (svgAcc) {
      const svgLen = svgAcc.data.readUInt32LE(8);
      const svg = svgAcc.data.subarray(12, 12 + svgLen);
      image = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    }

    const json = {
      name: `Gumball #${serial}`,
      symbol: "GMBL",
      description: "Fully on-chain SVG gumball with provably fair traits (commit-reveal oracle) on X1.",
      image,
      attributes: [
        { trait_type: "Flavor", value: NFT_FLAVORS[flavor % NFT_FLAVORS.length] },
        { trait_type: "Color", value: NFT_COLORS[color % NFT_COLORS.length] },
        { trait_type: "Rarity", value: NFT_RARITY[rarity % NFT_RARITY.length] },
        { trait_type: "Special", value: NFT_SPECIALS[special % NFT_SPECIALS.length] },
        { trait_type: "Serial", value: serial },
      ],
      external_url: "https://gumballnft-production.up.railway.app",
    };
    if (metadataCache.size > 20000) metadataCache.clear(); // crude cap
    metadataCache.set(req.params.mint, json);
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Price History ───────────────────────────────────────────────────────────
const PRICE_FILE = path.join(__dirname, "price-history.json");
const PRICE_INTERVAL = 30_000; // Record every 30 seconds
const MAX_PRICE_POINTS = 20_160; // 7 days at 30s intervals

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const XDEX_PID = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
// Phase 3: new GUM mint + new pool (AMM_CONFIG index 0, since the old GUM/XNT pair
// already exists at index 1 with the abandoned PDA mint).
const AMM_CONFIG = new PublicKey("77zjKzW2UTth9vMNxfHQsA7YcweTcgNgcCUMyTAXo1T9");
const GUM_MINT = new PublicKey("2KjdBhiWdCFoFcNNUbpSWqb67tGWnQpPjcMEYnescyy1");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Derive pool PDAs
const mint0 = WSOL_MINT.toBuffer().compare(GUM_MINT.toBuffer()) < 0 ? WSOL_MINT : GUM_MINT;
const mint1 = WSOL_MINT.toBuffer().compare(GUM_MINT.toBuffer()) < 0 ? GUM_MINT : WSOL_MINT;
const isGumToken0 = mint0.equals(GUM_MINT);
const [POOL_STATE] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), AMM_CONFIG.toBuffer(), mint0.toBuffer(), mint1.toBuffer()], XDEX_PID
);
const [VAULT_0] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_vault"), POOL_STATE.toBuffer(), mint0.toBuffer()], XDEX_PID
);
const [VAULT_1] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_vault"), POOL_STATE.toBuffer(), mint1.toBuffer()], XDEX_PID
);

const priceConnection = new Connection("https://rpc.testnet.x1.xyz", "confirmed");

// Load existing history
let priceHistory = [];
try {
  if (fs.existsSync(PRICE_FILE)) {
    priceHistory = JSON.parse(fs.readFileSync(PRICE_FILE, "utf8"));
    console.log(`Loaded ${priceHistory.length} price points from disk`);
  }
} catch(e) { priceHistory = []; }

async function recordPrice() {
  try {
    const [v0Info, v1Info] = await Promise.all([
      priceConnection.getAccountInfo(VAULT_0),
      priceConnection.getAccountInfo(VAULT_1),
    ]);
    if (!v0Info || !v1Info) return;

    const r0 = Number(Buffer.from(v0Info.data).readBigUInt64LE(64));
    const r1 = Number(Buffer.from(v1Info.data).readBigUInt64LE(64));

    const gumReserve = isGumToken0 ? r0 : r1;
    const xntReserve = isGumToken0 ? r1 : r0;

    if (gumReserve === 0 || xntReserve === 0) return;

    const price = (xntReserve / 1e9) / (gumReserve / 1e6);
    priceHistory.push({ t: Date.now(), p: parseFloat(price.toFixed(9)) });

    // Trim to max points
    if (priceHistory.length > MAX_PRICE_POINTS) {
      priceHistory = priceHistory.slice(-MAX_PRICE_POINTS);
    }

    // Save to disk every 5 minutes (10 recordings)
    if (priceHistory.length % 10 === 0) {
      fs.writeFileSync(PRICE_FILE, JSON.stringify(priceHistory));
    }
  } catch(e) { /* silent — pool might not exist yet */ }
}

// Start recording
setInterval(recordPrice, PRICE_INTERVAL);
setTimeout(recordPrice, 5000); // First record after 5s

app.get("/api/price-history", (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const data = since ? priceHistory.filter(p => p.t > since) : priceHistory;
  res.json(data);
});

// ── Health / Oracle / Monitor ───────────────────────────────────────────────
let oracleProcess = null;
let monitorProcess = null;

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oracle: oracleProcess ? "running" : "stopped",
    monitor: monitorProcess ? "running" : "stopped",
    uptime: process.uptime(),
  });
});

// Start server FIRST, then oracle/monitor
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);

  // Start oracle after server is up
  startOracle();
  startMonitor();
});

server.on("error", (err) => {
  console.error("Server error:", err.message);
});

function startOracle() {
  try {
    oracleProcess = fork(path.join(__dirname, "scripts/oracle.cjs"), [], {
      env: { ...process.env },
      silent: false,
    });
    oracleProcess.on("exit", (code) => {
      console.log(`Oracle exited (code ${code}), restarting in 5s...`);
      oracleProcess = null;
      setTimeout(startOracle, 5000);
    });
    oracleProcess.on("error", (err) => {
      console.error("Oracle fork error:", err.message);
    });
    console.log("Oracle started (pid:", oracleProcess.pid + ")");
  } catch(e) {
    console.error("Failed to start oracle:", e.message);
    setTimeout(startOracle, 5000);
  }
}

function startMonitor() {
  try {
    monitorProcess = fork(path.join(__dirname, "scripts/monitor.cjs"), [], {
      env: { ...process.env },
      silent: false,
    });
    monitorProcess.on("exit", (code) => {
      console.log(`Monitor exited (code ${code}), restarting in 10s...`);
      monitorProcess = null;
      setTimeout(startMonitor, 10000);
    });
    monitorProcess.on("error", (err) => {
      console.error("Monitor fork error:", err.message);
    });
    console.log("Monitor started (pid:", monitorProcess.pid + ")");
  } catch(e) {
    console.error("Failed to start monitor:", e.message);
    setTimeout(startMonitor, 10000);
  }
}

process.on("SIGTERM", () => {
  console.log("Shutting down...");
  if (oracleProcess) oracleProcess.kill();
  if (monitorProcess) monitorProcess.kill();
  server.close(() => process.exit(0));
});
