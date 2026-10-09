#!/usr/bin/env node
// The Java toolchain the Java export runners (scripts/e2e/runners/java.mjs) need: a
// JDK (>= 17) and Maven. Uses what the machine already has — LOCATRA_JAVA_HOME /
// LOCATRA_MVN, then JAVA_HOME / `mvn` on PATH (CI: actions/setup-java) — and
// otherwise installs both WITHOUT sudo into node_modules/.cache/locatra-e2e/java/:
//   * Eclipse Temurin JDK 21 (the current GA build, from the Adoptium API, sha256-checked)
//   * Apache Maven (pinned, from Maven Central, sha512-checked)
// then resolves every Maven dependency the generated tests use into the local
// repository there (node_modules/.cache/locatra-e2e/java/m2), so the export runs
// work offline afterwards.
//
//   node scripts/e2e/setup-java.mjs            # install what is missing, prefetch deps
//   node scripts/e2e/setup-java.mjs --check    # report what would be used, install nothing
//
// The runner imports javaToolchain() / pomXml() from here, so the versions below are
// the single source of truth for both.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const JAVA_CACHE = join(ROOT, 'node_modules/.cache/locatra-e2e/java');
export const M2_REPO = process.env.LOCATRA_M2_REPO || join(JAVA_CACHE, 'm2');

// Matched to the Node/Python sides: Playwright 1.59 (same driver and protocol as
// @playwright/test 1.59.1 and playwright==1.59.0) and Selenium 4.50.0.
export const VERSIONS = {
  jdkFeature: 21,
  maven: '3.9.16',
  playwright: '1.59.0',
  selenium: '4.50.0',
  junit: '5.14.4',
  surefire: '3.5.6',
  compiler: '3.14.1',
};
const MIN_JAVA = 17;

const IS_WIN = process.platform === 'win32';
const exe = (name) => (IS_WIN ? `${name}.exe` : name);

// ── discovery ─────────────────────────────────────────────────────────────────

/** The major version of the JDK at `home` (needs javac too), or 0. */
function jdkMajor(home) {
  if (!home || !existsSync(join(home, 'bin', exe('javac')))) return 0;
  const r = spawnSync(join(home, 'bin', exe('java')), ['-version'], { encoding: 'utf8', timeout: 60_000 });
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  if (!m) return 0;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

/** A JDK home for the `java` on PATH (resolving symlinks), or null. */
function jdkFromPath() {
  const r = spawnSync(exe('java'), ['-XshowSettings:properties', '-version'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const m = /java\.home = (.+)/.exec(`${r.stderr}${r.stdout}`);
  return m ? m[1].trim() : null;
}

function cachedJdk() {
  const home = join(JAVA_CACHE, 'jdk');
  const mac = join(home, 'Contents/Home');
  return existsSync(mac) ? mac : home;
}

function cachedMaven() {
  return join(JAVA_CACHE, 'maven', 'bin', IS_WIN ? 'mvn.cmd' : 'mvn');
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const n of IS_WIN ? [`${name}.cmd`, `${name}.exe`] : [name]) {
      if (dir && existsSync(join(dir, n))) return join(dir, n);
    }
  }
  return null;
}

/**
 * The JDK and Maven to use: { javaHome, mvn, javaVersion } or { missing: why }.
 * Order: LOCATRA_JAVA_HOME, JAVA_HOME, the cache, `java` on PATH (each must be a
 * JDK >= 17); LOCATRA_MVN, the cache, `mvn` on PATH.
 */
export function javaToolchain() {
  let javaHome = null;
  let javaVersion = 0;
  const homes = [process.env.LOCATRA_JAVA_HOME, process.env.JAVA_HOME, cachedJdk()];
  for (const home of homes) {
    const major = jdkMajor(home);
    if (major >= MIN_JAVA) {
      javaHome = home;
      javaVersion = major;
      break;
    }
  }
  if (!javaHome) {
    const home = jdkFromPath();
    const major = jdkMajor(home);
    if (major >= MIN_JAVA) {
      javaHome = home;
      javaVersion = major;
    }
  }
  const mvn = [process.env.LOCATRA_MVN, cachedMaven(), onPath('mvn')].find((p) => p && existsSync(p)) ?? null;
  const fix =
    'run `node scripts/e2e/setup-java.mjs` (installs into node_modules/.cache/locatra-e2e/java, no sudo)';
  if (!javaHome)
    return { missing: `no JDK >= ${MIN_JAVA} found (LOCATRA_JAVA_HOME, JAVA_HOME, PATH) — ${fix}` };
  if (!mvn) return { missing: `Maven (mvn) not found — ${fix}` };
  return { javaHome, mvn, javaVersion };
}

/** Environment for running java/mvn from `tc`: JAVA_HOME and its bin/ first on PATH. */
export function javaEnv(tc, env = {}) {
  const base = env.PATH ?? process.env.PATH ?? '';
  return { ...env, JAVA_HOME: tc.javaHome, PATH: [join(tc.javaHome, 'bin'), base].join(delimiter) };
}

// ── the Maven project around a generated test ───────────────────────────────────

/**
 * pom.xml for a project holding one generated test class. `kind` is 'playwright' or
 * 'selenium'; the test class itself is never edited.
 */
export function pomXml(kind, { artifactId = `locatra-${kind}-java` } = {}) {
  const dep =
    kind === 'playwright'
      ? `    <dependency>
      <groupId>com.microsoft.playwright</groupId>
      <artifactId>playwright</artifactId>
      <version>${VERSIONS.playwright}</version>
      <scope>test</scope>
    </dependency>`
      : `    <dependency>
      <groupId>org.seleniumhq.selenium</groupId>
      <artifactId>selenium-java</artifactId>
      <version>${VERSIONS.selenium}</version>
      <scope>test</scope>
    </dependency>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/e2e (Locatra export tests). -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.locatra.e2e</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>${MIN_JAVA}</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
${dep}
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>${VERSIONS.junit}</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>${VERSIONS.compiler}</version>
        <configuration>
          <compilerArgs><arg>-Xlint:all</arg></compilerArgs>
        </configuration>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>${VERSIONS.surefire}</version>
        <configuration>
          <trimStackTrace>false</trimStackTrace>
          <redirectTestOutputToFile>false</redirectTestOutputToFile>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

/** Common Maven arguments: batch mode, the local repository in the cache. */
export function mvnArgs(...goals) {
  return ['-B', '-ntp', `-Dmaven.repo.local=${M2_REPO}`, ...goals];
}

// ── installation ───────────────────────────────────────────────────────────────

const OS = { linux: 'linux', darwin: 'mac', win32: 'windows' }[process.platform];
const ARCH = { x64: 'x64', arm64: 'aarch64' }[process.arch];

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

function digest(file, algo) {
  return createHash(algo).update(readFileSync(file)).digest('hex');
}

function extract(archive, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  // bsdtar on Windows 10+ reads .zip too.
  const r = spawnSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar -xf ${archive} failed`);
  const top = readdirSync(into);
  if (top.length !== 1) throw new Error(`unexpected archive layout in ${archive}: ${top.join(', ')}`);
  return join(into, top[0]);
}

async function installJdk() {
  if (!OS || !ARCH) throw new Error(`no Temurin build for ${process.platform}/${process.arch}`);
  const api =
    `https://api.adoptium.net/v3/assets/latest/${VERSIONS.jdkFeature}/hotspot` +
    `?architecture=${ARCH}&image_type=jdk&os=${OS}&vendor=eclipse`;
  const res = await fetch(api);
  if (!res.ok) throw new Error(`GET ${api} → HTTP ${res.status}`);
  const [asset] = await res.json();
  if (!asset) throw new Error(`Adoptium lists no JDK ${VERSIONS.jdkFeature} for ${OS}/${ARCH}`);
  const pkg = asset.binary.package;
  mkdirSync(JAVA_CACHE, { recursive: true });
  const archive = join(JAVA_CACHE, pkg.name);
  console.log(`downloading ${pkg.name} (${(pkg.size / 1e6).toFixed(0)} MB)`);
  await download(pkg.link, archive);
  const sum = digest(archive, 'sha256');
  if (sum !== pkg.checksum) throw new Error(`sha256 mismatch for ${pkg.name}: ${sum} != ${pkg.checksum}`);
  const top = extract(archive, join(JAVA_CACHE, 'jdk.tmp'));
  rmSync(join(JAVA_CACHE, 'jdk'), { recursive: true, force: true });
  renameSync(top, join(JAVA_CACHE, 'jdk'));
  rmSync(join(JAVA_CACHE, 'jdk.tmp'), { recursive: true, force: true });
  rmSync(archive, { force: true });
  writeFileSync(join(JAVA_CACHE, 'jdk', '.locatra-release'), `${asset.release_name}\n`);
  console.log(`installed ${asset.release_name} → ${cachedJdk()}`);
}

async function installMaven() {
  const v = VERSIONS.maven;
  const name = `apache-maven-${v}-bin.tar.gz`;
  const url = `https://repo1.maven.org/maven2/org/apache/maven/apache-maven/${v}/${name}`;
  mkdirSync(JAVA_CACHE, { recursive: true });
  const archive = join(JAVA_CACHE, name);
  console.log(`downloading ${name}`);
  await download(url, archive);
  const res = await fetch(`${url}.sha512`);
  if (!res.ok) throw new Error(`GET ${url}.sha512 → HTTP ${res.status}`);
  const want = (await res.text()).trim().split(/\s+/)[0];
  const sum = digest(archive, 'sha512');
  if (sum !== want) throw new Error(`sha512 mismatch for ${name}`);
  const top = extract(archive, join(JAVA_CACHE, 'maven.tmp'));
  rmSync(join(JAVA_CACHE, 'maven'), { recursive: true, force: true });
  renameSync(top, join(JAVA_CACHE, 'maven'));
  rmSync(join(JAVA_CACHE, 'maven.tmp'), { recursive: true, force: true });
  rmSync(archive, { force: true });
  console.log(`installed Maven ${v} → ${cachedMaven()}`);
}

/** Resolve every dependency and plugin both runners use, into M2_REPO. */
function prefetch(tc) {
  for (const kind of ['playwright', 'selenium']) {
    const dir = join(JAVA_CACHE, `prefetch-${kind}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'src/test/java'), { recursive: true });
    writeFileSync(join(dir, 'pom.xml'), pomXml(kind));
    writeFileSync(join(dir, 'src/test/java/NoopTest.java'), 'class NoopTest {}\n');
    console.log(`resolving the ${kind} Maven dependencies into ${M2_REPO}`);
    const r = spawnSync(
      tc.mvn,
      mvnArgs('-q', 'test-compile', 'dependency:resolve-plugins', 'dependency:go-offline'),
      {
        cwd: dir,
        stdio: 'inherit',
        env: javaEnv(tc, process.env),
        shell: IS_WIN,
      }
    );
    rmSync(dir, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`mvn could not resolve the ${kind} dependencies`);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  let tc = javaToolchain();
  if (check) {
    console.log(
      tc.missing ? `missing: ${tc.missing}` : `JDK ${tc.javaVersion} at ${tc.javaHome}\nMaven at ${tc.mvn}`
    );
    return tc.missing ? 1 : 0;
  }
  if (!jdkMajor(tc.javaHome) && !(jdkMajor(cachedJdk()) >= MIN_JAVA)) await installJdk();
  if (!tc.mvn) await installMaven();
  tc = javaToolchain();
  if (tc.missing) throw new Error(tc.missing);
  console.log(`JDK ${tc.javaVersion} at ${tc.javaHome}\nMaven at ${tc.mvn}`);
  prefetch(tc);
  console.log('Java toolchain ready.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
  );
}
