use crate::*;

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum GumballError {
    #[msg("Machine is not active")]                  MachineInactive,
    #[msg("Sold out — no new serials can be issued")]SoldOut,
    #[msg("Quantity must be 1-5")]                   InvalidQuantity,
    #[msg("Price must be > 0")]                      InvalidPrice,
    #[msg("Invalid treasury")]                       InvalidTreasury,
    #[msg("Unauthorized")]                           Unauthorized,
    #[msg("Arithmetic overflow")]                    MathOverflow,
    #[msg("Insufficient funds")]                     InsufficientFunds,
    #[msg("Already Legendary — cannot upgrade")]     AlreadyLegendary,
    #[msg("All gumballs must be same rarity")]       RarityMismatch,
    #[msg("Wrong number of gumballs to burn")]       WrongBurnCount,
    #[msg("Use burn_multi for this rarity tier")]    UseMultiBurn,
    #[msg("Mint already fulfilled")]                 AlreadyFulfilled,
    #[msg("Commitment already used")]                CommitmentAlreadyUsed,
    #[msg("Invalid commitment — secret mismatch")]   InvalidCommitment,
    #[msg("Invalid slot hash")]                      InvalidSlotHash,
    #[msg("Invalid account data")]                   InvalidAccount,
    #[msg("Mint request has expired")]               RequestExpired,
    #[msg("Offer has expired")]                      OfferExpired,
    #[msg("GUM supply exhausted")]                   GumSupplyExhausted,
    #[msg("Invalid lock tier — must be 0 (Flexible), 1 (Bronze), 2 (Silver), 3 (Gold), or 4 (Diamond)")] InvalidLockPeriod,
    #[msg("Cannot sweep while stakers are active")]  PoolHasStakers,
    #[msg("Auction has ended")]                      AuctionEnded,
    #[msg("Auction has not ended yet")]              AuctionNotEnded,
    #[msg("Bid below minimum (start price or +5% raise)")] BidTooLow,
    #[msg("Listing price is higher than the maximum the buyer accepted")] PriceAboveMax,
    #[msg("Offer amount is lower than the minimum the seller accepted")]  AmountBelowMin,
    #[msg("LP mint is not the one registered via set_lp_mint")] InvalidLpMint,
    #[msg("Seed slot not reached yet: retry a few slots after request_slot + REVEAL_DELAY_SLOTS")] SeedSlotNotReached,
    #[msg("Gumball is not burned")]                  NotBurned,
    #[msg("Mint is not a gumball mint")]             NotGumballMint,
}
