/**
 * Follow-up — Codex-style click-to-run follow-up prompts for Hermes Desktop.
 *
 * Port of Codex++'s `codex-follow-up.js`, rebuilt on Hermes' own seams instead
 * of DOM scraping. Codex++ had to hide a raw ```json code block and inject a
 * panel after it via MutationObserver + viewport culling + an LRU parse cache;
 * Hermes exposes the transcript as a contribution area, so the model addresses
 * a real component directly and none of that machinery is needed.
 *
 * The model ends a reply with ONE paragraph:
 *
 *   ::followup{p1="Run the tests" p2="Open a PR" p3="Explain the tradeoff"}
 *
 * Attributes are untrusted strings; directive parsing is the host's concern.
 * Turning this plugin off leaves unclaimed directives as ordinary text.
 *
 * Click a row     → inserts the prompt into that chat's composer (you edit, then send).
 * Ctrl/Cmd+click  → dispatches to that chat's composer (not delivery confirmation).
 * "Insert all"    → appends every prompt as separate lines.
 *
 * Routing uses the public SDK and the render sessionId, never app DOM or
 * private event protocols. Submit acknowledges dispatch, not delivery.
 */

import { Codicon, haptic, host, Tip, usePluginI18n } from '@hermes/plugin-sdk'
import { useCallback, useLayoutEffect, useId, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'follow-up'
// Plugins are not scanned by Tailwind; native focus indicators stay intact.
const buttonStyle = { font: 'inherit', color: 'inherit', background: 'transparent', border: 0, borderRadius: 4, textAlign: 'start', cursor: 'pointer' }

const MAX_ITEMS = 5
const MAX_PROMPT_LEN = 400
// Reject disguise controls, but preserve ZWJ/ZWNJ for emoji and Indic scripts.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

/** How long a status line stays before clearing itself. Long enough to read,
 *  short enough that scrolling back to an old reply never shows a stale
 *  "Sent." from days ago. */
const STATUS_TTL_MS = 4000

/** Cut to at most `max` UTF-16 units without splitting a character.
 *
 *  `slice()` counts code units, so it happily cuts an emoji in half (leaving a
 *  lone surrogate that renders as a replacement box) or strips a Vietnamese
 *  tone mark off the letter it belongs to when the text arrives decomposed
 *  (NFD: "ạ" is two code units). Back off to the last boundary instead. */
function cutSafely(text, max) {
  if (text.length <= max) {
    return text
  }

  // Chromium and current Node expose Unicode grapheme segmentation. It keeps
  // complete not only surrogate pairs and NFD accents, but also joined emoji
  // such as 👨👩👧👦, skin-tone sequences and flags.
  if (typeof Intl?.Segmenter === 'function') {
    const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let end = 0

    for (const { index, segment } of graphemes.segment(text)) {
      const next = index + segment.length

      if (next > max) {
        break
      }

      end = next
    }

    return text.slice(0, end)
  }

  // Old engines cannot guarantee a grapheme boundary; show only the badge.
  return ''
}

/** Prompts out of untrusted directive attrs: p1..p5, trimmed, capped, deduped.
 *
 *  Each item carries `truncated` so the row can say so: a prompt silently cut
 *  mid-word lands in the composer looking finished, and the user only finds
 *  out after sending it. */
function promptsFromAttrs(attrs) {
  const seen = new Set()
  const items = []

  for (let i = 1; i <= MAX_ITEMS; i += 1) {
    const raw = attrs?.[`p${i}`]

    if (typeof raw !== 'string' || UNSAFE.test(raw)) {
      continue
    }

    const full = raw.normalize('NFC').replace(/\s+/gu, ' ').trim()
    const prompt = cutSafely(full, MAX_PROMPT_LEN)

    if (!full) {
      continue
    }

    // Dedupe on the full normalized value so distinct long prompts that share
    // the same preview remain separate actions.
    const key = full.normalize('NFC')

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    items.push({
      displayText: prompt,
      fullText: full,
      truncated: full.length > prompt.length
    })
  }

  return items
}

function FollowUpPanel({ attrs, sessionId, streaming }) {
  const t = usePluginI18n(ID)
  const titleId = useId()
  const actionDescriptionId = useId()
  const [status, setStatus] = useState('')
  const statusTimer = useRef(0)
  const alive = useRef(true)
  const locked = useRef(false)
  const [pending, setPending] = useState(false)

  const items = promptsFromAttrs(attrs)
  const supported = (sessionId === null || (typeof sessionId === 'string' && sessionId.trim())) &&
    typeof host.composer?.insertText === 'function' && typeof host.composer?.submit === 'function'

  // Announce through a keyed live region. Re-running the SAME action must
  // re-announce, but an identical string in an unchanged region is silent to
  // screen readers — so bump a nonce and key the node on it.
  const announce = useCallback(message => {
    setStatus(prev => ({ message, nonce: (prev?.nonce ?? 0) + 1 }))

    window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(() => setStatus(''), STATUS_TTL_MS)
  }, [])

  const run = useCallback(
    async (text, send) => {
      if (!alive.current || locked.current || !supported || streaming) return
      locked.current = true
      setPending(true)
      // TranscriptDirectiveProps: null means this transcript has no session.
      // SDK composer.ts: null targets ACTIVE; 'new' targets only the fresh draft.
      const address = sessionId === null ? 'new' : sessionId
      try {
        const ok = send
          ? await host.composer.submit(address, text)
          : await host.composer.insertText(address, text, { mode: 'block' })
        if (!alive.current) return
        if (ok === true) haptic('tap')
        announce(ok === true ? (send ? t('sent') : t('inserted')) : t('noComposer'))
      } catch {
        if (alive.current) announce(t('noComposer'))
      } finally {
        if (alive.current) {
          locked.current = false
          setPending(false)
        }
      }
    },
    [announce, sessionId, streaming, supported, t]
  )

  // Alt+1..5 runs the Nth prompt; add Ctrl/Cmd to send it outright. Bound on
  // the panel's own root, not the window: several replies can carry a panel at
  // once, and a window-level shortcut would fire every one of them. Focus must
  // be inside this panel, which Tab reaches natively.
  const onKeyDown = useCallback(
    event => {
      if (!event.altKey || event.shiftKey || event.repeat || event.isComposing || event.nativeEvent?.isComposing ||
          event.getModifierState?.('AltGraph') || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) ||
          event.target?.isContentEditable || !supported || pending || streaming) {
        return
      }

      const codeMatch = /^Digit([1-5])$/.exec(event.code)
      const keyMatch = /^[1-5]$/.exec(event.key)
      const index = Number(codeMatch?.[1] ?? keyMatch?.[0]) - 1

      if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        return
      }

      event.preventDefault()
      const item = items[index]
      run(item.fullText, item.truncated ? false : event.ctrlKey || event.metaKey)
    },
    [items, pending, run, streaming, supported]
  )

  // Clear a pending timer if the panel unmounts mid-countdown.
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      window.clearTimeout(statusTimer.current)
    }
  }, [])

  // A directive mid-stream is still being typed — render nothing rather than
  // flashing a half-parsed panel.
  if (streaming) {
    return null
  }

  // A panel that renders nothing is indistinguishable from a directive that
  // was never emitted: the user sees an answer with no follow-ups and cannot
  // tell the difference. Mirror the core drop badge instead of vanishing, so
  // a bad `::followup` is visible rather than silent.
  if (!items.length) {
    return jsx(Tip, {
      label: t('emptyDirectiveTip'),
      side: 'top',
      children: jsxs('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px dashed var(--ui-stroke-secondary, #8884)', borderRadius: 6, padding: '2px 8px', fontSize: 12, color: 'var(--ui-text-tertiary, #888)' },
        'data-testid': 'directive-drop-badge',
        role: 'note',
        'aria-label': `${t('emptyDirective')}. ${t('emptyDirectiveTip')}`,
        title: t('emptyDirectiveTip'),
        children: [
          jsx(Codicon, { name: 'debug-disconnect', size: '0.85em' }),
          t('emptyDirective')
        ]
      })
    })
  }

  return jsxs('section', {
    onKeyDown,
    role: 'group',
    'aria-labelledby': titleId,
    'data-testid': 'follow-up-panel',
    'aria-busy': pending,
    style: { marginBlock: 8, display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--ui-stroke-secondary, #8884)', borderRadius: 6, padding: 8 },
    children: [
      jsxs('div', {
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ui-text-tertiary, #888)' },
        children: [
          jsx(Codicon, { name: 'debug-step-over' }),
          jsx('span', { id: titleId, style: { fontWeight: 500, color: 'var(--ui-text-secondary, inherit)' }, children: t('title') }),
          jsx('span', {
            style: { fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--ui-text-quaternary, #888)' },
            'aria-hidden': true,
            children: items.length
          }),
          items.length > 1 &&
            jsx(Tip, {
              label: t('insertAllTip'),
              children: jsxs('button', {
                type: 'button',
                style: { ...buttonStyle, marginInlineStart: 'auto', minHeight: 32, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 },
                disabled: !supported || pending,
                onClick: () => run(items.map(item => item.fullText).join('\n'), false),
                children: [jsx(Codicon, { name: 'insert', size: '0.85em' }), t('insertAll')]
              })
            })
        ]
      }),

      !supported && jsx('p', { role: 'note', children: t('upgradeRequired') }),
      jsx('span', {
        id: actionDescriptionId,
        style: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 },
        children: t('actionDescription')
      }),
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 2 },
        children: items.map((item, index) =>
          jsx(
            Tip,
            {
              label: item.truncated ? t('rowTipTruncated') : t('rowTip'),
              children: jsxs('button', {
                type: 'button',
                'aria-describedby': actionDescriptionId,
                // Alt+N is invisible to a screen reader unless the control
                // says so; the number badge alone is decoration.
                'aria-keyshortcuts': `Alt+${index + 1} Control+Alt+${index + 1} Meta+Alt+${index + 1}`,
                style: { ...buttonStyle, width: '100%', minHeight: 40, display: 'flex', alignItems: 'start', gap: 8, padding: 8, fontSize: 14, lineHeight: 1.4 },
                disabled: !supported || pending,
                onClick: event => run(item.fullText, item.truncated ? false : event.ctrlKey || event.metaKey),
                children: [
                  jsx('span', {
                    style: { display: 'inline-flex', width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center', fontSize: 10, fontVariantNumeric: 'tabular-nums', color: 'var(--ui-text-quaternary, #888)' },
                    children: String(index + 1)
                  }),
                  jsxs('span', {
                    style: { minWidth: 0, flex: 1, overflowWrap: 'anywhere' },
                    children: [
                      jsx('span', { 'data-testid': 'prompt-preview', children: item.displayText }),
                      item.truncated &&
                        jsx('span', {
                          style: { marginInlineStart: 6, paddingInline: 4, fontSize: 10, color: 'var(--ui-text-quaternary, #888)' },
                          // The ellipsis is decorative; the label carries it.
                          title: t('truncatedTip'),
                          children: t('truncated')
                        })
                    ]
                  }),
                  // Keep the affordance quiet without depending on app CSS.
                  jsx(Codicon, {
                    name: 'arrow-right',
                    size: '0.85em',
                    style: { color: 'var(--ui-accent, #7186ef)', opacity: .6, flexShrink: 0 }
                  }),
                  jsx('span', {
                    style: { flexShrink: 0, fontSize: 11, color: 'var(--ui-text-quaternary, #888)' },
                    'aria-hidden': true,
                    children: t('insertAction')
                  })
                ]
              })
            },
            item.fullText
          )
        )
      }),

      // Always mounted so assistive tech has a region to observe; keyed by a
      // nonce so repeating the same action re-announces it.
      jsx('div', {
        style: { paddingInline: 8, fontSize: 11, color: 'var(--ui-text-quaternary, #888)' },
        role: 'status',
        'aria-live': 'polite',
        children: status
          ? jsx('span', { children: status.message }, String(status.nonce))
          : null
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Follow-up',
  // This plugin was explicitly installed for the user's Codex-style workflow.
  // Keep it active when no persisted choice exists; Settings → Plugins can
  // still override this with an explicit false decision.
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register({
      en: {
        title: 'Follow-up',
        rowTip: 'Click to insert · Ctrl/Cmd+click to send · Alt+N',
        rowTipTruncated: 'Shortened to fit · click to insert the full prompt for review',
        actionDescription: 'Click to insert. Ctrl/Cmd-click dispatches to this composer, not a delivery confirmation. Alt+1–5 inserts; Ctrl/Cmd+Alt+1–5 dispatches. Shortened prompts always insert in full for review.',
        truncatedDescription: 'This prompt is shortened in the preview and will be inserted in full for review.',
        insertAction: 'Insert',
        truncated: 'shortened',
        truncatedTip: 'This prompt was longer than 400 characters and was cut short.',
        insertAll: 'Insert all',
        insertAllTip: 'Append every prompt to the composer',
        inserted: 'Inserted into the composer.',
        sent: 'Sent to composer; delivery is not confirmed.',
        upgradeRequired: 'Upgrade Hermes Desktop to use session-scoped follow-ups.',
        noComposer: 'No visible composer in this chat.',
        emptyDirective: 'Follow-ups skipped: no prompts given',
        emptyDirectiveTip: 'The follow-up directive carried no usable prompt (expected p1="…").'
      },
      vi: {
        title: 'Gợi ý tiếp theo',
        rowTip: 'Nhấn để chèn · Ctrl/Cmd+nhấn để gửi ngay · Alt+N',
        rowTipTruncated: 'Đã rút gọn · nhấn để chèn toàn bộ nội dung để xem lại',
        actionDescription: 'Nhấn để chèn. Ctrl hoặc Command và nhấn để gửi ngay. Gợi ý đã rút gọn luôn được chèn đầy đủ để xem lại.',
        truncatedDescription: 'Gợi ý này đã được rút gọn trong phần xem trước và sẽ được chèn đầy đủ để xem lại.',
        insertAction: 'Chèn',
        truncated: 'đã rút gọn',
        truncatedTip: 'Gợi ý này dài hơn 400 ký tự nên đã bị cắt bớt.',
        insertAll: 'Chèn tất cả',
        insertAllTip: 'Thêm mọi gợi ý vào khung soạn',
        inserted: 'Đã chèn vào khung soạn.',
        sent: 'Đã chuyển đến khung soạn; chưa xác nhận chuyển tin.',
        upgradeRequired: 'Hãy nâng cấp Hermes Desktop để dùng gợi ý theo phiên.',
        noComposer: 'Không thấy khung soạn đang hiển thị.',
        emptyDirective: 'Đã bỏ qua gợi ý: không có nội dung',
        emptyDirectiveTip: 'Directive gợi ý không kèm nội dung dùng được (cần p1="…").'
      }
    })

    ctx.register({
      id: 'directive',
      area: 'transcript.directives',
      data: {
        name: 'followup',
        // A session switch remounts local state and invalidates pending completions.
        // null (fresh draft) and undefined (unsupported host) stay distinct.
        render: ({ attrs, sessionId, streaming }) => jsx(
          FollowUpPanel, { attrs, sessionId, streaming }, `${typeof sessionId}:${sessionId}`
        )
      }
    })
  }
}
