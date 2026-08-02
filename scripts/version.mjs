#!/usr/bin/env node
// Keep the version identical across package.json and every manifest.
//
// The repo carries three manifests (root, chrome, firefox). Bumping them by hand
// is how a Firefox build ends up submitted under a version Chrome already has —
// or worse, how an "update" gets rejected for reusing a published version number.
//
//   node scripts/version.mjs            # report, non-zero exit if they disagree
//   node scripts/version.mjs 1.2.0      # set everywhere
//   node scripts/version.mjs patch      # or minor / major

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'package.json',
  'manifest.json',
  'manifests/manifest.chrome.json',
  'manifests/manifest.firefox.json',
  'package-lock.json',
];

// The lockfile is the odd one out: it states the version twice — the root field and
// the packages[""] entry npm keeps in step with it — and hundreds of unrelated
// dependency versions surround them, so the textual replace below would rewrite the
// wrong line. It gets a JSON rewrite instead. npm writes the lockfile as
// JSON.stringify(data, null, 2) + newline, so that round-trips byte for byte.
const LOCKFILE = 'package-lock.json';

const SEMVER = /^\d+\.\d+\.\d+$/;

function read(file) {
  const path = join(ROOT, file);
  const text = readFileSync(path, 'utf8');
  return { path, text, json: JSON.parse(text), version: JSON.parse(text).version };
}

/** Every place a file states its own version, so a bump can't leave one behind. */
function versionsIn(file) {
  const { json } = read(file);
  if (file !== LOCKFILE) return [{ label: file, version: json.version }];
  return [
    { label: file, version: json.version },
    { label: `${file} packages[""]`, version: json.packages?.['']?.version },
  ];
}

function write(file, version) {
  const { path, text, json } = read(file);
  if (file === LOCKFILE) {
    json.version = version;
    if (json.packages?.['']) json.packages[''].version = version;
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    return;
  }
  // Textual replacement of just the version line keeps formatting, key order and
  // trailing newline exactly as they were — a full JSON.stringify would reflow the
  // manifests and make every bump a noisy diff.
  const next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (next === text) throw new Error(`Could not find a "version" field in ${file}`);
  writeFileSync(path, next);
}

const arg = process.argv[2];

if (!arg) {
  const current = FILES.flatMap(versionsIn);
  const versions = [...new Set(current.map((c) => c.version))];
  current.forEach((c) => console.log(`  ${String(c.version ?? 'missing').padEnd(10)} ${c.label}`));
  if (versions.length > 1) {
    console.error(`\n✗ Version mismatch across ${versions.length} distinct values: ${versions.join(', ')}`);
    console.error('  Fix with: node scripts/version.mjs <version>');
    process.exit(1);
  }
  console.log(`\n✓ All files agree on ${versions[0]}`);
  process.exit(0);
}

let next = arg;
if (['major', 'minor', 'patch'].includes(arg)) {
  const [major, minor, patch] = read('manifest.json').version.split('.').map(Number);
  next =
    arg === 'major'
      ? `${major + 1}.0.0`
      : arg === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
}

if (!SEMVER.test(next)) {
  console.error(`✗ "${next}" is not a three-part version (both stores require x.y.z)`);
  process.exit(1);
}

FILES.forEach((f) => write(f, next));
console.log(`✓ Set version ${next} in ${FILES.length} files`);
