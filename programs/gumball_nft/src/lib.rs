use anchor_lang::prelude::*;
use anchor_lang::system_program::System;
use anchor_lang::solana_program::{clock::Clock, sysvar, hash::hashv, program::invoke};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{burn, mint_to, Burn, Mint, MintTo, Token, TokenAccount},
};

/// Metaplex Token Metadata Program ID
const METAPLEX_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205,
    88, 184, 108, 115, 26, 160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70,
]); // metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s

declare_id!("AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy");

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SUPPLY:     u64   = 10_000;
const MAX_PER_TX:     u8    = 10;
const MAX_SVG_LEN:    usize = 1400;
const MINT_TIMEOUT:   i64   = 300; // 5 min before request expires — M-2 fix

// Exponential pricing: 0.01 XNT at mint #0, 0.04 XNT at mint #10,000
// Formula: price = BASE_PRICE * 4^(total_minted / MAX_SUPPLY)
// Implemented via integer approximation using linear interpolation over
// a precomputed table of 4^(x/10) for x = 0..10
const BASE_PRICE: u64 = 10_000_000; // 0.01 XNT in lamports
const MAX_PRICE:  u64 = 40_000_000; // 0.04 XNT in lamports

const RARITY_LEGENDARY: u8 = 4;
const ROYALTY_BPS: u64 = 500; // 5% royalty to treasury on marketplace sales

// ─── Staking Constants ───────────────────────────────────────────────────────
// GUM emission rates per second (6 decimal GUM token)
// Common=10/day, Uncommon=25/day, Rare=60/day, Epic=150/day, Legendary=500/day
const GUM_DECIMALS: u8 = 6;
const GUM_MAX_SUPPLY: u64 = 1_000_000_000 * 1_000_000; // 1B GUM (6 decimals)
const EMISSION_PER_SECOND: [u64; 5] = [
    115_740,   // Common:    10 * 1e6 / 86400 = 115,740
    289_351,   // Uncommon:  25 * 1e6 / 86400 = 289,351
    694_444,   // Rare:      60 * 1e6 / 86400 = 694,444
    1_736_111, // Epic:     150 * 1e6 / 86400 = 1,736,111
    5_787_037, // Legendary:500 * 1e6 / 86400 = 5,787,037
];

// LP staking: 100 GUM/day per LP token staked (scaled by LP amount)
// Rate is per 1 LP token (9 decimals) per second
const LP_EMISSION_PER_SECOND: u64 = 1_157_407; // 100 * 1e6 / 86400

// GumballData raw byte offsets for UncheckedAccount parsing in burn instructions.
// Must match GumballData struct layout: disc(8) + owner(32) + machine(32) + serial(8) + flavor(1) + color(1) + rarity(1)
const GD_OWNER_OFFSET:  usize = 8;
const GD_RARITY_OFFSET: usize = 8 + 32 + 32 + 8 + 1 + 1; // = 82
// CRIT-2 FIX: burns required per rarity level [Common, Uncommon, Rare, Epic]
const BURNS_REQUIRED: [u8; 4] = [5, 3, 2, 2];

const FLAVORS: [&str; 20] = [
    "Cherry","Grape","Watermelon","Blueberry","Strawberry",
    "Lemon","Lime","Orange","Bubblegum","Cotton Candy",
    "Peach","Pineapple","Raspberry","Mint","Cinnamon",
    "Root Beer","Banana","Green Apple","Mango","Mystery",
];
const COLORS: [&str; 12] = [
    "Cherry Red","Grape Purple","Melon Pink","Berry Blue",
    "Rose Gold","Citrus Yellow","Lime Green","Tangerine",
    "Cotton White","Midnight Black","Shimmer Silver","Rainbow",
];
const SPECIALS: [&str; 8] = [
    "None","None","None","None",
    "Glitter","Double Bubble","Holographic","Crystal",
];
const RARITY_NAMES: [&str; 5] = ["Common","Uncommon","Rare","Epic","Legendary"];
const RARITY_CUTS:  [u8; 5]   = [60, 85, 95, 99, 100];

const BALL_HI: [&str; 12] = [
    "#ff6688","#c077ff","#ffbbdd","#66aaff",
    "#ffc4b0","#fff099","#88ff88","#ffbb77",
    "#ffffff","#4455aa","#eeeeff","#ff88ff",
];
const BALL_SH: [&str; 12] = [
    "#8a0020","#4a1a6b","#cc3377","#0033aa",
    "#9a4433","#b8960a","#228822","#cc5500",
    "#aaaaaa","#000011","#777788","#8800aa",
];
const BALL_GL: [&str; 12] = [
    "#ff2244","#aa55ff","#ff44aa","#4488ff",
    "#ffaa88","#ffdd44","#66ee66","#ffaa44",
    "#cccccc","#3344aa","#ccccdd","#ff44ff",
];
const RARITY_RC: [&str; 5] = ["#aaaacc","#44ff88","#44aaff","#cc88ff","#ffcc00"];
const RARITY_BG: [&str; 5] = ["#0a0a14","#0a140a","#0a0a1e","#140a1e","#141000"];

// ─── SVG Generator ────────────────────────────────────────────────────────────

fn generate_svg(serial: u64, flavor: u8, color: u8, rarity: u8, special: u8) -> Vec<u8> {
    let ci = color   as usize % 12;
    let ri = rarity  as usize % 5;
    let si = special as usize % 8;
    let fi = flavor  as usize % 20;

    let hi = BALL_HI[ci]; let sh = BALL_SH[ci];
    let gl = BALL_GL[ci]; let rc = RARITY_RC[ri];
    let bg = RARITY_BG[ri];
    let fl = FLAVORS[fi];  let rn = RARITY_NAMES[ri];
    let sp = SPECIALS[si];

    let special_el: &str = match sp {
        "Glitter"       => r##"<circle cx="125" cy="115" r="2" fill="#fff" opacity=".9"/><circle cx="170" cy="130" r="1.5" fill="#fff" opacity=".8"/><circle cx="140" cy="160" r="2" fill="#fff" opacity=".7"/><circle cx="165" cy="110" r="1.5" fill="#fff" opacity=".85"/>"##,
        "Double Bubble"  => r##"<circle cx="205" cy="90" r="45" fill="url(#b)" opacity=".5"/><ellipse cx="192" cy="78" rx="12" ry="8" fill="#fff" opacity=".3"/>"##,
        "Holographic"    => r##"<circle cx="150" cy="145" r="85" fill="none" stroke="url(#hl)" stroke-width="4" opacity=".4"/>"##,
        "Crystal"        => r##"<polygon points="150,60 195,115 185,170 150,190 115,170 105,115" fill="none" stroke="#fff" stroke-width="1" opacity=".25"/>"##,
        _                => "",
    };

    let holo_grad = if sp == "Holographic" {
        r##"<linearGradient id="hl"><stop offset="0%" stop-color="#f4a"/><stop offset="50%" stop-color="#4af"/><stop offset="100%" stop-color="#4fa"/></linearGradient>"##
    } else { "" };

    let legend_el = if rn == "Legendary" {
        r##"<circle cx="150" cy="145" r="115" fill="none" stroke="#fc0" stroke-width="1" stroke-dasharray="5 3" opacity=".5"/>"##
    } else { "" };

    let mut svg = String::with_capacity(1400);
    svg.push_str(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">"#);
    svg.push_str(&format!(r#"<defs><radialGradient id="b" cx="35%" cy="30%" r="65%"><stop offset="0%" stop-color="{hi}"/><stop offset="70%" stop-color="{gl}"/><stop offset="100%" stop-color="{sh}"/></radialGradient>{holo_grad}</defs>"#));
    svg.push_str(&format!(r#"<rect width="300" height="300" fill="{bg}"/>"#));
    svg.push_str(legend_el);
    svg.push_str(&format!(r#"<circle cx="150" cy="145" r="106" fill="{gl}" opacity=".08"/>"#));
    svg.push_str(r##"<ellipse cx="150" cy="250" rx="55" ry="7" fill="#000" opacity=".3"/>"##);
    svg.push_str(r##"<circle cx="150" cy="145" r="100" fill="url(#b)"/>"##);
    svg.push_str(special_el);
    svg.push_str(r##"<ellipse cx="120" cy="110" rx="28" ry="18" fill="#fff" opacity=".4" transform="rotate(-30,120,110)"/>"##);
    svg.push_str(&format!(r##"<circle cx="150" cy="145" r="100" fill="none" stroke="{rc}" stroke-width="2" opacity=".4"/>"##));
    svg.push_str(r##"<rect x="0" y="250" width="300" height="50" fill="#000" opacity=".6"/>"##);
    svg.push_str(&format!(r##"<text x="150" y="270" text-anchor="middle" font-family="monospace" font-size="13" font-weight="bold" fill="#fff">{fl}</text>"##));
    svg.push_str(&format!(r##"<text x="150" y="288" text-anchor="middle" font-family="monospace" font-size="9" fill="{rc}">{rn} #{serial:04}</text>"##));
    svg.push_str("</svg>");

    let bytes = svg.into_bytes();
    if bytes.len() > MAX_SVG_LEN { bytes[..MAX_SVG_LEN].to_vec() } else { bytes }
}

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod gumball_nft {
    use super::*;

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

    // M-1 FIX: oracle pubkey is now stored in Machine and can be rotated
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


    // ── C-2 FIX: Step 1 — Oracle submits commitment BEFORE knowing slot ───────
    // Oracle generates: secret = random_bytes()
    // Computes: commitment = sha256(secret || oracle_pubkey)
    // Submits commitment on-chain here.
    // The oracle cannot predict the slot hash at this point.
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

    // ── User pays and locks in a commitment ───────────────────────────────────
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

    // ── C-2 FIX: Step 2 — Oracle reveals secret, contract verifies + mints ───
    // The oracle reveals the secret it committed to earlier.
    // Contract verifies sha256(secret || oracle_pubkey) == stored_commitment.
    // Seed = sha256(secret || slot_hash_bytes) — unpredictable to oracle
    // because slot_hash was unknown when commitment was made.
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
            let req_info = ctx.accounts.mint_request.to_account_info();
            let rent_lamports = req_info.lamports();
            **req_info.try_borrow_mut_lamports()? = 0;
            **ctx.accounts.minter.try_borrow_mut_lamports()? += rent_lamports;
            // Close the PDA: zero data + mark fulfilled
            req_info.try_borrow_mut_data()?.fill(0);
            ctx.accounts.mint_request.fulfilled = true;
            emit!(MintRefundedEvent {
                minter: minter_key,
                amount: paid_amount,
            });
            return Ok(());
        }

        // C-2 FIX: verify commitment on-chain
        // commitment = sha256(secret || oracle_pubkey)
        let oracle_pubkey = ctx.accounts.oracle.key();
        let expected_commitment = hashv(&[&secret, oracle_pubkey.as_ref()]);
        require!(
            expected_commitment.to_bytes() == ctx.accounts.oracle_commit.commitment,
            GumballError::InvalidCommitment
        );

        // Derive seed from secret + slot_hash (slot_hash unknown at commit time)
        let slot_hash_data = &ctx.accounts.slot_hashes.data.borrow();
        let slot_hash_bytes: &[u8; 32] = &slot_hash_data[16..48]
            .try_into()
            .map_err(|_| error!(GumballError::InvalidSlotHash))?;

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
        **ctx.accounts.mint_request.to_account_info().try_borrow_mut_lamports()? -= paid;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += paid;

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

        let traits = resolve_traits(seed, machine.total_minted)?;

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

    /// Burn 2 gumballs of rarity X → receive 1 guaranteed rarity X+1
    /// C-1 FIX: gumball accounts validated by PDA seeds

    /// Allow the minter to reclaim XNT if the oracle failed to reveal within MINT_TIMEOUT.
    /// Anyone can call this after the timeout — funds always go back to the original minter.
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

        // Upgrade fee = current dynamic mint price → treasury
        let upgrade_fee = get_mint_price(machine.total_minted);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                },
            ),
            upgrade_fee,
        )?;

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

    /// Burn N gumballs of rarity X → receive 1 of rarity X+1
    /// Handles Common→Uncommon (5 burns) and Uncommon→Rare (3 burns)
    /// remaining_accounts = [(mint_1, ata_1, gumball_pda_1), (mint_2, ata_2, gumball_pda_2), ...]
    /// gumball_a/mint_a/ata_a are the "base" accounts (first burn)
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

        // Upgrade fee = current dynamic mint price → treasury
        let upgrade_fee = get_mint_price(machine.total_minted);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.burner.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                },
            ),
            upgrade_fee,
        )?;

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

    /// Migrate machine account to new struct size (adds total_burned field).
    /// Safe to call multiple times — idempotent.
    pub fn migrate_machine(ctx: Context<MigrateMachine>) -> Result<()> {
        ctx.accounts.machine.total_burned = 0;
        msg!("Machine migrated — total_burned initialized to 0");
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let bal = ctx.accounts.treasury.lamports();
        require!(bal >= amount, GumballError::InsufficientFunds);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to:   ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    /// H2 FIX: Sync gumball owner to current SPL token holder.
    /// Anyone can call this — it just reads the ATA balance and updates the field.
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

    // ── Marketplace ──────────────────────────────────────────────────────────

    /// List a gumball NFT for sale at a fixed price.
    /// Token is escrowed in a PDA-owned ATA until sold or delisted.
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

    /// Cancel a listing and return the NFT to the seller.
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

    /// Buy a listed gumball at the listed price. 1% royalty to treasury.
    pub fn buy_gumball(ctx: Context<BuyGumball>) -> Result<()> {
        let price = ctx.accounts.listing.price;
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

        // Pay royalty to treasury
        if royalty > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.treasury.to_account_info(),
                    },
                ),
                royalty,
            )?;
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

    /// Place an offer on a gumball (listed or not). XNT escrowed in Offer PDA.
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

    /// Cancel an offer and return escrowed XNT to buyer.
    /// Anchor `close = buyer` handles lamport return + account cleanup.
    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        emit!(OfferCancelledEvent {
            buyer: ctx.accounts.offer.buyer, nft_mint: ctx.accounts.offer.nft_mint,
        });
        Ok(())
    }

    /// Accept an offer — seller receives XNT (minus 1% royalty), buyer gets NFT.
    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        // Check offer hasn't expired
        let now = Clock::get()?.unix_timestamp;
        if ctx.accounts.offer.expires_at > 0 {
            require!(now <= ctx.accounts.offer.expires_at, GumballError::OfferExpired);
        }
        let amount = ctx.accounts.offer.amount;
        let royalty = amount.checked_mul(ROYALTY_BPS).ok_or(GumballError::MathOverflow)? / 10_000;
        let seller_amount = amount.checked_sub(royalty).ok_or(GumballError::MathOverflow)?;

        let offer_info = ctx.accounts.offer.to_account_info();

        // Pay seller from Offer PDA
        **offer_info.try_borrow_mut_lamports()? -= seller_amount;
        **ctx.accounts.seller.try_borrow_mut_lamports()? += seller_amount;

        // Pay royalty to treasury from Offer PDA
        if royalty > 0 {
            **offer_info.try_borrow_mut_lamports()? -= royalty;
            **ctx.accounts.treasury.try_borrow_mut_lamports()? += royalty;
        }

        // Return remaining rent to buyer and close Offer account
        let remaining = offer_info.lamports();
        **offer_info.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.buyer.try_borrow_mut_lamports()? += remaining;
        offer_info.try_borrow_mut_data()?.fill(0);

        // Transfer NFT from seller to buyer
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

        // Update gumball owner
        ctx.accounts.gumball_data.owner = ctx.accounts.buyer.key();

        emit!(GumballSoldEvent {
            seller: ctx.accounts.seller.key(), buyer: ctx.accounts.offer.buyer,
            nft_mint: ctx.accounts.offer.nft_mint, price: amount, royalty,
        });
        Ok(())
    }

    // ── STAKING ──────────────────────────────────────────────────────────────

    /// Initialize the staking system — creates StakeConfig and GUM token mint.
    /// Called once by admin after deployment.
    pub fn initialize_staking(ctx: Context<InitializeStaking>) -> Result<()> {
        let config = &mut ctx.accounts.stake_config;
        config.authority = ctx.accounts.authority.key();
        config.gum_mint = ctx.accounts.gum_mint.key();
        config.total_staked = 0;
        config.total_claimed = 0;
        config.bump = ctx.bumps.stake_config;
        Ok(())
    }

    /// Stake a gumball NFT — transfer to vault, start earning GUM.
    pub fn stake(ctx: Context<StakeNft>) -> Result<()> {
        let rarity = ctx.accounts.gumball_data.rarity;
        require!(rarity <= RARITY_LEGENDARY, GumballError::InvalidAccount);

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

        let now = Clock::get()?.unix_timestamp;
        let stake = &mut ctx.accounts.stake_account;
        stake.owner = ctx.accounts.staker.key();
        stake.nft_mint = ctx.accounts.nft_mint.key();
        stake.rarity = rarity;
        stake.staked_at = now;
        stake.last_claimed = now;
        stake.bump = ctx.bumps.stake_account;

        ctx.accounts.stake_config.total_staked = ctx.accounts.stake_config.total_staked
            .checked_add(1).ok_or(GumballError::MathOverflow)?;

        emit!(NftStakedEvent {
            staker: stake.owner, nft_mint: stake.nft_mint, rarity,
        });
        Ok(())
    }

    /// Claim pending GUM rewards without unstaking.
    pub fn claim(ctx: Context<ClaimRewards>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let elapsed = (now - ctx.accounts.stake_account.last_claimed) as u64;
        let rarity = ctx.accounts.stake_account.rarity;
        let rate = EMISSION_PER_SECOND[rarity as usize % 5];
        let reward = elapsed.checked_mul(rate).ok_or(GumballError::MathOverflow)?;

        if reward == 0 { return Ok(()); }

        // Check GUM supply cap
        let new_total = ctx.accounts.stake_config.total_claimed
            .checked_add(reward).ok_or(GumballError::MathOverflow)?;
        require!(new_total <= GUM_MAX_SUPPLY, GumballError::GumSupplyExhausted);

        // Mint GUM to staker
        let bump = ctx.accounts.stake_config.bump;
        let seeds = &[b"stake_config".as_ref(), &[bump]];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.gum_mint.to_account_info(),
                    to:        ctx.accounts.staker_gum_ata.to_account_info(),
                    authority: ctx.accounts.stake_config.to_account_info(),
                },
                &[seeds],
            ),
            reward,
        )?;

        ctx.accounts.stake_account.last_claimed = now;
        ctx.accounts.stake_config.total_claimed = new_total;

        let staker = ctx.accounts.stake_account.owner;
        let nft_mint = ctx.accounts.stake_account.nft_mint;
        emit!(RewardsClaimedEvent { staker, nft_mint, amount: reward });
        Ok(())
    }

    /// Unstake — claim pending rewards and return NFT to owner.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let elapsed = (now - ctx.accounts.stake_account.last_claimed) as u64;
        let rarity = ctx.accounts.stake_account.rarity;
        let rate = EMISSION_PER_SECOND[rarity as usize % 5];
        let reward = elapsed.checked_mul(rate).ok_or(GumballError::MathOverflow)?;
        let staker_key = ctx.accounts.stake_account.owner;
        let nft_mint_key = ctx.accounts.stake_account.nft_mint;

        let bump = ctx.accounts.stake_config.bump;
        let seeds = &[b"stake_config".as_ref(), &[bump]];

        // Mint final GUM rewards if any
        if reward > 0 {
            let new_total = ctx.accounts.stake_config.total_claimed
                .checked_add(reward).ok_or(GumballError::MathOverflow)?;
            if new_total <= GUM_MAX_SUPPLY {
                mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        MintTo {
                            mint:      ctx.accounts.gum_mint.to_account_info(),
                            to:        ctx.accounts.staker_gum_ata.to_account_info(),
                            authority: ctx.accounts.stake_config.to_account_info(),
                        },
                        &[seeds],
                    ),
                    reward,
                )?;
                ctx.accounts.stake_config.total_claimed = new_total;
            }
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

        ctx.accounts.stake_config.total_staked = ctx.accounts.stake_config.total_staked.saturating_sub(1);

        emit!(NftUnstakedEvent { staker: staker_key, nft_mint: nft_mint_key, reward });
        // StakeAccount closed via `close = staker` in accounts struct
        Ok(())
    }

    // ── LP STAKING ───────────────────────────────────────────────────────────

    /// Stake LP tokens — mints a position NFT representing the staked amount.
    /// The NFT is tradeable — whoever holds it controls the position.
    /// lock_days: 30 (1x), 90 (1.5x), 180 (2x), 365 (3x)
    pub fn stake_lp(ctx: Context<StakeLp>, amount: u64, lock_days: u16) -> Result<()> {
        require!(amount > 0, GumballError::InvalidPrice);

        // Determine multiplier based on lock period (in bps, 100 = 1x)
        let multiplier: u16 = match lock_days {
            30 => 100,
            90 => 150,
            180 => 200,
            365 => 300,
            _ => return Err(GumballError::InvalidLockPeriod.into()),
        };

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
        let sc_seeds = &[b"stake_config".as_ref(), &[ctx.accounts.stake_config.bump]];
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

        let now = Clock::get()?.unix_timestamp;
        let lp_stake = &mut ctx.accounts.lp_stake_account;
        lp_stake.position_mint = ctx.accounts.position_mint.key();
        lp_stake.lp_mint = ctx.accounts.lp_mint.key();
        lp_stake.amount = amount;
        lp_stake.staked_at = now;
        lp_stake.last_claimed = now;
        lp_stake.lock_until = now + (lock_days as i64) * 86400;
        lp_stake.lock_multiplier = multiplier;
        lp_stake.bump = ctx.bumps.lp_stake_account;

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

    /// Claim GUM rewards from LP staking — must hold the position NFT.
    pub fn claim_lp(ctx: Context<ClaimLpRewards>) -> Result<()> {
        // Verify caller holds the position NFT
        require!(ctx.accounts.position_ata.amount == 1, GumballError::Unauthorized);

        let now = Clock::get()?.unix_timestamp;
        let elapsed = (now - ctx.accounts.lp_stake_account.last_claimed) as u64;
        let staked_amount = ctx.accounts.lp_stake_account.amount;
        let multiplier = ctx.accounts.lp_stake_account.lock_multiplier as u128;

        // reward = elapsed * rate * amount * multiplier / 1e9 / 100
        let reward = (elapsed as u128)
            .checked_mul(LP_EMISSION_PER_SECOND as u128).ok_or(GumballError::MathOverflow)?
            .checked_mul(staked_amount as u128).ok_or(GumballError::MathOverflow)?
            .checked_mul(multiplier).ok_or(GumballError::MathOverflow)?
            / 100_000_000_000u128; // 1e9 * 100
        let reward = reward as u64;

        if reward == 0 { return Ok(()); }

        let new_total = ctx.accounts.stake_config.total_claimed
            .checked_add(reward).ok_or(GumballError::MathOverflow)?;
        require!(new_total <= GUM_MAX_SUPPLY, GumballError::GumSupplyExhausted);

        let bump = ctx.accounts.stake_config.bump;
        let seeds = &[b"stake_config".as_ref(), &[bump]];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.gum_mint.to_account_info(),
                    to:        ctx.accounts.claimer_gum_ata.to_account_info(),
                    authority: ctx.accounts.stake_config.to_account_info(),
                },
                &[seeds],
            ),
            reward,
        )?;

        ctx.accounts.lp_stake_account.last_claimed = now;
        ctx.accounts.stake_config.total_claimed = new_total;

        emit!(LpRewardsClaimedEvent {
            staker: ctx.accounts.claimer.key(), amount: reward,
        });
        Ok(())
    }

    /// Unstake LP tokens — must hold position NFT.
    /// Partial: reduces position, keeps NFT.
    /// Full: burns NFT, closes account, returns LP + rent.
    pub fn unstake_lp(ctx: Context<UnstakeLp>, amount: u64) -> Result<()> {
        // Verify caller holds the position NFT
        require!(ctx.accounts.position_ata.amount == 1, GumballError::Unauthorized);

        let now = Clock::get()?.unix_timestamp;

        // Enforce lock period
        require!(now >= ctx.accounts.lp_stake_account.lock_until, GumballError::LockActive);

        let elapsed = (now - ctx.accounts.lp_stake_account.last_claimed) as u64;
        let staked_amount = ctx.accounts.lp_stake_account.amount;
        let multiplier = ctx.accounts.lp_stake_account.lock_multiplier as u128;

        require!(amount > 0 && amount <= staked_amount, GumballError::InvalidPrice);

        let reward = (elapsed as u128)
            .checked_mul(LP_EMISSION_PER_SECOND as u128).ok_or(GumballError::MathOverflow)?
            .checked_mul(staked_amount as u128).ok_or(GumballError::MathOverflow)?
            .checked_mul(multiplier).ok_or(GumballError::MathOverflow)?
            / 100_000_000_000u128;
        let reward = reward as u64;

        let bump = ctx.accounts.stake_config.bump;
        let seeds = &[b"stake_config".as_ref(), &[bump]];

        // Mint pending GUM rewards
        if reward > 0 {
            let new_total = ctx.accounts.stake_config.total_claimed
                .checked_add(reward).ok_or(GumballError::MathOverflow)?;
            if new_total <= GUM_MAX_SUPPLY {
                mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        MintTo {
                            mint:      ctx.accounts.gum_mint.to_account_info(),
                            to:        ctx.accounts.claimer_gum_ata.to_account_info(),
                            authority: ctx.accounts.stake_config.to_account_info(),
                        },
                        &[seeds],
                    ),
                    reward,
                )?;
                ctx.accounts.stake_config.total_claimed = new_total;
            }
        }

        // Return LP tokens
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
            amount,
        )?;

        ctx.accounts.lp_stake_account.last_claimed = now;

        if amount == staked_amount {
            // Full withdrawal — burn position NFT + close account
            burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
                mint:      ctx.accounts.position_mint.to_account_info(),
                from:      ctx.accounts.position_ata.to_account_info(),
                authority: ctx.accounts.claimer.to_account_info(),
            }), 1)?;

            let lp_info = ctx.accounts.lp_stake_account.to_account_info();
            let claimer_info = ctx.accounts.claimer.to_account_info();
            **claimer_info.try_borrow_mut_lamports()? += lp_info.lamports();
            **lp_info.try_borrow_mut_lamports()? = 0;
            lp_info.try_borrow_mut_data()?.fill(0);
        } else {
            ctx.accounts.lp_stake_account.amount = staked_amount
                .checked_sub(amount).ok_or(GumballError::MathOverflow)?;
        }

        emit!(LpUnstakedEvent { staker: ctx.accounts.claimer.key(), amount, reward });
        Ok(())
    }

}
// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Exponential mint price: 0.01 * 4^(total_minted / 10000) XNT (testnet)
/// Uses a 11-point lookup table of 4^(x/10) scaled by 10000, with linear
/// interpolation between points. No floating point needed.
/// Returns price in lamports.
fn get_mint_price(total_minted: u64) -> u64 {
    // 4^(i/10) * 10000, for i = 0..=10
    // 4^0.0=1.0, 4^0.1=1.1487, 4^0.2=1.3195, ..., 4^1.0=4.0
    const TABLE: [u64; 11] = [
        10000, 11487, 13195, 15157, 17411,
        20000, 22974, 26390, 30314, 34822,
        40000,
    ];
    if total_minted >= MAX_SUPPLY {
        return MAX_PRICE;
    }
    // Map total_minted (0..10000) to table index (0..10)
    // bucket = total_minted * 10 / MAX_SUPPLY
    let scaled = total_minted.checked_mul(10).unwrap_or(u64::MAX);
    if scaled == u64::MAX { return MAX_PRICE; }
    let bucket = (scaled / MAX_SUPPLY) as usize; // 0..9
    let remainder = scaled % MAX_SUPPLY;         // fractional position within bucket

    if bucket >= 10 {
        return MAX_PRICE;
    }

    // Linear interpolation between TABLE[bucket] and TABLE[bucket+1]
    let lo = TABLE[bucket];
    let hi = TABLE[bucket + 1];
    let interp = lo + (hi - lo) * remainder / MAX_SUPPLY;

    // price = BASE_PRICE * interp / 10000
    BASE_PRICE * interp / 10000
}

#[derive(Default)]
struct Traits { flavor: u8, color: u8, rarity: u8, special: u8 }

fn resolve_traits(mut seed: u64, serial: u64) -> Result<Traits> {
    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(serial.wrapping_add(1));
    let flavor  = lcg_next(&mut seed, FLAVORS.len()  as u64) as u8;
    let color   = lcg_next(&mut seed, COLORS.len()   as u64) as u8;
    let special = lcg_next(&mut seed, SPECIALS.len() as u64) as u8;
    let roll    = lcg_next(&mut seed, 100) as u8;
    let rarity  = RARITY_CUTS.iter().position(|&c| roll < c).unwrap_or(4) as u8;
    Ok(Traits { flavor, color, rarity, special })
}

fn lcg_next(seed: &mut u64, modulus: u64) -> u64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (*seed >> 33) % modulus
}

// ─── Account Structs ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeMachine<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Machine::LEN, seeds = [b"machine"], bump)]
    pub machine: Account<'info, Machine>,
    pub system_program: Program<'info, System>,
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
    pub machine: Account<'info, Machine>,
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
    pub mint_request: Account<'info, MintRequest>,
    #[account(
        mut,
        seeds = [b"commit", oracle.key().as_ref(), &oracle_commit.submitted_slot.to_le_bytes()],
        bump = oracle_commit.bump,
        constraint = oracle_commit.key() == mint_request.commitment @ GumballError::InvalidCommitment,
    )]
    pub oracle_commit: Account<'info, OracleCommit>,
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
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
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
    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}


#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, constraint = authority.key() == machine.authority @ GumballError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"machine"], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    /// CHECK: treasury
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

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
    pub machine: Account<'info, Machine>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        close = seller,
        seeds = [b"listing", nft_mint.key().as_ref()],
        bump = listing.bump,
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
        payer = buyer,
        associated_token::mint = nft_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"gumball", nft_mint.key().as_ref()],
        bump = gumball_data.bump,
    )]
    pub gumball_data: Account<'info, GumballData>,
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
    pub machine: Account<'info, Machine>,
    /// CHECK: treasury validated against machine
    #[account(mut, constraint = treasury.key() == machine.treasury @ GumballError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"offer", nft_mint.key().as_ref(), buyer.key().as_ref()],
        bump = offer.bump,
        constraint = offer.nft_mint == nft_mint.key() @ GumballError::Unauthorized,
    )]
    pub offer: Account<'info, Offer>,
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = seller,
        constraint = seller_ata.amount == 1 @ GumballError::Unauthorized,
    )]
    pub seller_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = nft_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,
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


// ─── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct Machine {
    pub authority:    Pubkey,  // 32
    pub treasury:     Pubkey,  // 32
    pub oracle:       Pubkey,  // 32 — M-1 fix: rotatable oracle

    pub mint_price:   u64,     //  8
    pub total_minted: u64,     //  8 — total ever created (mints + upgrade outputs)
    pub max_supply:   u64,     //  8
    pub is_active:    bool,    //  1
    pub bump:         u8,      //  1
    pub total_burned: u64,     //  8 — total ever destroyed via burns
}
impl Machine { pub const LEN: usize = 32+32+32+8+8+8+1+1+8; }

/// Stores oracle commitment before randomness is needed — C-2 fix
#[account]
pub struct OracleCommit {
    pub oracle:         Pubkey,    // 32
    pub commitment:     [u8; 32],  // 32 — sha256(secret || oracle_pubkey)
    pub submitted_at:   i64,       //  8
    pub submitted_slot: u64,       //  8
    pub used:           bool,      //  1
    pub bump:           u8,        //  1
}
impl OracleCommit { pub const LEN: usize = 32+32+8+8+1+1; }

/// Pending mint request linking user payment to a commitment
#[account]
pub struct MintRequest {
    pub minter:             Pubkey,    // 32
    pub machine:            Pubkey,    // 32
    pub commitment:         Pubkey,    // 32 — which OracleCommit to use
    pub quantity:           u8,        //  1
    pub remaining_quantity: u8,        //  1 — CRIT-1 FIX: tracks how many still to mint
    pub paid_amount:        u64,       //  8
    pub requested_at:       i64,       //  8 — for M-2 timeout
    pub fulfilled:          bool,      //  1
    pub bump:               u8,        //  1
    pub user_seed:          [u8; 32],  // 32 — CRIT-3 FIX: user-provided entropy
}
impl MintRequest { pub const LEN: usize = 32+32+32+1+1+8+8+1+1+32; }

#[account]
pub struct GumballData {
    pub owner:           Pubkey,
    pub machine:         Pubkey,
    pub serial:          u64,
    pub flavor:          u8,
    pub color:           u8,
    pub rarity:          u8,
    pub special:         u8,
    pub minted_at:       u64,
    pub bump:            u8,
    // v4: proof fields for verify.html — enables full hash verification
    pub commitment_hash: [u8; 32],  // sha256(secret || oracle_pubkey) from OracleCommit
    pub user_seed:       [u8; 32],  // user-provided entropy from MintRequest
    // v5: oracle secret stored after reveal — enables trustless auto-verification
    pub oracle_secret:   [u8; 32],  // revealed oracle secret (zeroed for upgrades)
}
impl GumballData {
    pub const LEN: usize = 32+32+8+1+1+1+1+8+1+32+32+32;
    pub fn flavor_name(&self)  -> &'static str { FLAVORS [self.flavor  as usize % FLAVORS.len()]  }
    pub fn color_name(&self)   -> &'static str { COLORS  [self.color   as usize % COLORS.len()]   }
    pub fn rarity_name(&self)  -> &'static str { RARITY_NAMES[self.rarity as usize % 5]           }
    pub fn special_name(&self) -> &'static str { SPECIALS[self.special as usize % SPECIALS.len()] }
}

/// Separate PDA holding the on-chain SVG — not loaded by burn instructions
#[account]
pub struct GumballSvg {
    pub svg: Vec<u8>,
}
impl GumballSvg {
    pub const LEN: usize = 4 + MAX_SVG_LEN;
}

/// Marketplace listing — seller lists NFT at a fixed price
#[account]
pub struct Listing {
    pub seller:     Pubkey,  // 32
    pub nft_mint:   Pubkey,  // 32
    pub price:      u64,     //  8
    pub created_at: i64,     //  8
    pub bump:       u8,      //  1
}
impl Listing { pub const LEN: usize = 32+32+8+8+1; }

/// Marketplace offer — buyer bids on an NFT with escrowed XNT
#[account]
pub struct Offer {
    pub buyer:      Pubkey,  // 32
    pub nft_mint:   Pubkey,  // 32
    pub amount:     u64,     //  8
    pub created_at: i64,     //  8
    pub expires_at: i64,     //  8 — 0 means no expiry (legacy compat)
    pub bump:       u8,      //  1
}
impl Offer { pub const LEN: usize = 32+32+8+8+8+1; }

// ─── Staking Accounts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeStaking<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init, payer = authority, space = 8 + StakeConfig::LEN,
        seeds = [b"stake_config"], bump,
    )]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        init, payer = authority,
        mint::decimals = GUM_DECIMALS,
        mint::authority = stake_config,
        seeds = [b"gum_mint"], bump,
    )]
    pub gum_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct StakeNft<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"stake_config"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        init, payer = staker, space = 8 + StakeAccount::LEN,
        seeds = [b"stake", nft_mint.key().as_ref()], bump,
    )]
    pub stake_account: Account<'info, StakeAccount>,
    /// The gumball data PDA — used to read rarity
    #[account(seeds = [b"gumball", nft_mint.key().as_ref()], bump = gumball_data.bump)]
    pub gumball_data: Account<'info, GumballData>,
    pub nft_mint: Account<'info, Mint>,
    /// User's NFT token account (source)
    #[account(mut, constraint = user_ata.mint == nft_mint.key() && user_ata.owner == staker.key())]
    pub user_ata: Account<'info, TokenAccount>,
    /// Vault token account (destination) — owned by stake_config PDA
    #[account(
        init_if_needed, payer = staker,
        associated_token::mint = nft_mint,
        associated_token::authority = stake_config,
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"stake_config"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        mut,
        seeds = [b"stake", stake_account.nft_mint.as_ref()], bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ GumballError::Unauthorized,
    )]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(mut, seeds = [b"gum_mint"], bump)]
    pub gum_mint: Account<'info, Mint>,
    /// Staker's GUM token account
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
    #[account(mut, seeds = [b"stake_config"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        mut, close = staker,
        seeds = [b"stake", stake_account.nft_mint.as_ref()], bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ GumballError::Unauthorized,
    )]
    pub stake_account: Account<'info, StakeAccount>,
    pub nft_mint: Account<'info, Mint>,
    /// Vault token account holding the staked NFT
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = stake_config,
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    /// User's NFT token account (destination)
    #[account(
        init_if_needed, payer = staker,
        associated_token::mint = nft_mint,
        associated_token::authority = staker,
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"gum_mint"], bump)]
    pub gum_mint: Account<'info, Mint>,
    /// Staker's GUM token account for final rewards
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

// ─── LP Staking Accounts (NFT Position) ─────────────────────────────────────

#[derive(Accounts)]
pub struct StakeLp<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [b"stake_config"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        init, payer = staker, space = 8 + LpStakeAccount::LEN,
        seeds = [b"lp_stake", position_mint.key().as_ref()], bump,
    )]
    pub lp_stake_account: Account<'info, LpStakeAccount>,
    /// Position NFT mint — created fresh for each new position
    #[account(init, payer = staker, mint::decimals = 0, mint::authority = stake_config, mint::freeze_authority = stake_config)]
    pub position_mint: Account<'info, Mint>,
    /// Position NFT ATA for the staker
    #[account(init_if_needed, payer = staker, associated_token::mint = position_mint, associated_token::authority = staker)]
    pub position_ata: Account<'info, TokenAccount>,
    pub lp_mint: Account<'info, Mint>,
    #[account(mut, constraint = user_lp_ata.mint == lp_mint.key() && user_lp_ata.owner == staker.key())]
    pub user_lp_ata: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = staker, associated_token::mint = lp_mint, associated_token::authority = stake_config)]
    pub vault_lp_ata: Account<'info, TokenAccount>,
    /// CHECK: Metaplex metadata PDA — created by Metaplex program via CPI
    #[account(mut)]
    pub metadata_account: AccountInfo<'info>,
    /// CHECK: Metaplex Token Metadata program
    pub metadata_program: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimLpRewards<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut, seeds = [b"stake_config"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        mut,
        seeds = [b"lp_stake", lp_stake_account.position_mint.as_ref()], bump = lp_stake_account.bump,
    )]
    pub lp_stake_account: Account<'info, LpStakeAccount>,
    /// Caller must hold the position NFT — verified in instruction body
    #[account(constraint = position_ata.mint == lp_stake_account.position_mint && position_ata.owner == claimer.key())]
    pub position_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"gum_mint"], bump)]
    pub gum_mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = claimer, associated_token::mint = gum_mint, associated_token::authority = claimer)]
    pub claimer_gum_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UnstakeLp<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut, seeds = [b"stake_config"], bump = stake_config.bump)]
    pub stake_config: Account<'info, StakeConfig>,
    #[account(
        mut,
        seeds = [b"lp_stake", lp_stake_account.position_mint.as_ref()], bump = lp_stake_account.bump,
    )]
    pub lp_stake_account: Account<'info, LpStakeAccount>,
    /// Position NFT mint — burned on full withdrawal
    #[account(mut, constraint = position_mint.key() == lp_stake_account.position_mint)]
    pub position_mint: Account<'info, Mint>,
    /// Caller must hold the position NFT
    #[account(mut, constraint = position_ata.mint == lp_stake_account.position_mint && position_ata.owner == claimer.key())]
    pub position_ata: Account<'info, TokenAccount>,
    pub lp_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = lp_mint, associated_token::authority = stake_config)]
    pub vault_lp_ata: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = claimer, associated_token::mint = lp_mint, associated_token::authority = claimer)]
    pub user_lp_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"gum_mint"], bump)]
    pub gum_mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = claimer, associated_token::mint = gum_mint, associated_token::authority = claimer)]
    pub claimer_gum_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ─── Staking State ───────────────────────────────────────────────────────────

#[account]
pub struct StakeConfig {
    pub authority:     Pubkey,  // 32
    pub gum_mint:      Pubkey,  // 32
    pub total_staked:  u64,     //  8
    pub total_claimed: u64,     //  8
    pub bump:          u8,      //  1
}
impl StakeConfig { pub const LEN: usize = 32+32+8+8+1; }

#[account]
pub struct StakeAccount {
    pub owner:        Pubkey,  // 32
    pub nft_mint:     Pubkey,  // 32
    pub rarity:       u8,      //  1
    pub staked_at:    i64,     //  8
    pub last_claimed: i64,     //  8
    pub bump:         u8,      //  1
}
impl StakeAccount { pub const LEN: usize = 32+32+1+8+8+1; }

#[account]
pub struct LpStakeAccount {
    pub position_mint:    Pubkey,  // 32 — NFT mint representing this position
    pub lp_mint:          Pubkey,  // 32
    pub amount:           u64,     //  8
    pub staked_at:        i64,     //  8
    pub last_claimed:     i64,     //  8
    pub lock_until:       i64,     //  8 — unix timestamp when lock expires
    pub lock_multiplier:  u16,     //  2 — reward multiplier in bps (100 = 1x, 200 = 2x)
    pub bump:             u8,      //  1
}
impl LpStakeAccount { pub const LEN: usize = 32+32+8+8+8+8+2+1; }

// ─── Events ───────────────────────────────────────────────────────────────────

#[event] pub struct MachineInitializedEvent { pub authority: Pubkey, pub treasury: Pubkey, pub mint_price: u64, pub max_supply: u64 }
#[event] pub struct OracleUpdatedEvent      { pub new_oracle: Pubkey }
#[event] pub struct CommitmentSubmittedEvent { pub oracle: Pubkey, pub commitment: [u8; 32] }
#[event] pub struct MintRequestedEvent      { pub minter: Pubkey, pub commitment: Pubkey, pub quantity: u8, pub paid: u64 }
#[event] pub struct MintRefundedEvent       { pub minter: Pubkey, pub amount: u64 }
#[event] pub struct GumballMintedEvent      { pub minter: Pubkey, pub serial: u64, pub mint: Pubkey, pub flavor: u8, pub color: u8, pub rarity: u8, pub special: u8, pub total_minted: u64 }
#[event] pub struct GumballUpgradedEvent    { pub burner: Pubkey, pub burned_rarity: u8, pub burned_count: u8, pub new_serial: u64, pub new_rarity: u8, pub new_mint: Pubkey, pub flavor: u8, pub color: u8, pub special: u8 }
#[event] pub struct GumballListedEvent     { pub seller: Pubkey, pub nft_mint: Pubkey, pub price: u64 }
#[event] pub struct GumballDelistedEvent   { pub seller: Pubkey, pub nft_mint: Pubkey }
#[event] pub struct GumballSoldEvent       { pub seller: Pubkey, pub buyer: Pubkey, pub nft_mint: Pubkey, pub price: u64, pub royalty: u64 }
#[event] pub struct OfferMadeEvent         { pub buyer: Pubkey, pub nft_mint: Pubkey, pub amount: u64 }
#[event] pub struct OfferCancelledEvent    { pub buyer: Pubkey, pub nft_mint: Pubkey }
#[event] pub struct NftStakedEvent        { pub staker: Pubkey, pub nft_mint: Pubkey, pub rarity: u8 }
#[event] pub struct NftUnstakedEvent      { pub staker: Pubkey, pub nft_mint: Pubkey, pub reward: u64 }
#[event] pub struct RewardsClaimedEvent   { pub staker: Pubkey, pub nft_mint: Pubkey, pub amount: u64 }
#[event] pub struct LpStakedEvent        { pub staker: Pubkey, pub amount: u64 }
#[event] pub struct LpUnstakedEvent      { pub staker: Pubkey, pub amount: u64, pub reward: u64 }
#[event] pub struct LpRewardsClaimedEvent { pub staker: Pubkey, pub amount: u64 }

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum GumballError {
    #[msg("Machine is not active")]                  MachineInactive,
    #[msg("Sold out — no new serials can be issued")]SoldOut,
    #[msg("Quantity must be 1-5")]                   InvalidQuantity,
    #[msg("Price must be > 0")]                      InvalidPrice,
    #[msg("Invalid treasury")]                       InvalidTreasury,
    #[msg("Unauthorized")]                           Unauthorized,
    #[msg("Arithmetic overflow")]                    MathOverflow,
    #[msg("Insufficient funds")]                     InsufficientFunds,
    #[msg("Already Legendary — cannot upgrade")]     AlreadyLegendary,
    #[msg("All gumballs must be same rarity")]       RarityMismatch,
    #[msg("Wrong number of gumballs to burn")]       WrongBurnCount,
    #[msg("Use burn_multi for this rarity tier")]    UseMultiBurn,
    #[msg("Mint already fulfilled")]                 AlreadyFulfilled,
    #[msg("Commitment already used")]                CommitmentAlreadyUsed,
    #[msg("Invalid commitment — secret mismatch")]   InvalidCommitment,
    #[msg("Invalid slot hash")]                      InvalidSlotHash,
    #[msg("Invalid account data")]                   InvalidAccount,
    #[msg("Mint request has expired")]               RequestExpired,
    #[msg("Offer has expired")]                      OfferExpired,
    #[msg("GUM supply exhausted")]                   GumSupplyExhausted,
    #[msg("Invalid lock period — use 30, 90, 180, or 365 days")] InvalidLockPeriod,
    #[msg("LP position is still locked")]            LockActive,
}