// Probes XDEX for available AMM config PDAs (indexes 0-15) and prints which exist.
//
// AMM configs are PDAs derived from `["amm_config", index_u16_be]` and own the fee
// parameters for pools using that config. Each pool references one config; the pool
// PDA is keyed on (config, mint0, mint1), so to create a second pool with the same
// mints you need a different config index.
//
// Known so far:
//   index 1 = 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY (used by current pools)

const { Connection, PublicKey } = require("@solana/web3.js");

const XDEX_PID = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  console.log("Probing AMM config indexes 0-15 on XDEX...\n");

  for (let i = 0; i < 16; i++) {
    const indexBuf = Buffer.alloc(2);
    indexBuf.writeUInt16BE(i, 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("amm_config"), indexBuf], XDEX_PID
    );
    const info = await conn.getAccountInfo(pda);
    const status = info ? "EXISTS" : "      ";
    console.log(`  index ${String(i).padStart(2)} → ${pda.toBase58()}  ${status}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
