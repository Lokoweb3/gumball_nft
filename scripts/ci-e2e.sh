#!/usr/bin/env bash
# Runs the 25-check staking/fee validation suite against a local validator
# seeded with fixtures (see scripts/make-localnet-fixtures.cjs).
# Used by CI (.github/workflows/tests.yml); also works locally on Linux/WSL:
#   OUT_DIR=localnet-fixtures node scripts/make-localnet-fixtures.cjs
#   FIXTURES=localnet-fixtures bash scripts/ci-e2e.sh
set -euo pipefail

FIXTURES=${FIXTURES:-localnet-fixtures}
PROGRAM_ID=AEahf37KaS548ErtW6RnDtwYrTxxJqkMgg79W9dSNhCy
SO=${SO:-target/deploy/gumball_nft.so}
RPC_URL=http://127.0.0.1:8899

[ -f "$SO" ] || { echo "program binary missing: $SO (run anchor build / cargo build-sbf)"; exit 1; }

# Account fixtures are the JSONs with a .pubkey field (skips treasury-keypair.json)
ARGS=()
for f in "$FIXTURES"/*.json; do
  PK=$(node -pe "require('./$f').pubkey ?? ''" 2>/dev/null || true)
  [ -n "$PK" ] && ARGS+=(--account "$PK" "$f")
done
echo "Loaded ${#ARGS[@]} validator args from $FIXTURES"

solana-test-validator --reset --quiet --ledger ci-test-ledger \
  --bpf-program "$PROGRAM_ID" "$SO" "${ARGS[@]}" &
VALIDATOR_PID=$!
trap 'kill $VALIDATOR_PID 2>/dev/null || true' EXIT

echo "Waiting for validator RPC..."
for i in $(seq 1 60); do
  if solana cluster-version -u "$RPC_URL" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { echo "validator never came up"; exit 1; }
  sleep 2
done
echo "Validator up."

NFT_MINT=$(cat "$FIXTURES/nft-mint-pubkey.txt")
TREASURY=$(node -pe "const{Keypair}=require('@solana/web3.js');Keypair.fromSecretKey(Uint8Array.from(require('./$FIXTURES/treasury-keypair.json'))).publicKey.toBase58()")

RPC="$RPC_URL" NFT_MINT="$NFT_MINT" TREASURY="$TREASURY" node scripts/validate-staking-localnet.cjs
