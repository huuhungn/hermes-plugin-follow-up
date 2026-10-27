# Follow-up

Session-scoped, clickable next-step prompts for **Hermes Desktop**. Follow-up
renders prompts authored in the current assistant reply; it makes **no additional
model calls**, reads no other sessions, requires no API keys, and does not update
itself.

```text
::followup{p1="Run the tests for this change" p2="Explain this implementation"}
```

## Compatibility

Requires Hermes **0.22.5 or later**, including a Desktop build exposing both
`host.composer` and the owning `sessionId` in `transcript.directives` render
props. These props landed in Hermes commit
`c78ca093aa4b6759c055c3ed2bfbe7f741cf0292` (2026-10-23). Older 0.22.5 canaries
can predate that contract: missing SDK methods or session identity **disable
all actions**, with an explanatory compatibility notice. The version number is
an installation floor, not proof of a compatible Desktop bundle.

The plugin uses public Desktop SDK contributions and composer APIs only. It
does not query, rewrite, or patch Hermes core markup and does not dispatch
internal composer events.

## Install

Until a catalog submission is reviewed and merged, install from this public
repository using Hermes' custom Git-source flow:

```sh
hermes plugins install https://github.com/huuhungn/hermes-plugin-follow-up
hermes plugins enable follow-up
```

The repository includes `plugin.yaml` and `desktop/plugin.js`. No npm packages
are needed at runtime; Hermes supplies React and `@hermes/plugin-sdk`. The npm
dependencies below are development-only.

A catalog listing, if accepted, will pin a reviewed commit. Publishing a new
commit here does not update that pin or any installed copy automatically.

## Interaction and safety

- **Click**: insert the full prompt into the owning chat's composer for review.
- **Ctrl/Cmd-click**: request immediate submission through that chat's composer.
  This is an explicit user action, not autonomous execution.
- **Alt+1..5**: insert a row while this panel is focused; add Ctrl/Cmd to request
  submission. Shortcuts are local to the panel, never window-wide.
- **Insert all**: insert full prompts as separate lines.
- Prompts over 400 characters have a grapheme-safe preview. Their **full text**
  is retained; even a modified click inserts it for review instead of submitting
  an abbreviated instruction.
- Pending operations lock the panel. Session changes and unmounts invalidate
  stale completions; a successful insert requires the SDK acknowledgement.
- A submission result means only that the SDK dispatched to the composer,
  **not** confirmed message delivery or model execution.
- Hidden, absent, or disabled composers fail closed through the SDK. Explicit
  fresh-draft identity routes to `new`, never the active chat as a fallback.
- C0/C1 and bidi controls are rejected. Unicode, including Vietnamese accents,
  emoji, ZWJ and ZWNJ, is preserved; equivalent prompts are deduplicated.
- English and Vietnamese UI strings and accessible status announcements are
  included. Streaming replies do not expose actionable partial prompts.

**Disclosure:** Desktop plugins run with the application's authority, not in a
sandbox. This plugin has no network, filesystem, credential, or storage access
of its own. Ctrl/Cmd-click can submit model-authored text, so review suggestions
before using it, particularly suggestions about external side effects.

## Prompt policy is separate from rendering

Installing this Desktop-only plugin does **not** edit `SOUL.md`, inject a system
prompt, or generate suggestions independently. The model must already know the
`::followup` convention. If needed, review and add the following instruction to
your own assistant instructions manually:

> When a concrete, safe next step remains for the current task, end with one
> standalone paragraph of the form `::followup{p1="Run this change's tests"}`.
> Offer one strong prompt, up to five only when genuinely distinct and needed.
> Use the user's current language, full accents and native script. Each prompt
> must be complete and sendable verbatim, within the current session's scope
> and ownership. Do not suggest completed work, another session's work,
> placeholders, or unapproved external side effects. Prefer review or dry-run
> when execution is not authorized. Omit the directive for self-contained
> answers. Avoid double quotes, Markdown syntax, URLs, email addresses, and
> newlines inside prompt values so Markdown does not split the directive.

Language policy and whether a suggestion is useful are model-policy concerns;
the renderer does not claim to verify them. Turning the plugin off leaves
ordinary text rather than breaking the conversation.

## Development and verification

Use a supported Node version from `package.json` (Node 22 or 24 recommended):

```sh
npm ci --ignore-scripts
npm test
```

The test loader maps `@hermes/plugin-sdk` to a test-only stub. No copy into
`node_modules`, real model request, live composer, or user's instruction file
is required. Tests exercise the real plugin component, SDK calls, async locks,
fail-closed routing, Unicode, accessibility and status behavior. They do not
prove model-policy compliance or live Hermes Desktop delivery.

Optional upstream parser/CSS integration checks require an explicit Hermes
source/build checkout; see test skip messages for required environment
variables. Without that checkout, they must skip rather than validate a copied
parser. Before publication, run Hermes' own admission validator:

```sh
hermes plugins validate . --json
```

CI runs component tests on Windows and Linux with Node 22 and 24. A real
Desktop visual/split-pane smoke test remains a separate check; do not infer
pixel fidelity or end-to-end delivery from jsdom.

## License

MIT. Originally inspired by Codex++ follow-up interactions, rebuilt on Hermes'
public extension surfaces.
