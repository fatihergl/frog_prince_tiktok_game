/*
 * Kurbağa Prens — Sunucu
 * ----------------------------------------------------------------
 *  - TikTok LIVE'a bağlanır, gül / beğeni / hediye olaylarını okur
 *  - Oyun motorunu (public/engine.js) çalıştırır
 *  - Oyun ekranına (overlay) ve kontrol paneline canlı veri yollar (SSE)
 *  - Kara liste, günün prensleri ve ayarları diske kaydeder
 *
 *  Çalıştırma:  npm install  →  npm start
 *  Panel:       http://localhost:3000/panel
 *  Oyun ekranı: http://localhost:3000/overlay   (OBS / LIVE Studio'ya bunu ekle)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Game } = require('./public/engine.js');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');

/* ---------------- Ayarlar ve kayıtlar ---------------- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { log('warn', 'Kaydedilemedi: ' + file + ' (' + e.message + ')'); }
}

const config = Object.assign({
  port: 3000,
  host: '127.0.0.1',
  tiktokUsername: '',
  autoConnect: false,
  signApiKey: '',
  nameSource: 'uniqueId',
  extraBadWords: [],
  game: {}
}, readJson(CONFIG_PATH, {}));

const BLACKLIST_PATH = path.join(DATA, 'blacklist.json');
const HALL_PATH = path.join(DATA, 'hall-of-fame.json');
const SETTINGS_PATH = path.join(DATA, 'settings.json');

let blacklist = new Set(readJson(BLACKLIST_PATH, []).map(String));

const savedSettings = readJson(SETTINGS_PATH, {});
const game = new Game(Object.assign({}, config.game, savedSettings), {
  onWinner: (winner, hall) => {
    const today = new Date().toISOString().slice(0, 10);
    const store = readJson(HALL_PATH, {});
    store[today] = hall;
    writeJson(HALL_PATH, store);
    log('win', `👑 Tur ${winner.round} kazananı: ${winner.name} (${winner.power} güç, ${winner.players} oyuncu)`);
  }
});
game.extraBadWords = config.extraBadWords || [];
{
  const today = new Date().toISOString().slice(0, 10);
  game.hall = (readJson(HALL_PATH, {})[today] || []).slice(0, game.settings.hallSize);
}

/* ---------------- Günlük (log) ---------------- */

const logBuffer = [];
function log(level, msg) {
  const line = { t: Date.now(), level, msg };
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
  const stamp = new Date().toLocaleTimeString('tr-TR');
  console.log(`[${stamp}] ${msg}`);
  broadcast('log', line, 'panel');
}

/* ---------------- SSE yayını ---------------- */

const clients = new Set(); // {res, kind}
function broadcast(event, data, onlyKind) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (onlyKind && c.kind !== onlyKind) continue;
    try { c.res.write(payload); } catch { /* bağlantı kopmuş */ }
  }
}

game.on(ev => broadcast('game', ev));

function fullState() {
  return Object.assign(game.snapshot(), { live: liveStatus() });
}

setInterval(() => {
  game.tick(Date.now());
}, 100);
setInterval(() => {
  broadcast('state', fullState());
}, 250);
setInterval(() => {
  for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { } }
}, 15000);

/* ---------------- TikTok LIVE bağlantısı ---------------- */

const live = {
  wanted: false,
  connected: false,
  connecting: false,
  username: config.tiktokUsername || '',
  conn: null,
  giftMap: {},
  retry: 0,
  retryTimer: null,
  lastError: '',
  libMissing: false,
  stats: { gifts: 0, likes: 0, joins: 0, diamonds: 0 }
};

function liveStatus() {
  return {
    connected: live.connected, connecting: live.connecting, wanted: live.wanted,
    username: live.username, lastError: live.lastError, libMissing: live.libMissing,
    stats: live.stats
  };
}

let libCache = null;
async function loadLib() {
  if (libCache) return libCache;
  let mod;
  try {
    mod = await import('tiktok-live-connector');
  } catch (e) {
    live.libMissing = true;
    throw new Error('tiktok-live-connector kurulu değil. Proje klasöründe "npm install" çalıştır.');
  }
  const lib = (mod.TikTokLiveConnection || mod.WebcastPushConnection) ? mod : (mod.default || mod);
  const Conn = lib.TikTokLiveConnection || lib.WebcastPushConnection;
  if (!Conn) throw new Error('tiktok-live-connector sürümü tanınmadı.');
  libCache = { lib, Conn };
  return libCache;
}

/** Kütüphanenin farklı sürümlerindeki veri yapılarını tek tipe çevirir */
function normalizeUser(data) {
  const u = data.user || data;
  const uniqueId = u.uniqueId || data.uniqueId || '';
  const id = String(u.userId || data.userId || uniqueId);
  const nickname = u.nickname || data.nickname || uniqueId;
  const pic = u.profilePicture || data.profilePicture || {};
  const avatar =
    (Array.isArray(pic.url) && pic.url[0]) ||
    (Array.isArray(pic.urls) && pic.urls[0]) ||
    (Array.isArray(pic.urlList) && pic.urlList[0]) ||
    (typeof pic === 'string' && pic) ||
    data.profilePictureUrl || u.profilePictureUrl ||
    (u.avatarThumb && u.avatarThumb.urlList && u.avatarThumb.urlList[0]) || null;
  const name = config.nameSource === 'nickname' ? (nickname || uniqueId) : (uniqueId || nickname);
  return { id, uniqueId, name, avatar };
}

function normalizeGift(data) {
  const d = data.giftDetails || data.gift || {};
  const ext = data.extendedGiftInfo || {};
  const giftId = Number(data.giftId || d.id || d.giftId || ext.id || 0);
  const known = live.giftMap[giftId] || {};
  return {
    giftId,
    giftName: d.giftName || d.name || data.giftName || ext.name || known.name || '',
    diamonds: Number(d.diamondCount || data.diamondCount || ext.diamond_count || ext.diamondCount || known.diamonds || 1),
    giftType: Number(d.giftType !== undefined ? d.giftType : (data.giftType !== undefined ? data.giftType : ext.type)),
    count: Number(data.repeatCount || 1),
    repeatEnd: data.repeatEnd === true || data.repeatEnd === 1
  };
}

function onGift(data) {
  try {
    const user = normalizeUser(data);
    const gift = normalizeGift(data);
    // Seri (combo) hediyelerde sadece seri bittiğinde say — aynı hediyeyi iki kez saymamak için
    if (gift.giftType === 1 && !gift.repeatEnd) return;
    if (blacklist.has(user.id) || blacklist.has(user.uniqueId)) return;
    live.stats.gifts += gift.count;
    live.stats.diamonds += gift.diamonds * gift.count;
    const r = game.handleGift(user, gift, Date.now());
    if (r.joined) live.stats.joins++;
    log('gift', `🎁 ${user.uniqueId}: ${gift.giftName || 'hediye#' + gift.giftId} ×${gift.count} (${gift.diamonds} elmas)` +
      (r.joined ? ' → oyuna katıldı' : r.queued ? ' → sonraki tura sırada' : r.reason === 'not-joined' ? ' → önce gül atmalı' : ''));
  } catch (e) { log('warn', 'Hediye işlenemedi: ' + e.message); }
}

function onLike(data) {
  try {
    const user = normalizeUser(data);
    if (blacklist.has(user.id) || blacklist.has(user.uniqueId)) return;
    const n = Number(data.likeCount || 1);
    live.stats.likes += n;
    game.handleLike(user, n, Date.now());
  } catch (e) { /* sessiz */ }
}

async function connectLive(username) {
  username = String(username || '').trim().replace(/^@/, '');
  if (!username) throw new Error('TikTok kullanıcı adı boş.');
  await disconnectLive(true);
  live.username = username;
  live.wanted = true;
  live.connecting = true;
  live.lastError = '';
  broadcast('state', fullState());

  try {
    const { lib, Conn } = await loadLib();
    const opts = { enableExtendedGiftInfo: true, processInitialData: false };
    if (config.signApiKey) {
      opts.signApiKey = config.signApiKey;
      if (lib.SignConfig) lib.SignConfig.apiKey = config.signApiKey;
    }
    const conn = new Conn(username, opts);
    live.conn = conn;
    const EV = lib.WebcastEvent || {};
    const CE = lib.ControlEvent || {};

    conn.on(EV.GIFT || 'gift', onGift);
    conn.on(EV.LIKE || 'like', onLike);
    conn.on(EV.STREAM_END || 'streamEnd', () => {
      log('warn', '📴 Canlı yayın sona erdi.');
      live.wanted = false;
      markDisconnected();
    });
    conn.on(CE.DISCONNECTED || 'disconnected', () => {
      if (live.conn !== conn) return;
      log('warn', '⚠️ TikTok bağlantısı koptu.');
      markDisconnected();
      scheduleReconnect();
    });
    conn.on(CE.ERROR || 'error', err => {
      const m = (err && (err.info || err.message)) || String(err);
      log('warn', 'TikTok hata: ' + m);
    });

    await conn.connect();
    live.connected = true;
    live.connecting = false;
    live.retry = 0;
    game.removeTestPlayers(); // Canlıya geçince test oyuncuları otomatik silinir
    log('ok', `✅ @${username} canlı yayınına bağlanıldı. Test modu kapatıldı.`);

    try {
      const gifts = await (conn.fetchAvailableGifts ? conn.fetchAvailableGifts() : conn.getAvailableGifts());
      for (const g of gifts || []) live.giftMap[Number(g.id)] = { name: g.name, diamonds: g.diamond_count || g.diamondCount };
      log('info', `Hediye listesi yüklendi (${Object.keys(live.giftMap).length} hediye).`);
    } catch { /* zorunlu değil */ }
  } catch (e) {
    live.connecting = false;
    live.connected = false;
    live.lastError = humanError(e);
    log('warn', '❌ Bağlanılamadı: ' + live.lastError);
    if (live.libMissing) live.wanted = false; else scheduleReconnect();
  }
  broadcast('state', fullState());
}

function humanError(e) {
  const m = String((e && (e.message || e.info)) || e);
  if (/offline|not live|isn't online|LIVE has ended|status 4/i.test(m)) return 'Kullanıcı şu an canlı yayında değil. Önce yayını aç, sonra bağlan.';
  if (/user_not_found|not found/i.test(m)) return 'Bu kullanıcı adı bulunamadı.';
  if (/rate|429|sign/i.test(m)) return 'İmza servisi sınırına takıldı. Biraz bekle ya da config.json içine signApiKey ekle. (' + m + ')';
  return m;
}

function markDisconnected() {
  live.connected = false;
  live.connecting = false;
  broadcast('state', fullState());
}

function scheduleReconnect() {
  if (!live.wanted || live.retryTimer) return;
  live.retry++;
  const delay = Math.min(60000, 5000 * live.retry);
  log('info', `🔁 ${Math.round(delay / 1000)} sn sonra tekrar bağlanmayı deneyeceğim (deneme ${live.retry}).`);
  live.retryTimer = setTimeout(() => {
    live.retryTimer = null;
    if (live.wanted) connectLive(live.username).catch(() => { });
  }, delay);
}

async function disconnectLive(silent) {
  live.wanted = false;
  if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
  const c = live.conn;
  live.conn = null;
  if (c) { try { await c.disconnect(); } catch { } }
  live.connected = false;
  live.connecting = false;
  if (!silent) log('info', 'Bağlantı kapatıldı.');
}

/* ---------------- Test araçları (sadece canlıya bağlı değilken) ---------------- */

const TEST_NAMES = ['zeynep.k', 'mert_34', 'ayse.yildiz', 'kaan', 'elif_nur', 'burak.tr', 'selin06', 'emre.can', 'deniz', 'yusuf_61', 'irem.s', 'can_kurbaga', 'melis', 'arda.07', 'ece_35', 'baris', 'nehir', 'kerem_01', 'asli.d', 'onur'];
let testCounter = 0;
function testUser(name) {
  testCounter++;
  const n = name || TEST_NAMES[Math.floor(Math.random() * TEST_NAMES.length)] + '_' + testCounter;
  return { id: 'test:' + n, uniqueId: n, name: n, avatar: null, isTest: true };
}
function randomTestPlayer() {
  const ps = [...game.players.values()].filter(p => p.isTest && p.alive);
  return ps[Math.floor(Math.random() * ps.length)];
}

/* ---------------- HTTP ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const api = {
  'GET /api/state': () => fullState(),
  'GET /api/logs': () => logBuffer,
  'GET /api/blacklist': () => [...blacklist],

  'POST /api/connect': async b => { connectLive(b.username || live.username).catch(() => { }); return { ok: true }; },
  'POST /api/disconnect': async () => { await disconnectLive(); broadcast('state', fullState()); return { ok: true }; },

  'POST /api/round/fight': () => ({ ok: game.startFight(Date.now()) }),
  'POST /api/round/reset': () => { game.reset(Date.now()); log('info', 'Tur sıfırlandı.'); return { ok: true }; },
  'POST /api/round/add-time': b => {
    const s = Number(b.seconds) || 30;
    if (game.phase === 'lobby' && game.roundEndsAt) game.roundEndsAt += s * 1000;
    return { ok: true };
  },
  'POST /api/settings': b => {
    game.updateSettings(b || {});
    writeJson(SETTINGS_PATH, game.settings);
    log('info', 'Ayarlar güncellendi.');
    return { ok: true, settings: game.settings };
  },
  'POST /api/player/kick': b => { const ok = game.kick(b.id); if (ok) log('info', 'Oyuncu oyundan çıkarıldı: ' + b.id); return { ok }; },
  'POST /api/player/ban': b => {
    const id = String(b.id || '');
    if (!id) return { ok: false };
    blacklist.add(id);
    if (b.uniqueId) blacklist.add(String(b.uniqueId));
    writeJson(BLACKLIST_PATH, [...blacklist]);
    game.kick(id, 'ban');
    log('info', '⛔ Kara listeye eklendi: ' + (b.uniqueId || id));
    return { ok: true };
  },
  'POST /api/player/unban': b => {
    blacklist.delete(String(b.id));
    writeJson(BLACKLIST_PATH, [...blacklist]);
    return { ok: true };
  },
  'POST /api/winner/hide-avatar': b => { game.hideWinnerAvatar(b.hidden !== false); return { ok: true }; },
  'POST /api/curtain': b => { game.curtain = !!b.on; log('info', game.curtain ? '🛑 Mola ekranı AÇIK' : 'Mola ekranı kapandı'); return { ok: true }; },

  // ---- Test araçları ----
  'POST /api/test/join': b => {
    const n = Math.min(50, Math.max(1, Number(b.count) || 1));
    for (let i = 0; i < n; i++) game.handleGift(testUser(b.name), { giftId: 5655, giftName: 'Rose', diamonds: 1, count: 1 }, Date.now());
    return { ok: true };
  },
  'POST /api/test/likes': () => {
    for (const p of [...game.players.values()].filter(p => p.isTest)) game.handleLike({ id: p.id }, 1 + Math.floor(Math.random() * 15), Date.now());
    return { ok: true };
  },
  'POST /api/test/gift': b => {
    const p = randomTestPlayer();
    if (!p) return { ok: false, error: 'Önce test oyuncusu ekle.' };
    const gifts = { small: ['Finger Heart', 5], medium: ['Perfume', 20], big: ['Galaxy', 1000], huge: ['Lion', 29999] };
    const [name, diamonds] = gifts[b.size] || gifts.small;
    game.handleGift({ id: p.id }, { giftId: 1, giftName: name, diamonds, count: 1 }, Date.now());
    return { ok: true };
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const client = { res, kind: url.searchParams.get('kind') === 'panel' ? 'panel' : 'overlay' };
    clients.add(client);
    res.write(`event: state\ndata: ${JSON.stringify(fullState())}\n\n`);
    req.on('close', () => clients.delete(client));
    return;
  }

  const key = req.method + ' ' + p;
  if (api[key]) {
    if (p.startsWith('/api/test/') && live.connected) {
      return sendJson(res, 403, { ok: false, error: 'Canlı yayına bağlıyken test araçları kapalıdır.' });
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await api[key](body);
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (p === '/' || p === '/panel') return serveStatic(res, 'panel.html');
  if (p === '/overlay') return serveStatic(res, 'overlay.html');
  return serveStatic(res, p.replace(/^\/+/, ''));
});

server.listen(config.port, config.host, () => {
  const base = `http://localhost:${config.port}`;
  console.log('\n  🐸👑  KURBAĞA PRENS hazır\n');
  console.log(`  Kontrol paneli : ${base}/panel`);
  console.log(`  Oyun ekranı    : ${base}/overlay   (OBS / LIVE Studio → Tarayıcı kaynağı, 1080×1920)\n`);
  if (config.autoConnect && config.tiktokUsername) connectLive(config.tiktokUsername).catch(() => { });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  ❌ ${config.port} portu kullanımda. Program zaten açık olabilir ya da config.json'da "port" değerini değiştir.\n`);
  else console.error(e);
  process.exit(1);
});

process.on('unhandledRejection', e => log('warn', 'Beklenmeyen hata: ' + (e && e.message || e)));
