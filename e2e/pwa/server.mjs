import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import process from 'node:process';

const port = 4174;
const projectRoot = process.cwd();
const distRoot = resolve(projectRoot, 'apps/web/dist');
const fixtureRoot = resolve(projectRoot, 'e2e/pwa');
/** @type {Set<import('node:http').ServerResponse>} */
const blockedWorkerResponses = new Set();
let blockWorker = false;

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
]);

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string} body
 * @param {string} [contentType]
 */
function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {string} filePath
 * @param {Record<string, string>} [extraHeaders]
 */
async function sendFile(response, filePath, extraHeaders = {}) {
  await access(filePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error('Not a file');
  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  createReadStream(filePath).pipe(response);
}

/** @param {import('node:http').ServerResponse} response */
async function serveWorker(response) {
  await sendFile(response, resolve(distRoot, 'sw.js'), {
    'Service-Worker-Allowed': '/feelmyrythm/',
  });
}

function releaseWorkers() {
  blockWorker = false;
  for (const response of blockedWorkerResponses) {
    blockedWorkerResponses.delete(response);
    void serveWorker(response).catch(() => sendText(response, 500, 'worker unavailable'));
  }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

  if (url.pathname === '/__pwa/health') {
    sendText(response, 200, 'ok');
    return;
  }
  if (url.pathname === '/__pwa/block-worker' && request.method === 'POST') {
    blockWorker = true;
    sendText(response, 200, 'blocked');
    return;
  }
  if (url.pathname === '/__pwa/release-worker' && request.method === 'POST') {
    releaseWorkers();
    sendText(response, 200, 'released');
    return;
  }
  if (url.pathname === '/feelmyrythm/api/pwa-probe') {
    sendText(response, 200, JSON.stringify({ source: 'network-user-b' }), 'application/json');
    return;
  }
  if (url.pathname === '/feelmyrythm/pwa/legacy-setup.html') {
    await sendFile(response, resolve(fixtureRoot, 'legacy-setup.html'));
    return;
  }
  if (url.pathname === '/feelmyrythm/pwa/legacy-sw.js') {
    await sendFile(response, resolve(fixtureRoot, 'legacy-sw.js'), {
      'Service-Worker-Allowed': '/feelmyrythm/',
    });
    return;
  }
  if (url.pathname === '/feelmyrythm/sw.js') {
    if (blockWorker) {
      blockedWorkerResponses.add(response);
      response.on('close', () => blockedWorkerResponses.delete(response));
      return;
    }
    await serveWorker(response);
    return;
  }

  if (url.pathname.startsWith('/feelmyrythm/')) {
    const relativePath = decodeURIComponent(url.pathname.slice('/feelmyrythm/'.length));
    const candidate = resolve(distRoot, relativePath);
    if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) {
      sendText(response, 403, 'forbidden');
      return;
    }
    try {
      await sendFile(response, candidate);
    } catch {
      await sendFile(response, resolve(distRoot, 'index.html'));
    }
    return;
  }

  sendText(response, 404, 'not found');
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (!response.headersSent) sendText(response, 500, 'fixture server error');
    else response.destroy(cause);
  });
});

server.listen(port, '127.0.0.1');

function shutdown() {
  releaseWorkers();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Force an early, explicit failure if the build output is missing.
await readFile(resolve(distRoot, 'index.html'));
