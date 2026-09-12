/**
 * Contract check between the SOUL.md instruction and CORE's own parser.
 *
 * The regexes/logic below are transplanted verbatim from
 * apps/desktop/src/lib/transcript-directives.ts (kept byte-identical by the
 * guard in check-parser-drift.sh) — this proves the exact paragraph the model
 * is told to emit parses into the attrs the plugin reads.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// --- verbatim from lib/transcript-directives.ts ----------------------------
const DIRECTIVE_RE = /^::([a-z][a-z0-9-]{0,63})(?:\{([^{}]{0,1024})\})?$/
const ATTR_RE = /([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)')/gi

function parseTranscriptDirective(text) {
  const trimmed = text.trim()

  if (!trimmed.startsWith('::') || trimmed.length > 1200 || trimmed.includes('\n')) {
    return null
  }

  const match = DIRECTIVE_RE.exec(trimmed)

  if (!match) {
    return null
  }

  const attrs = {}

  if (match[2]) {
    for (const pair of match[2].matchAll(ATTR_RE)) {
      attrs[pair[1].toLowerCase()] = pair[2] ?? pair[3] ?? ''
    }
  }

  return { name: match[1], attrs, source: trimmed }
}
// ---------------------------------------------------------------------------

// 1. The exact shape SOUL.md instructs the model to emit.
const emitted = '::followup{p1="Run the tests" p2="Open a PR" p3="Explain the tradeoff"}'
const parsed = parseTranscriptDirective(emitted)

assert.ok(parsed, 'core parser accepts the documented paragraph')
assert.equal(parsed.name, 'followup', 'name matches the plugin claim')
assert.equal(parsed.attrs.p1, 'Run the tests')
assert.equal(parsed.attrs.p2, 'Open a PR')
assert.equal(parsed.attrs.p3, 'Explain the tradeoff')
console.log('ok 1 - documented ::followup paragraph parses to p1..p3')

// 2. Five prompts still fit the 1024-char brace budget at realistic length.
const long = Array.from({ length: 5 }, (_, i) => `p${i + 1}="${'x'.repeat(115)}"`).join(' ')
const five = parseTranscriptDirective(`::followup{${long}}`)

assert.ok(five, '5 prompts at ~120 chars stay inside the brace cap')
assert.equal(Object.keys(five.attrs).length, 5)
console.log('ok 2 - 5 prompts at the documented ~120 char limit still parse')

// 3. The failure mode SOUL.md warns about: a quote inside a prompt truncates.
const withQuote = parseTranscriptDirective('::followup{p1="Say "hi" now" p2="Second"}')

assert.notEqual(withQuote?.attrs.p1, 'Say "hi" now', 'embedded quotes do NOT round-trip')
console.log('ok 3 - embedded quotes break the value (SOUL.md correctly forbids them)')

// 4. Prose containing the token stays prose — the plugin can never hijack text.
assert.equal(parseTranscriptDirective('see ::followup{p1="x"} inline'), null)
assert.equal(parseTranscriptDirective('::followup{p1="a"}\n::followup{p1="b"}'), null)
console.log('ok 4 - mid-prose and multi-line directives are rejected by core')

// 5. Unclaimed/garbage names degrade rather than throwing.
assert.equal(parseTranscriptDirective('::Followup{p1="x"}'), null, 'uppercase name rejected')
assert.deepEqual(parseTranscriptDirective('::followup').attrs, {}, 'bare directive → no attrs')
console.log('ok 5 - malformed names reject, bare directive yields empty attrs')

// 6. The language rule in SOUL.md must be technically achievable: every script
// the instruction promises has to survive core's parser unchanged.
{
  const samples = {
    vietnamese: 'Chạy lại toàn bộ test',
    chinese: '运行测试并打开拉取请求',
    japanese: 'テストを実行してください',
    korean: '테스트를 다시 실행',
    russian: 'Запустить тесты заново',
    arabic: 'إعادة تشغيل الاختبارات',
    emoji: 'Deploy 🚀 to staging'
  }

  for (const [label, text] of Object.entries(samples)) {
    const r = parseTranscriptDirective(`::followup{p1="${text}"}`)

    assert.ok(r, `${label} directive parses`)
    assert.equal(r.attrs.p1, text, `${label} round-trips byte-for-byte`)
    assert.ok(!/\uFFFD/.test(r.attrs.p1), `${label} has no replacement char`)
  }

  console.log('ok 6 - every language the contract promises survives the parser')
}

// 7. The example embedded in SOUL.md is itself valid, and is spelled with real
// diacritics rather than the bare ASCII the rule warns against.
{
  const soulPath = process.env.HERMES_SOUL
    || `${process.env.LOCALAPPDATA || process.env.HOME}/hermes/SOUL.md`

  let soul = ''
  try {
    soul = readFileSync(soulPath, 'utf8')
  } catch {
    soul = ''
  }

  if (!soul) {
    console.log('ok 7 - SKIP (SOUL.md not readable here)')
  } else {
    assert.ok(
      /\*\*Language\.\*\*/.test(soul),
      'SOUL.md carries the language rule the plugin depends on'
    )

    const examples = soul
      .split('\n')
      .map(l => parseTranscriptDirective(l))
      .filter(Boolean)
      .filter(d => d.name === 'followup')

    assert.ok(examples.length >= 1, 'at least one worked example is present')

    const vi = examples.find(d => /[\u00C0-\u1EF9]/.test(d.attrs.p1 || ''))

    assert.ok(vi, 'a non-ASCII example demonstrates the rule')
    assert.equal(
      vi.attrs.p1,
      vi.attrs.p1.normalize('NFC'),
      'the example is NFC-normalized so it cannot arrive pre-decomposed'
    )

    for (const [k, v] of Object.entries(vi.attrs)) {
      assert.ok(!v.includes('"'), `${k} avoids the one forbidden character`)
      assert.ok(v.length <= 120, `${k} respects the length guidance`)
    }

    console.log('ok 7 - the SOUL.md language rule ships a valid accented example')
  }
}

console.log('\nSOUL.md ↔ core parser contract verified.')
