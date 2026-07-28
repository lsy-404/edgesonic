#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Runs every suite under test/ and prints one line per file, then a summary.
# Exits non-zero if any suite fails, so it can gate a release.
#
#   ./test/run-all.sh              every suite
#   ./test/run-all.sh internal     only test/internal
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

filter="${1:-}"
pattern="test/*/*.test.ts"
[ -n "$filter" ] && pattern="test/$filter/*.test.ts"

# Suites that import .vue components need the SFC compiler; tsx cannot parse
# them. Their config lives beside them in test/frontend.
needs_vite_node() {
  grep -qE '^import .* from "[^"]*\.vue"' "$1"
}

pass=0; fail=0; failed=()
for f in $pattern; do
  [ -e "$f" ] || continue
  if needs_vite_node "$f"; then
    out=$(npx vite-node -c test/frontend/vite-node.config.mts "$f" 2>&1)
  else
    out=$(npx tsx "$f" 2>&1)
  fi
  if [ $? -eq 0 ]; then
    pass=$((pass + 1))
    printf "  ok   %s\n" "${f#test/}"
  else
    fail=$((fail + 1)); failed+=("$f")
    reason=$(printf '%s' "$out" | grep -Eo "Cannot find module '[^']*'|no such table: [a-z_]+|no such column: [a-z_.]+|[0-9]+ (assertion\(s\)|FAILURE\(S\)) failed|[0-9]+ FAILURE\(S\)|Transform failed|SyntaxError" | head -1)
    printf "  FAIL %s%s\n" "${f#test/}" "${reason:+  — $reason}"
  fi
done

echo
echo "$pass passed, $fail failed"
[ $fail -eq 0 ] || { printf '%s\n' "${failed[@]}" | sed 's/^/  /'; exit 1; }
