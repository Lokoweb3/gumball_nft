const {Connection, PublicKey} = require("@solana/web3.js");

const c = new Connection("https://rpc.testnet.x1.xyz", "confirmed");
const PID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const TOKEN_PID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const wallet = new PublicKey("73js7JXRu9SzfwWdUnE45KtZ7GzkD9tcUhVXrYD6dW7x");

(async () => {
  for (const s of [97, 107]) {
    const accts = await c.getProgramAccounts(PID, { filters: [{ dataSize: s }] });
    console.log(`\n=== Size ${s}: ${accts.length} accounts ===`);
    for (const a of accts) {
      const d = a.account.data;
      const dv = new DataView(d.buffer, d.byteOffset);
      const posMint = new PublicKey(d.slice(8, 40));
      const amount = Number(dv.getBigUint64(72, true));
      const [ataPda] = PublicKey.findProgramAddressSync(
        [wallet.toBytes(), TOKEN_PID.toBytes(), posMint.toBytes()], ASSOC
      );
      const ataInfo = await c.getAccountInfo(ataPda);
      let bal = 0, owner = "N/A";
      if (ataInfo && ataInfo.data.length >= 72) {
        const dv2 = new DataView(ataInfo.data.buffer, ataInfo.data.byteOffset);
        bal = Number(dv2.getBigUint64(64, true));
        owner = new PublicKey(ataInfo.data.slice(32, 64)).toBase58().slice(0, 8);
      }
      console.log(`  Stake: ${a.pubkey.toBase58().slice(0,12)} Mint: ${posMint.toBase58().slice(0,12)} Amount: ${amount/1e9} ATA bal: ${bal} owner: ${owner}`);
    }
  }
})();
