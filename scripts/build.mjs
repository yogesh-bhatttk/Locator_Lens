#!/usr/bin/env node
// Build reviewable, submittable extension packages.
//
// The shipping file set is an ALLOWLIST, not an ignore list. That distinction is
// the whole point of this script: the previous flow ("swap manifest.json, then zip
// the project root") had no file selection at all, so every new file in the repo
// silently became part of the submission — including a generated report page that
// pulled a library from unpkg.com, which is remote code and an automatic reject on
// both stores. Adding a file to the package must now be a deliberate edit here.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip } from './lib/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');

/** Everything that ships, relative to the repo root. Directories are copied recursively. */
const SHIP = [
  'src/background.js',
  'src/codegen.js',
  'src/content-locator-engine.js',
  'src/content.js',
  'src/popup.html',
  'src/popup.js',
  'src/sidepanel.html',
  'src/sidepanel.js',
  'icons',
];

const TARGETS = {
  chrome: { manifest: 'manifests/manifest.chrome.json' },
  firefox: { manifest: 'manifests/manifest.firefox.json' },
};

// ── file collection ─────────────────────────────────────────────────────────────

function walk(absPath, out = []) {
  if (statSync(absPath).isDirectory()) {
    for (const child of readdirSync(absPath).sort()) walk(join(absPath, child), out);
  } else {
    out.push(absPath);
  }
  return out;
}

function collect() {
  const files = [];
  for (const item of SHIP) {
    const abs = join(ROOT, item);
    if (!existsSync(abs)) throw new Error(`Declared in SHIP but missing on disk: ${item}`);
    for (const file of walk(abs)) {
      files.push({ name: relative(ROOT, file).split(/[\\/]/).join('/'), data: readFileSync(file) });
    }
  }
  return files;
}

// ── verification ────────────────────────────────────────────────────────────────

const TEXT_EXT = /\.(js|html|json|css)$/;

/**
 * Reject anything that would fail store review, before it can be uploaded.
 * These are the rules a human reviewer applies; running them here makes a policy
 * violation a build failure rather than a two-week round trip.
 */
function verify(entries, target) {
  const problems = [];

  for (const entry of entries) {
    if (!TEXT_EXT.test(entry.name)) continue;
    const text = entry.data.toString('utf8');

    // Remote code: any script/style pulled over the network at runtime.
    const remoteTag = text.match(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\/[^"']+/i);
    if (remoteTag) problems.push(`${entry.name}: loads a remote resource — ${remoteTag[0].slice(0, 100)}`);

    // Dynamic code execution: both stores treat these as remote/obfuscated code.
    if (/\beval\s*\(/.test(text)) problems.push(`${entry.name}: uses eval()`);
    if (/new\s+Function\s*\(/.test(text)) problems.push(`${entry.name}: uses new Function()`);
    if (/\bimportScripts\s*\(/.test(text)) problems.push(`${entry.name}: uses importScripts()`);

    // A network call from an extension that advertises "runs entirely locally".
    const fetchCall = text.match(/\b(?:fetch|XMLHttpRequest)\b/);
    if (fetchCall) problems.push(`${entry.name}: contains a network API (${fetchCall[0]}) — the listing claims no network access`);
  }

  const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));

  // Every path the manifest references must actually be in the archive. A manifest
  // pointing at a file the package omits is a load error on the reviewer's machine.
  const referenced = new Set();
  const addRef = (p) => typeof p === 'string' && referenced.add(p.replace(/^\//, ''));
  addRef(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(addRef);
  addRef(manifest.action?.default_popup);
  addRef(manifest.side_panel?.default_path);
  addRef(manifest.sidebar_action?.default_panel);
  addRef(manifest.sidebar_action?.default_icon);
  Object.values(manifest.icons ?? {}).forEach(addRef);
  Object.values(manifest.action?.default_icon ?? {}).forEach(addRef);
  (manifest.content_scripts ?? []).forEach((cs) => (cs.js ?? []).forEach(addRef));

  const present = new Set(entries.map((e) => e.name));
  for (const ref of referenced) {
    if (!present.has(ref)) problems.push(`manifest.json references "${ref}", which is not in the ${target} package`);
  }

  if (problems.length) {
    throw new Error(`${target}: package failed review checks\n  - ${problems.join('\n  - ')}`);
  }
}

// ── build ───────────────────────────────────────────────────────────────────────

function build(target) {
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target "${target}". Expected one of: ${Object.keys(TARGETS).join(', ')}`);

  const manifest = readFileSync(join(ROOT, config.manifest));
  const version = JSON.parse(manifest.toString('utf8')).version;

  const entries = [...collect(), { name: 'manifest.json', data: manifest }];
  verify(entries, target);

  // Unpacked tree, for `Load unpacked` / `about:debugging` and for reviewers who
  // want to read the exact bytes that were uploaded.
  const unpacked = join(OUT, target);
  rmSync(unpacked, { recursive: true, force: true });
  for (const entry of entries) {
    const dest = join(unpacked, entry.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data);
  }

  const zip = createZip(entries);
  const zipPath = join(OUT, `locatorlens-${target}-${version}.zip`);
  writeFileSync(zipPath, zip);

  const sha = createHash('sha256').update(zip).digest('hex');
  const bytes = zip.length;

  console.log(`✓ ${target} v${version}`);
  console.log(`  ${entries.length} files · ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`  ${relative(ROOT, unpacked)}/`);
  console.log(`  ${relative(ROOT, zipPath)}`);
  console.log(`  sha256 ${sha}`);
  return { target, version, files: entries.length, bytes, sha };
}

const requested = process.argv[2] ?? 'all';
const targets = requested === 'all' ? Object.keys(TARGETS) : [requested];

mkdirSync(OUT, { recursive: true });
try {
  targets.forEach(build);
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
}
