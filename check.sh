#!/usr/bin/env bash
# Acceptance checklist. Every phase runs or fails the build: a phase that
# cannot run is a red result, never a skip. Printing ALL CHECKS PASSED after
# having executed nothing is worse than erroring, because it describes the code
# as verified when nothing was.
#
# Run inside the pinned toolchain:  nix develop --command ./check.sh
set -uo pipefail
cd "$(dirname "$0")"

NODE=${NODE:-$(command -v node || true)}
STATUS=0
report() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; STATUS=1; }

# --engine picks the browser for the golden comparison; --update rewrites the
# baselines and is a developer action, never a CI one.
ENGINE=firefox
ARGS=()
for ((i = 1; i <= $#; i++)); do
  case "${!i}" in
    --engine) i=$((i + 1)); ENGINE="${!i:-}" ;;
    *) ARGS+=("${!i}") ;;
  esac
done
[[ -z $ENGINE ]] && { echo "--engine needs a value" >&2; exit 2; }

if [[ -z $NODE ]]; then
  fail "node is not on PATH. Run: nix develop --command ./check.sh"
  exit $STATUS
fi

# Test scratch space. Redirects below assume it exists; a fresh checkout (CI)
# has none, and a redirect to a missing directory fails before the command
# runs, which reports a harness error rather than a test result.
mkdir -p .tmp

# 1. Build. Tests read the artifact, so a stale artifact must never pass.
report "1/5 build artifact"
if "$NODE" tools/build.mjs; then :; else fail "build failed"; fi

# 2. Syntax. Localises an error to the file that has it rather than to whichever
#    test imported it first. The artifact is checked too, extracted from its page.
report "2/5 syntax"
for file in src/*.js tools/*.mjs tests/*.mjs; do
  if ! "$NODE" --experimental-vm-modules -e '
    const fs = require("fs"), vm = require("vm");
    const file = process.argv[1];
    try { new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file }); }
    catch (e) { console.error(`${file}: ${e.message}`); process.exit(1); }
  ' "$file"; then
    fail "syntax error in $file"
  fi
done
"$NODE" tools/check-artifact.mjs || fail "artifact self-containment check failed"

# 3. Physics. The part of the app the rest depends on, tested without a browser.
report "3/5 physics"
if "$NODE" tests/physics.test.mjs > .tmp/physics.log 2>&1; then
  grep -E '^# (pass|fail)' .tmp/physics.log
else
  tail -30 .tmp/physics.log; fail "physics tests failed"
fi

# 4. Interaction. Drives the loaded artifact and checks observable behaviour:
#    dragging changes the state, probability is conserved, packets spread.
report "4/5 interaction (engine: $ENGINE)"
if "$NODE" tests/interaction.test.mjs --engine "$ENGINE" > .tmp/interaction.log 2>&1; then
  tail -3 .tmp/interaction.log
else
  tail -30 .tmp/interaction.log; fail "interaction tests failed ($ENGINE)"
fi

# 5. Goldens. Byte comparison against reviewed baselines.
report "5/5 golden screenshots (engine: $ENGINE)"
if "$NODE" tests/golden.test.mjs --engine "$ENGINE" "${ARGS[@]}" > .tmp/golden.log 2>&1; then
  tail -3 .tmp/golden.log
else
  tail -30 .tmp/golden.log; fail "golden screenshots changed or missing ($ENGINE)"
fi

echo
if [[ $STATUS -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "CHECKS FAILED"; fi
exit $STATUS
