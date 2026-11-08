use crate::*;

// ─── Events ───────────────────────────────────────────────────────────────────

#[event] pub struct MachineInitializedEvent { pub authority: Pubkey, pub treasury: Pubkey, pub mint_price: u64, pub max_supply: u64 }

#[event] pub struct OracleUpdatedEvent      { pub new_oracle: Pubkey }

#[event] pub struct CommitmentSubmittedEvent { pub oracle: Pubkey, pub commitment: [u8; 32] }

#[event] pub struct MintRequestedEvent      { pub minter: Pubkey, pub commitment: Pubkey, pub quantity: u8, pub paid: u64 }

#[event] pub struct MintSeedEvent           { pub mint: Pubkey, pub request_slot: u64, pub seed_slot: u64, pub slot_hash: [u8; 32], pub mint_index: u8 }

#[event] pub struct MintRefundedEvent       { pub minter: Pubkey, pub amount: u64 }

#[event] pub struct GumballMintedEvent      { pub minter: Pubkey, pub serial: u64, pub mint: Pubkey, pub flavor: u8, pub color: u8, pub rarity: u8, pub special: u8, pub total_minted: u64 }

#[event] pub struct GumballUpgradedEvent    { pub burner: Pubkey, pub burned_rarity: u8, pub burned_count: u8, pub new_serial: u64, pub new_rarity: u8, pub new_mint: Pubkey, pub flavor: u8, pub color: u8, pub special: u8 }

#[event] pub struct GumballListedEvent     { pub seller: Pubkey, pub nft_mint: Pubkey, pub price: u64 }

#[event] pub struct GumballDelistedEvent   { pub seller: Pubkey, pub nft_mint: Pubkey }

#[event] pub struct GumballSoldEvent       { pub seller: Pubkey, pub buyer: Pubkey, pub nft_mint: Pubkey, pub price: u64, pub royalty: u64 }

#[event] pub struct OfferMadeEvent         { pub buyer: Pubkey, pub nft_mint: Pubkey, pub amount: u64 }

#[event] pub struct OfferCancelledEvent    { pub buyer: Pubkey, pub nft_mint: Pubkey }

#[event] pub struct NftStakedEvent        { pub staker: Pubkey, pub nft_mint: Pubkey, pub rarity: u8 }

#[event] pub struct NftUnstakedEvent      { pub staker: Pubkey, pub nft_mint: Pubkey, pub reward: u64 }

#[event] pub struct RewardsClaimedEvent   { pub staker: Pubkey, pub nft_mint: Pubkey, pub amount: u64 }

#[event] pub struct LpStakedEvent        { pub staker: Pubkey, pub amount: u64 }

#[event] pub struct LpUnstakedEvent      { pub staker: Pubkey, pub amount: u64, pub reward: u64 }

#[event] pub struct LpRewardsClaimedEvent { pub staker: Pubkey, pub amount: u64 }

#[event] pub struct XntFeeClaimedEvent    { pub claimer: Pubkey, pub stake_type: u8, pub amount: u64 }

#[event] pub struct AuctionCreatedEvent   { pub seller: Pubkey, pub nft_mint: Pubkey, pub start_price: u64, pub ends_at: i64 }

#[event] pub struct CosmeticsRerolledEvent { pub owner: Pubkey, pub nft_mint: Pubkey, pub flavor: u8, pub color: u8, pub special: u8 }

#[event] pub struct AuctionBidEvent       { pub bidder: Pubkey, pub nft_mint: Pubkey, pub amount: u64, pub ends_at: i64 }

#[event] pub struct XntFeeDistributedEvent { pub source: u8, pub treasury: u64, pub nft_pool: u64, pub lp_pool: u64 }
