/*
 * Checks web/js/crypto.js against an independent implementation (Node's crypto
 * module) and writes tests/vectors.json (fixed vectors for other implementations).
 *
 *   node crypto-vectors.js
 */
'use strict';

const assert = require('assert');
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('../web/js/crypto.js');
const C = globalThis.ClipCrypto;

function reference(code) {
  const master = nodeCrypto.pbkdf2Sync(Buffer.from(code, 'utf8'), Buffer.from('clipshare/v1'), 200000, 32, 'sha256');
  const sub = (label) => nodeCrypto.createHmac('sha256', master).update(label).digest();
  return { roomId: sub('room-id').toString('hex'), enc: sub('enc-key'), mac: sub('mac-key') };
}

function refEncrypt(ref, plain, aad, iv) {
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', ref.enc, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const aadBuf = Buffer.from(aad, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(aadBuf.length);
  const tag = nodeCrypto.createHmac('sha256', ref.mac).update(Buffer.concat([Buffer.from([1]), len, aadBuf, iv, ct])).digest();
  return Buffer.concat([Buffer.from([1]), iv, ct, tag]);
}

async function main() {
  // Code normalisation
  assert.strictEqual(C.normalizeCode(' 7k2qm-xr4td '), '7K2QMXR4TD');
  assert.strictEqual(C.normalizeCode('o1Li-uU'), '0111VV');
  assert.strictEqual(C.formatCode('7k2qmxr4td'), '7K2QM-XR4TD');
  assert.ok(C.isValidCode('7K2QM-XR4TD'));
  assert.ok(!C.isValidCode('7K2QM-XR4T'));
  for (let i = 0; i < 200; i++) {
    const c = C.generateCode();
    assert.ok(C.isValidCode(c) && c === C.normalizeCode(c), 'generated code ' + c);
  }

  const code = '7K2QMXR4TD';
  const keys = await C.deriveRoom('7k2qm-xr4td');
  const ref = reference(code);
  assert.strictEqual(keys.code, code);
  assert.strictEqual(keys.roomId, ref.roomId);

  const cases = [
    { aad: 'text', plain: Buffer.from(JSON.stringify({ v: 1, t: 'text', from: 'PC-A', src: 'chat', text: 'Hello \u00e9\u4e16\u754c \ud83d\ude00' }), 'utf8') },
    { aad: 'meta', plain: Buffer.from(JSON.stringify({ v: 1, t: 'file', from: 'PC-A', src: 'drop', name: 'a.txt', mime: 'text/plain', size: 3 }), 'utf8') },
    { aad: 'chunk:00000000-0000-4000-8000-000000000000:0:1', plain: Buffer.alloc(0) },
    { aad: 'presence', plain: Buffer.from(Array.from({ length: 33 }, (_, i) => i)) },
  ];
  const out = { scheme: 1, code: '7K2QM-XR4TD', roomId: ref.roomId, encKey: ref.enc.toString('hex'), macKey: ref.mac.toString('hex'), cases: [] };
  for (let i = 0; i < cases.length; i++) {
    const iv = Buffer.alloc(16, i + 1);
    const blob = Buffer.from(await C.encryptBytes(keys, new Uint8Array(cases[i].plain), cases[i].aad, new Uint8Array(iv)));
    assert.strictEqual(blob.toString('hex'), refEncrypt(ref, cases[i].plain, cases[i].aad, iv).toString('hex'), 'case ' + i);
    const back = Buffer.from(await C.decryptBytes(keys, blob, cases[i].aad));
    assert.ok(back.equals(cases[i].plain));
    out.cases.push({ aad: cases[i].aad, iv: iv.toString('hex'), plain: cases[i].plain.toString('hex'), blob: blob.toString('base64') });
  }

  // Tampering and wrong context must fail
  const blob = await C.encryptBytes(keys, new Uint8Array([1, 2, 3]), 'text');
  await assert.rejects(C.decryptBytes(keys, blob, 'meta'));
  const bad = blob.slice();
  bad[20] ^= 1;
  await assert.rejects(C.decryptBytes(keys, bad, 'text'));
  const other = await C.deriveRoom('7K2QM-XR4TE');
  await assert.rejects(C.decryptBytes(other, blob, 'text'));

  // JSON helpers and base64 round trip
  const obj = { a: 'x'.repeat(100000), b: [1, 2, 3] };
  assert.deepStrictEqual(await C.decryptJson(keys, await C.encryptJson(keys, obj, 'text'), 'text'), obj);
  const big = nodeCrypto.randomBytes(300000);
  assert.ok(Buffer.from(C.base64ToBytes(C.bytesToBase64(new Uint8Array(big)))).equals(big));

  const file = path.join(__dirname, 'vectors.json');
  const text = JSON.stringify(out, null, 2) + '\n';
  if (fs.existsSync(file) && !process.argv.includes('--write')) {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), out, 'vectors.json differs (run with --write to regenerate)');
    console.log('crypto: OK (matches vectors.json)');
  } else {
    fs.writeFileSync(file, text);
    console.log('crypto: OK (wrote vectors.json)');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
