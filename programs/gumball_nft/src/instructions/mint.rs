use crate::*;

/// Refund a request from inside reveal_and_mint (timeout, or seed slot aged out).
fn refund_in_reveal<'info>(
    mint_request: &mut Account<'info, MintRequest>,
    minter: &AccountInfo<'info>,
    minter_key: Pubkey,
    paid_amount: u64,
) -> Result<()> {
    let req_info = mint_request.to_account_info();
    let rent_lamports = req_info.lamports();
    **req_info.try_borrow_mut_lamports()? = 0;
    **minter.try_borrow_mut_lamports()? += rent_lamports;
    // Close the PDA: zero data + mark fulfilled
    req_info.try_borrow_mut_data()?.fill(0);
    mint_request.fulfilled = true;
    emit!(MintRefundedEvent { minter: minter_key, amount: paid_amount });
    Ok(())
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], slot: u64)]
pub struct SubmitCommitment<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(
        init,
        payer = oracle,
        space = 8 + OracleCommit::LEN,
        seeds = [b"commit", oracle.key().as_ref(), &slot.to_le_bytes()],
        bump,
    )]
    pub oracle_commit: Account<'info, OracleCommit>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestMint<'info> {
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(mut, seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"commit", machine.oracle.as_ref(), &oracle_commit.submitted_slot.to_le_bytes()],
        bump = oracle_commit.bump,
        constraint = !oracle_commit.used @ GumballError::CommitmentAlreadyUsed,
        constraint = oracle_commit.oracle == machine.oracle @ GumballError::Unauthorized,
    )]
    pub oracle_commit: Account<'info, OracleCommit>,
    #[account(
        init,
        payer = minter,
        space = 8 + MintRequest::LEN,
        seeds = [b"mint_request", minter.key().as_ref(), oracle_commit.key().as_ref()],
        bump,
    )]
    pub mint_request: Account<'info, MintRequest>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealAndMint<'info> {
    #[account(mut, constraint = oracle.key() == machine.oracle @ GumballError::Unauthorized)]
    pub oracle: Signer<'info>,
    #[account(mut, seeds = [b"machine"], bump = machine.bump)]
    pub machine: Box<Account<'info, Machine>>,
    /// CHECK: PDA authority
    #[account(seeds = [b"machine_authority"], bump)]
    pub machine_authority: AccountInfo<'info>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    /// CHECK: minter validated against mint_request
    #[account(mut, constraint = minter.key() == mint_request.minter @ GumballError::Unauthorized)]
    pub minter: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"mint_request", minter.key().as_ref(), oracle_commit.key().as_ref()],
        bump = mint_request.bump,
        constraint = !mint_request.fulfilled @ GumballError::AlreadyFulfilled,
        constraint = mint_request.remaining_quantity > 0 @ GumballError::AlreadyFulfilled,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,
    #[account(
        mut,
        seeds = [b"commit", oracle.key().as_ref(), &oracle_commit.submitted_slot.to_le_bytes()],
        bump = oracle_commit.bump,
        constraint = oracle_commit.key() == mint_request.commitment @ GumballError::InvalidCommitment,
    )]
    pub oracle_commit: Box<Account<'info, OracleCommit>>,
    #[account(init, payer = oracle, mint::decimals = 0, mint::authority = machine_authority, mint::freeze_authority = machine_authority)]
    pub nft_mint: Box<Account<'info, Mint>>,
    #[account(init_if_needed, payer = oracle, associated_token::mint = nft_mint, associated_token::authority = minter)]
    pub minter_ata: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = oracle, space = 8 + GumballData::LEN, seeds = [b"gumball", nft_mint.key().as_ref()], bump)]
    pub gumball_data: Box<Account<'info, GumballData>>,
    #[account(init, payer = oracle, space = 8 + GumballSvg::LEN, seeds = [b"svg", nft_mint.key().as_ref()], bump)]
    pub gumball_svg: Box<Account<'info, GumballSvg>>,
    /// CHECK: slot hashes sysvar
    #[account(address = sysvar::slot_hashes::id())]
    pub slot_hashes: AccountInfo<'info>,
    /// PHASE 2: NFT staker fee pool — receives 40% of mint revenue
    #[account(mut, seeds = [b"nft_xnt_pool"], bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    /// PHASE 2: LP staker fee pool — receives 10% of mint revenue
    #[account(mut, seeds = [b"lp_xnt_pool"], bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    /// CHECK: SeasonConfig PDA — parsed manually in apply_season; an
    /// UNINITIALIZED account means "no active season", so mints keep working
    /// even before set_season is ever called (no deploy-order lockout). The
    /// seeds constraint pins the address, so only set_season can put data here.
    #[account(seeds = [b"season"], bump)]
    pub season_config: AccountInfo<'info>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RefundLegacyMint<'info> {
    /// CHECK: must equal the minter stored in the legacy request (checked in the handler)
    #[account(mut)]
    pub minter: AccountInfo<'info>,
    /// CHECK: legacy 156-byte MintRequest, validated by hand (owner, length,
    /// discriminator, PDA seeds) because Account<MintRequest> cannot read it
    #[account(mut)]
    pub mint_request: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefundMint<'info> {
    /// CHECK: verified via mint_request.minter constraint
    #[account(mut, constraint = minter.key() == mint_request.minter @ GumballError::Unauthorized)]
    pub minter: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"mint_request", minter.key().as_ref(), oracle_commit.key().as_ref()],
        bump = mint_request.bump,
        constraint = !mint_request.fulfilled @ GumballError::AlreadyFulfilled,
    )]
    pub mint_request: Account<'info, MintRequest>,
    #[account(
        seeds = [b"commit", oracle_commit.oracle.as_ref(), &oracle_commit.submitted_slot.to_le_bytes()],
        bump = oracle_commit.bump,
    )]
    pub oracle_commit: Account<'info, OracleCommit>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    pub system_program: Program<'info, System>,
}

pub fn submit_commitment(
    ctx: Context<SubmitCommitment>,
    commitment: [u8; 32],
    slot: u64,
) -> Result<()> {
    // Only the registered oracle can submit commitments
    require!(
        ctx.accounts.oracle.key() == ctx.accounts.machine.oracle,
        GumballError::Unauthorized
    );

    let commit          = &mut ctx.accounts.oracle_commit;
    commit.oracle       = ctx.accounts.oracle.key();
    commit.commitment   = commitment;
    commit.submitted_at = Clock::get()?.unix_timestamp;
    commit.submitted_slot = slot;
    commit.used         = false;
    commit.bump         = ctx.bumps.oracle_commit;

    emit!(CommitmentSubmittedEvent {
        oracle:     ctx.accounts.oracle.key(),
        commitment,
    });
    Ok(())
}

pub fn request_mint(ctx: Context<RequestMint>, quantity: u8, user_seed: [u8; 32]) -> Result<()> {
    require!(ctx.accounts.machine.is_active, GumballError::MachineInactive);
    require!(quantity >= 1 && quantity <= MAX_PER_TX, GumballError::InvalidQuantity);

    // Commitment must not be used yet
    require!(!ctx.accounts.oracle_commit.used, GumballError::CommitmentAlreadyUsed);

    let machine   = &ctx.accounts.machine;
    let remaining = machine.max_supply - machine.total_minted;
    require!(remaining >= quantity as u64, GumballError::SoldOut);

    // Dynamic pricing: sum the price for each mint in the batch
    let mut total_cost: u64 = 0;
    for i in 0..quantity as u64 {
        total_cost = total_cost
            .checked_add(get_mint_price(machine.total_minted + i))
            .ok_or(GumballError::MathOverflow)?;
    }

    // Lock payment in MintRequest PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.minter.to_account_info(),
                to:   ctx.accounts.mint_request.to_account_info(),
            },
        ),
        total_cost,
    )?;
    let clock = Clock::get()?;
    let req   = &mut ctx.accounts.mint_request;
    req.minter       = ctx.accounts.minter.key();
    req.machine      = machine.key();
    req.commitment   = ctx.accounts.oracle_commit.key();
    req.quantity             = quantity;
    req.remaining_quantity   = quantity; // CRIT-1 FIX: track remaining
    req.paid_amount          = total_cost;
    req.user_seed            = user_seed; // CRIT-3 FIX: store user entropy
    req.requested_at = clock.unix_timestamp;
    req.fulfilled    = false;
    req.bump         = ctx.bumps.mint_request;
    req.request_slot = clock.slot; // fixes the seed slot (see reveal_and_mint)


    // Mark commitment as used so it can't be reused
    ctx.accounts.oracle_commit.used = true;

    emit!(MintRequestedEvent {
        minter:     ctx.accounts.minter.key(),
        commitment: ctx.accounts.oracle_commit.key(),
        quantity,
        paid:       total_cost,
    });
    Ok(())
}

pub fn reveal_and_mint(
    ctx: Context<RevealAndMint>,
    secret: [u8; 32],
) -> Result<()> {
    let clock        = Clock::get()?;
    let minter_key   = ctx.accounts.mint_request.minter;
    let paid_amount  = ctx.accounts.mint_request.paid_amount;
    let requested_at = ctx.accounts.mint_request.requested_at;

    // M-2 FIX: timeout — refund if oracle took too long
    if clock.unix_timestamp - requested_at > MINT_TIMEOUT {
        return refund_in_reveal(&mut ctx.accounts.mint_request, &ctx.accounts.minter, minter_key, paid_amount);
    }

    // S1 FIX: request_mint only sees minted supply, not pending requests, so
    // concurrent requests near sell-out can exceed the cap. Enforce it here;
    // the user then recovers payment via the timeout refund above.
    require!(
        ctx.accounts.machine.total_minted < ctx.accounts.machine.max_supply,
        GumballError::SoldOut
    );

    // C-2 FIX: verify commitment on-chain
    // commitment = sha256(secret || oracle_pubkey)
    let oracle_pubkey = ctx.accounts.oracle.key();
    let expected_commitment = hashv(&[&secret, oracle_pubkey.as_ref()]);
    require!(
        expected_commitment.to_bytes() == ctx.accounts.oracle_commit.commitment,
        GumballError::InvalidCommitment
    );

    // FAIRNESS: the hash comes from a slot fixed at request time, not from
    // "whatever is newest now". The oracle therefore cannot choose WHEN to reveal
    // to steer the outcome: every reveal of this request, at any slot, uses the same
    // hash. (It can still decline to reveal and let the request refund.)
    let (seed_slot, slot_hash) = {
        let slot_hash_data = ctx.accounts.slot_hashes.data.borrow();
        match lookup_fixed_slot_hash(&slot_hash_data, ctx.accounts.mint_request.request_slot) {
            SlotLookup::Found(slot, hash) => (slot, hash),
            SlotLookup::NotYet => return err!(GumballError::SeedSlotNotReached),
            SlotLookup::AgedOut => {
                drop(slot_hash_data);
                return refund_in_reveal(&mut ctx.accounts.mint_request, &ctx.accounts.minter, minter_key, paid_amount);
            }
        }
    };
    let slot_hash_bytes: &[u8; 32] = &slot_hash;

    // CRIT-1 FIX: derive per-mint seed using secret + slot_hash + mint_index
    // This ensures each NFT in a batch gets different traits
    // CRIT-3 PARTIAL FIX: slot_hash is mixed in after commit so oracle
    // cannot predict traits at commit time. Oracle can still time reveal
    // but cannot brute-force the commitment.
    let machine = &mut ctx.accounts.machine;
    let quantity = ctx.accounts.mint_request.quantity;

    // Forward payment from MintRequest PDA to treasury
    // On last mint, forward ALL remaining lamports (avoids rounding dust from dynamic pricing)
    let remaining_qty = ctx.accounts.mint_request.remaining_quantity;
    let mint_req_lamports = ctx.accounts.mint_request.to_account_info().lamports();
    let rent = Rent::get()?.minimum_balance(8 + MintRequest::LEN);
    let paid = if remaining_qty == 1 {
        // Last mint — sweep everything above rent
        let sweep = mint_req_lamports.saturating_sub(rent);
        require!(sweep > 0, GumballError::InsufficientFunds);
        sweep
    } else {
        paid_amount / ctx.accounts.mint_request.quantity as u64
    };
    // PHASE 2: split mint revenue 50/40/10 → treasury / NFT pool / LP pool
    let to_nft = paid.checked_mul(FEE_NFT_BPS_MINT).ok_or(GumballError::MathOverflow)? / 10_000;
    let to_lp  = paid.checked_mul(FEE_LP_BPS_MINT).ok_or(GumballError::MathOverflow)?  / 10_000;
    let to_treasury = paid.checked_sub(to_nft).ok_or(GumballError::MathOverflow)?
        .checked_sub(to_lp).ok_or(GumballError::MathOverflow)?;
    **ctx.accounts.mint_request.to_account_info().try_borrow_mut_lamports()? -= paid;
    **ctx.accounts.treasury.try_borrow_mut_lamports()? += to_treasury;
    **ctx.accounts.nft_xnt_pool.to_account_info().try_borrow_mut_lamports()? += to_nft;
    **ctx.accounts.lp_xnt_pool.to_account_info().try_borrow_mut_lamports()? += to_lp;
    emit!(XntFeeDistributedEvent {
        source: 0, treasury: to_treasury, nft_pool: to_nft, lp_pool: to_lp,
    });

    // Mint one NFT (quantity tracked in MintRequest, oracle calls this once per NFT)
    // CRIT-1 NOTE: Full quantity loop requires remaining_accounts pattern.
    // For now mint index 0; oracle must call reveal_and_mint once per quantity.
    // Use remaining_quantity as mint index so each NFT in batch gets unique traits
    let mint_index: u8 = ctx.accounts.mint_request.quantity
        .saturating_sub(ctx.accounts.mint_request.remaining_quantity);
    let index_bytes = [mint_index];
    // CRIT-3 FIX: mix in user_seed — oracle cannot predict this at commit time
    // Final seed = sha256(oracle_secret || slot_hash || user_seed || mint_index)
    // Neither oracle nor user alone can manipulate the outcome
    let user_seed = &ctx.accounts.mint_request.user_seed;
    let seed_hash = hashv(&[&secret, slot_hash_bytes, user_seed, &index_bytes]);
    let seed_bytes = seed_hash.to_bytes();
    let mut seed = u64::from_le_bytes(seed_bytes[..8].try_into()
        .map_err(|_| error!(GumballError::InvalidSlotHash))?);
    // Published so verify.html can recompute sha256(secret || slot_hash || user_seed || index)
    // (GumballData has no room for the slot hash and must not change layout).
    emit!(MintSeedEvent {
        mint: ctx.accounts.nft_mint.key(),
        request_slot: ctx.accounts.mint_request.request_slot,
        seed_slot,
        slot_hash,
        mint_index,
    });

    let traits = resolve_traits(seed, machine.total_minted)?;
    // Seasonal drop: remap flavor/color into the active season's window
    // (no-op when the season PDA is uninitialized or expired)
    let traits = apply_season(traits, &ctx.accounts.season_config)?;

    let svg_bytes = generate_svg(
        machine.total_minted + 1,
        traits.flavor, traits.color, traits.rarity, traits.special,
    );

    let gumball             = &mut ctx.accounts.gumball_data;
    gumball.owner           = minter_key;
    gumball.machine         = machine.key();
    gumball.serial          = machine.total_minted + 1;
    gumball.flavor          = traits.flavor;
    gumball.color           = traits.color;
    gumball.rarity          = traits.rarity;
    gumball.special         = traits.special;
    gumball.minted_at       = clock.unix_timestamp as u64;
    gumball.bump            = ctx.bumps.gumball_data;
    // v5: store proof fields for independent verification
    gumball.commitment_hash = ctx.accounts.oracle_commit.commitment;
    gumball.user_seed       = ctx.accounts.mint_request.user_seed;
    gumball.oracle_secret   = secret;

    // Store SVG in separate PDA — keeps GumballData lean for burn instructions
    ctx.accounts.gumball_svg.svg = svg_bytes;

    machine.total_minted = machine.total_minted
        .checked_add(1).ok_or(GumballError::MathOverflow)?;

    let seeds = &[b"machine_authority".as_ref(), &[ctx.bumps.machine_authority]];
    mint_to(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint:      ctx.accounts.nft_mint.to_account_info(),
            to:        ctx.accounts.minter_ata.to_account_info(),
            authority: ctx.accounts.machine_authority.to_account_info(),
        },
        &[seeds],
    ), 1)?;

    // CRIT-1 FIX: decrement remaining, only mark fulfilled when all minted
    ctx.accounts.mint_request.remaining_quantity = ctx.accounts.mint_request
        .remaining_quantity
        .checked_sub(1)
        .ok_or(GumballError::MathOverflow)?;

    if ctx.accounts.mint_request.remaining_quantity == 0 {
        ctx.accounts.mint_request.fulfilled = true;
    }

    emit!(GumballMintedEvent {
        minter: minter_key, serial: gumball.serial,
        mint: ctx.accounts.nft_mint.key(), flavor: traits.flavor,
        color: traits.color, rarity: traits.rarity, special: traits.special,
        total_minted: machine.total_minted,
    });

    Ok(())
}

pub fn refund_mint(ctx: Context<RefundMint>) -> Result<()> {
    let clock        = Clock::get()?;
    let requested_at = ctx.accounts.mint_request.requested_at;
    let paid_amount  = ctx.accounts.mint_request.paid_amount;
    let minter_key   = ctx.accounts.mint_request.minter;

    // Only refundable after MINT_TIMEOUT has elapsed
    require!(
        clock.unix_timestamp - requested_at > MINT_TIMEOUT,
        GumballError::RequestExpired
    );
    // Must not already be fulfilled
    require!(!ctx.accounts.mint_request.fulfilled, GumballError::AlreadyFulfilled);

    // MintRequest PDA holds paid_amount + rent — return all to minter and close PDA
    let req_info = ctx.accounts.mint_request.to_account_info();
    let total = req_info.lamports();
    **req_info.try_borrow_mut_lamports()? = 0;
    **ctx.accounts.minter.try_borrow_mut_lamports()? += total;
    req_info.try_borrow_mut_data()?.fill(0);

    emit!(MintRefundedEvent { minter: minter_key, amount: paid_amount });
    Ok(())
}

pub fn refund_legacy_mint(ctx: Context<RefundLegacyMint>) -> Result<()> {
    let req_info = ctx.accounts.mint_request.to_account_info();
    require!(req_info.owner == ctx.program_id, GumballError::InvalidAccount);

    let (minter_key, paid_amount) = {
        let data = req_info.try_borrow_data()?;
        require!(data.len() == LEGACY_MINT_REQUEST_LEN, GumballError::InvalidAccount);
        require!(
            &data[0..8] == <MintRequest as anchor_lang::Discriminator>::DISCRIMINATOR,
            GumballError::InvalidAccount
        );
        let minter = Pubkey::try_from(&data[8..40])
            .map_err(|_| error!(GumballError::InvalidAccount))?;
        let commitment = Pubkey::try_from(&data[72..104])
            .map_err(|_| error!(GumballError::InvalidAccount))?;
        let (expected, _) = Pubkey::find_program_address(
            &[b"mint_request", minter.as_ref(), commitment.as_ref()],
            ctx.program_id,
        );
        require!(expected == req_info.key(), GumballError::InvalidAccount);

        let paid = u64::from_le_bytes(
            data[106..114].try_into().map_err(|_| error!(GumballError::InvalidAccount))?);
        let requested_at = i64::from_le_bytes(
            data[114..122].try_into().map_err(|_| error!(GumballError::InvalidAccount))?);
        require!(data[122] == 0, GumballError::AlreadyFulfilled);
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp.saturating_sub(requested_at) > MINT_TIMEOUT,
            GumballError::RequestExpired
        );
        (minter, paid)
    };
    require!(ctx.accounts.minter.key() == minter_key, GumballError::Unauthorized);

    let total = req_info.lamports();
    **req_info.try_borrow_mut_lamports()? = 0;
    let new_bal = ctx.accounts.minter.lamports().checked_add(total)
        .ok_or(GumballError::MathOverflow)?;
    **ctx.accounts.minter.try_borrow_mut_lamports()? = new_bal;
    req_info.try_borrow_mut_data()?.fill(0);

    emit!(MintRefundedEvent { minter: minter_key, amount: paid_amount });
    Ok(())
}
