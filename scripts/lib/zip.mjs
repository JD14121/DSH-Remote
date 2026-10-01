/**
 * Minimal ZIP reader/writer used by the R8G.2 APK build.
 *
 * ## Why this exists
 *
 * `classes.dex` has to sit at the APK root, and neither obvious route works:
 *
 * * **Appending the entry by hand** fails because aapt2's output is not a plain
 *   local-then-central ZIP. It carries extra data after the central directory, so computing the
 *   new local-header offset from the central directory's end placed it inside that trailing data
 *   and produced an archive `zipalign` refused.
 * * **Letting `aapt2 compile` include it** fails silently. aapt2 only compiles recognised resource
 *   types and skips anything else without a warning, so `classes.dex` simply never appeared.
 *
 * So the archive is read properly and written back out as a clean, standard ZIP. Only stored and
 * deflated entries are handled, which is everything an APK contains.
 *
 * `classes.dex` is written STORED, as the runtime requires.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/** Local file header signature. */
const LOCAL = 0x04034b50;
/** Central directory header signature. */
const CENTRAL = 0x02014b50;
/** End of central directory signature. */
const EOCD = 0x06054b50;

/**
 * Locate the end-of-central-directory record.
 *
 * The record is found by searching BACKWARD from the end, and the first candidate is validated
 * against the file length. A forward search would match the signature bytes wherever they happen
 * to occur inside compressed data, which silently corrupts the offsets that follow.
 *
 * @param {Buffer} buffer - the archive.
 * @returns {number} the offset of the EOCD, or -1.
 */
function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    // The comment must run exactly to the end of the file for this to be the real record.
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  return -1;
}

/**
 * Read every entry in a ZIP.
 *
 * @param {string} file - path to the archive.
 * @returns {Array<{name: string, data: Buffer}>} the entries, in central-directory order.
 */
export function readZip(file) {
  const buffer = fs.readFileSync(file);
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error(`${file}: no end-of-central-directory record`);

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length) throw new Error(`${file}: central directory runs past the file`);
    if (buffer.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error(`${file}: bad central directory signature at ${cursor}`);
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    // The local header carries its own name/extra lengths, which may differ from the central
    // record's; the data offset must be computed from the LOCAL header, never assumed.
    if (buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`${file}: bad local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${file}: unsupported compression method ${method} for ${name}`);

    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** CRC-32, as ZIP requires. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Write a ZIP from entries. Everything is stored uncompressed.
 *
 * Storing rather than deflating costs a few kilobytes and buys two things that matter here: no
 * compressor can alter a byte of `classes.dex`, and alignment stays predictable for zipalign.
 *
 * @param {string} file - path to write.
 * @param {Array<{name: string, data: Buffer}>} entries - the entries to write.
 * @returns {void}
 */
export function writeStoredZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);          // version needed to extract
    local.writeUInt16LE(0, 6);           // general purpose flags
    local.writeUInt16LE(0, 8);           // method 0 = stored
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);         // flags
    central.writeUInt16LE(0, 10);        // method
    central.writeUInt16LE(0, 12);        // mod time
    central.writeUInt16LE(0x21, 14);     // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk number
    central.writeUInt16LE(0, 36);        // internal attributes
    // 0644 regular file, so the entry is not mistaken for a directory. `>>> 0` is required:
    // 0o100644 << 16 exceeds the signed 32-bit range and `writeUInt32LE` rejects a negative.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);                       // disk number
  eocd.writeUInt16LE(0, 6);                       // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);          // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);         // entries total
  eocd.writeUInt32LE(centralBuffer.length, 12);   // central directory size
  eocd.writeUInt32LE(offset, 16);                 // central directory offset
  eocd.writeUInt16LE(0, 20);                      // comment length

  fs.writeFileSync(file, Buffer.concat([...locals, centralBuffer, eocd]));
}

/**
 * Add entries to an existing ZIP by rewriting it.
 *
 * @param {string} source - the archive to read.
 * @param {string} target - the archive to write.
 * @param {Array<{name: string, data: Buffer}>} additions - entries to add.
 * @returns {Array<string>} the entry names in the written archive.
 */
export function addEntries(source, target, additions) {
  const existing = readZip(source);
  const names = new Set(existing.map((entry) => entry.name));
  const merged = [...existing];
  for (const addition of additions) {
    if (names.has(addition.name)) throw new Error(`${addition.name} already exists in ${source}`);
    merged.push(addition);
  }
  writeStoredZip(target, merged);
  return merged.map((entry) => entry.name);
}
