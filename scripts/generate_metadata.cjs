const fs = require("fs");
const path = require("path");

const FLAVORS = ["Cherry","Grape","Watermelon","Blueberry","Strawberry",
  "Lemon","Lime","Orange","Bubblegum","Cotton Candy","Peach","Pineapple",
  "Raspberry","Mint","Cinnamon","Root Beer","Banana","Green Apple","Mango","Mystery"];
const COLORS = ["Cherry Red","Grape Purple","Melon Pink","Berry Blue","Rose Gold",
  "Citrus Yellow","Lime Green","Tangerine","Cotton White","Midnight Black",
  "Shimmer Silver","Rainbow"];
const SPECIALS = ["None","None","None","None","Glitter","Double Bubble","Holographic","Crystal"];
const RARITY = ["Common","Uncommon","Rare","Epic","Legendary"];
const RARITY_CUTS = [60,85,95,99,100];

function lcg(seed) {
  const s = (BigInt(seed) * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
  return Number(s >> 33n) >>> 0;
}

function resolveTraits(serial) {
  const seed = serial;
  const flavor  = lcg(seed * 1 + 1) % FLAVORS.length;
  const color   = lcg(seed * 2 + 1) % COLORS.length;
  const special = lcg(seed * 3 + 1) % SPECIALS.length;
  const roll    = lcg(seed * 4 + 1) % 100;
  const rarity  = RARITY_CUTS.findIndex(c => roll < c);
  return { flavor, color, special, rarity: rarity === -1 ? 4 : rarity };
}

const outDir = path.join(__dirname, "../metadata");
fs.mkdirSync(outDir, { recursive: true });

const BASE_IMAGE = "https://img.gumball.x1.xyz";
const count = 10000;

for (let i = 1; i <= count; i++) {
  const t = resolveTraits(i);
  const meta = {
    name: `Gumball #${i}`,
    symbol: "GBALL",
    description: "A one-of-a-kind XNT gumball from the Gumball Machine on X1.",
    image: `${BASE_IMAGE}/${i}.png`,
    attributes: [
      { trait_type: "Flavor",  value: FLAVORS[t.flavor]   },
      { trait_type: "Color",   value: COLORS[t.color]     },
      { trait_type: "Special", value: SPECIALS[t.special] },
      { trait_type: "Rarity",  value: RARITY[t.rarity]    },
      { trait_type: "Serial",  value: i                   },
    ],
    properties: {
      files: [{ uri: `${BASE_IMAGE}/${i}.png`, type: "image/png" }],
      category: "image",
    },
  };
  const json = JSON.stringify(meta, null, 2);
  fs.writeFileSync(path.join(outDir, `${i}.json`), json);
  if (i % 1000 === 0) console.log(`Generated ${i}/${count}...`);
}
console.log(`Done! ${count} files in ./metadata/`);
