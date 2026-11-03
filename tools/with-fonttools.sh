#!/usr/bin/env bash
# Generator for the embedded font faces, pinned to nixpkgs so the bytes are
# reproducible from flake.lock.
#
# The output (build/*.woff2.base64) is committed, so this script is the only
# part of the project that ever wants font tooling: building, testing, and
# viewing the artifact need neither it nor a network. Regenerating faces is a
# deliberate act, because a font change moves every glyph and therefore every
# full-page golden screenshot.
#
# Two ways to reach the same pinned packages:
#
#   1. `nix build` / `nix shell`, when a Nix daemon or socket is reachable.
#      This is the normal path on a developer machine and on CI.
#   2. Absolute /nix/store paths, when it is not. The sandbox this project is
#      verified in has no daemon socket, so the fallback is what actually runs
#      here. Both paths name the same nixpkgs revision, and the script prints
#      which it used plus the store paths, so a regenerated face can always be
#      traced back to the package that produced it.
#
# Note the difference from the sibling Aurelia project, which shells out to
# `woff2_compress` from pkgs.woff2: those binaries cannot be exec'd in this
# sandbox, and fonttools writes WOFF2 on its own given a brotli module built
# for the same interpreter. See the header of tools/build-font.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."

FONT_PKG="pkgs.dejavu_fonts"
# DejaVuSans.ttf lives in a subdirectory, and an interpolated "${out}/subdir"
# string carries a derivation context that nix rejects; the subdirectory is
# therefore appended in bash, not inside the nix expression.
FONT_SUBDIR="share/fonts/truetype"

# Fallback store paths, resolved with:
#   nix build --no-link --print-out-paths '<nixpkgs>' -A dejavu_fonts
# and read off this machine's store otherwise. Pinned to the same versions
# flake.lock resolves: dejavu-fonts-2.37, fonttools-4.63.0, brotli-1.2.0.
FALLBACK_FONT_OUT=/nix/store/xadrivsjgk1bslbd64hq9zakin7vp6nr-dejavu-fonts-2.37
FALLBACK_PYFTSUBSET=/nix/store/16dfzqspcbliyigq9k2ha85j2dbp633b-python3.14-fonttools-4.63.0/bin/pyftsubset
# fonttools needs a brotli Python extension built for the *same* interpreter to
# encode WOFF2, and does not declare it, so it is added to PYTHONPATH by hand.
FALLBACK_BROTLI_SITE=/nix/store/f7bpjfpqhaaya02029i444lvrp70353z-python3.14-brotli-1.2.0/lib/python3.14/site-packages

nix_expr_fonts() {
  cat <<'NIX'
let flake = builtins.getFlake (toString ./.);
    pkgs = flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
in
NIX
}

if nix build --impure --no-link --print-out-paths --expr "$(nix_expr_fonts)${FONT_PKG}" >/dev/null 2>&1; then
  echo "== fonts: resolved from the pinned flake via nix build =="
  FONT_OUT=$(nix build --impure --no-link --print-out-paths --expr "$(nix_expr_fonts)${FONT_PKG}")
  # fonttools provides pyftsubset; brotli provides the encoder fonttools imports
  # for WOFF2 output. Both from the same pinned package set and interpreter.
  nix shell --impure --expr "$(nix_expr_fonts)[
    pkgs.python3Packages.fonttools
    pkgs.python3Packages.brotli
  ]" --command bash -c 'set -euo pipefail; node tools/build-font.mjs "$1"' _ "$FONT_OUT/$FONT_SUBDIR"
else
  echo "== fonts: nix is unavailable here, using pinned store paths directly =="
  for path in "$FALLBACK_FONT_OUT/$FONT_SUBDIR/DejaVuSans.ttf" \
              "$FALLBACK_FONT_OUT/$FONT_SUBDIR/DejaVuSans-Bold.ttf" \
              "$FALLBACK_PYFTSUBSET" \
              "$FALLBACK_BROTLI_SITE/brotli.py"; do
    if [[ ! -e $path ]]; then
      echo "missing $path" >&2
      echo "run this script where a Nix daemon can realise the pinned packages" >&2
      exit 1
    fi
  done
  echo "   font package:   $FALLBACK_FONT_OUT"
  echo "   subsetter:      $FALLBACK_PYFTSUBSET"
  echo "   brotli module:  $FALLBACK_BROTLI_SITE"
  PATH="$(dirname "$FALLBACK_PYFTSUBSET"):$PATH" \
  PYTHONPATH="$FALLBACK_BROTLI_SITE${PYTHONPATH:+:$PYTHONPATH}" \
    node tools/build-font.mjs "$FALLBACK_FONT_OUT/$FONT_SUBDIR"
fi
