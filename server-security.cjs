// HTTP hardening for server.cjs: security headers (helmet + CSP) and per-IP
// rate limits. Kept in its own module so it can be exercised by a bare
// express app in tests — server.cjs forks the live oracle on listen, so it
// cannot be booted just to inspect a header.
//
// CSP notes — every allowance below is something the pages actually do:
//   script-src  'self' + 'unsafe-inline': every page is a single inline
//               <script>; Turnstile injects its api.js from Cloudflare.
//   connect-src the X1 RPC over https AND wss — web3.js confirmTransaction
//               subscribes on the websocket it derives from the RPC URL.
//   img-src     data: — on-chain SVG is rendered as <img> data URIs (N2).
//   frame-src   the Turnstile challenge iframe.
//   style/font  Google Fonts (Press Start 2P) + inline styles.
// Wallet extensions (Backpack, Phantom) inject via content scripts, which
// CSP does not govern, so they are unaffected.
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const RPC_HOST = process.env.RPC_HOST || "rpc.testnet.x1.xyz";

function applySecurity(app) {
  app.disable("x-powered-by");

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"],
        styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc:        ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc:         ["'self'", "data:"],
        connectSrc:     ["'self'", `https://${RPC_HOST}`, `wss://${RPC_HOST}`,
                         "https://challenges.cloudflare.com"],
        frameSrc:       ["https://challenges.cloudflare.com"],
        objectSrc:      ["'none'"],
        baseUri:        ["'self'"],
        formAction:     ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    // Turnstile's iframe is cross-origin; COEP would block it.
    crossOriginEmbedderPolicy: false,
    // Some wallet flows open popups and rely on window.opener; keep COOP off.
    crossOriginOpenerPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }));

  const common = { standardHeaders: true, legacyHeaders: false };

  // Everything under /api/ — generous ceiling against loops and scrapers.
  app.use("/api/", rateLimit({
    ...common, windowMs: 60 * 1000, limit: 120,
    message: { error: "Too many requests — slow down." },
  }));

  // Metadata: each cache MISS is two RPC calls, so this route is the cheapest
  // way for a stranger to burn RPC quota. Tighter than the global ceiling.
  app.use("/api/metadata/", rateLimit({
    ...common, windowMs: 60 * 1000, limit: 60,
    message: { error: "Too many metadata requests." },
  }));

  // Faucet: the per-wallet cooldown and per-IP daily cap already exist inside
  // the handler; this just stops hammering the endpoint itself.
  app.use("/api/faucet", rateLimit({
    ...common, windowMs: 15 * 60 * 1000, limit: 10,
    message: { error: "Too many faucet attempts. Try again later." },
  }));
}

// Short-lived negative cache for /api/metadata. Misses (unknown mint, not a
// gumball) were never cached, so every probe cost two RPC round-trips. A
// 60-second memo bounds that without risking staleness: a mint that is not
// a gumball now will not become one, and a freshly minted one is at most a
// minute late to appear.
const NEGATIVE_TTL_MS = 60 * 1000;
const NEGATIVE_MAX = 5000;
const negative = new Map(); // key -> expiresAt

function negativeGet(key) {
  const exp = negative.get(key);
  if (exp === undefined) return false;
  if (Date.now() > exp) { negative.delete(key); return false; }
  return true;
}
function negativeSet(key) {
  if (negative.size >= NEGATIVE_MAX) negative.clear();
  negative.set(key, Date.now() + NEGATIVE_TTL_MS);
}

module.exports = { applySecurity, negativeGet, negativeSet, NEGATIVE_TTL_MS };
