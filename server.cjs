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
const faucetCooldowns = new Map(); // wallet -> timestamp

// Clean up expired cooldowns every hour
setInterval(() => {
  const now = Date.now();
  for (const [wallet, ts] of faucetCooldowns) {
    if (now - ts > FAUCET_COOLDOWN) faucetCooldowns.delete(wallet);
  }
}, 60 * 60 * 1000);

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

app.post("/api/faucet", async (req, res) => {
  try {
    if (!faucetKeypair) return res.status(503).json({ error: "Faucet wallet not configured" });

    const { wallet } = req.body;
    if (!wallet || typeof wallet !== "string") return res.status(400).json({ error: "Missing wallet address" });

    // Validate pubkey
    let recipient;
    try {
      recipient = new PublicKey(wallet);
      if (!PublicKey.isOnCurve(recipient)) throw new Error();
    } catch {
      return res.status(400).json({ error: "Invalid wallet address" });
    }

    // Check cooldown
    const lastRequest = faucetCooldowns.get(wallet);
    if (lastRequest) {
      const remaining = FAUCET_COOLDOWN - (Date.now() - lastRequest);
      if (remaining > 0) {
        const hours = Math.ceil(remaining / (60 * 60 * 1000));
        return res.status(429).json({ error: `Cooldown active. Try again in ~${hours}h.` });
      }
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

    console.log(`Faucet: sent 0.1 XNT to ${wallet.slice(0,8)}... tx=${sig.slice(0,16)}...`);
    res.json({ success: true, signature: sig, amount: "0.1 XNT" });

  } catch(e) {
    console.error("Faucet error:", e.message);
    res.status(500).json({ error: "Faucet transaction failed. Try again." });
  }
});

// ── Price History ───────────────────────────────────────────────────────────
const PRICE_FILE = path.join(__dirname, "price-history.json");
const PRICE_INTERVAL = 30_000; // Record every 30 seconds
const MAX_PRICE_POINTS = 20_160; // 7 days at 30s intervals

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const XDEX_PID = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const GUM_MINT = new PublicKey("47wsxrZymUoKp5ALEMWsWbaN2F5MFzn6kKedWEsLV82G");
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
