use crate::*;

#[derive(Accounts)]
pub struct UpdateOwner<'info> {
    pub holder: Signer<'info>,
    #[account(
        mut,
        seeds = [b"gumball", nft_mint.key().as_ref()],
        bump = gumball_data.bump,
    )]
    pub gumball_data: Account<'info, GumballData>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        associated_token::mint = nft_mint,
        associated_token::authority = holder,
    )]
    pub holder_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

// ─── Marketplace Account Contexts ────────────────────────────────────────────

#[derive(Accounts)]
pub struct ListGumball<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = seller,
        constraint = seller_ata.amount == 1 @ GumballError::Unauthorized,
    )]
    pub seller_ata: Account<'info, TokenAccount>,
    /// CHECK: escrow PDA authority
    #[account(seeds = [b"escrow", nft_mint.key().as_ref()], bump)]
    pub escrow_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = nft_mint,
        associated_token::authority = escrow_authority,
    )]
    pub escrow_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = seller,
        space = 8 + Listing::LEN,
        seeds = [b"listing", nft_mint.key().as_ref()],
        bump,
    )]
    pub listing: Account<'info, Listing>,
    #[account(
        mut,
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
pub struct DelistGumball<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        close = seller,
        seeds = [b"listing", nft_mint.key().as_ref()],
        bump = listing.bump,
        constraint = listing.seller == seller.key() @ GumballError::Unauthorized,
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: escrow PDA authority
    #[account(seeds = [b"escrow", nft_mint.key().as_ref()], bump)]
    pub escrow_authority: AccountInfo<'info>,
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = escrow_authority,
    )]
    pub escrow_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = nft_mint,
        associated_token::authority = seller,
    )]
    pub seller_ata: Account<'info, TokenAccount>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuyGumball<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: seller receives payment, validated via listing
    #[account(mut, constraint = seller.key() == listing.seller @ GumballError::Unauthorized)]
    pub seller: AccountInfo<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Box<Account<'info, Machine>>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    pub nft_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        close = seller,
        seeds = [b"listing", nft_mint.key().as_ref()],
        bump = listing.bump,
    )]
    pub listing: Box<Account<'info, Listing>>,
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
        payer = buyer,
        associated_token::mint = nft_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"gumball", nft_mint.key().as_ref()],
        bump = gumball_data.bump,
    )]
    pub gumball_data: Box<Account<'info, GumballData>>,
    /// PHASE 2: NFT staker fee pool — receives 25% of royalty
    #[account(mut, seeds = [b"nft_xnt_pool"], bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    /// PHASE 2: LP staker fee pool — receives 25% of royalty
    #[account(mut, seeds = [b"lp_xnt_pool"], bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MakeOffer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Offer::LEN,
        seeds = [b"offer", nft_mint.key().as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub offer: Account<'info, Offer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        close = buyer,
        seeds = [b"offer", offer.nft_mint.as_ref(), buyer.key().as_ref()],
        bump = offer.bump,
        constraint = offer.buyer == buyer.key() @ GumballError::Unauthorized,
    )]
    pub offer: Account<'info, Offer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: buyer receives NFT and rent refund, validated via offer
    #[account(mut, constraint = buyer.key() == offer.buyer @ GumballError::Unauthorized)]
    pub buyer: AccountInfo<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Box<Account<'info, Machine>>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    pub nft_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [b"offer", nft_mint.key().as_ref(), buyer.key().as_ref()],
        bump = offer.bump,
        constraint = offer.nft_mint == nft_mint.key() @ GumballError::Unauthorized,
    )]
    pub offer: Box<Account<'info, Offer>>,
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = seller,
        constraint = seller_ata.amount == 1 @ GumballError::Unauthorized,
    )]
    pub seller_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = nft_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"gumball", nft_mint.key().as_ref()],
        bump = gumball_data.bump,
        constraint = gumball_data.owner == seller.key() @ GumballError::Unauthorized,
    )]
    pub gumball_data: Box<Account<'info, GumballData>>,
    /// PHASE 2: NFT staker fee pool — receives 25% of royalty
    #[account(mut, seeds = [b"nft_xnt_pool"], bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    /// PHASE 2: LP staker fee pool — receives 25% of royalty
    #[account(mut, seeds = [b"lp_xnt_pool"], bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

pub fn update_owner(ctx: Context<UpdateOwner>) -> Result<()> {
    // Verify the caller actually holds the token
    require!(
        ctx.accounts.holder_ata.amount == 1,
        GumballError::Unauthorized
    );
    require!(
        ctx.accounts.holder_ata.mint == ctx.accounts.nft_mint.key(),
        GumballError::Unauthorized
    );
    ctx.accounts.gumball_data.owner = ctx.accounts.holder.key();
    Ok(())
}

pub fn list_gumball(ctx: Context<ListGumball>, price: u64) -> Result<()> {
    require!(price > 0, GumballError::InvalidPrice);

    // Transfer NFT from seller to escrow ATA
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

    let listing         = &mut ctx.accounts.listing;
    listing.seller      = ctx.accounts.seller.key();
    listing.nft_mint    = ctx.accounts.nft_mint.key();
    listing.price       = price;
    listing.created_at  = Clock::get()?.unix_timestamp;
    listing.bump        = ctx.bumps.listing;

    emit!(GumballListedEvent {
        seller: listing.seller, nft_mint: listing.nft_mint, price,
    });
    Ok(())
}

pub fn delist_gumball(ctx: Context<DelistGumball>) -> Result<()> {
    let nft_mint_key = ctx.accounts.listing.nft_mint;
    let seeds = &[b"escrow".as_ref(), nft_mint_key.as_ref(), &[ctx.bumps.escrow_authority]];

    // Transfer NFT from escrow back to seller
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.escrow_ata.to_account_info(),
                to:        ctx.accounts.seller_ata.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            &[seeds],
        ),
        1,
    )?;

    emit!(GumballDelistedEvent {
        seller: ctx.accounts.listing.seller, nft_mint: nft_mint_key,
    });
    // Listing PDA closed via close = seller in account struct
    Ok(())
}

pub fn buy_gumball(ctx: Context<BuyGumball>, max_price: u64) -> Result<()> {
    let price = ctx.accounts.listing.price;
    require!(price <= max_price, GumballError::PriceAboveMax);
    let royalty = price.checked_mul(ROYALTY_BPS).ok_or(GumballError::MathOverflow)? / 10_000;
    let seller_amount = price.checked_sub(royalty).ok_or(GumballError::MathOverflow)?;

    // Pay seller
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to:   ctx.accounts.seller.to_account_info(),
            },
        ),
        seller_amount,
    )?;

    // PHASE 2: split royalty 50/25/25 → treasury / NFT pool / LP pool
    if royalty > 0 {
        let to_nft = royalty.checked_mul(FEE_NFT_BPS_ROYAL).ok_or(GumballError::MathOverflow)? / 10_000;
        let to_lp  = royalty.checked_mul(FEE_LP_BPS_ROYAL).ok_or(GumballError::MathOverflow)?  / 10_000;
        let to_treasury = royalty.checked_sub(to_nft).ok_or(GumballError::MathOverflow)?
            .checked_sub(to_lp).ok_or(GumballError::MathOverflow)?;
        if to_treasury > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.treasury.to_account_info(),
                    }), to_treasury)?;
        }
        if to_nft > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.nft_xnt_pool.to_account_info(),
                    }), to_nft)?;
        }
        if to_lp > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.lp_xnt_pool.to_account_info(),
                    }), to_lp)?;
        }
        emit!(XntFeeDistributedEvent {
            source: 2, treasury: to_treasury, nft_pool: to_nft, lp_pool: to_lp,
        });
    }

    // Transfer NFT from escrow to buyer
    let nft_mint_key = ctx.accounts.listing.nft_mint;
    let seeds = &[b"escrow".as_ref(), nft_mint_key.as_ref(), &[ctx.bumps.escrow_authority]];
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.escrow_ata.to_account_info(),
                to:        ctx.accounts.buyer_ata.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            &[seeds],
        ),
        1,
    )?;

    // Update gumball owner
    ctx.accounts.gumball_data.owner = ctx.accounts.buyer.key();

    emit!(GumballSoldEvent {
        seller: ctx.accounts.listing.seller, buyer: ctx.accounts.buyer.key(),
        nft_mint: nft_mint_key, price, royalty,
    });
    // Listing PDA closed via close = seller
    Ok(())
}

pub fn make_offer(ctx: Context<MakeOffer>, amount: u64, expire_seconds: i64) -> Result<()> {
    require!(amount > 0, GumballError::InvalidPrice);

    // Escrow XNT in the Offer PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to:   ctx.accounts.offer.to_account_info(),
            },
        ),
        amount,
    )?;

    let now          = Clock::get()?.unix_timestamp;
    let offer        = &mut ctx.accounts.offer;
    offer.buyer      = ctx.accounts.buyer.key();
    offer.nft_mint   = ctx.accounts.nft_mint.key();
    offer.amount     = amount;
    offer.created_at = now;
    // Default to 7 days if 0 or negative; cap at 30 days
    let exp = if expire_seconds <= 0 { 7 * 86400 } else { expire_seconds.min(30 * 86400) };
    offer.expires_at = now + exp;
    offer.bump       = ctx.bumps.offer;

    emit!(OfferMadeEvent {
        buyer: offer.buyer, nft_mint: offer.nft_mint, amount,
    });
    Ok(())
}

pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
    emit!(OfferCancelledEvent {
        buyer: ctx.accounts.offer.buyer, nft_mint: ctx.accounts.offer.nft_mint,
    });
    Ok(())
}

pub fn accept_offer(ctx: Context<AcceptOffer>, min_amount: u64) -> Result<()> {
    // Check offer hasn't expired
    let now = Clock::get()?.unix_timestamp;
    if ctx.accounts.offer.expires_at > 0 {
        require!(now <= ctx.accounts.offer.expires_at, GumballError::OfferExpired);
    }
    let amount = ctx.accounts.offer.amount;
    require!(amount >= min_amount, GumballError::AmountBelowMin);
    let royalty = amount.checked_mul(ROYALTY_BPS).ok_or(GumballError::MathOverflow)? / 10_000;
    let seller_amount = amount.checked_sub(royalty).ok_or(GumballError::MathOverflow)?;

    // Move the NFT FIRST. This CPI used to run after the block below had
    // already zeroed the Offer PDA's lamports and data; draining an account
    // by hand and then invoking a CPI in the same instruction trips the
    // runtime's lamport-balance check, and accept_offer failed with
    // UnbalancedInstruction every time — the offer flow could never
    // complete. Doing the CPI while all accounts are still intact fixes it.
    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.seller_ata.to_account_info(),
                to:        ctx.accounts.buyer_ata.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        1,
    )?;

    let offer_info = ctx.accounts.offer.to_account_info();

    // Pay seller from Offer PDA
    **offer_info.try_borrow_mut_lamports()? -= seller_amount;
    **ctx.accounts.seller.try_borrow_mut_lamports()? += seller_amount;

    // PHASE 2: split royalty 50/25/25 → treasury / NFT pool / LP pool from Offer PDA
    if royalty > 0 {
        let to_nft = royalty.checked_mul(FEE_NFT_BPS_ROYAL).ok_or(GumballError::MathOverflow)? / 10_000;
        let to_lp  = royalty.checked_mul(FEE_LP_BPS_ROYAL).ok_or(GumballError::MathOverflow)?  / 10_000;
        let to_treasury = royalty.checked_sub(to_nft).ok_or(GumballError::MathOverflow)?
            .checked_sub(to_lp).ok_or(GumballError::MathOverflow)?;
        **offer_info.try_borrow_mut_lamports()? -= royalty;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += to_treasury;
        **ctx.accounts.nft_xnt_pool.to_account_info().try_borrow_mut_lamports()? += to_nft;
        **ctx.accounts.lp_xnt_pool.to_account_info().try_borrow_mut_lamports()? += to_lp;
        emit!(XntFeeDistributedEvent {
            source: 3, treasury: to_treasury, nft_pool: to_nft, lp_pool: to_lp,
        });
    }

    // Return remaining rent to buyer and close Offer account
    let remaining = offer_info.lamports();
    **offer_info.try_borrow_mut_lamports()? = 0;
    **ctx.accounts.buyer.try_borrow_mut_lamports()? += remaining;
    offer_info.try_borrow_mut_data()?.fill(0);

    // Update gumball owner
    ctx.accounts.gumball_data.owner = ctx.accounts.buyer.key();

    emit!(GumballSoldEvent {
        seller: ctx.accounts.seller.key(), buyer: ctx.accounts.offer.buyer,
        nft_mint: ctx.accounts.offer.nft_mint, price: amount, royalty,
    });
    Ok(())
}
