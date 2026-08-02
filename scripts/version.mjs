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
];

const SEMVER = /^\d+\.\d+\.\d+$/;

function read(file) {
  const path = join(ROOT, file);
  const text = readFileSync(path, 'utf8');
  return { path, text, json: JSON.parse(text), version: JSON.parse(text).version };
}

function write(file, version) {
  const { path, text } = read(file);
  // Textual replacement of just the version line keeps formatting, key order and
  // trailing newline exactly as they were — a full JSON.stringify would reflow the
  // manifests and make every bump a noisy diff.
  const next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (next === text) throw new Error(`Could not find a "version" field in ${file}`);
  writeFileSync(path, next);
}

const arg = process.argv[2];
const current = FILES.map((f) => ({ file: f, ...read(f) }));

if (!arg) {
  const versions = [...new Set(current.map((c) => c.version))];
  current.forEach((c) => console.log(`  ${c.version.padEnd(10)} ${c.file}`));
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
