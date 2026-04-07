const express = require("express");
const path = require("path");
const { fork } = require("child_process");

const PORT = process.env.PORT || 3000;
const app = express();

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname), {
  extensions: ["html"],
}));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oracle: oracleProcess ? "running" : "stopped",
    monitor: monitorProcess ? "running" : "stopped",
    uptime: process.uptime(),
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Frontend serving on port ${PORT}`);
});

// Start oracle as child process
let oracleProcess = null;
function startOracle() {
  oracleProcess = fork(path.join(__dirname, "scripts/oracle.cjs"), [], {
    env: { ...process.env },
  });
  oracleProcess.on("exit", (code) => {
    console.log(`Oracle exited with code ${code}, restarting in 3s...`);
    oracleProcess = null;
    setTimeout(startOracle, 3000);
  });
  console.log("Oracle started");
}

// Start monitor as child process
let monitorProcess = null;
function startMonitor() {
  monitorProcess = fork(path.join(__dirname, "scripts/monitor.cjs"), [], {
    env: { ...process.env },
  });
  monitorProcess.on("exit", (code) => {
    console.log(`Monitor exited with code ${code}, restarting in 5s...`);
    monitorProcess = null;
    setTimeout(startMonitor, 5000);
  });
  console.log("Monitor started");
}

startOracle();
startMonitor();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  if (oracleProcess) oracleProcess.kill();
  if (monitorProcess) monitorProcess.kill();
  process.exit(0);
});
