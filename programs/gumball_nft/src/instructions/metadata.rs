use crate::*;

#[derive(Accounts)]
pub struct AttachMetadata<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: gumball NFT mint authority PDA — signs the Metaplex CPI
    #[account(seeds = [b"machine_authority"], bump)]
    pub machine_authority: AccountInfo<'info>,
    pub nft_mint: Account<'info, Mint>,
    /// Proves this mint is a real gumball (PDA exists) + provides the serial
    #[account(seeds = [b"gumball", nft_mint.key().as_ref()], bump = gumball_data.bump)]
    pub gumball_data: Account<'info, GumballData>,
    /// CHECK: Metaplex metadata PDA — derivation validated by the Metaplex
    /// program in the CPI; creation fails if it already exists
    #[account(mut)]
    pub metadata_account: AccountInfo<'info>,
    /// CHECK: Metaplex Token Metadata program
    #[account(address = METAPLEX_PROGRAM_ID @ GumballError::InvalidAccount)]
    pub metadata_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn attach_metadata(ctx: Context<AttachMetadata>) -> Result<()> {
    let serial = ctx.accounts.gumball_data.serial;
    let name = {
        let n = format!("Gumball #{}", serial);
        if n.len() > 32 { n[..32].to_string() } else { n }
    };
    let symbol = "GMBL".to_string();
    let uri = format!("{}{}", METADATA_BASE_URI, ctx.accounts.nft_mint.key());

    // CreateMetadataAccountV3 — same manual serialization as stake_lp's CPI
    let mut meta_data = vec![33u8];
    meta_data.extend_from_slice(&(name.len() as u32).to_le_bytes());
    meta_data.extend_from_slice(name.as_bytes());
    meta_data.extend_from_slice(&(symbol.len() as u32).to_le_bytes());
    meta_data.extend_from_slice(symbol.as_bytes());
    meta_data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
    meta_data.extend_from_slice(uri.as_bytes());
    meta_data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_bps (royalty enforced by our marketplace, not Metaplex)
    meta_data.push(0); // creators: None
    meta_data.push(0); // collection: None
    meta_data.push(0); // uses: None
    meta_data.push(1); // is_mutable: true — URI host may change; update auth is the program PDA
    meta_data.push(0); // collection_details: None

    let meta_accounts = vec![
        AccountMeta::new(ctx.accounts.metadata_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.nft_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.machine_authority.key(), true), // mint authority (PDA signs)
        AccountMeta::new(ctx.accounts.payer.key(), true),                      // payer
        AccountMeta::new_readonly(ctx.accounts.machine_authority.key(), true), // update authority
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(sysvar::rent::id(), false),
    ];

    let auth_bump = ctx.bumps.machine_authority;
    let auth_seeds: &[&[u8]] = &[b"machine_authority", &[auth_bump]];
    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: METAPLEX_PROGRAM_ID,
            accounts: meta_accounts,
            data: meta_data,
        },
        &[
            ctx.accounts.metadata_account.to_account_info(),
            ctx.accounts.nft_mint.to_account_info(),
            ctx.accounts.machine_authority.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.machine_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.metadata_program.to_account_info(),
        ],
        &[auth_seeds],
    )?;
    Ok(())
}
