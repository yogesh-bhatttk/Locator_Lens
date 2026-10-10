// The demo checkout (scripts/screenshots/demo-page.html + payment-frame.html) served
// over HTTP for the export tests, with one addition: the page beacons each placed
// order to POST /__orders, and the server keeps them so a test run can be checked
// end to end — "the exported script submitted Ada Lovelace / Ireland / gift wrap /
// card 4242 / the password from LOCATRA_PASSWORD", not merely "it exited 0".
//
// With `exportExtras` (the export run only) the page also carries a few things the
// store screenshots and the other smokes must not see, so they are injected rather
// than written into demo-page.html:
//   - a multi-select (Interests) whose option text has stray whitespace, so labels
//     must be normalised and every chosen option sent;
//   - a Promo code field inside an open shadow root (<promo-code>);
//   - an invisible <object> before the payment <iframe>: a browsing context that is
//     not an <iframe>, which positional frame addressing must not count.
// The page reports the extra fields through its window.demoExtraOrder hook.
//
//   const server = await startDemoServer({ port: 4175 });                     // plain page
//   const server = await startDemoServer({ port: 4175, exportExtras: true }); // export run
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

const OBJECT_BEFORE_PAYMENT =
  '<object data="/embedded-note" type="text/html" width="1" height="1" aria-hidden="true" tabindex="-1"' +
  ' style="position:absolute;opacity:0;pointer-events:none"></object>\n';

const PREFERENCES_CARD = `
        <div class="card" id="preferences">
          <h2>Preferences</h2>
          <div class="field">
            <label for="interests">Interests</label>
            <select id="interests" name="interests" multiple size="4">
              <option value="books">Books</option>
              <option value="music">
                Music
              </option>
              <option value="film">Film</option>
              <option value="games">Games</option>
            </select>
          </div>
          <promo-code></promo-code>
        </div>
`;

const EXTRA_SCRIPT = `
    <script>
      customElements.define('promo-code', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<div class="field"><label for="promo">Promo code</label><input id="promo" name="promo" /></div>';
        }
      });
      window.demoExtraOrder = function (form) {
        var host = document.querySelector('promo-code');
        return {
          interests: Array.prototype.map.call(form.elements.interests.selectedOptions, function (o) { return o.value; }),
          promo: host && host.shadowRoot ? host.shadowRoot.getElementById('promo').value : ''
        };
      };
    </script>
`;

/** The checkout page with the export-only additions above. */
export function exportPage(html) {
  const out = String(html)
    .replace(
      '<iframe\n            id="payment-frame"',
      OBJECT_BEFORE_PAYMENT + '          <iframe\n            id="payment-frame"'
    )
    .replace('        </form>', PREFERENCES_CARD + '        </form>')
    .replace('  </body>', EXTRA_SCRIPT + '  </body>');
  if (!out.includes('id="interests"') || !out.includes('<object') || !out.includes('demoExtraOrder = '))
    throw new Error('demo-page.html changed shape: the export-only additions no longer apply');
  return out;
}

export async function startDemoServer({ port = 4175, host = '127.0.0.1', exportExtras = false } = {}) {
  // The extras are for the export run only: the smokes that share this server scan
  // or count what is on the page, and must see the plain checkout.
  const shape = (html) => (exportExtras ? exportPage(html) : html);
  shape(readFileSync(DEMO_HTML, 'utf8')); // a page that no longer takes the extras fails here, not mid-run
  // Read per request: the page can be edited while a long run is in progress.
  const page = () => shape(readFileSync(DEMO_HTML, 'utf8'));
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
    if (path === '/embedded-note') {
      // What the export-only <object> shows.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>note</title><p>embedded</p>');
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
