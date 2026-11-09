// gumball-svg.js — draws a gumball from its on-chain traits.
//
// Byte-identical port of generate_svg in programs/gumball_nft/src/svg.rs. The
// program no longer stores any artwork: the picture is a pure function of
// (serial, flavor, color, rarity, special) from GumballData. This one file is
// used by the browser (<script src="js/gumball-svg.js">, global GumballSvg)
// and by server.cjs (require("./public/js/gumball-svg.js")).
//
// tests: scripts/test-svg-identity.cjs compares this against the Rust renderer.
// Do NOT change a byte here without changing svg.rs the same way (and the other
// way round): the Rust golden hashes and that test will fail if they drift.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GumballSvg = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Mirrors constants.rs
  const FLAVORS = ["Cherry","Grape","Watermelon","Blueberry","Strawberry","Lemon","Lime","Orange","Bubblegum","Cotton Candy","Peach","Pineapple","Raspberry","Mint","Cinnamon","Root Beer","Banana","Green Apple","Mango","Mystery"];
  const RARITY_NAMES = ["Common","Uncommon","Rare","Epic","Legendary"];
  const BALL_HI = ["#ff6688","#c077ff","#ffbbdd","#66aaff","#ffc4b0","#fff099","#88ff88","#ffbb77","#ffffff","#4455aa","#eeeeff","#ff88ff"];
  const BALL_SH = ["#8a0020","#4a1a6b","#cc3377","#0033aa","#9a4433","#b8960a","#228822","#cc5500","#aaaaaa","#000011","#777788","#8800aa"];
  const BALL_GL = ["#ff2244","#aa55ff","#ff44aa","#4488ff","#ffaa88","#ffdd44","#66ee66","#ffaa44","#cccccc","#3344aa","#ccccdd","#ff44ff"];
  const RARITY_RC = ["#aaaacc","#44ff88","#44aaff","#cc88ff","#ffcc00"];
  const RARITY_BG = ["#0a0a14","#0a140a","#0a0a1e","#140a1e","#141000"];
  const MAX_SVG_LEN = 1400;

  const SPECIAL_EL = {
    4: '<circle cx="125" cy="115" r="2" fill="#fff" opacity=".9"/><circle cx="170" cy="130" r="1.5" fill="#fff" opacity=".8"/><circle cx="140" cy="160" r="2" fill="#fff" opacity=".7"/><circle cx="165" cy="110" r="1.5" fill="#fff" opacity=".85"/>', // Glitter
    5: '<circle cx="205" cy="90" r="45" fill="url(#b)" opacity=".5"/><ellipse cx="192" cy="78" rx="12" ry="8" fill="#fff" opacity=".3"/>', // Double Bubble
    6: '<circle cx="150" cy="145" r="85" fill="none" stroke="url(#hl)" stroke-width="4" opacity=".4"/>', // Holographic
    7: '<polygon points="150,60 195,115 185,170 150,190 115,170 105,115" fill="none" stroke="#fff" stroke-width="1" opacity=".25"/>', // Crystal
  };
  const HOLO_GRAD = '<linearGradient id="hl"><stop offset="0%" stop-color="#f4a"/><stop offset="50%" stop-color="#4af"/><stop offset="100%" stop-color="#4fa"/></linearGradient>';
  const LEGEND_EL = '<circle cx="150" cy="145" r="115" fill="none" stroke="#fc0" stroke-width="1" stroke-dasharray="5 3" opacity=".5"/>';

  // Trait bytes are u8 on chain; wrap exactly like the Rust `as usize % N`.
  const u8 = (v) => Number(v) & 0xff;

  // serial may be a Number or BigInt (u64 on chain). `{serial:04}`: zero-pad to 4, never truncate.
  function generateSvg(serial, flavor, color, rarity, special) {
    const ci = u8(color) % 12, ri = u8(rarity) % 5, si = u8(special) % 8, fi = u8(flavor) % 20;
    const hi = BALL_HI[ci], sh = BALL_SH[ci], gl = BALL_GL[ci];
    const rc = RARITY_RC[ri], bg = RARITY_BG[ri];
    const fl = FLAVORS[fi], rn = RARITY_NAMES[ri];
    const specialEl = SPECIAL_EL[si] || "";
    const holoGrad = si === 6 ? HOLO_GRAD : "";
    const legendEl = ri === 4 ? LEGEND_EL : "";
    const sn = String(BigInt(serial)).padStart(4, "0");

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">';
    svg += `<defs><radialGradient id="b" cx="35%" cy="30%" r="65%"><stop offset="0%" stop-color="${hi}"/><stop offset="70%" stop-color="${gl}"/><stop offset="100%" stop-color="${sh}"/></radialGradient>${holoGrad}</defs>`;
    svg += `<rect width="300" height="300" fill="${bg}"/>`;
    svg += legendEl;
    svg += `<circle cx="150" cy="145" r="106" fill="${gl}" opacity=".08"/>`;
    svg += '<ellipse cx="150" cy="250" rx="55" ry="7" fill="#000" opacity=".3"/>';
    svg += '<circle cx="150" cy="145" r="100" fill="url(#b)"/>';
    svg += specialEl;
    svg += '<ellipse cx="120" cy="110" rx="28" ry="18" fill="#fff" opacity=".4" transform="rotate(-30,120,110)"/>';
    svg += `<circle cx="150" cy="145" r="100" fill="none" stroke="${rc}" stroke-width="2" opacity=".4"/>`;
    svg += '<rect x="0" y="250" width="300" height="50" fill="#000" opacity=".6"/>';
    svg += `<text x="150" y="270" text-anchor="middle" font-family="monospace" font-size="13" font-weight="bold" fill="#fff">${fl}</text>`;
    svg += `<text x="150" y="288" text-anchor="middle" font-family="monospace" font-size="9" fill="${rc}">${rn} #${sn}</text>`;
    svg += "</svg>";
    // Rust truncates at MAX_SVG_LEN bytes; everything emitted is ASCII.
    return svg.length > MAX_SVG_LEN ? svg.slice(0, MAX_SVG_LEN) : svg;
  }

  // GumballData accounts (v5 and the shorter legacy layouts) -> traits.
  // Offsets: disc(8) owner(32) machine(32) serial(u64) flavor color rarity special.
  function traitsFromGumballData(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      serial: dv.getBigUint64(72, true),
      flavor: data[80], color: data[81], rarity: data[82], special: data[83],
    };
  }

  function svgFromGumballData(data) {
    const t = traitsFromGumballData(data);
    return generateSvg(t.serial, t.flavor, t.color, t.rarity, t.special);
  }

  return { generateSvg, traitsFromGumballData, svgFromGumballData };
});
