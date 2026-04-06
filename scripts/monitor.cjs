const { Connection, PublicKey } = require("@solana/web3.js");
const https = require("https");
const http = require("http");

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN || "YOUR_BOT_TOKEN_HERE";
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT  || "529787973";

const PROGRAM_ID      = new PublicKey("Bsbc5gd22aRWHgHGJXwNugHHHDAR6Q2Hmoj1xB88QmKK");
const MACHINE_PDA     = new PublicKey("AV8PXFSuVuZaYSBuVf2qcqF9TKfThRJaiUg4U2MVRWcj");
const ORACLE_PUBKEY   = new PublicKey("53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy");
const RPC             = "https://rpc.testnet.x1.xyz";

const MINT_TIMEOUT    = 300; // 5 min
const CHECK_INTERVAL  = 30_000;  // check every 30 seconds
const LOW_BALANCE_XNT = 0.5;     // alert if oracle wallet below this

const MINT_REQUEST_SIZE = 8 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 32; // 156 bytes

// ─── STATE ───────────────────────────────────────────────────────────────────

let lastOracleStatus = "unknown"; // "running" | "stopped" | "unknown"
let lastBalanceAlert = 0;         // timestamp of last low balance alert
let alertedRequests  = new Set();  // mint request PDAs we already alerted on

const connection = new Connection(RPC, "confirmed");

// ─── TELEGRAM ────────────────────────────────────────────────────────────────

function sendTelegram(message) {
  const text = `🎰 GUMBALL ORACLE\n\n${message}`;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT,
    text,
    parse_mode: "HTML",
  });

  const req = https.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, (res) => {
    let data = "";
    res.on("data", d => data += d);
    res.on("end", () => {
      if (res.statusCode !== 200) {
        console.error(`Telegram error ${res.statusCode}: ${data}`);
      }
    });
  });
  req.on("error", e => console.error("Telegram request failed:", e.message));
  req.write(body);
  req.end();

  console.log(`[ALERT] ${message.replace(/<[^>]*>/g, "")}`);
}

// ─── PM2 ORACLE STATUS ──────────────────────────────────────────────────────

function checkPm2Status() {
  return new Promise((resolve) => {
    const { exec } = require("child_process");
    exec("pm2 jlist", (err, stdout) => {
      if (err) {
        resolve("unknown");
        return;
      }
      try {
        const list = JSON.parse(stdout);
        const oracle = list.find(p => p.name === "gumball-oracle");
        if (!oracle) {
          resolve("not_found");
        } else {
          resolve(oracle.pm2_env.status); // "online", "stopped", "errored"
        }
      } catch(e) {
        resolve("unknown");
      }
    });
  });
}

async function monitorOracleProcess() {
  const status = await checkPm2Status();

  if (status !== "online" && lastOracleStatus === "online") {
    sendTelegram(
      `🔴 <b>ORACLE DOWN</b>\n` +
      `Status: <code>${status}</code>\n` +
      `The oracle process has stopped. Mints will not be fulfilled.\n` +
      `Users can refund after 5 minutes.`
    );
  } else if (status === "online" && lastOracleStatus !== "online" && lastOracleStatus !== "unknown") {
    sendTelegram(
      `🟢 <b>ORACLE RECOVERED</b>\n` +
      `The oracle is back online and processing mints.`
    );
  }

  lastOracleStatus = status;
}

// ─── PENDING MINT REQUESTS ───────────────────────────────────────────────────

async function monitorPendingRequests() {
  try {
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: MINT_REQUEST_SIZE }],
    });

    const now = Math.floor(Date.now() / 1000);

    for (const { pubkey, account } of accounts) {
      const data = account.data;
      const dv = new DataView(data.buffer, data.byteOffset);

      // Parse MintRequest fields
      const fulfilled = data[8 + 32 + 32 + 32 + 1 + 1 + 8 + 8] === 1;
      if (fulfilled) continue;

      const requestedAt = Number(dv.getBigInt64(8 + 32 + 32 + 32 + 1 + 1 + 8, true));
      const elapsed = now - requestedAt;
      const remaining = MINT_TIMEOUT - elapsed;
      const pdaKey = pubkey.toBase58();

      // Alert when < 60 seconds before timeout
      if (remaining > 0 && remaining < 60 && !alertedRequests.has(pdaKey)) {
        const minter = new PublicKey(data.slice(8, 40)).toBase58();
        const quantity = data[8 + 32 + 32 + 32];
        const remainingQty = data[8 + 32 + 32 + 32 + 1];

        sendTelegram(
          `⚠️ <b>MINT REQUEST EXPIRING</b>\n` +
          `Request: <code>${pdaKey.slice(0, 8)}...</code>\n` +
          `Minter: <code>${minter.slice(0, 8)}...</code>\n` +
          `Quantity: ${remainingQty}/${quantity} remaining\n` +
          `⏱ <b>${remaining}s until refund eligible</b>\n` +
          `Oracle may be stuck or slow.`
        );
        alertedRequests.add(pdaKey);
      }

      // Clean up old alerts
      if (elapsed > MINT_TIMEOUT + 60) {
        alertedRequests.delete(pdaKey);
      }
    }
  } catch(e) {
    console.error("Error checking pending requests:", e.message);
  }
}

// ─── ORACLE WALLET BALANCE ───────────────────────────────────────────────────

async function monitorBalance() {
  try {
    const balance = await connection.getBalance(ORACLE_PUBKEY);
    const balanceXNT = balance / 1e9;
    const now = Date.now();

    // Alert max once per hour
    if (balanceXNT < LOW_BALANCE_XNT && now - lastBalanceAlert > 3600_000) {
      sendTelegram(
        `💰 <b>LOW ORACLE BALANCE</b>\n` +
        `Balance: <b>${balanceXNT.toFixed(4)} XNT</b>\n` +
        `Wallet: <code>${ORACLE_PUBKEY.toBase58().slice(0, 12)}...</code>\n` +
        `The oracle needs funds to pay rent for new mint accounts.\n` +
        `Top up to avoid failed mints.`
      );
      lastBalanceAlert = now;
    }
  } catch(e) {
    console.error("Error checking balance:", e.message);
  }
}

// ─── TELEGRAM COMMANDS ───────────────────────────────────────────────────────

let lastUpdateId = 0;
const AUTHORIZED_CHAT = TELEGRAM_CHAT;

function pm2Command(action, processName) {
  const ALLOWED_ACTIONS = ["restart", "stop", "status", "jlist"];
  if (!ALLOWED_ACTIONS.includes(action)) {
    return Promise.reject(new Error(`Invalid action: ${action}`));
  }
  return new Promise((resolve, reject) => {
    const { execFile } = require("child_process");
    execFile("pm2", [action, processName], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function handleCommand(command) {
  const cmd = command.toLowerCase().trim();

  if (cmd === "/status") {
    const status = await checkPm2Status();
    const balance = await connection.getBalance(ORACLE_PUBKEY);
    const balanceXNT = (balance / 1e9).toFixed(4);

    // Check pending requests
    let pendingCount = 0;
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: MINT_REQUEST_SIZE }],
      });
      const now = Math.floor(Date.now() / 1000);
      for (const { account } of accounts) {
        const fulfilled = account.data[8 + 32 + 32 + 32 + 1 + 1 + 8 + 8] === 1;
        if (!fulfilled) {
          const dv = new DataView(account.data.buffer, account.data.byteOffset);
          const requestedAt = Number(dv.getBigInt64(8 + 32 + 32 + 32 + 1 + 1 + 8, true));
          if (now - requestedAt < MINT_TIMEOUT) pendingCount++;
        }
      }
    } catch(e) {}

    // Machine stats
    let totalMinted = "?", totalBurned = "?";
    try {
      const machineInfo = await connection.getAccountInfo(MACHINE_PDA);
      if (machineInfo) {
        const dv = new DataView(machineInfo.data.buffer, machineInfo.data.byteOffset);
        totalMinted = Number(dv.getBigUint64(8+32+32+32+8, true));
        totalBurned = Number(dv.getBigUint64(8+32+32+32+8+8+8+1+1, true));
      }
    } catch(e) {}

    const statusEmoji = status === "online" ? "🟢" : "🔴";
    sendTelegram(
      `📊 <b>STATUS</b>\n\n` +
      `${statusEmoji} Oracle: <b>${status}</b>\n` +
      `💰 Balance: <b>${balanceXNT} XNT</b>\n` +
      `⏳ Pending requests: <b>${pendingCount}</b>\n` +
      `🎰 Total minted: <b>${totalMinted}</b>\n` +
      `🔥 Total burned: <b>${totalBurned}</b>`
    );

  } else if (cmd === "/restart") {
    sendTelegram(`🔄 Restarting oracle...`);
    try {
      await pm2Command("restart", "gumball-oracle");
      sendTelegram(`🟢 <b>ORACLE RESTARTED</b>\nProcess restarted successfully.`);
    } catch(e) {
      sendTelegram(`🔴 <b>RESTART FAILED</b>\n<code>${e.message}</code>`);
    }

  } else if (cmd === "/stop") {
    sendTelegram(`⏹ Stopping oracle...`);
    try {
      await pm2Command("stop", "gumball-oracle");
      sendTelegram(`🔴 <b>ORACLE STOPPED</b>\nProcess stopped. Mints will not be fulfilled.`);
    } catch(e) {
      sendTelegram(`🔴 <b>STOP FAILED</b>\n<code>${e.message}</code>`);
    }

  } else if (cmd === "/balance") {
    const balance = await connection.getBalance(ORACLE_PUBKEY);
    const balanceXNT = (balance / 1e9).toFixed(4);
    sendTelegram(
      `💰 <b>ORACLE BALANCE</b>\n` +
      `Balance: <b>${balanceXNT} XNT</b>\n` +
      `Wallet: <code>${ORACLE_PUBKEY.toBase58()}</code>`
    );

  } else if (cmd === "/help") {
    sendTelegram(
      `🎰 <b>COMMANDS</b>\n\n` +
      `/status — Oracle status, balance, pending requests\n` +
      `/restart — Restart the oracle process\n` +
      `/stop — Stop the oracle process\n` +
      `/balance — Check oracle wallet balance\n` +
      `/help — Show this message`
    );

  } else {
    sendTelegram(`Unknown command. Type /help for available commands.`);
  }
}

async function pollTelegramCommands() {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", async () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok || !json.result) { resolve(); return; }

          for (const update of json.result) {
            lastUpdateId = update.update_id;
            const msg = update.message;
            if (!msg || !msg.text) continue;

            // Only respond to authorized chat
            if (String(msg.chat.id) !== AUTHORIZED_CHAT) {
              console.log(`Ignoring message from unauthorized chat: ${msg.chat.id}`);
              continue;
            }

            if (msg.text.startsWith("/")) {
              console.log(`Command received: ${msg.text}`);
              await handleCommand(msg.text);
            }
          }
        } catch(e) {
          console.error("Telegram poll error:", e.message);
        }
        resolve();
      });
    }).on("error", () => resolve());
  });
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

async function runChecks() {
  await monitorOracleProcess();
  await monitorPendingRequests();
  await monitorBalance();
  await pollTelegramCommands();
}

async function main() {
  console.log("🔍 Gumball Oracle Monitor started");
  console.log(`   Chat ID:  ${TELEGRAM_CHAT}`);
  console.log(`   Interval: ${CHECK_INTERVAL / 1000}s`);
  console.log(`   Low bal:  ${LOW_BALANCE_XNT} XNT`);
  console.log(`   Commands: /status /restart /stop /balance /help`);
  console.log("");

  // Startup alert
  sendTelegram(
    `🟢 <b>MONITOR STARTED</b>\n` +
    `Oracle monitoring is now active.\n\n` +
    `Type /help for available commands.`
  );

  // Initial check
  await runChecks();

  // Loop
  setInterval(runChecks, CHECK_INTERVAL);
}

main().catch(e => {
  console.error("Monitor fatal error:", e);
  sendTelegram(`🔴 <b>MONITOR CRASHED</b>\n<code>${e.message}</code>`);
  process.exit(1);
});
