/*
 * ClipShare QR codes: a small QR Code encoder (ISO/IEC 18004, model 2) used to
 * show the invite link, so a phone can join a room by scanning it with its camera.
 *
 * Byte mode (UTF-8), versions 1-40, error correction L/M/Q/H, automatic or fixed
 * mask. tests/qr-test.js compares the output module for module with the "qrcode"
 * npm package and decodes it with jsQR.
 *
 *   ClipQR.encode(textOrBytes, { ecl: 'M', version, minVersion, maxVersion, mask })
 *     -> { version, size, ecl, mask, modules }   modules: Uint8Array, row-major, 1 = dark
 *   ClipQR.svg(textOrEncoded, { ecl, border: 4, moduleSize, label }) -> <svg> element
 *   ClipQR.pathData(encoded, border) -> SVG path data covering the dark modules
 */
(function (root) {
  'use strict';

  const LEVELS = 'LMQH';
  const FORMAT_LEVEL_BITS = [1, 0, 3, 2];   // how L, M, Q, H are written in the format information

  // Error correction codewords per block and number of blocks, by level (L, M, Q, H) and version (index 0 unused).
  const ECC_PER_BLOCK = [
    [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const ECC_BLOCKS = [
    [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  // ---------------------------------------------------------------------------
  // Reed-Solomon error correction over GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1
  // ---------------------------------------------------------------------------
  const EXP = new Uint8Array(510);
  const LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = EXP[i + 255] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  const generators = {};
  // (x - a^0)(x - a^1)...(x - a^(degree-1)), coefficients from the highest power down.
  function generator(degree) {
    if (generators[degree]) return generators[degree];
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    generators[degree] = poly;
    return poly;
  }

  function errorCorrection(data, degree) {
    const gen = generator(degree);
    const rem = new Uint8Array(degree);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.copyWithin(0, 1);
      rem[degree - 1] = 0;
      for (let j = 0; j < degree; j++) rem[j] ^= mul(gen[j + 1], factor);
    }
    return rem;
  }

  // ---------------------------------------------------------------------------
  // Data codewords
  // ---------------------------------------------------------------------------
  // Modules left for data and error correction once all function patterns are drawn.
  function rawDataModules(version) {
    let n = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const count = Math.floor(version / 7) + 2;
      n -= (25 * count - 10) * count - 55;   // alignment patterns
      if (version >= 7) n -= 36;            // version information
    }
    return n;
  }

  function dataCapacity(version, level) {
    return (rawDataModules(version) >> 3) - ECC_PER_BLOCK[level][version] * ECC_BLOCKS[level][version];
  }

  function fits(version, level, length) {
    return 4 + (version < 10 ? 8 : 16) + 8 * length <= 8 * dataCapacity(version, level);
  }

  // Byte-mode segment, terminator and padding, filling the version's data capacity.
  function dataCodewords(bytes, version, level) {
    const capacity = dataCapacity(version, level);
    const out = new Uint8Array(capacity);
    let bit = 0;
    const put = (value, length) => {
      for (let i = length - 1; i >= 0; i--, bit++) {
        if ((value >>> i) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
      }
    };
    put(0b0100, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) put(bytes[i], 8);
    bit += Math.min(4, capacity * 8 - bit);
    bit = (bit + 7) & ~7;
    for (let i = bit >> 3, pad = 0xec; i < capacity; i++, pad ^= 0xec ^ 0x11) out[i] = pad;
    return out;
  }

  // Splits the data into blocks, adds error correction to each and interleaves them.
  function interleave(data, version, level) {
    const blocks = ECC_BLOCKS[level][version];
    const eccLen = ECC_PER_BLOCK[level][version];
    const total = rawDataModules(version) >> 3;
    const longBlocks = total % blocks;
    const shortLen = Math.floor(total / blocks) - eccLen;
    const parts = [];
    for (let b = 0, pos = 0; b < blocks; b++) {
      const len = shortLen + (b >= blocks - longBlocks ? 1 : 0);
      const chunk = data.subarray(pos, pos + len);
      parts.push({ data: chunk, ecc: errorCorrection(chunk, eccLen) });
      pos += len;
    }
    const out = new Uint8Array(total);
    let k = 0;
    for (let i = 0; i <= shortLen; i++) {
      for (const p of parts) if (i < p.data.length) out[k++] = p.data[i];
    }
    for (let i = 0; i < eccLen; i++) {
      for (const p of parts) out[k++] = p.ecc[i];
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // The module grid
  // ---------------------------------------------------------------------------
  class Grid {
    constructor(version) {
      this.size = version * 4 + 17;
      this.dark = new Uint8Array(this.size * this.size);
      this.reserved = new Uint8Array(this.size * this.size);   // function patterns: no data, never masked
    }

    set(x, y, dark) {
      const k = y * this.size + x;
      this.dark[k] = dark ? 1 : 0;
      this.reserved[k] = 1;
    }
  }

  function alignmentPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const out = [6];
    for (let i = count - 2; i >= 0; i--) out.push(version * 4 + 10 - i * step);
    return out;
  }

  function drawFunctionPatterns(g, version) {
    const size = g.size;
    for (let i = 0; i < size; i++) {
      g.set(6, i, i % 2 === 0);
      g.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          g.set(x, y, ring !== 2 && ring !== 4);
        }
      }
    }
    const pos = alignmentPositions(version);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0)) continue;   // finder corners
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) g.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    drawFormatBits(g, 0, 0);   // reserves the area; rewritten once the mask is known
    drawVersionBits(g, version);
  }

  function drawFormatBits(g, level, mask) {
    const data = (FORMAT_LEVEL_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => (bits >>> i) & 1;
    const s = g.size;
    for (let i = 0; i < 6; i++) g.set(8, i, bit(i));
    g.set(8, 7, bit(6));
    g.set(8, 8, bit(7));
    g.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) g.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) g.set(8, s - 15 + i, bit(i));
    g.set(8, s - 8, 1);
  }

  function drawVersionBits(g, version) {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = (bits >>> i) & 1;
      const a = g.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, on);
      g.set(b, a, on);
    }
  }

  // Zigzag through two-module-wide columns from the bottom right, skipping the vertical timing pattern.
  function placeData(g, codewords) {
    const size = g.size;
    const total = codewords.length * 8;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let v = 0; v < size; v++) {
        const y = upward ? size - 1 - v : v;
        for (let j = 0; j < 2; j++) {
          const k = y * size + right - j;
          if (g.reserved[k] || i >= total) continue;
          g.dark[k] = (codewords[i >> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }

  // x = column, y = row.
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(g, mask) {
    const f = MASKS[mask];
    for (let y = 0; y < g.size; y++) {
      for (let x = 0; x < g.size; x++) {
        const k = y * g.size + x;
        if (!g.reserved[k] && f(x, y)) g.dark[k] ^= 1;
      }
    }
  }

  // Penalty rules 1 (runs) and 3 (finder-like 1:1:3:1:1 with four light modules on a side) for one line.
  function linePenalty(line) {
    const n = line.length;
    let score = 0;
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) score += run - 2;
      run = 1;
    }
    const light = (from, to) => {
      for (let i = Math.max(0, from); i < Math.min(n, to); i++) if (line[i]) return false;
      return true;
    };
    for (let i = 0; i + 7 <= n; i++) {
      if (line[i] && !line[i + 1] && line[i + 2] && line[i + 3] && line[i + 4] && !line[i + 5] && line[i + 6] &&
          (light(i - 4, i) || light(i + 7, i + 11))) score += 40;
    }
    return score;
  }

  function penalty(g) {
    const n = g.size;
    const d = g.dark;
    let score = 0;
    const line = new Uint8Array(n);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) line[b] = d[a * n + b];
      score += linePenalty(line);
      for (let b = 0; b < n; b++) line[b] = d[b * n + a];
      score += linePenalty(line);
    }
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = d[y * n + x];
        if (c === d[y * n + x + 1] && c === d[(y + 1) * n + x] && c === d[(y + 1) * n + x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (let k = 0; k < d.length; k++) dark += d[k];
    const total = n * n;
    score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function checkVersion(v) {
    if (!Number.isInteger(v) || v < 1 || v > 40) throw new RangeError('QR version must be an integer from 1 to 40');
    return v;
  }

  function encode(input, options) {
    const opts = options || {};
    const ecl = opts.ecl == null ? 'M' : String(opts.ecl).toUpperCase();
    const level = ecl.length === 1 ? LEVELS.indexOf(ecl) : -1;
    if (level < 0) throw new RangeError('QR error correction level must be L, M, Q or H');
    const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input));
    const min = checkVersion(opts.version || opts.minVersion || 1);
    const max = checkVersion(opts.version || opts.maxVersion || 40);
    let version = 0;
    for (let v = min; v <= max && !version; v++) if (fits(v, level, bytes.length)) version = v;
    if (!version) throw new RangeError('Too much data for a QR code (' + bytes.length + ' bytes)');
    let mask = opts.mask == null ? -1 : opts.mask;
    if (mask !== -1 && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) {
      throw new RangeError('QR mask must be an integer from 0 to 7');
    }

    const g = new Grid(version);
    drawFunctionPatterns(g, version);
    placeData(g, interleave(dataCodewords(bytes, version, level), version, level));
    if (mask < 0) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(g, m);
        drawFormatBits(g, level, m);
        const score = penalty(g);
        if (score < best) { best = score; mask = m; }
        applyMask(g, m);
      }
    }
    applyMask(g, mask);
    drawFormatBits(g, level, mask);
    return { version, size: g.size, ecl, mask, modules: g.dark };
  }

  function pathData(qr, border) {
    const b = border == null ? 4 : border;
    const n = qr.size;
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!qr.modules[y * n + x]) continue;
        let w = 1;
        while (x + w < n && qr.modules[y * n + x + w]) w++;
        d += 'M' + (x + b) + ' ' + (y + b) + 'h' + w + 'v1h-' + w + 'z';
        x += w;
      }
    }
    return d;
  }

  // Always black on white with a quiet zone, whatever the page colours, so cameras can read it.
  function svg(input, options) {
    const opts = options || {};
    const qr = input && input.modules ? input : encode(input, opts);
    const border = opts.border == null ? 4 : opts.border;
    const n = qr.size + 2 * border;
    const ns = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(ns, 'svg');
    el.setAttribute('viewBox', '0 0 ' + n + ' ' + n);
    if (opts.moduleSize) {
      el.setAttribute('width', String(n * opts.moduleSize));
      el.setAttribute('height', String(n * opts.moduleSize));
    }
    el.setAttribute('shape-rendering', 'crispEdges');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', opts.label || 'QR code');
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', String(n));
    bg.setAttribute('height', String(n));
    bg.setAttribute('fill', '#fff');
    const fg = document.createElementNS(ns, 'path');
    fg.setAttribute('d', pathData(qr, border));
    fg.setAttribute('fill', '#000');
    el.append(bg, fg);
    return el;
  }

  root.ClipQR = { encode, svg, pathData };
})(typeof window !== 'undefined' ? window : globalThis);
