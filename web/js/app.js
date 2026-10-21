/* ClipShare web app (UI). Uses window.ClipCrypto and window.ClipBackend. */
(function () {
  'use strict';

  const C = window.ClipCrypto;
  const B = window.ClipBackend;
  const cfg = window.CLIPSHARE_CONFIG || {};
  const $ = (s) => document.querySelector(s);

  const FRESH_MS = 15 * 60 * 1000;            // only auto-copy / auto-download recent items
  const PREVIEW_CHARS = 1500;
  const PREVIEW_IMAGE_MAX = 8 * 1024 * 1024;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('clipshare.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; }
    },
    set(k, v) { try { localStorage.setItem('clipshare.' + k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
    del(k) { try { localStorage.removeItem('clipshare.' + k); } catch (_) { /* ignore */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem('clipshare.' + k) || ''; } catch (_) { return ''; } },
    set(k, v) { try { sessionStorage.setItem('clipshare.' + k, v); } catch (_) { /* ignore */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(label, cls, onClick, title) {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return t;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
  }

  function relTime(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  function defaultDeviceName() {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android'
      : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return os + ' ' + br;
  }

  function describe(item) {
    if (item.kind === 'text') return 'text';
    if (item.t === 'image') return 'an image';
    return item.name;
  }

  function preview(item) {
    if (item.kind === 'text') {
      const t = item.text.replace(/\s+/g, ' ').trim();
      return t.length > 140 ? t.slice(0, 137) + '...' : t;
    }
    if (item.t === 'image') return 'Image (' + formatBytes(item.size) + ')';
    return item.name + ' (' + formatBytes(item.size) + ')';
  }

  function fileIcon(name, mime) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    if (/^image\//.test(mime)) return '\u{1F5BC}\uFE0F';
    if (ext === 'pdf') return '\u{1F4D5}';
    if (['zip', '7z', 'rar', 'gz', 'tar'].includes(ext)) return '\u{1F5DC}\uFE0F';
    if (['xls', 'xlsx', 'xlsm', 'csv'].includes(ext)) return '\u{1F4CA}';
    if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return '\u{1F4DD}';
    if (['ppt', 'pptx'].includes(ext)) return '\u{1F4FD}\uFE0F';
    if (['txt', 'md', 'log', 'json', 'xml', 'yaml', 'yml', 'ini'].includes(ext)) return '\u{1F4C4}';
    return '\u{1F4E6}';
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    deviceId: store.get('deviceId', null),
    settings: null,
    room: null,
    pending: null,
    lastClipHash: session.get('lastClipHash'),
    urls: new Map(),        // item id -> object URL (image previews)
    installPrompt: null,
    observer: null,
    focusBusy: false,
    connection: 'connecting',
    peers: [],
  };
  if (!state.deviceId) {
    state.deviceId = B.randomHex(8);
    store.set('deviceId', state.deviceId);
  }
  state.settings = Object.assign(
    { deviceName: defaultDeviceName(), autoCopy: true, autoDownload: true, autoSend: false },
    store.get('settings', {}));

  function saveSettings() { store.set('settings', state.settings); }
  function configured() { return !!(cfg.supabaseUrl && cfg.supabaseKey); }

  // ---------------------------------------------------------------------------
  // Toasts / alerts
  // ---------------------------------------------------------------------------
  function toast(msg, kind, ms) {
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), ms || (kind === 'error' ? 6000 : 3500));
  }

  function setAlert(msg) {
    const a = $('#alert');
    a.textContent = msg || '';
    a.hidden = !msg;
  }

  // ---------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------
  function legacyCopy(text) {
    const ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Copy is not supported in this browser');
  }

  async function writeClipboardText(text, html) {
    if (navigator.clipboard && window.ClipboardItem && html) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
        return;
      } catch (_) { /* fall back to plain text */ }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    legacyCopy(text);
  }

  async function toPng(blob) {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image conversion failed'))), 'image/png');
    });
  }

  async function writeClipboardImage(blobPromise) {
    if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) {
      throw new Error('Copying images is not supported in this browser. Use Download instead.');
    }
    const png = Promise.resolve(blobPromise).then((b) => (b.type === 'image/png' ? b : toPng(b)));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }

  /** Returns {text, html} or {image: Blob} or null. */
  async function readClipboard() {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const ci of items) {
        if (ci.types.includes('text/plain')) {
          const text = await (await ci.getType('text/plain')).text();
          if (text.trim()) {
            const html = ci.types.includes('text/html') ? await (await ci.getType('text/html')).text() : '';
            return { text, html };
          }
        }
      }
      for (const ci of items) {
        const type = ci.types.find((t) => /^image\//.test(t));
        if (type) return { image: await ci.getType(type) };
      }
      return null;
    }
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      return text ? { text, html: '' } : null;
    }
    throw new Error('Reading the clipboard is not supported here. Press Ctrl+V on this page instead.');
  }

  async function clipHash(clip) {
    if (clip.image) return 'i:' + await C.sha256Hex(new Uint8Array(await clip.image.arrayBuffer()));
    return 't:' + await C.sha256Hex(String(clip.text || ''));
  }

  function setLastClipHash(h) {
    state.lastClipHash = h;
    session.set('lastClipHash', h);
  }

  /** Remember what is on the clipboard now, so auto-send doesn't send it back. */
  async function rememberClipboard(fallback) {
    let h = '';
    if (state.settings.autoSend) {
      try { const c = await readClipboard(); if (c) h = await clipHash(c); } catch (_) { /* ignore */ }
    }
    if (!h && fallback) h = await clipHash(fallback);
    if (h) setLastClipHash(h);
  }

  async function copyPlain(text, what) {
    try {
      await writeClipboardText(text, '');
      await rememberClipboard({ text });
      toast((what || 'Text') + ' copied', 'ok');
      return true;
    } catch (e) {
      toast('Could not copy: ' + e.message, 'error');
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function show(screen) {
    $('#lobby').hidden = screen !== 'lobby';
    $('#room').hidden = screen !== 'room';
  }

  function inviteLink(code) {
    return location.href.split('#')[0] + '#join=' + C.formatCode(code);
  }

  function appUrl() {
    return location.protocol === 'file:' ? 'this page' : location.host + location.pathname.replace(/index\.html$/, '');
  }

  /** Puts a QR code of the room's invite link in `box`. Not shown for file:// pages, which a phone can't open. */
  function renderQr(box, code, moduleSize) {
    box.textContent = '';
    if (!window.ClipQR || !/^https?:$/.test(location.protocol)) return false;
    try {
      box.appendChild(window.ClipQR.svg(inviteLink(code), {
        moduleSize, label: 'QR code that joins room ' + C.formatCode(code),
      }));
      return true;
    } catch (e) {
      console.warn('[ClipShare] QR code:', e);
      return false;
    }
  }

  function renderLobby() {
    $('#config-warning').hidden = configured();
    const rooms = store.get('rooms', []);
    const list = $('#recent-list');
    list.textContent = '';
    for (const r of rooms) {
      const li = el('li');
      li.append(el('span', 'code', C.formatCode(r.code)), el('span', 'when', relTime(r.at)));
      li.append(button('Open', 'small primary', () => enterRoom(r.code)));
      li.append(button('Forget', 'small', () => {
        store.set('rooms', store.get('rooms', []).filter((x) => x.code !== r.code));
        renderLobby();
      }));
      list.appendChild(li);
    }
    $('#recent').hidden = rooms.length === 0;
    $('#install-btn').hidden = !state.installPrompt;
  }

  function rememberRoom(code) {
    const rooms = store.get('rooms', []).filter((r) => r.code !== code);
    rooms.unshift({ code, at: Date.now() });
    store.set('rooms', rooms.slice(0, 8));
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------
  async function enterRoom(codeInput) {
    if (!configured()) {
      show('lobby');
      renderLobby();
      toast('Set up the backend in config.js first (see README).', 'error');
      return;
    }
    const code = C.normalizeCode(codeInput);
    if (!C.isValidCode(code)) { toast('Invalid room code', 'error'); return; }
    leaveRoom(true);
    show('room');
    resetRoomView(code);

    const room = new B.Room({
      url: cfg.supabaseUrl, key: cfg.supabaseKey, code,
      deviceId: state.deviceId, deviceName: state.settings.deviceName, client: 'web',
    });
    state.room = room;
    const mine = (fn) => (...args) => { if (state.room === room) fn(...args); };
    room.on('add', mine(onAdd));
    room.on('remove', mine(onRemove));
    room.on('connection', mine(setStatus));
    room.on('peers', mine((p) => { state.peers = p; renderPeers(); }));
    room.on('loaded', mine(() => { updateEmpty(); scrollToBottom(); }));
    room.on('notice', (msg) => console.info('[ClipShare]', msg));
    room.on('syncError', mine(onSyncError));
    rememberRoom(code);
    store.set('lastRoom', code);
    try {
      await room.open();
    } catch (e) {
      if (state.room === room) setAlert('Could not open the room: ' + e.message);
    }
  }

  function leaveRoom(keepLast) {
    if (state.room) state.room.close();
    state.room = null;
    clearPending();
    for (const url of state.urls.values()) URL.revokeObjectURL(url);
    state.urls.clear();
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if ($('#invite').open) $('#invite').close();
    if (!keepLast) store.del('lastRoom');
  }

  function resetRoomView(code) {
    $('#room-code').textContent = C.formatCode(code);
    $('#empty-code').textContent = C.formatCode(code);
    $('#empty-url').textContent = appUrl();
    $('#empty-qr').hidden = !renderQr($('#empty-qr .qr'), code, 4);
    $('#items').textContent = '';
    $('#uploads').textContent = '';
    $('#empty').hidden = true;
    state.peers = [];
    setAlert('');
    setStatus('connecting');
    renderPeers();
    state.observer = 'IntersectionObserver' in window ? new IntersectionObserver(onVisible, { root: $('#feed'), rootMargin: '300px' }) : null;
  }

  function onSyncError(e) {
    if (e && (e.status === 404 || e.code === 'PGRST202')) {
      setAlert('The ClipShare database functions were not found. Run supabase/setup.sql in the Supabase SQL editor (see README).');
    } else if (e && (e.status === 401 || e.status === 403)) {
      setAlert('The backend rejected the API key. Check supabaseKey in config.js.');
    } else if (e && e.code !== 'network') {
      setAlert('Server error: ' + e.message);
    }
  }

  function setStatus(c) {
    state.connection = c;
    if (c === 'live' || c === 'polling') {
      const a = $('#alert');
      if (!a.hidden) setAlert('');
    }
    $('#status').dataset.state = c;
    $('#status-text').textContent = {
      connecting: 'Connecting...', live: 'Live', polling: 'Connected (polling)', offline: 'Offline, retrying...',
    }[c] || c;
    $('#status').title = {
      live: 'Changes arrive instantly.',
      polling: 'Instant updates are blocked on this network, so the app checks every few seconds.',
      offline: 'Cannot reach the server. Retrying automatically.',
    }[c] || '';
    renderPeers();
  }

  function renderPeers() {
    const box = $('#peers');
    box.textContent = '';
    box.appendChild(el('span', 'chip self', 'This device: ' + state.settings.deviceName));
    if (state.connection !== 'live') {
      box.appendChild(el('span', 'chip unknown', 'Online status unavailable'));
      return;
    }
    const others = state.peers.filter((p) => !p.self);
    if (!others.length) {
      box.appendChild(el('span', 'chip waiting', 'Waiting for the other computer to join...'));
      return;
    }
    for (const p of others) {
      box.appendChild(el('span', 'chip peer', p.name));
    }
  }

  function updateEmpty() {
    const room = state.room;
    $('#empty').hidden = !room || !room.loaded || room.items.size > 0 || $('#uploads').childElementCount > 0;
  }

  // ---------------------------------------------------------------------------
  // Feed rendering
  // ---------------------------------------------------------------------------
  function feedNearBottom() {
    const f = $('#feed');
    return f.scrollHeight - f.scrollTop - f.clientHeight < 160;
  }

  function scrollToBottom() {
    const f = $('#feed');
    f.scrollTop = f.scrollHeight;
  }

  function findItemEl(id) {
    return $('#items').querySelector('[data-id="' + id + '"]');
  }

  function onAdd(item) {
    if (findItemEl(item.id)) return;
    const near = feedNearBottom();
    const node = renderItem(item);
    const list = $('#items');
    let before = null;
    for (let n = list.lastElementChild; n; n = n.previousElementSibling) {
      if (Number(n.dataset.seq) <= item.seq) break;
      before = n;
    }
    list.insertBefore(node, before);
    updateEmpty();
    if (near || item.mine) scrollToBottom();
    if (item.live && !item.mine && Date.now() - item.createdAt < FRESH_MS) handleIncoming(item);
  }

  function onRemove(id) {
    const node = findItemEl(id);
    if (node) node.remove();
    const url = state.urls.get(id);
    if (url) { URL.revokeObjectURL(url); state.urls.delete(id); }
    if (state.pending && state.pending.id === id) clearPending();
    updateEmpty();
  }

  function renderItem(item) {
    const node = el('article', 'item' + (item.mine ? ' mine' : ''));
    node.dataset.id = item.id;
    node.dataset.seq = String(item.seq);

    const meta = el('div', 'meta');
    meta.append(el('span', 'from', item.mine ? 'You (' + item.from + ')' : item.from));
    meta.append(el('span', null, '\u00B7'), el('time', null, formatTime(item.createdAt)));
    const tag = { clip: 'clipboard' }[item.src];
    if (tag) meta.append(el('span', 'tag', tag));
    node.appendChild(meta);

    const bubble = el('div', 'bubble');
    if (item.kind === 'text') renderText(bubble, item.text);
    else if (item.t === 'image') renderImage(bubble, item, node);
    else renderFile(bubble, item);
    node.appendChild(bubble);

    const actions = el('div', 'actions');
    if (item.kind === 'text' || item.t === 'image') {
      actions.append(button('Copy', '', () => copyItem(item, false), 'Copy to clipboard'));
    }
    if (item.kind === 'blob') {
      actions.append(button('Download', '', () => downloadItem(item, false), 'Save to Downloads'));
    }
    actions.append(button('Delete', 'danger', () => deleteItem(item), 'Delete for everyone in the room'));
    node.appendChild(actions);
    return node;
  }

  function renderText(bubble, text) {
    const trimmed = text.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed) && trimmed.length < 2000) {
      const a = el('a', null, trimmed);
      a.href = trimmed;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      bubble.appendChild(a);
      return;
    }
    const pre = el('pre', 'text', text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '...' : text);
    bubble.appendChild(pre);
    if (text.length > PREVIEW_CHARS) {
      const more = button('Show all (' + text.length.toLocaleString() + ' characters)', 'small more', () => {
        pre.textContent = text;
        more.remove();
      });
      bubble.appendChild(more);
    }
  }

  function renderFile(bubble, item) {
    const f = el('div', 'file');
    f.append(el('span', 'icon', fileIcon(item.name, item.mime)));
    const info = el('div');
    info.append(el('div', 'name', item.name), el('div', 'size', formatBytes(item.size)));
    f.appendChild(info);
    bubble.appendChild(f);
  }

  function renderImage(bubble, item, node) {
    const ph = el('div', 'placeholder', 'Image \u00B7 ' + formatBytes(item.size));
    bubble.appendChild(ph);
    if (item.size <= PREVIEW_IMAGE_MAX) {
      if (state.observer) state.observer.observe(node);
      else loadPreview(item, node);
    } else {
      bubble.appendChild(button('Show preview', 'small more', () => loadPreview(item, node)));
    }
  }

  function onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      state.observer.unobserve(e.target);
      const item = state.room && state.room.items.get(e.target.dataset.id);
      if (item) loadPreview(item, e.target);
    }
  }

  async function loadPreview(item, node) {
    const room = state.room;
    if (!room || node.dataset.loading) return;
    node.dataset.loading = '1';
    const bubble = node.querySelector('.bubble');
    try {
      const blob = await room.getBlob(item);
      if (state.room !== room) return;
      let url = state.urls.get(item.id);
      if (!url) { url = URL.createObjectURL(blob); state.urls.set(item.id, url); }
      const img = el('img', 'preview');
      img.alt = item.name;
      img.src = url;
      img.addEventListener('click', () => img.classList.toggle('zoom'));
      bubble.textContent = '';
      bubble.appendChild(img);
    } catch (e) {
      const ph = bubble.querySelector('.placeholder');
      if (ph) ph.textContent = 'Image preview failed: ' + e.message;
      delete node.dataset.loading;
    }
  }

  function addProgress(node) {
    const bar = el('div', 'progress');
    const fill = el('div');
    bar.appendChild(fill);
    node.querySelector('.bubble').appendChild(bar);
    return { set(p) { fill.style.width = Math.round(p * 100) + '%'; }, remove() { bar.remove(); } };
  }

  function flash(id) {
    const node = findItemEl(id);
    if (!node) return;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1500);
  }

  // ---------------------------------------------------------------------------
  // Item actions
  // ---------------------------------------------------------------------------
  async function copyItem(item, auto) {
    const room = state.room;
    try {
      if (item.kind === 'text') {
        await writeClipboardText(item.text, item.html);
        await rememberClipboard({ text: item.text });
      } else if (item.t === 'image') {
        const blobP = room.getBlob(item);
        await writeClipboardImage(blobP);
        await rememberClipboard({ image: await blobP });
      } else {
        return false;
      }
      flash(item.id);
      if (state.pending && state.pending.id === item.id) clearPending();
      toast(auto ? 'Copied ' + describe(item) + ' from ' + item.from + '. Ready to paste.' : 'Copied. Ready to paste.', 'ok');
      return true;
    } catch (e) {
      if (!auto) toast('Could not copy: ' + e.message, 'error');
      return false;
    }
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function downloadItem(item, auto) {
    const room = state.room;
    if (!room) return;
    const node = findItemEl(item.id);
    const bar = node ? addProgress(node) : null;
    try {
      const blob = await room.getBlob(item, (p) => bar && bar.set(p));
      saveBlob(blob, item.name);
      if (auto) toast('Downloaded ' + item.name + ' from ' + item.from, 'ok');
    } catch (e) {
      toast('Download failed: ' + e.message, 'error');
    } finally {
      if (bar) bar.remove();
    }
  }

  async function deleteItem(item) {
    if (!state.room) return;
    try {
      await state.room.deleteItem(item.id);
    } catch (e) {
      toast('Could not delete: ' + e.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Receiving
  // ---------------------------------------------------------------------------
  function notify(item) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;
    try {
      const n = new Notification('ClipShare: from ' + item.from, {
        body: preview(item), tag: 'clipshare', icon: 'icons/icon-192.png',
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (_) { /* ignore */ }
  }

  async function handleIncoming(item) {
    notify(item);
    if (item.kind === 'blob' && item.t !== 'image') {
      if (state.settings.autoDownload) downloadItem(item, true);
      return;
    }
    if (!state.settings.autoCopy) return;
    if (document.hasFocus() && await copyItem(item, true)) return;
    setPending(item);
  }

  function setPending(item) {
    state.pending = item;
    $('#pending-text').textContent = 'New ' + (item.kind === 'text' ? 'text' : 'image') + ' from ' + item.from +
      ': it will be copied when you switch to this window.';
    $('#pending-banner').hidden = false;
    document.title = '(1) New clip - ClipShare';
  }

  function clearPending() {
    state.pending = null;
    $('#pending-banner').hidden = true;
    document.title = 'ClipShare';
  }

  async function onFocus() {
    if (state.focusBusy || !state.room) return;
    state.focusBusy = true;
    try {
      await sleep(80);
      if (!document.hasFocus() || !state.room) return;
      if (state.pending) {
        await copyItem(state.pending, true);
        return;
      }
      if (state.settings.autoSend && state.room.loaded) await autoSendClipboard();
    } finally {
      state.focusBusy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------
  function newestItem() {
    let best = null;
    if (!state.room) return null;
    for (const it of state.room.items.values()) if (!best || it.seq > best.seq) best = it;
    return best;
  }

  async function sendText(fields) {
    const room = state.room;
    if (!room) return false;
    if (!fields.text || !fields.text.length) return false;
    try {
      await room.sendText(fields);
      if (fields.src === 'clip') setLastClipHash(await clipHash({ text: fields.text }));
      return true;
    } catch (e) {
      toast('Could not send: ' + e.message, 'error');
      return false;
    }
  }

  function uploadPlaceholder(file) {
    const node = el('article', 'item mine');
    const meta = el('div', 'meta');
    meta.append(el('span', null, 'Sending...'));
    const bubble = el('div', 'bubble');
    const f = el('div', 'file');
    f.append(el('span', 'icon', fileIcon(file.name, file.type)));
    const info = el('div');
    info.append(el('div', 'name', file.name), el('div', 'size', formatBytes(file.size)));
    f.appendChild(info);
    bubble.appendChild(f);
    node.append(meta, bubble);
    $('#uploads').appendChild(node);
    updateEmpty();
    scrollToBottom();
    const bar = addProgress(node);
    return {
      progress: (p) => bar.set(p),
      remove: () => { node.remove(); updateEmpty(); },
      fail: (msg, retry) => {
        node.classList.add('failed');
        meta.textContent = 'Failed: ' + msg;
        bar.remove();
        const actions = el('div', 'actions');
        actions.append(button('Retry', 'small', () => { node.remove(); retry(); }));
        actions.append(button('Dismiss', 'small', () => { node.remove(); updateEmpty(); }));
        node.appendChild(actions);
      },
    };
  }

  function niceName(file, src) {
    let name = file.name || '';
    if (!name || (src === 'clip' && /^image\.(png|jpe?g|gif|bmp|webp)$/i.test(name))) {
      const ext = (file.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      name = 'clipboard-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext;
    }
    return name;
  }

  async function sendFiles(files, src) {
    const room = state.room;
    if (!room || !files.length) return;
    const g = files.length > 1 ? B.randomHex(6) : '';
    for (const file of files) {
      if (file.size > B.MAX_FILE) {
        toast(file.name + ' is larger than ' + (B.MAX_FILE / 1048576) + ' MB', 'error');
        continue;
      }
      const name = niceName(file, src);
      const ph = uploadPlaceholder({ name, type: file.type, size: file.size });
      try {
        await room.sendFile(file, { name, mime: file.type, src, g, gn: files.length }, ph.progress);
        ph.remove();
        if (src === 'clip' && /^image\//.test(file.type)) setLastClipHash(await clipHash({ image: file }));
      } catch (e) {
        ph.fail(e.message, () => sendFiles([file], src));
      }
    }
  }

  async function sendClipboardNow() {
    let clip;
    try {
      clip = await readClipboard();
    } catch (e) {
      toast('Clipboard access was blocked. Press Ctrl+V on this page instead.', 'error');
      return;
    }
    if (!clip) { toast('Your clipboard is empty'); return; }
    if (clip.image) {
      await sendFiles([new File([clip.image], 'image.png', { type: clip.image.type || 'image/png' })], 'clip');
    } else {
      await sendText({ text: clip.text, html: clip.html, src: 'clip' });
    }
  }

  async function autoSendClipboard() {
    let clip;
    try { clip = await readClipboard(); } catch (_) { return; }
    if (!clip) return;
    const h = await clipHash(clip);
    if (h === state.lastClipHash) return;
    setLastClipHash(h);
    const last = newestItem();
    if (clip.text !== undefined && last && last.kind === 'text' && last.text === clip.text) return;
    if (clip.image) {
      await sendFiles([new File([clip.image], 'image.png', { type: clip.image.type || 'image/png' })], 'clip');
    } else {
      await sendText({ text: clip.text, html: clip.html, src: 'clip' });
    }
  }

  function isBitmapOnly(files) {
    return files.length === 1 && /^image\//.test(files[0].type) && /^image\.(png|bmp|jpe?g|gif)$/i.test(files[0].name);
  }

  function onPaste(e) {
    if (!state.room || $('#room').hidden || $('#settings').open) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const target = e.target;
    const editable = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
    const files = Array.from(dt.files || []);
    const text = dt.getData('text/plain');
    const useText = !!text.trim() && (files.length === 0 || isBitmapOnly(files));
    if (editable) {
      // Normal paste into the text box, except files/images which are sent right away.
      if (target.id === 'message' && files.length && !useText) {
        e.preventDefault();
        sendFiles(files, 'clip');
      }
      return;
    }
    e.preventDefault();
    if (useText) {
      sendText({ text, html: dt.getData('text/html'), rtf: dt.getData('text/rtf'), src: 'clip' });
    } else if (files.length) {
      sendFiles(files, 'clip');
    } else if (text) {
      sendText({ text, src: 'clip' });
    }
  }

  function draggingFiles(e) {
    return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function openSettings() {
    $('#device-name').value = state.settings.deviceName;
    $('#opt-autocopy').checked = state.settings.autoCopy;
    $('#opt-autodownload').checked = state.settings.autoDownload;
    $('#opt-autosend').checked = state.settings.autoSend;
    updateNotifyState();
    $('#settings').showModal();
  }

  function updateNotifyState() {
    const s = $('#notify-state');
    const btn = $('#notify-btn');
    if (!('Notification' in window)) { s.textContent = 'Not supported in this browser'; btn.hidden = true; return; }
    btn.hidden = Notification.permission === 'granted';
    s.textContent = { granted: 'Notifications are on', denied: 'Blocked in browser settings', default: '' }[Notification.permission] || '';
  }

  // ---------------------------------------------------------------------------
  // Invite
  // ---------------------------------------------------------------------------
  const labelTimers = new WeakMap();

  function openInvite() {
    if (!state.room) return;
    const code = state.room.code;
    const qr = renderQr($('#invite-qr'), code, 6);
    $('#invite-qr').hidden = !qr;
    $('#invite-hint').textContent = qr
      ? 'Scan this with a phone\u2019s camera, or enter this code on the other device:'
      : 'Enter this code on the other device, or send it the invite link:';
    $('#invite-code').textContent = C.formatCode(code);
    for (const b of document.querySelectorAll('#invite button[data-label]')) b.textContent = b.dataset.label;
    $('#invite').showModal();
  }

  /** Copies from inside the invite dialog. Toasts sit behind the modal backdrop, so the button shows the result. */
  async function copyFromDialog(btn, text, what) {
    const ok = await copyPlain(text, what);
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = ok ? 'Copied' : 'Could not copy';
    clearTimeout(labelTimers.get(btn));
    labelTimers.set(btn, setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500));
  }

  /** Closes a modal dialog when a click both starts and ends on its backdrop. */
  function closeOnBackdrop(dialog) {
    let fromBackdrop = false;
    dialog.addEventListener('pointerdown', (e) => { fromBackdrop = e.target === dialog; });
    dialog.addEventListener('click', (e) => { if (fromBackdrop && e.target === dialog) dialog.close(); });
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function formatCodeInput(input) {
    const raw = C.normalizeCode(input.value).slice(0, C.CODE_LENGTH);
    input.value = raw.length > 5 ? raw.slice(0, 5) + '-' + raw.slice(5) : raw;
  }

  function wire() {
    $('#create-btn').addEventListener('click', () => enterRoom(C.generateCode()));
    $('#join-code').addEventListener('input', (e) => { formatCodeInput(e.target); $('#join-error').hidden = true; });
    $('#join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = $('#join-code').value;
      if (!C.isValidCode(code)) {
        const err = $('#join-error');
        err.textContent = 'A room code has 10 letters and numbers, like 7K2QM-XR4TD.';
        err.hidden = false;
        return;
      }
      $('#join-code').value = '';
      enterRoom(code);
    });
    $('#install-btn').addEventListener('click', async () => {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      try { await state.installPrompt.userChoice; } catch (_) { /* ignore */ }
      state.installPrompt = null;
      renderLobby();
    });

    $('#leave-btn').addEventListener('click', () => { leaveRoom(false); show('lobby'); renderLobby(); });
    const copyCode = () => state.room && copyPlain(C.formatCode(state.room.code), 'Room code');
    const copyLink = () => state.room && copyPlain(inviteLink(state.room.code), 'Invite link');
    $('#code-btn').addEventListener('click', copyCode);
    $('#empty-copy-code').addEventListener('click', copyCode);
    $('#empty-copy-link').addEventListener('click', copyLink);
    $('#invite-btn').addEventListener('click', openInvite);
    $('#invite-copy-code').addEventListener('click', (e) => state.room && copyFromDialog(e.currentTarget, C.formatCode(state.room.code), 'Room code'));
    $('#invite-copy-link').addEventListener('click', (e) => state.room && copyFromDialog(e.currentTarget, inviteLink(state.room.code), 'Invite link'));
    closeOnBackdrop($('#invite'));
    $('#settings-btn').addEventListener('click', openSettings);
    $('#pending-copy').addEventListener('click', () => state.pending && copyItem(state.pending, false));
    $('#pending-dismiss').addEventListener('click', clearPending);

    // Composer
    const msg = $('#message');
    const autosize = () => { msg.style.height = 'auto'; msg.style.height = Math.min(200, msg.scrollHeight + 2) + 'px'; };
    msg.addEventListener('input', autosize);
    msg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $('#composer').requestSubmit();
      }
    });
    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = msg.value;
      if (!text.trim()) return;
      const btn = $('#send-btn');
      btn.disabled = true;
      const ok = await sendText({ text, src: 'chat' });
      btn.disabled = false;
      if (ok && msg.value === text) { msg.value = ''; autosize(); }
    });
    $('#attach-btn').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      sendFiles(files, 'drop');
    });
    $('#clip-btn').addEventListener('click', sendClipboardNow);

    document.addEventListener('paste', onPaste);

    // Drag and drop
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!draggingFiles(e) || !state.room) return;
      e.preventDefault();
      depth += 1;
      $('#drop').hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!draggingFiles(e) || !state.room) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!draggingFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) $('#drop').hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      depth = 0;
      $('#drop').hidden = true;
      if (!state.room) return;
      // Folders show up as zero-byte "files"; skip them (entries must be read during the event).
      const files = [];
      let folders = 0;
      for (const it of Array.from(e.dataTransfer.items || [])) {
        if (it.kind !== 'file') continue;
        const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) { folders += 1; continue; }
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      if (!files.length && !folders) files.push(...Array.from(e.dataTransfer.files || []));
      if (folders) toast('Folders cannot be sent. Zip the folder first (right click > Send to > Compressed folder).', 'error', 8000);
      sendFiles(files, 'drop');
    });

    // Focus: copy pending items / auto-send clipboard
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onFocus(); });

    // Settings dialog
    $('#device-name').addEventListener('change', (e) => {
      const name = e.target.value.trim().slice(0, 40) || defaultDeviceName();
      e.target.value = name;
      state.settings.deviceName = name;
      saveSettings();
      if (state.room) state.room.setDeviceName(name);
      renderPeers();
    });
    $('#opt-autocopy').addEventListener('change', (e) => { state.settings.autoCopy = e.target.checked; saveSettings(); });
    $('#opt-autodownload').addEventListener('change', (e) => { state.settings.autoDownload = e.target.checked; saveSettings(); });
    $('#opt-autosend').addEventListener('change', async (e) => {
      const on = e.target.checked;
      if (on) {
        try {
          const clip = await readClipboard();   // asks for clipboard permission
          if (clip) setLastClipHash(await clipHash(clip));
        } catch (err) {
          e.target.checked = false;
          toast('Clipboard access was blocked. Allow it in the site settings (lock icon in the address bar).', 'error', 8000);
          return;
        }
      }
      state.settings.autoSend = on;
      saveSettings();
    });
    $('#notify-btn').addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch (_) { /* ignore */ }
      updateNotifyState();
    });
    $('#clear-btn').addEventListener('click', async () => {
      if (!state.room) return;
      if (!confirm('Delete everything in this room for all devices?')) return;
      try {
        await state.room.clearAll();
        toast('Room cleared');
      } catch (e) {
        toast('Could not clear: ' + e.message, 'error');
      }
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.installPrompt = e;
      if (!$('#lobby').hidden) renderLobby();
    });
    window.addEventListener('hashchange', checkHash);
  }

  function checkHash() {
    const m = location.hash.match(/join=([0-9A-Za-z-]+)/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    if (C.isValidCode(m[1])) { enterRoom(m[1]); return true; }
    toast('That invite link has an invalid room code', 'error');
    return false;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
    navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
  }

  function start() {
    wire();
    registerServiceWorker();
    if (checkHash()) return;
    const last = store.get('lastRoom', null);
    if (last && C.isValidCode(last) && configured()) {
      enterRoom(last);
      return;
    }
    show('lobby');
    renderLobby();
  }

  start();
})();
