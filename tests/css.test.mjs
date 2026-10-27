/** Self-contained styling guard: installed plugin JS is not in Tailwind's
 * source scan. Layout must not depend on host build-specific utility classes.
 * This static check is NOT visual browser verification.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('plugin styling has no host Tailwind class dependency or hidden core protocol', () => {
  const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /className\s*:|\bcn\(/)
  assert.doesNotMatch(source, /querySelector|\.closest\(|CustomEvent|hermes:composer-|data-composer-/)
  assert.doesNotMatch(source, /\bfetch\(|localStorage|sessionStorage|addEventListener/)
  assert.match(source, /var\(--ui-stroke-secondary/)
  assert.match(source, /style:/)
  assert.doesNotMatch(source, /outline\s*:\s*['"]none/)
})
