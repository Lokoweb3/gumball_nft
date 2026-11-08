use crate::*;

// ─── Account Structs ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeMachine<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Machine::LEN, seeds = [b"machine"], bump)]
    pub machine: Account<'info, Machine>,
    pub system_program: Program<'info, System>,
    /// S2 FIX: only the program's upgrade authority may create the Machine,
    /// otherwise the first caller becomes machine.authority.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ GumballError::Unauthorized)]
    pub program: Program<'info, crate::program::GumballNft>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ GumballError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, constraint = authority.key() == machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
}

#[derive(Accounts)]
pub struct MigrateMachine<'info> {
    #[account(mut, constraint = authority.key() == machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"machine"],
        bump = machine.bump,
        realloc = 8 + Machine::LEN,
        realloc::payer = authority,
        realloc::zero = false,
    )]
    pub machine: Account<'info, Machine>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetSeason<'info> {
    #[account(mut, address = machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(init_if_needed, payer = authority, space = 8 + SeasonConfig::LEN,
              seeds = [b"season"], bump)]
    pub season_config: Account<'info, SeasonConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(address = machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
}

pub fn initialize_machine(
    ctx: Context<InitializeMachine>,
    mint_price: u64,
    treasury: Pubkey,
) -> Result<()> {
    let machine          = &mut ctx.accounts.machine;
    machine.authority    = ctx.accounts.authority.key();
    machine.treasury     = treasury;
    machine.mint_price   = if mint_price == 0 { BASE_PRICE } else { mint_price };
    machine.total_minted = 0;
    machine.max_supply   = MAX_SUPPLY;
    machine.is_active    = false;
    machine.oracle       = ctx.accounts.authority.key(); // set oracle = authority initially
    machine.bump         = ctx.bumps.machine;
    machine.total_burned = 0;
    emit!(MachineInitializedEvent {
        authority: machine.authority, treasury,
        mint_price: machine.mint_price, max_supply: MAX_SUPPLY,
    });
    Ok(())
}

pub fn set_oracle(ctx: Context<AdminOnly>, new_oracle: Pubkey) -> Result<()> {
    ctx.accounts.machine.oracle = new_oracle;
    emit!(OracleUpdatedEvent { new_oracle });
    Ok(())
}

pub fn set_active(ctx: Context<AdminOnly>, active: bool) -> Result<()> {
    ctx.accounts.machine.is_active = active;
    Ok(())
}

pub fn set_mint_price(ctx: Context<AdminOnly>, new_price: u64) -> Result<()> {
    require!(new_price > 0, GumballError::InvalidPrice);
    require!(new_price <= 100_000_000_000, GumballError::InvalidPrice); // max 100 XNT
    ctx.accounts.machine.mint_price = new_price;
    Ok(())
}

pub fn migrate_machine(ctx: Context<MigrateMachine>) -> Result<()> {
    ctx.accounts.machine.total_burned = 0;
    msg!("Machine migrated — total_burned initialized to 0");
    Ok(())
}

pub fn set_season(
    ctx: Context<SetSeason>,
    flavor_start: u8, flavor_count: u8,
    color_start: u8, color_count: u8,
    ends_at: i64, label: [u8; 12],
) -> Result<()> {
    require!(
        (flavor_start as usize).saturating_add(flavor_count as usize) <= FLAVORS.len() &&
        (color_start as usize).saturating_add(color_count as usize) <= COLORS.len(),
        GumballError::InvalidAccount
    );
    let s = &mut ctx.accounts.season_config;
    s.flavor_start = flavor_start;
    s.flavor_count = flavor_count;
    s.color_start  = color_start;
    s.color_count  = color_count;
    s.ends_at      = ends_at;
    s.label        = label;
    s.bump         = ctx.bumps.season_config;
    Ok(())
}

pub fn transfer_authority(
    ctx: Context<TransferAuthority>,
    new_authority: Pubkey,
    new_treasury: Pubkey,
) -> Result<()> {
    require!(
        new_authority != Pubkey::default() && new_treasury != Pubkey::default(),
        GumballError::InvalidAccount
    );
    let machine = &mut ctx.accounts.machine;
    machine.authority = new_authority;
    machine.treasury  = new_treasury;
    Ok(())
}
