import {
  Connection, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, Keypair, sendAndConfirmTransaction
} from "@solana/web3.js";
import * as fs from "fs";
import * as borsh from "borsh";

const PROGRAM_ID = new PublicKey("mW1BJcacXszW9Fa1cnNZrHnHstvwUopgnwPoBMW81nE");
const RPC = "https://rpc.testnet.x1.xyz";

// Load wallet keypair
const walletPath = process.env.ANCHOR_WALLET || (require("os").homedir() + "/.config/solana/id.json");
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
const wallet = Keypair.fromSecretKey(secretKey);

async function main() {
  const connection = new Connection(RPC, "confirmed");

  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Balance:", await connection.getBalance(wallet.publicKey) / 1e9, "SOL");

  const [machinePda, machineBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("machine")],
    PROGRAM_ID
  );
  console.log("Machine PDA:", machinePda.toBase58());

  // Check if already initialized
  const existing = await connection.getAccountInfo(machinePda);
  if (existing) {
    console.log("Already initialized, skipping init...");
  } else {
    // initializeMachine discriminator (Anchor sha256 of "global:initialize_machine")
    const discriminator = Buffer.from([
      135, 106, 159, 181, 22, 114, 175, 51
    ]);

    // Encode args: mint_price (u64 LE) + treasury (32 bytes)
    const mintPrice = BigInt(250_000_000);
    const args = Buffer.alloc(8 + 32);
    args.writeBigUInt64LE(mintPrice, 0);
    wallet.publicKey.toBuffer().copy(args, 8);

    const data = Buffer.concat([discriminator, args]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: machinePda,       isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log("Init tx:", sig);
    console.log("Machine initialized!");
  }

  // setActive(true) discriminator
  const setActiveDisc = Buffer.from([
    221, 192, 142, 245, 73, 182, 218, 47
  ]);
  const activeArg = Buffer.from([1]); // true
  const setActiveData = Buffer.concat([setActiveDisc, activeArg]);

  const ix2 = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: machinePda,       isSigner: false, isWritable: true  },
    ],
    data: setActiveData,
  });

  const tx2 = new Transaction().add(ix2);
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [wallet]);
  console.log("Activate tx:", sig2);
  console.log("Minting is now ACTIVE! Gumball machine is live on X1 testnet.");
}

main().catch(console.error);
