(function () {
  'use strict';
  const MODE = window.MODE === 'watch' ? 'watch' : 'play';
  const $ = Q.$, esc = Q.esc;
  const socket = Q.connect();
  const LS = 'qa-player';
  const urlCode = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
  let st = null, me = null, blocked = false;
  let releaseSeq = 0, releaseAt = 0, lockUntil = 0, buzzedSeq = 0, endShown = false, textKey = '';

  Q.mountSound($('#sound'));
  Q.bindTimer($('#qTimer'), () => st && st.current && st.current.timer);
  if (urlCode) $('#codeInput').value = urlCode;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)); } catch (e) { return null; } })();

  function show(v) {
    $('#joinView').classList.toggle('hidden', v !== 'join');
    $('#gameView').classList.toggle('hidden', v !== 'game');
    if (v === 'join') { $('#questionOverlay').classList.add('hidden'); $('#endOverlay').classList.add('hidden'); $('#pauseBanner').classList.add('hidden'); }
  }
  function setConn(on) { const el = $('#conn'); el.textContent = on ? 'verbunden' : 'getrennt – verbinde neu…'; el.classList.toggle('bad', !on); }

  socket.on('connect', () => {
    setConn(true);
    if (blocked) return;
    if (MODE === 'watch') { const c = (me && me.code) || urlCode; if (c) watch(c); return; }
    const data = me || (saved && (!urlCode || saved.code === urlCode) ? saved : null);
    if (data) rejoin(data);
  });
  socket.on('disconnect', () => setConn(false));

  function rejoin(data) {
    socket.emit('player:rejoin', data, res => {
      if (res && res.ok) { me = data; show('game'); }
      else { localStorage.removeItem(LS); me = null; show('join'); if (res && res.error) $('#joinError').textContent = res.error; }
    });
  }
  function watch(code) {
    socket.emit('watch:join', { code }, res => {
      if (res && res.ok) { me = { code: res.code }; show('game'); history.replaceState(null, '', '?room=' + res.code); }
      else { $('#joinError').textContent = (res && res.error) || 'Fehler'; show('join'); }
    });
  }

  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    Q.sound.init();
    blocked = false;
    const code = $('#codeInput').value.trim().toUpperCase();
    $('#joinError').textContent = '';
    if (MODE === 'watch') return watch(code);
    socket.emit('player:join', { code, name: $('#nameInput').value }, res => {
      if (!res || !res.ok) { $('#joinError').textContent = (res && res.error) || 'Beitritt fehlgeschlagen.'; return; }
      me = { code: res.code, playerId: res.playerId, token: res.token };
      localStorage.setItem(LS, JSON.stringify(me));
      history.replaceState(null, '', '?room=' + res.code);
      show('game');
    });
  });

  socket.on('kicked', () => { localStorage.removeItem(LS); me = null; st = null; show('join'); $('#joinError').textContent = 'Du wurdest vom Quizmaster entfernt.'; });
  socket.on('replaced', () => { blocked = true; me = null; st = null; show('join'); $('#joinError').textContent = 'Du bist in einem anderen Fenster angemeldet. Zum Fortsetzen hier neu beitreten.'; });
  socket.on('state', s => { if (!me) return; st = s; render(); });

  const nm = id => esc(Q.playerName(st, id));
  const myId = () => (MODE === 'play' && me ? me.playerId : null);

  function render() {
    const id = myId();
    $('#roomBadge').textContent = 'Raum ' + st.code;
    $('#pauseBanner').classList.toggle('hidden', !st.hostPaused);
    const lobby = st.phase === 'lobby';
    $('#lobby').classList.toggle('hidden', !lobby);
    $('#board').classList.toggle('hidden', lobby);
    if (lobby) $('#lobbyList').innerHTML = st.players.map(p => `<li style="--pc:${p.color}"><span class="dot ${p.online ? 'on' : 'off'}"></span>${esc(p.name)}${p.id === id ? ' <em>(du)</em>' : ''}</li>`).join('') || '<li class="muted">Noch niemand da…</li>';
    Q.renderBoard($('#board'), st, { canPick: false });
    Q.renderScores($('#scores'), st, { meId: id });

    let s = '';
    if (lobby) s = '';
    else if (st.phase === 'board') {
      if (st.selector === id) s = '<b>Du bist am Zug!</b> Sag dem Quizmaster Kategorie und Punktwert.';
      else s = `<b>${nm(st.selector)}</b> ist am Zug – der Quizmaster öffnet das Feld.`;
    }
    $('#status').innerHTML = s;

    renderQuestion();

    if (st.phase === 'end') {
      $('#endOverlay').classList.remove('hidden');
      Q.renderPodium($('#podium'), st);
      if (!endShown) { endShown = true; Q.confetti(); }
    } else { $('#endOverlay').classList.add('hidden'); endShown = false; }
  }


  function renderQuestion() {
    const cur = st.current, ov = $('#questionOverlay'), id = myId();
    if (!cur || st.phase === 'end') { ov.classList.add('hidden'); return; }
    ov.classList.remove('hidden');
    $('#qCat').textContent = cur.category;
    $('#qValue').textContent = cur.value;
    $('#qText').textContent = cur.question;
    const img = $('#qImg');
    if (cur.image) { if (img.getAttribute('src') !== cur.image) img.src = cur.image; img.classList.remove('hidden'); } else img.classList.add('hidden');
    $('#qAnswer').classList.toggle('hidden', !cur.revealed);
    $('#qAnswerText').textContent = cur.answer || '';
    const aimg = $('#qAnsImg');
    if (cur.revealed && cur.answerImage) { if (aimg.getAttribute('src') !== cur.answerImage) aimg.src = cur.answerImage; aimg.classList.remove('hidden'); } else aimg.classList.add('hidden');
    $('#questionOverlay').classList.toggle('has-img', !!cur.image);

    if (cur.buzzSeq && cur.buzzSeq !== releaseSeq) { releaseSeq = cur.buzzSeq; releaseAt = performance.now(); }

    const lw = cur.lastWrong ? `${nm(cur.lastWrong.playerId)}: ${cur.lastWrong.timeout ? 'Zeit abgelaufen' : 'falsch'}. ` : '';
    let s = '';
    switch (st.phase) {
      case 'question': s = cur.answerer === id ? '<b>Du bist dran!</b> Antworte jetzt.' : `<b>${nm(cur.answerer)}</b> antwortet…`; break;
      case 'buzzOpen': s = lw + (MODE === 'watch' ? '<b>Buzzer frei!</b>' : cur.lockedOut.includes(id) ? 'Du bist für diese Frage gesperrt.' : '<b>Buzzer frei!</b> Drück den Buzzer oder die Leertaste.'); break;
      case 'buzzAnswer': s = cur.answerer === id ? '<b>Du hast das Wort!</b> Antworte jetzt.' : `<b>${nm(cur.answerer)}</b> hat gebuzzert und antwortet…`; break;
      case 'reveal': s = cur.endReason === 'correct' ? `<b>${nm(cur.answerer)}</b> hat richtig geantwortet!` : lw + 'Auflösung'; break;
    }
    if (st.hostPaused) s = '<b>Pausiert</b> – der Quizmaster ist kurz offline.';
    $('#qStatus').innerHTML = s;

    if (MODE === 'play') {
      const tk = cur.c + '-' + cur.l + '-' + st.phase + '-' + cur.answerer;
      if (tk !== textKey) { textKey = tk; $('#textInput').value = ''; $('#textSent').textContent = ''; }
      const showText = st.settings.textAnswers && cur.answerer === id && (st.phase === 'question' || st.phase === 'buzzAnswer');
      $('#textForm').classList.toggle('hidden', !showText);
      renderBuzzer();
    }
    Q.renderScores($('#qScores'), st, { meId: id });
  }

  // ---------- Buzzer ----------
  function buzzerState() {
    const cur = st.current, id = myId();
    if (st.phase === 'reveal') return { cls: 'off', label: '', disabled: true, hide: true };
    if (cur.lockedOut.includes(id)) return { cls: 'off', label: 'Gesperrt', disabled: true };
    if (cur.answerer === id) return { cls: 'mine', label: 'Du hast das Wort', disabled: true };
    if (performance.now() < lockUntil) return { cls: 'early', label: 'Zu früh!', disabled: true };
    if (st.phase === 'buzzOpen' && !st.hostPaused) {
      if (buzzedSeq === cur.buzzSeq) return { cls: 'sent', label: 'Gebuzzert', disabled: true };
      return { cls: 'live', label: 'Buzz!', disabled: false };
    }
    return { cls: 'wait', label: 'Warten…', disabled: false };
  }
  function renderBuzzer() {
    if (MODE !== 'play' || !st || !st.current) return;
    const b = buzzerState(), el = $('#buzzer');
    el.className = 'buzzer ' + b.cls + (b.hide ? ' hidden' : '');
    el.textContent = b.label;
    el.disabled = b.disabled;
    $('#buzzHint').classList.toggle('hidden', !!b.hide);
  }
  function buzz() {
    if (MODE !== 'play' || !st || !st.current) return;
    const b = buzzerState();
    if (b.disabled) return;
    const cur = st.current, live = b.cls === 'live';
    const reaction = live && releaseSeq === cur.buzzSeq ? performance.now() - releaseAt : -1;
    if (live) buzzedSeq = cur.buzzSeq;
    else { lockUntil = performance.now() + 1000; Q.sound.play('early'); setTimeout(renderBuzzer, 1050); }
    socket.emit('player:buzz', { seq: cur.buzzSeq, reaction }, res => {
      if (res && (res.early || res.discarded || res.locked)) {
        lockUntil = performance.now() + (res.until || 1000);
        buzzedSeq = 0;
        if (live) Q.sound.play('early');
        setTimeout(renderBuzzer, (res.until || 1000) + 50);
      }
      renderBuzzer();
    });
    renderBuzzer();
  }
  if (MODE === 'play') {
    $('#buzzer').addEventListener('pointerdown', e => { e.preventDefault(); buzz(); });
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!st || !st.current) return;
      e.preventDefault();
      if (!e.repeat) buzz();
    });
    $('#textForm').addEventListener('submit', e => {
      e.preventDefault();
      const text = $('#textInput').value.trim();
      if (!text) return;
      socket.emit('player:text', { text }, res => { $('#textSent').textContent = res && res.ok ? 'Antwort gesendet.' : (res && res.error) || 'Fehler'; });
    });
  }
})();
