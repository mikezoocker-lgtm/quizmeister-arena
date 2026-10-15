(function () {
  'use strict';
  const Q = (window.Q = {});
  Q.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  Q.$ = (s, r) => (r || document).querySelector(s);
  Q.offset = 0;
  Q.rtt = null;
  Q.now = () => Date.now() + Q.offset;

  // ---------- Verbindung + Uhrsynchronisation ----------
  Q.connect = function () {
    const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
    const samples = [];
    function sync() {
      if (!socket.connected) return;
      const t0 = Date.now();
      socket.timeout(4000).emit('tsync', t0, (err, ts) => {
        if (err || typeof ts !== 'number') return;
        const t1 = Date.now(), rtt = t1 - t0;
        samples.push({ rtt, off: ts - (t0 + t1) / 2 });
        if (samples.length > 12) samples.shift();
        const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        Q.offset = best.off;
        Q.rtt = rtt;
      });
    }
    socket.on('connect', () => { samples.length = 0; [0, 200, 400, 700, 1000].forEach(d => setTimeout(sync, d)); });
    setInterval(sync, 5000);
    socket.on('lat', (t, cb) => { if (typeof cb === 'function') cb(); });
    socket.on('sfx', t => S.play(t));
    return socket;
  };

  // ---------- Sounds (Web Audio API) ----------
  const S = (Q.sound = {
    ctx: null, master: null,
    vol: parseFloat(localStorage.getItem('qa-vol') || '0.7'),
    muted: localStorage.getItem('qa-muted') === '1',
    init() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.master.gain.value = this.muted ? 0 : this.vol;
      return this.ctx;
    },
    tone(freq, at, dur, type, gain, to) {
      const c = this.ctx, t = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.3, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.05);
    },
    play(name) {
      if (this.muted || this.vol <= 0) return;
      if (!this.init()) return;
      const T = this.tone.bind(this);
      switch (name) {
        case 'buzz': T(220, 0, 0.45, 'square', 0.22); T(165, 0, 0.45, 'sawtooth', 0.15); break;
        case 'correct': [523, 659, 784].forEach((f, i) => T(f, i * 0.12, 0.14, 'triangle', 0.3)); T(1047, 0.36, 0.45, 'triangle', 0.3); break;
        case 'wrong': T(320, 0, 0.3, 'sawtooth', 0.2, 220); T(200, 0.3, 0.55, 'sawtooth', 0.2, 110); break;
        case 'timeout': [0, 0.22, 0.44].forEach(a => T(880, a, 0.14, 'square', 0.16)); T(440, 0.7, 0.6, 'square', 0.16); break;
        case 'open': T(660, 0, 0.08, 'sine', 0.25); T(990, 0.08, 0.2, 'sine', 0.25); break;
        case 'reveal': T(392, 0, 0.12, 'triangle', 0.25); T(587, 0.1, 0.28, 'triangle', 0.25); break;
        case 'early': T(150, 0, 0.22, 'square', 0.15); break;
        case 'fanfare': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => T(f, i * 0.15, i === 5 ? 0.9 : 0.18, 'triangle', 0.3)); break;
      }
    },
    set(vol, muted) {
      this.vol = vol; this.muted = muted;
      localStorage.setItem('qa-vol', String(vol));
      localStorage.setItem('qa-muted', muted ? '1' : '0');
      if (this.master) this.master.gain.value = muted ? 0 : vol;
    }
  });
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => S.init(), { once: true }));

  Q.mountSound = function (el) {
    if (!el) return;
    el.className = 'sound-ctl';
    el.innerHTML = '<button type="button" class="btn ghost sm"></button><input type="range" min="0" max="1" step="0.05" aria-label="Lautstärke">';
    const b = el.querySelector('button'), r = el.querySelector('input');
    const upd = () => { b.textContent = S.muted ? 'Ton aus' : 'Ton an'; b.classList.toggle('off', S.muted); r.value = S.vol; };
    b.onclick = () => { S.set(S.vol, !S.muted); upd(); if (!S.muted) S.play('open'); };
    r.oninput = () => { S.set(parseFloat(r.value), false); upd(); };
    r.onchange = () => S.play('open');
    upd();
  };

  // ---------- Toasts ----------
  Q.toast = function (msg, kind) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  };

  // ---------- Board ----------
  Q.renderBoard = function (el, st, opts) {
    opts = opts || {};
    const cats = st.board || [], levels = st.settings.numLevels, cur = st.current;
    const key = JSON.stringify([cats, levels, !!opts.canPick, cur ? cur.c + '-' + cur.l : '']);
    if (el._key === key) return;
    el._key = key;
    el.style.setProperty('--cols', cats.length || 1);
    let h = cats.map(c => `<div class="cat"><span>${Q.esc(c.name)}</span></div>`).join('');
    for (let l = 0; l < levels; l++) cats.forEach((c, ci) => {
      const cell = c.cells[l];
      if (!cell) { h += '<div class="cell empty"></div>'; return; }
      const isCur = cur && cur.c === ci && cur.l === l;
      const can = opts.canPick && !cell.used;
      h += `<button type="button" class="cell${cell.used ? ' used' : ''}${isCur ? ' current' : ''}${can ? ' pickable' : ''}" data-c="${ci}" data-l="${l}"${can ? '' : ' disabled'}>${cell.used ? '' : cell.value}</button>`;
    });
    el.innerHTML = h;
    if (opts.canPick) el.querySelectorAll('.cell.pickable').forEach(b => b.addEventListener('click', () => opts.onPick(+b.dataset.c, +b.dataset.l)));
  };

  // ---------- Punktestände ----------
  Q.renderScores = function (el, st, opts) {
    opts = opts || {};
    const cur = st.current, live = st.phase !== 'lobby' && st.phase !== 'end';
    el.innerHTML = st.players.map(p => {
      const tags = [];
      if (live && st.selector === p.id) tags.push('<span class="tag turn">am Zug</span>');
      if (cur && cur.answerer === p.id && (st.phase === 'question' || st.phase === 'buzzAnswer')) tags.push('<span class="tag answering">antwortet</span>');
      if (cur && cur.lockedOut.includes(p.id) && st.phase !== 'reveal') tags.push('<span class="tag locked">gesperrt</span>');
      return `<div class="score-card${live && st.selector === p.id ? ' is-turn' : ''}${opts.meId === p.id ? ' is-me' : ''}" style="--pc:${p.color}">
        <div class="sc-top"><span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'online' : 'offline'}"></span><span class="sc-name">${Q.esc(p.name)}${opts.meId === p.id ? ' <em>(du)</em>' : ''}</span></div>
        <div class="sc-score${p.score < 0 ? ' neg' : ''}">${p.score}</div>
        <div class="sc-tags">${tags.join('')}</div></div>`;
    }).join('') || '<div class="muted">Noch keine Spieler</div>';
  };

  // ---------- Timer ----------
  Q.timerHTML = '<div class="timer-head"><span class="timer-label"></span><span class="timer-num"></span></div><div class="timer-track"><div class="timer-fill"></div></div>';
  const LABELS = { answer: 'Antwortzeit', buzz: 'Antwort nach Buzzer', open: 'Buzzer offen' };
  Q.bindTimer = function (root, getTimer) {
    if (!root) return;
    root.innerHTML = Q.timerHTML;
    const fill = root.querySelector('.timer-fill'), num = root.querySelector('.timer-num'), lab = root.querySelector('.timer-label');
    (function frame() {
      const t = getTimer();
      if (!t) { root.classList.add('idle'); }
      else {
        root.classList.remove('idle');
        root.dataset.kind = t.kind;
        const rem = t.paused ? t.remaining : Math.max(0, t.endsAt - Q.now());
        fill.style.width = Math.max(0, Math.min(100, (100 * rem) / t.duration)).toFixed(2) + '%';
        num.textContent = Math.ceil(rem / 1000);
        lab.textContent = LABELS[t.kind] + (t.paused ? ' – pausiert' : '');
        root.classList.toggle('urgent', rem < 5000 && !t.paused);
      }
      requestAnimationFrame(frame);
    })();
  };

  // ---------- Siegerehrung ----------
  Q.renderPodium = function (el, st) {
    let rank = 0, prev = null;
    const ranked = st.players.slice().sort((a, b) => b.score - a.score).map((p, i) => {
      if (p.score !== prev) { rank = i + 1; prev = p.score; }
      return Object.assign({}, p, { rank });
    });
    const slots = [[ranked[1], 2], [ranked[0], 1], [ranked[2], 3]].filter(x => x[0]);
    el.innerHTML = `<div class="podium">${slots.map(([p, pos]) => `<div class="pod pod-${pos}" style="--pc:${p.color}"><div class="pod-name">${Q.esc(p.name)}</div><div class="pod-score">${p.score}</div><div class="pod-block">${p.rank}</div></div>`).join('')}</div>
      <ol class="ranking">${ranked.map(p => `<li style="--pc:${p.color}"><span class="r-rank">${p.rank}.</span><span class="r-name">${Q.esc(p.name)}</span><span class="r-score">${p.score}</span></li>`).join('')}</ol>`;
  };

  Q.confetti = function (dur) {
    dur = dur || 7000;
    const c = document.createElement('canvas');
    c.className = 'confetti';
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    const resize = () => { c.width = innerWidth; c.height = innerHeight; };
    resize(); addEventListener('resize', resize);
    const cols = ['#ffc933', '#ff5d73', '#4dd0ff', '#7dff8a', '#ffffff', '#c77dff'];
    const parts = Array.from({ length: 240 }, () => ({
      x: Math.random() * c.width, y: -Math.random() * c.height, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, w: 6 + Math.random() * 8, h: 8 + Math.random() * 10,
      col: cols[Math.floor(Math.random() * cols.length)]
    }));
    const start = performance.now();
    (function f(now) {
      const el = now - start;
      ctx.clearRect(0, 0, c.width, c.height);
      parts.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        if (p.y > c.height && el < dur - 1500) { p.y = -20; p.x = Math.random() * c.width; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.col; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      });
      if (el < dur) requestAnimationFrame(f); else { removeEventListener('resize', resize); c.remove(); }
    })(start);
  };

  Q.playerName = (st, id) => { const p = st.players.find(x => x.id === id); return p ? p.name : '—'; };
})();
