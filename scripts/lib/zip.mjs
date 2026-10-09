// Minimal, deterministic ZIP writer.
//
// Store submissions are easier to reason about when the same source tree always
// produces a byte-identical archive: you can diff two builds, and a reviewer's
// copy provably matches yours. Shelling out to `zip` gives neither (it embeds the
// current mtime and varies by platform), so the archive is assembled here with a
// fixed timestamp and no external dependency.

import { deflateRawSync, inflateRawSync } from 'node:zlib';

// "Version made by": high byte is the host system, low byte the spec version (2.0).
// Host 3 = Unix, which is what tells unzip/zipinfo to read the Unix mode bits from
// the high half of the external attributes. Claiming MS-DOS (0) there while storing
// Unix bits is self-contradictory, and some extractors then ignore or misread them.
const VERSION_MADE_BY = (3 << 8) | 20;
// S_IFREG | 0644: a regular file, rw-r--r--. Without the file-type bits the mode
// describes nothing in particular, and zipinfo shows it as "?rw-r--r--".
const UNIX_MODE = 0o100644;

// Fixed DOS timestamp: 1980-01-01 00:00:00, the zero point of the ZIP epoch.
const DOS_TIME = 0;
const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{name: string, data: Buffer}>} entries Archive members. `name` uses
 *   forward slashes and is stored verbatim, so callers control the layout.
 * @returns {Buffer}
 */
export function createZip(entries) {
  validateNames(entries);

  // Sort by name so archive order never depends on filesystem iteration order.
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });

    // Only compress when it actually helps; tiny files often grow.
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(VERSION_MADE_BY, 4); // version made by: Unix, spec 2.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((UNIX_MODE << 16) >>> 0, 38); // external attrs: regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * Refuse member names that would make an unsafe or ambiguous archive: a duplicate
 * (which copy wins depends on the extractor), an absolute path or a `..` segment
 * (extracts outside the target directory — "zip slip"), backslashes (a Windows
 * separator some tools honour and others keep literally), or an empty segment.
 */
function validateNames(entries) {
  const seen = new Set();
  for (const { name } of entries) {
    if (typeof name !== 'string' || name === '') throw new Error('zip: empty member name');
    if (name.includes('\\')) throw new Error(`zip: "${name}" contains a backslash; use forward slashes`);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name))
      throw new Error(`zip: "${name}" is an absolute path`);
    const segments = name.split('/');
    if (segments.some((s) => s === '..')) throw new Error(`zip: "${name}" escapes the archive root`);
    if (segments.some((s) => s === '' || s === '.'))
      throw new Error(`zip: "${name}" has an empty or "." segment`);
    if (seen.has(name)) throw new Error(`zip: duplicate member "${name}"`);
    seen.add(name);
  }
}

/**
 * Read an archive back through its central directory, inflate every member and
 * verify its CRC-32 and size. This is an independent check on createZip(): it
 * reads the structure a real extractor reads (EOCD → central directory → local
 * headers) rather than trusting the writer's own bookkeeping.
 *
 * @param {Buffer} zip
 * @returns {Array<{name: string, data: Buffer, method: number, versionMadeBy: number, externalAttrs: number}>}
 */
export function readZip(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > zip.length) throw new Error('zip: no end-of-central-directory record');
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize !== eocd) throw new Error('zip: central directory does not end at the EOCD record');

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip: bad central header #${i}`);
    const versionMadeBy = zip.readUInt16LE(p + 4);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const externalAttrs = zip.readUInt32LE(p + 38);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const localName = zip.toString('utf8', localOffset + 30, localOffset + 30 + localNameLen);
    if (localName !== name) throw new Error(`zip: local/central name mismatch (${localName} vs ${name})`);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const payload = zip.subarray(start, start + compSize);

    let data;
    if (method === 0) data = Buffer.from(payload);
    else if (method === 8) data = inflateRawSync(payload);
    else throw new Error(`zip: ${name} uses unsupported method ${method}`);
    if (data.length !== size)
      throw new Error(`zip: ${name} inflates to ${data.length} bytes, header says ${size}`);
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
    out.push({ name, data, method, versionMadeBy, externalAttrs });
  }
  return out;
}
