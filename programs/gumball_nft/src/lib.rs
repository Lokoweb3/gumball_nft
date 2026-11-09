use anchor_lang::prelude::*;
use anchor_lang::system_program::System;
use anchor_lang::solana_program::{clock::Clock, sysvar, hash::hashv, program::invoke};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{burn, mint_to, Burn, Mint, MintTo, Token, TokenAccount},
};

declare_id!("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");

pub mod accumulators;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod pricing;
pub mod randomness;
pub mod state;
#[cfg(test)]
pub mod svg;

pub(crate) use accumulators::*;
pub(crate) use constants::*;
pub use errors::*;
pub use events::*;
// The Accounts structs (and Anchor's generated __client_accounts_* modules) must be
// reachable at the crate root. The glob also carries the handler fns, whose names the
// #[program] macro re-exports too; nothing refers to them by root path.
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;
pub(crate) use pricing::*;
pub(crate) use randomness::*;
pub use state::*;
#[cfg(test)]
pub(crate) use svg::*;

// ─── Program ──────────────────────────────────────────────────────────────────


// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod gumball_nft {
    use super::*;

    pub fn initialize_machine(
        ctx: Context<InitializeMachine>,
        mint_price: u64,
        treasury: Pubkey,
    ) -> Result<()> {
        instructions::initialize_machine(ctx, mint_price, treasury)
    }

    // M-1 FIX: oracle pubkey is now stored in Machine and can be rotated
    pub fn set_oracle(ctx: Context<AdminOnly>, new_oracle: Pubkey) -> Result<()> {
        instructions::set_oracle(ctx, new_oracle)
    }

    pub fn set_active(ctx: Context<AdminOnly>, active: bool) -> Result<()> {
        instructions::set_active(ctx, active)
    }

    pub fn set_mint_price(ctx: Context<AdminOnly>, new_price: u64) -> Result<()> {
        instructions::set_mint_price(ctx, new_price)
    }


    // ── C-2 FIX: Step 1 — Oracle submits commitment BEFORE knowing slot ───────
    // Oracle generates: secret = random_bytes()
    // Computes: commitment = sha256(secret || oracle_pubkey)
    // Submits commitment on-chain here.
    // The oracle cannot predict the slot hash at this point.
    pub fn submit_commitment(
        ctx: Context<SubmitCommitment>,
        commitment: [u8; 32],
        slot: u64,
    ) -> Result<()> {
        instructions::submit_commitment(ctx, commitment, slot)
    }

    // ── User pays and locks in a commitment ───────────────────────────────────
    pub fn request_mint(ctx: Context<RequestMint>, quantity: u8, user_seed: [u8; 32]) -> Result<()> {
        instructions::request_mint(ctx, quantity, user_seed)
    }

    // ── C-2 FIX: Step 2 — Oracle reveals secret, contract verifies + mints ───
    // The oracle reveals the secret it committed to earlier.
    // Contract verifies sha256(secret || oracle_pubkey) == stored_commitment.
    // Seed = sha256(secret || slot_hash_bytes) — unpredictable to oracle
    // because slot_hash was unknown when commitment was made.
    pub fn reveal_and_mint(
        ctx: Context<RevealAndMint>,
        secret: [u8; 32],
    ) -> Result<()> {
        instructions::reveal_and_mint(ctx, secret)
    }

    /// Burn 2 gumballs of rarity X → receive 1 guaranteed rarity X+1
    /// C-1 FIX: gumball accounts validated by PDA seeds

    /// Allow the minter to reclaim XNT if the oracle failed to reveal within MINT_TIMEOUT.
    /// Anyone can call this after the timeout — funds always go back to the original minter.
    pub fn refund_mint(ctx: Context<RefundMint>) -> Result<()> {
        instructions::refund_mint(ctx)
    }

    /// Refund a pre-upgrade 156-byte MintRequest (before `request_slot` was appended).
    /// `Account<MintRequest>` cannot deserialize those, so reveal_and_mint and
    /// refund_mint reject them. Anyone may call this after MINT_TIMEOUT; all lamports
    /// go to the stored minter. Layout (incl. 8-byte discriminator): minter 8..40,
    /// machine 40..72, commitment 72..104, quantity 104, remaining 105, paid 106..114,
    /// requested_at 114..122, fulfilled 122, bump 123, user_seed 124..156.
    pub fn refund_legacy_mint(ctx: Context<RefundLegacyMint>) -> Result<()> {
        instructions::refund_legacy_mint(ctx)
    }

    pub fn burn_to_upgrade(ctx: Context<BurnToUpgrade>, user_seed: [u8; 32]) -> Result<()> {
        instructions::burn_to_upgrade(ctx, user_seed)
    }

    /// Burn N gumballs of rarity X → receive 1 of rarity X+1
    /// Handles Common→Uncommon (5 burns) and Uncommon→Rare (3 burns)
    /// remaining_accounts = [(mint_1, ata_1, gumball_pda_1), (mint_2, ata_2, gumball_pda_2), ...]
    /// gumball_a/mint_a/ata_a are the "base" accounts (first burn)
    pub fn burn_multi<'info>(ctx: Context<'_, '_, 'info, 'info, BurnMulti<'info>>, user_seed: [u8; 32]) -> Result<()> {
        instructions::burn_multi(ctx, user_seed)
    }

    /// Permissionless: close ONE burned ball's GumballData (+ the GumballSvg of a
    /// legacy ball, if it has one) and send all their lamports to machine.treasury
    /// (never to the caller).
    pub fn close_burned(ctx: Context<CloseBurned>) -> Result<()> {
        instructions::close_burned(ctx)
    }

    /// Migrate machine account to new struct size (adds total_burned field).
    /// Safe to call multiple times — idempotent.
    pub fn migrate_machine(ctx: Context<MigrateMachine>) -> Result<()> {
        instructions::migrate_machine(ctx)
    }

    /// Admin: configure a seasonal trait window. While `ends_at` is in the
    /// future, new mints draw flavor/color from the given sub-ranges of the
    /// trait arrays (rarity odds untouched). Set ends_at = 0 to end a season
    /// early. count = 0 leaves that trait unwindowed.
    pub fn set_season(
        ctx: Context<SetSeason>,
        flavor_start: u8, flavor_count: u8,
        color_start: u8, color_count: u8,
        ends_at: i64, label: [u8; 12],
    ) -> Result<()> {
        instructions::set_season(ctx, flavor_start, flavor_count, color_start, color_count, ends_at, label)
    }

    /// Permissionless: attach Metaplex metadata to an existing gumball NFT so
    /// wallets display it (name + image). Name derives from on-chain serial;
    /// the URI points at the metadata API, which draws the image from the
    /// ball's on-chain traits (shared renderer, public/js/gumball-svg.js).
    /// Anyone can pay to attach; Metaplex rejects the CPI if metadata exists.
    pub fn attach_metadata(ctx: Context<AttachMetadata>) -> Result<()> {
        instructions::attach_metadata(ctx)
    }

    /// Transfer machine admin rights and treasury to a new key — the mainnet
    /// path to a multisig (point both at a Squads-style multisig authority).
    /// Irreversible unless the new authority signs a transfer back.
    pub fn transfer_authority(
        ctx: Context<TransferAuthority>,
        new_authority: Pubkey,
        new_treasury: Pubkey,
    ) -> Result<()> {
        instructions::transfer_authority(ctx, new_authority, new_treasury)
    }

    // `withdraw` was removed. It CPI'd system_program::transfer with the
    // treasury as the source, but the treasury is an ordinary system-owned
    // wallet and was never a Signer here — a program cannot debit an account it
    // does not own. It only ever appeared to work because treasury ==
    // authority, and the authority signs; in that case it is also redundant,
    // since the authority can simply spend from its own wallet.
    //
    // The trap it set: the documented mainnet path (transfer_authority -> point
    // treasury at a multisig) is exactly what breaks it, so it would have failed
    // the first time it actually mattered.
    //
    // Nothing is stranded by the removal. Protocol revenue is paid straight to
    // the treasury wallet by the payer's own CPI (buy_gumball, accept_offer,
    // settle_auction, reveal_and_mint); the program never custodies it. The
    // lamports the program DOES custody have their own exits:
    // sweep_xnt_pool_nft / sweep_xnt_pool_lp for the fee pools, refund_mint for
    // an unfulfilled MintRequest, and settle_auction for bid escrow.
    //
    // If protocol-owned revenue custody is ever wanted, the correct design is a
    // program-owned treasury PDA that every fee sink pays into and that an
    // authority-gated instruction withdraws from — not this.

    /// H2 FIX: Sync gumball owner to current SPL token holder.
    /// Anyone can call this — it just reads the ATA balance and updates the field.
    pub fn update_owner(ctx: Context<UpdateOwner>) -> Result<()> {
        instructions::update_owner(ctx)
    }

    // ── Marketplace ──────────────────────────────────────────────────────────

    /// List a gumball NFT for sale at a fixed price.
    /// Token is escrowed in a PDA-owned ATA until sold or delisted.
    pub fn list_gumball(ctx: Context<ListGumball>, price: u64) -> Result<()> {
        instructions::list_gumball(ctx, price)
    }

    /// Cancel a listing and return the NFT to the seller.
    pub fn delist_gumball(ctx: Context<DelistGumball>) -> Result<()> {
        instructions::delist_gumball(ctx)
    }

    /// Buy a listed gumball. `max_price` is the most the buyer is willing to
    /// pay, in lamports — pass the price that was displayed to them.
    ///
    /// Without it this instruction was front-runnable. The Listing PDA address
    /// is derived from the mint alone, so a seller who sees a buy in flight can
    /// delist and relist at any price: the PDA is recreated at the SAME
    /// address, the victim's instruction still resolves, and it settles at the
    /// new price. Binding the caller's expectation is the fix.
    pub fn buy_gumball(ctx: Context<BuyGumball>, max_price: u64) -> Result<()> {
        instructions::buy_gumball(ctx, max_price)
    }

    /// Place an offer on a gumball (listed or not). XNT escrowed in Offer PDA.
    pub fn make_offer(ctx: Context<MakeOffer>, amount: u64, expire_seconds: i64) -> Result<()> {
        instructions::make_offer(ctx, amount, expire_seconds)
    }

    /// Cancel an offer and return escrowed XNT to buyer.
    /// Anchor `close = buyer` handles lamport return + account cleanup.
    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        instructions::cancel_offer(ctx)
    }

    /// Accept an offer — seller receives XNT (minus royalty), buyer gets NFT.
    /// `min_amount` is the least the seller is willing to accept, in lamports —
    /// pass the amount that was displayed to them.
    ///
    /// Mirror of the buy_gumball case: the Offer PDA is keyed by (mint, buyer),
    /// so a buyer can cancel and re-make a smaller offer at the same address
    /// under a pending accept_offer.
    pub fn accept_offer(ctx: Context<AcceptOffer>, min_amount: u64) -> Result<()> {
        instructions::accept_offer(ctx, min_amount)
    }

    // ── GUM SINK ─────────────────────────────────────────────────────────────

    /// Burn a flat GUM fee to re-randomize a gumball's COSMETICS (flavor,
    /// color, special) — rarity never changes. Entropy is the slot hash mixed
    /// with a caller-supplied seed (prevents validator grinding, same model as
    /// burns). Respects any active season window; the picture follows the new traits.
    /// This is GUM's demand sink: supply is fixed, burned GUM is gone forever.
    pub fn reroll_cosmetics(ctx: Context<RerollCosmetics>, user_seed: [u8; 32]) -> Result<()> {
        instructions::reroll_cosmetics(ctx, user_seed)
    }

    // ── AUCTIONS ─────────────────────────────────────────────────────────────

    /// Start an English auction: NFT escrowed (same escrow authority as fixed-
    /// price listings), bids escrow lamports in the Auction PDA. Duration is
    /// bounded to 1 hour – 7 days.
    pub fn create_auction(ctx: Context<CreateAuction>, start_price: u64, duration_secs: i64) -> Result<()> {
        instructions::create_auction(ctx, start_price, duration_secs)
    }

    /// Bid on a live auction. Lamports escrow in the Auction PDA; the previous
    /// highest bidder is refunded in the same transaction. Minimum raise is 5%.
    /// Anti-snipe: a bid in the final 5 minutes extends the auction to now+5min.
    pub fn bid(ctx: Context<Bid>, amount: u64) -> Result<()> {
        instructions::bid(ctx, amount)
    }

    /// Settle an ended auction — permissionless (anyone can crank it).
    /// With bids: NFT → winner, 95% → seller, 5% royalty split 50/25/25 to
    /// treasury/NFT pool/LP pool (same routing as buy_gumball). Without bids:
    /// NFT returns to the seller (pass seller as `winner`). Auction PDA closes
    /// to the seller either way.
    pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
        instructions::settle_auction(ctx)
    }

    // ── STAKING ──────────────────────────────────────────────────────────────

    /// Initialize the staking system. Stores the (already-existing, fixed-supply)
    /// GUM mint pubkey and creates two reward-vault ATAs owned by stake_config.
    /// The admin must transfer GUM into both vaults after init (regular SPL transfer).
    pub fn initialize_staking(ctx: Context<InitializeStaking>) -> Result<()> {
        instructions::initialize_staking(ctx)
    }

    /// Stake a gumball NFT — transfer to vault, start earning GUM via Pattern B.
    pub fn stake(ctx: Context<StakeNft>) -> Result<()> {
        instructions::stake(ctx)
    }

    /// Claim pending GUM rewards without unstaking. Pays from nft_reward_vault.
    pub fn claim(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::claim(ctx)
    }

    /// Unstake — claim final rewards and return NFT to owner. Closes StakeAccount.
    /// Also settles any pending XNT fee share and closes the XntDebt PDA (rent
    /// refunded to the staker; stake() re-creates it on a future re-stake).
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        instructions::unstake(ctx)
    }

    // ── LP STAKING ───────────────────────────────────────────────────────────

    /// Stake LP tokens with a lock tier. lock_tier: 0=Flexible, 1=Bronze (30d),
    /// 2=Silver (90d), 3=Gold (180d), 4=Diamond (365d).
    /// Mints a tradeable position NFT — whoever holds it controls the position.
    pub fn stake_lp(ctx: Context<StakeLp>, amount: u64, lock_tier: u8) -> Result<()> {
        instructions::stake_lp(ctx, amount, lock_tier)
    }

    /// Claim GUM rewards from LP staking — must hold the position NFT.
    /// Pays from lp_reward_vault using Pattern B accumulator.
    pub fn claim_lp(ctx: Context<ClaimLpRewards>) -> Result<()> {
        instructions::claim_lp(ctx)
    }

    /// Unstake LP — must hold position NFT.
    /// Partial: reduces position, keeps NFT. Full: burns NFT, closes account.
    /// Early exit (before lock_until): per-tier penalty, of which 50% is burned
    /// and 50% retained in the vault as deferred rewards. No GUM emitted on early exit.
    pub fn unstake_lp(ctx: Context<UnstakeLp>, amount: u64) -> Result<()> {
        instructions::unstake_lp(ctx, amount)
    }

    // ── LEGACY RECOVERY (one-shot, post-Phase-1 migration) ──────────────────

    /// Recover an NFT staked under the v1 (pre-Phase-1) StakeAccount layout.
    /// Reads the OLD 8+82-byte StakeAccount via raw bytes, transfers the NFT
    /// from the OLD vault back to the owner, closes the OLD PDA. No GUM
    /// rewards (v1 GUM PDA mint is no longer authoritative).
    pub fn recover_legacy_v1_stake(ctx: Context<RecoverLegacyV1Stake>) -> Result<()> {
        instructions::recover_legacy_v1_stake(ctx)
    }

    // ── PHASE 2: XNT FEE SHARING ─────────────────────────────────────────────

    /// One-time admin call: creates the four PDAs that power XNT fee sharing
    /// (two lamport-holding pools + two accumulator state accounts).
    pub fn initialize_xnt_fees(ctx: Context<InitializeXntFees>) -> Result<()> {
        instructions::initialize_xnt_fees(ctx)
    }

    /// NFT staker claims their accumulated XNT share. Creates the per-position
    /// XntDebt PDA on first call (lazy-init for legacy positions; new positions
    /// have it initialized at stake-time so this path is mostly redundant).
    pub fn claim_xnt_fees_nft(ctx: Context<ClaimXntFeesNft>) -> Result<()> {
        instructions::claim_xnt_fees_nft(ctx)
    }

    /// LP staker claims their accumulated XNT share.
    pub fn claim_xnt_fees_lp(ctx: Context<ClaimXntFeesLp>) -> Result<()> {
        instructions::claim_xnt_fees_lp(ctx)
    }

    /// Admin: recover unattributed lamports from the NFT XNT fee pool while
    /// NO ONE is staked (total_nft_weight == 0). Unattributed lamports come
    /// from sources with no owner: fees absorbed while the pool had zero
    /// stakers, shares forfeited by pre-XntDebt legacy positions, unpayable
    /// remainders of closed positions, and accumulator rounding dust. With
    /// zero weight there are no live entitlements, so the sweep cannot touch
    /// any staker's share. Leaves the rent-exempt minimum in place and
    /// re-baselines last_seen so accounting starts clean.
    pub fn sweep_xnt_pool_nft(ctx: Context<SweepXntPoolNft>) -> Result<()> {
        instructions::sweep_xnt_pool_nft(ctx)
    }

    /// Admin: same as sweep_xnt_pool_nft, for the LP pool (total_lp_weight == 0).
    pub fn sweep_xnt_pool_lp(ctx: Context<SweepXntPoolLp>) -> Result<()> {
        instructions::sweep_xnt_pool_lp(ctx)
    }

    /// Admin: register (or change) the single LP mint that stake_lp accepts.
    /// Kept in its own PDA so the StakeConfig layout does not change. Existing
    /// positions keep the mint recorded in their LpStakeAccount; changing this
    /// only affects NEW stakes.
    pub fn set_lp_mint(ctx: Context<SetLpMint>, lp_mint: Pubkey) -> Result<()> {
        instructions::set_lp_mint(ctx, lp_mint)
    }

}
