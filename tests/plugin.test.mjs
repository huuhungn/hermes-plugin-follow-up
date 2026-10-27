/** Real React + jsdom component tests at the registered directive seam.
 * Only @hermes/plugin-sdk is doubled. No core markup, bus, parser, or delivery
 * integration is simulated; core integration belongs in a separate suite.
 */
import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { calls, haptics, host, registerTranslations, resetSdk, setComposer } from './sdk-stub.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const plugin = (await import('../desktop/plugin.js')).default
const contributions = []
let translations
plugin.register({
  i18n: { register(value) { translations = value; registerTranslations(value) } },
  register(value) { contributions.push(value) }
})
const directive = contributions.find(value => value.area === 'transcript.directives')
let mounted = []
let errors = []
const consoleError = console.error
console.error = (...args) => { errors.push(args.map(String).join(' ')); consoleError(...args) }
const onError = event => errors.push(event.error ?? event.message ?? event.reason)
dom.window.addEventListener('error', onError)
dom.window.addEventListener('unhandledrejection', onError)
beforeEach(() => { resetSdk(); errors = [] })
afterEach(async () => {
  await act(async () => { for (const view of mounted) view.root.unmount() })
  mounted = []
  document.body.replaceChildren()
  assert.deepEqual(errors, [], 'no swallowed handler errors or React warnings')
})
after(() => { console.error = consoleError; dom.window.close() })

function mount(props = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const view = {
    root, container,
    render(next) {
      act(() => root.render(createElement(directive.data.render, {
        attrs: { p1: 'Run the tests' }, streaming: false, source: '', sessionId: 'session-a', ...next
      })))
    },
    rows: () => [...container.querySelectorAll('button[aria-keyshortcuts]')],
    status: () => container.querySelector('[role="status"]')?.textContent ?? '',
    panel: () => container.querySelector('[data-testid="follow-up-panel"]')
  }
  mounted.push(view)
  view.render(props)
  return view
}
async function click(node, init = {}) {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('registers followup with English and Vietnamese translations', () => {
  assert.equal(plugin.id, 'follow-up')
  assert.equal(plugin.defaultEnabled, true)
  assert.equal(directive.data.name, 'followup')
  assert.ok(translations.en.title && translations.vi.title)
})

test('null session addresses new explicitly, never the active composer', async () => {
  const view = mount({ sessionId: null })
  await click(view.rows()[0])
  assert.equal(calls[0].args[0], 'new')
})

for (const sessionId of [undefined, '', '   ', 42]) {
  test(`missing/invalid session (${String(sessionId)}) disables every action with upgrade notice`, async () => {
    const view = mount({ sessionId, attrs: { p1: 'One', p2: 'Two' } })
    assert.ok(view.container.textContent.includes('Upgrade Hermes Desktop'))
    assert.ok([...view.container.querySelectorAll('button')].every(button => button.disabled))
    await click(view.rows()[0], { ctrlKey: true })
    assert.deepEqual(calls, [])
  })
}

for (const modifier of ['ctrlKey', 'metaKey']) {
  test(`${modifier} click dispatches submit to this session with honest status`, async () => {
    const view = mount({ sessionId: 'runtime-2' })
    await click(view.rows()[0], { [modifier]: true })
    assert.deepEqual(calls, [{ method: 'submit', args: ['runtime-2', 'Run the tests'] }])
    assert.equal(view.status(), 'Sent to composer; delivery is not confirmed.')
  })
}

for (const send of [false, true]) {
  for (const outcome of ['false', 'throw', 'reject']) {
    test(`${send ? 'submit' : 'insert'} ${outcome} reports failure without haptics`, async () => {
      const response = () => {
        if (outcome === 'throw') throw new Error('SDK unavailable')
        if (outcome === 'reject') return Promise.reject(new Error('SDK unavailable'))
        return false
      }
      setComposer(send ? { submit: response } : { insertText: response })
      const view = mount()
      await click(view.rows()[0], { ctrlKey: send })
      assert.equal(calls.length, 1)
      assert.equal(view.status(), 'No visible composer in this chat.')
      assert.deepEqual(haptics, [])
    })
  }
}

test('pending insert locks clicks, insert-all and panel shortcuts until it settles', async () => {
  const pending = deferred()
  setComposer({ insertText: () => pending.promise })
  const view = mount({ attrs: { p1: 'First', p2: 'Second' } })
  await act(async () => {
    const row = view.rows()[0]
    row.click()
    row.click()
  })
  await click(view.rows()[1], { ctrlKey: true })
  await click(view.container.querySelector('button'))
  await key(view.panel(), { altKey: true, key: '2' })
  assert.equal(calls.length, 1, 'synchronous ref lock blocks same-tick duplicate and other paths')
  assert.ok([...view.container.querySelectorAll('button')].every(button => button.disabled))
  await act(async () => pending.resolve(true))
  assert.ok(view.rows().every(button => !button.disabled))
  await click(view.rows()[1], { ctrlKey: true })
  assert.equal(calls.length, 2)
})

for (const completion of ['resolve', 'reject']) {
  test(`session change ignores stale ${completion} and cannot unlock the next session action`, async () => {
    const first = deferred()
    const second = deferred()
    let count = 0
    setComposer({ insertText: () => (++count === 1 ? first.promise : second.promise) })
    const view = mount()
    await click(view.rows()[0])
    view.render({ sessionId: 'session-b' })
    assert.equal(view.status(), '')
    assert.ok(!view.rows()[0].disabled)
    await click(view.rows()[0])
    await act(async () => first[completion](completion === 'resolve' ? true : new Error('old failure')))
    assert.equal(view.status(), '')
    assert.deepEqual(haptics, [])
    assert.ok(view.rows()[0].disabled, 'old completion must not release the new request lock')
    await act(async () => second.resolve(true))
    assert.equal(view.status(), 'Inserted into the composer.')
    assert.deepEqual(calls.map(call => call.args[0]), ['session-a', 'session-b'])
  })
  test(`unmount ignores stale ${completion} without haptics or React errors`, async () => {
    const pending = deferred()
    setComposer({ insertText: () => pending.promise })
    const view = mount()
    await click(view.rows()[0])
    act(() => view.root.unmount())
    mounted = mounted.filter(other => other !== view)
    await act(async () => pending[completion](completion === 'resolve' ? true : new Error('old failure')))
    assert.deepEqual(haptics, [])
  })
}

async function key(node, init = {}) {
  let event
  await act(async () => {
    event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    node.dispatchEvent(event)
  })
  return event
}

test('rejects C0/C1 and bidi controls rather than silently changing the intended action', async () => {
  const forbidden = [
    ...Array.from({ length: 32 }, (_, i) => i).filter(i => ![9, 10, 13].includes(i)),
    ...Array.from({ length: 33 }, (_, i) => i + 127),
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069
  ]
  const view = mount()
  for (const point of forbidden) {
    view.render({ attrs: { p1: `Run${String.fromCodePoint(point)}tests`, p2: 'Safe prompt' } })
    assert.equal(view.rows().length, 1, `reject U+${point.toString(16)}`)
    assert.ok(view.rows()[0].textContent.includes('Safe prompt'))
  }
  await click(view.rows()[0])
  assert.equal(calls[0].args[1], 'Safe prompt')
})

test('normalizes whitespace but preserves Unicode, ZWJ and ZWNJ in text and SDK calls', async () => {
  const text = 'Chạy 运行 परीक्षण क्\u200dष क्\u200cष 👨\u200d👩\u200d👧\u200d👦 🇻🇳'
  const view = mount({ attrs: { p1: ` \t${text}\r\n   next\tstep ` } })
  await click(view.rows()[0])
  assert.equal(calls[0].args[1], `${text} next step`)
  assert.ok(view.rows()[0].textContent.includes(text))
})

test('dedupes NFC-equivalent full prompts and caps at five ordered attributes', async () => {
  const text = 'Chạy lại test'
  const view = mount({ attrs: { p1: text, p2: text.normalize('NFD'), p3: '  ', p4: false, p5: 'Other', p6: 'Overflow' } })
  assert.equal(view.rows().length, 2)
  await click(view.rows()[1])
  assert.equal(calls[0].args[1], 'Other')
  view.render({ attrs: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i + 1}`, `Prompt ${i + 1}`])) })
  assert.equal(view.rows().length, 5)
  assert.ok(view.rows()[4].textContent.includes('Prompt 5'))
})

for (const [prefix, grapheme] of [
  ['a'.repeat(399), '🚀'], ['a'.repeat(399), 'q\u0301'],
  ['a'.repeat(395), '👨\u200d👩\u200d👧\u200d👦'], ['a'.repeat(398), '🇻🇳'],
  ['a'.repeat(398), '👍🏽']
]) {
  test(`grapheme-safe preview retains full prompt for modified click: ${grapheme}`, async () => {
    const full = prefix + grapheme + 'tail'
    const view = mount({ attrs: { p1: full } })
    const preview = view.container.querySelector('[data-testid="prompt-preview"]')
    assert.equal(preview?.textContent, prefix)
    assert.ok(view.rows()[0].textContent.includes('shortened'))
    await click(view.rows()[0], { metaKey: true })
    assert.deepEqual(calls, [{ method: 'insertText', args: ['session-a', full, { mode: 'block' }] }])
  })
}

test('a single oversized grapheme keeps the full action available without a broken preview', async () => {
  const full = 'q' + '\u0301'.repeat(410)
  const view = mount({ attrs: { p1: full } })
  assert.equal(view.rows().length, 1)
  assert.equal(view.container.querySelector('[data-testid="prompt-preview"]').textContent, '')
  await click(view.rows()[0], { ctrlKey: true })
  assert.equal(calls[0].method, 'insertText')
  assert.equal(calls[0].args[1], full.normalize('NFC'))
})

test('distinct long prompts sharing one preview remain separate, insert-all inserts full lines', async () => {
  const start = 'x'.repeat(410)
  const view = mount({ attrs: { p1: start + ' first', p2: start + ' second' } })
  assert.equal(view.rows().length, 2)
  await click([...view.container.querySelectorAll('button')].find(button => button.textContent.includes('Insert all')), { ctrlKey: true })
  assert.deepEqual(calls, [{ method: 'insertText', args: ['session-a', `${start} first\n${start} second`, { mode: 'block' }] }])
})

test('streaming renders no actions or diagnostics; invalid attrs produce an accessible note', () => {
  const view = mount({ streaming: true })
  assert.equal(view.container.textContent, '')
  view.render({ attrs: { other: 'Not a prompt', p1: '\u202eUnsafe' } })
  assert.equal(view.rows().length, 0)
  const note = view.container.querySelector('[data-testid="directive-drop-badge"]')
  assert.equal(note?.getAttribute('role'), 'note')
  assert.ok(note?.getAttribute('aria-label'))
})

test('SDK composer unavailable fails closed with upgrade notice', async () => {
  const composer = host.composer
  try {
    host.composer = undefined
    const view = mount()
    assert.ok(view.rows()[0].disabled)
    assert.ok(view.container.textContent.includes('Upgrade Hermes Desktop'))
    await click(view.rows()[0])
    assert.deepEqual(calls, [])
  } finally { host.composer = composer }
})

test('shortcuts route only inside their own panel including physical Option digit codes', async () => {
  const first = mount({ sessionId: 'first', attrs: { p1: 'One', p2: 'Two', p3: 'x'.repeat(420) } })
  const second = mount({ sessionId: 'second' })
  const outside = await key(document.body, { altKey: true, key: '1' })
  assert.equal(outside.defaultPrevented, false)
  assert.equal(calls.length, 0)
  const inside = await key(first.rows()[1], { altKey: true, key: '2' })
  assert.equal(inside.defaultPrevented, true)
  await key(first.panel(), { altKey: true, ctrlKey: true, key: '¡', code: 'Digit1' })
  await key(first.panel(), { altKey: true, metaKey: true, key: '3' })
  assert.deepEqual(calls.map(call => [call.method, call.args[0], call.args[1]]), [
    ['insertText', 'first', 'Two'], ['submit', 'first', 'One'], ['insertText', 'first', 'x'.repeat(420)]
  ])
  assert.equal(second.status(), '')
})

test('unrelated, repeated, shifted and composing shortcuts are not consumed', async () => {
  const view = mount()
  for (const init of [
    { key: '1' }, { altKey: true, key: '6' }, { altKey: true, key: '2' },
    { altKey: true, key: '1', repeat: true }, { altKey: true, key: '1', shiftKey: true },
    { altKey: true, key: '1', isComposing: true }
  ]) assert.equal((await key(view.panel(), init)).defaultPrevented, false)
  assert.deepEqual(calls, [])
})

test('native keyboard button activation retains insert default and accessible description', async () => {
  const view = mount()
  const row = view.rows()[0]
  assert.equal(row.tagName, 'BUTTON')
  assert.equal(row.type, 'button')
  const description = document.getElementById(row.getAttribute('aria-describedby'))
  assert.ok(description.textContent.includes('Ctrl/Cmd'))
  assert.ok(view.container.querySelector('[role="status"][aria-live="polite"]'))
  // Keyboard-generated clicks have detail=0; do not infer send from that.
  await click(row, { detail: 0 })
  assert.equal(calls[0].method, 'insertText')
})

test('plain click addresses the render session and waits for insert acknowledgement', async () => {
  const pending = deferred()
  setComposer({ insertText: () => pending.promise })
  const view = mount({ sessionId: 'stored-session-9' })
  await click(view.rows()[0])
  assert.deepEqual(calls, [{ method: 'insertText', args: ['stored-session-9', 'Run the tests', { mode: 'block' }] }])
  assert.ok(!view.status().includes('Inserted'))
  await act(async () => pending.resolve(true))
  assert.equal(view.status(), 'Inserted into the composer.')
})
