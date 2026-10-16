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

### Limit recording to your test sites
Set the extension policy `allowedHosts` to a list of host names: `staging.example.com` for one host, or
`*.example.com` for that domain and every subdomain. Ports don't matter. Once it's set:

- Start is refused on every other site, and the popup says the organization doesn't allow it.
- If a recorded tab moves to another site, nothing from there is kept. Network requests are judged by the page
  that made them, and console errors and interactions by the tab's current site.
- Local files (`file://`) can't be recorded.

Users can't change it. Leave it unset for no limit. Examples, with your extension ID in place of `<extension-id>`:

Google Admin console → Apps & extensions → Capture All → Policy for extensions:
```json
{ "allowedHosts": { "Value": ["*.staging.example.com", "qa.example.com"] } }
```

Linux, a file in `/etc/opt/chrome/policies/managed/`:
```json
{ "3rdparty": { "extensions": { "<extension-id>": { "allowedHosts": ["*.staging.example.com", "qa.example.com"] } } } }
```

Windows uses the same key under `Software\Policies\Google\Chrome\3rdparty\extensions\<extension-id>\policy`, and
macOS a configuration profile for `com.google.Chrome.extensions.<extension-id>`. The schema is in
`managed_schema.json`.

### Other controls
- Allow or block the extension with the `ExtensionInstallAllowlist` / `ExtensionInstallBlocklist` policies.
- Don't use `ExtensionSettings` → `runtime_blocked_hosts` for this. Chrome's debugger API handles that policy
  separately: depending on the Chrome version, a blocked host can turn off network capture on every site.

## For security reviewers

**No network access.** The manifest's Content Security Policy lets the popup, the background service worker and the
offscreen document connect only to the extension itself (`connect-src 'self' blob: data:`, `default-src 'self'`).
Every exported `timeline.html` carries its own policy with `default-src 'none'`: it can't load or send anything,
and only plays the `video.webm` next to it. There is no remote code; every script ships in the extension.

| Permission | Why it's needed |
|---|---|
| `debugger` | Reads the recorded tab's network requests, responses and console errors. Chrome shows the "being debugged" banner while it's attached; it's detached on Stop. |
| `tabs` | Reads the tab's URL to decide whether it can be recorded, and follows the recorded tab across page loads. |
| `activeTab` | Access to the tab where the user clicked the extension. |
| `scripting` | Adds the interaction recorder (`content.js`) to the recorded tab. |
| `<all_urls>` host access | Adds the recorder again after each page load in the recorded tab, and for "Start on next website". `allowedHosts` narrows where it records. |
| `storage` | Keeps the recording in the browser until it's exported; reads the `allowedHosts` policy. |
| `downloads` | Saves the export `.zip` where the user chooses. |
| `tabCapture` | Video mode: records the tab as video. |
| `offscreen` | Runs the video recorder and builds the `.zip`; a service worker can do neither. |
