use crate::*;

#[derive(Accounts)]
pub struct CreateAuction<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = seller,
        constraint = seller_ata.amount == 1 @ GumballError::Unauthorized,
    )]
    pub seller_ata: Account<'info, TokenAccount>,
    /// CHECK: escrow PDA authority — same escrow as fixed-price listings
    #[account(seeds = [b"escrow", nft_mint.key().as_ref()], bump)]
    pub escrow_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = nft_mint,
        associated_token::authority = escrow_authority,
    )]
    pub escrow_ata: Account<'info, TokenAccount>,
    #[account(init, payer = seller, space = 8 + Auction::LEN,
              seeds = [b"auction", nft_mint.key().as_ref()], bump)]
    pub auction: Account<'info, Auction>,
    #[account(
        seeds = [b"gumball", nft_mint.key().as_ref()],
        bump = gumball_data.bump,
        constraint = gumball_data.owner == seller.key() @ GumballError::Unauthorized,
    )]
    pub gumball_data: Account<'info, GumballData>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Bid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(mut, seeds = [b"auction", auction.nft_mint.as_ref()], bump = auction.bump)]
    pub auction: Account<'info, Auction>,
    /// CHECK: refund target — validated against auction.highest_bidder in the
    /// handler (any account is accepted when there is no previous bid)
    #[account(mut)]
    pub prev_bidder: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleAuction<'info> {
    /// Anyone can crank a settle; the payer covers winner-ATA rent if needed
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [b"auction", nft_mint.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Account<'info, Auction>,
    /// CHECK: validated against auction.seller
    #[account(mut, constraint = seller.key() == auction.seller @ GumballError::Unauthorized)]
    pub seller: AccountInfo<'info>,
    /// CHECK: highest bidder (or the seller when there were no bids) — handler-validated
    #[account(mut)]
    pub winner: AccountInfo<'info>,
    #[account(constraint = nft_mint.key() == auction.nft_mint @ GumballError::InvalidAccount)]
    pub nft_mint: Box<Account<'info, Mint>>,
    /// CHECK: escrow PDA authority
    #[account(seeds = [b"escrow", nft_mint.key().as_ref()], bump)]
    pub escrow_authority: AccountInfo<'info>,
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = escrow_authority,
    )]
    pub escrow_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = nft_mint,
        associated_token::authority = winner,
    )]
    pub winner_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"gumball", nft_mint.key().as_ref()], bump = gumball_data.bump)]
    pub gumball_data: Box<Account<'info, GumballData>>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Box<Account<'info, Machine>>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    #[account(mut, seeds = [b"nft_xnt_pool"], bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    #[account(mut, seeds = [b"lp_xnt_pool"], bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

pub fn create_auction(ctx: Context<CreateAuction>, start_price: u64, duration_secs: i64) -> Result<()> {
    // L3 FIX: a bid below the rent-exempt minimum for a 0-byte account can't
    // be refunded to an emptied wallet, which would freeze every later outbid.
    require!(
        start_price >= Rent::get()?.minimum_balance(0),
        GumballError::InvalidPrice
    );
    require!((3600..=7 * 86400).contains(&duration_secs), GumballError::InvalidPrice);

    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.seller_ata.to_account_info(),
                to:        ctx.accounts.escrow_ata.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        1,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts.auction;
    a.seller         = ctx.accounts.seller.key();
    a.nft_mint       = ctx.accounts.nft_mint.key();
    a.start_price    = start_price;
    a.ends_at        = now + duration_secs;
    a.highest_bid    = 0;
    a.highest_bidder = Pubkey::default();
    a.settled        = false;
    a.bump           = ctx.bumps.auction;

    emit!(AuctionCreatedEvent {
        seller: a.seller, nft_mint: a.nft_mint, start_price, ends_at: a.ends_at,
    });
    Ok(())
}

pub fn bid(ctx: Context<Bid>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts.auction;
    require!(!a.settled, GumballError::AlreadyFulfilled);
    require!(now < a.ends_at, GumballError::AuctionEnded);

    let min_bid = if a.highest_bid == 0 {
        a.start_price
    } else {
        a.highest_bid
            .checked_add((a.highest_bid / 20).max(1)).ok_or(GumballError::MathOverflow)?
    };
    require!(amount >= min_bid, GumballError::BidTooLow);

    // Escrow the new bid (bidder is a system account, so CPI transfer works)
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.bidder.to_account_info(),
                to:   ctx.accounts.auction.to_account_info(),
            },
        ),
        amount,
    )?;

    // Refund the outbid escrow directly from the PDA
    let prev_bid = ctx.accounts.auction.highest_bid;
    if prev_bid > 0 {
        require!(
            ctx.accounts.prev_bidder.key() == ctx.accounts.auction.highest_bidder,
            GumballError::InvalidAccount
        );
        **ctx.accounts.auction.to_account_info().try_borrow_mut_lamports()? -= prev_bid;
        **ctx.accounts.prev_bidder.try_borrow_mut_lamports()? += prev_bid;
    }

    let a = &mut ctx.accounts.auction;
    a.highest_bid = amount;
    a.highest_bidder = ctx.accounts.bidder.key();
    if a.ends_at - now < 300 { a.ends_at = now + 300; }

    emit!(AuctionBidEvent {
        bidder: a.highest_bidder, nft_mint: a.nft_mint, amount, ends_at: a.ends_at,
    });
    Ok(())
}

pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.auction.settled, GumballError::AlreadyFulfilled);
    require!(now >= ctx.accounts.auction.ends_at, GumballError::AuctionNotEnded);

    let bid = ctx.accounts.auction.highest_bid;
    if bid == 0 {
        // No bids — the "winner" must be the seller (NFT goes home)
        require!(
            ctx.accounts.winner.key() == ctx.accounts.auction.seller,
            GumballError::InvalidAccount
        );
    } else {
        require!(
            ctx.accounts.winner.key() == ctx.accounts.auction.highest_bidder,
            GumballError::InvalidAccount
        );
        let royalty = bid.checked_mul(ROYALTY_BPS).ok_or(GumballError::MathOverflow)? / 10_000;
        let to_nft = royalty.checked_mul(FEE_NFT_BPS_ROYAL).ok_or(GumballError::MathOverflow)? / 10_000;
        let to_lp  = royalty.checked_mul(FEE_LP_BPS_ROYAL).ok_or(GumballError::MathOverflow)?  / 10_000;
        let to_treasury = royalty.checked_sub(to_nft).ok_or(GumballError::MathOverflow)?
            .checked_sub(to_lp).ok_or(GumballError::MathOverflow)?;
        let to_seller = bid.checked_sub(royalty).ok_or(GumballError::MathOverflow)?;

        // Escrowed lamports live in the program-owned Auction PDA —
        // distribute with direct lamport arithmetic
        let auction_info = ctx.accounts.auction.to_account_info();
        **auction_info.try_borrow_mut_lamports()? -= bid;
        **ctx.accounts.seller.try_borrow_mut_lamports()?      += to_seller;
        **ctx.accounts.treasury.try_borrow_mut_lamports()?    += to_treasury;
        **ctx.accounts.nft_xnt_pool.to_account_info().try_borrow_mut_lamports()? += to_nft;
        **ctx.accounts.lp_xnt_pool.to_account_info().try_borrow_mut_lamports()?  += to_lp;

        ctx.accounts.gumball_data.owner = ctx.accounts.winner.key();
        emit!(XntFeeDistributedEvent {
            source: 3, treasury: to_treasury, nft_pool: to_nft, lp_pool: to_lp,
        });
        emit!(GumballSoldEvent {
            seller: ctx.accounts.auction.seller,
            buyer: ctx.accounts.winner.key(),
            nft_mint: ctx.accounts.auction.nft_mint,
            price: bid,
            royalty,
        });
    }

    // NFT: escrow → winner (or back to seller when no bids)
    let nft_mint_key = ctx.accounts.auction.nft_mint;
    let seeds = &[b"escrow".as_ref(), nft_mint_key.as_ref(), &[ctx.bumps.escrow_authority]];
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.escrow_ata.to_account_info(),
                to:        ctx.accounts.winner_ata.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            &[seeds],
        ),
        1,
    )?;

    ctx.accounts.auction.settled = true;
    // Auction PDA rent returns to the seller via `close = seller`
    Ok(())
}
