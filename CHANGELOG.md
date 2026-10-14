# Changelog

Each change is its own commit on the `ui-redesign` branch, so any step can be undone on its own.
List the commits with `git log --oneline main..ui-redesign`.

## 1.0.14: Skip in export (2026-10-14)

A **Skip in export** panel in the popup, with one switch per kind of sensitive data. Both start on. React and
similar frameworks copy a field's typed value into its `value` attribute, so with nothing skipped, v1.0.13 exports
held passwords, emails and notes from every keystroke.

- **Typed text**: drops `value` from text, password, email and every other field-type input and textarea, and the
  text of textareas and rich-text editors (`contenteditable`). Button labels and checkbox/radio values are kept, and
  typing still shows as "Typed ×12".
- **Private areas**: drops text and `value` inside `.rr-mask`, `.rr-block` or `[data-private]` (rrweb's markers).
  Selector, position and size are kept.
- Switches apply when the zip is built (`exportAllLogs` in `background.js`), to both `logs.json` and
  `timeline.html`. Capture is unchanged apart from tagging elements `private` / `editable`, so raw values stay in
  browser storage until export or Clear. The choice is remembered, survives Clear, and is written to `logs.json`
  as `exportSkip`.
- No "hidden fields" switch: Chrome hides `input[type=hidden]`, so they never reach interactions or snapshots.

Not covered yet: network request and response headers and bodies are exported as captured (planned next).

| What changed | Checks passed | Undo just this |
|---|---|---|
| `content.js`, `background.js`, `popup.html`, `popup.js`, `styles.css`, `manifest.json`, `README.md` | End-to-end test on a React-style form (video mode), one recording exported three ways. Defaults: no typed password, email, note, editor text or private text in `logs.json` interactions/snapshots or `timeline.html`; submit label, checkbox value and button text kept; typing still counted; zip has timeline, logs and video; timeline opens with no errors and lists the clicked button. All off: every value exported. Private areas off only: private text exported, typed text not. Popup: switch saves, summary updates, choice remembered. Hidden inputs confirmed never captured. | `git revert` the v1.0.14 commit (`git log --grep v1.0.14`) |

## 1.0.13: Motion, and clearer Network / Interactions / Snapshots (2026-10-10)

Motion ideas come from the 21st.dev motion libraries (Motion Primitives, Magic UI, Animate UI and others), rebuilt in plain CSS and a little JS so the exports stay self-contained: sliding tab and filter highlights, spring easing, odometer digits, count-up numbers, blur-in cascades, a cursor spotlight, ripples, a border light while playing or recording, a magnetic play button with a progress ring, and a play/pause icon morph. Everything turns off under "reduce motion".

**Session replay**
- Network: filter by API / Pages / JS & CSS / Media / Errors, hide CORS preflight, search, duration and size with a speed bar. Open a row for query parameters, headers, request body and a highlighted JSON response, plus Copy URL and Copy as cURL. Requests the browser canceled after a 2xx no longer count as errors.
- Interactions: rows read as actions ("Clicked" on button “Edit booking”, "Typed ×9" in input “Patient name”). Scroll bursts and keystrokes in one field collapse into one row, and page changes get a divider. Open a row for the selector, XPath (both copyable), text, link and position.
- Snapshots: each row shows a layout thumbnail and counts by element type. Open one to outline every in-view element on the video, find elements by text or selector, filter by type, and copy one selector or the whole snapshot as JSON. Hovering the list lights up the element on the video and the map. Snapshots appear as diamonds on the scrubber.
- Player: hovering the scrubber shows the time and the nearest click, snapshot or page change. Click markers show the clicked element's name. Follow keeps the current row in view while the video plays. Scroll the list by hand and a "Back to now" button appears.
- Keyboard: `/` jumps to the filter, `F` turns Follow on or off, Enter or Space opens a row, ↑/↓ move between rows, and Esc hides the outlines.

**Capture** (`content.js`): clicks on an icon or span inside a button or link are recorded as that button or link, and `aria-label` / `role` are kept so icon-only controls get a name in snapshots and the interaction list.

**Logs timeline**: event details use the same views (cURL, headers, the snapshot map and element list). Totals count up, pills cascade in and get a cursor spotlight.

**Popup**: the mode thumb slides between options, counts roll like an odometer, Start gets a sheen, icons animate on hover, a shutter flash follows a snapshot, the Clear confirm window drains along the button's bottom edge, and toasts show how long they will stay.

| What changed | Checks passed | Undo just this |
|---|---|---|
| `background.js`, `content.js`, `popup.html`, `popup.js`, `styles.css`, `manifest.json`, docs | Player checks (17/17 on the v1.0.12 Redcliffe export), new feature checks on a fresh recording with snapshots (snapshot outlines line up with the recorded click), follow checks on a 391-request session, a 6,000-request / 3,000-interaction synthetic session (loads in ~3 s, search ~15 ms), XSS probes in every captured field with all details open, logs timeline (light/dark, pill → right event), popup checks, reduced motion | `git checkout 97434d7 -- background.js content.js popup.html popup.js styles.css manifest.json README.md VIDEO_FEATURE_DOCUMENTATION.md` |

## 1.0.12: UI redesign (2026-10-10)

| Commit | What changed | Checks passed | Undo just this |
|---|---|---|---|
| `79707e6` | **Baseline.** The working v1.0.11 exactly as it was before the redesign. | Full journey export, player checks, quick-close, page-load and auto-update checks | `git checkout 79707e6 -- .` restores every file to this point |
| `3d694cf` | **Popup.** Neutral palette with one red accent, light and dark themes, a single Start/Stop button, inline two-step Clear (no `confirm()` dialog), focus rings, ARIA states, reduced motion, version 1.0.12. | Popup check: themes, Tab reaches every control, Clear arm/confirm/timeout, Start/Stop through the real popup, reduced motion | `git revert 3d694cf` |
| `2832340` | **Exports.** Session replay and logs timeline restyled to match the popup, with keyboard seeking (←/→, Home/End), arrow keys between tabs and labelled controls. Logs timeline: captured values are now escaped (no script runs from captured pages), and clicking an event opens that event instead of a neighbour. | Player checks on a fresh v1.0.12 zip, keyboard/slider check, logs check (light/dark, pill → right event, XSS probes inert), no network requests when opened | `git revert 2832340` |

### To go back to the pre-redesign extension
1. `git checkout 79707e6 -- .` (or `git switch main` for the version before this session's work)
2. Reload the extension on `chrome://extensions`.
