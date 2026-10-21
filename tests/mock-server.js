/*
 * Local stand-in for Supabase, used by the automated tests and for trying the
 * app without a Supabase project:
 *   - serves ../web (and a generated config.js pointing at this server) with
 *     the response headers from ../vercel.json, including the CSP
 *   - POST /rest/v1/rpc/clip_*  : in-memory copy of supabase/setup.sql, or with
 *                                 --pg the real setup.sql running in PGlite
 *   - WS   /realtime/v1/websocket: Phoenix channel protocol (vsn 1.0.0) with
 *                                  broadcast + presence, like Supabase Realtime
 *   - /__mock/*                 : test controls
 *
 * Run: node mock-server.js [port] [--pg]     (binds to 127.0.0.1 only)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb, Rest } = require('./pg');

const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const VERCEL_JSON = path.resolve(__dirname, '..', 'vercel.json');
const MOCK_KEY = 'sb_publishable_mock_key';
const LIMITS = {
  maxText: 2 * 1024 * 1024,
  maxFile: 50 * 1024 * 1024,
  chunkMax: 1024 * 1024 + 4096,
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PgError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// The response headers from vercel.json (CSP etc.), so the app is tested under
// the same policy as the deployed site. Supports the subset of Vercel's
// "source" syntax used there: literal paths and "(.*)".
function loadSiteHeaders() {
  if (!fs.existsSync(VERCEL_JSON)) return [];
  const conf = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
  return (conf.headers || []).map((rule) => ({
    re: new RegExp('^' + rule.source.split('(.*)').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'),
    headers: rule.headers,
  }));
}
const SITE_HEADERS = loadSiteHeaders();

function siteHeaders(pathname, extra) {
  const out = {};
  for (const rule of SITE_HEADERS) {
    if (rule.re.test(pathname)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return Object.assign(out, extra);
}

function pgTimestamp(date) {
  // Same shape as Postgres to_jsonb(timestamptz): 2026-01-02T03:04:05.123456+00:00
  return date.toISOString().replace(/\.(\d{3})Z$/, (_, ms) => '.' + ms + String(Math.floor(Math.random() * 1000)).padStart(3, '0') + '+00:00');
}

function createMockServer(options) {
  const opts = Object.assign({ key: MOCK_KEY, rpcDelayMs: 0, pg: false }, options);
  const control = { wsEnabled: true, rejectAccessToken: false, failRpc: null };
  let db;
  let pgRest = null;                      // set by listen() when opts.pg
  const stats = { rpc: {}, wsConnections: 0, joins: 0, broadcasts: 0 };
  const sockets = new Set();
  const topics = new Map();               // topic -> Map(ws -> {joinRef, key, meta, phxRef})

  function reset() {
    db = { seq: 0, items: new Map(), chunks: new Map() };
    for (const k of Object.keys(stats.rpc)) delete stats.rpc[k];
    return pgRest ? pgRest.reset() : Promise.resolve();
  }
  reset();

  // ---------------------------------------------------------------------------
  // RPC (mirror of supabase/setup.sql)
  // ---------------------------------------------------------------------------
  const SIGNATURES = {
    clip_list: { required: ['p_room'], optional: ['p_after', 'p_limit'] },
    clip_push: { required: ['p_room', 'p_sender', 'p_payload'], optional: [] },
    clip_file_begin: { required: ['p_room', 'p_sender', 'p_payload', 'p_size', 'p_chunks'], optional: [] },
    clip_file_chunk: { required: ['p_room', 'p_id', 'p_idx', 'p_data'], optional: [] },
    clip_file_finish: { required: ['p_room', 'p_id'], optional: [] },
    clip_file_get: { required: ['p_room', 'p_id', 'p_idx'], optional: [] },
    clip_delete: { required: ['p_room', 'p_id'], optional: [] },
    clip_clear: { required: ['p_room'], optional: [] },
  };

  const checkRoom = (room) => {
    if (typeof room !== 'string' || !/^[0-9a-f]{64}$/.test(room)) throw new PgError(400, '22023', 'invalid room id');
  };
  const checkUuid = (id) => {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new PgError(400, '22P02', 'invalid input syntax for type uuid: "' + id + '"');
  };
  const nextSeq = () => ++db.seq;
  const rowOut = (i) => ({
    id: i.id, seq: i.seq, created_at: i.created_at, sender: i.sender, kind: i.kind,
    payload: i.payload, size: i.size, chunks: i.chunks, deleted: i.deleted,
  });
  function tombstone(item) {
    db.chunks.delete(item.id);
    item.deleted = true;
    item.payload = '';
    item.size = 0;
    item.seq = nextSeq();
  }

  const FUNCS = {
    clip_list({ p_room, p_after = -1, p_limit = 200 }) {
      checkRoom(p_room);
      const limit = Math.min(Math.max(Number(p_limit) || 200, 1), 500);
      const all = Array.from(db.items.values()).filter((i) => i.room === p_room && i.seq != null);
      if (p_after == null || Number(p_after) < 0) {
        return all.filter((i) => i.complete && !i.deleted).sort((a, b) => b.seq - a.seq).slice(0, limit)
          .sort((a, b) => a.seq - b.seq).map(rowOut);
      }
      return all.filter((i) => i.seq > Number(p_after)).sort((a, b) => a.seq - b.seq).slice(0, limit).map(rowOut);
    },
    clip_push({ p_room, p_sender, p_payload }) {
      checkRoom(p_room);
      if (!p_payload || String(p_payload).length > LIMITS.maxText) throw new PgError(400, '22001', 'text is too large');
      const item = {
        id: crypto.randomUUID(), room: p_room, seq: nextSeq(), created_at: pgTimestamp(new Date()),
        sender: String(p_sender || '').slice(0, 64), kind: 'text', payload: String(p_payload), size: String(p_payload).length, chunks: 0,
        complete: true, deleted: false,
      };
      db.items.set(item.id, item);
      return { id: item.id, seq: item.seq, created_at: item.created_at };
    },
    clip_file_begin({ p_room, p_sender, p_payload, p_size, p_chunks }) {
      checkRoom(p_room);
      if (!p_payload || String(p_payload).length > 65536) throw new PgError(400, '22023', 'invalid file metadata');
      if (p_size == null || p_size < 0 || p_size > LIMITS.maxFile) {
        throw new PgError(400, '22001', 'file is too large (max ' + LIMITS.maxFile / 1048576 + ' MB)');
      }
      if (!(p_chunks >= 1 && p_chunks <= 100000)) throw new PgError(400, '22023', 'invalid chunk count');
      const item = {
        id: crypto.randomUUID(), room: p_room, seq: null, created_at: pgTimestamp(new Date()),
        sender: String(p_sender || '').slice(0, 64), kind: 'blob', payload: String(p_payload),
        size: Number(p_size) + Number(p_chunks) * 128, chunks: Number(p_chunks), complete: false, deleted: false,
      };
      db.items.set(item.id, item);
      db.chunks.set(item.id, new Map());
      return { id: item.id };
    },
    clip_file_chunk({ p_room, p_id, p_idx, p_data }) {
      checkRoom(p_room);
      checkUuid(p_id);
      const item = db.items.get(p_id);
      if (!item || item.room !== p_room || item.deleted) throw new PgError(400, 'P0001', 'upload not found');
      if (item.complete) throw new PgError(400, '22023', 'upload already finished');
      if (!(Number.isInteger(p_idx) && p_idx >= 0 && p_idx < item.chunks)) throw new PgError(400, '22023', 'invalid chunk index');
      const bytes = Buffer.from(String(p_data || ''), 'base64');
      if (!bytes.length || bytes.length > LIMITS.chunkMax) throw new PgError(400, '22001', 'invalid chunk size');
      let stored = bytes.length;
      for (const [idx, b] of db.chunks.get(item.id)) if (idx !== p_idx) stored += b.length;
      if (stored > item.size) throw new PgError(400, '22001', 'upload is larger than announced');
      db.chunks.get(item.id).set(p_idx, bytes);
      return { ok: true };
    },
    clip_file_finish({ p_room, p_id }) {
      checkRoom(p_room);
      checkUuid(p_id);
      const item = db.items.get(p_id);
      if (!item || item.room !== p_room || item.deleted) throw new PgError(400, 'P0001', 'upload not found');
      if (item.complete) return { id: item.id, seq: item.seq, created_at: item.created_at };
      const parts = db.chunks.get(item.id);
      if (parts.size !== item.chunks) {
        throw new PgError(400, '22023', 'upload incomplete (' + parts.size + ' of ' + item.chunks + ' chunks)');
      }
      let size = 0;
      for (const b of parts.values()) size += b.length;
      item.complete = true;
      item.size = size;
      item.seq = nextSeq();
      item.created_at = pgTimestamp(new Date());
      return { id: item.id, seq: item.seq, created_at: item.created_at };
    },
    clip_file_get({ p_room, p_id, p_idx }) {
      checkRoom(p_room);
      checkUuid(p_id);
      const item = db.items.get(p_id);
      const data = item && item.room === p_room && item.complete && !item.deleted && db.chunks.get(p_id).get(p_idx);
      if (!data) throw new PgError(400, 'P0001', 'file not found (it may have expired)');
      return data.toString('base64');
    },
    clip_delete({ p_room, p_id }) {
      checkRoom(p_room);
      checkUuid(p_id);
      const item = db.items.get(p_id);
      if (!item || item.room !== p_room || item.deleted) return { ok: false };
      tombstone(item);
      return { ok: true };
    },
    clip_clear({ p_room }) {
      checkRoom(p_room);
      let n = 0;
      for (const item of db.items.values()) {
        if (item.room === p_room && !item.deleted) { tombstone(item); n += 1; }
      }
      return { cleared: n };
    },
  };

  function sendJson(res, status, body, extra) {
    const text = JSON.stringify(body);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    }, extra));
    res.end(text);
  }

  function corsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
  }

  async function handleRpc(req, res, fn) {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }
    const key = req.headers.apikey;
    if (!key) return sendJson(res, 401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' }, corsHeaders());
    if (key !== opts.key) return sendJson(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }, corsHeaders());
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer ' + opts.key) return sendJson(res, 401, { code: 'PGRST301', message: 'Invalid JWT' }, corsHeaders());

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let args;
    try {
      args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch (_) {
      return sendJson(res, 400, { code: 'PGRST102', details: null, hint: null, message: 'Empty or invalid json' }, corsHeaders());
    }
    stats.rpc[fn] = (stats.rpc[fn] || 0) + 1;
    const sig = SIGNATURES[fn];
    const names = Object.keys(args || {});
    if (!pgRest && (!sig || sig.required.some((a) => !names.includes(a)) || names.some((a) => !sig.required.includes(a) && !sig.optional.includes(a)))) {
      return sendJson(res, 404, {
        code: 'PGRST202', details: 'Searched for the function public.' + fn + ' with parameters ' + names.join(', '),
        hint: null, message: 'Could not find the function public.' + fn + '(' + names.join(', ') + ') in the schema cache',
      }, corsHeaders());
    }
    if (opts.rpcDelayMs) await new Promise((r) => setTimeout(r, opts.rpcDelayMs));
    if (control.failRpc && control.failRpc.fn === fn && control.failRpc.count > 0) {
      control.failRpc.count -= 1;
      return sendJson(res, control.failRpc.status, { code: 'XX000', details: null, hint: null, message: 'injected failure' }, corsHeaders());
    }
    if (pgRest) {
      const r = await pgRest.call(fn, args || {});
      return sendJson(res, r.status, r.body, corsHeaders());
    }
    try {
      const out = FUNCS[fn](args);
      sendJson(res, 200, out, corsHeaders());
    } catch (e) {
      if (e instanceof PgError) return sendJson(res, e.status, { code: e.code, details: null, hint: null, message: e.message }, corsHeaders());
      console.error(e);
      sendJson(res, 500, { code: 'XX000', details: null, hint: null, message: String(e && e.message) }, corsHeaders());
    }
  }

  // ---------------------------------------------------------------------------
  // Static files
  // ---------------------------------------------------------------------------
  function serveStatic(req, res, pathname) {
    if (pathname === '/config.js') {
      const body = 'window.CLIPSHARE_CONFIG = window.CLIPSHARE_CONFIG || ' + JSON.stringify({
        supabaseUrl: 'http://' + req.headers.host, supabaseKey: opts.key,
      }) + ';\n';
      res.writeHead(200, siteHeaders(pathname, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' }));
      res.end(body);
      return;
    }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (_) { res.writeHead(400); res.end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(WEB_ROOT, '.' + rel);
    if (!file.startsWith(WEB_ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, siteHeaders(pathname, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store',
      }));
      res.end(data);
    });
  }

  // ---------------------------------------------------------------------------
  // Realtime (Phoenix vsn 1.0.0)
  // ---------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });

  function wsSend(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function members(topic) {
    let m = topics.get(topic);
    if (!m) { m = new Map(); topics.set(topic, m); }
    return m;
  }

  function presenceState(topic) {
    const state = {};
    for (const info of members(topic).values()) {
      if (!info.meta) continue;
      (state[info.key] = state[info.key] || { metas: [] }).metas.push(Object.assign({ phx_ref: info.phxRef }, info.meta));
    }
    return state;
  }

  function presenceDiff(topic, joins, leaves) {
    for (const [ws, info] of members(topic)) {
      wsSend(ws, { topic, event: 'presence_diff', payload: { joins, leaves }, ref: null, join_ref: info.joinRef });
    }
  }

  function leave(ws, topic) {
    const m = members(topic);
    const info = m.get(ws);
    if (!info) return;
    m.delete(ws);
    if (info.meta) {
      presenceDiff(topic, {}, { [info.key]: { metas: [Object.assign({ phx_ref: info.phxRef }, info.meta)] } });
    }
    if (!m.size) topics.delete(topic);
  }

  function onWsMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const { topic, event, payload, ref } = msg;
    const joinRef = msg.join_ref;
    if (topic === 'phoenix' && event === 'heartbeat') {
      wsSend(ws, { topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref });
      return;
    }
    if (event === 'phx_join') {
      const cfg = (payload && payload.config) || {};
      if (control.rejectAccessToken && payload && payload.access_token && !String(payload.access_token).startsWith('eyJ')) {
        wsSend(ws, { topic, event: 'phx_reply', payload: { status: 'error', response: { reason: 'Invalid JWT' } }, ref, join_ref: joinRef });
        return;
      }
      if (!/^realtime:/.test(topic)) {
        wsSend(ws, { topic, event: 'phx_reply', payload: { status: 'error', response: { reason: 'invalid topic' } }, ref, join_ref: joinRef });
        return;
      }
      stats.joins += 1;
      const key = (cfg.presence && cfg.presence.key) || crypto.randomUUID();
      leave(ws, topic);
      members(topic).set(ws, { joinRef, key, meta: null, phxRef: null, self: !!(cfg.broadcast && cfg.broadcast.self) });
      ws.topicsJoined.add(topic);
      wsSend(ws, { topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: [] } }, ref, join_ref: joinRef });
      wsSend(ws, { topic, event: 'presence_state', payload: presenceState(topic), ref: null, join_ref: joinRef });
      return;
    }
    const info = members(topic).get(ws);
    if (!info) {
      wsSend(ws, { topic, event: 'phx_reply', payload: { status: 'error', response: { reason: 'unmatched topic' } }, ref, join_ref: joinRef });
      return;
    }
    if (event === 'phx_leave') {
      leave(ws, topic);
      ws.topicsJoined.delete(topic);
      wsSend(ws, { topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref, join_ref: joinRef });
      return;
    }
    if (event === 'presence' && payload && payload.event === 'track') {
      const leaves = info.meta ? { [info.key]: { metas: [Object.assign({ phx_ref: info.phxRef }, info.meta)] } } : {};
      const prev = info.phxRef;
      info.meta = payload.payload || {};
      info.phxRef = crypto.randomBytes(8).toString('base64url');
      const meta = Object.assign({ phx_ref: info.phxRef }, prev ? { phx_ref_prev: prev } : {}, info.meta);
      presenceDiff(topic, { [info.key]: { metas: [meta] } }, leaves);
      return;
    }
    if (event === 'presence' && payload && payload.event === 'untrack') {
      if (info.meta) {
        const leaves = { [info.key]: { metas: [Object.assign({ phx_ref: info.phxRef }, info.meta)] } };
        info.meta = null;
        presenceDiff(topic, {}, leaves);
      }
      return;
    }
    if (event === 'broadcast') {
      stats.broadcasts += 1;
      for (const [other, oinfo] of members(topic)) {
        if (other === ws && !info.self) continue;
        wsSend(other, { topic, event: 'broadcast', payload, ref: null, join_ref: oinfo.joinRef });
      }
    }
  }

  wss.on('connection', (ws) => {
    stats.wsConnections += 1;
    ws.topicsJoined = new Set();
    sockets.add(ws);
    ws.on('message', (data) => onWsMessage(ws, data.toString()));
    ws.on('close', () => {
      sockets.delete(ws);
      for (const t of ws.topicsJoined) leave(ws, t);
    });
    ws.on('error', () => {});
  });

  function dropAllSockets() {
    for (const ws of sockets) { try { ws.terminate(); } catch (_) { /* ignore */ } }
  }

  // ---------------------------------------------------------------------------
  // HTTP server
  // ---------------------------------------------------------------------------
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/rest/v1/rpc/')) {
      if (req.method !== 'POST' && req.method !== 'OPTIONS') return sendJson(res, 405, { code: 'PGRST117', message: 'Unsupported HTTP method' });
      handleRpc(req, res, p.slice('/rest/v1/rpc/'.length)).catch((e) => { console.error(e); try { res.end(); } catch (_) { /* ignore */ } });
      return;
    }
    if (p.startsWith('/__mock/')) {
      handleMock(url, res).catch((e) => { console.error(e); sendJson(res, 500, { message: String(e && e.message) }); });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    serveStatic(req, res, p);
  });

  async function handleMock(url, res) {
    const what = url.pathname.slice('/__mock/'.length);
    if (what === 'ws') {
      control.wsEnabled = url.searchParams.get('enabled') !== '0';
      if (!control.wsEnabled) dropAllSockets();
    } else if (what === 'config') {
      if (url.searchParams.has('rejectAccessToken')) control.rejectAccessToken = url.searchParams.get('rejectAccessToken') === '1';
    } else if (what === 'reset') {
      await reset();
    } else if (what === 'fail') {
      control.failRpc = { fn: url.searchParams.get('fn'), status: Number(url.searchParams.get('status') || 500), count: Number(url.searchParams.get('count') || 1) };
    }
    const counts = pgRest ? await pgRest.counts() : { items: db.items.size, seq: db.seq };
    sendJson(res, 200, {
      backend: pgRest ? 'postgres' : 'memory', control, stats, items: counts.items, seq: counts.seq, sockets: sockets.size,
      topics: Array.from(topics.entries()).map(([t, m]) => ({ topic: t, members: m.size })),
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const reject = (code, text) => {
      socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    };
    if (url.pathname !== '/realtime/v1/websocket') return reject(404, 'Not Found');
    if (!control.wsEnabled) return reject(503, 'Service Unavailable');
    if (url.searchParams.get('apikey') !== opts.key) return reject(401, 'Unauthorized');
    if (url.searchParams.get('vsn') !== '1.0.0') return reject(400, 'Bad Request');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return {
    key: opts.key,
    control,
    stats,
    get db() { return db; },
    get pg() { return pgRest; },
    reset,
    setWsEnabled(on) { control.wsEnabled = !!on; if (!on) dropAllSockets(); },
    async listen(port) {
      if (opts.pg && !pgRest) pgRest = new Rest(await openDb());
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port || 0, '127.0.0.1', () => {
          const addr = server.address();
          resolve({ port: addr.port, url: 'http://127.0.0.1:' + addr.port });
        });
      });
    },
    async close() {
      dropAllSockets();
      wss.close();
      await new Promise((resolve) => server.close(() => resolve()));
      if (pgRest) await pgRest.db.close();
    },
  };
}

module.exports = { createMockServer, MOCK_KEY };

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = Number(args.find((a) => /^\d+$/.test(a))) || 8787;
  const pg = args.includes('--pg');
  const srv = createMockServer({ pg });
  srv.listen(port).then(({ url }) => {
    console.log('PastePort mock backend (' + (pg ? 'setup.sql in PGlite' : 'in memory') + ') + app: ' + url);
    console.log('Open it in two browser windows (or a normal and a private window) to try it.');
  });
}
