/*
 * Checks web/js/qr.js, the app's own QR Code encoder:
 *  - module for module against the "qrcode" npm package (an independent encoder)
 *    for every version and error correction level, and every mask on a few versions;
 *  - by decoding its output with jsQR (including the automatic mask choice);
 *  - capacities against the QR Code specification, error handling, and the SVG path.
 *
 *   node qr-test.js
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const QRCode = require('qrcode');
const jsQR = require('jsqr');

require('../web/js/qr.js');
const Q = globalThis.ClipQR;

const LEVELS = ['L', 'M', 'Q', 'H'];
// jsQR 1.4.0 lists the version 23 alignment patterns at 6, 30, 54, 74, 102 instead of 6, 30, 54, 78, 102,
// so it misreads every version 23 symbol. Those are still compared with the reference encoder.
const JSQR_CANNOT_READ = new Set([23]);
// Byte-mode capacities from the specification (ISO/IEC 18004, table 7).
const SPEC_CAPACITY = {
  '1L': 17, '1M': 14, '1Q': 11, '1H': 7, '4M': 62, '9L': 230, '10M': 213, '10H': 119,
  '40L': 2953, '40M': 2331, '40Q': 1663, '40H': 1273,
};

function reference(bytes, version, ecl, mask) {
  return QRCode.create([{ data: bytes, mode: 'byte' }], { version, errorCorrectionLevel: ecl, maskPattern: mask }).modules;
}

function sameAsReference(qr, bytes, what) {
  const ref = reference(bytes, qr.version, qr.ecl, qr.mask);
  assert.strictEqual(ref.size, qr.size, what + ': size');
  if (!Buffer.from(ref.data).equals(Buffer.from(qr.modules))) {
    let diff = 0;
    for (let i = 0; i < ref.data.length; i++) if (ref.data[i] !== qr.modules[i]) diff++;
    assert.fail(what + ': ' + diff + ' modules differ from the reference encoder');
  }
}

// Black on white, 4-module quiet zone, `scale` pixels per module; RGBA for jsQR.
function rasterize(qr, scale) {
  const border = 4;
  const n = (qr.size + border * 2) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + border) * scale + dy) * n;
        for (let dx = 0; dx < scale; dx++) {
          const p = (row + (x + border) * scale + dx) * 4;
          px[p] = px[p + 1] = px[p + 2] = 0;
        }
      }
    }
  }
  return { px, n };
}

function decode(qr) {
  for (const scale of [3, 4, 6]) {
    const { px, n } = rasterize(qr, scale);
    const res = jsQR(px, n, n, { inversionAttempts: 'dontInvert' });
    if (res) return res;
  }
  return null;
}

function decodesTo(qr, bytes, what) {
  if (JSQR_CANNOT_READ.has(qr.version)) return false;
  const res = decode(qr);
  assert.ok(res, what + ': jsQR found no QR code');
  assert.ok(Buffer.from(res.binaryData).equals(Buffer.from(bytes)), what + ': jsQR decoded different data');
  assert.strictEqual(res.version, qr.version, what + ': version seen by jsQR');
  return true;
}

// Largest byte count that fits, found by bisection with encode(); cross-checked with the reference below.
function capacity(version, ecl) {
  let lo = 0;
  let hi = 3000;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    try { Q.encode(new Uint8Array(mid), { ecl, version, mask: 0 }); lo = mid; } catch (_) { hi = mid - 1; }
  }
  return lo;
}

// Parses pathData() output back into a module grid.
function pathToGrid(d, size, border) {
  const grid = new Uint8Array(size * size);
  const re = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let consumed = 0;
  let m;
  while ((m = re.exec(d))) {
    const x = +m[1] - border;
    const y = +m[2] - border;
    const w = +m[3];
    assert.strictEqual(+m[4], w);
    for (let i = 0; i < w; i++) {
      assert.strictEqual(grid[y * size + x + i], 0, 'overlapping path rectangles');
      grid[y * size + x + i] = 1;
    }
    consumed += m[0].length;
  }
  assert.strictEqual(consumed, d.length, 'unexpected path syntax');
  return grid;
}

function main() {
  const t0 = Date.now();
  let compared = 0;
  let decoded = 0;

  // Every version and level: full-capacity random data, fixed mask vs the reference, and the
  // automatic mask through jsQR.
  for (let version = 1; version <= 40; version++) {
    for (const ecl of LEVELS) {
      const what = 'v' + version + '-' + ecl;
      const cap = capacity(version, ecl);
      const spec = SPEC_CAPACITY[version + ecl];
      if (spec != null) assert.strictEqual(cap, spec, what + ': capacity');
      reference(new Uint8Array(cap), version, ecl, 0);
      assert.throws(() => reference(new Uint8Array(cap + 1), version, ecl, 0), /cannot contain|too big/, what + ': reference capacity');

      const bytes = crypto.randomBytes(cap);
      const mask = (version * 3 + LEVELS.indexOf(ecl)) % 8;
      const fixed = Q.encode(bytes, { ecl, version, mask });
      assert.deepStrictEqual([fixed.version, fixed.size, fixed.ecl, fixed.mask], [version, version * 4 + 17, ecl, mask], what);
      sameAsReference(fixed, bytes, what + ' mask ' + mask);
      compared++;

      const auto = Q.encode(bytes, { ecl, minVersion: version });
      assert.strictEqual(auto.version, version, what + ': smallest version that fits');
      assert.ok(auto.mask >= 0 && auto.mask <= 7);
      sameAsReference(auto, bytes, what + ' auto mask ' + auto.mask);
      compared++;
      if (decodesTo(auto, bytes, what + ' auto mask ' + auto.mask)) decoded++;
    }
  }

  // Every mask and level on versions with different structures (no alignment, one alignment,
  // version information, 16-bit length, many blocks), short and partly filled data.
  for (const version of [1, 2, 6, 7, 10, 14, 21, 32, 40]) {
    for (const ecl of LEVELS) {
      const bytes = crypto.randomBytes(Math.floor(capacity(version, ecl) * 0.6));
      for (let mask = 0; mask < 8; mask++) {
        const qr = Q.encode(bytes, { ecl, version, mask });
        sameAsReference(qr, bytes, 'v' + version + '-' + ecl + ' mask ' + mask);
        compared++;
        if (version <= 10 && decodesTo(qr, bytes, 'v' + version + '-' + ecl + ' mask ' + mask)) decoded++;
      }
    }
  }

  // Text is encoded as UTF-8; version follows the length.
  for (const text of ['a', 'Hello, PastePort!', 'สวัสดีครับ PastePort \u{1F4CB}', 'x'.repeat(500), '\u20AC'.repeat(300)]) {
    const qr = Q.encode(text);
    const res = decode(qr);
    assert.ok(res, 'no QR code found for ' + JSON.stringify(text.slice(0, 20)));
    assert.strictEqual(res.data, text);
    sameAsReference(qr, Buffer.from(text, 'utf8'), JSON.stringify(text.slice(0, 20)));
    decoded++;
  }
  const empty = Q.encode('');
  assert.strictEqual(empty.version, 1);
  sameAsReference(empty, new Uint8Array(0), 'empty text');

  // The invite link the app shows: version 4 (33 x 33) at level M.
  const link = 'https://pasteport.vercel.app/#join=7K2QM-XR4TD';
  const invite = Q.encode(link);
  assert.deepStrictEqual([invite.version, invite.ecl], [4, 'M']);
  assert.strictEqual(decode(invite).data, link);

  // Options and errors.
  assert.strictEqual(Q.encode('x', { ecl: 'h' }).ecl, 'H');
  assert.strictEqual(Q.encode('x', { minVersion: 5 }).version, 5);
  assert.throws(() => Q.encode(new Uint8Array(2954), { ecl: 'L' }), RangeError);
  assert.throws(() => Q.encode('x'.repeat(15), { version: 1 }), RangeError);
  assert.throws(() => Q.encode('x'.repeat(100), { maxVersion: 3 }), RangeError);
  for (const ecl of ['X', '', 'LM']) assert.throws(() => Q.encode('x', { ecl }), RangeError);
  for (const mask of [8, -2, 1.5]) assert.throws(() => Q.encode('x', { mask }), RangeError);
  for (const version of [0.5, 41]) assert.throws(() => Q.encode('x', { version }), RangeError);

  // The SVG path covers exactly the dark modules.
  for (const qr of [invite, Q.encode(crypto.randomBytes(1000), { ecl: 'L' })]) {
    for (const border of [0, 4]) {
      const grid = pathToGrid(Q.pathData(qr, border), qr.size, border);
      assert.ok(Buffer.from(grid).equals(Buffer.from(qr.modules)), 'path data does not match the modules');
    }
  }

  console.log('qr.js OK: ' + compared + ' symbols identical to the reference encoder, ' + decoded +
    ' decoded by jsQR (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
}

main();
