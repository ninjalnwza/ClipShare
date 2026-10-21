/*
 * Live smoke test: a deployed PastePort site and its real Supabase project.
 *
 *   node live-test.js https://<your-site>.vercel.app
 *
 * Takes the Supabase URL and key from the site's own config.js, checks that
 * supabase/setup.sql is installed and that Realtime works, then two browser
 * "computers" (system Chrome, fake in-page clipboard) exchange text and a file
 * in a new random room, and an emulated phone joins it through its QR code.
 * That room is cleared at the end; nothing else is
 * touched. HEADED=1 to watch, PW_CHANNEL=msedge to use Edge. Behind a
 * TLS-inspecting proxy, set NODE_OPTIONS=--use-system-ca first.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { chromium, devices } = require('playwright-core');
const { fakeClipboard, presetName } = require('./page-helpers');
const { decodeQr } = require('./qr-decode');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function rpc(cfg, fn, args) {
  const headers = { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(cfg.supabaseKey)) headers.Authorization = 'Bearer ' + cfg.supabaseKey;
  const res = await fetch(cfg.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, body };
}

// A raw Phoenix socket joined to `topic`, configured like the app's channel.
function rtJoin(cfg, topic, presenceKey, withToken) {
  const url = cfg.supabaseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') +
    '/realtime/v1/websocket?apikey=' + encodeURIComponent(cfg.supabaseKey) + '&vsn=1.0.0';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const sock = { ws, seen: [], waiters: [], ref: 1 };
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Realtime: no join reply within 15 s')); }, 15000);
    sock.push = (event, payload) => ws.send(JSON.stringify({ topic, event, payload, ref: String(++sock.ref), join_ref: '1' }));
    sock.wait = (what, pred) => new Promise((res, rej) => {
      const hit = sock.seen.find(pred);
      if (hit) { res(hit); return; }
      const t = setTimeout(() => rej(new Error('Realtime: timed out waiting for ' + what)), 10000);
      sock.waiters.push({ pred, done: (m) => { clearTimeout(t); res(m); } });
    });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); reject(new Error('Realtime: WebSocket refused with HTTP ' + res.statusCode)); });
    ws.on('error', (e) => { clearTimeout(timer); reject(new Error('Realtime: ' + e.message)); });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch (_) { return; }
      if (m.topic === topic && m.event === 'phx_reply' && m.ref === '1') {
        clearTimeout(timer);
        if (m.payload && m.payload.status === 'ok') resolve(sock);
        else { ws.close(); reject(new Error('Realtime: join refused: ' + JSON.stringify(m.payload && m.payload.response))); }
        return;
      }
      sock.seen.push(m);
      sock.waiters = sock.waiters.filter((w) => { if (!w.pred(m)) return true; w.done(m); return false; });
    });
    ws.on('open', () => {
      const payload = { config: { broadcast: { self: false, ack: false }, presence: { key: presenceKey, enabled: true }, postgres_changes: [], private: false } };
      if (withToken) payload.access_token = cfg.supabaseKey;
      ws.send(JSON.stringify({ topic, event: 'phx_join', payload, ref: '1', join_ref: '1' }));
    });
  });
}

async function main() {
  const site = (process.argv[2] || process.env.CLIPSHARE_SITE || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/i.test(site)) {
    console.error('Usage: node live-test.js https://<your-site>.vercel.app');
    process.exitCode = 2;
    return;
  }
  console.log('live test of ' + site);
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL || 'chrome',
    headless: !process.env.HEADED,
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshare-live-'));
  const pageErrors = [];
  const results = [];
  let cfg = null;
  let code = '';
  let qrLink = '';
  let cleared = false;

  async function device(name, extra) {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1000, height: 760 }, ...extra });
    await ctx.addInitScript(fakeClipboard);
    await ctx.addInitScript(presetName, name);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(name + ' console: ' + m.text()); });
    return { name, ctx, page };
  }

  const itemWith = (page, text) => page.locator('#items .item', { hasText: text });
  async function waitLive(page) {
    try {
      await page.waitForSelector('#status[data-state="live"]', { timeout: 20000 });
    } catch (_) {
      const state = await page.getAttribute('#status', 'data-state').catch(() => '?');
      const alert = ((await page.textContent('#alert').catch(() => '')) || '').trim();
      throw new Error('status is "' + state + '" instead of "live"' + (alert ? ': ' + alert : ''));
    }
  }
  async function waitClipText(page, text) {
    await page.waitForFunction(async (t) => {
      const s = await window.__clip.snapshot();
      return !!s && s['text/plain'] === t;
    }, text, { timeout: 15000, polling: 100 });
  }
  async function sendChat(page, text) {
    await page.fill('#message', text);
    await page.press('#message', 'Enter');
  }

  async function step(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true });
      console.log('  PASS  ' + name + ' (' + (Date.now() - t0) + ' ms)');
    } catch (e) {
      results.push({ name, ok: false });
      console.log('  FAIL  ' + name + '\n        ' + String(e && e.message || e).split('\n').slice(0, 4).join('\n        '));
      throw e;
    }
  }

  const A = await device('LiveTest-A');
  const B = await device('LiveTest-B');

  try {
    await step('site loads and has a backend configured', async () => {
      const res = await A.page.goto(site);
      assert.strictEqual(res.status(), 200);
      if (!/default-src 'self'/.test(res.headers()['content-security-policy'] || '')) {
        console.log('        note: no Content-Security-Policy header (the vercel.json headers are not applied)');
      }
      await A.page.waitForSelector('#lobby:not([hidden])');
      cfg = await A.page.evaluate(() => window.CLIPSHARE_CONFIG || null);
      assert.ok(cfg && cfg.supabaseUrl && cfg.supabaseKey, 'config.js has no Supabase URL / key');
      assert.strictEqual(await A.page.isHidden('#config-warning'), true);
      console.log('        backend ' + cfg.supabaseUrl);
    });

    await step('database functions are installed (supabase/setup.sql)', async () => {
      const r = await rpc(cfg, 'clip_list', { p_room: crypto.randomBytes(32).toString('hex'), p_after: -1, p_limit: 1 });
      if (r.status === 404) {
        throw new Error('clip_list was not found. In Supabase open SQL Editor > New query, paste supabase/setup.sql and click Run.');
      }
      if (r.status === 401 || r.status === 403) {
        throw new Error('the backend rejected the API key (HTTP ' + r.status + '): ' + JSON.stringify(r.body));
      }
      assert.strictEqual(r.status, 200, 'HTTP ' + r.status + ': ' + JSON.stringify(r.body));
      assert.deepStrictEqual(r.body, []);
    });

    await step('Realtime: presence and broadcast between two sockets', async () => {
      const topic = 'realtime:clipshare-livetest-' + crypto.randomBytes(8).toString('hex');
      const join = async (key) => {
        try {
          return await rtJoin(cfg, topic, key, true);
        } catch (e) {
          if (!/join refused/.test(e.message)) throw e;
          console.log('        note: join with the key as access_token was refused; the app then joins without it');
          return rtJoin(cfg, topic, key, false);
        }
      };
      const a = await join('a');
      const b = await join('b').catch((e) => { a.ws.close(); throw e; });
      try {
        a.push('presence', { type: 'presence', event: 'track', payload: { d: 'a' } });
        await b.wait('presence', (m) => m.topic === topic &&
          ((m.event === 'presence_diff' && m.payload && m.payload.joins && m.payload.joins.a) ||
           (m.event === 'presence_state' && m.payload && m.payload.a)));
        b.push('broadcast', { type: 'broadcast', event: 'changed', payload: {} });
        await a.wait('broadcast', (m) => m.topic === topic && m.event === 'broadcast' && m.payload && m.payload.event === 'changed');
      } finally {
        a.ws.close();
        b.ws.close();
      }
    });

    await step('host creates a room and goes live', async () => {
      await A.page.click('#create-btn');
      await A.page.waitForSelector('#room:not([hidden])');
      code = (await A.page.textContent('#room-code')).trim();
      assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      console.log('        room ' + code);
      await waitLive(A.page);
      await A.page.waitForSelector('#empty:not([hidden])');
      qrLink = await decodeQr(A.page.locator('#empty-qr svg'));
      assert.strictEqual(qrLink, site + '/#join=' + code);
    });

    await step('joiner enters the code and both computers see each other', async () => {
      await B.page.goto(site);
      await B.page.fill('#join-code', code);
      await B.page.press('#join-code', 'Enter');
      await B.page.waitForSelector('#room:not([hidden])');
      await waitLive(B.page);
      await A.page.waitForFunction(() => /LiveTest-B/.test(document.querySelector('#peers').textContent), null, { timeout: 15000 });
      await B.page.waitForFunction(() => /LiveTest-A/.test(document.querySelector('#peers').textContent), null, { timeout: 15000 });
    });

    for (const [from, to] of [[A, B], [B, A]]) {
      await step('text from ' + from.name + ' arrives on ' + to.name + ', already on its clipboard', async () => {
        const text = 'hello from ' + from.name + ' ' + crypto.randomBytes(4).toString('hex');
        const t0 = Date.now();
        await sendChat(from.page, text);
        await itemWith(to.page, text).waitFor({ timeout: 15000 });
        await waitClipText(to.page, text);
        console.log('        arrived after ' + (Date.now() - t0) + ' ms');
      });
    }

    await step('phone (Pixel 7) opens the scanned QR link, joins and sends text', async () => {
      const P = await device('LiveTest-Phone', devices['Pixel 7']);
      try {
        await P.page.goto(qrLink);
        await P.page.waitForSelector('#room:not([hidden])');
        assert.strictEqual((await P.page.textContent('#room-code')).trim(), code);
        await waitLive(P.page);
        await A.page.waitForFunction(() => /LiveTest-Phone/.test(document.querySelector('#peers').textContent), null, { timeout: 15000 });
        await P.page.waitForFunction(() => document.querySelectorAll('#items .item').length >= 2, null, { timeout: 15000 });
        const text = 'hello from the phone ' + crypto.randomBytes(4).toString('hex');
        await sendChat(P.page, text);
        await itemWith(A.page, text).waitFor({ timeout: 15000 });
        await waitClipText(A.page, text);
        await P.page.click('#leave-btn');
        await P.page.waitForSelector('#lobby:not([hidden])');
      } finally {
        await P.ctx.close();
      }
      await A.page.waitForFunction(() => !/LiveTest-Phone/.test(document.querySelector('#peers').textContent), null, { timeout: 15000 });
    });

    await step('file (2.5 MB, 3 chunks) arrives byte-identical', async () => {
      const data = crypto.randomBytes(2.5 * 1024 * 1024);
      const file = path.join(tmp, 'live-test.bin');
      fs.writeFileSync(file, data);
      const t0 = Date.now();
      const download = B.page.waitForEvent('download', { timeout: 120000 });
      download.catch(() => {});
      await A.page.setInputFiles('#file-input', file);
      const dl = await download;
      assert.strictEqual(dl.suggestedFilename(), 'live-test.bin');
      const saved = path.join(tmp, 'downloaded.bin');
      await dl.saveAs(saved);
      assert.strictEqual(sha256(fs.readFileSync(saved)), sha256(data));
      console.log('        transferred in ' + (Date.now() - t0) + ' ms');
    });

    await step('delete removes the file on both computers', async () => {
      await itemWith(A.page, 'live-test.bin').locator('button', { hasText: 'Delete' }).click();
      await itemWith(A.page, 'live-test.bin').waitFor({ state: 'detached', timeout: 15000 });
      await itemWith(B.page, 'live-test.bin').waitFor({ state: 'detached', timeout: 15000 });
    });

    await step('clear room empties both feeds', async () => {
      A.page.once('dialog', (d) => d.accept());
      await A.page.click('#settings-btn');
      await A.page.click('#clear-btn');
      await A.page.click('#settings button[value="close"]');
      await A.page.waitForFunction(() => document.querySelectorAll('#items .item').length === 0, null, { timeout: 15000 });
      await B.page.waitForFunction(() => document.querySelectorAll('#items .item').length === 0, null, { timeout: 15000 });
      cleared = true;
    });

    await step('no page errors or CSP violations', async () => {
      const relevant = pageErrors.filter((e) => !/Failed to load resource|WebSocket connection to/.test(e));
      assert.deepStrictEqual(relevant, []);
    });
  } finally {
    if (code && cfg && !cleared) {
      // A step failed: don't leave the test room's items behind.
      try {
        const roomId = await A.page.evaluate(async (c) => (await window.ClipCrypto.deriveRoom(c)).roomId, code);
        const r = await rpc(cfg, 'clip_clear', { p_room: roomId });
        console.log('cleanup of room ' + code + ': HTTP ' + r.status + ' ' + JSON.stringify(r.body));
      } catch (e) {
        console.log('cleanup failed (' + e.message + '); the test items expire after 72 hours');
      }
    }
    await browser.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
    if (pageErrors.length) console.log('page errors:\n  ' + pageErrors.join('\n  '));
    process.exitCode = failed ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e && e.message ? '' : e);
  process.exitCode = 1;
});
