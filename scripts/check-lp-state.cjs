const {Connection, PublicKey} = require("@solana/web3.js");
const c = new Connection("https://rpc.testnet.x1.xyz", "confirmed");
const PID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");

(async () => {
  const accts = await c.getProgramAccounts(PID, { filters: [{ dataSize: 107 }] });
  const now = Math.floor(Date.now() / 1000);
  console.log(`Now (wall clock): ${now} (${new Date(now*1000).toLocaleString()})`);
  console.log(`Found ${accts.length} v2 LP positions\n`);

  for (const a of accts) {
    const d = a.account.data;
    const dv = new DataView(d.buffer, d.byteOffset);
    const posMint = new PublicKey(d.slice(8, 40)).toBase58().slice(0, 12);
    const amount = Number(dv.getBigUint64(72, true));
    const stakedAt = Number(dv.getBigInt64(80, true));
    const lastClaimed = Number(dv.getBigInt64(88, true));
    const lockUntil = Number(dv.getBigInt64(96, true));
    const mult = dv.getUint16(104, true);

    const elapsed = now - lastClaimed;
    // Use same formula as contract: elapsed * 1157 * amount * mult / 1e11
    const reward = BigInt(elapsed) * 1157n * BigInt(amount) * BigInt(mult) / 100_000_000_000n;

    console.log(`Position: ${a.pubkey.toBase58().slice(0, 12)}`);
    console.log(`  NFT: ${posMint}`);
    console.log(`  Amount: ${amount / 1e9} LP`);
    console.log(`  Multiplier: ${mult/100}x`);
    console.log(`  Staked at:  ${stakedAt} (${new Date(stakedAt*1000).toLocaleString()})`);
    console.log(`  Last claim: ${lastClaimed} (${new Date(lastClaimed*1000).toLocaleString()})`);
    console.log(`  Lock until: ${lockUntil} (${new Date(lockUntil*1000).toLocaleString()})`);
    console.log(`  Elapsed:    ${elapsed}s (${(elapsed/3600).toFixed(2)}h)`);
    console.log(`  Expected reward: ${Number(reward) / 1e6} GUM\n`);
  }
})();
