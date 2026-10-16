# Capture All

Chrome extension (Manifest V3) that records network logs, user interactions and DOM
element snapshots, then exports JSON plus a self-contained interactive HTML timeline.
All data stays local — privacy is a product requirement, not an afterthought.
Remote: `github.com/ishkapoor2000/Capture-All---Offline-Network-Logs-and-Visuals`.

## Commands
No build step — plain JS, loaded unpacked.
- Load: `chrome://extensions` → Developer mode → "Load unpacked" → this folder.
- After editing `background.js` or `manifest.json`, hit **Reload** on the extension card.
- After editing `content.js`, reload the extension *and* the target page.
- Bump `version` in `manifest.json` for any user-visible change.
- Test export scrubbing and repro steps: `node tests/export.test.js`.

## Files
- `manifest.json` — MV3 manifest. Permissions: `activeTab, storage, tabs, scripting,
  debugger, downloads, tabCapture, offscreen`. Adding a permission is a user-facing
  change (re-prompts on update) — don't add one casually. Its CSP blocks network access from
  extension pages and the worker (`connect-src 'self'`); keep it that way.
- `managed_schema.json` — the `allowedHosts` admin policy (enforced via `urlAllowed` in `background.js`).
- `background.js` — service worker. Owns the Chrome Debugger API attachment and network capture.
- `content.js` — injected into the page; captures clicks, scrolls, drags, inputs, keys, DOM snapshots.
- `offscreen.html` / `offscreen.js` — offscreen document, used for recording work the
  service worker can't do directly.
- `popup.html` / `popup.js` / `styles.css` — the extension UI.
- `VIDEO_FEATURE_DOCUMENTATION.md` — read before touching capture/playback.

## Conventions
- MV3 service workers are **ephemeral** — never hold state in a module-level variable
  expecting it to survive; persist to `chrome.storage`.
- Always `chrome.debugger.detach` on stop/error; a stranded attachment leaves the
  "being debugged" banner on the user's tab.
- Exported HTML timeline must stay fully self-contained (no external requests) — that's
  what makes the export offline-safe. `TIMELINE_CSP` enforces it in both timelines.
- Nothing captured should ever leave the machine. No telemetry, no remote endpoints.
