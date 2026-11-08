use crate::*;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Advance the NFT-staking accumulator to `now`. Distributes vault emission
/// (0.3% of vault balance per day) pro-rata across the current `total_nft_weight`.
/// Must be called before any change to `total_nft_weight` or any reward calculation.
pub(crate) fn update_nft_accumulator(config: &mut StakeConfig, vault_balance: u64, now: i64) -> Result<()> {
    let last = config.last_nft_emission_update;
    if now <= last { return Ok(()); }
    let elapsed = (now - last) as u64;
    if elapsed == 0 || config.total_nft_weight == 0 || vault_balance == 0 {
        config.last_nft_emission_update = now;
        return Ok(());
    }
    // emission_gum = vault_balance × bps × elapsed / 10000 / 86400
    let emission = (vault_balance as u128)
        .checked_mul(EMISSION_BPS_PER_DAY as u128).ok_or(GumballError::MathOverflow)?
        .checked_mul(elapsed as u128).ok_or(GumballError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128 * SECONDS_PER_DAY as u128)
        .ok_or(GumballError::MathOverflow)?;
    let delta_acc = emission
        .checked_mul(ACC_SCALE).ok_or(GumballError::MathOverflow)?
        .checked_div(config.total_nft_weight)
        .ok_or(GumballError::MathOverflow)?;
    config.acc_nft_reward_per_weight = config.acc_nft_reward_per_weight
        .checked_add(delta_acc).ok_or(GumballError::MathOverflow)?;
    config.last_nft_emission_update = now;
    Ok(())
}

/// Advance the XNT-fee accumulator for one stream (NFT or LP). Reads the
/// current pool balance and credits any unseen lamports to the per-weight
/// accumulator. Must be called before any reward calculation OR before the
/// pool balance changes via claim/deposit.
pub(crate) fn update_xnt_accumulator(state: &mut XntFeeState, pool_balance: u64, total_weight: u128) -> Result<()> {
    if pool_balance <= state.last_seen_balance || total_weight == 0 {
        // Either no new lamports OR no stakers to distribute to. With no
        // stakers, last_seen is left unchanged here; the stake path
        // (advance_xnt_for_stake) absorbs any zero-weight backlog into
        // last_seen so a flash-staker can't capture it, and the admin can
        // recover that surplus via sweep_xnt_pool_* while weight is zero.
        return Ok(());
    }
    let delta = (pool_balance - state.last_seen_balance) as u128;
    let delta_acc = delta
        .checked_mul(ACC_SCALE).ok_or(GumballError::MathOverflow)?
        .checked_div(total_weight).ok_or(GumballError::MathOverflow)?;
    state.acc_xnt_per_weight = state.acc_xnt_per_weight
        .checked_add(delta_acc).ok_or(GumballError::MathOverflow)?;
    state.last_seen_balance = pool_balance;
    Ok(())
}

/// Advance the XNT accumulator ahead of a total-weight INCREASE (HIGH-1).
/// When nobody is staked, lamports that arrived while total_weight == 0 are
/// absorbed into `last_seen_balance` instead of being credited — otherwise the
/// incoming staker could capture the entire backlog with a flash stake.
/// Absorbed lamports remain in the pool as unattributed surplus; the admin can
/// recover them to treasury via sweep_xnt_pool_* while the stream has no stakers.
pub(crate) fn advance_xnt_for_stake(state: &mut XntFeeState, pool_balance: u64, old_total_weight: u128) -> Result<()> {
    if old_total_weight == 0 {
        state.last_seen_balance = pool_balance;
    }
    update_xnt_accumulator(state, pool_balance, old_total_weight)
}

/// Settle a position's pending XNT fee share (shared by unstake, unstake_lp,
/// claim_xnt_fees_nft, claim_xnt_fees_lp):
///   - CRIT-3: a first-touch XntDebt (bump == 0, i.e. freshly init_if_needed'd
///     for a position staked before XntDebt existed) is snapshotted at the
///     current accumulator WITHOUT payout — historical accumulator value is
///     not credited to it.
///   - CRIT-1: the pool's rent-exempt minimum is always reserved so the PDA
///     can never be tombstoned.
///   - Debt advances by ONLY the amount actually paid, so a remainder the pool
///     can't cover right now stays pending instead of being forfeited.
/// Returns (paid, remaining_pending).
pub(crate) fn settle_xnt_fees<'info>(
    state: &mut XntFeeState,
    pool_info: &AccountInfo<'info>,
    recipient_info: &AccountInfo<'info>,
    xnt_debt: &mut XntDebt,
    weight: u128,
    canonical_bump: u8,
) -> Result<(u64, u128)> {
    let entitled = weight
        .checked_mul(state.acc_xnt_per_weight).ok_or(GumballError::MathOverflow)?
        / ACC_SCALE;
    if xnt_debt.bump == 0 {
        xnt_debt.debt = entitled;
        xnt_debt.bump = canonical_bump;
        return Ok((0, 0));
    }
    let pending = entitled.saturating_sub(xnt_debt.debt);
    if pending == 0 {
        return Ok((0, 0));
    }
    let rent_min = Rent::get()?.minimum_balance(8 + XntPool::LEN);
    let withdrawable = pool_info.lamports().saturating_sub(rent_min);
    let to_pay = (pending.min(withdrawable as u128)) as u64;
    if to_pay > 0 {
        **pool_info.try_borrow_mut_lamports()? -= to_pay;
        **recipient_info.try_borrow_mut_lamports()? += to_pay;
        // Maintain the last_seen invariant — the pool just shrank by to_pay.
        state.last_seen_balance = state.last_seen_balance.saturating_sub(to_pay);
        emit!(XntFeeClaimedEvent {
            claimer: recipient_info.key(),
            stake_type: state.stake_type,
            amount: to_pay,
        });
    }
    xnt_debt.debt = xnt_debt.debt
        .checked_add(to_pay as u128).ok_or(GumballError::MathOverflow)?;
    Ok((to_pay, pending - to_pay as u128))
}

/// Close a per-position XntDebt PDA and refund its rent to `recipient`.
/// Safe wherever the position itself is being closed: stake paths re-create
/// the PDA via init_if_needed and re-snapshot the debt, so no state is lost.
/// Same manual-close pattern as the LpStakeAccount close in unstake_lp.
pub(crate) fn close_xnt_debt<'info>(
    debt_info: &AccountInfo<'info>,
    recipient_info: &AccountInfo<'info>,
) -> Result<()> {
    **recipient_info.try_borrow_mut_lamports()? += debt_info.lamports();
    **debt_info.try_borrow_mut_lamports()? = 0;
    debt_info.try_borrow_mut_data()?.fill(0);
    Ok(())
}

/// Shared body for sweep_xnt_pool_nft / sweep_xnt_pool_lp. Caller has already
/// verified the stream's total weight is zero (no live entitlements exist).
pub(crate) fn sweep_xnt_pool<'info>(
    state: &mut XntFeeState,
    pool_info: &AccountInfo<'info>,
    treasury_info: &AccountInfo<'info>,
) -> Result<()> {
    let rent_min = Rent::get()?.minimum_balance(8 + XntPool::LEN);
    let surplus = pool_info.lamports().saturating_sub(rent_min);
    require!(surplus > 0, GumballError::InsufficientFunds);
    **pool_info.try_borrow_mut_lamports()? -= surplus;
    **treasury_info.try_borrow_mut_lamports()? += surplus;
    // Re-baseline: with zero stakers and the surplus gone, the pool holds only
    // its rent again. This also clears historical drift (e.g. state accounts
    // initialized pre-CRIT-2 that counted pool rent as fee revenue).
    state.last_seen_balance = pool_info.lamports();
    Ok(())
}

/// Same logic for the LP-staking accumulator.
pub(crate) fn update_lp_accumulator(config: &mut StakeConfig, vault_balance: u64, now: i64) -> Result<()> {
    let last = config.last_lp_emission_update;
    if now <= last { return Ok(()); }
    let elapsed = (now - last) as u64;
    if elapsed == 0 || config.total_lp_weight == 0 || vault_balance == 0 {
        config.last_lp_emission_update = now;
        return Ok(());
    }
    let emission = (vault_balance as u128)
        .checked_mul(EMISSION_BPS_PER_DAY as u128).ok_or(GumballError::MathOverflow)?
        .checked_mul(elapsed as u128).ok_or(GumballError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128 * SECONDS_PER_DAY as u128)
        .ok_or(GumballError::MathOverflow)?;
    let delta_acc = emission
        .checked_mul(ACC_SCALE).ok_or(GumballError::MathOverflow)?
        .checked_div(config.total_lp_weight)
        .ok_or(GumballError::MathOverflow)?;
    config.acc_lp_reward_per_weight = config.acc_lp_reward_per_weight
        .checked_add(delta_acc).ok_or(GumballError::MathOverflow)?;
    config.last_lp_emission_update = now;
    Ok(())
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xnt_accumulator_credits_and_baselines() {
        let mut s = XntFeeState { stake_type: 0, acc_xnt_per_weight: 0, last_seen_balance: 1000, bump: 255 };
        // no stakers → nothing credited, last_seen untouched (reserved for absorb)
        update_xnt_accumulator(&mut s, 5000, 0).unwrap();
        assert_eq!(s.acc_xnt_per_weight, 0);
        assert_eq!(s.last_seen_balance, 1000);
        // stakers present → delta credited per weight, last_seen advances
        update_xnt_accumulator(&mut s, 5000, 4).unwrap();
        assert_eq!(s.acc_xnt_per_weight, 4000 * ACC_SCALE / 4);
        assert_eq!(s.last_seen_balance, 5000);
        // balance decreased (payout happened) → no negative credit
        update_xnt_accumulator(&mut s, 4000, 4).unwrap();
        assert_eq!(s.acc_xnt_per_weight, 4000 * ACC_SCALE / 4);
        // absorb path: zero-weight backlog folded into last_seen, nothing credited
        let mut s2 = XntFeeState { stake_type: 1, acc_xnt_per_weight: 7, last_seen_balance: 100, bump: 255 };
        advance_xnt_for_stake(&mut s2, 9000, 0).unwrap();
        assert_eq!(s2.acc_xnt_per_weight, 7);
        assert_eq!(s2.last_seen_balance, 9000);
    }
}
