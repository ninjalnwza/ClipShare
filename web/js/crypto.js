/*
 * PastePort crypto: room codes, key derivation and authenticated encryption.
 *
 * Scheme v1 (tests/crypto-vectors.js checks it against Node's crypto module):
 *   code    = 10 Crockford base32 characters (50 bits), e.g. "7K2QM-XR4TD"
 *   master  = PBKDF2-HMAC-SHA256(normalized code, salt "clipshare/v1", 200000 iterations, 32 bytes)
 *   roomId  = hex(HMAC-SHA256(master, "room-id"))      -> sent to the server
 *   encKey  = HMAC-SHA256(master, "enc-key")           -> AES-256-CBC (PKCS#7)
 *   macKey  = HMAC-SHA256(master, "mac-key")           -> HMAC-SHA256
 *   blob    = 0x01 | iv(16) | ciphertext | tag(32)
 *   tag     = HMAC-SHA256(macKey, 0x01 | uint32be(len(aad)) | aad | iv | ciphertext)
 */
(function (root) {
  'use strict';

  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CODE_LENGTH = 10;
  const ITERATIONS = 200000;
  // From the app's original name (ClipShare). Changing it would make existing rooms unreadable.
  const SALT = 'clipshare/v1';
  const VERSION = 1;
  const te = new TextEncoder();
  const td = new TextDecoder();

  function generateCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    let code = '';
    for (const b of bytes) code += ALPHABET[b & 31];
    return code;
  }

  function normalizeCode(input) {
    return String(input || '')
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0')
      .replace(/U/g, 'V');
  }

  function isValidCode(input) {
    const code = normalizeCode(input);
    if (code.length !== CODE_LENGTH) return false;
    for (const c of code) if (ALPHABET.indexOf(c) < 0) return false;
    return true;
  }

  function formatCode(input) {
    const code = normalizeCode(input);
    return code.length === CODE_LENGTH ? code.slice(0, 5) + '-' + code.slice(5) : code;
  }

  function toHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  function concatBytes(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function bytesToBase64(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveRoom(codeInput) {
    const code = normalizeCode(codeInput);
    if (!isValidCode(code)) throw new Error('Invalid room code');
    const pw = await crypto.subtle.importKey('raw', te.encode(code), 'PBKDF2', false, ['deriveBits']);
    const master = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(SALT), iterations: ITERATIONS }, pw, 256));
    const hk = await crypto.subtle.importKey('raw', master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sub = async (label) => new Uint8Array(await crypto.subtle.sign('HMAC', hk, te.encode(label)));
    const [rid, ek, mk] = await Promise.all([sub('room-id'), sub('enc-key'), sub('mac-key')]);
    const encKey = await crypto.subtle.importKey('raw', ek, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
    const macKey = await crypto.subtle.importKey('raw', mk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return { code, roomId: toHex(rid), encKey, macKey };
  }

  function macInput(aadBytes, iv, ct) {
    const head = new Uint8Array(5);
    head[0] = VERSION;
    new DataView(head.buffer).setUint32(1, aadBytes.length);
    return concatBytes([head, aadBytes, iv, ct]);
  }

  async function encryptBytes(keys, plain, aad, ivOverride) {
    const iv = ivOverride || crypto.getRandomValues(new Uint8Array(16));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, keys.encKey, plain));
    const tag = new Uint8Array(await crypto.subtle.sign('HMAC', keys.macKey, macInput(te.encode(aad || ''), iv, ct)));
    return concatBytes([new Uint8Array([VERSION]), iv, ct, tag]);
  }

  async function decryptBytes(keys, blob, aad) {
    const data = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    if (data.length < 1 + 16 + 16 + 32 || data[0] !== VERSION) throw new Error('Unsupported or corrupted data');
    const iv = data.subarray(1, 17);
    const ct = data.subarray(17, data.length - 32);
    const tag = data.subarray(data.length - 32);
    const ok = await crypto.subtle.verify('HMAC', keys.macKey, tag, macInput(te.encode(aad || ''), iv, ct));
    if (!ok) throw new Error('Could not decrypt (wrong room code or corrupted data)');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keys.encKey, ct));
  }

  async function encryptJson(keys, obj, aad) {
    return bytesToBase64(await encryptBytes(keys, te.encode(JSON.stringify(obj)), aad));
  }

  async function decryptJson(keys, b64, aad) {
    return JSON.parse(td.decode(await decryptBytes(keys, base64ToBytes(b64), aad)));
  }

  async function sha256Hex(input) {
    const bytes = typeof input === 'string' ? te.encode(input) : input;
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }

  root.ClipCrypto = {
    CODE_LENGTH, generateCode, normalizeCode, isValidCode, formatCode,
    deriveRoom, encryptBytes, decryptBytes, encryptJson, decryptJson,
    bytesToBase64, base64ToBytes, toHex, sha256Hex, concatBytes,
  };
})(typeof window !== 'undefined' ? window : globalThis);
