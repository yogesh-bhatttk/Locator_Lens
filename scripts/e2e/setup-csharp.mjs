#!/usr/bin/env node
// Install a .NET SDK for the C# export runners (scripts/e2e/runners/csharp.mjs)
// without sudo: Microsoft's dotnet-install script into
// node_modules/.cache/locatra-e2e/dotnet. A `dotnet` already on PATH (or DOTNET_ROOT,
// or LOCATRA_DOTNET) with a new-enough SDK is used as is and nothing is downloaded.
//
//   node scripts/e2e/setup-csharp.mjs            # install if missing
//   node scripts/e2e/setup-csharp.mjs --force    # install into the cache regardless
//   node scripts/e2e/setup-csharp.mjs --restore  # also pre-fetch the NuGet packages
//
// NuGet packages land in node_modules/.cache/locatra-e2e/nuget (NUGET_PACKAGES)
// unless NUGET_PACKAGES is set — cache that directory in CI.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE = join(ROOT, 'node_modules/.cache/locatra-e2e');
export const DOTNET_DIR = join(CACHE, 'dotnet');
export const NUGET_DIR = join(CACHE, 'nuget');
/** The SDK channel installed when none is available (an LTS release). */
export const DOTNET_CHANNEL = '10.0';
/** Oldest SDK major version the runners accept. */
export const MIN_SDK_MAJOR = 8;

const EXE = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';

function sdkMajors(dotnet) {
  const r = spawnSync(dotnet, ['--list-sdks'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((l) => Number((/^(\d+)\./.exec(l.trim()) || [])[1]))
    .filter((n) => n >= MIN_SDK_MAJOR);
}

/**
 * The dotnet to use: LOCATRA_DOTNET, the local cache, DOTNET_ROOT, then PATH — the
 * first with an SDK ≥ MIN_SDK_MAJOR. Returns { dotnet, root, major } or null.
 */
export function findDotnet() {
  const candidates = [];
  if (process.env.LOCATRA_DOTNET) candidates.push(process.env.LOCATRA_DOTNET);
  candidates.push(join(DOTNET_DIR, EXE));
  if (process.env.DOTNET_ROOT) candidates.push(join(process.env.DOTNET_ROOT, EXE));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) candidates.push(join(dir, EXE));
  for (const dotnet of candidates) {
    if (!existsSync(dotnet)) continue;
    const majors = sdkMajors(dotnet);
    if (majors.length) return { dotnet, root: dirname(dotnet), major: Math.max(...majors) };
  }
  return null;
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

export async function installDotnet({ log = console.log } = {}) {
  mkdirSync(DOTNET_DIR, { recursive: true });
  const win = process.platform === 'win32';
  const script = join(CACHE, win ? 'dotnet-install.ps1' : 'dotnet-install.sh');
  log(`downloading ${win ? 'dotnet-install.ps1' : 'dotnet-install.sh'} …`);
  await download(`https://dot.net/v1/${win ? 'dotnet-install.ps1' : 'dotnet-install.sh'}`, script);
  log(`installing the .NET ${DOTNET_CHANNEL} SDK into ${DOTNET_DIR} …`);
  const r = win
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Channel',
          DOTNET_CHANNEL,
          '-InstallDir',
          DOTNET_DIR,
          '-NoPath',
        ],
        { stdio: 'inherit' }
      )
    : (chmodSync(script, 0o755),
      spawnSync('bash', [script, '--channel', DOTNET_CHANNEL, '--install-dir', DOTNET_DIR, '--no-path'], {
        stdio: 'inherit',
      }));
  if (r.status !== 0) throw new Error(`dotnet-install failed (exit ${r.status})`);
}

/** Environment for running the SDK quietly with the shared NuGet cache. */
export function dotnetEnv(found) {
  return {
    DOTNET_ROOT: found.root,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME || CACHE,
    NUGET_PACKAGES: process.env.NUGET_PACKAGES || NUGET_DIR,
    PATH: found.root + delimiter + (process.env.PATH ?? ''),
  };
}

async function main() {
  const args = process.argv.slice(2);
  let found = args.includes('--force') ? null : findDotnet();
  if (found) {
    console.log(`using ${found.dotnet} (SDK ${found.major}.x) — nothing to install`);
  } else {
    await installDotnet();
    found = findDotnet();
    if (!found) throw new Error(`no usable SDK in ${DOTNET_DIR} after installing`);
    console.log(`installed: ${found.dotnet} (SDK ${found.major}.x)`);
  }
  if (args.includes('--restore')) {
    const { scaffold } = await import('./runners/csharp.mjs');
    for (const kind of ['playwright', 'selenium']) {
      const dir = join(CACHE, `csharp-restore-${kind}`);
      scaffold({ dir, kind, major: found.major, script: '' });
      const r = spawnSync(found.dotnet, ['restore'], {
        cwd: dir,
        stdio: 'inherit',
        env: { ...process.env, ...dotnetEnv(found) },
      });
      if (r.status !== 0) throw new Error(`dotnet restore (${kind}) failed`);
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(`NuGet packages restored into ${process.env.NUGET_PACKAGES || NUGET_DIR}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
