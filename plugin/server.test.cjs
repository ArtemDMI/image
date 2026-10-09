const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');

function startServer() {
    const child = spawn(process.execPath, ['index.js'], { cwd: __dirname });
    let output = '';
    child.stdout.on('data', chunk => {
        output += chunk;
    });
    child.stderr.on('data', chunk => {
        output += chunk;
    });
    return {
        child,
        address() {
            const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);
            return match ? match[0] : '';
        },
    };
}

test('serves the map window and refuses a click without SillyTavern', async () => {
    const server = startServer();
    try {
        let pageUrl = '';
        const started = Date.now();
        while (!pageUrl && Date.now() - started < 5000) {
            pageUrl = server.address();
            if (!pageUrl) {
                await new Promise(resolve => setTimeout(resolve, 40));
            }
        }
        assert.ok(pageUrl);

        const origin = new URL(pageUrl).origin;
        const denied = await fetch(`${origin}/`);
        assert.equal(denied.status, 403);

        const page = await fetch(pageUrl);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Генерация/);
        assert.match(html, /src="\/viewer\.js\?token=/);

        const scriptUrl = new URL(html.match(/src="([^"]+viewer\.js[^"]*)"/)[1], origin);
        const script = await fetch(scriptUrl);
        assert.equal(script.status, 200);
        assert.match(await script.text(), /EventSource/);

        const generateUrl = new URL('/generate', origin);
        generateUrl.search = new URL(pageUrl).search;
        const generate = await fetch(generateUrl, { method: 'POST' });
        assert.equal(generate.status, 409);
        const body = await generate.json();
        assert.match(body.error, /не подключена/);
    } finally {
        server.child.kill();
    }
});
