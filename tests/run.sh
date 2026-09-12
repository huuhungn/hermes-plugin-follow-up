#!/usr/bin/env bash
# Verify the follow-up plugin against real React + jsdom, and verify the
# SOUL.md instruction against Hermes core's own directive parser.
#
#   bash tests/run.sh
#
# React/jsdom/react-dom are resolved from the Hermes checkout (they are not
# vendored here); NODE_PATH points at it. The @hermes/plugin-sdk stub in
# tests/node_modules mirrors only the handful of exports the plugin imports.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="${HERMES_CORE:-$LOCALAPPDATA/hermes/hermes-agent}"

# Native Windows programs (node) don't understand MSYS `/c/...` paths, and
# MSYS path conversion is disabled here — hand node real Windows paths.
if command -v cygpath >/dev/null 2>&1; then
  HERE_N="$(cygpath -m "$HERE")"
  CORE_N="$(cygpath -m "$CORE")"
else
  HERE_N="$HERE"
  CORE_N="$CORE"
fi

if [ ! -d "$CORE/node_modules/react" ]; then
  echo "Cannot find React. Set HERMES_CORE to your hermes-agent checkout." >&2
  exit 1
fi

# ESM resolution ignores NODE_PATH and walks up from the importing FILE, so a
# test living outside the Hermes checkout can't see its node_modules. Rather
# than copying dependencies or writing junctions into the plugin folder, run
# the tests from a scratch dir INSIDE the checkout, importing the plugin (and
# the SDK stub) back out by absolute path. Nothing is duplicated.
WORK="$(mktemp -d "$CORE/.followup-tests-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if command -v cygpath >/dev/null 2>&1; then
  WORK_N="$(cygpath -m "$WORK")"
else
  WORK_N="$WORK"
fi

mkdir -p "$WORK/node_modules/@hermes"
cp -r "$HERE/node_modules/@hermes/plugin-sdk" "$WORK/node_modules/@hermes/"

# Stop Node's module-type probe from walking up into the checkout's package.json
# (it emits MODULE_TYPELESS_PACKAGE_JSON on every .js import otherwise).
printf '{ "type": "module" }\n' > "$WORK/package.json"

PLUGIN="$HERE/../desktop/plugin.js"

# The plugin resolves `@hermes/plugin-sdk` from its OWN directory, so it has to
# run inside the scratch tree. Copy it there and prove the copy is byte-identical
# to what the desktop app loads — a stale or wrong file would silently make the
# whole suite meaningless.
cp "$PLUGIN" "$WORK/plugin.js"

if [ "$(sha256sum < "$PLUGIN")" != "$(sha256sum < "$WORK/plugin.js")" ]; then
  echo "Copy of plugin.js does not match the installed file — aborting." >&2
  exit 1
fi

echo "verifying: plugin.js sha256 $(sha256sum < "$PLUGIN" | cut -c1-16)… (matches installed copy)"

sed "s|import('../desktop/plugin.js')|import('./plugin.js')|" \
  "$HERE/plugin.test.mjs" > "$WORK/plugin.test.mjs"

grep -q "import('./plugin.js')" "$WORK/plugin.test.mjs" || {
  echo "Failed to rewrite the plugin import — refusing to test the wrong file." >&2
  exit 1
}

cp "$HERE/contract.test.mjs" "$WORK/contract.test.mjs"

echo "== plugin behaviour (React 19 + jsdom) =="
node "$WORK_N/plugin.test.mjs"

echo
echo "== CSS reachability (classes must exist in the built stylesheet) =="
HERMES_CORE="$CORE_N" node "$(cygpath -m "$HERE/css.test.mjs" 2>/dev/null || echo "$HERE/css.test.mjs")"

echo
echo "== SOUL.md <-> core parser contract =="
node "$WORK_N/contract.test.mjs"

echo
echo "== parser drift guard =="
SRC="$CORE/apps/desktop/src/lib/transcript-directives.ts"
status=0
# The guard compares the transplanted lines byte-for-byte. Anchor each pattern
# so it matches exactly ONE line in each file: `trimmed.length > 1200` also
# appears in describeDirectiveParseFailure(), and an unanchored grep returns
# both lines, reporting drift that does not exist.
for pat in 'const DIRECTIVE_RE = ' 'const ATTR_RE = ' "!trimmed.startsWith('::')"; do
  a="$(grep -F "$pat" "$SRC" | sed 's/^ *//')"
  b="$(grep -F "$pat" "$HERE/contract.test.mjs" | sed 's/^ *//')"
  if [ "$a" = "$b" ]; then
    echo "ok - in sync: ${pat}"
  else
    echo "DRIFT - core changed its parser; update contract.test.mjs"
    echo "  core: $a"
    echo "  test: $b"
    status=1
  fi
done

exit $status
