// Store-policy checks for a built package.
//
// One implementation, used by scripts/build.mjs (which refuses to write a package
// that fails) and unit-tested directly by tests/package.test.mjs against fixtures
// that must fail. Before this module existed the build and the test suite each
// carried their own copy of these regexes, and the copies had already drifted.
//
// Everything here is pure: it takes file contents and a parsed manifest and returns
// a list of human-readable problems. An empty list means the package passes.

import { posix } from 'node:path';

// ── comment stripping ───────────────────────────────────────────────────────────
//
// The scans below look for API names. Scanning raw source would let a comment that
// says "there is no fetch here" fail the build, and — worse — let a comment that
// merely mentions `chrome.storage.` count as evidence that a permission is used.
// So comments are removed first. This is a small lexer, not a parser: it knows
// enough about strings, template literals and regex literals not to mistake their
// contents for comments, and it never throws.

const REGEX_PRECEDING_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const isIdent = (ch) => /[\w$]/.test(ch);

/** Is a `/` at this point the start of a regex literal (rather than division)? */
function regexAllowed(out) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  if (j < 0) return true;
  const prev = out[j];
  if (prev === ')' || prev === ']' || prev === '}') return false;
  if (isIdent(prev)) {
    let k = j;
    while (k >= 0 && isIdent(out[k])) k--;
    return REGEX_PRECEDING_WORDS.has(out.slice(k + 1, j + 1));
  }
  return true;
}

/**
 * Remove // and /* *\/ comments from JavaScript, leaving strings, template
 * literals and regex literals intact. Newlines inside block comments are kept so
 * line numbers in the output still line up with the input.
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // One entry per open `${`: the count of `{` opened inside it and not yet closed.
  const templateDepth = [];

  const readTemplateBody = () => {
    // Positioned just after a backtick or after the `}` closing a substitution.
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (ch === '`') {
        out += ch;
        i++;
        return;
      } else if (ch === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        templateDepth.push(0);
        return;
      } else {
        out += ch;
        i++;
      }
    }
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, '') || ' ';
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      out += c;
      i++;
      readTemplateBody();
      continue;
    }
    if (templateDepth.length) {
      if (c === '{') templateDepth[templateDepth.length - 1]++;
      if (c === '}') {
        if (templateDepth[templateDepth.length - 1] === 0) {
          templateDepth.pop();
          out += c;
          i++;
          readTemplateBody();
          continue;
        }
        templateDepth[templateDepth.length - 1]--;
      }
    }
    if (c === '/' && regexAllowed(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      if (src[j] === '/') {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out += src.slice(i, j);
        i = j;
        continue;
      }
      // Not a terminated regex after all: treat the slash as an operator.
    }
    out += c;
    i++;
  }
  return out;
}

/** Remove CSS comments. CSS strings never contain `/*` in practice; keep it simple. */
export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, ''));
}

/**
 * Remove comments from an HTML document: `<!-- -->` everywhere, plus JS comments
 * inside inline <script> blocks and CSS comments inside <style> blocks. Text
 * content is left alone — an apostrophe in prose is not a string delimiter.
 */
export function stripHtmlComments(src) {
  return src
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ''))
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
      (_, open, body, close) => open + stripJsComments(body) + close
    )
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_, open, body, close) => open + stripCssComments(body) + close
    );
}

/** Strip comments according to the file's type. Unknown types are returned as-is. */
export function stripComments(name, text) {
  if (/\.(?:js|mjs|cjs)$/i.test(name)) return stripJsComments(text);
  if (/\.html?$/i.test(name)) return stripHtmlComments(text);
  if (/\.css$/i.test(name)) return stripCssComments(text);
  return text;
}

// ── source rules ────────────────────────────────────────────────────────────────

/** A URL that leaves the package: http(s) or protocol-relative. */
const REMOTE = String.raw`(?:https?:)?\/\/`;

/** One local script path literal: no scheme, not protocol-relative, no expression. */
const LOCAL_SCRIPT_LITERAL = String.raw`\s*(?:'(?!\/\/)[\w./-]+'|"(?!\/\/)[\w./-]+")\s*`;
/** The argument list of an importScripts() call that loads only local files. */
const LOCAL_SCRIPT_LIST = String.raw`${LOCAL_SCRIPT_LITERAL}(?:,${LOCAL_SCRIPT_LITERAL})*`;
const IMPORT_SCRIPTS_LOCAL_ARGS = String.raw`${LOCAL_SCRIPT_LIST}\)`;

/**
 * Each rule is a pattern that must not appear in shipped code (after comments are
 * stripped). `label` is what the build prints. These are the rules a store
 * reviewer applies; running them here makes a violation a build failure rather
 * than a two-week round trip.
 */
export const SOURCE_RULES = [
  // Remote code / remote resources.
  {
    id: 'remote-tag',
    label: 'loads a remote resource from markup',
    pattern: new RegExp(
      String.raw`<(?:script|link|iframe|frame|embed|object|img|source|audio|video)\b[^>]*\b(?:src|href|data|srcset)\s*=\s*["']?\s*${REMOTE}`,
      'i'
    ),
  },
  {
    id: 'remote-import',
    label: 'imports a module from a remote URL',
    pattern: new RegExp(String.raw`\bimport\s*(?:\(\s*|[\w$\s{},*]*\bfrom\s*)["'\`]${REMOTE}`),
  },
  {
    id: 'remote-src-assignment',
    label: 'points an element at a remote URL',
    pattern: new RegExp(
      String.raw`(?:\.(?:src|href|data)\s*=|\bsetAttribute\s*\(\s*["'](?:src|href|data)["']\s*,)\s*["'\`]${REMOTE}`
    ),
  },
  {
    id: 'remote-css',
    label: 'pulls a remote stylesheet, font or image from CSS',
    pattern: new RegExp(
      String.raw`(?:@import\s+(?:url\(\s*)?["']?\s*${REMOTE}|\burl\(\s*["']?\s*${REMOTE})`,
      'i'
    ),
  },

  // Dynamic code execution: both stores treat these as remote/obfuscated code.
  { id: 'eval', label: 'uses eval()', pattern: /\beval\s*\(/ },
  { id: 'new-function', label: 'uses new Function()', pattern: /\bnew\s+Function\s*\(/ },
  // importScripts() of a file shipped in the package is how a classic MV3 service
  // worker splits its code (background.js loads thumbs-store.js) — that is not remote
  // code. Anything else is: a URL, a computed argument, a variable. So only a call
  // whose every argument is a plain relative-path string literal passes, and
  // importedScripts() below makes the build prove each of those files ships.
  {
    id: 'import-scripts',
    label: 'uses importScripts() with something other than a packaged file',
    pattern: new RegExp(String.raw`\bimportScripts\s*\((?!${IMPORT_SCRIPTS_LOCAL_ARGS})`),
  },
  {
    id: 'string-timer',
    label: 'passes a string to setTimeout/setInterval (implicit eval)',
    pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
  },

  // Network APIs. The listing and privacy policy say nothing leaves the browser.
  { id: 'fetch', label: 'calls fetch()', pattern: /\bfetch\s*\(/ },
  { id: 'xhr', label: 'uses XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { id: 'beacon', label: 'calls navigator.sendBeacon()', pattern: /\bsendBeacon\s*\(/ },
  { id: 'websocket', label: 'opens a WebSocket', pattern: /\bnew\s+WebSocket\b/ },
  { id: 'event-source', label: 'opens an EventSource', pattern: /\bnew\s+EventSource\b/ },
];

/** File types the source rules are applied to. */
export const SCANNED_EXT = /\.(?:js|mjs|cjs|html?|css)$/i;

/**
 * Scan one file. Returns problems as strings, empty when clean.
 * @param {string} name package-relative path
 * @param {string} text file contents
 */
export function scanSource(name, text) {
  if (!SCANNED_EXT.test(name)) return [];
  const code = stripComments(name, text);
  const problems = [];
  for (const rule of SOURCE_RULES) {
    const m = code.match(rule.pattern);
    if (m) problems.push(`${name}: ${rule.label} — ${m[0].trim().slice(0, 100)}`);
  }
  return problems;
}

// ── permission policy ───────────────────────────────────────────────────────────
//
// Chrome Web Store rejection "Purple Potassium" (2026): the submitted package
// requested `tabs`, which nothing in the code needed. Every declared permission
// must be justified by an API the shipped code actually calls (comments do not
// count), and the check fails closed: an unrecognised permission is an error.

const api = (name) => new RegExp(String.raw`\b(?:chrome|browser)\.${name}\.`);

/** permission -> evidence that the packaged code genuinely uses it. */
export const PERMISSION_EVIDENCE = {
  scripting: api('scripting'),
  storage: api('storage'),
  contextMenus: /\b(?:chrome|browser)\.(?:contextMenus|menus)\./,
  sidePanel: /\bchrome(?:\.sidePanel\b|\[["']sidePanel["']\])/,
  alarms: api('alarms'),
  debugger: api('debugger'),
  downloads: api('downloads'),
  cookies: api('cookies'),
  notifications: api('notifications'),
  webNavigation: api('webNavigation'),
  webRequest: api('webRequest'),
  clipboardWrite: /navigator\.clipboard|execCommand\(\s*['"]copy/,
};

/**
 * Permissions that grant host access rather than an API surface, so there is no
 * call signature to look for. activeTab is what keeps Inspect/Record working for
 * users who set Chrome site access to "on click" or revoke Firefox host
 * permissions. Listed here so that declaring one is a recognised
 * choice rather than an unknown permission; the reviewed set is pinned separately
 * in tests/package.test.mjs.
 */
export const HOST_ACCESS_PERMISSIONS = new Set(['activeTab']);

/** Never request these. */
export const BANNED_PERMISSIONS = new Map([
  [
    'tabs',
    'tabs.query/sendMessage/onUpdated/onRemoved all work without it; only url/title/favIconUrl need it, and nothing reads those. Rejected by CWS as "Purple Potassium".',
  ],
]);

/**
 * The only host patterns any manifest key may name. `<all_urls>` and `*://` wildcards also
 * cover file://, ftp:// and more, which the extension has no use for; widening this
 * list is a deliberate, reviewable edit.
 */
export const ALLOWED_HOST_PATTERNS = new Set(['http://*/*', 'https://*/*']);

/**
 * `<all_urls>` is accepted in exactly one place: optional_host_permissions, for step
 * screenshots. chrome.tabs.captureVisibleTab needs `<all_urls>` or an activeTab grant
 * (http/https host permissions are not enough), so the panel asks for it at run time
 * — chrome.permissions.request({ origins: ['<all_urls>'] }) — when the user turns
 * step screenshots on, never at install. It stays forbidden in host_permissions,
 * content_scripts.matches and web_accessible_resources.
 */
export const OPTIONAL_ONLY_HOST_PATTERNS = new Set(['<all_urls>']);

/**
 * The code uses permissions.request — called directly, or through an alias after a
 * feature test (`const api = chrome.permissions; … api.request(…)`).
 */
export const PERMISSIONS_REQUEST = /\b(?:chrome|browser)\.permissions\.request\b/;

/**
 * Evidence that the code asks for the `<all_urls>` grant at run time: it uses
 * permissions.request and builds an origins list holding exactly `<all_urls>`
 * (inline, `{ origins: ['<all_urls>'] }`, or as a named constant).
 */
export function requestsAllUrls(code) {
  return PERMISSIONS_REQUEST.test(code) && /\[\s*["'`]<all_urls>["'`]\s*\]/.test(code);
}

/** Lowest Chrome that has chrome.sidePanel. */
const SIDE_PANEL_MIN_CHROME = 114;

function checkPermissionList(list, kind, code, problems) {
  for (const permission of list ?? []) {
    if (BANNED_PERMISSIONS.has(permission)) {
      problems.push(
        `manifest ${kind} includes banned permission "${permission}" — ${BANNED_PERMISSIONS.get(permission)}`
      );
      continue;
    }
    if (HOST_ACCESS_PERMISSIONS.has(permission)) continue;

    const evidence = PERMISSION_EVIDENCE[permission];
    if (!evidence) {
      problems.push(
        `manifest ${kind} includes "${permission}", which has no entry in PERMISSION_EVIDENCE. ` +
          `Add one proving the code uses it, or remove the permission.`
      );
      continue;
    }
    if (!evidence.test(code)) {
      problems.push(
        `manifest ${kind} includes "${permission}" but no packaged file calls the matching API — remove it`
      );
    }
  }
}

function checkHostPatterns(list, kind, problems, extra = new Set()) {
  for (const pattern of list ?? []) {
    if (!ALLOWED_HOST_PATTERNS.has(pattern) && !extra.has(pattern)) {
      problems.push(
        `manifest ${kind} names "${pattern}", outside the reviewed host set (${[...ALLOWED_HOST_PATTERNS].join(', ')})`
      );
    }
  }
}

// Script sources an extension page may keep. Anything else — 'unsafe-eval',
// 'unsafe-inline', a host, a scheme, a hash allowance for inline code — loosens the
// browser's default policy, which is exactly what the store reviews reject.
const CSP_SCRIPT_DIRECTIVES = new Set([
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'object-src',
  'worker-src',
]);
// 'report-sample' only adds a code sample to violation reports; it allows nothing.
const CSP_SAFE_SOURCES = new Set(["'self'", "'none'", "'wasm-unsafe-eval'", "'report-sample'"]);

/**
 * The extension pages' CSP may only tighten the default. The sandbox policy is
 * left alone: sandboxed pages have no extension API access by design.
 * @param {string|object|undefined} csp manifest.content_security_policy
 * @returns {string[]} problems
 */
export function verifyCsp(csp) {
  if (csp === undefined) return [];
  const policy = typeof csp === 'string' ? csp : csp && csp.extension_pages;
  if (policy === undefined) return [];
  if (typeof policy !== 'string') return ['content_security_policy.extension_pages is not a string'];
  const problems = [];
  for (const directive of policy.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (!name || !CSP_SCRIPT_DIRECTIVES.has(name.toLowerCase())) continue;
    for (const src of sources) {
      if (!CSP_SAFE_SOURCES.has(src.toLowerCase())) {
        problems.push(`content_security_policy ${name} allows ${src}; extension pages may only use 'self'`);
      }
    }
  }
  return problems;
}

/**
 * Check a manifest's permission-like keys against the (comment-stripped) code.
 * @param {object} manifest parsed manifest.json
 * @param {string} code all packaged JS/HTML, comments already stripped
 * @returns {string[]} problems
 */
export function verifyPermissions(manifest, code) {
  const problems = [];
  checkPermissionList(manifest.permissions, 'permissions', code, problems);
  checkPermissionList(manifest.optional_permissions, 'optional_permissions', code, problems);

  checkHostPatterns(manifest.host_permissions, 'host_permissions', problems);
  checkHostPatterns(
    manifest.optional_host_permissions,
    'optional_host_permissions',
    problems,
    OPTIONAL_ONLY_HOST_PATTERNS
  );
  if ((manifest.optional_host_permissions ?? []).includes('<all_urls>') && !requestsAllUrls(code)) {
    problems.push(
      'manifest optional_host_permissions includes "<all_urls>" but no packaged file calls ' +
        "permissions.request({ origins: ['<all_urls>'] })"
    );
  }
  for (const cs of manifest.content_scripts ?? [])
    checkHostPatterns(cs.matches, 'content_scripts.matches', problems);
  for (const war of manifest.web_accessible_resources ?? []) {
    if (typeof war === 'object' && war)
      checkHostPatterns(war.matches, 'web_accessible_resources.matches', problems);
  }

  // An optional grant that is never requested is dead weight in the install prompt.
  const hasOptional =
    (manifest.optional_permissions ?? []).length || (manifest.optional_host_permissions ?? []).length;
  if (hasOptional && !PERMISSIONS_REQUEST.test(code)) {
    problems.push('manifest declares optional permissions but no packaged file calls permissions.request()');
  }

  // Nothing outside the extension may message it: no web page and no other
  // extension has a reason to, and every handler assumes its sender is our own code.
  if (manifest.externally_connectable !== undefined) {
    problems.push('manifest declares externally_connectable; the extension must not accept outside messages');
  }
  problems.push(...verifyCsp(manifest.content_security_policy));

  if (manifest.minimum_chrome_version !== undefined) {
    const v = String(manifest.minimum_chrome_version);
    if (!/^\d+(?:\.\d+){0,3}$/.test(v)) {
      problems.push(`minimum_chrome_version "${v}" is not a dotted version number`);
    } else if (
      (manifest.permissions ?? []).includes('sidePanel') &&
      Number(v.split('.')[0]) < SIDE_PANEL_MIN_CHROME
    ) {
      problems.push(
        `minimum_chrome_version ${v} predates chrome.sidePanel (Chrome ${SIDE_PANEL_MIN_CHROME})`
      );
    }
  }
  return problems;
}

// ── references ──────────────────────────────────────────────────────────────────

const strip = (p) => p.replace(/^\.?\//, '');

/** Every package path the manifest names. Glob patterns are returned as-is. */
export function manifestReferences(manifest) {
  const refs = [];
  const add = (p) => typeof p === 'string' && p && refs.push(strip(p));
  const addIcons = (v) => (typeof v === 'string' ? add(v) : Object.values(v ?? {}).forEach(add));

  add(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(add);
  add(manifest.background?.page);
  add(manifest.action?.default_popup);
  addIcons(manifest.action?.default_icon);
  add(manifest.side_panel?.default_path);
  add(manifest.sidebar_action?.default_panel);
  addIcons(manifest.sidebar_action?.default_icon);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.devtools_page);
  addIcons(manifest.icons);
  for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach(add);
    (cs.css ?? []).forEach(add);
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    // MV3 objects ({resources, matches}); MV2-style bare strings tolerated.
    if (typeof war === 'string') add(war);
    else (war?.resources ?? []).forEach(add);
  }
  return refs;
}

/**
 * Local files an HTML page loads with <script src> or <link href>, resolved to
 * package paths. Remote URLs are the remote-tag rule's business, not this one's.
 */
export function htmlReferences(name, html) {
  const refs = [];
  const text = stripHtmlComments(html);
  const tag = /<(script|link)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const m of text.matchAll(tag)) {
    if ((m[1].toLowerCase() === 'script') !== (m[2].toLowerCase() === 'src')) continue;
    const url = m[3].split(/[?#]/)[0];
    if (!url || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(url)) continue;
    refs.push(url.startsWith('/') ? strip(url) : posix.normalize(posix.join(posix.dirname(name), url)));
  }
  return refs;
}

/**
 * Files passed to scripting.executeScript({ files }) — either inline array literals
 * or a `const NAME = [...]` the call refers to by name. Missing any of them is a
 * runtime injection failure that no manifest check would notice.
 */
export function injectedFiles(js) {
  const code = stripJsComments(js);
  const strings = (body) => [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => strip(m[1]));
  const out = [];
  for (const m of code.matchAll(/\bfiles\s*:\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g)) {
    if (m[1].startsWith('[')) {
      out.push(...strings(m[1]));
    } else {
      const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${m[1]}\s*=\s*(\[[^\]]*\])`).exec(code);
      if (decl) out.push(...strings(decl[1]));
    }
  }
  return [...new Set(out)];
}

/**
 * Package paths a worker script loads with importScripts('a.js', ...), resolved the
 * way the browser does: relative to the importing script's own location, or to the
 * package root for a leading "/". Only string-literal arguments are collected —
 * anything else already fails the import-scripts source rule.
 * @param {string} name package-relative path of the importing script
 * @param {string} js its source
 */
export function importedScripts(name, js) {
  const code = stripJsComments(js);
  const out = [];
  for (const m of code.matchAll(new RegExp(String.raw`\bimportScripts\s*\((${LOCAL_SCRIPT_LIST})\)`, 'g'))) {
    for (const lit of m[1].matchAll(/["']([^"']+)["']/g)) {
      const url = lit[1];
      out.push(url.startsWith('/') ? strip(url) : posix.normalize(posix.join(posix.dirname(name), url)));
    }
  }
  return [...new Set(out)];
}

const globToRegExp = (glob) =>
  new RegExp(
    '^' +
      glob
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^]*') +
      '$'
  );

/** Is the reference satisfied by a file in the package? Globs need one match. */
function present(ref, names) {
  return ref.includes('*') ? [...names].some((n) => globToRegExp(ref).test(n)) : names.has(ref);
}

// ── whole package ───────────────────────────────────────────────────────────────

/**
 * Run every check over a package's entries.
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {string[]} problems; empty means the package passes
 */
export function verifyPackage(entries) {
  const problems = [];
  const text = (e) => (typeof e.data === 'string' ? e.data : e.data.toString('utf8'));
  const names = new Set(entries.map((e) => e.name));

  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) return ['package has no manifest.json at its root'];
  const manifest = JSON.parse(text(manifestEntry));

  const codeParts = [];
  for (const entry of entries) {
    if (!SCANNED_EXT.test(entry.name)) continue;
    const src = text(entry);
    problems.push(...scanSource(entry.name, src));
    if (/\.(?:m?js|html?)$/i.test(entry.name)) codeParts.push(stripComments(entry.name, src));

    if (/\.html?$/i.test(entry.name)) {
      for (const ref of htmlReferences(entry.name, src)) {
        if (!names.has(ref)) problems.push(`${entry.name} loads "${ref}", which is not in the package`);
      }
    }
    if (/\.m?js$/i.test(entry.name)) {
      for (const ref of injectedFiles(src)) {
        if (!names.has(ref)) problems.push(`${entry.name} injects "${ref}", which is not in the package`);
      }
      for (const ref of importedScripts(entry.name, src)) {
        if (!names.has(ref)) {
          problems.push(`${entry.name} loads "${ref}" with importScripts(), which is not in the package`);
        }
      }
    }
  }

  problems.push(...verifyPermissions(manifest, codeParts.join('\n')));

  for (const ref of manifestReferences(manifest)) {
    if (!present(ref, names)) problems.push(`manifest.json references "${ref}", which is not in the package`);
  }
  return problems;
}
