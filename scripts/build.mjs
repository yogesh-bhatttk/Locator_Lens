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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versions } from 'node:process';

import { verifyPackage } from './lib/policy.mjs';
import { createZip } from './lib/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Output directory. Defaults to dist/; `--out-dir <dir>` or LOCATRA_OUT_DIR
 * redirects it, which is how the test suite builds without touching (or deleting
 * stale archives from) the developer's real dist/.
 */
const DEFAULT_OUT = join(ROOT, 'dist');

/** Everything that ships, relative to the repo root. Directories are copied recursively. */
export const SHIP = [
  'src/background.js',
  'src/codegen.js',
  // Code-generator targets that plug into LLCodegen.registerTarget(): content
  // scripts (manifest + background's CONTENT_SCRIPT_FILES), and <script>s of the
  // side panel and the settings page.
  'src/codegen-java.js',
  'src/codegen-csharp.js',
  'src/codegen-wdio.js',
  'src/content-locator-engine.js',
  'src/content.js',
  // The settings page (manifest options_ui).
  'src/options.html',
  'src/options.js',
  'src/popup.html',
  'src/popup.js',
  'src/sidepanel.html',
  'src/sidepanel.js',
  // IndexedDB store for step screenshots: loaded by the service worker with
  // importScripts() (Chrome) / background.scripts (Firefox), and by sidepanel.html.
  'src/thumbs-store.js',
  'icons',
];

const TARGETS = {
  chrome: { manifest: 'manifests/manifest.chrome.json' },
  firefox: { manifest: 'manifests/manifest.firefox.json' },
  // Microsoft Edge Add-ons takes the Chrome MV3 package as is (Edge is Chromium,
  // with chrome.sidePanel and the same commands/options_ui). Its own target, with
  // its own archive name, so the file uploaded to Partner Center is unambiguous
  // and is checked by the same policy rules on its own.
  edge: { manifest: 'manifests/manifest.chrome.json' },
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
    if (!existsSync(abs)) {
      throw new Error(
        `Declared in SHIP but missing on disk: ${item} — create it, or remove it from SHIP in scripts/build.mjs`
      );
    }
    for (const file of walk(abs)) {
      files.push({ name: relative(ROOT, file).split(/[\\/]/).join('/'), data: readFileSync(file) });
    }
  }
  return files;
}

// ── verification ────────────────────────────────────────────────────────────────
//
// The rules themselves (remote code, dynamic code, network APIs, permission
// evidence, manifest/HTML/executeScript references) live in scripts/lib/policy.mjs
// so tests/package.test.mjs can exercise them directly against fixtures that must
// fail, instead of re-implementing them.

/** Reject anything that would fail store review, before it can be uploaded. */
function verify(entries, target) {
  const problems = verifyPackage(entries);
  if (problems.length) {
    throw new Error(`${target}: package failed review checks\n  - ${problems.join('\n  - ')}`);
  }
}

// ── build ───────────────────────────────────────────────────────────────────────

export function build(target, out = DEFAULT_OUT) {
  const config = TARGETS[target];
  if (!config)
    throw new Error(`Unknown target "${target}". Expected one of: ${Object.keys(TARGETS).join(', ')}`);

  const manifest = readFileSync(join(ROOT, config.manifest));
  const version = JSON.parse(manifest.toString('utf8')).version;

  const entries = [...collect(), { name: 'manifest.json', data: manifest }];
  verify(entries, target);

  // Unpacked tree, for `Load unpacked` / `about:debugging` and for reviewers who
  // want to read the exact bytes that were uploaded.
  const unpacked = join(out, target);
  rmSync(unpacked, { recursive: true, force: true });
  for (const entry of entries) {
    const dest = join(unpacked, entry.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data);
  }

  // Drop this target's earlier packages. Leaving 1.1.6, 1.2.0 and 1.2.1 side by side
  // in dist/ is how the wrong archive gets picked at upload time — which is the exact
  // failure this script exists to prevent, and the one that caused the rejection.
  const stale = new RegExp(`^locatra-${target}-.*\\.zip$`);
  for (const name of readdirSync(out)) {
    if (stale.test(name)) rmSync(join(out, name), { force: true });
  }

  const zip = createZip(entries);
  const zipPath = join(out, `locatra-${target}-${version}.zip`);
  writeFileSync(zipPath, zip);

  const sha = createHash('sha256').update(zip).digest('hex');
  const bytes = zip.length;

  console.log(`✓ ${target} v${version}`);
  console.log(`  ${entries.length} files · ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`  ${relative(ROOT, unpacked) || unpacked}/`);
  console.log(`  ${relative(ROOT, zipPath) || zipPath}`);
  console.log(`  sha256 ${sha}`);
  return { target, version, files: entries.length, bytes, sha, zipPath, unpacked };
}

export const TARGET_NAMES = Object.keys(TARGETS);

function main(argv) {
  const args = [...argv];
  let out = process.env.LOCATRA_OUT_DIR ? resolve(process.env.LOCATRA_OUT_DIR) : DEFAULT_OUT;
  const outFlag = args.indexOf('--out-dir');
  if (outFlag !== -1) {
    if (!args[outFlag + 1]) throw new Error('--out-dir needs a directory');
    out = resolve(args[outFlag + 1]);
    args.splice(outFlag, 2);
  }
  const requested = args[0] ?? 'all';
  const targets = requested === 'all' ? TARGET_NAMES : [requested];

  // The archive bytes depend on zlib's deflate output, which is stable for a given
  // zlib but not across zlib releases. Print what produced them so a hash can be
  // reproduced (same commit + same Node major / zlib → same bytes).
  console.log(`node ${versions.node} · zlib ${versions.zlib}`);
  mkdirSync(out, { recursive: true });
  targets.forEach((t) => build(t, out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  }
}
