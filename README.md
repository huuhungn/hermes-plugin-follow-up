# Follow-up

Codex-style click-to-run follow-up prompts for Hermes Desktop — a port of
Codex++'s `codex-follow-up.js`, rebuilt on Hermes' own extension seams.

The model ends a reply with one paragraph:

```
::followup{p1="Run the tests" p2="Open a PR" p3="Explain the tradeoff"}
```

which renders as a small panel of clickable rows.

The prompts follow the **user's current language** — English in an English
conversation, Vietnamese with full diacritics in a Vietnamese one, native
script in other languages. The language/quality contract lives in
`$HERMES_HOME/SOUL.md`; the renderer preserves non-ASCII text byte-for-byte.
It also normalizes only for deduplication and will not split an emoji or a
combining diacritic when applying the 400-character cap.

- **Click** a row → inserts the prompt into that chat's composer (edit, then send).
- **Ctrl/Cmd+click** → sends immediately.
- **Alt+1..5** → runs the Nth prompt without the mouse; add Ctrl/Cmd to send it
  outright. Bound to the panel, not the window, so with several replies on
  screen only the focused panel responds (Tab reaches it natively).
- **Insert all** → appends every prompt as separate lines.

A prompt longer than 400 characters is cut to fit and the row says so —
otherwise a shortened prompt lands in the composer looking complete. The cut
uses `Intl.Segmenter` grapheme boundaries, so it never splits an emoji ZWJ
sequence, a regional-indicator flag, or a decomposed (NFD) diacritic; the
regex fallback covers runtimes without `Intl.Segmenter`.

Every action is announced through a polite `role="status"` live region, so
screen-reader users hear the result. The status clears itself after 4s: it used
to persist, which meant scrolling back to an old reply showed a stale "Sent."

## Install

This repository is the **unified package** layout: the desktop half lives in
`desktop/plugin.js`. Install it into any Hermes plugins root and Electron copies
that half into `$HERMES_HOME/desktop-plugins/follow-up/` for you.

```bash
git clone https://github.com/anhtahaylove/hermes-plugin-follow-up   ~/.hermes/plugins/follow-up
```

Then restart Desktop (or use **Settings -> Plugins -> Rescan**). It is enabled by
default once installed; an explicit **Settings -> Plugins** toggle still wins.
2. In the desktop app: ⌘K → **Reload desktop plugins**.
3. Teach the model to emit the directive — see the "Follow-up suggestions"
   section appended to `$HERMES_HOME/SOUL.md`.

Turning the plugin off is safe: an unclaimed directive renders as plain text.

## Why it isn't a port of the Codex++ approach

Codex++ had no extension API, so it scraped the DOM: hide the raw ```json
block, MutationObserver the transcript, cull by viewport, LRU-cache parses in
`localStorage`, and guess at the composer with a list of CSS selectors.

Hermes exposes the transcript as a contribution area, so ~800 lines of
scaffolding collapse to a registration:

| Codex++ | Here |
| --- | --- |
| MutationObserver + `scan()` + viewport culling | `transcript.directives` area |
| Parse cache, panel cache, `localStorage` LRU | React renders from attrs |
| `<style>` injection, hardcoded colors | app UI kit + theme variables |
| Composer discovery by selector list | `[data-composer-target]` ancestor |
| `document.execCommand` / value setters | `hermes:composer-insert` / `-submit` |

The one thing worth keeping was its **toggle** interaction (Ctrl+click), which
survives here as click-to-insert vs Ctrl-click-to-send.

## Routing

Prompts are routed to the chat surface the panel is rendered **inside**, found
by walking up to `[data-composer-target]` — which wraps both the transcript and
its composer. With split tiles the prompt lands in the chat you clicked in.

Submit carries that surface's `data-composer-surface-id` and **fails closed**
without it, matching core's own rule (`requestComposerSubmit` in
`app/chat/composer/focus.ts`): with keep-alive tabs mounted but hidden, a
broadcast without exact surface identity could be claimed by the wrong
composer. Clicks inside a buried tab therefore do nothing.

Inserts are deferred to a macrotask (core's focus-restoration contract);
submits dispatch synchronously (deferring lets a tab reveal steal the target).

## Tests

```bash
bash tests/run.sh
```

Mounts the plugin with real React 19 + jsdom and asserts on the actual
CustomEvents the composer bus subscribes to; then checks the SOUL.md syntax
against core's own directive parser, plus a drift guard that fails if core's
regexes change. The suite verifies `plugin.js` by hash before running, so it
can never pass against a stale copy.

Validated by mutation: removing the surface-id guard, the streaming guard, the
hidden-pane check, the ctrl-click branch, or the length cap each turns the
suite red.

## Limits

- Prompts cannot contain `"` — core's attribute regex ends the value there.
  Keep them under ~120 chars; all five must fit core's 1024-char brace budget.
- Max 5 prompts (`p1`..`p5`); each is truncated at 400 chars.
- Desktop only. Other surfaces show the directive as plain text.
