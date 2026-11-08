use crate::*;

// ─── LP Staking Accounts (NFT Position) ─────────────────────────────────────

#[derive(Accounts)]
pub struct StakeLp<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(
        init, payer = staker, space = 8 + LpStakeAccount::LEN,
        seeds = [b"lp_stake_v2",position_mint.key().as_ref()], bump,
    )]
    pub lp_stake_account: Box<Account<'info, LpStakeAccount>>,
    /// Position NFT mint — created fresh for each new position
    #[account(init, payer = staker, mint::decimals = 0, mint::authority = stake_config, mint::freeze_authority = stake_config)]
    pub position_mint: Box<Account<'info, Mint>>,
    /// Position NFT ATA for the staker
    #[account(init_if_needed, payer = staker, associated_token::mint = position_mint, associated_token::authority = staker)]
    pub position_ata: Box<Account<'info, TokenAccount>>,
    /// B3 FIX: only the LP mint registered via set_lp_mint may be staked.
    #[account(constraint = lp_mint.key() == lp_mint_config.lp_mint @ GumballError::InvalidLpMint)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = user_lp_ata.mint == lp_mint.key() && user_lp_ata.owner == staker.key())]
    pub user_lp_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = staker, associated_token::mint = lp_mint, associated_token::authority = stake_config)]
    pub vault_lp_ata: Box<Account<'info, TokenAccount>>,
    /// LP reward vault — read for accumulator update
    #[account(seeds = [b"lp_reward_vault"], bump,
              constraint = lp_reward_vault.key() == stake_config.lp_reward_vault @ GumballError::InvalidAccount)]
    pub lp_reward_vault: Box<Account<'info, TokenAccount>>,
    /// HIGH-1 FIX: XNT fee state for LP — accumulator must advance before total_lp_weight grows.
    #[account(mut, seeds = [b"xnt_fee_state_lp"], bump = lp_xnt_state.bump)]
    pub lp_xnt_state: Box<Account<'info, XntFeeState>>,
    /// HIGH-1 FIX: LP XNT pool — lamports are only READ here (accumulator
    /// update); no mut, so stakes don't write-lock the shared pool.
    #[account(seeds = [b"lp_xnt_pool"], bump = lp_xnt_pool.bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    /// CRIT-3 FIX: per-position XNT debt initialized at stake-time. Plain
    /// `init` — position_mint is a fresh keypair created in this same
    /// instruction, so this PDA can never pre-exist.
    #[account(init, payer = staker, space = 8 + XntDebt::LEN,
              seeds = [b"xnt_debt_lp", position_mint.key().as_ref()], bump)]
    pub xnt_debt: Box<Account<'info, XntDebt>>,
    /// CHECK: Metaplex metadata PDA — created by Metaplex program via CPI
    #[account(mut)]
    pub metadata_account: AccountInfo<'info>,
    /// CHECK: Metaplex Token Metadata program
    pub metadata_program: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    /// Appended LAST so existing clients only need to add one trailing account.
    #[account(seeds = [b"lp_mint_config"], bump = lp_mint_config.bump)]
    pub lp_mint_config: Box<Account<'info, LpMintConfig>>,
}

#[derive(Accounts)]
pub struct ClaimLpRewards<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut, seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(
        mut,
        seeds = [b"lp_stake_v2",lp_stake_account.position_mint.as_ref()], bump = lp_stake_account.bump,
    )]
    pub lp_stake_account: Box<Account<'info, LpStakeAccount>>,
    /// Caller must hold the position NFT — verified in instruction body
    #[account(constraint = position_ata.mint == lp_stake_account.position_mint && position_ata.owner == claimer.key())]
    pub position_ata: Box<Account<'info, TokenAccount>>,
    /// The fixed-supply GUM mint
    #[account(constraint = gum_mint.key() == stake_config.gum_mint @ GumballError::InvalidAccount)]
    pub gum_mint: Box<Account<'info, Mint>>,
    /// LP reward vault — transfer source
    #[account(mut, seeds = [b"lp_reward_vault"], bump,
              constraint = lp_reward_vault.key() == stake_config.lp_reward_vault @ GumballError::InvalidAccount)]
    pub lp_reward_vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = claimer, associated_token::mint = gum_mint, associated_token::authority = claimer)]
    pub claimer_gum_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UnstakeLp<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut, seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(
        mut,
        seeds = [b"lp_stake_v2",lp_stake_account.position_mint.as_ref()], bump = lp_stake_account.bump,
    )]
    pub lp_stake_account: Box<Account<'info, LpStakeAccount>>,
    /// Position NFT mint — burned on full withdrawal
    #[account(mut, constraint = position_mint.key() == lp_stake_account.position_mint)]
    pub position_mint: Box<Account<'info, Mint>>,
    /// Caller must hold the position NFT
    #[account(mut, constraint = position_ata.mint == lp_stake_account.position_mint && position_ata.owner == claimer.key())]
    pub position_ata: Box<Account<'info, TokenAccount>>,
    /// B2 FIX: must be the mint this position was staked with; vault_lp_ata
    /// derives from it, so an unbound mint let a junk-mint position drain the
    /// real LP vault.
    #[account(mut, constraint = lp_mint.key() == lp_stake_account.lp_mint @ GumballError::InvalidAccount)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = lp_mint, associated_token::authority = stake_config)]
    pub vault_lp_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = claimer, associated_token::mint = lp_mint, associated_token::authority = claimer)]
    pub user_lp_ata: Box<Account<'info, TokenAccount>>,
    /// The fixed-supply GUM mint
    #[account(constraint = gum_mint.key() == stake_config.gum_mint @ GumballError::InvalidAccount)]
    pub gum_mint: Box<Account<'info, Mint>>,
    /// LP reward vault — pending GUM rewards source
    #[account(mut, seeds = [b"lp_reward_vault"], bump,
              constraint = lp_reward_vault.key() == stake_config.lp_reward_vault @ GumballError::InvalidAccount)]
    pub lp_reward_vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = claimer, associated_token::mint = gum_mint, associated_token::authority = claimer)]
    pub claimer_gum_ata: Box<Account<'info, TokenAccount>>,
    /// HIGH-1 FIX: XNT fee state — accumulator must advance on weight changes.
    #[account(mut, seeds = [b"xnt_fee_state_lp"], bump = lp_xnt_state.bump)]
    pub lp_xnt_state: Box<Account<'info, XntFeeState>>,
    /// XNT pool — settles pending XNT to claimer on full unstake; HIGH-3 sync on partial.
    #[account(mut, seeds = [b"lp_xnt_pool"], bump = lp_xnt_pool.bump)]
    pub lp_xnt_pool: Box<Account<'info, XntPool>>,
    /// HIGH-3 FIX: xnt_debt is settled and re-snapshotted on partial unstake.
    #[account(init_if_needed, payer = claimer, space = 8 + XntDebt::LEN,
              seeds = [b"xnt_debt_lp", lp_stake_account.position_mint.as_ref()], bump)]
    pub xnt_debt: Box<Account<'info, XntDebt>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetLpMint<'info> {
    #[account(mut, address = stake_config.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(init_if_needed, payer = authority, space = 8 + LpMintConfig::LEN,
              seeds = [b"lp_mint_config"], bump)]
    pub lp_mint_config: Account<'info, LpMintConfig>,
    pub system_program: Program<'info, System>,
}

pub fn stake_lp(ctx: Context<StakeLp>, amount: u64, lock_tier: u8) -> Result<()> {
    require!(amount > 0, GumballError::InvalidPrice);
    require!((lock_tier as usize) < LOCK_DAYS.len(), GumballError::InvalidLockPeriod);

    let now = Clock::get()?.unix_timestamp;
    let multiplier = LOCK_MULTIPLIER_BPS[lock_tier as usize];
    let lock_days  = LOCK_DAYS[lock_tier as usize];

    // weight = amount × multiplier_bps / 100  (so multiplier=100 → 1× weight)
    let weight = (amount as u128)
        .checked_mul(multiplier as u128).ok_or(GumballError::MathOverflow)?
        / 100;

    // Update LP GUM accumulator BEFORE adding new weight
    update_lp_accumulator(
        &mut ctx.accounts.stake_config,
        ctx.accounts.lp_reward_vault.amount,
        now,
    )?;

    // HIGH-1 FIX: advance XNT accumulator using OLD total_lp_weight so existing
    // stakers get full credit for fees deposited up to this stake. Zero-weight
    // absorb semantics documented on the helper; surplus recoverable via
    // sweep_xnt_pool_lp.
    let xnt_pool_balance = ctx.accounts.lp_xnt_pool.to_account_info().lamports();
    advance_xnt_for_stake(
        &mut ctx.accounts.lp_xnt_state,
        xnt_pool_balance,
        ctx.accounts.stake_config.total_lp_weight,
    )?;

    // Transfer LP tokens to vault
    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.user_lp_ata.to_account_info(),
                to:        ctx.accounts.vault_lp_ata.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        ),
        amount,
    )?;

    // Mint position NFT to staker
    let sc_seeds = &[b"stake_config_v2".as_ref(), &[ctx.accounts.stake_config.bump]];
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint:      ctx.accounts.position_mint.to_account_info(),
                to:        ctx.accounts.position_ata.to_account_info(),
                authority: ctx.accounts.stake_config.to_account_info(),
            },
            &[sc_seeds],
        ),
        1,
    )?;

    let acc     = ctx.accounts.stake_config.acc_lp_reward_per_weight;
    let xnt_acc = ctx.accounts.lp_xnt_state.acc_xnt_per_weight;
    let lp_stake = &mut ctx.accounts.lp_stake_account;
    lp_stake.position_mint   = ctx.accounts.position_mint.key();
    lp_stake.lp_mint         = ctx.accounts.lp_mint.key();
    lp_stake.amount          = amount;
    lp_stake.staked_at       = now;
    lp_stake.last_claimed    = now;
    lp_stake.lock_until      = now + (lock_days as i64) * 86400;
    lp_stake.lock_multiplier = multiplier;
    lp_stake.lock_tier       = lock_tier;
    lp_stake.weight          = weight;
    lp_stake.reward_debt     = weight
        .checked_mul(acc).ok_or(GumballError::MathOverflow)?
        / ACC_SCALE;
    lp_stake.bump            = ctx.bumps.lp_stake_account;

    // CRIT-3 FIX: snapshot XNT debt at stake-time for this position.
    let xnt_debt = &mut ctx.accounts.xnt_debt;
    xnt_debt.debt = weight
        .checked_mul(xnt_acc).ok_or(GumballError::MathOverflow)?
        / ACC_SCALE;
    xnt_debt.bump = ctx.bumps.xnt_debt;

    ctx.accounts.stake_config.total_lp_weight = ctx.accounts.stake_config.total_lp_weight
        .checked_add(weight).ok_or(GumballError::MathOverflow)?;

    // Create Metaplex metadata for position NFT
    let mint_key = ctx.accounts.position_mint.key();
    let metadata_seeds: &[&[u8]] = &[
        b"metadata",
        METAPLEX_PROGRAM_ID.as_ref(),
        mint_key.as_ref(),
    ];
    let (metadata_pda, _) = Pubkey::find_program_address(metadata_seeds, &METAPLEX_PROGRAM_ID);

    // Build CreateMetadataAccountV3 instruction manually
    let lp_display = amount / 1_000_000_000; // LP tokens (9 decimals)
    let name = format!("GUM LP #{}", lp_display);
    let name = if name.len() > 32 { name[..32].to_string() } else { name };
    let symbol = "GUMLP".to_string();
    let uri = "".to_string(); // No off-chain metadata needed

    // Serialize CreateMetadataAccountV3 data
    let mut meta_data = vec![33u8]; // CreateMetadataAccountV3 discriminator
    // DataV2: name
    meta_data.extend_from_slice(&(name.len() as u32).to_le_bytes());
    meta_data.extend_from_slice(name.as_bytes());
    // symbol
    meta_data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
    meta_data.extend_from_slice(symbol.as_bytes());
    // uri
    meta_data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
    meta_data.extend_from_slice(uri.as_bytes());
    // seller_fee_basis_points
    meta_data.extend_from_slice(&0u16.to_le_bytes());
    // creators: None
    meta_data.push(0);
    // collection: None
    meta_data.push(0);
    // uses: None
    meta_data.push(0);
    // is_mutable
    meta_data.push(0); // false — metadata is immutable
    // collection_details: None
    meta_data.push(0);

    let meta_accounts = vec![
        AccountMeta::new(metadata_pda, false),
        AccountMeta::new_readonly(ctx.accounts.position_mint.key(), false),
        AccountMeta::new(ctx.accounts.stake_config.key(), false), // mint authority
        AccountMeta::new(ctx.accounts.staker.key(), true), // payer
        AccountMeta::new_readonly(ctx.accounts.stake_config.key(), true), // update authority
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(sysvar::rent::id(), false),
    ];

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: METAPLEX_PROGRAM_ID,
            accounts: meta_accounts,
            data: meta_data,
        },
        &[
            ctx.accounts.metadata_account.to_account_info(),
            ctx.accounts.position_mint.to_account_info(),
            ctx.accounts.stake_config.to_account_info(),
            ctx.accounts.staker.to_account_info(),
            ctx.accounts.stake_config.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.metadata_program.to_account_info(),
        ],
        &[sc_seeds],
    )?;

    emit!(LpStakedEvent { staker: ctx.accounts.staker.key(), amount });
    Ok(())
}

pub fn claim_lp(ctx: Context<ClaimLpRewards>) -> Result<()> {
    require!(ctx.accounts.position_ata.amount == 1, GumballError::Unauthorized);

    let now = Clock::get()?.unix_timestamp;
    update_lp_accumulator(
        &mut ctx.accounts.stake_config,
        ctx.accounts.lp_reward_vault.amount,
        now,
    )?;

    let weight = ctx.accounts.lp_stake_account.weight;
    let acc = ctx.accounts.stake_config.acc_lp_reward_per_weight;
    let entitled = weight.checked_mul(acc).ok_or(GumballError::MathOverflow)? / ACC_SCALE;
    let reward = entitled.saturating_sub(ctx.accounts.lp_stake_account.reward_debt);

    if reward == 0 {
        ctx.accounts.lp_stake_account.last_claimed = now;
        return Ok(());
    }

    let vault_balance = ctx.accounts.lp_reward_vault.amount as u128;
    let to_pay = reward.min(vault_balance) as u64;
    require!(to_pay > 0, GumballError::GumSupplyExhausted);

    let bump = ctx.accounts.stake_config.bump;
    let seeds = &[b"stake_config_v2".as_ref(), &[bump]];
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from:      ctx.accounts.lp_reward_vault.to_account_info(),
                to:        ctx.accounts.claimer_gum_ata.to_account_info(),
                authority: ctx.accounts.stake_config.to_account_info(),
            },
            &[seeds],
        ),
        to_pay,
    )?;

    ctx.accounts.lp_stake_account.reward_debt = entitled;
    ctx.accounts.lp_stake_account.last_claimed = now;
    ctx.accounts.stake_config.total_claimed = ctx.accounts.stake_config.total_claimed
        .checked_add(to_pay).ok_or(GumballError::MathOverflow)?;

    emit!(LpRewardsClaimedEvent {
        staker: ctx.accounts.claimer.key(), amount: to_pay,
    });
    Ok(())
}

pub fn unstake_lp(ctx: Context<UnstakeLp>, amount: u64) -> Result<()> {
    require!(ctx.accounts.position_ata.amount == 1, GumballError::Unauthorized);

    let now = Clock::get()?.unix_timestamp;
    let is_early = now < ctx.accounts.lp_stake_account.lock_until;
    let staked_amount = ctx.accounts.lp_stake_account.amount;
    require!(amount > 0 && amount <= staked_amount, GumballError::InvalidPrice);

    // Update GUM accumulator BEFORE computing pending or changing total_lp_weight
    update_lp_accumulator(
        &mut ctx.accounts.stake_config,
        ctx.accounts.lp_reward_vault.amount,
        now,
    )?;

    // HIGH-1 FIX: advance XNT accumulator with current total_lp_weight before
    // we shrink it. Pending XNT will be settled below.
    let xnt_pool_balance = ctx.accounts.lp_xnt_pool.to_account_info().lamports();
    update_xnt_accumulator(
        &mut ctx.accounts.lp_xnt_state,
        xnt_pool_balance,
        ctx.accounts.stake_config.total_lp_weight,
    )?;

    let lock_tier  = ctx.accounts.lp_stake_account.lock_tier;
    let multiplier = ctx.accounts.lp_stake_account.lock_multiplier;

    // Pending rewards on the FULL position
    let position_weight = ctx.accounts.lp_stake_account.weight;
    let acc = ctx.accounts.stake_config.acc_lp_reward_per_weight;
    let entitled = position_weight
        .checked_mul(acc).ok_or(GumballError::MathOverflow)?
        / ACC_SCALE;
    let pending = entitled.saturating_sub(ctx.accounts.lp_stake_account.reward_debt);

    let bump = ctx.accounts.stake_config.bump;
    let seeds = &[b"stake_config_v2".as_ref(), &[bump]];

    // Pay GUM rewards only if NOT early
    let reward_paid: u64 = if !is_early && pending > 0 {
        let vault_balance = ctx.accounts.lp_reward_vault.amount as u128;
        let to_pay = pending.min(vault_balance) as u64;
        if to_pay > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from:      ctx.accounts.lp_reward_vault.to_account_info(),
                        to:        ctx.accounts.claimer_gum_ata.to_account_info(),
                        authority: ctx.accounts.stake_config.to_account_info(),
                    },
                    &[seeds],
                ),
                to_pay,
            )?;
            ctx.accounts.stake_config.total_claimed = ctx.accounts.stake_config.total_claimed
                .checked_add(to_pay).ok_or(GumballError::MathOverflow)?;
        }
        to_pay
    } else { 0 };

    // Penalty on the LP amount being withdrawn (only on early exit)
    let penalty_bps = if is_early {
        EARLY_EXIT_PENALTY_BPS[lock_tier as usize % 5] as u64
    } else { 0 };
    let penalty: u64 = ((amount as u128)
        .checked_mul(penalty_bps as u128).ok_or(GumballError::MathOverflow)?
        / 10_000) as u64;
    let burn_amount: u64 = ((penalty as u128)
        .checked_mul(PENALTY_BURN_BPS as u128).ok_or(GumballError::MathOverflow)?
        / 10_000) as u64;
    // The remaining (penalty - burn_amount) stays in vault_lp_ata as deferred LP

    let net_to_user = amount.checked_sub(penalty).ok_or(GumballError::MathOverflow)?;

    // Return user's net LP from vault
    if net_to_user > 0 {
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from:      ctx.accounts.vault_lp_ata.to_account_info(),
                    to:        ctx.accounts.user_lp_ata.to_account_info(),
                    authority: ctx.accounts.stake_config.to_account_info(),
                },
                &[seeds],
            ),
            net_to_user,
        )?;
    }

    // Burn 50% of penalty from vault
    if burn_amount > 0 {
        burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint:      ctx.accounts.lp_mint.to_account_info(),
                    from:      ctx.accounts.vault_lp_ata.to_account_info(),
                    authority: ctx.accounts.stake_config.to_account_info(),
                },
                &[seeds],
            ),
            burn_amount,
        )?;
    }

    // HIGH-3 FIX: settle pending XNT BEFORE shrinking weight. The helper pays
    // what the pool can cover and advances debt only by the amount paid;
    // `xnt_remaining` carries any unpaid remainder into the re-snapshot below.
    let xnt_remaining = {
        let pool_info    = ctx.accounts.lp_xnt_pool.to_account_info();
        let claimer_info = ctx.accounts.claimer.to_account_info();
        let (_, remaining) = settle_xnt_fees(
            &mut ctx.accounts.lp_xnt_state,
            &pool_info,
            &claimer_info,
            &mut ctx.accounts.xnt_debt,
            position_weight,
            ctx.bumps.xnt_debt,
        )?;
        remaining
    };

    // Update total_lp_weight — remove the proportional weight of the unstaked LP.
    // MED-3: use checked_sub to fail loudly on accounting drift.
    let weight_to_remove = (amount as u128)
        .checked_mul(multiplier as u128).ok_or(GumballError::MathOverflow)?
        / 100;
    ctx.accounts.stake_config.total_lp_weight = ctx.accounts.stake_config.total_lp_weight
        .checked_sub(weight_to_remove).ok_or(GumballError::MathOverflow)?;

    if amount == staked_amount {
        // Full withdrawal — burn position NFT + close stake account
        burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
            mint:      ctx.accounts.position_mint.to_account_info(),
            from:      ctx.accounts.position_ata.to_account_info(),
            authority: ctx.accounts.claimer.to_account_info(),
        }), 1)?;

        // Close the XntDebt PDA and refund its rent — the position mint is
        // burned above and StakeLp always creates a fresh mint, so this PDA
        // could never be reached again and would strand its rent forever.
        // (Any XNT the pool couldn't cover just now stays in the pool as
        // unattributed surplus, recoverable via sweep_xnt_pool_lp.)
        close_xnt_debt(
            &ctx.accounts.xnt_debt.to_account_info(),
            &ctx.accounts.claimer.to_account_info(),
        )?;

        let lp_info = ctx.accounts.lp_stake_account.to_account_info();
        let claimer_info = ctx.accounts.claimer.to_account_info();
        **claimer_info.try_borrow_mut_lamports()? += lp_info.lamports();
        **lp_info.try_borrow_mut_lamports()? = 0;
        lp_info.try_borrow_mut_data()?.fill(0);
    } else {
        // Partial — adjust amount, weight, reward_debt
        let new_amount = staked_amount.checked_sub(amount).ok_or(GumballError::MathOverflow)?;
        let new_weight = (new_amount as u128)
            .checked_mul(multiplier as u128).ok_or(GumballError::MathOverflow)?
            / 100;
        ctx.accounts.lp_stake_account.amount = new_amount;
        ctx.accounts.lp_stake_account.weight = new_weight;
        // Reset reward_debt to current accumulator level — we just paid out everything pending
        ctx.accounts.lp_stake_account.reward_debt = new_weight
            .checked_mul(acc).ok_or(GumballError::MathOverflow)?
            / ACC_SCALE;
        ctx.accounts.lp_stake_account.last_claimed = now;
        // HIGH-3 FIX: re-snapshot xnt_debt at NEW weight × current xnt_acc,
        // minus any remainder the pool couldn't pay just now — so the
        // position's unpaid pending XNT survives the re-snapshot instead
        // of being silently forfeited. (bump was set by settle_xnt_fees.)
        let xnt_acc  = ctx.accounts.lp_xnt_state.acc_xnt_per_weight;
        let xnt_snap = new_weight
            .checked_mul(xnt_acc).ok_or(GumballError::MathOverflow)?
            / ACC_SCALE;
        ctx.accounts.xnt_debt.debt = xnt_snap.saturating_sub(xnt_remaining);
    }

    emit!(LpUnstakedEvent {
        staker: ctx.accounts.claimer.key(), amount, reward: reward_paid,
    });
    Ok(())
}

pub fn set_lp_mint(ctx: Context<SetLpMint>, lp_mint: Pubkey) -> Result<()> {
    let cfg = &mut ctx.accounts.lp_mint_config;
    cfg.lp_mint = lp_mint;
    cfg.bump = ctx.bumps.lp_mint_config;
    Ok(())
}
