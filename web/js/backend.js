/*
 * PastePort backend client: Supabase RPC + a small Supabase Realtime (Phoenix)
 * client + the room sync logic. No external libraries.
 *
 * Data flow
 *  - Items are stored through the clip_* SQL functions (see supabase/setup.sql).
 *  - Realtime broadcast is only used as a "something changed" ping and for
 *    presence. The source of truth is always clip_list, so nothing is lost if
 *    the WebSocket is blocked: the room simply falls back to polling.
 */
(function (root) {
  'use strict';

  const C = root.ClipCrypto;
  const CHUNK_SIZE = 1024 * 1024;          // plaintext bytes per file chunk
  const MAX_FILE = 50 * 1024 * 1024;       // must match clipshare.limits()
  const MAX_TEXT_B64 = 2 * 1024 * 1024;    // encrypted text payload (chars)
  const PARALLEL = 3;
  const POLL_LIVE_MS = 15000;              // realtime connected
  const POLL_FALLBACK_MS = 3000;           // realtime not available
  const HEARTBEAT_MS = 25000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function randomHex(bytes) {
    return C.toHex(crypto.getRandomValues(new Uint8Array(bytes)));
  }

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter((f) => f !== fn); }
    emit(ev, ...args) {
      for (const fn of (this._h[ev] || []).slice()) {
        try { fn(...args); } catch (e) { console.error(e); }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // RPC (PostgREST)
  // ---------------------------------------------------------------------------
  class RpcError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  class Rpc {
    constructor(url, key) {
      this.url = String(url || '').replace(/\/+$/, '');
      this.key = key || '';
    }

    headers() {
      const h = { 'Content-Type': 'application/json', apikey: this.key };
      // Legacy anon keys are JWTs and go in Authorization as well. The new
      // sb_publishable_ keys must only be sent as "apikey".
      if (this.key.startsWith('eyJ')) h.Authorization = 'Bearer ' + this.key;
      return h;
    }

    async call(fn, args, opts) {
      const o = Object.assign({ timeout: 20000, retries: 0 }, opts);
      for (let attempt = 0; ; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), o.timeout);
        try {
          const res = await fetch(this.url + '/rest/v1/rpc/' + fn, {
            method: 'POST', headers: this.headers(), body: JSON.stringify(args || {}),
            signal: ctrl.signal, cache: 'no-store',
          });
          const text = await res.text();
          let data = null;
          if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
          if (!res.ok) {
            const msg = (data && (data.message || data.error || data.msg)) || ('HTTP ' + res.status);
            const err = new RpcError(msg, res.status, data && data.code);
            // Retry only server/gateway hiccups, never request errors.
            if (attempt < o.retries && (res.status >= 500 || res.status === 429)) {
              await sleep(500 * (attempt + 1));
              continue;
            }
            throw err;
          }
          return data;
        } catch (e) {
          if (e instanceof RpcError) throw e;
          if (attempt < o.retries) { await sleep(500 * (attempt + 1)); continue; }
          const msg = e && e.name === 'AbortError' ? 'Request timed out' : 'Network error: ' + (e && e.message);
          throw new RpcError(msg, 0, 'network');
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Realtime: one Phoenix channel with broadcast + presence (protocol vsn 1.0.0)
  // ---------------------------------------------------------------------------
  class RealtimeChannel extends Emitter {
    constructor(baseUrl, key, topic, presenceKey) {
      super();
      this.wsUrl = baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') +
        '/realtime/v1/websocket?apikey=' + encodeURIComponent(key) + '&vsn=1.0.0';
      this.key = key;
      this.topic = 'realtime:' + topic;
      this.presenceKey = presenceKey;
      this.state = 'closed';                // closed | connecting | joined | error
      this.ws = null;
      this.ref = 0;
      this.joinRef = null;
      this.tries = 0;
      this.stopped = true;
      this.presenceMeta = null;
      this.presence = {};                   // key -> [meta]
      this.pendingHeartbeat = null;
      this.timers = {};
      // supabase-js sends the API key as access_token when nobody is signed in.
      // If the server refuses the join we try the other way on the next attempt.
      this.sendToken = true;
    }

    start() {
      this.stopped = false;
      this._connect();
    }

    stop() {
      this.stopped = true;
      this._clearTimers();
      if (this.ws) {
        try { this.ws.onclose = null; this.ws.close(1000); } catch (_) { /* ignore */ }
        this.ws = null;
      }
      this._setState('closed');
    }

    _setState(s, detail) {
      if (this.state === s) return;
      this.state = s;
      this.emit('state', s, detail);
    }

    _clearTimers() {
      for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); }
      this.timers = {};
    }

    _nextRef() { this.ref += 1; return String(this.ref); }

    _send(msg) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      this.ws.send(JSON.stringify(msg));
      return true;
    }

    _connect() {
      if (this.stopped) return;
      this._clearTimers();
      this._setState('connecting');
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (e) {
        this._scheduleReconnect('WebSocket unavailable');
        return;
      }
      this.ws = ws;
      this.timers.connect = setTimeout(() => { try { ws.close(); } catch (_) { /* ignore */ } }, 15000);
      ws.onopen = () => {
        clearTimeout(this.timers.connect);
        this.pendingHeartbeat = null;
        this.timers.hb = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
        this._join();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        this._onMessage(msg);
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this._scheduleReconnect('connection closed');
      };
    }

    _scheduleReconnect(reason) {
      this._clearTimers();
      this.presence = {};
      this.emit('presence', this.presence);
      if (this.stopped) { this._setState('closed'); return; }
      this._setState('error', reason);
      const delays = [1000, 2000, 5000, 10000, 20000, 30000];
      const delay = delays[Math.min(this.tries, delays.length - 1)];
      this.tries += 1;
      this.timers.reconnect = setTimeout(() => this._connect(), delay);
    }

    _heartbeat() {
      if (this.pendingHeartbeat) {
        // Previous heartbeat never answered: the connection is dead.
        this.pendingHeartbeat = null;
        try { this.ws && this.ws.close(); } catch (_) { /* ignore */ }
        return;
      }
      this.pendingHeartbeat = this._nextRef();
      this._send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: this.pendingHeartbeat });
    }

    _join() {
      this.joinRef = this._nextRef();
      const payload = {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: this.presenceKey, enabled: true },
          postgres_changes: [],
          private: false,
        },
      };
      if (this.sendToken) payload.access_token = this.key;
      this._send({ topic: this.topic, event: 'phx_join', payload, ref: this.joinRef, join_ref: this.joinRef });
      this.timers.join = setTimeout(() => {
        if (this.state !== 'joined') { try { this.ws && this.ws.close(); } catch (_) { /* ignore */ } }
      }, 15000);
    }

    _onMessage(msg) {
      if (msg.topic === 'phoenix') {
        if (msg.event === 'phx_reply' && msg.ref === this.pendingHeartbeat) this.pendingHeartbeat = null;
        return;
      }
      if (msg.topic !== this.topic) return;
      switch (msg.event) {
        case 'phx_reply':
          if (msg.ref === this.joinRef) {
            clearTimeout(this.timers.join);
            const status = msg.payload && msg.payload.status;
            if (status === 'ok') {
              this.tries = 0;
              this._setState('joined');
              if (this.presenceMeta) this._sendTrack();
            } else {
              const resp = msg.payload && msg.payload.response;
              const reason = (resp && (resp.reason || resp.message)) || 'join refused';
              this.sendToken = !this.sendToken;
              this.emit('joinError', reason);
              try { this.ws && this.ws.close(); } catch (_) { /* ignore */ }
            }
          }
          break;
        case 'phx_error':
        case 'phx_close':
          if (msg.join_ref && msg.join_ref !== this.joinRef) break;
          try { this.ws && this.ws.close(); } catch (_) { /* ignore */ }
          break;
        case 'broadcast':
          if (msg.payload) this.emit('broadcast', msg.payload.event, msg.payload.payload);
          break;
        case 'presence_state':
          this.presence = {};
          this._applyPresence(msg.payload || {}, {});
          break;
        case 'presence_diff':
          this._applyPresence((msg.payload && msg.payload.joins) || {}, (msg.payload && msg.payload.leaves) || {});
          break;
        default:
          break;
      }
    }

    _applyPresence(joins, leaves) {
      for (const key of Object.keys(joins)) {
        const metas = (joins[key] && joins[key].metas) || [];
        const cur = (this.presence[key] || []).filter((m) => !metas.some((n) => n.phx_ref === m.phx_ref));
        this.presence[key] = cur.concat(metas);
      }
      for (const key of Object.keys(leaves)) {
        const gone = ((leaves[key] && leaves[key].metas) || []).map((m) => m.phx_ref);
        const rest = (this.presence[key] || []).filter((m) => gone.indexOf(m.phx_ref) < 0);
        if (rest.length) this.presence[key] = rest; else delete this.presence[key];
      }
      this.emit('presence', this.presence);
    }

    track(meta) {
      this.presenceMeta = meta;
      if (this.state === 'joined') this._sendTrack();
    }

    _sendTrack() {
      this._send({
        topic: this.topic, event: 'presence',
        payload: { type: 'presence', event: 'track', payload: this.presenceMeta },
        ref: this._nextRef(), join_ref: this.joinRef,
      });
    }

    broadcast(event, payload) {
      if (this.state !== 'joined') return false;
      return this._send({
        topic: this.topic, event: 'broadcast',
        payload: { type: 'broadcast', event, payload },
        ref: this._nextRef(), join_ref: this.joinRef,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Room
  // ---------------------------------------------------------------------------
  async function mapLimit(count, limit, fn) {
    let next = 0;
    const workers = [];
    for (let w = 0; w < Math.min(limit, count); w++) {
      workers.push((async () => {
        while (next < count) {
          const i = next++;
          await fn(i);
        }
      })());
    }
    await Promise.all(workers);
  }

  class Room extends Emitter {
    /**
     * opts: { url, key, code, deviceId, deviceName, client: 'web' }
     */
    constructor(opts) {
      super();
      this.opts = opts;
      this.rpc = new Rpc(opts.url, opts.key);
      this.items = new Map();              // id -> item
      this.keys = null;
      this.roomId = null;
      this.code = C.normalizeCode(opts.code);
      this.deviceId = opts.deviceId;
      this.deviceName = opts.deviceName || 'Device';
      this.cursor = 0;                     // highest seq seen from clip_list
      this.syncing = null;
      this.syncAgain = false;
      this.loaded = false;
      this.closed = false;
      this.peers = [];
      this.rt = null;
      this.pollTimer = null;
      this.blobCache = new Map();          // id -> Blob (decrypted)
      this.blobCacheBytes = 0;
      this.lastError = null;
    }

    get connection() {
      if (this.lastError) return 'offline';
      if (!this.loaded) return 'connecting';
      return this.rt && this.rt.state === 'joined' ? 'live' : 'polling';
    }

    async open() {
      this.keys = await C.deriveRoom(this.code);
      this.roomId = this.keys.roomId;
      try {
        await this.sync();
      } catch (_) {
        // Offline or backend unreachable: polling below keeps retrying.
      }
      if (this.closed) return;
      this.rt = new RealtimeChannel(this.opts.url, this.opts.key, 'clipshare-' + this.roomId, this.deviceId);
      this.rt.on('state', (s) => {
        this.emit('connection', this.connection);
        if (s === 'joined') this.sync().catch(() => {});
        this._schedulePoll();
      });
      this.rt.on('broadcast', (event) => {
        if (event === 'changed') this.sync().catch(() => {});
        if (event === 'hello') this.sync().catch(() => {});
      });
      this.rt.on('presence', (p) => { this._updatePeers(p).catch(() => {}); });
      this.rt.on('joinError', (reason) => { this.emit('notice', 'Realtime unavailable (' + reason + '), using polling'); });
      const meta = { d: this.deviceId, n: await C.encryptJson(this.keys, { name: this.deviceName, client: this.opts.client || 'web' }, 'presence') };
      this.rt.track(meta);
      this.rt.start();
      this._schedulePoll();
    }

    close() {
      this.closed = true;
      if (this.rt) this.rt.stop();
      clearTimeout(this.pollTimer);
      this.blobCache.clear();
      this.blobCacheBytes = 0;
    }

    async setDeviceName(name) {
      this.deviceName = name;
      if (this.rt && this.keys) {
        this.rt.track({ d: this.deviceId, n: await C.encryptJson(this.keys, { name, client: this.opts.client || 'web' }, 'presence') });
      }
    }

    async _updatePeers(presence) {
      const peers = [];
      for (const key of Object.keys(presence)) {
        for (const m of presence[key]) {
          if (!m || typeof m.n !== 'string') continue;
          let info = null;
          try { info = await C.decryptJson(this.keys, m.n, 'presence'); } catch (_) { continue; }
          peers.push({ id: m.d || key, name: String(info.name || 'Device'), client: info.client || 'web', self: (m.d || key) === this.deviceId });
        }
      }
      // One entry per device (a device may have several tabs open).
      const seen = new Map();
      for (const p of peers) {
        const prev = seen.get(p.id);
        if (!prev) seen.set(p.id, Object.assign({ count: 1 }, p));
        else prev.count += 1;
      }
      this.peers = Array.from(seen.values());
      this.emit('peers', this.peers);
    }

    _schedulePoll(force) {
      if (this.closed) return;
      const live = this.rt && this.rt.state === 'joined';
      const due = Date.now() + (live ? POLL_LIVE_MS : POLL_FALLBACK_MS);
      // Only move the next poll earlier, so reconnect attempts can't starve it.
      if (!force && this.pollTimer && this.pollDue <= due) return;
      clearTimeout(this.pollTimer);
      this.pollDue = due;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.sync().catch(() => {}).finally(() => this._schedulePoll(true));
      }, due - Date.now());
    }

    /**
     * Fetch changes. The first call loads a snapshot of the newest items; after
     * that we ask for everything after the highest sequence number seen
     * (including deletions). The server serialises changes per room, so a
     * lower number can never appear after a higher one.
     */
    sync() {
      if (this.syncing) { this.syncAgain = true; return this.syncing; }
      this.syncing = (async () => {
        try {
          do {
            this.syncAgain = false;
            await this._syncOnce();
          } while (this.syncAgain && !this.closed);
          if (this.lastError) { this.lastError = null; this.emit('connection', this.connection); }
        } catch (e) {
          const changed = !this.lastError;
          this.lastError = e;
          if (changed) this.emit('connection', this.connection);
          this.emit('syncError', e);
          throw e;
        } finally {
          this.syncing = null;
        }
      })();
      return this.syncing;
    }

    async _syncOnce() {
      const live = this.loaded;
      if (!this.loaded) {
        const rows = await this.rpc.call('clip_list', { p_room: this.roomId, p_after: -1, p_limit: 200 }, { retries: 1 });
        if (this.closed) return;
        for (const row of rows || []) {
          this.cursor = Math.max(this.cursor, Number(row.seq) || 0);
          await this._applyRow(row, false);
        }
        this.loaded = true;
        this.emit('loaded');
        this.emit('connection', this.connection);
        return;
      }
      for (let page = 0; page < 50; page++) {
        const rows = await this.rpc.call('clip_list', { p_room: this.roomId, p_after: this.cursor, p_limit: 200 }, { retries: 1 });
        if (this.closed) return;
        for (const row of rows || []) {
          this.cursor = Math.max(this.cursor, Number(row.seq) || 0);
          await this._applyRow(row, live);
        }
        if (!rows || rows.length < 200) break;
      }
    }

    async _applyRow(row, live) {
      if (row.deleted) {
        if (this.items.has(row.id)) {
          this.items.delete(row.id);
          this._dropBlob(row.id);
          this.emit('remove', row.id);
        }
        return;
      }
      if (this.items.has(row.id)) return;
      let item;
      try {
        item = await this._decodeRow(row);
      } catch (e) {
        return;   // not ours / corrupted: ignore
      }
      if (this.items.has(row.id)) return;
      item.live = live && !item.mine;
      this.items.set(item.id, item);
      this.emit('add', item);
    }

    async _decodeRow(row) {
      const aad = row.kind === 'text' ? 'text' : 'meta';
      const p = await C.decryptJson(this.keys, row.payload, aad);
      if (!p || p.v !== 1) throw new Error('unsupported item');
      return {
        id: row.id,
        seq: Number(row.seq),
        createdAt: Date.parse(row.created_at) || Date.now(),
        sender: row.sender,
        mine: row.sender === this.deviceId,
        kind: row.kind,
        t: p.t || (row.kind === 'text' ? 'text' : 'file'),
        from: String(p.from || 'Device'),
        src: p.src || '',
        text: typeof p.text === 'string' ? p.text : '',
        html: typeof p.html === 'string' ? p.html : '',
        rtf: typeof p.rtf === 'string' ? p.rtf : '',
        name: String(p.name || 'file'),
        mime: String(p.mime || 'application/octet-stream'),
        size: Number(p.size) || 0,
        chunks: Number(row.chunks) || 0,
        g: p.g || '',
        gn: Number(p.gn) || 0,
      };
    }

    _addLocal(item) {
      if (this.items.has(item.id)) return this.items.get(item.id);
      this.items.set(item.id, item);
      this.emit('add', item);
      return item;
    }

    _ping() {
      if (this.rt) this.rt.broadcast('changed', { at: Date.now() });
    }

    /** Send text. fields: {text, html?, rtf?, src?} */
    async sendText(fields) {
      const body = {
        v: 1, t: 'text', from: this.deviceName, src: fields.src || 'chat',
        text: String(fields.text || ''),
      };
      if (fields.html) body.html = String(fields.html);
      if (fields.rtf) body.rtf = String(fields.rtf);
      let payload = await C.encryptJson(this.keys, body, 'text');
      if (payload.length > MAX_TEXT_B64 && (body.html || body.rtf)) {
        delete body.html; delete body.rtf;
        payload = await C.encryptJson(this.keys, body, 'text');
      }
      if (payload.length > MAX_TEXT_B64) {
        // Very long text: send it as a .txt file instead.
        const blob = new Blob([body.text], { type: 'text/plain' });
        return this.sendFile(blob, { name: 'text-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt', src: body.src });
      }
      const r = await this.rpc.call('clip_push', { p_room: this.roomId, p_sender: this.deviceId, p_payload: payload });
      const item = this._addLocal({
        id: r.id, seq: Number(r.seq), createdAt: Date.parse(r.created_at) || Date.now(),
        sender: this.deviceId, mine: true, kind: 'text', t: 'text', from: this.deviceName, src: body.src,
        text: body.text, html: body.html || '', rtf: body.rtf || '', name: '', mime: 'text/plain', size: 0, chunks: 0, g: '', gn: 0,
        live: false,
      });
      this._ping();
      return item;
    }

    /**
     * Upload a Blob/File. meta: {name, mime?, src?, g?, gn?}
     * onProgress(fraction 0..1)
     */
    async sendFile(blob, meta, onProgress) {
      meta = meta || {};
      const size = blob.size;
      if (size > MAX_FILE) throw new Error('File is too large (max ' + (MAX_FILE / 1048576) + ' MB)');
      const mime = meta.mime || blob.type || 'application/octet-stream';
      const t = meta.t || (/^image\//.test(mime) ? 'image' : 'file');
      const chunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
      const body = { v: 1, t, from: this.deviceName, src: meta.src || 'drop', name: meta.name || blob.name || 'file', mime, size };
      if (meta.g) { body.g = meta.g; body.gn = meta.gn || 1; }
      const payload = await C.encryptJson(this.keys, body, 'meta');
      const begin = await this.rpc.call('clip_file_begin', {
        p_room: this.roomId, p_sender: this.deviceId, p_payload: payload, p_size: size, p_chunks: chunks,
      });
      const id = begin.id;
      let done = 0;
      if (onProgress) onProgress(0);
      try {
        await mapLimit(chunks, PARALLEL, async (idx) => {
          const part = new Uint8Array(await blob.slice(idx * CHUNK_SIZE, Math.min(size, (idx + 1) * CHUNK_SIZE)).arrayBuffer());
          const enc = await C.encryptBytes(this.keys, part, 'chunk:' + id + ':' + idx + ':' + chunks);
          await this.rpc.call('clip_file_chunk', { p_room: this.roomId, p_id: id, p_idx: idx, p_data: C.bytesToBase64(enc) },
            { timeout: 60000, retries: 3 });
          done += 1;
          if (onProgress) onProgress(done / chunks);
        });
        const fin = await this.rpc.call('clip_file_finish', { p_room: this.roomId, p_id: id }, { retries: 2 });
        this._cacheBlob(id, blob.type === mime ? blob : new Blob([blob], { type: mime }));
        const item = this._addLocal({
          id, seq: Number(fin.seq), createdAt: Date.parse(fin.created_at) || Date.now(),
          sender: this.deviceId, mine: true, kind: 'blob', t, from: this.deviceName, src: body.src,
          text: '', html: '', rtf: '', name: body.name, mime, size, chunks, g: body.g || '', gn: body.gn || 0, live: false,
        });
        this._ping();
        return item;
      } catch (e) {
        this.rpc.call('clip_delete', { p_room: this.roomId, p_id: id }).catch(() => {});
        throw e;
      }
    }

    /** Download and decrypt a file item. Returns a Blob. */
    async getBlob(item, onProgress) {
      const cached = this.blobCache.get(item.id);
      if (cached) return cached;
      if (item.kind !== 'blob') throw new Error('Not a file');
      const parts = new Array(item.chunks);
      let done = 0;
      await mapLimit(item.chunks, PARALLEL, async (idx) => {
        const b64 = await this.rpc.call('clip_file_get', { p_room: this.roomId, p_id: item.id, p_idx: idx }, { timeout: 60000, retries: 3 });
        parts[idx] = await C.decryptBytes(this.keys, C.base64ToBytes(b64), 'chunk:' + item.id + ':' + idx + ':' + item.chunks);
        done += 1;
        if (onProgress) onProgress(done / item.chunks);
      });
      const blob = new Blob(parts, { type: item.mime || 'application/octet-stream' });
      this._cacheBlob(item.id, blob);
      return blob;
    }

    _cacheBlob(id, blob) {
      const LIMIT = 200 * 1024 * 1024;
      if (blob.size > LIMIT) return;
      this._dropBlob(id);
      this.blobCache.set(id, blob);
      this.blobCacheBytes += blob.size;
      for (const [k, b] of this.blobCache) {
        if (this.blobCacheBytes <= LIMIT) break;
        this.blobCache.delete(k);
        this.blobCacheBytes -= b.size;
      }
    }

    _dropBlob(id) {
      const b = this.blobCache.get(id);
      if (b) { this.blobCache.delete(id); this.blobCacheBytes -= b.size; }
    }

    async deleteItem(id) {
      await this.rpc.call('clip_delete', { p_room: this.roomId, p_id: id }, { retries: 1 });
      if (this.items.delete(id)) { this._dropBlob(id); this.emit('remove', id); }
      this._ping();
    }

    async clearAll() {
      await this.rpc.call('clip_clear', { p_room: this.roomId });
      for (const id of Array.from(this.items.keys())) {
        this.items.delete(id);
        this._dropBlob(id);
        this.emit('remove', id);
      }
      this._ping();
    }
  }

  root.ClipBackend = { Rpc, RpcError, RealtimeChannel, Room, randomHex, CHUNK_SIZE, MAX_FILE };
})(typeof window !== 'undefined' ? window : globalThis);
