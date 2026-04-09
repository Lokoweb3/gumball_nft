
const { Connection, PublicKey } = require('@solana/web3.js');
const PROGRAM_ID = new PublicKey('Bsbc5gd22aRWHgHGJXwNugHHHDAR6Q2Hmoj1xB88QmKK');
const WALLET     = new PublicKey('73js7JXRu9SzfwWdUnE45KtZ7GzkD9tcUhVXrYD6dW7x');
const RPC        = 'https://rpc.testnet.x1.xyz';
const FLAVORS  = ['Cherry','Grape','Watermelon','Blueberry','Strawberry','Lemon','Lime','Orange','Bubblegum','Cotton Candy','Peach','Pineapple','Raspberry','Mint','Cinnamon','Root Beer','Banana','Green Apple','Mango','Mystery'];
const COLORS   = ['Cherry Red','Grape Purple','Melon Pink','Berry Blue','Rose Gold','Citrus Yellow','Lime Green','Tangerine','Cotton White','Midnight Black','Shimmer Silver','Rainbow'];
const SPECIALS = ['None','None','None','None','Glitter','Double Bubble','Holographic','Crystal'];
const RARITY   = ['Common','Uncommon','Rare','Epic','Legendary'];
async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const accounts = await connection.getProgramAccounts(new PublicKey('Bsbc5gd22aRWHgHGJXwNugHHHDAR6Q2Hmoj1xB88QmKK'), {
    filters: [
      { dataSize: 8+32+32+8+1+1+1+1+8+1 },
      { memcmp: { offset: 8, bytes: WALLET.toBase58() } },
    ],
  });
  console.log('Found ' + accounts.length + ' gumballs');
  console.log('-'.repeat(60));
  const parsed = accounts.map(({pubkey, account}) => {
    const d = account.data;
    const dv = new DataView(d.buffer, d.byteOffset);
    return {
      serial:  Number(dv.getBigUint64(8+32+32, true)),
      flavor:  FLAVORS[d[8+32+32+8]] || '?',
      color:   COLORS[d[8+32+32+8+1]] || '?',
      rarity:  RARITY[d[8+32+32+8+2]] || '?',
      special: SPECIALS[d[8+32+32+8+3]] || '?',
    };
  }).sort((a,b) => a.serial - b.serial);
  parsed.forEach(g => {
    console.log('#' + String(g.serial).padStart(4,'0') + ' | ' + g.rarity.padEnd(10) + ' | ' + g.flavor.padEnd(14) + ' | ' + g.color.padEnd(15) + ' | ' + g.special);
  });
}
main().catch(console.error);
