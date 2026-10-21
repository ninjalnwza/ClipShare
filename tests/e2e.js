/*
 * End-to-end test: two browser "computers" talk through the mock backend.
 * Uses the system Chrome via playwright-core and a fake in-page clipboard, so
 * the real clipboard is never touched.
 *
 *   node e2e.js            (HEADED=1 to watch, PW_CHANNEL=msedge to use Edge)
 *   node e2e.js --pg       same, but the backend is the real supabase/setup.sql
 *                          running in PGlite instead of the in-memory copy
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, devices } = require('playwright-core');
const { createMockServer } = require('./mock-server');
const { fakeClipboard, presetName } = require('./page-helpers');
const { decodeQr } = require('./qr-decode');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pg = process.argv.includes('--pg');
  const server = createMockServer({ pg });
  const { url } = await server.listen(0);
  console.log('mock server (' + (pg ? 'setup.sql in PGlite' : 'in-memory backend') + ') at ' + url);
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL || 'chrome',
    headless: !process.env.HEADED,
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshare-e2e-'));
  const pageErrors = [];
  const results = [];

  async function device(name, extra) {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1000, height: 760 }, ...extra });
    await ctx.addInitScript(fakeClipboard);
    await ctx.addInitScript(presetName, name);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(name + ' console: ' + m.text()); });
    return { name, ctx, page };
  }

  const clip = (page) => page.evaluate(() => window.__clip.snapshot());
  const clipWrites = (page) => page.evaluate(() => window.__clip.writes);
  const itemWith = (page, text) => page.locator('#items .item', { hasText: text });
  const itemCount = (page) => page.locator('#items .item').count();
  const waitStatus = (page, s, timeout) => page.waitForSelector('#status[data-state="' + s + '"]', { timeout: timeout || 15000 });
  async function waitClipText(page, text, timeout) {
    await page.waitForFunction(async (t) => {
      const s = await window.__clip.snapshot();
      return !!s && s['text/plain'] === t;
    }, text, { timeout: timeout || 10000, polling: 100 });
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
      console.log('  FAIL  ' + name + '\n        ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n        '));
      throw e;
    }
  }

  const A = await device('PC-A');
  const B = await device('PC-B');
  let code = '';
  let qrLink = '';

  try {
    await step('lobby loads with backend configured, under the vercel.json CSP', async () => {
      const res = await A.page.goto(url);
      assert.match(res.headers()['content-security-policy'] || '', /default-src 'self'/);
      await A.page.waitForSelector('#lobby:not([hidden])');
      assert.strictEqual(await A.page.isHidden('#config-warning'), true);
    });

    await step('host creates a room and goes live', async () => {
      await A.page.click('#create-btn');
      await A.page.waitForSelector('#room:not([hidden])');
      code = (await A.page.textContent('#room-code')).trim();
      assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      await waitStatus(A.page, 'live');
      await A.page.waitForSelector('#empty:not([hidden])');
      assert.strictEqual((await A.page.textContent('#empty-code')).trim(), code);
      assert.match(await A.page.textContent('#peers'), /Waiting for the other computer/);
      qrLink = await decodeQr(A.page.locator('#empty-qr svg'));
      assert.strictEqual(qrLink, url + '/#join=' + code);
    });

    await step('joiner enters the code (lowercase, no dash) and both see each other', async () => {
      await B.page.goto(url);
      await B.page.fill('#join-code', code.replace('-', '').toLowerCase());
      assert.strictEqual(await B.page.inputValue('#join-code'), code);
      await B.page.press('#join-code', 'Enter');
      await B.page.waitForSelector('#room:not([hidden])');
      assert.strictEqual((await B.page.textContent('#room-code')).trim(), code);
      await waitStatus(B.page, 'live');
      await A.page.waitForFunction(() => /PC-B/.test(document.querySelector('#peers').textContent));
      await B.page.waitForFunction(() => /PC-A/.test(document.querySelector('#peers').textContent));
    });

    await step('chat text arrives and is auto-copied', async () => {
      await sendChat(B.page, 'hello from B');
      await itemWith(B.page, 'hello from B').waitFor();
      assert.strictEqual(await B.page.inputValue('#message'), '');
      assert.ok(await itemWith(B.page, 'hello from B').evaluate((n) => n.classList.contains('mine')));
      await itemWith(A.page, 'hello from B').waitFor({ timeout: 5000 });
      await waitClipText(A.page, 'hello from B');
      assert.ok(!(await itemWith(A.page, 'hello from B').evaluate((n) => n.classList.contains('mine'))));
    });

    await step('phone (Pixel 7, dark mode) opens the scanned QR link, joins and sends text', async () => {
      const P = await device('Phone', { ...devices['Pixel 7'], colorScheme: 'dark' });
      await P.page.goto(qrLink);
      await P.page.waitForSelector('#room:not([hidden])');
      assert.strictEqual((await P.page.textContent('#room-code')).trim(), code);
      await waitStatus(P.page, 'live');
      await A.page.waitForFunction(() => /Phone/.test(document.querySelector('#peers').textContent));
      await itemWith(P.page, 'hello from B').waitFor({ timeout: 5000 });
      assert.ok(await P.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page scrolls sideways');
      assert.ok((await P.page.locator('.topbar').boundingBox()).height < 60, 'top bar wraps onto two lines');
      await P.page.setViewportSize({ width: 360, height: 760 });
      assert.ok(await P.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page scrolls sideways at 360 px');
      assert.ok((await P.page.locator('.topbar').boundingBox()).height < 60, 'top bar wraps onto two lines at 360 px');
      assert.ok(await P.page.isVisible('#invite-btn'));
      assert.ok(await P.page.isHidden('#invite-btn .btn-label'));
      await sendChat(P.page, 'sent from the phone');
      await itemWith(A.page, 'sent from the phone').waitFor({ timeout: 5000 });
      await waitClipText(A.page, 'sent from the phone');
      await P.page.click('#invite-btn');
      await P.page.waitForSelector('#invite[open]');
      assert.strictEqual(await decodeQr(P.page.locator('#invite-qr svg')), qrLink);
      await P.page.click('#invite button[value="close"]');
      await P.page.waitForSelector('#invite', { state: 'hidden' });
      await P.page.click('#leave-btn');
      await P.page.waitForSelector('#lobby:not([hidden])');
      await P.ctx.close();
      await A.page.waitForFunction(() => !/Phone/.test(document.querySelector('#peers').textContent));
    });

    await step('Invite button shows the code and QR code; Copy invite link copies the link', async () => {
      await A.page.click('#invite-btn');
      await A.page.waitForSelector('#invite[open]');
      assert.strictEqual((await A.page.textContent('#invite-code')).trim(), code);
      assert.strictEqual(await decodeQr(A.page.locator('#invite-qr svg')), qrLink);
      await A.page.click('#invite-copy-link');
      await waitClipText(A.page, qrLink);
      await A.page.waitForFunction(() => document.querySelector('#invite-copy-link').textContent === 'Copied');
      await A.page.mouse.click(5, 5);
      await A.page.waitForSelector('#invite', { state: 'hidden' });
    });

    await step('Ctrl+V on the page sends rich text; receiver gets text + html, page shows plain text', async () => {
      await A.page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'Formatted text');
        dt.setData('text/html', '<b>Formatted</b> <img src=x onerror="window.__xss=1"> text');
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await itemWith(B.page, 'Formatted text').waitFor({ timeout: 5000 });
      await waitClipText(B.page, 'Formatted text');
      const snap = await clip(B.page);
      assert.match(snap['text/html'], /<b>Formatted<\/b>/);
      assert.strictEqual(await B.page.locator('#items b, #items img').count(), 0);
      assert.strictEqual(await B.page.evaluate(() => window.__xss), undefined);
    });

    await step('file (2.5 MB, 3 chunks) is uploaded, auto-downloaded and byte-identical', async () => {
      const data = crypto.randomBytes(2.5 * 1024 * 1024);
      const file = path.join(tmp, 'report.bin');
      fs.writeFileSync(file, data);
      const dlPromise = B.page.waitForEvent('download', { timeout: 30000 });
      await A.page.setInputFiles('#file-input', file);
      const dl = await dlPromise;
      assert.strictEqual(dl.suggestedFilename(), 'report.bin');
      const saved = path.join(tmp, 'downloaded.bin');
      await dl.saveAs(saved);
      assert.strictEqual(sha256(fs.readFileSync(saved)), sha256(data));
      await itemWith(A.page, 'report.bin').waitFor();
      assert.strictEqual(await A.page.locator('#uploads > *').count(), 0);
      assert.match(await itemWith(B.page, 'report.bin').textContent(), /2\.5 MB/);
    });

    await step('pasted screenshot shows a preview and lands on the other clipboard as PNG', async () => {
      const pngSha = await B.page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 48;
        const g = c.getContext('2d');
        g.fillStyle = '#e11d48'; g.fillRect(0, 0, 64, 48);
        g.fillStyle = '#fff'; g.fillRect(8, 8, 20, 20);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, '0')).join('');
      });
      const img = A.page.locator('#items img.preview').last();
      await img.waitFor({ timeout: 10000 });
      assert.match(await img.getAttribute('alt'), /^clipboard-\d{8}-\d{6}\.png$/);
      await A.page.waitForFunction(() => {
        const i = document.querySelectorAll('#items img.preview');
        return i.length && i[i.length - 1].complete && i[i.length - 1].naturalWidth === 64;
      });
      await A.page.waitForFunction(async () => {
        const s = await window.__clip.snapshot();
        return !!(s && s['image/png']);
      }, null, { timeout: 10000 });
      assert.strictEqual((await clip(A.page))['image/png'].sha256, pngSha);
    });

    await step('delete removes the item on both computers', async () => {
      await itemWith(A.page, 'hello from B').locator('button', { hasText: 'Delete' }).click();
      await itemWith(A.page, 'hello from B').waitFor({ state: 'detached', timeout: 5000 });
      await itemWith(B.page, 'hello from B').waitFor({ state: 'detached', timeout: 5000 });
    });

    await step('window in background: banner + title, copied when the window gets focus', async () => {
      await B.page.evaluate(() => { document.hasFocus = () => false; });
      const before = await clipWrites(B.page);
      await sendChat(A.page, 'while you were away');
      await B.page.waitForSelector('#pending-banner:not([hidden])', { timeout: 5000 });
      assert.match(await B.page.title(), /^\(1\)/);
      assert.strictEqual(await clipWrites(B.page), before);
      await B.page.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); });
      await waitClipText(B.page, 'while you were away');
      await B.page.waitForSelector('#pending-banner', { state: 'hidden' });
      assert.strictEqual(await B.page.title(), 'PastePort');
    });

    await step('auto-send clipboard on focus, without echoing received items back', async () => {
      await B.page.click('#settings-btn');
      await B.page.check('#opt-autosend');
      await B.page.waitForTimeout(200);
      assert.strictEqual(await B.page.isChecked('#opt-autosend'), true);
      await B.page.click('#settings button[value="close"]');
      // Clipboard content that was already there when enabling is not sent.
      await B.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(700);
      assert.strictEqual(await itemWith(A.page, 'while you were away').count(), 1);
      // New clipboard content is sent on focus.
      await B.page.evaluate(() => { window.__clip.setText('copied on B'); window.dispatchEvent(new Event('focus')); });
      await itemWith(A.page, 'copied on B').waitFor({ timeout: 5000 });
      assert.match(await itemWith(A.page, 'copied on B').textContent(), /clipboard/);
      await waitClipText(A.page, 'copied on B');
      // Items received from A are auto-copied on B but must not bounce back.
      await sendChat(A.page, 'echo test');
      await waitClipText(B.page, 'echo test');
      await B.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(1000);
      assert.strictEqual(await itemWith(A.page, 'echo test').count(), 1);
      assert.strictEqual(await itemWith(B.page, 'echo test').count(), 1);
    });

    await step('long text is truncated with "Show all"', async () => {
      const long = 'L'.repeat(1400) + ' END-OF-PREVIEW ' + 'x'.repeat(2000) + ' THE-REAL-END';
      await A.page.fill('#message', long);
      await A.page.click('#send-btn');
      const item = itemWith(B.page, 'END-OF-PREVIEW');
      await item.waitFor({ timeout: 5000 });
      assert.doesNotMatch(await item.textContent(), /THE-REAL-END/);
      await item.locator('button', { hasText: 'Show all' }).click();
      assert.match(await item.textContent(), /THE-REAL-END/);
      await waitClipText(B.page, long);
    });

    await step('WebSocket blocked: falls back to polling, then recovers to live', async () => {
      server.setWsEnabled(false);
      await waitStatus(A.page, 'polling', 10000);
      await waitStatus(B.page, 'polling', 10000);
      assert.match(await B.page.textContent('#peers'), /Online status unavailable/);
      await sendChat(A.page, 'sent while polling');
      await itemWith(B.page, 'sent while polling').waitFor({ timeout: 10000 });
      server.setWsEnabled(true);
      await waitStatus(A.page, 'live', 45000);
      await waitStatus(B.page, 'live', 45000);
      await B.page.waitForFunction(() => /PC-A/.test(document.querySelector('#peers').textContent), null, { timeout: 10000 });
    });

    await step('reload restores the room and history without auto-copying old items', async () => {
      const count = await itemCount(B.page);
      await B.page.reload();
      await B.page.waitForSelector('#room:not([hidden])');
      await waitStatus(B.page, 'live');
      await B.page.waitForFunction((n) => document.querySelectorAll('#items .item').length === n, count, { timeout: 5000 });
      await sleep(500);
      assert.strictEqual(await clipWrites(B.page), 0);
      assert.strictEqual(await B.page.isHidden('#empty'), true);
    });

    await step('invite link joins the room; other rooms are isolated', async () => {
      const C = await device('PC-C');
      await C.page.goto(url + '/#join=' + code);
      await C.page.waitForSelector('#room:not([hidden])');
      assert.strictEqual(C.page.url().includes('#'), false);
      await itemWith(C.page, 'copied on B').waitFor({ timeout: 5000 });
      await A.page.waitForFunction(() => /PC-C/.test(document.querySelector('#peers').textContent));
      await C.page.click('#leave-btn');
      await C.page.waitForSelector('#lobby:not([hidden])');
      assert.match(await C.page.textContent('#recent-list'), new RegExp(code));
      await A.page.waitForFunction(() => !/PC-C/.test(document.querySelector('#peers').textContent));
      await C.page.click('#create-btn');
      await C.page.waitForSelector('#empty:not([hidden])');
      assert.strictEqual(await itemCount(C.page), 0);
      await C.ctx.close();
    });

    await step('realtime join without access_token when the server refuses the key as a token', async () => {
      await fetch(url + '/__mock/config?rejectAccessToken=1');
      const D = await device('PC-D');
      await D.page.goto(url + '/#join=' + code);
      await waitStatus(D.page, 'live', 15000);
      await A.page.waitForFunction(() => /PC-D/.test(document.querySelector('#peers').textContent));
      await D.ctx.close();
      await fetch(url + '/__mock/config?rejectAccessToken=0');
    });

    await step('server error on upload shows a retry button that works', async () => {
      await fetch(url + '/__mock/fail?fn=clip_file_finish&status=400&count=1');
      const file = path.join(tmp, 'notes.txt');
      fs.writeFileSync(file, 'some notes');
      await A.page.setInputFiles('#file-input', file);
      const failed = A.page.locator('#uploads .item.failed');
      await failed.waitFor({ timeout: 5000 });
      await failed.locator('button', { hasText: 'Retry' }).click();
      await itemWith(B.page, 'notes.txt').waitFor({ timeout: 5000 });
      assert.strictEqual(await A.page.locator('#uploads > *').count(), 0);
    });

    await step('clear room empties both feeds', async () => {
      A.page.once('dialog', (d) => d.accept());
      await A.page.click('#settings-btn');
      await A.page.click('#clear-btn');
      await A.page.click('#settings button[value="close"]');
      await A.page.waitForFunction(() => document.querySelectorAll('#items .item').length === 0);
      await A.page.waitForSelector('#empty:not([hidden])');
      await B.page.waitForFunction(() => document.querySelectorAll('#items .item').length === 0, null, { timeout: 5000 });
    });

    await step('no page errors or CSP violations', async () => {
      const relevant = pageErrors.filter((e) => !/Failed to load resource|WebSocket connection to/.test(e));
      assert.deepStrictEqual(relevant, []);
    });
  } finally {
    await browser.close().catch(() => {});
    await server.close();
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
