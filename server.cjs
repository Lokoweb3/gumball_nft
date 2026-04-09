const express = require("express");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");

const PORT = process.env.PORT || 3000;

console.log("Starting Gumball NFT server...");
console.log("PORT:", PORT);
console.log("ORACLE_WALLET_KEY set:", !!process.env.ORACLE_WALLET_KEY);
console.log("ORACLE_ENCRYPTION_KEY set:", !!process.env.ORACLE_ENCRYPTION_KEY);
console.log("TELEGRAM_TOKEN set:", !!process.env.TELEGRAM_TOKEN);

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

app.use(express.static(path.join(__dirname), {
  extensions: ["html"],
}));

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
