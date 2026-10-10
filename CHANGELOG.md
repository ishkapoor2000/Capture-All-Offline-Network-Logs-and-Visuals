# Changelog

Each change is its own commit on the `ui-redesign` branch, so any step can be undone on its own.
List the commits with `git log --oneline main..ui-redesign`.

## 1.0.12: UI redesign (2026-10-10)

| Commit | What changed | Checks passed | Undo just this |
|---|---|---|---|
| `79707e6` | **Baseline.** The working v1.0.11 exactly as it was before the redesign. | Full journey export, player checks, quick-close, page-load and auto-update checks | `git checkout 79707e6 -- .` restores every file to this point |
| `3d694cf` | **Popup.** Neutral palette with one red accent, light and dark themes, a single Start/Stop button, inline two-step Clear (no `confirm()` dialog), focus rings, ARIA states, reduced motion, version 1.0.12. | Popup check: themes, Tab reaches every control, Clear arm/confirm/timeout, Start/Stop through the real popup, reduced motion | `git revert 3d694cf` |
| `2832340` | **Exports.** Session replay and logs timeline restyled to match the popup, with keyboard seeking (←/→, Home/End), arrow keys between tabs and labelled controls. Logs timeline: captured values are now escaped (no script runs from captured pages), and clicking an event opens that event instead of a neighbour. | Player checks on a fresh v1.0.12 zip, keyboard/slider check, logs check (light/dark, pill → right event, XSS probes inert), no network requests when opened | `git revert 2832340` |

### To go back to the pre-redesign extension
1. `git checkout 79707e6 -- .` (or `git switch main` for the version before this session's work)
2. Reload the extension on `chrome://extensions`.
