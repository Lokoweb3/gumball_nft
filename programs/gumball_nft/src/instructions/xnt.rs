use crate::*;

// ─── Phase 2: XNT Fee Sharing Account Contexts ──────────────────────────────

#[derive(Accounts)]
pub struct InitializeXntFees<'info> {
    #[account(mut, address = stake_config.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(init, payer = authority, space = 8 + XntPool::LEN,
              seeds = [b"nft_xnt_pool"], bump)]
    pub nft_xnt_pool: Account<'info, XntPool>,
    #[account(init, payer = authority, space = 8 + XntPool::LEN,
              seeds = [b"lp_xnt_pool"], bump)]
    pub lp_xnt_pool: Account<'info, XntPool>,
    #[account(init, payer = authority, space = 8 + XntFeeState::LEN,
              seeds = [b"xnt_fee_state_nft"], bump)]
    pub nft_xnt_state: Account<'info, XntFeeState>,
    #[account(init, payer = authority, space = 8 + XntFeeState::LEN,
              seeds = [b"xnt_fee_state_lp"], bump)]
    pub lp_xnt_state: Account<'info, XntFeeState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimXntFeesNft<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(seeds = [b"stake_v2", stake_account.nft_mint.as_ref()], bump = stake_account.bump,
              constraint = stake_account.owner == staker.key() @ GumballError::Unauthorized)]
    pub stake_account: Box<Account<'info, StakeAccount>>,
    #[account(mut, seeds = [b"nft_xnt_pool"], bump = nft_xnt_pool.bump)]
    pub nft_xnt_pool: Account<'info, XntPool>,
    #[account(mut, seeds = [b"xnt_fee_state_nft"], bump = nft_xnt_state.bump)]
    pub nft_xnt_state: Box<Account<'info, XntFeeState>>,
    /// Per-position debt — created on first claim
    #[account(init_if_needed, payer = staker, space = 8 + XntDebt::LEN,
              seeds = [b"xnt_debt_nft", stake_account.nft_mint.as_ref()], bump)]
    pub xnt_debt: Box<Account<'info, XntDebt>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimXntFeesLp<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Box<Account<'info, StakeConfig>>,
    #[account(seeds = [b"lp_stake_v2", lp_stake_account.position_mint.as_ref()], bump = lp_stake_account.bump)]
    pub lp_stake_account: Box<Account<'info, LpStakeAccount>>,
    /// Caller must hold the position NFT
    #[account(constraint = position_ata.mint == lp_stake_account.position_mint
              && position_ata.owner == claimer.key() @ GumballError::Unauthorized)]
    pub position_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"lp_xnt_pool"], bump = lp_xnt_pool.bump)]
    pub lp_xnt_pool: Account<'info, XntPool>,
    #[account(mut, seeds = [b"xnt_fee_state_lp"], bump = lp_xnt_state.bump)]
    pub lp_xnt_state: Box<Account<'info, XntFeeState>>,
    #[account(init_if_needed, payer = claimer, space = 8 + XntDebt::LEN,
              seeds = [b"xnt_debt_lp", lp_stake_account.position_mint.as_ref()], bump)]
    pub xnt_debt: Box<Account<'info, XntDebt>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepXntPoolNft<'info> {
    #[account(mut, address = machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    /// CHECK: validated against machine.treasury
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    #[account(seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(mut, seeds = [b"xnt_fee_state_nft"], bump = nft_xnt_state.bump)]
    pub nft_xnt_state: Account<'info, XntFeeState>,
    #[account(mut, seeds = [b"nft_xnt_pool"], bump = nft_xnt_pool.bump)]
    pub nft_xnt_pool: Account<'info, XntPool>,
}

#[derive(Accounts)]
pub struct SweepXntPoolLp<'info> {
    #[account(mut, address = machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    /// CHECK: validated against machine.treasury
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    #[account(seeds = [b"stake_config_v2"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(mut, seeds = [b"xnt_fee_state_lp"], bump = lp_xnt_state.bump)]
    pub lp_xnt_state: Account<'info, XntFeeState>,
    #[account(mut, seeds = [b"lp_xnt_pool"], bump = lp_xnt_pool.bump)]
    pub lp_xnt_pool: Account<'info, XntPool>,
}

pub fn initialize_xnt_fees(ctx: Context<InitializeXntFees>) -> Result<()> {
    // CRIT-2 FIX: capture the pool's initial rent-exempt balance as last_seen
    // so it isn't credited as fee revenue on the first accumulator update.
    let nft_pool_balance = ctx.accounts.nft_xnt_pool.to_account_info().lamports();
    let lp_pool_balance  = ctx.accounts.lp_xnt_pool.to_account_info().lamports();

    let nft_pool  = &mut ctx.accounts.nft_xnt_pool;
    nft_pool.bump = ctx.bumps.nft_xnt_pool;
    let lp_pool   = &mut ctx.accounts.lp_xnt_pool;
    lp_pool.bump  = ctx.bumps.lp_xnt_pool;

    let nft_state = &mut ctx.accounts.nft_xnt_state;
    nft_state.stake_type         = 0;
    nft_state.acc_xnt_per_weight = 0;
    nft_state.last_seen_balance  = nft_pool_balance;
    nft_state.bump               = ctx.bumps.nft_xnt_state;

    let lp_state  = &mut ctx.accounts.lp_xnt_state;
    lp_state.stake_type         = 1;
    lp_state.acc_xnt_per_weight = 0;
    lp_state.last_seen_balance  = lp_pool_balance;
    lp_state.bump               = ctx.bumps.lp_xnt_state;
    Ok(())
}

pub fn claim_xnt_fees_nft(ctx: Context<ClaimXntFeesNft>) -> Result<()> {
    let pool_balance = ctx.accounts.nft_xnt_pool.to_account_info().lamports();
    let total_weight = ctx.accounts.stake_config.total_nft_weight;

    update_xnt_accumulator(&mut ctx.accounts.nft_xnt_state, pool_balance, total_weight)?;

    let weight = ctx.accounts.stake_account.weight as u128;
    let (paid, remaining) = {
        let pool_info   = ctx.accounts.nft_xnt_pool.to_account_info();
        let staker_info = ctx.accounts.staker.to_account_info();
        settle_xnt_fees(
            &mut ctx.accounts.nft_xnt_state,
            &pool_info,
            &staker_info,
            &mut ctx.accounts.xnt_debt,
            weight,
            ctx.bumps.xnt_debt,
        )?
    };
    // Fail loudly when pending XNT exists but the pool couldn't pay ANY of
    // it — a silent success is indistinguishable from "nothing pending" for
    // the user. A partial payment succeeds; the unpaid remainder stays
    // pending (debt advances only by what was paid) for a later claim.
    require!(paid > 0 || remaining == 0, GumballError::InsufficientFunds);
    Ok(())
}

pub fn claim_xnt_fees_lp(ctx: Context<ClaimXntFeesLp>) -> Result<()> {
    require!(ctx.accounts.position_ata.amount == 1, GumballError::Unauthorized);

    let pool_balance = ctx.accounts.lp_xnt_pool.to_account_info().lamports();
    let total_weight = ctx.accounts.stake_config.total_lp_weight;

    update_xnt_accumulator(&mut ctx.accounts.lp_xnt_state, pool_balance, total_weight)?;

    let weight = ctx.accounts.lp_stake_account.weight;
    let (paid, remaining) = {
        let pool_info    = ctx.accounts.lp_xnt_pool.to_account_info();
        let claimer_info = ctx.accounts.claimer.to_account_info();
        settle_xnt_fees(
            &mut ctx.accounts.lp_xnt_state,
            &pool_info,
            &claimer_info,
            &mut ctx.accounts.xnt_debt,
            weight,
            ctx.bumps.xnt_debt,
        )?
    };
    // Same loud-failure semantics as claim_xnt_fees_nft.
    require!(paid > 0 || remaining == 0, GumballError::InsufficientFunds);
    Ok(())
}

pub fn sweep_xnt_pool_nft(ctx: Context<SweepXntPoolNft>) -> Result<()> {
    require!(ctx.accounts.stake_config.total_nft_weight == 0, GumballError::PoolHasStakers);
    sweep_xnt_pool(
        &mut ctx.accounts.nft_xnt_state,
        &ctx.accounts.nft_xnt_pool.to_account_info(),
        &ctx.accounts.treasury,
    )
}

pub fn sweep_xnt_pool_lp(ctx: Context<SweepXntPoolLp>) -> Result<()> {
    require!(ctx.accounts.stake_config.total_lp_weight == 0, GumballError::PoolHasStakers);
    sweep_xnt_pool(
        &mut ctx.accounts.lp_xnt_state,
        &ctx.accounts.lp_xnt_pool.to_account_info(),
        &ctx.accounts.treasury,
    )
}
