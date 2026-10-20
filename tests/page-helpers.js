/*
 * Browser-side helpers shared by e2e.js and live-test.js. Both functions are
 * passed to context.addInitScript(), so they run inside every page before the
 * app and must not reference anything from this Node module.
 */
'use strict';

// An in-memory navigator.clipboard, so tests never touch the real clipboard.
function fakeClipboard() {
  const state = { items: [], writes: 0 };
  class FakeClipboardItem {
    constructor(data) { this._data = Object.assign({}, data); this.types = Object.keys(data); }
    async getType(type) {
      if (!(type in this._data)) throw new DOMException('No ' + type, 'NotFoundError');
      const v = await this._data[type];
      return v instanceof Blob ? v : new Blob([v], { type });
    }
  }
  const textItem = (text) => new FakeClipboardItem({ 'text/plain': new Blob([String(text)], { type: 'text/plain' }) });
  const clipboard = {
    async writeText(text) { state.items = [textItem(text)]; state.writes += 1; },
    async readText() {
      const it = state.items[0];
      return it && it.types.includes('text/plain') ? (await it.getType('text/plain')).text() : '';
    },
    async write(items) {
      const out = [];
      for (const it of items) {
        const data = {};
        for (const t of it.types) data[t] = await it.getType(t);
        out.push(new FakeClipboardItem(data));
      }
      state.items = out;
      state.writes += 1;
    },
    async read() { return state.items.slice(); },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(Navigator.prototype, 'clipboard', { get() { return clipboard; }, configurable: true });
  window.ClipboardItem = FakeClipboardItem;
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
  window.__clip = {
    get writes() { return state.writes; },
    setText(text) { state.items = [textItem(text)]; },
    async snapshot() {
      const it = state.items[0];
      if (!it) return null;
      const out = {};
      for (const t of it.types) {
        const b = await it.getType(t);
        out[t] = t.startsWith('text/') ? await b.text()
          : { size: b.size, sha256: hex(await crypto.subtle.digest('SHA-256', await b.arrayBuffer())) };
      }
      return out;
    },
  };
}

// Device name shown to the other computer (only if none is saved yet).
function presetName(name) {
  try {
    if (!localStorage.getItem('clipshare.settings')) localStorage.setItem('clipshare.settings', JSON.stringify({ deviceName: name }));
  } catch (_) { /* about:blank */ }
}

module.exports = { fakeClipboard, presetName };
