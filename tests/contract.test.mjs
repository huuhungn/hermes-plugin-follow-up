/** Optional real upstream parser integration, not a copied parser or SOUL check.
 * HERMES_SOURCE must name a compatible Hermes source checkout. Missing source
 * skips honestly; configured but missing/incompatible source fails the test.
 * This tests parsing only, not Markdown rendering, policy, or composer delivery.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('actual upstream directive parser preserves followup attributes', {
  skip: !process.env.HERMES_SOURCE && 'Set HERMES_SOURCE for actual upstream parser integration'
}, async () => {
  const source = resolve(process.env.HERMES_SOURCE)
  const parser = await import(pathToFileURL(join(source, 'apps/desktop/src/lib/transcript-directives.ts')).href)
  assert.equal(typeof parser.segmentTranscriptDirectives, 'function', 'requires the current upstream segmentation API')
  const attrs = { p1: 'Chạy lại test', p2: 'Check src/file_name.ts & 🚀', p3: 'Explain the tradeoff' }
  const directive = `::followup{${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}}`
  const segments = parser.segmentTranscriptDirectives(directive)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].kind, 'directive')
  assert.equal(segments[0].directive.name, 'followup')
  assert.deepEqual(segments[0].directive.attrs, attrs)
  assert.equal(segments[0].directive.source, directive)
})
