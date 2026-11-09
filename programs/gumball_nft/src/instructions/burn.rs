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

    let gd = &mut ctx.accounts.gumball_data;
    gd.flavor  = t.flavor;
    gd.color   = t.color;
    gd.special = t.special;
    // The ATA constraint proved the caller holds the token — sync the
    // tracked owner too (same effect as update_owner)
    gd.owner   = ctx.accounts.owner.key();

    emit!(CosmeticsRerolledEvent {
        owner: ctx.accounts.owner.key(),
        nft_mint: ctx.accounts.nft_mint.key(),
        flavor: t.flavor, color: t.color, special: t.special,
    });
    Ok(())
}

/// Permissionless cleanup of ONE burned ball: closes its GumballData (and, for legacy balls
/// minted before the artwork moved off chain, its GumballSvg) and sends ALL their lamports to `machine.treasury` (never to
/// the caller: the oracle or the burner paid that rent, not the caller, and a
/// refund to the burner would pay users to mint-and-burn). Takes no signer
/// account of its own, so anyone (a bot, the site, the owner) can send it.
///
/// GumballData is read raw (UncheckedAccount) so legacy, shorter layouts work.
#[derive(Accounts)]
pub struct CloseBurned<'info> {
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    /// CHECK: PDA authority — only compared against the mint's mint_authority
    #[account(seeds = [b"machine_authority"], bump)]
    pub machine_authority: AccountInfo<'info>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    /// Classic SPL mint (Account<Mint> enforces the token program as owner)
    pub nft_mint: Account<'info, Mint>,
    /// CHECK: owner, discriminator, burned marker and machine checked in the body
    #[account(mut, seeds = [b"gumball", nft_mint.key().as_ref()], bump)]
    pub gumball_data: UncheckedAccount<'info>,
    /// CHECK: owner and discriminator checked in the body
    #[account(mut, seeds = [b"svg", nft_mint.key().as_ref()], bump)]
    pub gumball_svg: UncheckedAccount<'info>,
}

/// Move every lamport of a program-owned account to `dest` and make it unrevivable
/// (assign to the system program, zero-size the data). Mirrors Anchor's close.
fn close_to<'info>(info: &AccountInfo<'info>, dest: &AccountInfo<'info>) -> Result<()> {
    let moved = info.lamports();
    **dest.try_borrow_mut_lamports()? = dest.lamports().checked_add(moved).ok_or(GumballError::MathOverflow)?;
    **info.try_borrow_mut_lamports()? = 0;
    info.assign(&System::id());
    info.resize(0)?;
    Ok(())
}

pub fn close_burned(ctx: Context<CloseBurned>) -> Result<()> {
    let mint = &ctx.accounts.nft_mint;
    // The token is burned, and this is a gumball mint (minted by this program)
    require!(mint.supply == 0, GumballError::NotBurned);
    require!(
        mint.mint_authority.contains(&ctx.accounts.machine_authority.key()),
        GumballError::NotGumballMint
    );

    {
        let gd = &ctx.accounts.gumball_data;
        require!(gd.owner == ctx.program_id, GumballError::InvalidAccount);
        let data = gd.try_borrow_data()?;
        // disc(8) + owner(32) + machine(32); legacy layouts are shorter than 189 bytes
        require!(data.len() >= GD_MACHINE_OFFSET + 32, GumballError::InvalidAccount);
        require!(data[..8] == *GumballData::DISCRIMINATOR, GumballError::InvalidAccount);
        require!(
            data[GD_MACHINE_OFFSET..GD_MACHINE_OFFSET + 32] == *ctx.accounts.machine.key().as_ref(),
            GumballError::InvalidAccount
        );
        // burn_to_upgrade / burn_multi zero the owner field
        require!(
            data[GD_OWNER_OFFSET..GD_OWNER_OFFSET + 32].iter().all(|b| *b == 0),
            GumballError::NotBurned
        );
    }
    // The svg PDA exists only for LEGACY balls (new balls never create it). Three states:
    //   program-owned + GumballSvg discriminator -> legacy, close it too
    //   system-owned + empty data                -> new ball (or already closed): leave it alone
    //   anything else (foreign owner, wrong discriminator) -> refuse
    // The address is seed-checked, so a legacy ball's real svg PDA cannot be swapped for an empty
    // one. The GumballData checks above never depend on this branch. Lamports sitting on an empty
    // system-owned address are NOT ours (the program cannot debit them, and moving them is not our
    // call): they are ignored, so a donation can neither block the close nor be swept.
    let close_svg = {
        let svg = &ctx.accounts.gumball_svg;
        if svg.owner == ctx.program_id {
            let data = svg.try_borrow_data()?;
            require!(data.len() >= 8 && data[..8] == *GumballSvg::DISCRIMINATOR, GumballError::InvalidAccount);
            true
        } else {
            require!(*svg.owner == System::id() && svg.data_is_empty(), GumballError::InvalidAccount);
            false
        }
    };

    let mut lamports = ctx.accounts.gumball_data.lamports();
    if close_svg {
        lamports = lamports
            .checked_add(ctx.accounts.gumball_svg.lamports())
            .ok_or(GumballError::MathOverflow)?;
    }
    let treasury = ctx.accounts.treasury.to_account_info();
    // Same steps as Anchor `close = treasury`: every lamport moves, owner becomes the system program, data is zero-sized
    close_to(&ctx.accounts.gumball_data.to_account_info(), &treasury)?;
    if close_svg {
        close_to(&ctx.accounts.gumball_svg.to_account_info(), &treasury)?;
    }

    emit!(BurnedClosedEvent { nft_mint: ctx.accounts.nft_mint.key(), lamports });
    Ok(())
}
