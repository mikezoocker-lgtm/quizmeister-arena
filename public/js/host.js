(function () {
  'use strict';
  const $ = Q.$, esc = Q.esc;
  const socket = Q.connect();
  const LS_ROOM = 'qa-host-room', SS_PW = 'qa-host-pw';
  let st = null, pw = sessionStorage.getItem(SS_PW) || '', draft = null, dirty = false, ctrlKey = '', endShown = false, inDash = false;

  Q.mountSound($('#sound'));
  Q.bindTimer($('#hostTimer'), () => st && st.current && st.current.timer);

  function show(v) {
    ['loginView', 'setupView', 'dashView'].forEach(id => $('#' + id).classList.toggle('hidden', id !== v));
    $('#roomInfo').classList.toggle('hidden', v !== 'dashView');
    inDash = v === 'dashView';
    if (inDash && st) render();
  }
  function setConn(on) { const el = $('#conn'); el.textContent = on ? 'verbunden' : 'getrennt – verbinde neu…'; el.classList.toggle('bad', !on); }

  socket.on('connect', () => { setConn(true); if (pw) auth(pw, true); });
  socket.on('disconnect', () => setConn(false));
  socket.on('host:replaced', () => { st = null; show('setupView'); Q.toast('Die Runde wurde in einem anderen Fenster übernommen.', 'bad'); });
  socket.on('state', s => { st = s; if (inDash) render(); });

  function auth(p, silent) {
    socket.emit('host:auth', { password: p }, res => {
      if (!res || !res.ok) {
        sessionStorage.removeItem(SS_PW); pw = ''; show('loginView');
        if (!silent) $('#loginError').textContent = (res && res.error) || 'Fehler';
        return;
      }
      pw = p; sessionStorage.setItem(SS_PW, p);
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(LS_ROOM)); } catch (e) {}
      if (saved) socket.emit('host:rejoin', saved, r => { if (r && r.ok) enter(r); else { localStorage.removeItem(LS_ROOM); show('setupView'); } });
      else show('setupView');
    });
  }
  function enter(r) { localStorage.setItem(LS_ROOM, JSON.stringify({ code: r.code, hostToken: r.hostToken })); show('dashView'); }

  $('#loginForm').addEventListener('submit', e => { e.preventDefault(); Q.sound.init(); $('#loginError').textContent = ''; auth($('#pwInput').value, false); });
  $('#createBtn').onclick = () => socket.emit('host:create', {}, r => { if (r && r.ok) { draft = null; enter(r); } else Q.toast((r && r.error) || 'Fehler', 'bad'); });
  $('#switchRoom').onclick = () => {
    if (!confirm('Diese Runde verlassen und eine neue anlegen? Die aktuelle Runde läuft ohne dich pausiert weiter.')) return;
    localStorage.removeItem(LS_ROOM);
    socket.emit('host:create', {}, r => { if (r && r.ok) { draft = null; ctrlKey = ''; enter(r); } });
  };
  document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
    const inp = $('#' + b.dataset.copy);
    (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(() => Q.toast('Link kopiert.'), () => { inp.select(); document.execCommand('copy'); Q.toast('Link kopiert.'); });
  }));

  function cmd(type, args) {
    return new Promise(resolve => socket.emit('host:cmd', Object.assign({ type }, args || {}), r => {
      if (!r || !r.ok) Q.toast((r && r.error) || 'Fehler', 'bad');
      else if (r.msg) Q.toast(r.msg);
      resolve(r || { ok: false });
    }));
  }

  const nm = id => esc(Q.playerName(st, id));

  function render() {
    $('#roomCode').textContent = st.code;
    $('#inviteLink').value = location.origin + '/play?room=' + st.code;
    $('#watchLink').value = location.origin + '/watch?room=' + st.code;
    Q.renderBoard($('#hostBoard'), st, { canPick: st.phase === 'board', onPick: (c, l) => cmd('pick', { c, l }) });
    renderControl();
    renderBuzzLog();
    renderPlayers();
    fillSettings();
    if (st.phase === 'end' && !endShown) { endShown = true; Q.confetti(); }
    if (st.phase !== 'end') endShown = false;
    if (!draft && st.questions) { draft = JSON.parse(JSON.stringify(st.questions)); renderEditor(); }
  }

  // ---------- Steuerpult ----------
  function playerOptions(sel, withRandom) {
    return (withRandom ? '<option value="">Zufällig auslosen</option>' : '') + st.players.map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  }
  function renderControl() {
    const cur = st.current;
    const key = JSON.stringify([st.phase, st.selector, st.settings.pickBy, st.players.map(p => p.id + p.name), cur && [cur.c, cur.l, cur.answerer, cur.lockedOut, cur.revealed, cur.buzzSeq, cur.textAnswers, cur.endReason, cur.lastWrong, !!cur.timer, cur.question, cur.answer], st.historyCount, st.lastHistory, st.manualPause, st.phase === 'end' ? st.players.map(p => p.score) : 0]);
    if (key === ctrlKey) return;
    ctrlKey = key;
    let h = '';
    if (st.phase === 'lobby') {
      h = `<h2>Lobby</h2><p>${st.players.length ? `<b>${st.players.length}</b> Spieler im Raum.` : 'Noch keine Spieler. Schick den Einladungslink oder lege rechts selbst Spieler an.'}</p>
        <div class="row"><label>Startspieler<select id="starterSel">${playerOptions('', true)}</select></label><button type="button" class="btn primary big" id="startBtn"${st.players.length ? '' : ' disabled'}>Spiel starten</button></div>`;
    } else if (st.phase === 'board') {
      h = `<h2>Feldwahl</h2><p><b class="gold">${nm(st.selector)}</b> ist am Zug. ${st.settings.pickBy === 'player' ? 'Der Spieler wählt auf seinem Board – du kannst auch selbst ein Feld anklicken.' : 'Klicke das angesagte Feld auf dem Board.'}</p>
        <div class="row"><label>Zug geben an<select id="selSel">${playerOptions(st.selector, false)}</select></label></div>`;
    } else if (cur) {
      const canJudge = !!cur.answerer && (st.phase === 'question' || st.phase === 'buzzAnswer');
      let status = '';
      if (st.phase === 'question') status = `<b>${nm(cur.answerer)}</b> antwortet (Auswahlspieler).`;
      else if (st.phase === 'buzzOpen') status = (cur.lastWrong ? `${nm(cur.lastWrong.playerId)}: ${cur.lastWrong.timeout ? 'Zeit abgelaufen' : 'falsch'}. ` : '') + '<b>Buzzer offen</b> – warte auf einen Buzz.';
      else if (st.phase === 'buzzAnswer') status = `<b>${nm(cur.answerer)}</b> hat gebuzzert und antwortet.`;
      else if (st.phase === 'reveal') status = cur.endReason === 'correct' ? `<b>${nm(cur.answerer)}</b> lag richtig und wählt als Nächstes.` : `Frage beendet. Als Nächstes am Zug: <b>${nm(st.selector)}</b>.`;
      const texts = Object.values(cur.textAnswers || {});
      h = `<div class="ctrl-meta"><span>${esc(cur.category)}</span><span class="gold">${cur.value}</span></div>
        <div class="ctrl-q">${esc(cur.question)}</div>${cur.image ? `<img class="ctrl-img" src="${esc(cur.image)}" alt="">` : ''}
        <div class="ctrl-answer"><span>Antwort ${cur.revealed ? '(für alle sichtbar)' : '(nur für dich)'}</span><b>${esc(cur.answer)}</b></div>
        <div class="ctrl-status">${status}</div>
        ${texts.length ? `<div class="ctrl-texts"><span>Textantworten</span>${texts.map(t => `<div><b>${esc(t.name)}:</b> ${esc(t.text)}</div>`).join('')}</div>` : ''}
        ${st.phase === 'reveal' ? '<div class="btn-row"><button type="button" class="btn primary big" data-cmd="continue">Weiter zum Board</button></div>' : `
        <div class="btn-row"><button type="button" class="btn good big" data-cmd="judge" data-args='{"correct":true}'${canJudge ? '' : ' disabled'}>Richtig <kbd>R</kbd></button><button type="button" class="btn bad big" data-cmd="judge" data-args='{"correct":false}'${canJudge ? '' : ' disabled'}>Falsch <kbd>F</kbd></button></div>
        <div class="btn-row">
          <button type="button" class="btn" data-cmd="reveal"${cur.revealed ? ' disabled' : ''}>Antwort aufdecken</button>
          <button type="button" class="btn" data-cmd="endQuestion">Frage beenden</button>
          <button type="button" class="btn" data-cmd="pause"${cur.timer ? '' : ' disabled'}>${st.manualPause ? 'Timer fortsetzen' : 'Timer pausieren'}</button>
          <button type="button" class="btn" data-cmd="addTime"${cur.timer ? '' : ' disabled'}>+10 s</button>
          <button type="button" class="btn ghost" data-cmd="returnQuestion" data-confirm="Frage ohne Wertung zurück aufs Board legen? Punkte aus dieser Frage werden zurückgenommen.">Zurück aufs Board</button>
        </div>`}`;
    } else if (st.phase === 'end') {
      h = '<h2>Spielende</h2><div id="hostPodium"></div>';
    }
    const lh = st.lastHistory;
    h += `<div class="btn-row foot"><button type="button" class="btn sm" data-cmd="undo"${st.historyCount ? '' : ' disabled'}>Undo letzte Punktevergabe${lh ? ` (${nm(lh.playerId)} ${lh.delta > 0 ? '+' : ''}${lh.delta})` : ''}</button><button type="button" class="btn sm ghost" data-cmd="newGame" data-confirm="Neues Spiel starten? Punkte und Felder werden zurückgesetzt, die Spieler bleiben.">Neues Spiel</button></div>`;
    const el = $('#ctrl');
    el.innerHTML = h;
    el.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
      cmd(b.dataset.cmd, b.dataset.args ? JSON.parse(b.dataset.args) : {});
    }));
    const sb = $('#startBtn');
    if (sb) sb.onclick = () => cmd('start', { starter: $('#starterSel').value });
    const ss = $('#selSel');
    if (ss) ss.onchange = () => cmd('setSelector', { id: ss.value });
    if (st.phase === 'end') Q.renderPodium($('#hostPodium'), st);
  }

  function renderBuzzLog() {
    const cur = st.current, el = $('#buzzLog');
    if (!cur || !cur.buzzLog || !cur.buzzLog.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<h3>Buzz-Protokoll ${st.settings.fairBuzz ? '(fair, latenzkompensiert)' : '(einfach)'}</h3><div class="table-wrap"><table><thead><tr><th>Spieler</th><th>Reaktion</th><th>Latenz</th><th>Server</th><th>Gewertet</th><th></th></tr></thead><tbody>${cur.buzzLog.map(b => `<tr class="${b.winner ? 'win' : ''}${b.flag ? ' flag' : ''}"><td>${esc(b.name)}</td><td>${b.reaction == null ? '–' : b.reaction + ' ms'}</td><td>${b.rtt} ms</td><td>${b.serverElapsed} ms</td><td>${b.discarded ? '–' : b.compensated + ' ms'}</td><td>${b.winner ? '<b>Gewinner</b>' : ''}${b.flag ? `<span class="flag-txt">${esc(b.flag)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- Spielerliste ----------
  function renderPlayers() {
    const list = $('#playerList'), ids = new Set(st.players.map(p => p.id));
    [...list.children].forEach(r => { if (!ids.has(r.dataset.id)) r.remove(); });
    st.players.forEach((p, i) => {
      let row = list.querySelector(`[data-id="${p.id}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'prow';
        row.dataset.id = p.id;
        row.innerHTML = `<input type="color" class="p-color" title="Farbe">
          <div class="p-main"><input class="p-name" maxlength="24" aria-label="Name"><div class="p-meta"><span class="dot"></span><span class="p-status"></span><span class="p-turn"></span></div></div>
          <div class="p-score"></div>
          <div class="p-adj"><button type="button" class="btn sm" data-d="-1">−</button><input class="p-step" type="number" value="100" step="50" min="1" aria-label="Punkte"><button type="button" class="btn sm" data-d="1">+</button></div>
          <div class="p-actions"><button type="button" class="btn sm ghost p-sel">Zug geben</button><button type="button" class="btn sm ghost danger p-del">Entfernen</button></div>`;
        const id = p.id;
        row.querySelector('.p-color').addEventListener('change', e => cmd('colorPlayer', { id, color: e.target.value }));
        const nameIn = row.querySelector('.p-name');
        nameIn.addEventListener('change', () => cmd('renamePlayer', { id, name: nameIn.value }).then(r => { if (!r.ok) nameIn.value = Q.playerName(st, id); }));
        nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') nameIn.blur(); });
        row.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => {
          const step = Math.abs(parseInt(row.querySelector('.p-step').value, 10)) || 100;
          cmd('adjust', { id, delta: step * +b.dataset.d });
        }));
        row.querySelector('.p-sel').addEventListener('click', () => cmd('setSelector', { id }));
        row.querySelector('.p-del').addEventListener('click', () => { if (confirm(`${Q.playerName(st, id)} entfernen?`)) cmd('removePlayer', { id }); });
      }
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
      const nameIn = row.querySelector('.p-name'), col = row.querySelector('.p-color');
      if (document.activeElement !== nameIn) nameIn.value = p.name;
      if (document.activeElement !== col) col.value = p.color;
      row.style.setProperty('--pc', p.color);
      row.querySelector('.dot').className = 'dot ' + (p.online ? 'on' : 'off');
      row.querySelector('.p-status').textContent = p.online ? (p.rtt != null ? `online · ${p.rtt} ms` : 'online') : 'offline';
      row.querySelector('.p-turn').textContent = st.selector === p.id && st.phase !== 'lobby' ? 'am Zug' : '';
      const sc = row.querySelector('.p-score');
      sc.textContent = p.score;
      sc.classList.toggle('neg', p.score < 0);
      row.classList.toggle('is-turn', st.selector === p.id && st.phase !== 'lobby');
    });
    $('#playerCount').textContent = st.players.length;
  }
  $('#addPlayerForm').addEventListener('submit', e => {
    e.preventDefault();
    const inp = $('#addPlayerName');
    cmd('addPlayer', { name: inp.value }).then(r => { if (r.ok) inp.value = ''; });
  });

  // ---------- Einstellungen ----------
  const settingsForm = $('#settingsForm');
  function fillSettings() {
    settingsForm.querySelectorAll('[data-key]').forEach(el => {
      if (el === document.activeElement) return;
      const v = st.settings[el.dataset.key];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    });
  }
  settingsForm.addEventListener('change', e => {
    const el = e.target, k = el.dataset.key;
    if (!k) return;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (k === 'fairBuzz') v = el.value === 'true';
    else if (k === 'pickBy') v = el.value;
    else v = Number(el.value);
    cmd('settings', { patch: { [k]: v } });
  });

  // ---------- Fragen-Editor ----------
  function setDirty(d) { dirty = d; $('#edDirty').textContent = d ? 'Ungespeicherte Änderungen' : ''; }
  function renderEditor() {
    if (!draft) return;
    $('#editor').innerHTML = draft.categories.map((cat, ci) => `
      <div class="ed-cat" data-ci="${ci}">
        <div class="ed-cat-head"><span class="ed-num">${ci + 1}</span><input class="ed-catname" data-f="name" value="${esc(cat.name)}" aria-label="Kategoriename"><button type="button" class="btn sm ghost danger" data-act="delCat">Löschen</button></div>
        ${cat.questions.map((q, li) => `<div class="ed-q" data-li="${li}">
          <input type="number" class="ed-val" data-f="value" value="${q.value}" min="1" aria-label="Punktwert">
          <textarea class="ed-question" data-f="question" rows="2" placeholder="Frage">${esc(q.question)}</textarea>
          <button type="button" class="btn sm ghost danger ed-del" data-act="delQ" title="Frage löschen">×</button>
          <input class="ed-ans" data-f="answer" placeholder="Antwort" value="${esc(q.answer)}">
          <input class="ed-img" data-f="image" placeholder="Bild-URL (optional)" value="${esc(q.image || '')}">
        </div>`).join('')}
        <button type="button" class="btn sm ghost" data-act="addQ">+ Frage</button>
      </div>`).join('') || '<p class="muted">Keine Kategorien vorhanden.</p>';
  }
  $('#editor').addEventListener('input', e => {
    const f = e.target.dataset.f;
    if (!f) return;
    const ci = +e.target.closest('.ed-cat').dataset.ci;
    if (f === 'name') draft.categories[ci].name = e.target.value;
    else {
      const q = draft.categories[ci].questions[+e.target.closest('.ed-q').dataset.li];
      q[f] = f === 'value' ? Number(e.target.value) || 0 : e.target.value;
    }
    setDirty(true);
  });
  $('#editor').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const ci = +b.closest('.ed-cat').dataset.ci, cat = draft.categories[ci];
    if (b.dataset.act === 'delCat') { if (!confirm(`Kategorie „${cat.name}“ löschen?`)) return; draft.categories.splice(ci, 1); }
    else if (b.dataset.act === 'addQ') { const last = cat.questions[cat.questions.length - 1]; cat.questions.push({ value: (last ? last.value : 0) + 100, question: '', answer: '', image: '' }); }
    else if (b.dataset.act === 'delQ') cat.questions.splice(+b.closest('.ed-q').dataset.li, 1);
    setDirty(true);
    renderEditor();
  });
  $('#edAddCat').onclick = () => { draft.categories.push({ name: 'Neue Kategorie', questions: [1, 2, 3, 4, 5].map(i => ({ value: i * 100, question: '', answer: '', image: '' })) }); setDirty(true); renderEditor(); };
  $('#edApply').onclick = () => cmd('questions', { data: draft }).then(r => { if (r.ok) { setDirty(false); Q.toast('Fragen übernommen.'); } });
  $('#edReset').onclick = () => { if (dirty && !confirm('Änderungen verwerfen?')) return; draft = JSON.parse(JSON.stringify(st.questions)); setDirty(false); renderEditor(); };
  $('#edImport').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        let d = JSON.parse(rd.result);
        if (Array.isArray(d)) d = { categories: d };
        if (!d || !Array.isArray(d.categories)) throw new Error('Erwartet wird { "categories": [...] }');
        d.categories.forEach(c => { c.name = c.name || 'Kategorie'; c.questions = (Array.isArray(c.questions) ? c.questions : []).map((q, i) => ({ value: Number(q.value) || (i + 1) * 100, question: q.question || '', answer: q.answer || '', image: q.image || '' })); });
        draft = d; setDirty(true); renderEditor();
        Q.toast('Importiert – mit „Fragen übernehmen“ aktivieren.');
      } catch (err) { Q.toast('Import fehlgeschlagen: ' + err.message, 'bad'); }
      e.target.value = '';
    };
    rd.readAsText(f);
  });
  $('#edExport').onclick = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'questions.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // ---------- Tastatur ----------
  document.addEventListener('keydown', e => {
    if (!st || !inDash) return;
    const t = e.target;
    if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
    const can = st.current && st.current.answerer && (st.phase === 'question' || st.phase === 'buzzAnswer');
    const k = e.key.toLowerCase();
    if (k === 'r' && can) cmd('judge', { correct: true });
    if (k === 'f' && can) cmd('judge', { correct: false });
  });
})();
