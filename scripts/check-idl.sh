#!/usr/bin/env bash
# Rebuilds the IDL and diffs it against tests/idl.golden.json (refactor safety net).
# Uses `cargo test --features idl-build` (what `anchor idl build` runs underneath).
#   scripts/check-idl.sh            diff against the golden file
#   scripts/check-idl.sh --update   regenerate the golden file
set -euo pipefail
cd "$(dirname "$0")/.."
GOLDEN=tests/idl.golden.json
NEW=$(mktemp)
trap 'rm -f "$NEW"' EXIT
(cd programs/gumball_nft && cargo test --features idl-build __anchor_private_print_idl -- --show-output --test-threads=1 2>/dev/null) \
  | node scripts/lib/idl-canon.cjs > "$NEW"
[ -s "$NEW" ] || { echo "IDL build produced no output"; exit 1; }
if [ "${1:-}" = "--update" ]; then cp "$NEW" "$GOLDEN"; echo "golden updated"; exit 0; fi
if diff -u "$GOLDEN" "$NEW"; then echo "IDL IDENTICAL to $GOLDEN"; else echo "IDL DIFFERS"; exit 1; fi
