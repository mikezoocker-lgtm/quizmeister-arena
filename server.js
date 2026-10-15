'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'quizmeister';
if (!process.env.HOST_PASSWORD) console.warn('[Quizmeister] HOST_PASSWORD ist nicht gesetzt – Standardpasswort "quizmeister" aktiv!');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000, maxHttpBufferSize: 60e6 });

const PUB = path.join(__dirname, 'public');
const rooms = new Map();
const media = new Map();
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
// Hochgeladene Bilder (data:-URLs) werden im RAM abgelegt und als kurze /media/-URL ausgeliefert
function storeMedia(src) {
  src = String(src || '').trim();
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(src);
  if (!m) return src.slice(0, 2000);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8e6) return '';
  const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
  if (!media.has(id)) media.set(id, { type: m[1], buf });
  return '/media/' + id + '.' + EXT[m[1]];
}

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
['host', 'play', 'watch'].forEach(p => app.get('/' + p, (req, res) => res.sendFile(path.join(PUB, p + '.html'))));
app.get('/join/:code', (req, res) => res.redirect('/play?room=' + encodeURIComponent(String(req.params.code).toUpperCase())));
app.get('/media/:id', (req, res) => {
  const m = media.get(String(req.params.id).split('.')[0]);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m.type).set('Cache-Control', 'public, max-age=31536000, immutable').send(m.buf);
});
app.use(express.static(PUB));

// ---------- Konstanten ----------
const COLORS = ['#ff5d73', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#20c997', '#f06595', '#94d82d', '#748ffc', '#e8590c', '#15aabf'];
const DEFAULT_SETTINGS = {
  answerTime: 30, buzzAnswerTime: 15, buzzOpenTime: 0, buzzWindow: 400,
  penaltyBuzz: true, pickBy: 'host', textAnswers: false, fairBuzz: true, numCats: 5, numLevels: 5
};
const LIMITS = { answerTime: [5, 300], buzzAnswerTime: [5, 300], buzzOpenTime: [0, 300], buzzWindow: [0, 2000], numCats: [3, 6], numLevels: [3, 6] };
const MIN_REACTION = 80;
const MAX_PLAYERS = 30;

const token = () => crypto.randomBytes(16).toString('hex');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- Fragen ----------
function normalizeQuestions(q) {
  if (Array.isArray(q)) q = { categories: q };
  const cats = q && Array.isArray(q.categories) ? q.categories : [];
  return {
    categories: cats.slice(0, 12).map((c, ci) => ({
      name: String((c && c.name) || `Kategorie ${ci + 1}`).slice(0, 80),
      questions: (c && Array.isArray(c.questions) ? c.questions : []).slice(0, 12).map((x, li) => {
        x = x || {};
        const v = Math.round(Number(x.value));
        return {
          value: Number.isFinite(v) && v > 0 ? v : (li + 1) * 100,
          question: String(x.question || '').slice(0, 1000),
          answer: String(x.answer || '').slice(0, 1000),
          image: storeMedia(x.image),
          answerImage: storeMedia(x.answerImage)
        };
      })
    }))
  };
}
function loadQuestions() {
  try { return normalizeQuestions(JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'))); }
  catch (e) { console.error('[Quizmeister] questions.json konnte nicht gelesen werden:', e.message); return { categories: [] }; }
}
const DEFAULT_QUESTIONS = loadQuestions();

// ---------- Räume & Spieler ----------
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function createRoom() {
  const room = {
    code: makeCode(), hostToken: token(), hostSocket: null, hostOnline: false, hostPaused: false, manualPause: false,
    players: new Map(), order: [], settings: { ...DEFAULT_SETTINGS }, questions: clone(DEFAULT_QUESTIONS),
    used: new Set(), phase: 'lobby', selector: null, current: null, history: [], buzzSeq: 0, earlyLock: new Map(),
    timerHandle: null, windowHandle: null, lastActivity: Date.now()
  };
  rooms.set(room.code, room);
  return room;
}
function cleanName(n) { return String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 24); }
function nameTaken(room, name, exceptId) {
  const n = name.toLowerCase();
  for (const p of room.players.values()) if (p.id !== exceptId && p.name.toLowerCase() === n) return true;
  return false;
}
function addPlayer(room, name) {
  const usedColors = new Set([...room.players.values()].map(p => p.color));
  const color = COLORS.find(c => !usedColors.has(c)) || COLORS[room.order.length % COLORS.length];
  const p = { id: 'p' + crypto.randomBytes(5).toString('hex'), token: token(), name, color, score: 0, online: false, socketId: null, rtt: null };
  room.players.set(p.id, p);
  room.order.push(p.id);
  return p;
}
function nextPlayer(room, fromId) {
  const o = room.order;
  if (!o.length) return null;
  const i = o.indexOf(fromId);
  return o[(i + 1) % o.length];
}

// ---------- Board ----------
function cellQ(room, c, l) { const cat = room.questions.categories[c]; return (cat && cat.questions[l]) || null; }
function boardKeys(room) {
  const out = [];
  for (let c = 0; c < room.settings.numCats; c++) for (let l = 0; l < room.settings.numLevels; l++) if (cellQ(room, c, l)) out.push(c + '-' + l);
  return out;
}
function allUsed(room) { const k = boardKeys(room); return k.length > 0 && k.every(x => room.used.has(x)); }
function boardView(room) {
  return room.questions.categories.slice(0, room.settings.numCats).map((cat, c) => ({
    name: cat.name,
    cells: Array.from({ length: room.settings.numLevels }, (_, l) => {
      const q = cat.questions[l];
      return q ? { value: q.value, used: room.used.has(c + '-' + l) } : null;
    })
  }));
}

// ---------- Sounds ----------
function sfx(room, type) { io.to(['pub:' + room.code, 'host:' + room.code]).emit('sfx', type); }

// ---------- Timer (serverseitig, Endzeitstempel) ----------
function clearTimer(room) { clearTimeout(room.timerHandle); room.timerHandle = null; }
function clearWindow(room) { clearTimeout(room.windowHandle); room.windowHandle = null; }
function isPaused(room) { return room.manualPause || room.hostPaused; }
function schedule(room) {
  clearTimer(room);
  const t = room.current && room.current.timer;
  if (!t || t.paused) return;
  const id = t.id;
  room.timerHandle = setTimeout(() => onTimeout(room, id), Math.max(0, t.endsAt - Date.now()));
}
function syncPause(room) {
  const t = room.current && room.current.timer;
  if (!t) return;
  const want = isPaused(room);
  if (want && !t.paused) { t.remaining = Math.max(0, t.endsAt - Date.now()); t.paused = true; clearTimer(room); }
  else if (!want && t.paused) { t.endsAt = Date.now() + t.remaining; t.paused = false; schedule(room); }
}
function startTimer(room, kind, seconds) {
  clearTimer(room);
  room.manualPause = false;
  const cur = room.current;
  if (!cur) return;
  if (!(seconds > 0)) { cur.timer = null; return; }
  const d = seconds * 1000;
  cur.timer = { id: crypto.randomBytes(4).toString('hex'), kind, duration: d, endsAt: Date.now() + d, remaining: d, paused: false };
  syncPause(room);
  schedule(room);
}
function onTimeout(room, id) {
  const cur = room.current;
  if (!cur || !cur.timer || cur.timer.id !== id) return;
  room.timerHandle = null;
  const kind = cur.timer.kind;
  cur.timer = null;
  try {
    if (kind === 'answer' || kind === 'buzz') judge(room, false, true);
    else if (kind === 'open') {
      if (cur.pending.length) resolveBuzz(room);
      else { sfx(room, 'timeout'); finishQuestion(room, 'noBuzz'); }
    }
  } catch (e) { console.error(e); }
  broadcast(room);
}
function timerView(t) {
  return t ? { kind: t.kind, duration: t.duration, endsAt: t.endsAt, remaining: t.paused ? t.remaining : Math.max(0, t.endsAt - Date.now()), paused: t.paused } : null;
}

// ---------- Punkte ----------
function addScore(room, id, delta, reason, track = true) {
  const p = room.players.get(id);
  if (!p || !delta) return;
  p.score += delta;
  const e = { playerId: id, delta, reason, at: Date.now() };
  room.history.push(e);
  if (room.history.length > 300) room.history.shift();
  if (track && room.current) room.current.deltas.push(e);
}

// ---------- Spielablauf ----------
function pick(room, c, l) {
  if (room.phase !== 'board') throw new Error('Gerade kann kein Feld gewählt werden.');
  if (room.hostPaused) throw new Error('Spiel ist pausiert.');
  if (c < 0 || l < 0 || c >= room.settings.numCats || l >= room.settings.numLevels) throw new Error('Ungültiges Feld.');
  const q = cellQ(room, c, l), key = c + '-' + l;
  if (!q || room.used.has(key)) throw new Error('Dieses Feld ist nicht verfügbar.');
  room.current = {
    c, l, key, value: q.value, question: q.question, answer: q.answer, image: q.image, answerImage: q.answerImage,
    category: room.questions.categories[c].name, answerer: null, firstAnswerer: null, lockedOut: new Set(),
    timer: null, buzzSeq: 0, buzzOpenAt: 0, pending: [], buzzLog: [], textAnswers: {}, deltas: [],
    revealed: false, lastWrong: null, endReason: null
  };
  sfx(room, 'reveal');
  const sel = room.selector && room.players.has(room.selector) ? room.selector : null;
  if (sel) {
    room.current.answerer = sel;
    room.current.firstAnswerer = sel;
    room.phase = 'question';
    startTimer(room, 'answer', room.settings.answerTime);
  } else openBuzz(room);
}
function eligible(room) {
  const cur = room.current;
  return room.order.filter(id => { const p = room.players.get(id); return p && p.online && !cur.lockedOut.has(id); });
}
function openBuzz(room) {
  const cur = room.current;
  clearWindow(room);
  cur.answerer = null;
  cur.pending = [];
  if (!eligible(room).length) { finishQuestion(room, 'noneLeft'); return; }
  room.phase = 'buzzOpen';
  cur.buzzSeq = ++room.buzzSeq;
  cur.buzzOpenAt = Date.now();
  startTimer(room, 'open', room.settings.buzzOpenTime);
  sfx(room, 'open');
}
function handleBuzz(room, p, data) {
  const now = Date.now(), cur = room.current;
  const lock = room.earlyLock.get(p.id) || 0;
  if (lock > now) return { ok: false, locked: true, until: lock - now };
  if (!cur || cur.lockedOut.has(p.id) || cur.answerer === p.id) return { ok: false, ignored: true };
  if (room.hostPaused) return { ok: false, paused: true };
  if (room.phase !== 'buzzOpen' || data.seq !== cur.buzzSeq) {
    if (['question', 'buzzAnswer', 'buzzOpen'].includes(room.phase)) { room.earlyLock.set(p.id, now + 1000); return { ok: false, early: true, until: 1000 }; }
    return { ok: false };
  }
  if (cur.pending.some(b => b.playerId === p.id)) return { ok: true, already: true };

  const serverElapsed = now - cur.buzzOpenAt;
  const rtt = p.rtt == null ? 150 : p.rtt;
  const reaction = Number(data.reaction);
  const entry = {
    playerId: p.id, name: p.name, reaction: Number.isFinite(reaction) ? Math.round(reaction) : null,
    rtt: Math.round(rtt), serverElapsed, compensated: serverElapsed, flag: null, winner: false, discarded: false
  };
  if (room.settings.fairBuzz) {
    const est = Math.max(0, Math.round(serverElapsed - rtt));
    if (!Number.isFinite(reaction) || reaction < 0) { entry.flag = 'Keine gültige Zeit – Serverschätzung verwendet'; entry.compensated = est; }
    else if (reaction < MIN_REACTION) { entry.flag = `Unter ${MIN_REACTION} ms – verworfen`; entry.discarded = true; }
    else if (reaction > serverElapsed + 100) { entry.flag = 'Zeit größer als Servermessung – Serverschätzung verwendet'; entry.compensated = est; }
    else if (reaction < serverElapsed - rtt - Math.max(300, rtt)) { entry.flag = 'Zeit zu klein für gemessene Latenz – Serverschätzung verwendet'; entry.compensated = est; }
    else entry.compensated = Math.round(reaction);
  }
  cur.buzzLog.push(entry);
  if (entry.discarded) { room.earlyLock.set(p.id, now + 1000); return { ok: false, discarded: true, until: 1000 }; }
  cur.pending.push(entry);
  if (!room.settings.fairBuzz || room.settings.buzzWindow <= 0) resolveBuzz(room);
  else if (cur.pending.length === 1) {
    room.windowHandle = setTimeout(() => {
      room.windowHandle = null;
      if (room.current === cur && room.phase === 'buzzOpen') { resolveBuzz(room); broadcast(room); }
    }, room.settings.buzzWindow);
  }
  return { ok: true };
}
function resolveBuzz(room) {
  const cur = room.current;
  clearWindow(room);
  if (!cur || !cur.pending.length) return;
  const w = cur.pending.slice().sort((a, b) => a.compensated - b.compensated || a.serverElapsed - b.serverElapsed)[0];
  w.winner = true;
  cur.pending = [];
  cur.answerer = w.playerId;
  room.phase = 'buzzAnswer';
  startTimer(room, 'buzz', room.settings.buzzAnswerTime);
  sfx(room, 'buzz');
}
function judge(room, correct, timeout = false) {
  const cur = room.current;
  if (!cur || !cur.answerer || !['question', 'buzzAnswer'].includes(room.phase)) throw new Error('Gerade antwortet niemand.');
  const id = cur.answerer, first = room.phase === 'question';
  clearTimer(room);
  cur.timer = null;
  if (correct) {
    addScore(room, id, cur.value, 'richtig');
    room.selector = id;
    sfx(room, 'correct');
    finishQuestion(room, 'correct');
  } else {
    if (first || room.settings.penaltyBuzz) addScore(room, id, -Math.floor(cur.value / 2), timeout ? 'Zeit abgelaufen' : 'falsch');
    cur.lockedOut.add(id);
    cur.lastWrong = { playerId: id, timeout };
    sfx(room, timeout ? 'timeout' : 'wrong');
    openBuzz(room);
  }
}
function finishQuestion(room, reason) {
  const cur = room.current;
  if (!cur) return;
  clearTimer(room); clearWindow(room);
  cur.timer = null;
  cur.revealed = true;
  cur.endReason = reason;
  if (reason !== 'correct') { cur.answerer = null; room.selector = nextPlayer(room, room.selector); }
  room.used.add(cur.key);
  room.phase = 'reveal';
}
function continueGame(room) {
  if (room.phase !== 'reveal') throw new Error('Keine aufgedeckte Frage.');
  room.current = null;
  if (allUsed(room)) { room.phase = 'end'; sfx(room, 'fanfare'); }
  else room.phase = 'board';
}
function returnQuestion(room) {
  const cur = room.current;
  if (!cur) throw new Error('Keine offene Frage.');
  clearTimer(room); clearWindow(room);
  for (const d of cur.deltas) {
    const p = room.players.get(d.playerId);
    if (p) p.score -= d.delta;
    const i = room.history.indexOf(d);
    if (i >= 0) room.history.splice(i, 1);
  }
  room.used.delete(cur.key);
  room.current = null;
  room.phase = 'board';
}
function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) throw new Error('Spieler nicht gefunden.');
  const nxt = room.order.length > 1 ? nextPlayer(room, id) : null;
  if (p.socketId) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) { s.emit('kicked'); s.leave('pub:' + room.code); s.data.playerId = null; s.data.room = null; }
  }
  room.players.delete(id);
  room.order = room.order.filter(x => x !== id);
  if (room.selector === id) room.selector = nxt;
  const cur = room.current;
  if (cur) {
    cur.pending = cur.pending.filter(b => b.playerId !== id);
    if (cur.answerer === id && ['question', 'buzzAnswer'].includes(room.phase)) { clearTimer(room); cur.timer = null; cur.lockedOut.add(id); openBuzz(room); }
  }
}
function applySettings(room, patch) {
  const s = room.settings;
  for (const [k, [a, b]] of Object.entries(LIMITS)) if (k in patch) { const v = Math.round(Number(patch[k])); if (Number.isFinite(v)) s[k] = clamp(v, a, b); }
  for (const k of ['penaltyBuzz', 'textAnswers', 'fairBuzz']) if (k in patch) s[k] = !!patch[k];
}

function hostCommand(room, type, a) {
  const P = () => { const p = room.players.get(a.id); if (!p) throw new Error('Spieler nicht gefunden.'); return p; };
  switch (type) {
    case 'start': {
      if (!room.order.length) throw new Error('Es sind noch keine Spieler im Raum.');
      if (room.phase !== 'lobby') throw new Error('Das Spiel läuft bereits.');
      room.selector = a.starter && room.players.has(a.starter) ? a.starter : room.order[crypto.randomInt(room.order.length)];
      room.phase = allUsed(room) ? 'end' : 'board';
      return;
    }
    case 'pick': return pick(room, a.c | 0, a.l | 0);
    case 'judge': return judge(room, !!a.correct);
    case 'reveal': if (room.current) room.current.revealed = true; return;
    case 'endQuestion':
      if (!room.current || room.phase === 'reveal') throw new Error('Keine laufende Frage.');
      sfx(room, 'timeout');
      return finishQuestion(room, 'ended');
    case 'returnQuestion': return returnQuestion(room);
    case 'continue': return continueGame(room);
    case 'pause':
      if (!room.current || !room.current.timer) throw new Error('Kein Timer aktiv.');
      room.manualPause = !room.manualPause; syncPause(room); return;
    case 'addTime': {
      const t = room.current && room.current.timer;
      if (!t) throw new Error('Kein Timer aktiv.');
      t.duration += 10000;
      if (t.paused) t.remaining += 10000; else { t.endsAt += 10000; schedule(room); }
      return;
    }
    case 'undo': {
      const e = room.history.pop();
      if (!e) throw new Error('Nichts zum Rückgängigmachen.');
      const p = room.players.get(e.playerId);
      if (p) p.score -= e.delta;
      if (room.current) { const i = room.current.deltas.indexOf(e); if (i >= 0) room.current.deltas.splice(i, 1); }
      return { ok: true, msg: `Rückgängig: ${p ? p.name : '?'} ${e.delta > 0 ? '−' : '+'}${Math.abs(e.delta)}` };
    }
    case 'newGame':
      clearTimer(room); clearWindow(room);
      room.players.forEach(p => { p.score = 0; });
      room.used.clear(); room.current = null; room.history = []; room.selector = null;
      room.phase = 'lobby'; room.manualPause = false; room.earlyLock.clear();
      return;
    case 'settings': applySettings(room, a.patch || {}); return;
    case 'questions': room.questions = normalizeQuestions(a.data); return;
    case 'addPlayer': {
      const n = cleanName(a.name);
      if (!n) throw new Error('Bitte einen Namen angeben.');
      if (nameTaken(room, n)) throw new Error('Dieser Name ist schon vergeben.');
      if (room.players.size >= MAX_PLAYERS) throw new Error('Maximale Spielerzahl erreicht.');
      addPlayer(room, n); return;
    }
    case 'renamePlayer': {
      const p = P(), n = cleanName(a.name);
      if (!n) throw new Error('Name darf nicht leer sein.');
      if (nameTaken(room, n, p.id)) throw new Error('Dieser Name ist schon vergeben.');
      p.name = n; return;
    }
    case 'colorPlayer': { const p = P(); if (/^#[0-9a-f]{6}$/i.test(a.color)) p.color = a.color; return; }
    case 'removePlayer': return removePlayer(room, a.id);
    case 'adjust': {
      P();
      const d = Math.round(Number(a.delta));
      if (!Number.isFinite(d) || !d) throw new Error('Ungültiger Wert.');
      addScore(room, a.id, d, 'manuell', false); return;
    }
    case 'setSelector': P(); room.selector = a.id; return;
    default: throw new Error('Unbekannter Befehl.');
  }
}

// ---------- Zustand ----------
function publicState(room) {
  const cur = room.current, s = room.settings;
  return {
    code: room.code, phase: room.phase, hostOnline: room.hostOnline, hostPaused: room.hostPaused, manualPause: room.manualPause,
    settings: { pickBy: s.pickBy, textAnswers: s.textAnswers, numCats: s.numCats, numLevels: s.numLevels, fairBuzz: s.fairBuzz, penaltyBuzz: s.penaltyBuzz },
    board: boardView(room),
    players: room.order.map(id => { const p = room.players.get(id); return { id, name: p.name, color: p.color, score: p.score, online: p.online, rtt: p.rtt }; }),
    selector: room.selector,
    current: cur ? {
      c: cur.c, l: cur.l, category: cur.category, value: cur.value, question: cur.question, image: cur.image,
      answerer: cur.answerer, firstAnswerer: cur.firstAnswerer, lockedOut: [...cur.lockedOut], timer: timerView(cur.timer),
      buzzSeq: room.phase === 'buzzOpen' ? cur.buzzSeq : 0, revealed: cur.revealed, answer: cur.revealed ? cur.answer : null, answerImage: cur.revealed ? cur.answerImage : '',
      lastWrong: cur.lastWrong, endReason: cur.endReason
    } : null,
    serverNow: Date.now()
  };
}
function hostState(room) {
  const st = publicState(room);
  st.settings = { ...room.settings };
  st.questions = room.questions;
  st.historyCount = room.history.length;
  st.lastHistory = room.history[room.history.length - 1] || null;
  if (st.current) {
    st.current.answer = room.current.answer;
    st.current.answerImage = room.current.answerImage;
    st.current.buzzLog = room.current.buzzLog;
    st.current.textAnswers = room.current.textAnswers;
  }
  return st;
}
function broadcast(room) {
  io.to('pub:' + room.code).emit('state', publicState(room));
  io.to('host:' + room.code).emit('state', hostState(room));
}

function attachHost(room, socket) {
  if (room.hostSocket && room.hostSocket !== socket.id) {
    const old = io.sockets.sockets.get(room.hostSocket);
    if (old) { old.emit('host:replaced'); old.leave('host:' + room.code); old.data.hostRoom = null; }
  }
  room.hostSocket = socket.id; room.hostOnline = true; room.hostPaused = false;
  syncPause(room);
  socket.data.hostRoom = room.code;
  socket.join('host:' + room.code);
  room.lastActivity = Date.now();
}
function bindPlayer(room, p, socket) {
  if (p.socketId && p.socketId !== socket.id) {
    const old = io.sockets.sockets.get(p.socketId);
    if (old) { old.emit('replaced'); old.leave('pub:' + room.code); old.data.playerId = null; old.data.room = null; }
  }
  p.socketId = socket.id; p.online = true;
  if (socket.data.rtt != null) p.rtt = socket.data.rtt;
  socket.data.room = room.code; socket.data.playerId = p.id;
  socket.join('pub:' + room.code);
  room.lastActivity = Date.now();
}

// ---------- Sockets ----------
io.on('connection', socket => {
  socket.data.rtts = [];
  const ack = (cb, v) => { if (typeof cb === 'function') cb(v); };
  const getRoom = c => rooms.get(String(c || '').trim().toUpperCase());
  const ctx = () => {
    const room = socket.data.room && rooms.get(socket.data.room);
    const p = room && room.players.get(socket.data.playerId);
    return { room, p: p && p.socketId === socket.id ? p : null };
  };

  socket.on('tsync', (t0, cb) => ack(cb, Date.now()));

  socket.on('host:auth', (d, cb) => {
    if (d && d.password === HOST_PASSWORD) { socket.data.hostAuthed = true; ack(cb, { ok: true }); }
    else ack(cb, { ok: false, error: 'Falsches Passwort.' });
  });
  socket.on('host:create', (d, cb) => {
    if (!socket.data.hostAuthed) return ack(cb, { ok: false, error: 'Nicht angemeldet.' });
    const room = createRoom();
    attachHost(room, socket);
    ack(cb, { ok: true, code: room.code, hostToken: room.hostToken });
    broadcast(room);
  });
  socket.on('host:rejoin', (d, cb) => {
    if (!socket.data.hostAuthed) return ack(cb, { ok: false, error: 'Nicht angemeldet.' });
    const room = getRoom(d && d.code);
    if (!room || room.hostToken !== (d && d.hostToken)) return ack(cb, { ok: false, error: 'Runde nicht mehr vorhanden.' });
    attachHost(room, socket);
    ack(cb, { ok: true, code: room.code, hostToken: room.hostToken });
    broadcast(room);
  });
  socket.on('host:cmd', (d, cb) => {
    const room = socket.data.hostRoom && rooms.get(socket.data.hostRoom);
    if (!room || room.hostSocket !== socket.id) return ack(cb, { ok: false, error: 'Keine Host-Berechtigung.' });
    room.lastActivity = Date.now();
    let res;
    try { res = hostCommand(room, d && d.type, d || {}) || { ok: true }; }
    catch (e) { res = { ok: false, error: e.message }; }
    ack(cb, res);
    broadcast(room);
  });

  socket.on('player:join', (d, cb) => {
    const room = getRoom(d && d.code);
    if (!room) return ack(cb, { ok: false, error: 'Raum nicht gefunden. Prüfe den Code.' });
    const name = cleanName(d.name);
    if (!name) return ack(cb, { ok: false, error: 'Bitte gib einen Namen ein.' });
    if (nameTaken(room, name)) return ack(cb, { ok: false, error: 'Dieser Name ist schon vergeben.' });
    if (room.players.size >= MAX_PLAYERS) return ack(cb, { ok: false, error: 'Der Raum ist voll.' });
    const p = addPlayer(room, name);
    bindPlayer(room, p, socket);
    ack(cb, { ok: true, code: room.code, playerId: p.id, token: p.token });
    broadcast(room);
  });
  socket.on('player:rejoin', (d, cb) => {
    const room = getRoom(d && d.code);
    const p = room && room.players.get(d.playerId);
    if (!p || p.token !== d.token) return ack(cb, { ok: false, error: 'Deine Sitzung ist abgelaufen. Bitte neu beitreten.' });
    bindPlayer(room, p, socket);
    ack(cb, { ok: true, code: room.code, playerId: p.id, token: p.token });
    broadcast(room);
  });
  socket.on('player:buzz', (d, cb) => {
    const { room, p } = ctx();
    if (!p) return ack(cb, { ok: false });
    ack(cb, handleBuzz(room, p, d || {}));
    broadcast(room);
  });
  socket.on('player:text', (d, cb) => {
    const { room, p } = ctx();
    const cur = room && room.current;
    if (!p || !room.settings.textAnswers || !cur || cur.answerer !== p.id) return ack(cb, { ok: false, error: 'Gerade nicht möglich.' });
    cur.textAnswers[p.id] = { name: p.name, text: String((d && d.text) || '').slice(0, 300), at: Date.now() };
    ack(cb, { ok: true });
    broadcast(room);
  });
  socket.on('watch:join', (d, cb) => {
    const room = getRoom(d && d.code);
    if (!room) return ack(cb, { ok: false, error: 'Raum nicht gefunden.' });
    socket.join('pub:' + room.code);
    ack(cb, { ok: true, code: room.code });
    socket.emit('state', publicState(room));
  });

  socket.on('disconnect', () => {
    const hr = socket.data.hostRoom && rooms.get(socket.data.hostRoom);
    if (hr && hr.hostSocket === socket.id) {
      hr.hostSocket = null; hr.hostOnline = false; hr.hostPaused = true;
      syncPause(hr);
      broadcast(hr);
    }
    const { room, p } = ctx();
    if (p) { p.online = false; p.socketId = null; broadcast(room); }
  });
});

// ---------- Latenzmessung, Heartbeat, Aufräumen ----------
setInterval(() => {
  for (const s of io.sockets.sockets.values()) {
    const t = Date.now();
    s.timeout(5000).emit('lat', t, err => {
      if (err) return;
      const rtt = Date.now() - t;
      s.data.rtts = (s.data.rtts || []).concat(rtt).slice(-7);
      const sorted = [...s.data.rtts].sort((a, b) => a - b);
      s.data.rtt = sorted[Math.floor(sorted.length / 2)];
      const room = s.data.room && rooms.get(s.data.room);
      const p = room && room.players.get(s.data.playerId);
      if (p && p.socketId === s.id) p.rtt = s.data.rtt;
    });
  }
}, 2000);
setInterval(() => { for (const r of rooms.values()) if (r.hostOnline || r.players.size) broadcast(r); }, 4000);
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const anyOnline = r.hostOnline || [...r.players.values()].some(p => p.online);
    if (!anyOnline && now - r.lastActivity > 6 * 3600e3) { clearTimer(r); clearWindow(r); rooms.delete(code); }
  }
}, 10 * 60e3);

server.listen(PORT, () => console.log(`[Quizmeister] Arena läuft auf Port ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
