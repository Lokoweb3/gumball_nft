// gumball-rpc.js — RPC helpers shared by the frontend pages. Load AFTER
// js/gumball-common.js and BEFORE the page's own script:
//   <script src="js/gumball-rpc.js"></script>
//
// Nothing here uses getProgramAccounts for per-wallet data: a wallet's
// gumballs are found from its token accounts (the token account is the
// source of truth for who holds an NFT; GumballData.owner only changes on
// update_owner, so a plain transfer leaves it stale).

// Account sizes (8-byte discriminator + lib.rs LEN). Keep in step with lib.rs.
const GUMBALL_DATA_SIZE   = 8 + 32+32+8+1+1+1+1+8+1+32+32+32; // 8 + GumballData::LEN = 189
const ORACLE_COMMIT_SIZE  = 8 + 32+32+8+8+1+1;                // 8 + OracleCommit::LEN = 90
const ORACLE_COMMIT_USED_OFFSET = 8 + 32+32+8+8;              // `used` byte = 88

// getMultipleAccountsInfo in chunks (RPC limit is 100 keys per call).
// Returns an array aligned with `pubkeys` (null for missing accounts).
async function getMultipleAccountsChunked(pubkeys, chunkSize = 100) {
  const chunks = [];
  for (let i = 0; i < pubkeys.length; i += chunkSize) chunks.push(pubkeys.slice(i, i + chunkSize));
  const results = await Promise.all(chunks.map(c => connection.getMultipleAccountsInfo(c)));
  return results.flat();
}

// Every GumballData the wallet currently holds, found from its token accounts
// (amount == 1, decimals 0), then batch-loaded. Returns
//   [{ gumballPda, mintPubkey, ataPubkey, data }]   (data = GumballData bytes)
// Only accounts owned by the program, of the current size, and belonging to
// this machine are returned.
async function loadWalletGumballAccounts(wallet) {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PID });
  const held = [];
  for (const ta of tokenAccounts.value) {
    const info = ta.account.data.parsed && ta.account.data.parsed.info;
    if (!info || !info.tokenAmount) continue;
    if (info.tokenAmount.amount !== "1" || info.tokenAmount.decimals !== 0) continue;
    const mintPubkey = new PublicKey(info.mint);
    const [gumballPda] = PublicKey.findProgramAddressSync([strToU8("gumball"), mintPubkey.toBytes()], PROGRAM_ID);
    held.push({ gumballPda, mintPubkey, ataPubkey: ta.pubkey });
  }
  const infos = await getMultipleAccountsChunked(held.map(h => h.gumballPda));
  const machine = MACHINE_PDA.toBytes();
  const out = [];
  held.forEach((h, i) => {
    const info = infos[i];
    if (!info || !info.owner.equals(PROGRAM_ID) || info.data.length !== GUMBALL_DATA_SIZE) return;
    const d = info.data;
    for (let k = 0; k < 32; k++) if (d[8 + 32 + k] !== machine[k]) return; // other machine
    out.push({ ...h, data: d });
  });
  return out;
}

// Pick an unused OracleCommit for `oraclePubkey`. Server-side filters: exact
// size + oracle at offset 8 + used == 0 (base58 "1" is the single byte 0x00). Chooses at random so concurrent minters don't all
// collide on the newest one. `exclude` is a Set of base58 keys to skip.
async function pickUnusedCommitment(oraclePubkey, exclude = new Set()) {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: ORACLE_COMMIT_SIZE },
      { memcmp: { offset: 8, bytes: oraclePubkey.toBase58() } },
      { memcmp: { offset: ORACLE_COMMIT_USED_OFFSET, bytes: "1" } }, // base58 "1" = single 0x00 byte
    ],
    dataSlice: { offset: 0, length: 0 },
  });
  const free = accounts.filter(a => !exclude.has(a.pubkey.toBase58()));
  if (free.length === 0) throw new Error("No oracle commitment available — is oracle.cjs running?");
  return free[Math.floor(Math.random() * free.length)].pubkey;
}

// setInterval that skips ticks while the tab is hidden and, for data pollers,
// runs once as soon as the tab is visible again (catchUp, default true).
// Returns the interval handle (clearInterval works as usual).
function setVisibleInterval(fn, ms, catchUp = true) {
  let lastRun = Date.now();
  const tick = () => { lastRun = Date.now(); fn(); };
  const id = setInterval(() => { if (!document.hidden) tick(); }, ms);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && catchUp && Date.now() - lastRun >= ms) tick();
  });
  return id;
}
