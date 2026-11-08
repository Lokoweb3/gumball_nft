use crate::*;

#[derive(Accounts)]

pub struct BurnToUpgrade<'info> {
    #[account(mut)]
    pub burner: Signer<'info>,
    #[account(mut, seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    /// CHECK: PDA authority
    #[account(seeds = [b"machine_authority"], bump)]
    pub machine_authority: AccountInfo<'info>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    /// CHECK: manually validated in instruction body
    #[account(mut, seeds = [b"gumball", mint_a.key().as_ref()], bump)]
    pub gumball_a: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint_a: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub ata_a: Box<Account<'info, TokenAccount>>,
    /// CHECK: manually validated in instruction body
    #[account(mut, seeds = [b"gumball", mint_b.key().as_ref()], bump)]
    pub gumball_b: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub ata_b: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = burner, mint::decimals = 0, mint::authority = machine_authority, mint::freeze_authority = machine_authority)]
    pub new_mint: Box<Account<'info, Mint>>,
    #[account(init_if_needed, payer = burner, associated_token::mint = new_mint, associated_token::authority = burner)]
    pub new_ata: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = burner, space = 8 + GumballData::LEN, seeds = [b"gumball", new_mint.key().as_ref()], bump)]
    pub new_gumball_data: Box<Account<'info, GumballData>>,
    #[account(init, payer = burner, space = 8 + GumballSvg::LEN, seeds = [b"svg", new_mint.key().as_ref()], bump)]
    pub new_gumball_svg: Box<Account<'info, GumballSvg>>,
    /// CHECK: slot hashes sysvar
    #[account(address = sysvar::slot_hashes::id())]
    pub slot_hashes: AccountInfo<'info>,
    /// PHASE 2: NFT staker fee pool — receives 40% of upgrade fee
    #[account(mut, seeds = [b"nft_xnt_pool"], bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    /// PHASE 2: LP staker fee pool — receives 10% of upgrade fee
    #[account(mut, seeds = [b"lp_xnt_pool"], bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BurnMulti<'info> {
    #[account(mut)]
    pub burner: Signer<'info>,
    #[account(mut, seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    /// CHECK: PDA authority
    #[account(seeds = [b"machine_authority"], bump)]
    pub machine_authority: AccountInfo<'info>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    /// CHECK: manually validated in instruction body — owner, seeds, and rarity checked
    #[account(mut, seeds = [b"gumball", mint_a.key().as_ref()], bump)]
    pub gumball_a: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint_a: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub ata_a: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = burner, mint::decimals = 0, mint::authority = machine_authority, mint::freeze_authority = machine_authority)]
    pub new_mint: Box<Account<'info, Mint>>,
    #[account(init_if_needed, payer = burner, associated_token::mint = new_mint, associated_token::authority = burner)]
    pub new_ata: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = burner, space = 8 + GumballData::LEN, seeds = [b"gumball", new_mint.key().as_ref()], bump)]
    pub new_gumball_data: Box<Account<'info, GumballData>>,
    #[account(init, payer = burner, space = 8 + GumballSvg::LEN, seeds = [b"svg", new_mint.key().as_ref()], bump)]
    pub new_gumball_svg: Box<Account<'info, GumballSvg>>,
    /// CHECK: slot hashes sysvar
    #[account(address = sysvar::slot_hashes::id())]
    pub slot_hashes: AccountInfo<'info>,
    /// PHASE 2: NFT staker fee pool — receives 40% of upgrade fee
    #[account(mut, seeds = [b"nft_xnt_pool"], bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    /// PHASE 2: LP staker fee pool — receives 10% of upgrade fee
    #[account(mut, seeds = [b"lp_xnt_pool"], bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RerollCosmetics<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub nft_mint: Account<'info, Mint>,
    /// Caller must actually HOLD the NFT (stronger than the tracked owner
    /// field, and staked/escrowed gumballs can't be rerolled)
    #[account(
        associated_token::mint = nft_mint,
        associated_token::authority = owner,
        constraint = owner_nft_ata.amount == 1 @ GumballError::Unauthorized,
    )]
    pub owner_nft_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"gumball", nft_mint.key().as_ref()], bump = gumball_data.bump)]
    pub gumball_data: Account<'info, GumballData>,
    #[account(mut, seeds = [b"svg", nft_mint.key().as_ref()], bump)]
    pub gumball_svg: Account<'info, GumballSvg>,
    #[account(seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(mut, constraint = gum_mint.key() == stake_config.gum_mint @ GumballError::InvalidAccount)]
    pub gum_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = gum_mint, associated_token::authority = owner)]
    pub owner_gum_ata: Account<'info, TokenAccount>,
    /// CHECK: slot hashes sysvar
    #[account(address = sysvar::slot_hashes::id())]
    pub slot_hashes: AccountInfo<'info>,
    /// CHECK: SeasonConfig PDA — parsed leniently (uninitialized = no season)
    #[account(seeds = [b"season"], bump)]
    pub season_config: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn burn_to_upgrade(ctx: Context<BurnToUpgrade>, user_seed: [u8; 32]) -> Result<()> {
    let machine = &mut ctx.accounts.machine;
    let clock   = Clock::get()?;

    let mut burn_rarity: u8;
    {
        let data_a = ctx.accounts.gumball_a.try_borrow_data()?;
        let data_b = ctx.accounts.gumball_b.try_borrow_data()?;
        require!(data_a.len() > GD_RARITY_OFFSET, GumballError::InvalidAccount);
        require!(data_b.len() > GD_RARITY_OFFSET, GumballError::InvalidAccount);
        let owner_a = Pubkey::try_from(&data_a[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32])
            .map_err(|_| error!(GumballError::InvalidAccount))?;
        let owner_b = Pubkey::try_from(&data_b[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32])
            .map_err(|_| error!(GumballError::InvalidAccount))?;
        require!(owner_a == ctx.accounts.burner.key(), GumballError::Unauthorized);
        require!(owner_b == ctx.accounts.burner.key(), GumballError::Unauthorized);
        burn_rarity = data_a[GD_RARITY_OFFSET];
        require!(data_b[GD_RARITY_OFFSET] == burn_rarity, GumballError::RarityMismatch);
    }
    require!(burn_rarity < RARITY_LEGENDARY, GumballError::AlreadyLegendary);
    // Enforce correct burn count for this rarity tier
    let required = BURNS_REQUIRED[burn_rarity as usize];
    require!(required == 2, GumballError::UseMultiBurn);

    // Stop burns once max supply is reached — no new serials can be issued
    require!(machine.total_minted < machine.max_supply, GumballError::SoldOut);

    // PHASE 2: split upgrade fee 50/40/10 → treasury / NFT pool / LP pool
    let upgrade_fee = get_mint_price(machine.total_minted);
    let to_nft = upgrade_fee.checked_mul(FEE_NFT_BPS_MINT).ok_or(GumballError::MathOverflow)? / 10_000;
    let to_lp  = upgrade_fee.checked_mul(FEE_LP_BPS_MINT).ok_or(GumballError::MathOverflow)?  / 10_000;
    let to_treasury = upgrade_fee.checked_sub(to_nft).ok_or(GumballError::MathOverflow)?
        .checked_sub(to_lp).ok_or(GumballError::MathOverflow)?;
    if to_treasury > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                }), to_treasury)?;
    }
    if to_nft > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.nft_xnt_pool.to_account_info(),
                }), to_nft)?;
    }
    if to_lp > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.lp_xnt_pool.to_account_info(),
                }), to_lp)?;
    }
    emit!(XntFeeDistributedEvent {
        source: 1, treasury: to_treasury, nft_pool: to_nft, lp_pool: to_lp,
    });

    burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
        mint:      ctx.accounts.mint_a.to_account_info(),
        from:      ctx.accounts.ata_a.to_account_info(),
        authority: ctx.accounts.burner.to_account_info(),
    }), 1)?;

    burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
        mint:      ctx.accounts.mint_b.to_account_info(),
        from:      ctx.accounts.ata_b.to_account_info(),
        authority: ctx.accounts.burner.to_account_info(),
    }), 1)?;

    // Zero owner field to mark as burned
    ctx.accounts.gumball_a.try_borrow_mut_data()?[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32].fill(0);
    ctx.accounts.gumball_b.try_borrow_mut_data()?[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32].fill(0);

    let new_rarity = burn_rarity + 1;

    // Use slot hash + user seed + burn context for upgrade traits
    // User seed prevents validator grinding for specific cosmetic combos
    let slot_hash_data = &ctx.accounts.slot_hashes.data.borrow();
    let hash_bytes: [u8; 32] = slot_hash_data[16..48].try_into()
        .map_err(|_| error!(GumballError::InvalidSlotHash))?;
    let seed_hash = hashv(&[
        &hash_bytes,
        &user_seed,
        &clock.unix_timestamp.to_le_bytes(),
        &machine.total_minted.to_le_bytes(),
        &[burn_rarity],
    ]);
    let mut seed = u64::from_le_bytes(seed_hash.to_bytes()[..8].try_into()
        .map_err(|_| error!(GumballError::InvalidSlotHash))?);

    let flavor  = lcg_next(&mut seed, FLAVORS.len()  as u64) as u8;
    let color   = lcg_next(&mut seed, COLORS.len()   as u64) as u8;
    let special = lcg_next(&mut seed, SPECIALS.len() as u64) as u8;

    let svg_bytes = generate_svg(
        machine.total_minted + 1,
        flavor, color, new_rarity, special,
    );

    let auth_seeds = &[b"machine_authority".as_ref(), &[ctx.bumps.machine_authority]];
    mint_to(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint:      ctx.accounts.new_mint.to_account_info(),
            to:        ctx.accounts.new_ata.to_account_info(),
            authority: ctx.accounts.machine_authority.to_account_info(),
        },
        &[auth_seeds],
    ), 1)?;

    let ng              = &mut ctx.accounts.new_gumball_data;
    ng.owner            = ctx.accounts.burner.key();
    ng.machine          = machine.key();
    ng.serial           = machine.total_minted + 1;
    ng.flavor           = flavor;
    ng.color            = color;
    ng.rarity           = new_rarity;
    ng.special          = special;
    ng.minted_at        = clock.unix_timestamp as u64;
    ng.bump             = ctx.bumps.new_gumball_data;
    ng.commitment_hash  = [0u8; 32]; // upgrade — no commit-reveal
    ng.user_seed        = [0u8; 32];
    ng.oracle_secret    = [0u8; 32];

    ctx.accounts.new_gumball_svg.svg = svg_bytes;

    machine.total_minted = machine.total_minted
        .checked_add(1).ok_or(GumballError::MathOverflow)?;

    // Track burned supply: 2 destroyed, 1 created = net 2 burned
    machine.total_burned = machine.total_burned
        .checked_add(2).ok_or(GumballError::MathOverflow)?;

    emit!(GumballUpgradedEvent {
        burner: ctx.accounts.burner.key(), burned_rarity: burn_rarity,
        burned_count: 2u8, new_serial: ng.serial,
        new_rarity, new_mint: ctx.accounts.new_mint.key(),
        flavor, color, special,
    });

    Ok(())
}

pub fn burn_multi<'info>(ctx: Context<'_, '_, 'info, 'info, BurnMulti<'info>>, user_seed: [u8; 32]) -> Result<()> {
    let machine    = &mut ctx.accounts.machine;
    let clock      = Clock::get()?;
    // Read rarity and owner from base gumball (UncheckedAccount — no auto-deserialize)
    let burn_rarity: u8;
    {
        let data_a = ctx.accounts.gumball_a.try_borrow_data()?;
        require!(data_a.len() > GD_RARITY_OFFSET, GumballError::InvalidAccount);
        let owner_a = Pubkey::try_from(&data_a[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32])
            .map_err(|_| error!(GumballError::InvalidAccount))?;
        require!(owner_a == ctx.accounts.burner.key(), GumballError::Unauthorized);
        burn_rarity = data_a[GD_RARITY_OFFSET];
    }
    require!(burn_rarity < RARITY_LEGENDARY, GumballError::AlreadyLegendary);
    require!(machine.total_minted < machine.max_supply, GumballError::SoldOut);

    // PHASE 2: split upgrade fee 50/40/10 → treasury / NFT pool / LP pool
    let upgrade_fee = get_mint_price(machine.total_minted);
    let to_nft = upgrade_fee.checked_mul(FEE_NFT_BPS_MINT).ok_or(GumballError::MathOverflow)? / 10_000;
    let to_lp  = upgrade_fee.checked_mul(FEE_LP_BPS_MINT).ok_or(GumballError::MathOverflow)?  / 10_000;
    let to_treasury = upgrade_fee.checked_sub(to_nft).ok_or(GumballError::MathOverflow)?
        .checked_sub(to_lp).ok_or(GumballError::MathOverflow)?;
    if to_treasury > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                }), to_treasury)?;
    }
    if to_nft > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.nft_xnt_pool.to_account_info(),
                }), to_nft)?;
    }
    if to_lp > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.lp_xnt_pool.to_account_info(),
                }), to_lp)?;
    }
    emit!(XntFeeDistributedEvent {
        source: 1, treasury: to_treasury, nft_pool: to_nft, lp_pool: to_lp,
    });

    let required = BURNS_REQUIRED[burn_rarity as usize] as usize;
    // remaining_accounts must be triples: (mint, ata, gumball_pda) for each extra burn
    let extra = required - 1;
    require!(
        ctx.remaining_accounts.len() == extra * 3,
        GumballError::WrongBurnCount
    );

    // Burn base gumball
    burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
        mint:      ctx.accounts.mint_a.to_account_info(),
        from:      ctx.accounts.ata_a.to_account_info(),
        authority: ctx.accounts.burner.to_account_info(),
    }), 1)?;

    // Zero owner field to mark as burned
    ctx.accounts.gumball_a.try_borrow_mut_data()?[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32].fill(0);

    // Burn remaining gumballs from remaining_accounts
    for i in 0..extra {
        let mint_ai    = &ctx.remaining_accounts[i * 3];
        let ata_ai     = &ctx.remaining_accounts[i * 3 + 1];
        let gumball_ai = &ctx.remaining_accounts[i * 3 + 2];

        // Verify gumball PDA seeds
        let (expected_pda, _) = Pubkey::find_program_address(
            &[b"gumball", mint_ai.key.as_ref()],
            ctx.program_id,
        );
        require!(expected_pda == *gumball_ai.key, GumballError::Unauthorized);

        // Verify same rarity and owner
        let gumball_data = gumball_ai.try_borrow_data()?;
        require!(gumball_data.len() > GD_RARITY_OFFSET, GumballError::InvalidAccount);
        require!(gumball_data[GD_RARITY_OFFSET] == burn_rarity, GumballError::RarityMismatch);

        let owner_bytes: [u8; 32] = gumball_data[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32].try_into()
            .map_err(|_| error!(GumballError::InvalidAccount))?;
        let owner_pubkey = Pubkey::from(owner_bytes);
        require!(owner_pubkey == ctx.accounts.burner.key(), GumballError::Unauthorized);
        drop(gumball_data);

        // Burn token
        burn(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint:      mint_ai.to_account_info(),
                from:      ata_ai.to_account_info(),
                authority: ctx.accounts.burner.to_account_info(),
            },
        ), 1)?;

        // Zero owner field to mark as burned (can't move lamports from
        // remaining_accounts — causes UnbalancedInstruction).
        let mut gb_data = gumball_ai.try_borrow_mut_data()?;
        gb_data[GD_OWNER_OFFSET..GD_OWNER_OFFSET+32].fill(0); // zero owner field
    }

    let new_rarity = burn_rarity + 1;

    // Derive seed for upgraded NFT traits — user_seed prevents validator grinding
    let slot_hash_data = &ctx.accounts.slot_hashes.data.borrow();
    let hash_bytes: [u8; 32] = slot_hash_data[16..48].try_into()
        .map_err(|_| error!(GumballError::InvalidSlotHash))?;
    let seed_hash = anchor_lang::solana_program::hash::hashv(&[
        &hash_bytes,
        &user_seed,
        &clock.unix_timestamp.to_le_bytes(),
        &machine.total_minted.to_le_bytes(),
        &[burn_rarity],
    ]);
    let mut seed = u64::from_le_bytes(seed_hash.to_bytes()[..8].try_into()
        .map_err(|_| error!(GumballError::InvalidSlotHash))?);

    let flavor  = lcg_next(&mut seed, FLAVORS.len()  as u64) as u8;
    let color   = lcg_next(&mut seed, COLORS.len()   as u64) as u8;
    let special = lcg_next(&mut seed, SPECIALS.len() as u64) as u8;

    let svg_bytes = generate_svg(machine.total_minted + 1, flavor, color, new_rarity, special);

    let auth_seeds = &[b"machine_authority".as_ref(), &[ctx.bumps.machine_authority]];
    mint_to(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint:      ctx.accounts.new_mint.to_account_info(),
            to:        ctx.accounts.new_ata.to_account_info(),
            authority: ctx.accounts.machine_authority.to_account_info(),
        },
        &[auth_seeds],
    ), 1)?;

    let ng              = &mut ctx.accounts.new_gumball_data;
    ng.owner            = ctx.accounts.burner.key();
    ng.machine          = machine.key();
    ng.serial           = machine.total_minted + 1;
    ng.flavor           = flavor;
    ng.color            = color;
    ng.rarity           = new_rarity;
    ng.special          = special;
    ng.minted_at        = clock.unix_timestamp as u64;
    ng.bump             = ctx.bumps.new_gumball_data;
    ng.commitment_hash  = [0u8; 32]; // upgrade — no commit-reveal
    ng.user_seed        = [0u8; 32];
    ng.oracle_secret    = [0u8; 32];

    ctx.accounts.new_gumball_svg.svg = svg_bytes;

    machine.total_minted = machine.total_minted
        .checked_add(1).ok_or(GumballError::MathOverflow)?;

    // Track burned supply: required destroyed, 1 created = net `required` burned
    machine.total_burned = machine.total_burned
        .checked_add(required as u64).ok_or(GumballError::MathOverflow)?;

    emit!(GumballUpgradedEvent {
        burner: ctx.accounts.burner.key(), burned_rarity: burn_rarity,
        burned_count: required as u8, new_serial: ng.serial,
        new_rarity, new_mint: ctx.accounts.new_mint.key(),
        flavor, color, special,
    });

    Ok(())
}

pub fn reroll_cosmetics(ctx: Context<RerollCosmetics>, user_seed: [u8; 32]) -> Result<()> {
    anchor_spl::token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint:      ctx.accounts.gum_mint.to_account_info(),
                from:      ctx.accounts.owner_gum_ata.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        REROLL_COST_GUM,
    )?;

    let serial = ctx.accounts.gumball_data.serial;
    let rarity = ctx.accounts.gumball_data.rarity; // NEVER rerolled

    let clock = Clock::get()?;
    let slot_hash_data = &ctx.accounts.slot_hashes.data.borrow();
    let hash_bytes: [u8; 32] = slot_hash_data[16..48].try_into()
        .map_err(|_| error!(GumballError::InvalidSlotHash))?;
    let seed_hash = hashv(&[
        &hash_bytes,
        &user_seed,
        &clock.unix_timestamp.to_le_bytes(),
        &serial.to_le_bytes(),
    ]);
    let mut seed = u64::from_le_bytes(seed_hash.to_bytes()[..8].try_into()
        .map_err(|_| error!(GumballError::InvalidSlotHash))?);

    let flavor  = lcg_next(&mut seed, FLAVORS.len()  as u64) as u8;
    let color   = lcg_next(&mut seed, COLORS.len()   as u64) as u8;
    let special = lcg_next(&mut seed, SPECIALS.len() as u64) as u8;
    let t = apply_season(
        Traits { flavor, color, rarity, special },
        &ctx.accounts.season_config,
    )?;

    let svg_bytes = generate_svg(serial, t.flavor, t.color, rarity, t.special);
    let gd = &mut ctx.accounts.gumball_data;
    gd.flavor  = t.flavor;
    gd.color   = t.color;
    gd.special = t.special;
    // The ATA constraint proved the caller holds the token — sync the
    // tracked owner too (same effect as update_owner)
    gd.owner   = ctx.accounts.owner.key();
    ctx.accounts.gumball_svg.svg = svg_bytes;

    emit!(CosmeticsRerolledEvent {
        owner: ctx.accounts.owner.key(),
        nft_mint: ctx.accounts.nft_mint.key(),
        flavor: t.flavor, color: t.color, special: t.special,
    });
    Ok(())
}
