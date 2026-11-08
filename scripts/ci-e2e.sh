#!/usr/bin/env bash
# Runs the staking/fee validation suite (25 checks) plus the vulnerability
# regression tests (B1/B2/B3) against a local validator seeded with fixtures (see scripts/make-localnet-fixtures.cjs).
# Used by CI (.github/workflows/tests.yml); also works locally on Linux/WSL:
#   OUT_DIR=localnet-fixtures node scripts/make-localnet-fixtures.cjs
#   FIXTURES=localnet-fixtures bash scripts/ci-e2e.sh
set -euo pipefail

FIXTURES=${FIXTURES:-localnet-fixtures}
PROGRAM_ID=AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy
SO=${SO:-target/deploy/gumball_nft.so}
RPC_URL=http://127.0.0.1:8899

[ -f "$SO" ] || { echo "program binary missing: $SO (run anchor build / cargo build-sbf)"; exit 1; }

# Extra fixtures for the staking-vulnerability tests (B1/B2/B3). A file here
# with the same name as a base fixture (stake_config.json) replaces it.
ATTACK_DIR=$(mktemp -d)
FIXTURES="$FIXTURES" OUT_DIR="$ATTACK_DIR" node scripts/make-staking-attack-fixtures.cjs

# The fair-seed suite reveals mints, so it needs the Machine's oracle to be a key we hold.
# Use a COPY of the machine fixture patched to a throwaway oracle (shared fixtures untouched).
FAIR_DIR=ci-fairseed-fixtures
rm -rf "$FAIR_DIR"
node scripts/make-fairseed-fixtures.cjs "$FIXTURES" "$FAIR_DIR"

# Account fixtures are the JSONs with a .pubkey field (skips treasury-keypair.json)
ARGS=()
for f in "$FIXTURES"/*.json; do
  [ -f "$ATTACK_DIR/$(basename "$f")" ] && continue
  [ "$(basename "$f")" = machine.json ] && f="$FAIR_DIR/machine.json"
  PK=$(node -pe "require('./$f').pubkey ?? ''" 2>/dev/null || true)
  [ -n "$PK" ] && ARGS+=(--account "$PK" "$f")
done
for f in "$ATTACK_DIR"/*.json; do
  PK=$(node -pe "require('$f').pubkey ?? ''" 2>/dev/null || true)
  [ -n "$PK" ] && ARGS+=(--account "$PK" "$f")
done
echo "Loaded ${#ARGS[@]} validator args from $FIXTURES"

# CI runners can be slow and resource-constrained
ulimit -n 1000000 2>/dev/null || true

# The program is loaded as UPGRADEABLE with the local wallet as upgrade
# authority so the initialize_machine gate (S2) is testable. Same wallet path
# the suites use (WALLET, else ~/.config/solana/id.json).
WALLET_FILE=${WALLET:-$HOME/.config/solana/id.json}
AUTHORITY=$(node -pe "const{Keypair}=require('@solana/web3.js');Keypair.fromSecretKey(Uint8Array.from(require('$WALLET_FILE'))).publicKey.toBase58()")

dump_log() {
  echo "── validator.log tail ──"
  tail -40 ci-test-ledger/validator.log 2>/dev/null || echo "(no validator log)"
}
trap 'kill $VALIDATOR_PID 2>/dev/null || true; rm -rf "$ATTACK_DIR" "$FAIR_DIR"' EXIT

# start_validator [extra args...]; $FRESH=1 resets the ledger and loads the program
start_validator() {
  if [ "${FRESH:-0}" = 2 ]; then
    # clean validator, no fixtures: program only, so no Machine PDA exists
    solana-test-validator --reset --quiet --ledger ci-test-ledger-init \
      --upgradeable-program "$PROGRAM_ID" "$SO" "$AUTHORITY" &
  elif [ "${FRESH:-0}" = 1 ]; then
    solana-test-validator --reset --quiet --ledger ci-test-ledger \
      --limit-ledger-size 10000 \
      --upgradeable-program "$PROGRAM_ID" "$SO" "$AUTHORITY" "${ARGS[@]}" &
  else
    solana-test-validator --quiet --ledger ci-test-ledger \
      --limit-ledger-size 10000 "$@" &
  fi
  VALIDATOR_PID=$!
  echo "Waiting for validator RPC (up to 5 min)..."
  for i in $(seq 1 150); do
    if ! kill -0 $VALIDATOR_PID 2>/dev/null; then
      echo "validator process DIED"; dump_log; exit 1
    fi
    if solana cluster-version -u "$RPC_URL" >/dev/null 2>&1; then break; fi
    [ "$i" = 150 ] && { echo "validator never came up"; dump_log; exit 1; }
    sleep 2
  done
  echo "Validator up after ~$((i*2))s."
}

FRESH=1 start_validator

NFT_MINT=$(cat "$FIXTURES/nft-mint-pubkey.txt")
TREASURY=$(node -pe "const{Keypair}=require('@solana/web3.js');Keypair.fromSecretKey(Uint8Array.from(require('./$FIXTURES/treasury-keypair.json'))).publicKey.toBase58()")

if ! ATTACK_INFO="$ATTACK_DIR/attack-info.json" RPC="$RPC_URL" NFT_MINT="$NFT_MINT" TREASURY="$TREASURY" node scripts/validate-staking-localnet.cjs; then
  dump_log
  exit 1
fi

# Fair-seed mints: seed slot fixed at request time (see DEPLOY.md 0.5). ~3 min: includes the 150 s timeout refund.
if ! RPC="$RPC_URL" ORACLE_KEYPAIR="$FAIR_DIR/oracle.json" node scripts/validate-fairseed-localnet.cjs; then
  dump_log
  exit 1
fi

# Auctions, phase 1 (live): create_auction guards, dust-bid outbid, escrow, refund.
AUCTION_STATE=$(pwd)/ci-auction-state.json
FIXTURE_DIR=$(pwd)/ci-auction-fixtures
export AUCTION_STATE FIXTURE_DIR
rm -rf "$AUCTION_STATE" "$FIXTURE_DIR"
if ! RPC="$RPC_URL" NFT_MINT="$NFT_MINT" TREASURY="$TREASURY" AUCTION_PHASE=1 node scripts/validate-auction-localnet.cjs; then
  dump_log
  exit 1
fi

# Auctions, phase 2 (settle): the minimum auction is 1h and the validator cannot
# warp mid-run, so settle runs on a fresh validator seeded with an already-ended
# auction + escrowed NFT written in the on-chain layout.
kill $VALIDATOR_PID; wait $VALIDATOR_PID 2>/dev/null || true
RPC="$RPC_URL" NFT_MINT="$NFT_MINT" TREASURY="$TREASURY" AUCTION_PHASE=fixture node scripts/validate-auction-localnet.cjs
for f in "$FIXTURE_DIR"/*.json; do
  ARGS+=(--account "$(node -pe "require('$f').pubkey")" "$f")
done
FRESH=1 start_validator
if ! RPC="$RPC_URL" NFT_MINT="$NFT_MINT" TREASURY="$TREASURY" AUCTION_PHASE=2 node scripts/validate-auction-localnet.cjs; then
  dump_log
  exit 1
fi
rm -rf "$AUCTION_STATE" "$FIXTURE_DIR"

# S2: initialize_machine upgrade-authority gate, on a clean validator with no
# Machine PDA (the fixture ledger already has one, which masks the gate).
kill $VALIDATOR_PID; wait $VALIDATOR_PID 2>/dev/null || true
FRESH=2 start_validator
if ! RPC="$RPC_URL" TREASURY="$TREASURY" node scripts/validate-init-gate-localnet.cjs; then
  dump_log
  exit 1
fi

