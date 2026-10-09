const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const BODY_LIMIT = 32 * 1024 * 1024;
const PING_MS = 15_000;

const token = crypto.randomBytes(16).toString('hex');
const clients = new Set();
let httpServer = null;
let origin = '';
let leaderId = null;
let starting = null;
let currentJobId = 0;
let latestImage = null;
let pingTimer = null;

function tokenOk(value) {
    const given = Buffer.from(String(value ?? ''));
    const expected = Buffer.from(token);
    if (given.length !== expected.length) {
        return false;
    }
    return crypto.timingSafeEqual(given, expected);
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(payload);
}

function sendEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
    for (const client of [...clients]) {
        try {
            sendEvent(client.res, event, data);
        } catch {
            clients.delete(client);
        }
    }
}

function setLeader(id) {
    leaderId = id;
    broadcast('leader', { leaderId });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const fail = error => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };
        req.on('data', chunk => {
            size += chunk.length;
            if (size > BODY_LIMIT) {
                fail(new Error('Слишком большой запрос'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        req.on('error', fail);
    });
}

async function readJson(req) {
    const raw = await readBody(req);
    if (raw.length === 0) {
        return {};
    }
    try {
        return JSON.parse(raw.toString('utf8'));
    } catch {
        throw new Error('Некорректный JSON');
    }
}

function sameJob(value) {
    return Number(value) === currentJobId && currentJobId > 0;
}

function hostIsConnected() {
    return [...clients].some(client => client.role === 'host' && client.id === leaderId);
}

function openEvents(req, res, url) {
    if (!tokenOk(url.searchParams.get('token'))) {
        sendJson(res, 403, { error: 'Неверный token' });
        return;
    }

    const role = url.searchParams.get('role') === 'host' ? 'host' : 'view';
    const client = {
        id: crypto.randomBytes(8).toString('hex'),
        role,
        res,
    };
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        // Tell proxies not to buffer the stream, or the map tab never sees a new picture.
        'X-Accel-Buffering': 'no',
    });
    res.write('\n');
    clients.add(client);
    sendEvent(res, 'hello', { id: client.id, role });
    if (role === 'host') {
        // The newest chat tab wins, so two open chats cannot both spend a click.
        setLeader(client.id);
    }
    req.on('close', () => {
        clients.delete(client);
        if (leaderId !== client.id) {
            return;
        }
        const hosts = [...clients].filter(item => item.role === 'host');
        setLeader(hosts.length > 0 ? hosts[hosts.length - 1].id : null);
    });
}

async function acceptResult(req, res) {
    const body = await readJson(req);
    if (!sameJob(body.jobId)) {
        sendJson(res, 409, { error: 'Устаревшая генерация' });
        return;
    }
    if (body.ok === false) {
        const message = String(body.message || 'Ошибка генерации').slice(0, 300);
        broadcast('status', { phase: 'error', message, jobId: currentJobId });
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
    }

    const mime = String(body.mime || '');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) {
        throw new Error('Неизвестный формат картинки');
    }
    const buffer = Buffer.from(String(body.image || ''), 'base64');
    if (buffer.length < 32) {
        throw new Error('Пустая картинка');
    }
    latestImage = { buffer, mime, jobId: currentJobId };
    broadcast('image', { jobId: currentJobId });
    broadcast('status', { phase: 'ready', message: 'Готово', jobId: currentJobId });
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
}

async function acceptProgress(req, res) {
    const body = await readJson(req);
    if (!sameJob(body.jobId)) {
        sendJson(res, 409, { error: 'Устаревшая генерация' });
        return;
    }
    if (body.phase !== 'prompt' && body.phase !== 'image') {
        throw new Error('Неизвестная фаза');
    }
    broadcast('status', {
        phase: body.phase,
        message: String(body.message || '').slice(0, 300),
        jobId: currentJobId,
    });
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
}

function startJob(res) {
    if (!hostIsConnected()) {
        sendJson(res, 409, { error: 'Вкладка SillyTavern не подключена' });
        return;
    }
    currentJobId += 1;
    broadcast('status', { phase: 'start', message: 'Генерация…', jobId: currentJobId });
    broadcast('generate', { jobId: currentJobId, leaderId });
    sendJson(res, 202, { jobId: currentJobId });
}

function sendBytes(res, body, contentType) {
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function sendPage(res, pageToken) {
    // The script is a separate file so the page can run under a strict script policy.
    // The token stays on that file request; the HTML itself never embeds it.
    const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8')
        .replace('src="/viewer.js"', `src="/viewer.js?token=${encodeURIComponent(pageToken)}"`);
    sendBytes(res, html, 'text/html; charset=utf-8');
}

function sendImage(res) {
    if (!latestImage) {
        sendJson(res, 404, { error: 'Пока нет картинки' });
        return;
    }
    res.writeHead(200, {
        'Content-Type': latestImage.mime,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(latestImage.buffer);
}

async function handle(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/events') {
        openEvents(req, res, url);
        return;
    }
    if (!tokenOk(url.searchParams.get('token'))) {
        sendJson(res, 403, { error: 'Неверный token' });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
        sendPage(res, url.searchParams.get('token'));
        return;
    }
    if (req.method === 'GET' && url.pathname === '/viewer.js') {
        sendBytes(res, fs.readFileSync(path.join(__dirname, 'viewer.js')), 'text/javascript; charset=utf-8');
        return;
    }
    if (req.method === 'GET' && url.pathname === '/image') {
        sendImage(res);
        return;
    }
    if (req.method === 'POST' && url.pathname === '/generate') {
        startJob(res);
        return;
    }
    if (req.method === 'POST' && url.pathname === '/progress') {
        await acceptProgress(req, res);
        return;
    }
    if (req.method === 'POST' && url.pathname === '/result') {
        await acceptResult(req, res);
        return;
    }

    sendJson(res, 404, { error: 'Не найдено' });
}

function onRequest(req, res) {
    handle(req, res).catch(error => {
        if (res.headersSent) {
            return;
        }
        sendJson(res, 400, { error: String(error?.message || 'Ошибка').slice(0, 300) });
    });
}

function ensureServer() {
    if (origin && httpServer) {
        return Promise.resolve();
    }
    if (starting) {
        return starting;
    }
    starting = startServer().finally(() => {
        starting = null;
    });
    return starting;
}

function startServer() {
    httpServer = http.createServer(onRequest);
    // Node closes a quiet socket after a few minutes. The map tab holds one stream for the whole visit.
    httpServer.requestTimeout = 0;
    httpServer.headersTimeout = 0;
    httpServer.timeout = 0;

    pingTimer = setInterval(() => {
        for (const client of clients) {
            client.res.write(': ping\n\n');
        }
    }, PING_MS);

    return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
            try {
                const address = httpServer.address();
                if (!address || typeof address === 'string') {
                    throw new Error('Map server did not bind a TCP port');
                }
                origin = `http://127.0.0.1:${address.port}`;
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function sessionPayload() {
    return { origin, token };
}

async function init(router) {
    // The port stays closed until the user asks. SillyTavern only loads this plugin at startup.
    router.get('/session', (_req, res) => {
        if (!origin) {
            res.status(404).json({ error: 'Сервер не запущен' });
            return;
        }
        res.json(sessionPayload());
    });
    router.post('/start', async (_req, res) => {
        try {
            await ensureServer();
            res.json(sessionPayload());
        } catch (error) {
            res.status(500).json({ error: String(error?.message || 'Сервер не запустился').slice(0, 300) });
        }
    });
}

async function exit() {
    clearInterval(pingTimer);
    pingTimer = null;
    for (const client of clients) {
        client.res.end();
    }
    clients.clear();
    if (!httpServer) {
        return;
    }
    await new Promise(resolve => httpServer.close(resolve));
    httpServer = null;
    origin = '';
}

if (require.main === module) {
    ensureServer().then(() => {
        console.log(`${origin}/?token=${token}`);
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    init,
    exit,
    info: {
        id: 'location-map',
        name: 'Location Map',
        description: 'Separate local window for the location schematic extension',
    },
};
