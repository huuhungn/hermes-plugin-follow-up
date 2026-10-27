#!/usr/bin/env bash
# Self-contained React/jsdom UI tests; no installed Hermes or SOUL required.
# Optional actual upstream parser coverage: HERMES_SOURCE=C:/path/to/hermes
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm ci
npm test
