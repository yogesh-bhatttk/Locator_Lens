// The demo checkout (scripts/screenshots/demo-page.html + payment-frame.html) served
// over HTTP for the export tests, with one addition: the page beacons each placed
// order to POST /__orders, and the server keeps them so a test run can be checked
// end to end — "the exported script submitted Ada Lovelace / Ireland / gift wrap /
// card 4242 / the password from LOCATRA_PASSWORD", not merely "it exited 0".
//
//   const server = await startDemoServer({ port: 4175 });
//   server.base            // http://127.0.0.1:4175
//   server.orders()        // every order placed so far, oldest first
//   await server.close();

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEMO_HTML = join(ROOT, 'scripts/screenshots/demo-page.html');
const FRAME_HTML = join(ROOT, 'scripts/screenshots/payment-frame.html');

export async function startDemoServer({ port = 4175, host = '127.0.0.1' } = {}) {
  // Read per request: the page can be edited while a long run is in progress.
  const page = () => readFileSync(DEMO_HTML);
  const frame = () => readFileSync(FRAME_HTML);
  const orders = [];

  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/__orders' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          orders.push({ ...JSON.parse(body), receivedAt: Date.now() });
        } catch {
          orders.push({ invalid: body });
        }
        res.writeHead(204).end();
      });
      return;
    }
    if (path === '/__orders') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(orders));
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    // Every other path is the checkout page (as the smoke and screenshot servers
    // do), so /checkout/confirmed — the URL the page pushes after an order —
    // survives a reload.
    const body = path.startsWith('/payment-frame') ? frame() : page();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, ok);
  });

  return {
    base: `http://${host}:${port}`,
    orders: () => orders.slice(),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
