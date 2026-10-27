# Changelog

## 1.0.0 — 2026-10-27

- Use public `host.composer` APIs and the transcript contribution's session
  identity instead of querying app markup or dispatching internal events.
- Disable actions on incompatible hosts or missing identities. Fresh drafts
  explicitly target `new`, never an unrelated active chat.
- Lock pending actions and invalidate stale completions when the panel unmounts
  or changes owner. Report SDK dispatch separately from confirmed delivery.
- Retain full prompts behind grapheme-safe 400-character previews. Truncated
  previews always insert the complete text for review, never submit it directly.
- Ship a self-contained React/jsdom SDK test loader, locked development
  dependencies, and Windows/Linux Node 22/24 CI.
- Replace copied-parser assurances with optional checks against actual upstream
  source. Separate renderer verification from model-policy and live Desktop tests.
- Document compatibility, installation, prompt-policy setup, permissions and
  catalog provenance. No automatic instruction edits, updates or model calls.

## 0.1.0

- Initial public Follow-up Desktop contribution.
