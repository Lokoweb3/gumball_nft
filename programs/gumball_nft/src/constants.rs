use crate::*;

/// Metaplex Token Metadata Program ID
pub(crate) const METAPLEX_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205,
    88, 184, 108, 115, 26, 160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70,
]); // metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s

// ─── Constants ────────────────────────────────────────────────────────────────

pub(crate) const MAX_SUPPLY:     u64   = 10_000;

pub(crate) const MAX_PER_TX:     u8    = 10;

pub(crate) const MAX_SVG_LEN:    usize = 1400;

// A request expires (and becomes refundable) after MINT_TIMEOUT seconds — M-2 fix.
// FAIRNESS: the reveal seed uses the SlotHashes entry fixed by the request
// (see lookup_fixed_slot_hash). The sysvar only keeps the newest 512 slots,
// ~190 s at X1's ~0.37 s/slot. The timeout must be comfortably shorter than that
// window, otherwise a request could outlive its slot hash and be unrevealable
// (and refundable only after the timeout). 150 s ≈ 405 slots leaves ~100 slots
// of margin for slot-time jitter. If the entry still ages out first, reveal_and_mint
// refunds the request itself.
pub(crate) const MINT_TIMEOUT:   i64   = 150;

/// Size of a MintRequest created before `request_slot` was appended (8 disc + 148).
pub(crate) const LEGACY_MINT_REQUEST_LEN: usize = 156;

/// The seed slot is the first recorded slot STRICTLY AFTER request_slot + this delay,
/// so its hash did not exist when request_mint landed (SlotHashes at slot R only
/// holds slots < R) and cannot be known to the minter or oracle at request time.
pub(crate) const REVEAL_DELAY_SLOTS: u64 = 2;

// Exponential pricing: 0.01 XNT at mint #0, 0.04 XNT at mint #10,000
// Formula: price = BASE_PRICE * 4^(total_minted / MAX_SUPPLY)
// Implemented via integer approximation using linear interpolation over
// a precomputed table of 4^(x/10) for x = 0..10
pub(crate) const BASE_PRICE: u64 = 10_000_000; // 0.01 XNT in lamports

pub(crate) const MAX_PRICE:  u64 = 40_000_000; // 0.04 XNT in lamports

pub(crate) const RARITY_LEGENDARY: u8 = 4;

pub(crate) const ROYALTY_BPS: u64 = 500; // 5% royalty to treasury on marketplace sales

// ─── Staking Constants (Pattern B: pro-rata of vault dynamic emission) ──────
// GUM is a fixed-supply 6-decimal SPL token (mint authority revoked) referenced
// by the StakeConfig.gum_mint field — no longer minted by the program.

// Rarity weights for NFT staking (Moderate APR profile).
// Each NFT's contribution to total_nft_weight = RARITY_WEIGHT[rarity].
// Targets ~50/75/125/200/300% steady-state APR at 0.3%/day vault emission
// when GUM is priced near the 1,000 XNT mainnet bootstrap point.
pub(crate) const RARITY_WEIGHT: [u64; 5] = [1, 9, 47, 156, 591];

// GUM sink: flat fee burned per cosmetic re-roll (6-decimal GUM units).
// ~1 day of Uncommon-tier staking emissions — cheap enough to use, real
// enough to matter at volume.
pub(crate) const REROLL_COST_GUM: u64 = 25_000_000; // 25 GUM

// Base URI for wallet metadata (attach_metadata) — the API serves the
// on-chain SVG as a data-URI image. Mutable metadata + PDA update authority
// mean this can be repointed if the host ever changes.
pub(crate) const METADATA_BASE_URI: &str = "https://gumballnft-production.up.railway.app/api/metadata/";

// Phase 3: early-mint stake bonus — serial #1 earns +50% stake weight,
// decaying linearly to +0% at serial 10,000. Applied only at stake-time;
// the boosted weight is cached in StakeAccount so unstake subtracts the
// exact amount that was added (no accounting drift for existing positions).
// Floor division means low-weight Commons see little/no boost — the bonus
// is meant to reward holding EARLY rare pulls, not to inflate Commons.
pub(crate) const MINT_BONUS_MAX_BPS: u64 = 5_000;  // +50% at serial 1

pub(crate) const MINT_BONUS_SUPPLY:  u64 = 10_000; // bonus reaches 0 at this serial

// Vault emission rate: 0.3% of vault balance per day, distributed pro-rata
// by weight via accumulator pattern. Computed each claim:
//   emission_per_sec = vault_balance × EMISSION_BPS_PER_DAY / 10_000 / 86_400
// Vault drains over time with ~1.9-year half-life — never empties.
pub(crate) const EMISSION_BPS_PER_DAY: u64 = 30; // 0.3%

pub(crate) const SECONDS_PER_DAY:      u64 = 86_400;

pub(crate) const BPS_DENOMINATOR:      u64 = 10_000;

// LP lock tiers — index: 0=Flexible, 1=Bronze, 2=Silver, 3=Gold, 4=Diamond.
pub(crate) const LOCK_DAYS:              [u16; 5] = [0,    30,   90,   180,  365];

pub(crate) const LOCK_MULTIPLIER_BPS:    [u16; 5] = [100,  150,  200,  300,  500]; // 1.0/1.5/2/3/5×

pub(crate) const EARLY_EXIT_PENALTY_BPS: [u16; 5] = [0,    1000, 1500, 2000, 2500]; // 0/10/15/20/25%

// Penalty split on early LP unstake: 50% burned, 50% kept in lp_reward_vault
// (effectively stays in the LP vault as deferred rewards — extends emission life).
// Note: "burn" applies to LP tokens, not GUM. The kept half stays in vault_lp_ata
// (LP token vault) but cannot be re-emitted; admin can choose to redeem-and-refund
// the GUM side later if desired. For Phase 1 we just retain the LP tokens in vault.
pub(crate) const PENALTY_BURN_BPS: u64 = 5000; // 50% of penalty is burned

// Accumulator scaling factor — preserves precision when computing
// (vault_balance / total_weight × elapsed). Each unit of weight earns
// `acc_reward_per_weight / ACC_SCALE` GUM at any point in time.
pub(crate) const ACC_SCALE: u128 = 1_000_000_000_000; // 1e12

// ─── XNT Fee Sharing (Phase 2) ──────────────────────────────────────────────
// Fees collected from on-chain activity are split into three buckets at the
// source. Each bucket is a separate program-owned PDA that holds raw lamports.
//
//                          Treasury    NFT stakers    LP stakers
//   Mint revenue            50%          40%             10%
//   Burn-to-upgrade fee     50%          40%             10%
//   Marketplace royalty     50%          25%             25%
//
// Stakers claim accrued XNT via claim_xnt_fees_{nft,lp} using a per-position
// debt accumulator (sibling pattern to the GUM accumulator) — no changes to
// the existing v2 StakeAccount / LpStakeAccount layouts.
pub(crate) const FEE_TREASURY_BPS_MINT:   u64 = 5000; // 50%

pub(crate) const FEE_NFT_BPS_MINT:        u64 = 4000; // 40%

pub(crate) const FEE_LP_BPS_MINT:         u64 = 1000; // 10%

pub(crate) const FEE_TREASURY_BPS_ROYAL:  u64 = 5000; // 50%

pub(crate) const FEE_NFT_BPS_ROYAL:       u64 = 2500; // 25%

pub(crate) const FEE_LP_BPS_ROYAL:        u64 = 2500; // 25%

// GumballData raw byte offsets for UncheckedAccount parsing in burn instructions.
// Must match GumballData struct layout: disc(8) + owner(32) + machine(32) + serial(8) + flavor(1) + color(1) + rarity(1)
pub(crate) const GD_OWNER_OFFSET:  usize = 8;

pub(crate) const GD_RARITY_OFFSET: usize = 8 + 32 + 32 + 8 + 1 + 1; // = 82

// CRIT-2 FIX: burns required per rarity level [Common, Uncommon, Rare, Epic]
pub(crate) const BURNS_REQUIRED: [u8; 4] = [5, 3, 2, 2];

pub(crate) const FLAVORS: [&str; 20] = [
    "Cherry","Grape","Watermelon","Blueberry","Strawberry",
    "Lemon","Lime","Orange","Bubblegum","Cotton Candy",
    "Peach","Pineapple","Raspberry","Mint","Cinnamon",
    "Root Beer","Banana","Green Apple","Mango","Mystery",
];

pub(crate) const COLORS: [&str; 12] = [
    "Cherry Red","Grape Purple","Melon Pink","Berry Blue",
    "Rose Gold","Citrus Yellow","Lime Green","Tangerine",
    "Cotton White","Midnight Black","Shimmer Silver","Rainbow",
];

pub(crate) const SPECIALS: [&str; 8] = [
    "None","None","None","None",
    "Glitter","Double Bubble","Holographic","Crystal",
];

pub(crate) const RARITY_NAMES: [&str; 5] = ["Common","Uncommon","Rare","Epic","Legendary"];

pub(crate) const RARITY_CUTS:  [u8; 5]   = [60, 85, 95, 99, 100];

pub(crate) const BALL_HI: [&str; 12] = [
    "#ff6688","#c077ff","#ffbbdd","#66aaff",
    "#ffc4b0","#fff099","#88ff88","#ffbb77",
    "#ffffff","#4455aa","#eeeeff","#ff88ff",
];

pub(crate) const BALL_SH: [&str; 12] = [
    "#8a0020","#4a1a6b","#cc3377","#0033aa",
    "#9a4433","#b8960a","#228822","#cc5500",
    "#aaaaaa","#000011","#777788","#8800aa",
];

pub(crate) const BALL_GL: [&str; 12] = [
    "#ff2244","#aa55ff","#ff44aa","#4488ff",
    "#ffaa88","#ffdd44","#66ee66","#ffaa44",
    "#cccccc","#3344aa","#ccccdd","#ff44ff",
];

pub(crate) const RARITY_RC: [&str; 5] = ["#aaaacc","#44ff88","#44aaff","#cc88ff","#ffcc00"];

pub(crate) const RARITY_BG: [&str; 5] = ["#0a0a14","#0a140a","#0a0a1e","#140a1e","#141000"];
