// Admin: configure (or end) a seasonal trait window. While active, new mints
// draw flavor/color from sub-ranges of the trait arrays — rarity untouched.
//
// Usage:
//   node scripts/set-season.cjs <flavorStart> <flavorCount> <colorStart> <colorCount> <days> <label>
//   node scripts/set-season.cjs 14 3 4 2 14 "WINTER"   # Cinnamon/RootBeer/Banana + RoseGold/Citrus for 14 days
//   node scripts/set-season.cjs end                     # end the current season immediately
//
// Trait indices (see js/gumball-common.js / lib.rs):
//   FLAVORS: 0=Cherry 1=Grape 2=Watermelon 3=Blueberry 4=Strawberry 5=Lemon
//            6=Lime 7=Orange 8=Bubblegum 9=CottonCandy 10=Peach 11=Pineapple
//            12=Raspberry 13=Mint 14=Cinnamon 15=RootBeer 16=Banana
//            17=GreenApple 18=Mango 19=Mystery
//   COLORS:  0=CherryRed 1=GrapePurple 2=MelonPink 3=BerryBlue 4=RoseGold
//            5=CitrusYellow 6=LimeGreen 7=Tangerine 8=CottonWhite
//            9=MidnightBlack 10=ShimmerSilver 11=Rainbow

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, sendAndConfirmTransaction, SystemProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROGRAM_ID = new PublicKey("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");
const RPC = process.env.RPC || "https://rpc.testnet.x1.xyz";

const walletPath = process.env.WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));

function disc(name) { return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8); }

async function main() {
  const c = new Connection(RPC, "confirmed");
  const [machinePda]   = PublicKey.findProgramAddressSync([Buffer.from("machine")], PROGRAM_ID);
  const [seasonConfig] = PublicKey.findProgramAddressSync([Buffer.from("season")], PROGRAM_ID);

  let fStart = 0, fCount = 0, cStart = 0, cCount = 0, endsAt = 0, label = "";
  if (process.argv[2] === "end") {
    console.log("Ending current season (ends_at = 0)...");
  } else {
    [fStart, fCount, cStart, cCount] = process.argv.slice(2, 6).map(Number);
    const days = Number(process.argv[6]);
    label = (process.argv[7] || "SEASON").slice(0, 12);
    if ([fStart, fCount, cStart, cCount, days].some(Number.isNaN)) {
      console.error("Usage: set-season.cjs <fStart> <fCount> <cStart> <cCount> <days> <label> | end");
      process.exit(1);
    }
    endsAt = Math.floor(Date.now() / 1000) + days * 86400;
    console.log(`Season "${label}": flavors [${fStart}..${fStart + fCount}) colors [${cStart}..${cStart + cCount}) until ${new Date(endsAt * 1000).toISOString()}`);
  }

  // args: flavor_start u8, flavor_count u8, color_start u8, color_count u8, ends_at i64, label [u8;12]
  const data = Buffer.alloc(8 + 4 + 8 + 12);
  disc("set_season").copy(data, 0);
  data.writeUInt8(fStart, 8);
  data.writeUInt8(fCount, 9);
  data.writeUInt8(cStart, 10);
  data.writeUInt8(cCount, 11);
  data.writeBigInt64LE(BigInt(endsAt), 12);
  Buffer.from(label.padEnd(12, "\0")).copy(data, 20);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey,        isSigner: true,  isWritable: true  }, // authority
      { pubkey: machinePda,              isSigner: false, isWritable: false }, // machine
      { pubkey: seasonConfig,            isSigner: false, isWritable: true  }, // season_config
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [wallet]);
  console.log("✅ Season updated:", sig);
}

main().catch((e) => { console.error(e); process.exit(1); });
