# Changelog

## 0.1.1

- Compose-box buttons now live in a shared toolbar row above the input box (created on demand,
  shared with other Marinara extensions) instead of inside `.mari-chat-input-box`, which was
  squeezing the compose textarea on narrow windows. See
  `../NOTES-compose-box-ui-placement.md` for the analysis behind this change.

## 0.1.0

- Initial port of SillyTavern's built-in Quick Reply extension to Marinara Engine, text-snippet scope only (no
  STscript — see README "Known limitations").
- Dropdown trigger (replaces the original's per-QR button bar) that doubles as the nested context-menu system.
- Global / chat / character scoping, merged at render and execute time.
- Auto-execute triggers (startup, chat change, after user message, after AI message) with a reentrancy guard.
- Full set/quick-reply CRUD, JSON import/export per set.
- Settings persisted via `marinara.storage`, with `localStorage` fallback.
