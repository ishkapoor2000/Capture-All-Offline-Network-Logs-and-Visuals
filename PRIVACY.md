# Privacy

Capture All makes no network requests of its own. It has no server, no account, no analytics and no telemetry.
Everything it records stays in the browser's local storage until you export it, and the export is a `.zip` saved
wherever you choose. The `timeline.html` inside loads nothing from the internet.

## What it records
Only in the tab where you press Start, and only until you press Stop:

- **Network:** URL, method, headers, POST data, status, and the bodies of text, JSON and XML responses
  (via the Chrome debugger, the same data DevTools shows).
- **Console errors:** the text of `console.error` calls, failed asserts and uncaught exceptions, with file and
  line. Objects passed to the console are recorded only as their type (`Object`, `Array(3)`), never their contents.
- **Interactions:** clicks, scrolls, drags, inputs and keys, with the page URL and a description of the element.
- **Element snapshots:** tag, selector, position and visible text of elements on the page.
- **Video** (Video mode only): the tab as you see it.

## What the export leaves out by default
The **Skip in export** panel in the popup has one switch per kind of data. All of them start on. Turning one off
puts that data back in the next export.

| Switch | Left out of the export |
|---|---|
| Typed text | Values of text fields and editors, passwords included |
| Private areas | Anything inside `data-private`, `.rr-mask` or `.rr-block` |
| Logins and keys | Auth and cookie headers; URL parameters, JSON keys and form fields named like a token, key, session, password or signature (they become `REDACTED`), also in URLs inside console messages; `user:password@` in URLs |
| Request and response bodies | POST data and response bodies (their size stays) |

`timeline.html` and `repro.md` are built from the same filtered data. `logs.json` records which switches were on (`exportSkip`) and how many values were left out (`redacted`). The popup
shows the same count after each export.

Matching works on **names**, not content. A token in an oddly named field, or personal data such as a name or
phone number inside a page or a kept body, is not detected. **Video can't be redacted**: it shows whatever was on
screen. Look through an export before sharing it outside your team.

## For IT administrators
- Allow or block the extension with the `ExtensionInstallAllowlist` / `ExtensionInstallBlocklist` policies.
- `ExtensionSettings` → `runtime_blocked_hosts` is **not** a reliable way to limit recording to certain sites. It
  keeps the content script off blocked sites, but Chrome's debugger API handles the policy separately: depending
  on the Chrome version, a blocked host can turn off network capture on every site instead. Test on a managed
  profile before relying on it.
- The `debugger` permission is what lets Capture All read network traffic. Chrome shows the "being debugged"
  banner on the tab for as long as recording runs.
