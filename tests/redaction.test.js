// Run: node tests/redaction.test.js
// Loads background.js with every Chrome API stubbed out and checks the export scrubbing.
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
const context = vm.createContext({ chrome: stub, self: stub, indexedDB: stub, console: { log() {}, warn() {}, error() {} }, URL, Blob: stub, setTimeout, Promise });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
const { scrubNetwork, scrubCapture, EXPORT_SKIP_DEFAULTS } = vm.runInContext('({ scrubNetwork, scrubCapture, EXPORT_SKIP_DEFAULTS })', context);

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

console.log('redaction: all checks passed');
