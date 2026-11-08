use crate::*;

// ─── Staking Accounts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeStaking<'info> {
    /// HIGH-2 FIX: only the Machine.authority (the legitimate admin who deployed
    /// the program and initialized the Machine PDA) can initialize staking.
    /// Without this check, any wallet could front-run the admin and seize control
    /// of stake_config.authority — bricking the staking deploy permanently.
    #[account(mut, address = machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(
        init, payer = authority, space = 8 + StakeConfig::LEN,
        seeds = [b"stake_config_v2"], bump,
    )]
    pub stake_config: Account<'info, StakeConfig>,
    /// The (already-existing, fixed-supply) GUM mint. Authority should be revoked
    /// before initialization — admin must transfer GUM into the vaults out-of-band.
    pub gum_mint: Account<'info, Mint>,
    /// Reward vault for NFT stakers — PDA-owned token account (admin funds via SPL transfer).
    #[account(
        init, payer = authority,
        token::mint = gum_mint,
        token::authority = stake_config,
        seeds = [b"nft_reward_vault"], bump,
    )]
    pub nft_reward_vault: Account<'info, TokenAccount>,
    /// Reward vault for LP stakers — PDA-owned token account (admin funds via SPL transfer).
    #[account(
        init, payer = authority,
        token::mint = gum_mint,
        token::authority = stake_config,
        seeds = [b"lp_reward_vault"], bump,
    )]
    pub lp_reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct StakeNft<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(
        init, payer = staker, space = 8 + StakeAccount::LEN,
        seeds = [b"stake_v2",nft_mint.key().as_ref()], bump,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,
    /// The gumball data PDA — used to read rarity
    #[account(seeds = [b"gumball", nft_mint.key().as_ref()], bump = gumball_data.bump)]
    pub gumball_data: Box<Account<'info, GumballData>>,
    pub nft_mint: Box<Account<'info, Mint>>,
    /// User's NFT token account (source)
    #[account(mut, constraint = user_ata.mint == nft_mint.key() && user_ata.owner == staker.key())]
    pub user_ata: Box<Account<'info, TokenAccount>>,
    /// Vault token account (destination) — owned by stake_config PDA
    #[account(
        init_if_needed, payer = staker,
        associated_token::mint = nft_mint,
        associated_token::authority = stake_config,
    )]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    /// NFT reward vault — read for accumulator update (vault_balance term)
    #[account(seeds = [b"nft_reward_vault"], bump,
              constraint = nft_reward_vault.key() == stake_config.nft_reward_vault @ GumballError::InvalidAccount)]
    pub nft_reward_vault: Box<Account<'info, TokenAccount>>,
    /// HIGH-1 FIX: XNT fee state — accumulator must advance before total_nft_weight changes.
    #[account(mut, seeds = [b"xnt_fee_state_nft"], bump = nft_xnt_state.bump)]
    pub nft_xnt_state: Box<Account<'info, XntFeeState>>,
    /// HIGH-1 FIX: XNT fee pool — lamports are only READ here (accumulator
    /// update); no mut, so stakes don't write-lock the shared pool.
    #[account(seeds = [b"nft_xnt_pool"], bump = nft_xnt_pool.bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    /// CRIT-3 FIX: per-position XNT debt initialized at stake-time so historical
    /// accumulator value is NOT credited to this position on first claim.
    /// init_if_needed: the PDA may survive from an unstake under the previous
    /// deploy (which didn't close it) — we overwrite it either way.
    #[account(init_if_needed, payer = staker, space = 8 + XntDebt::LEN,
              seeds = [b"xnt_debt_nft", nft_mint.key().as_ref()], bump)]
    pub xnt_debt: Box<Account<'info, XntDebt>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        mut,
        seeds = [b"stake_v2",stake_account.nft_mint.as_ref()], bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ GumballError::Unauthorized,
    )]
    pub stake_account: Account<'info, StakeAccount>,
    /// The fixed-supply GUM mint — must match what's stored in stake_config
    #[account(constraint = gum_mint.key() == stake_config.gum_mint @ GumballError::InvalidAccount)]
    pub gum_mint: Account<'info, Mint>,
    /// NFT reward vault — transfer source
    #[account(mut, seeds = [b"nft_reward_vault"], bump,
              constraint = nft_reward_vault.key() == stake_config.nft_reward_vault @ GumballError::InvalidAccount)]
    pub nft_reward_vault: Account<'info, TokenAccount>,
    /// Staker's GUM token account (destination)
    #[account(
        init_if_needed, payer = staker,
        associated_token::mint = gum_mint,
        associated_token::authority = staker,
    )]
    pub staker_gum_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(
        mut, close = staker,
        // B1 FIX: seed from the nft_mint ACCOUNT (as StakeNft does), not from the
        // stake account's own field. vault_ata / user_ata / xnt_debt all derive
        // from nft_mint, so the two must be bound or a caller could pair their
        // own StakeAccount with someone else's staked NFT.
        seeds = [b"stake_v2",nft_mint.key().as_ref()], bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ GumballError::Unauthorized,
        constraint = stake_account.nft_mint == nft_mint.key() @ GumballError::InvalidAccount,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,
    pub nft_mint: Box<Account<'info, Mint>>,
    /// Vault token account holding the staked NFT
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = stake_config,
    )]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    /// User's NFT token account (destination)
    #[account(
        init_if_needed, payer = staker,
        associated_token::mint = nft_mint,
        associated_token::authority = staker,
    )]
    pub user_ata: Box<Account<'info, TokenAccount>>,
    /// The fixed-supply GUM mint
    #[account(constraint = gum_mint.key() == stake_config.gum_mint @ GumballError::InvalidAccount)]
    pub gum_mint: Box<Account<'info, Mint>>,
    /// NFT reward vault — final reward source
    #[account(mut, seeds = [b"nft_reward_vault"], bump,
              constraint = nft_reward_vault.key() == stake_config.nft_reward_vault @ GumballError::InvalidAccount)]
    pub nft_reward_vault: Box<Account<'info, TokenAccount>>,
    /// Staker's GUM token account for final rewards
    #[account(
        init_if_needed, payer = staker,
        associated_token::mint = gum_mint,
        associated_token::authority = staker,
    )]
    pub staker_gum_ata: Box<Account<'info, TokenAccount>>,
    /// HIGH-1 FIX: XNT fee state — accumulator must advance before total_nft_weight shrinks.
    #[account(mut, seeds = [b"xnt_fee_state_nft"], bump = nft_xnt_state.bump)]
    pub nft_xnt_state: Box<Account<'info, XntFeeState>>,
    /// XNT pool — settles any pending XNT to the staker on unstake, then we update last_seen.
    #[account(mut, seeds = [b"nft_xnt_pool"], bump = nft_xnt_pool.bump)]
    pub nft_xnt_pool: Box<Account<'info, XntPool>>,
    /// XntDebt is settled then CLOSED on unstake (rent back to staker);
    /// init_if_needed covers legacy positions that never had one.
    #[account(init_if_needed, payer = staker, space = 8 + XntDebt::LEN,
              seeds = [b"xnt_debt_nft", nft_mint.key().as_ref()], bump)]
    pub xnt_debt: Box<Account<'info, XntDebt>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ─── Legacy Recovery Account Context ────────────────────────────────────────

#[derive(Accounts)]
pub struct RecoverLegacyV1Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: v1 StakeConfig PDA — bump read manually from raw bytes
    #[account(seeds = [b"stake_config"], bump)]
    pub legacy_stake_config: AccountInfo<'info>,
    /// CHECK: v1 StakeAccount — raw bytes parsed in body, owner validated
    #[account(mut, seeds = [b"stake", nft_mint.key().as_ref()], bump)]
    pub legacy_stake_account: AccountInfo<'info>,
    pub nft_mint: Account<'info, Mint>,
    /// v1 vault ATA — owned by legacy_stake_config, holds the staked NFT
    #[account(mut,
              associated_token::mint = nft_mint,
              associated_token::authority = legacy_stake_config)]
    pub legacy_vault_ata: Account<'info, TokenAccount>,
    /// User's NFT destination — created if missing
    #[account(init_if_needed, payer = user,
              associated_token::mint = nft_mint,
              associated_token::authority = user)]
    pub user_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_staking(ctx: Context<InitializeStaking>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.stake_config;
    config.authority                 = ctx.accounts.authority.key();
    config.gum_mint                  = ctx.accounts.gum_mint.key();
    config.nft_reward_vault          = ctx.accounts.nft_reward_vault.key();
    config.lp_reward_vault           = ctx.accounts.lp_reward_vault.key();
    config.total_staked              = 0;
    config.total_claimed             = 0;
    config.total_nft_weight          = 0;
    config.total_lp_weight           = 0;
    config.acc_nft_reward_per_weight = 0;
    config.acc_lp_reward_per_weight  = 0;
    config.last_nft_emission_update  = now;
    config.last_lp_emission_update   = now;
    config.bump                      = ctx.bumps.stake_config;
    Ok(())
}

pub fn stake(ctx: Context<StakeNft>) -> Result<()> {
    let rarity = ctx.accounts.gumball_data.rarity;
    require!(rarity <= RARITY_LEGENDARY, GumballError::InvalidAccount);

    let now = Clock::get()?.unix_timestamp;
    // Phase 3: rarity weight boosted by the early-mint bonus (see stake_weight)
    let weight = stake_weight(rarity, ctx.accounts.gumball_data.serial);

    // Update GUM accumulator BEFORE adding new weight — new staker
    // shouldn't earn rewards from time before they joined.
    update_nft_accumulator(
        &mut ctx.accounts.stake_config,
        ctx.accounts.nft_reward_vault.amount,
        now,
    )?;

    // HIGH-1 FIX: advance XNT fee accumulator using OLD total_weight so that
    // fees deposited before this stake are credited to existing stakers,
    // not diluted across the new weight. Zero-weight absorb semantics are
    // documented on the helper; absorbed surplus is recoverable to treasury
    // via sweep_xnt_pool_nft.
    let xnt_pool_balance = ctx.accounts.nft_xnt_pool.to_account_info().lamports();
    advance_xnt_for_stake(
        &mut ctx.accounts.nft_xnt_state,
        xnt_pool_balance,
        ctx.accounts.stake_config.total_nft_weight,
    )?;

    // Transfer NFT to vault
    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.user_ata.to_account_info(),
                to:        ctx.accounts.vault_ata.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        ),
        1,
    )?;

    let acc      = ctx.accounts.stake_config.acc_nft_reward_per_weight;
    let xnt_acc  = ctx.accounts.nft_xnt_state.acc_xnt_per_weight;
    let stake = &mut ctx.accounts.stake_account;
    stake.owner        = ctx.accounts.staker.key();
    stake.nft_mint     = ctx.accounts.nft_mint.key();
    stake.rarity       = rarity;
    stake.weight       = weight;
    stake.staked_at    = now;
    stake.last_claimed = now;
    // Snapshot GUM accumulator at stake-time so user only earns going forward.
    stake.reward_debt  = (weight as u128)
        .checked_mul(acc).ok_or(GumballError::MathOverflow)?
        / ACC_SCALE;
    stake.bump         = ctx.bumps.stake_account;

    // CRIT-3 FIX: snapshot XNT accumulator into xnt_debt at stake-time so this
    // position cannot capture fees deposited before it joined. (Re-init is OK
    // because init_if_needed re-uses the existing PDA; we just overwrite.)
    let xnt_debt = &mut ctx.accounts.xnt_debt;
    xnt_debt.debt = (weight as u128)
        .checked_mul(xnt_acc).ok_or(GumballError::MathOverflow)?
        / ACC_SCALE;
    xnt_debt.bump = ctx.bumps.xnt_debt;

    ctx.accounts.stake_config.total_nft_weight = ctx.accounts.stake_config.total_nft_weight
        .checked_add(weight as u128).ok_or(GumballError::MathOverflow)?;
    ctx.accounts.stake_config.total_staked = ctx.accounts.stake_config.total_staked
        .checked_add(1).ok_or(GumballError::MathOverflow)?;

    emit!(NftStakedEvent {
        staker: stake.owner, nft_mint: stake.nft_mint, rarity,
    });
    Ok(())
}

pub fn claim(ctx: Context<ClaimRewards>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    update_nft_accumulator(
        &mut ctx.accounts.stake_config,
        ctx.accounts.nft_reward_vault.amount,
        now,
    )?;

    let weight = ctx.accounts.stake_account.weight as u128;
    let acc = ctx.accounts.stake_config.acc_nft_reward_per_weight;
    let entitled = weight.checked_mul(acc).ok_or(GumballError::MathOverflow)? / ACC_SCALE;
    let reward = entitled.saturating_sub(ctx.accounts.stake_account.reward_debt);

    if reward == 0 {
        ctx.accounts.stake_account.last_claimed = now;
        return Ok(());
    }

    // Cap to vault balance — accumulator may overshoot if vault drained
    let vault_balance = ctx.accounts.nft_reward_vault.amount as u128;
    let to_pay_u64 = reward.min(vault_balance) as u64;
    require!(to_pay_u64 > 0, GumballError::GumSupplyExhausted);

    let bump = ctx.accounts.stake_config.bump;
    let seeds = &[b"stake_config_v2".as_ref(), &[bump]];
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.nft_reward_vault.to_account_info(),
                to:        ctx.accounts.staker_gum_ata.to_account_info(),
                authority: ctx.accounts.stake_config.to_account_info(),
            },
            &[seeds],
        ),
        to_pay_u64,
    )?;

    ctx.accounts.stake_account.reward_debt = entitled;
    ctx.accounts.stake_account.last_claimed = now;
    ctx.accounts.stake_config.total_claimed = ctx.accounts.stake_config.total_claimed
        .checked_add(to_pay_u64).ok_or(GumballError::MathOverflow)?;

    let staker = ctx.accounts.stake_account.owner;
    let nft_mint = ctx.accounts.stake_account.nft_mint;
    emit!(RewardsClaimedEvent { staker, nft_mint, amount: to_pay_u64 });
    Ok(())
}

pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    update_nft_accumulator(
        &mut ctx.accounts.stake_config,
        ctx.accounts.nft_reward_vault.amount,
        now,
    )?;

    // HIGH-1 FIX: advance XNT accumulator BEFORE removing weight so existing
    // stakers get their fair share of fees deposited up to this moment.
    let xnt_pool_balance = ctx.accounts.nft_xnt_pool.to_account_info().lamports();
    update_xnt_accumulator(
        &mut ctx.accounts.nft_xnt_state,
        xnt_pool_balance,
        ctx.accounts.stake_config.total_nft_weight,
    )?;

    let weight = ctx.accounts.stake_account.weight as u128;
    let acc = ctx.accounts.stake_config.acc_nft_reward_per_weight;
    let entitled = weight.checked_mul(acc).ok_or(GumballError::MathOverflow)? / ACC_SCALE;
    let reward = entitled.saturating_sub(ctx.accounts.stake_account.reward_debt);
    let staker_key = ctx.accounts.stake_account.owner;
    let nft_mint_key = ctx.accounts.stake_account.nft_mint;

    let bump = ctx.accounts.stake_config.bump;
    let seeds = &[b"stake_config_v2".as_ref(), &[bump]];

    let mut paid: u64 = 0;
    if reward > 0 {
        let vault_balance = ctx.accounts.nft_reward_vault.amount as u128;
        paid = reward.min(vault_balance) as u64;
        if paid > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from:      ctx.accounts.nft_reward_vault.to_account_info(),
                        to:        ctx.accounts.staker_gum_ata.to_account_info(),
                        authority: ctx.accounts.stake_config.to_account_info(),
                    },
                    &[seeds],
                ),
                paid,
            )?;
            ctx.accounts.stake_config.total_claimed = ctx.accounts.stake_config.total_claimed
                .checked_add(paid).ok_or(GumballError::MathOverflow)?;
        }
    }

    // Settle pending XNT fee share to the staker (pays what the pool can
    // cover; first-touch guard inside the helper), then close the XntDebt
    // PDA — stake() re-creates and re-snapshots it on any re-stake, so
    // keeping it open would only strand its rent with the position gone.
    {
        let pool_info   = ctx.accounts.nft_xnt_pool.to_account_info();
        let staker_info = ctx.accounts.staker.to_account_info();
        settle_xnt_fees(
            &mut ctx.accounts.nft_xnt_state,
            &pool_info,
            &staker_info,
            &mut ctx.accounts.xnt_debt,
            weight,
            ctx.bumps.xnt_debt,
        )?;
        close_xnt_debt(&ctx.accounts.xnt_debt.to_account_info(), &staker_info)?;
    }

    // Return NFT from vault to staker
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.vault_ata.to_account_info(),
                to:        ctx.accounts.user_ata.to_account_info(),
                authority: ctx.accounts.stake_config.to_account_info(),
            },
            &[seeds],
        ),
        1,
    )?;

    // MED-3: use checked_sub instead of saturating_sub so accounting drift
    // fails loudly rather than silently corrupting state.
    ctx.accounts.stake_config.total_nft_weight = ctx.accounts.stake_config.total_nft_weight
        .checked_sub(weight).ok_or(GumballError::MathOverflow)?;
    ctx.accounts.stake_config.total_staked = ctx.accounts.stake_config.total_staked.saturating_sub(1);

    emit!(NftUnstakedEvent { staker: staker_key, nft_mint: nft_mint_key, reward: paid });
    // StakeAccount closed via `close = staker` in accounts struct
    Ok(())
}

pub fn recover_legacy_v1_stake(ctx: Context<RecoverLegacyV1Stake>) -> Result<()> {
    // v1 StakeAccount layout: disc(8) owner(32) nft_mint(32) rarity(1)
    //                         staked_at(8) last_claimed(8) bump(1) = 90 bytes
    let stake_info = ctx.accounts.legacy_stake_account.to_account_info();
    let data = stake_info.try_borrow_data()?;
    require!(data.len() == 90, GumballError::InvalidAccount);

    let owner = Pubkey::try_from(&data[8..40])
        .map_err(|_| error!(GumballError::InvalidAccount))?;
    let nft_mint = Pubkey::try_from(&data[40..72])
        .map_err(|_| error!(GumballError::InvalidAccount))?;
    require!(owner == ctx.accounts.user.key(), GumballError::Unauthorized);
    require!(nft_mint == ctx.accounts.nft_mint.key(), GumballError::InvalidAccount);
    drop(data);

    // v1 StakeConfig layout: disc(8) authority(32) gum_mint(32)
    //                        total_staked(8) total_claimed(8) bump(1) = 89 bytes
    let config_data = ctx.accounts.legacy_stake_config.try_borrow_data()?;
    require!(config_data.len() == 89, GumballError::InvalidAccount);
    let config_bump = config_data[88];
    drop(config_data);

    // Transfer NFT from v1 vault back to the user
    let seeds = &[b"stake_config".as_ref(), &[config_bump]];
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.legacy_vault_ata.to_account_info(),
                to:        ctx.accounts.user_ata.to_account_info(),
                authority: ctx.accounts.legacy_stake_config.to_account_info(),
            },
            &[seeds],
        ),
        1,
    )?;

    // Close the v1 StakeAccount — zero data + return rent to user
    let user_info = ctx.accounts.user.to_account_info();
    let lamports = stake_info.lamports();
    **user_info.try_borrow_mut_lamports()? += lamports;
    **stake_info.try_borrow_mut_lamports()? = 0;
    stake_info.try_borrow_mut_data()?.fill(0);

    Ok(())
}
