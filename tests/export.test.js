// Run: node tests/export.test.js
// Loads background.js with every Chrome API stubbed out and checks the export scrubbing and repro steps.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Any property is another stub and any call returns one; 'then' stays undefined so awaiting a stub doesn't hang.
const stub = new Proxy(function () {}, {
    get: (target, prop) => (prop === 'then' ? undefined : stub),
    apply: () => stub,
    set: () => true,
});
const context = vm.createContext({ chrome: stub, self: stub, indexedDB: stub, console: { log() {}, warn() {}, error() {} }, URL, Blob: stub, setTimeout, clearTimeout, Promise });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
const { scrubNetwork, scrubCapture, reproSteps, EXPORT_SKIP_DEFAULTS } = vm.runInContext('({ scrubNetwork, scrubCapture, reproSteps, EXPORT_SKIP_DEFAULTS })', context);

const log = () => ({
    type: 'request',
    url: 'https://user:pw@api.example.com/v1/me?access_token=abc123&page=2#id_token=xyz',
    method: 'POST',
    headers: { Authorization: 'Bearer abc123', 'Content-Type': 'application/json', Referer: 'https://example.com/?session=s1&q=hi' },
    postData: '{"email":"a@b.co","password":"hunter2","nested":{"api_key":"k1"}}',
    response: {
        status: 200,
        headers: { 'Set-Cookie': 'sid=s1', 'Cache-Control': 'no-store', Location: '/next?token=t2' },
        body: { user: { name: 'Asha', refreshToken: 'r1' }, items: [{ id: 1 }] },
        bodySize: 120,
    },
});
// Objects built inside the vm have its own Object.prototype; deepStrictEqual needs plain copies.
const plain = value => JSON.parse(JSON.stringify(value));
const leaks = text => ['abc123', 'pw@', 'xyz', 'Bearer', 's1', 'hunter2', 'k1', 't2', 'r1'].filter(s => text.includes(s));

// Defaults: no secrets and no bodies.
{
    const original = log();
    const redacted = { secrets: 0, bodies: 0 };
    const [out] = scrubNetwork([original], EXPORT_SKIP_DEFAULTS, redacted);
    assert.deepStrictEqual(leaks(JSON.stringify(out)), []);
    assert.strictEqual(out.postData, undefined);
    assert.strictEqual(out.response.body, undefined);
    assert.strictEqual(out.response.bodySize, 120, 'size stays for the timeline');
    assert.strictEqual(out.url, 'https://api.example.com/v1/me?access_token=REDACTED&page=2#id_token=REDACTED');
    assert.strictEqual(out.headers['Content-Type'], 'application/json');
    assert.strictEqual(out.headers.Referer, 'https://example.com/?session=REDACTED&q=hi');
    assert.strictEqual(out.response.headers['Cache-Control'], 'no-store');
    assert.strictEqual(out.response.headers.Location, '/next?token=REDACTED');
    assert.deepStrictEqual({ ...redacted }, { secrets: 7, bodies: 2 });
    assert.deepStrictEqual(original, log(), 'the captured logs are not changed');
}

// Bodies kept, logins still redacted inside them; everything else in the body survives.
{
    const redacted = { secrets: 0, bodies: 0 };
    const [out] = scrubNetwork([log()], { credentials: true, bodies: false }, redacted);
    assert.deepStrictEqual(leaks(JSON.stringify(out)), []);
    assert.deepStrictEqual(JSON.parse(out.postData), { email: 'a@b.co', password: 'REDACTED', nested: { api_key: 'REDACTED' } });
    assert.deepStrictEqual(plain(out.response.body), { user: { name: 'Asha', refreshToken: 'REDACTED' }, items: [{ id: 1 }] });
    assert.strictEqual(redacted.bodies, 0);
}

// Form-encoded and plain-text bodies.
{
    const redacted = { secrets: 0, bodies: 0 };
    const [form, text, json] = scrubNetwork([
        { url: '/login', postData: 'user=asha&password=hunter2' },
        { url: '/note', postData: 'just some text with password=hunter2 inside' },
        { url: '/ok', postData: '{"page":2}' },
    ], { credentials: true, bodies: false }, redacted);
    assert.strictEqual(form.postData, 'user=asha&password=REDACTED');
    assert.strictEqual(text.postData, 'just some text with password=hunter2 inside', 'free text is left alone');
    assert.strictEqual(json.postData, '{"page":2}', 'unchanged JSON keeps its exact text');
}

// Both switches off: the export is the capture.
{
    const redacted = { secrets: 0, bodies: 0 };
    const [out] = scrubNetwork([log()], { credentials: false, bodies: false }, redacted);
    assert.deepStrictEqual(plain(out), log());
    assert.deepStrictEqual({ ...redacted }, { secrets: 0, bodies: 0 });
}

// Page URLs and link attributes from interactions and snapshots.
{
    const redacted = { secrets: 0, bodies: 0 };
    const el = { tagName: 'A', attributes: { href: '/download?sig=s3&file=a.pdf' } };
    const { interactionLogs, elementSnapshots } = scrubCapture(
        [{ type: 'click', url: 'https://example.com/#access_token=xyz', element: el }],
        [{ url: 'https://example.com/?token=t4', elements: [el] }],
        EXPORT_SKIP_DEFAULTS, redacted);
    assert.strictEqual(interactionLogs[0].url, 'https://example.com/#access_token=REDACTED');
    assert.strictEqual(interactionLogs[0].element.attributes.href, '/download?sig=REDACTED&file=a.pdf');
    assert.strictEqual(elementSnapshots[0].url, 'https://example.com/?token=REDACTED');
    assert.strictEqual(redacted.secrets, 4);
}

// URLs inside free text, as in console messages: the value stops at whitespace.
{
    const redacted = { secrets: 0, bodies: 0 };
    const redactUrl = vm.runInContext('redactUrl', context);
    assert.strictEqual(redactUrl('Save failed for /api?token=t5 Object', redacted), 'Save failed for /api?token=REDACTED Object');
}

// Repro steps: what the user did, then what failed, in time order.
{
    const page = 'https://shop.example.com/cart';
    const button = { tagName: 'BUTTON', text: 'Pay now', attributes: {} };
    const field = { tagName: 'INPUT', attributes: { type: 'text', placeholder: 'Card number' }, selector: '#card' };
    const md = reproSteps({
        exportDate: '2026-10-17T10:00:00.000Z',
        extensionVersion: '9.9.9',
        interactionLogs: [
            { type: 'input', timestamp: 1000, url: page, element: field, valueLength: 4, viewport: { width: 1280, height: 720 } },
            { type: 'input', timestamp: 1500, url: page, element: field, valueLength: 16 },
            { type: 'click', timestamp: 2000, url: page, element: button },
            { type: 'scroll', timestamp: 2500, url: page + '/done', scrollPosition: { x: 0, y: 300 } },
        ],
        networkLogs: [
            { timestamp: 900, url: page, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36' }, response: { status: 200, mimeType: 'text/html', timestamp: 950 } },
            { timestamp: 2100, url: 'https://shop.example.com/api/pay', method: 'POST', response: { status: 502, statusText: 'Bad Gateway', mimeType: 'application/json', timestamp: 2300 } },
        ],
        consoleErrors: [{ timestamp: 2350, message: 'TypeError: x is undefined\n    at pay (app.js:9)', url: 'https://shop.example.com/app.js', line: 9 }],
    });
    assert.ok(md.includes('1. Open https://shop.example.com/cart\n2. Type in field “Card number” (16 characters)\n3. Click button “Pay now”\n4. Go to https://shop.example.com/cart/done\n5. Scroll\n'), md);
    assert.ok(md.includes('- `POST https://shop.example.com/api/pay` → 502 Bad Gateway (+1.2 s)\n- Console: TypeError: x is undefined (https://shop.example.com/app.js:9) (+1.4 s)'), md);
    assert.ok(md.includes('- Chrome 131, Mac OS X, window 1280 × 720'), md);
    const env = ua => reproSteps({ exportDate: '2026-10-17T10:00:00.000Z', networkLogs: [{ timestamp: 1, url: 'https://a.example/', headers: { 'user-agent': ua } }] });
    assert.ok(env('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0').includes('- Edge 131, Windows'));
    assert.ok(env('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36').includes('- Chrome 131, Linux'));
    assert.ok(env('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36').includes('- Chrome 131, Android'));
    assert.ok(md.includes('Capture All v9.9.9'), md);

    const empty = reproSteps({ exportDate: '2026-10-17T10:00:00.000Z' });
    assert.ok(empty.includes('No interactions were recorded.') && empty.includes('Nothing failed'), empty);
}

// The allowedHosts policy: exact hosts, and *. for a domain with its subdomains; nothing else gets through.
{
    const urlAllowed = vm.runInContext('urlAllowed', context);
    assert.strictEqual(urlAllowed('https://anything.example/'), true, 'no policy: no limit');
    vm.runInContext("allowedHosts = ['staging.example.com', '*.test.example.org']", context);
    assert.strictEqual(urlAllowed('https://staging.example.com/a?b=c'), true);
    assert.strictEqual(urlAllowed('http://staging.example.com:8080/'), true, 'port does not matter');
    assert.strictEqual(urlAllowed('https://example.com/'), false);
    assert.strictEqual(urlAllowed('https://prod.example.com/'), false);
    assert.strictEqual(urlAllowed('https://staging.example.com.evil.net/'), false, 'suffix tricks fail');
    assert.strictEqual(urlAllowed('https://test.example.org/'), true, '*. includes the domain itself');
    assert.strictEqual(urlAllowed('https://a.b.test.example.org/'), true);
    assert.strictEqual(urlAllowed('https://nottest.example.org/'), false, 'not a dot boundary');
    assert.strictEqual(urlAllowed('file:///Users/me/report.html'), false);
    assert.strictEqual(urlAllowed('not a url'), false);

    // A redirect from an allowed page to a blocked one keeps the request ID: its response must not attach.
    vm.runInContext("networkLogs = []; attachedTabs.add(7)", context);
    const event = vm.runInContext('onDebuggerEvent', context);
    const src = { tabId: 7 };
    event(src, 'Network.requestWillBeSent', { requestId: 'r1', documentURL: 'https://staging.example.com/login', request: { url: 'https://staging.example.com/login', method: 'GET', headers: {} } });
    event(src, 'Network.requestWillBeSent', { requestId: 'r1', documentURL: 'https://sso.prod.com/', request: { url: 'https://sso.prod.com/', method: 'GET', headers: {} }, redirectResponse: { status: 302 } });
    event(src, 'Network.responseReceived', { requestId: 'r1', response: { status: 200, statusText: 'OK', headers: { 'X-Prod': '1' }, mimeType: 'text/html' } });
    event(src, 'Network.loadingFinished', { requestId: 'r1', encodedDataLength: 10 });
    const logs = plain(vm.runInContext('networkLogs', context));
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].url, 'https://staging.example.com/login');
    assert.strictEqual(logs[0].response, undefined, 'the blocked response stays out');
    assert.strictEqual(logs[0].loadingFinished, undefined);
    vm.runInContext('allowedHosts = null; networkLogs = []; blockedRequests.clear()', context);
}

console.log('export: all checks passed');
