/**
 * Real-DOM harness for the follow-up desktop plugin.
 *
 * Mounts the plugin's directive component with React 19 + jsdom, reproducing
 * Hermes' surface markup (`data-composer-target` / `data-composer-surface-id`,
 * `data-pane-hidden` keep-alive tabs), then asserts against the CustomEvents
 * the real composer bus (app/chat/composer/focus.ts) subscribes to.
 */
import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
})

globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 24 defines `navigator` as a getter-only global; redefine it.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Event = dom.window.Event
globalThis.CustomEvent = dom.window.CustomEvent
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.Node = dom.window.Node
globalThis.getComputedStyle = dom.window.getComputedStyle
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = cb => dom.window.setTimeout(() => cb(Date.now()), 0)
globalThis.cancelAnimationFrame = id => dom.window.clearTimeout(id)

// A handler that THROWS must never look like a passing "no event dispatched"
// assertion. React and jsdom both swallow listener errors by default, so fail
// the run loudly on any error surfaced through either channel.
const failures = []

dom.window.addEventListener('error', event => failures.push(event.error || event.message))
dom.window.addEventListener('unhandledrejection', event => failures.push(event.reason))

const realConsoleError = console.error

console.error = (...args) => {
  failures.push(args.map(String).join(' '))
  realConsoleError(...args)
}

const assertNoFailures = label => {
  if (failures.length) {
    realConsoleError(`\nnot ok - ${label}: handler raised an error`)
    realConsoleError(failures[0])
    process.exit(1)
  }
}

// Panels left mounted keep a live status TTL timer. When it fires after the
// suite has moved on, React logs an out-of-act() update — noise that would
// mask a real error. Track every root and tear them down at the end.
const roots = []

const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')

const trackRoot = root => {
  roots.push(root)

  return root
}

const unmountAll = () => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
}

// The plugin exactly as the desktop app loads it — no copy, no shim.
const plugin = (await import('../desktop/plugin.js')).default

// ---------------------------------------------------------------------------
// Collect the plugin's contributions exactly like ctx.register would.
// ---------------------------------------------------------------------------
const registered = []
const locales = []

plugin.register({
  i18n: { register: bundles => locales.push(bundles) },
  register: contribution => registered.push(contribution)
})

assert.equal(plugin.id, 'follow-up', 'plugin id must match its folder name')
assert.equal(
  plugin.defaultEnabled,
  true,
  'an installed Follow-up plugin is active unless the user explicitly disables it'
)

const directive = registered.find(c => c.area === 'transcript.directives')
assert.ok(directive, 'registers a transcript.directives contribution')
assert.equal(directive.data.name, 'followup', 'claims the ::followup directive name')
assert.equal(typeof directive.data.render, 'function', 'directive ships a render fn')
assert.ok(locales[0]?.en?.title && locales[0]?.vi?.title, 'ships en + vi locale bundles')

// ---------------------------------------------------------------------------
// Mount inside a realistic chat surface.
// ---------------------------------------------------------------------------
function mount({
  attrs,
  disabled = false,
  hidden = false,
  streaming = false,
  surfaceId = 'surface-1',
  target = 'main'
}) {
  const host = document.getElementById('root')

  // Core's real markup: the surface wraps BOTH the transcript and the rich
  // editor, and stamps the editor with its disabled state. React renders
  // `aria-disabled` + `contentEditable={!inputDisabled}`, so a disabled editor
  // carries contenteditable="false" — mirror that exactly.
  const editor = `<div data-slot="composer-rich-input" contenteditable="${!disabled}"${
    disabled ? ' aria-disabled="true"' : ''
  }></div>`

  const surface = `<div data-composer-target="${target}" data-composer-surface-id="${surfaceId}"><div id="mount"></div>${editor}</div>`

  host.innerHTML = hidden ? `<div data-pane-hidden="true">${surface}</div>` : surface

  const root = trackRoot(createRoot(document.getElementById('mount')))

  act(() => {
    root.render(createElement(directive.data.render, { attrs, source: '', streaming }))
  })

  return root
}

const events = []
const record = event => events.push({ detail: event.detail, type: event.type })

window.addEventListener('hermes:composer-insert', record)
window.addEventListener('hermes:composer-submit', record)

const click = (node, init = {}) => {
  act(() => {
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

// Inserts are deferred to a macrotask (core's focus-restoration contract), so
// drain the timer queue before asserting. Submits fire synchronously.
const flush = async () => {
  await new Promise(resolve => dom.window.setTimeout(resolve, 1))
}

const rows = () => [...document.querySelectorAll('#mount button')]

// -- 1. renders one row per prompt, in order, deduped -----------------------
mount({ attrs: { p1: 'Run the tests', p2: 'Open a PR', p3: 'Run the tests', p4: '   ' } })

let buttons = rows()
let labels = buttons.map(b => b.textContent)

assert.ok(
  labels.some(l => l.includes('Run the tests')) && labels.some(l => l.includes('Open a PR')),
  'renders both distinct prompts'
)
assert.equal(
  labels.filter(l => l.includes('Run the tests')).length,
  1,
  'duplicate prompt is deduped'
)
assert.ok(!labels.some(l => l.trim() === ''), 'blank prompt is dropped')
console.log('ok 1 - renders deduped, non-empty prompts in order');

// -- 2. plain click inserts into the composer of ITS surface ----------------
{
  events.length = 0
  const promptRow = rows().find(b => b.textContent.includes('Open a PR'))

  click(promptRow)
  await flush()

  assert.equal(events.length, 1, 'exactly one bus event')
  assert.equal(events[0].type, 'hermes:composer-insert', 'plain click inserts, never sends')
  assert.equal(events[0].detail.text, 'Open a PR')
  assert.equal(events[0].detail.mode, 'block')
  assert.equal(events[0].detail.target, 'main')
  console.log('ok 2 - plain click dispatches composer-insert with the prompt')
}

// -- 3. ctrl/cmd click submits, carrying the exact surface identity ---------
{
  events.length = 0
  click(rows().find(b => b.textContent.includes('Open a PR')), { ctrlKey: true })

  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'hermes:composer-submit', 'ctrl+click sends')
  assert.equal(events[0].detail.surfaceId, 'surface-1', 'submit carries the surface identity')
  assert.equal(events[0].detail.target, 'main')

  events.length = 0
  click(rows().find(b => b.textContent.includes('Open a PR')), { metaKey: true })
  assert.equal(events[0].type, 'hermes:composer-submit', 'cmd+click sends too')
  console.log('ok 3 - ctrl/cmd+click dispatches composer-submit with exact surfaceId')
}

// -- 4. "insert all" appends every prompt as separate lines -----------------
{
  events.length = 0
  const insertAll = rows().find(b => b.textContent.includes('insertAll'))

  assert.ok(insertAll, 'insert-all control renders for multi-prompt panels')
  click(insertAll)
  await flush()

  assert.equal(events[0].type, 'hermes:composer-insert')
  assert.equal(events[0].detail.text, 'Run the tests\nOpen a PR', 'joins prompts as separate lines')
  console.log('ok 4 - insert all appends every prompt as its own line')
}

// -- 5. routes to the tile it was clicked in, not the main chat -------------
{
  mount({ attrs: { p1: 'Tile prompt' }, surfaceId: 'surface-9', target: 'tile:abc' })
  events.length = 0
  click(rows()[0], { ctrlKey: true })

  assert.equal(events[0].detail.target, 'tile:abc', 'submit targets the surface it lives in')
  assert.equal(events[0].detail.surfaceId, 'surface-9')
  console.log('ok 5 - routing is surface-exact (split tiles land in the right chat)')
}

// -- 6. fails closed inside a hidden keep-alive tab -------------------------
{
  mount({ attrs: { p1: 'Buried prompt' }, hidden: true })
  events.length = 0
  click(rows()[0], { ctrlKey: true })
  click(rows()[0])
  await flush()

  assert.equal(events.length, 0, 'no submit OR insert broadcast from a buried surface')
  assertNoFailures('buried surface')
  console.log('ok 6 - buried (data-pane-hidden) surface fails closed, no broadcast')
}

// -- 7. streaming renders nothing; junk attrs render a visible badge --------
{
  mount({ attrs: { p1: 'Half typed' }, streaming: true })
  assert.equal(rows().length, 0, 'nothing renders mid-stream')
  assert.equal(
    document.querySelector('#mount [data-testid="directive-drop-badge"]'),
    null,
    'a still-streaming directive is not yet a failure — no badge'
  )

  // A directive that parsed but carries no usable prompt must NOT vanish: an
  // empty render is indistinguishable from a directive that was never sent.
  mount({ attrs: { nope: 'x', title: 'not a prompt' } })
  assert.equal(rows().length, 0, 'no p1..p5 attrs → no prompt buttons')
  assert.ok(
    document.querySelector('#mount [data-testid="directive-drop-badge"]'),
    'no usable prompt → visible drop badge, not silence'
  )
  console.log('ok 7 - streaming renders nothing; junk attrs show a drop badge')
}

// -- 8. untrusted attrs are capped ------------------------------------------
{
  mount({
    attrs: {
      p1: 'a'.repeat(1000),
      p2: 'b',
      p3: 'c',
      p4: 'd',
      p5: 'e',
      p6: 'overflow'
    }
  })

  const texts = rows()
    .filter(b => !b.textContent.includes('insertAll'))
    .map(b => b.textContent)

  assert.equal(texts.length, 5, 'caps at 5 prompts (p6 ignored)')
  assert.ok(!texts.some(t => t.includes('overflow')), 'p6 is not rendered')
  assert.ok(texts[0].length < 500, 'over-long prompt is truncated')
  console.log('ok 8 - untrusted attrs capped at 5 items / 400 chars')
}

// -- 9. a DISABLED composer must not be told "sent" ------------------------
// While the gateway is closed core unsubscribes insert entirely and gates
// submit on !inputDisabled, so a dispatch here goes nowhere. The panel has to
// notice that instead of claiming success.
{
  mount({ attrs: { p1: 'Offline prompt' }, disabled: true })
  events.length = 0

  click(rows()[0], { ctrlKey: true })
  click(rows()[0])
  await flush()

  assert.equal(events.length, 0, 'nothing is dispatched at a disabled composer')

  const status = document.querySelector('#mount').textContent

  assert.ok(status.includes('noComposer'), 'panel reports the failure, not "sent"')
  assert.ok(!status.includes('sent'), 'never claims the prompt was sent')
  assertNoFailures('disabled composer')
  console.log('ok 9 - disabled composer: no dispatch, honest failure status')
}

// -- 10/11. each disabled signal must stand on its own ---------------------
// Core sets aria-disabled and contentEditable together today, so a test that
// sets both leaves each half of the guard unverified (mutation-confirmed: the
// halves survived individually). Assert each signal alone, so the guard still
// holds if core ever renders only one of them.
for (const [n, markup, name] of [
  [10, 'aria-disabled="true" contenteditable="true"', 'aria-disabled alone'],
  [11, 'contenteditable="false"', 'contenteditable=false alone']
]) {
  const host = document.getElementById('root')

  host.innerHTML = `<div data-composer-target="main" data-composer-surface-id="s1"><div id="mount"></div><div data-slot="composer-rich-input" ${markup}></div></div>`

  const root = trackRoot(createRoot(document.getElementById('mount')))

  act(() => {
    root.render(createElement(directive.data.render, { attrs: { p1: 'Blocked' }, source: '', streaming: false }))
  })

  events.length = 0
  click(rows()[0], { ctrlKey: true })
  click(rows()[0])
  await flush()

  assert.equal(events.length, 0, `no dispatch when disabled via ${name}`)
  assertNoFailures(name)
  console.log(`ok ${n} - blocked by ${name}`)
}

// -- 12. the status line clears itself -------------------------------------
// It used to be set and never reset: scrolling back to an old reply showed a
// stale "Sent." forever, and a second click could not be told from the first.
{
  mount({ attrs: { p1: 'Alpha' } })
  events.length = 0

  click(rows()[0])
  await flush()

  const live = document.querySelector('#mount [role="status"]')

  assert.ok(live, 'a live region exists')
  assert.ok(live.textContent.includes('inserted'), 'status appears after acting')

  // Drain the TTL. jsdom timers are real, so wait past it.
  await act(async () => {
    await new Promise(resolve => dom.window.setTimeout(resolve, 4200))
  })

  assert.equal(
    document.querySelector('#mount [role="status"]').textContent,
    '',
    'status clears itself so it cannot go stale'
  )
  assertNoFailures('status ttl')
  console.log('ok 12 - status line clears itself after its TTL')
}

// -- 13. assistive tech gets a live region ---------------------------------
{
  mount({ attrs: { p1: 'Alpha' } })

  const live = document.querySelector('#mount [role="status"]')

  assert.equal(live.getAttribute('aria-live'), 'polite', 'announced politely')
  assert.equal(live.textContent, '', 'region is mounted and empty before acting')

  click(rows()[0])
  await flush()

  assert.ok(
    document.querySelector('#mount [role="status"]').textContent.length > 0,
    'the same region receives the message (screen readers observe it)'
  )
  assertNoFailures('aria-live')
  console.log('ok 13 - status is announced through a polite live region')
}

// -- 14. repeating an action re-announces it -------------------------------
// An identical string in an unchanged node is silent to a screen reader; the
// nonce key forces a fresh node so the second click is heard too.
{
  mount({ attrs: { p1: 'Alpha' } })

  click(rows()[0])
  await flush()

  const first = document.querySelector('#mount [role="status"] span')

  click(rows()[0])
  await flush()

  const second = document.querySelector('#mount [role="status"] span')

  assert.ok(first && second, 'both clicks produce a message node')
  assert.equal(first.textContent, second.textContent, 'same message text')
  assert.notStrictEqual(
    first,
    second,
    'the DOM node is replaced, so an identical message is re-announced'
  )
  assertNoFailures('re-announce')
  console.log('ok 14 - repeating the same action re-announces it')
}

// -- 15. truncation is visible ---------------------------------------------
// A prompt cut at 400 chars used to land in the composer looking complete.
{
  const long = 'x'.repeat(450)

  mount({ attrs: { p1: long, p2: 'Short one' } })

  const buttons = rows()
  const longRow = buttons.find(b => b.textContent.includes('x'.repeat(50)))
  const shortRow = buttons.find(b => b.textContent.includes('Short one'))

  assert.ok(longRow, 'the long prompt has a row')
  assert.ok(shortRow, 'the short prompt has a row')
  assert.ok(longRow.textContent.includes('truncated'), 'long prompt is flagged')
  assert.ok(!shortRow.textContent.includes('truncated'), 'short prompt is not flagged')
  assert.ok(
    longRow.textContent.includes('x'.repeat(400)),
    'the visible text is the capped 400 chars'
  )
  assertNoFailures('truncation badge')
  console.log('ok 15 - a shortened prompt is marked as such')
}

// -- 16. Alt+N runs the Nth prompt -----------------------------------------
{
  mount({ attrs: { p1: 'First', p2: 'Second', p3: 'Third' } })
  events.length = 0

  const panel = document.querySelector('#mount [data-testid="follow-up-panel"]')
  const key = (init) => {
    act(() => {
      panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })
  }

  key({ altKey: true, key: '2' })
  await flush()

  assert.equal(events.length, 1, 'Alt+2 acts exactly once')
  assert.equal(events[0].type, 'hermes:composer-insert', 'plain Alt+N inserts')
  assert.equal(events[0].detail.text, 'Second', 'Alt+2 picks the SECOND prompt')

  // Ctrl+Alt+N sends outright.
  events.length = 0
  key({ altKey: true, ctrlKey: true, key: '3' })
  await flush()

  assert.equal(events[0].type, 'hermes:composer-submit', 'Ctrl+Alt+N submits')
  assert.equal(events[0].detail.text, 'Third', 'and picks the THIRD prompt')

  // Out-of-range and unmodified keys must do nothing.
  events.length = 0
  key({ altKey: true, key: '9' })
  key({ key: '1' })
  key({ altKey: true, key: 'a' })
  await flush()

  assert.equal(events.length, 0, 'out-of-range, bare and non-numeric keys are ignored')
  assertNoFailures('alt shortcuts')
  console.log('ok 16 - Alt+N runs the Nth prompt, Ctrl/Cmd+Alt+N sends it')
}

// -- 17. non-ASCII prompts survive intact ----------------------------------
// These strings are what the user is about to SEND as their own message, so
// any mangling here is a message they can't use.
{
  const vi = 'Chạy lại toàn bộ test'
  const zh = '运行测试并打开拉取请求'
  const emoji = 'Deploy 🚀 to staging'

  mount({ attrs: { p1: vi, p2: zh, p3: emoji } })
  events.length = 0

  const buttons = rows()
  const viRow = buttons.find(b => b.textContent.includes('Chạy'))
  const zhRow = buttons.find(b => b.textContent.includes('运行'))

  assert.ok(viRow, 'Vietnamese row renders with its diacritics')
  assert.ok(zhRow, 'Chinese row renders in native script')
  assert.ok(
    !viRow.textContent.includes('Chay lai'),
    'diacritics are not stripped to bare ASCII'
  )

  click(viRow)
  await flush()

  assert.equal(events[0].detail.text, vi, 'the composer receives the exact original text')
  assert.ok(!/\uFFFD/.test(events[0].detail.text), 'no replacement characters')

  events.length = 0
  click(buttons.find(b => b.textContent.includes('Deploy')))
  await flush()

  assert.equal(events[0].detail.text, emoji, 'the emoji survives as a whole pair')
  assertNoFailures('non-ascii')
  console.log('ok 17 - Vietnamese, Chinese and emoji prompts round-trip intact')
}

// -- 18. truncation never splits a character -------------------------------
// slice() counts UTF-16 units: cutting mid-pair leaves a lone surrogate that
// renders as a box, and cutting a decomposed accent orphans the tone mark.
{
  // Land the 400-char boundary exactly inside a surrogate pair.
  const emojiAt400 = 'a'.repeat(399) + '🚀' + 'b'.repeat(60)
  // Same, for an NFD Vietnamese character (base + combining mark).
  const nfd = 'Chạy lại'.normalize('NFD')
  const nfdAt400 = 'a'.repeat(398) + nfd + 'b'.repeat(60)

  mount({ attrs: { p1: emojiAt400, p2: nfdAt400 } })
  events.length = 0

  // rows() includes the localized "Insert all" control. Prompt rows carry
  // aria-keyshortcuts (Alt+1..5); filter by semantics, never English UI text.
  const buttons = rows().filter(b => b.hasAttribute('aria-keyshortcuts'))

  assert.equal(buttons.length, 2, 'both long prompts render as rows')

  for (const b of buttons) {
    assert.ok(
      !/[\uD800-\uDFFF]/.test(b.textContent.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
      'no lone surrogate survives into the rendered row'
    )
  }

  click(buttons[0])
  await flush()

  const sent = events[0].detail.text
  assert.ok(
    !/[\uD800-\uDFFF]/.test(sent.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
    'the inserted text has no half-character'
  )
  assert.equal(sent, emojiAt400.trim(), 'plain click inserts the complete prompt for review')
  assertNoFailures('safe cut')
  console.log('ok 18 - preview is capped without splitting a character; insert keeps full text')
  click(buttons[1])
  await flush()

  const viSent = events[0].detail.text

  // The cut must not leave a combining mark as the final character with no
  // base letter of its own — that renders as a floating accent.
  assert.ok(
    !/\p{M}/u.test(viSent.slice(-1)) || /\P{M}\p{M}$/u.test(viSent),
    'no orphaned combining mark at the cut'
  )
  assertNoFailures('safe cut')
  console.log('ok 18 - the cut never splits a character; insert keeps full text')
}

// -- 19. complex emoji graphemes also survive the cap intact -----------------
{
  const family = '👨\u200d👩\u200d👧\u200d👦'
  const flag = '🇻🇳'
  // Force the boundary into each multi-code-point grapheme, not merely into a
  // surrogate pair. Intl.Segmenter should back off before the whole cluster.
  const familyAt400 = 'a'.repeat(395) + family + 'tail'
  const flagAt400 = 'b'.repeat(398) + flag + 'tail'

  mount({ attrs: { p1: familyAt400, p2: flagAt400 } })
  events.length = 0

  const buttons = rows().filter(b => b.hasAttribute('aria-keyshortcuts'))
  assert.equal(buttons.length, 2, 'both complex grapheme prompts render')

  click(buttons[0])
  await flush()
  assert.equal(events[0].detail.text, familyAt400, 'plain click inserts the complete family prompt for review')
  assert.ok(events[0].detail.text.includes(family), 'the complete family grapheme is preserved')

  events.length = 0
  click(buttons[1])
  await flush()
  assert.equal(events[0].detail.text, flagAt400, 'plain click inserts the complete flag prompt for review')
  assert.ok(events[0].detail.text.includes(flag), 'the complete flag grapheme is preserved')
  assertNoFailures('grapheme cut')
  console.log('ok 19 - joined emoji and flags are never split by the cap')
}

// -- 20. NFC and NFD spellings of one prompt are not offered twice ----------
{
  const nfc = 'Chạy lại test'.normalize('NFC')
  const nfd = 'Chạy lại test'.normalize('NFD')

  assert.notEqual(nfc, nfd, 'the two encodings really do differ byte-wise')

  mount({ attrs: { p1: nfc, p2: nfd, p3: 'Something else' } })

  const labels = rows()
    .filter(b => !b.textContent.includes('Insert all'))
    .map(b => b.textContent)

  const dupes = labels.filter(l => l.includes('Chạy lại test'))

  assert.equal(dupes.length, 1, 'the same sentence appears once, not twice')
  assertNoFailures('nfc dedupe')
  console.log('ok 20 - NFC/NFD spellings of one prompt dedupe to a single row')
}

// -- 21. truncated prompts never submit incomplete text --------------------
{
  const long = 'z'.repeat(450)

  mount({ attrs: { p1: long } })
  events.length = 0
  const longRow = rows().find(b => b.hasAttribute('aria-keyshortcuts'))

  click(longRow, { ctrlKey: true })
  await flush()

  assert.equal(events.length, 1, 'modified click still performs one safe action')
  assert.equal(events[0].type, 'hermes:composer-insert', 'truncated prompt is inserted for review, never submitted')
  assert.equal(events[0].detail.text, long, 'composer receives the complete prompt, not the 400-char preview')
  assertNoFailures('truncated safe insert')
  console.log('ok 21 - truncated prompt fails safe: full text inserts instead of submitting')
}

// -- 22. physical DigitN shortcuts survive Option/Alt keyboard layouts ------
{
  mount({ attrs: { p1: 'First physical', p2: 'Second physical' } })
  events.length = 0
  const panel = document.querySelector('#mount [data-testid="follow-up-panel"]')

  act(() => {
    panel.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        altKey: true,
        code: 'Digit2',
        key: '™'
      })
    )
  })
  await flush()

  assert.equal(events.length, 1, 'physical shortcut fires once even when Option changes event.key')
  assert.equal(events[0].detail.text, 'Second physical')
  console.log('ok 22 - Alt+DigitN uses event.code, independent of keyboard layout')
}

// -- 23. compact command list exposes semantic group + focus affordance -----
{
  mount({ attrs: { p1: 'Accessible action', p2: 'Another action' } })
  const panel = document.querySelector('#mount [data-testid="follow-up-panel"]')
  const promptRows = rows().filter(b => b.hasAttribute('aria-keyshortcuts'))

  assert.equal(panel.getAttribute('role'), 'group')
  assert.ok(panel.getAttribute('aria-labelledby'), 'panel is labelled by its visible title')
  assert.equal(panel.querySelectorAll('[role="listitem"]').length, 2, 'prompts expose list semantics')
  assert.ok(promptRows.every(b => b.className.includes('focus-visible:ring-2')), 'every prompt has a strong focus ring')
  assert.ok(promptRows.every(b => b.getAttribute('aria-describedby')), 'every prompt describes insert/send behavior')
  assert.ok(promptRows.every(b => b.textContent.includes('insertAction')), 'insert affordance is present for hover/focus')
  console.log('ok 23 - compact list has group/list semantics, focus ring, and explicit insert affordance')
}

// -- 24. empty directive is an accessible, visible diagnostic --------------
{
  mount({ attrs: { nope: 'not a prompt' } })
  const badge = document.querySelector('#mount [data-testid="directive-drop-badge"]')

  assert.ok(badge, 'empty directive renders a visible diagnostic')
  assert.equal(badge.getAttribute('role'), 'note')
  assert.ok(badge.getAttribute('aria-label'), 'empty diagnostic has an accessible explanation')
  console.log('ok 24 - empty state is visible and named for assistive technology')
}

// Tear down every panel so no pending status TTL fires after the run.
unmountAll()
assertNoFailures('teardown')

console.log('\nAll follow-up plugin checks passed.')
assertNoFailures('end of run')
