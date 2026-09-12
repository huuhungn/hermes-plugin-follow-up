/**
 * CSS reachability guard.
 *
 * The plugin ships as plain JavaScript on disk. Tailwind scans the Hermes
 * SOURCE tree at build time — it never sees this file — so a utility class
 * the app itself doesn't already use is NOT emitted into the stylesheet and
 * silently renders as nothing. That failure is invisible to the jsdom suite
 * (jsdom applies no stylesheet) and to code review.
 *
 * This test extracts every class the plugin puts in a `className` and asserts
 * the built stylesheet actually defines it.
 *
 * Skips (exit 0) when no built CSS is available.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const core = process.env.HERMES_CORE || join(process.env.LOCALAPPDATA || '', 'hermes', 'hermes-agent')
const assets = join(core, 'apps', 'desktop', 'dist', 'assets')

if (!existsSync(assets)) {
  console.log('ok - skipped: no built CSS at ' + assets)
  process.exit(0)
}

// The app stylesheet is the largest .css in the bundle.
const cssFiles = readdirSync(assets)
  .filter(f => f.endsWith('.css'))
  .map(f => ({ f, size: statSync(join(assets, f)).size }))
  .sort((a, b) => b.size - a.size)

if (!cssFiles.length) {
  console.log('ok - skipped: no .css in the bundle')
  process.exit(0)
}

const cssFile = cssFiles[0].f
const css = readFileSync(join(assets, cssFile), 'utf8')
const plugin = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

/** Class tokens the plugin hands to `className`, including every string
 *  argument of a `cn(...)` call.
 *
 *  The value is read by BALANCING parentheses, not by a lazy regex: Tailwind
 *  v4 arbitrary properties embed parens (`text-(--ui-accent)`), and a
 *  non-greedy `cn\(...\)` match stops at that inner `)`, silently dropping
 *  every class after it — which is exactly how an unreachable class slipped
 *  through review in the first place. */
function classTokens(source) {
  const tokens = new Set()
  const addFrom = text => {
    for (const lit of text.matchAll(/'([^'\n]*)'/g)) {
      for (const tok of lit[1].split(/\s+/)) {
        if (tok) {
          tokens.add(tok)
        }
      }
    }
  }

  const re = /className:\s*/g
  let m

  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length

    // Plain string value.
    if (source[i] === "'") {
      const end = source.indexOf("'", i + 1)

      addFrom(source.slice(i, end + 1))
      continue
    }

    // cn( … ) — walk to the matching close paren.
    if (!source.startsWith('cn(', i)) {
      continue
    }

    let depth = 0
    const start = i

    for (; i < source.length; i++) {
      const ch = source[i]

      if (ch === "'") {
        i = source.indexOf("'", i + 1)
        continue
      }

      if (ch === '(') {
        depth++
      } else if (ch === ')') {
        depth--

        if (depth === 0) {
          break
        }
      }
    }

    addFrom(source.slice(start, i + 1))
  }

  return [...tokens]
}

/** Tailwind escapes non-word characters with a backslash in its selectors. */
const selectorFor = cls => '.' + cls.replace(/[.:[\]()/%,#&>*+~$!]/g, ch => '\\' + ch)

// Utilities emitted by base/preflight or used as pure markers rather than
// generated selectors.
const NOT_A_UTILITY = new Set(['group', 'peer'])

const missing = []

for (const cls of classTokens(plugin)) {
  if (NOT_A_UTILITY.has(cls)) {
    continue
  }

  if (!css.includes(selectorFor(cls))) {
    missing.push(cls)
  }
}

assert.deepEqual(
  missing,
  [],
  `These classes are used by plugin.js but are NOT in ${cssFile}, so they render as nothing:\n` +
    missing.map(c => '  ' + c).join('\n') +
    '\nUse a class the app already ships, or an inline style.'
)

console.log(`ok - every plugin class exists in ${cssFile}`)
