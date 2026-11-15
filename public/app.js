
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const wave = $('wave');
  const scope = $('scope');
  const wctx = wave.getContext('2d');
  const sctx = scope.getContext('2d');
  const dot = $('live-dot');
  const subtitle = $('subtitle');
  const recBtn = $('rec');
  const recLabel = $('rec-label');
  const recInfo = $('recinfo');
  const gainInput = $('gain');
  const gainVal = $('gain-val');
  const sourceSel = $('source');
  const player = $('player');
  const listEl = $('recordings');
  const countEl = $('count');

  const state = {
    rate: 16000,
    chunkMs: 40,
    gain: 4,
    capturing: false,
    recording: null,
    lastFrameAt: 0,
    history: [],        // {rms, peak, clip}
    raw: new Float32Array(0),
    selected: null,
    recordings: [],
    peakHold: 0,
    peakHoldAt: 0,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  };
  const HISTORY_MAX = 480;

  /* ---------- размеры канвасов ---------- */
  function fitCanvases() {
    for (const c of [wave, scope]) {
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * state.dpr));
      const h = Math.max(1, Math.round(rect.height * state.dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    draw();
  }
  window.addEventListener('resize', fitCanvases);

  /* ---------- отрисовка ---------- */
  function drawGrid(ctx, w, h, mid) {
    ctx.clearRect(0, 0, w, h);
    // фоновая сетка
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const cell = Math.round(h / 6);
    for (let y = mid % cell; y < h; y += cell) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const cols = 10;
    for (let i = 1; i < cols; i++) {
      const x = Math.round((w * i) / cols) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    // осевая линия
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(w, mid + 0.5); ctx.stroke();
  }

  function draw() {
    const w = wave.width, h = wave.height, mid = h / 2;
    drawGrid(wctx, w, h, mid);

    const hist = state.history;
    if (!hist.length) {
      fitScope();
      return;
    }
    const barW = w / HISTORY_MAX;
    const g = state.gain;
    const x0 = w - hist.length * barW;

    // оболочка: вверх — пик, вниз — RMS (как у осциллографа-огибающей)
    for (let i = 0; i < hist.length; i++) {
      const f = hist[i];
      const x = x0 + i * barW;
      const peak = Math.min(1, (f.peak / 32768) * g);
      const rms = Math.min(1, (f.rms / 32768) * g);
      const hp = Math.max(1, peak * (mid - 6));
      const hr = Math.max(0.6, rms * (mid - 6));
      // пик
      wctx.fillStyle = f.clip ? 'rgba(239,68,68,0.95)' : 'rgba(76,201,240,0.42)';
      wctx.fillRect(x, mid - hp, Math.max(1, barW * 0.85), hp);
      wctx.fillRect(x, mid, Math.max(1, barW * 0.85), hp);
      // RMS
      wctx.fillStyle = f.clip ? 'rgba(255,255,255,0.9)' : 'rgba(76,201,240,0.95)';
      wctx.fillRect(x, mid - hr, Math.max(1, barW * 0.85), hr);
      wctx.fillRect(x, mid, Math.max(1, barW * 0.85), hr);
    }

    // подпись шкалы
    wctx.fillStyle = 'rgba(255,255,255,0.25)';
    wctx.font = '13px -apple-system, sans-serif';
    wctx.fillText('−' + Math.round((HISTORY_MAX * state.chunkMs) / 1000) + ' с', 8, h - 8);
    wctx.fillText('сейчас', w - 60, h - 8);

    fitScope();
  }

  function fitScope() {
    const w = scope.width, h = scope.height, mid = h / 2;
    drawGrid(sctx, w, h, mid);
    const raw = state.raw;
    if (raw.length < 2) return;
    const step = state.rate / 1000; // сэмплов на мс
    const g = state.gain;
    sctx.strokeStyle = 'rgba(76,201,240,0.9)';
    sctx.lineWidth = Math.max(1, 1.4 * state.dpr);
    sctx.beginPath();
    for (let i = 0; i < raw.length; i++) {
      const x = (i / raw.length) * w;
      const y = mid - Math.max(-1, Math.min(1, raw[i] * g)) * (mid - 4);
      if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
    }
    sctx.stroke();
    sctx.fillStyle = 'rgba(255,255,255,0.25)';
    sctx.font = '12px -apple-system, sans-serif';
    sctx.fillText(Math.round(raw.length / step) + ' мс', 8, h - 6);
  }

  function updateMeter(db, peak) {
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    $('meter-fill').style.width = pct + '%';
    const now = Date.now();
    if (pct >= state.peakHold || now - state.peakHoldAt > 1500) {
      state.peakHold = pct; state.peakHoldAt = now;
    }
    $('meter-peak').style.left = Math.min(100, state.peakHold) + '%';
    $('db-now').textContent = db <= -100 ? '−∞ dBFS' : db.toFixed(1) + ' dBFS';
    $('db-peak').textContent = 'пик ' + (peak > 0 ? (20 * Math.log10(peak / 32768)).toFixed(1) + ' dB' : '−∞');
  }

  /* ---------- SSE ---------- */
  let es = null;
  function connect(sourceName) {
    if (es) { es.close(); es = null; }
    state.history = [];
    state.raw = new Float32Array(0);
    const url = '/api/stream' + (sourceName ? '?source=' + encodeURIComponent(sourceName) : '');
    es = new EventSource(url);
    es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      state.rate = d.rate; state.chunkMs = d.chunkMs;
      subtitle.textContent = (d.source || 'источник по умолчанию') + ' · ' + d.rate + ' Гц · ' + d.chunkMs + ' мс/кадр';
      if (d.asr) applyAsrState(d.asr);
      if (d.history) renderHistory(d.history);
      fitCanvases();
    });
    es.addEventListener('level', (e) => {
      const d = JSON.parse(e.data);
      state.lastFrameAt = Date.now();
      dot.className = 'dot live';
      state.capturing = true;
      state.history.push({ rms: d.rms, peak: d.peak, clip: d.clip });
      if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
      if (d.pcm) {
        const bin = atob(d.pcm);
        const n = bin.length >> 1;
        const buf = new Float32Array(state.raw.length + n);
        buf.set(state.raw, 0);
        for (let i = 0; i < n; i++) {
          const v = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
          buf[state.raw.length + i] = v / 32768;
        }
        if (buf.length > 1600) state.raw = buf.subarray(buf.length - 1600); else state.raw = buf;
      }
      updateMeter(d.db, d.peak);
      draw();
      if (d.rec) {
        if (!state.recording) {
          // запись уже идёт (например, страница открыта заново)
          recBtn.classList.add('on');
          recLabel.textContent = 'Stop';
        }
        state.recording = d.rec;
        recInfo.textContent = 'запись: ' + (d.rec.ms / 1000).toFixed(1) + ' с';
      } else if (state.recording) {
        endRecordingUI();
      }
    });
    es.addEventListener('status', (e) => {
      const d = JSON.parse(e.data);
      if (d.capturing === false) {
        dot.className = d.error ? 'dot err' : 'dot';
        if (d.error) subtitle.textContent = 'ошибка: ' + d.error;
      }
      if (d.recording === false && state.recording) {
        endRecordingUI();
      }
      if (d.saved) refreshRecordings(d.saved.name);
    });
    es.addEventListener('asr', (e) => {
      const d = JSON.parse(e.data);
      applyAsrState(d);
      if (d.type === 'vad') {
        asrUi.speaking = !!d.speech;
        applyVadBadge(asrUi.speaking);
        if (asrUi.speaking) hintEl.textContent = 'слышу речь…';
        return;
      }
      if (d.type === 'partial') {
        partialEl.textContent = d.text || '…';
        if (d.enabled) hintEl.textContent = 'распознаю…';
      } else if (d.type === 'final') {
        partialEl.textContent = d.text || '—';
      } else if (d.type === 'wake') {
        hintEl.textContent = 'обращение услышано — говорите команду';
      } else if (d.type === 'ignored') {
        hintEl.textContent = 'услышал без обращения: «' + d.text + '»';
      } else if (d.type === 'idle') {
        partialEl.textContent = '—';
        hintIdle();
      } else if (d.state === 'error') {
        hintEl.textContent = 'ошибка распознавания: ' + (d.error || 'неизвестно');
      }
    });
    es.addEventListener('cmd', () => { loadHistory(); });

    es.addEventListener('llm', (e) => {
      const d = JSON.parse(e.data);
      if (d.type === 'start') {
        llmUi.busy = true;
        llmUi.answer = '';
        $('llm-prompt').textContent = 'Вы: ' + (d.prompt || '');
        llmShowAnswer('');
        $('llm-status').textContent = 'думаю…';
      } else if (d.type === 'delta') {
        llmUi.answer += d.delta || '';
        $('llm-text').textContent = llmUi.answer;
      } else if (d.type === 'done') {
        llmUi.busy = false;
        if (d.text) llmShowAnswer(d.text);
        $('llm-status').textContent = 'готово';
      } else if (d.type === 'speaking') {
        llmUi.speaking = true;
        $('llm-status').textContent = 'проговариваю: ' + (d.text || '').slice(0, 60);
      } else if (d.type === 'error') {
        llmUi.busy = false;
        llmUi.error = d.error;
        $('llm-status').textContent = 'ошибка: ' + d.error;
      } else if (d.type === 'busy') {
        $('llm-status').textContent = 'уже отвечаю…';
      } else if (d.type === 'reset') {
        llmUi.answer = '';
        $('llm-text').textContent = 'Ответ появится здесь';
      } else if (d.type === 'config') {
        llmApplyConfig(d.config);
      }
      llmBadge();
    });
    es.addEventListener('history', (e) => {
      const d = JSON.parse(e.data);
      if (d.cleared) renderHistory([]); else loadHistory();
    });
    es.onerror = () => {
      dot.className = 'dot err';
    };
  }

  /* ---------- список записей ---------- */
  function fmtDur(sec) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m > 0 ? m + ':' + s.toFixed(1).padStart(4, '0') : s.toFixed(1) + ' с';
  }

  function renderRecordings() {
    listEl.innerHTML = '';
    countEl.textContent = state.recordings.length ? '(' + state.recordings.length + ')' : '';
    if (!state.recordings.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'пока пусто — нажмите Record';
      listEl.appendChild(li);
      return;
    }
    for (const r of state.recordings) {
      const li = document.createElement('li');
      li.dataset.name = r.name;
      if (state.selected === r.name) li.classList.add('sel');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name.replace(/\.wav$/, '').replace('rec-', '');
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = fmtDur(r.duration);
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = 'удалить';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await fetch('/api/recordings/delete?name=' + encodeURIComponent(r.name), { method: 'POST' }).catch(() => {});
        if (state.selected === r.name) state.selected = null;
        refreshRecordings();
      });
      const mini = document.createElement('button');
      mini.className = 'play-mini';
      mini.type = 'button';
      mini.title = 'прослушать';
      mini.setAttribute('aria-label', 'прослушать ' + r.name);
      mini.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(r.name);
        play(r);
      });
      li.appendChild(mini);
      li.appendChild(name); li.appendChild(dur); li.appendChild(del);
      li.addEventListener('click', () => { select(r.name); play(r); });
      listEl.appendChild(li);
    }
  }

  function select(name) {
    state.selected = name;
    for (const li of listEl.children) {
      if (li.dataset) li.classList.toggle('sel', li.dataset.name === name);
    }
  }

  async function refreshRecordings(preferName) {
    try {
      const r = await fetch('/api/recordings', { cache: 'no-store' });
      const d = await r.json();
      state.recordings = d.recordings || [];
      if (preferName && state.recordings.some((x) => x.name === preferName)) state.selected = preferName;
      if (!state.selected && state.recordings.length) state.selected = state.recordings[0].name;
      renderRecordings();
    } catch (e) { /* ignore */ }
  }

  /* ---------- воспроизведение ---------- */
  function play(rec) {
    const item = rec || state.recordings.find((x) => x.name === state.selected) || state.recordings[0];
    if (!item) return;
    state.selected = item.name;
    player.src = item.url + '?t=' + Date.now();
    player.play().catch((e) => { recInfo.textContent = 'не удалось воспроизвести: ' + e.message; });
  }

  /* ---------- запись ---------- */
  function endRecordingUI() {
    state.recording = null;
    recBtn.classList.remove('on');
    recLabel.textContent = 'Record';
    if (!recInfo.textContent.startsWith('сохранено')) recInfo.textContent = '';
  }

  recBtn.addEventListener('click', async () => {
    recBtn.disabled = true;
    try {
      if (state.recording) {
        const r = await fetch('/api/record/stop', { method: 'POST' });
        const d = await r.json();
        endRecordingUI();
        if (d.recording) {
          recInfo.textContent = 'сохранено: ' + fmtDur(d.recording.duration);
          await refreshRecordings(d.recording.name);
        }
      } else {
        const src = sourceSel.value;
        const r = await fetch('/api/record/start?source=' + encodeURIComponent(src), { method: 'POST' });
        const d = await r.json();
        if (!d.ok) { recInfo.textContent = d.error || 'ошибка старта'; return; }
        state.recording = { name: d.name, ms: 0 };
        recBtn.classList.add('on');
        recLabel.textContent = 'Stop';
      }
    } catch (e) {
      recInfo.textContent = 'ошибка: ' + e.message;
    } finally {
      recBtn.disabled = false;
    }
  });

  player.addEventListener('ended', () => { recInfo.textContent = ''; });
  player.addEventListener('play', () => { recInfo.textContent = '▶ ' + (state.selected || '').replace(/\.wav$/, ''); });

  gainInput.addEventListener('input', () => {
    state.gain = Number(gainInput.value);
    gainVal.textContent = state.gain;
    draw();
  });


  /* ---------- голосовой ввод (Vosk) ---------- */
  const asrUi = { enabled: false, ready: false, armed: false, error: null, vad: true, speaking: false };
  const wakeInput = $('asr-wake');
  const partialEl = $('asr-partial');
  const hintEl = $('asr-hint');

  function wakeWord() {
    return (wakeInput.value || '').trim() || 'антон';
  }

  function hintIdle() {
    if (!asrUi.enabled) { hintEl.textContent = 'распознавание выключено'; return; }
    hintEl.textContent = 'скажите «' + wakeWord() + '», затем команду';
  }

  function applyVadBadge(speaking) {
    const el = $('asr-vad-badge');
    if (!el) return;
    if (!asrUi.enabled || !asrUi.vad) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'badge ' + (speaking ? 'ready' : 'off');
    el.textContent = speaking ? 'речь' : 'тишина';
  }

  function applyAsrBadge() {
    const b = $('asr-badge');
    let cls = 'off';
    let label = 'выкл';
    if (asrUi.error && asrUi.enabled) { cls = 'error'; label = 'ошибка'; }
    else if (!asrUi.enabled) { cls = 'off'; label = 'выкл'; }
    else if (!asrUi.ready) { cls = 'off'; label = 'запуск…'; }
    else if (asrUi.armed) { cls = 'armed'; label = 'жду команду'; }
    else { cls = 'ready'; label = 'слушаю'; }
    b.className = 'badge ' + cls;
    b.textContent = label;
    b.title = asrUi.error || '';
    $('asr-toggle').textContent = asrUi.enabled ? 'Выключить распознавание' : 'Включить распознавание';
  }

  function applyAsrState(d) {
    if (!d) return;
    if (d.error !== undefined) asrUi.error = d.error;
    if (d.enabled !== undefined) asrUi.enabled = d.enabled;
    if (d.ready !== undefined) asrUi.ready = d.ready;
    if (d.armed !== undefined) asrUi.armed = d.armed;
    if (d.model) $('asr-model-info').textContent = 'Vosk · ' + d.model;
    if (d.vad !== undefined) asrUi.vad = !!d.vad;
    if (d.speaking !== undefined) asrUi.speaking = !!d.speaking;
    applyVadBadge(asrUi.speaking);
    applyAsrBadge();
  }

  function histTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderHistory(items) {
    const ul = $('hist');
    ul.innerHTML = '';
    if (!items || !items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'пока ничего не распознано';
      ul.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = histTime(it.at);
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = it.text;
      li.appendChild(t);
      li.appendChild(tx);
      if (it.viaWake) {
        const w = document.createElement('span');
        w.className = 'wake-mark';
        w.textContent = 'после обращения';
        li.appendChild(w);
      }
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = 'удалить';
      del.addEventListener('click', async () => {
        await fetch('/api/asr/history/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: it.id }),
        }).catch(() => {});
        loadHistory();
      });
      li.appendChild(del);
      ul.appendChild(li);
    }
  }

  async function loadHistory() {
    try {
      const r = await fetch('/api/asr/history', { cache: 'no-store' });
      const d = await r.json();
      renderHistory(d.items || []);
    } catch (e) { /* ignore */ }
  }

  async function loadAsr() {
    try {
      const r = await fetch('/api/asr/options', { cache: 'no-store' });
      const d = await r.json();
      const sel = $('asr-model');
      sel.innerHTML = '';
      for (const m of d.models || []) {
        const o = document.createElement('option');
        o.value = m.name;
        o.textContent = m.name;
        sel.appendChild(o);
      }
      if (d.config) {
        if (d.config.model) sel.value = d.config.model;
        wakeInput.value = d.config.wakeWord || '';
        $('asr-silence').value = d.config.silenceMs || 1200;
        $('asr-require').checked = d.config.requireWake !== false;
        $('asr-vad').checked = d.config.vad !== false;
        $('asr-vad-th').value = d.config.vadThreshold != null ? d.config.vadThreshold : 0.5;
        if (d.vad && !d.vad.available) {
          $('asr-vad').checked = false;
          $('asr-vad').disabled = true;
          $('asr-vad').parentElement.title = 'модель Silero VAD не найдена на сервере';
        }
      }
      applyAsrState(d.state);
      renderHistory(d.history || []);
      hintIdle();
    } catch (e) {
      hintEl.textContent = 'не удалось загрузить настройки: ' + e.message;
    }
  }

  $('asr-toggle').addEventListener('click', async () => {
    const on = !asrUi.enabled;
    $('asr-toggle').disabled = true;
    try {
      const r = await fetch(on ? '/api/asr/start' : '/api/asr/stop', { method: 'POST' });
      const d = await r.json();
      applyAsrState(d.state);
      if (!on) { partialEl.textContent = '—'; asrUi.speaking = false; applyVadBadge(false); $('asr-vad-badge').hidden = true; hintIdle(); }
      else hintEl.textContent = 'загрузка модели…';
    } catch (e) {
      hintEl.textContent = 'ошибка: ' + e.message;
    } finally {
      $('asr-toggle').disabled = false;
    }
  });

  $('asr-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      model: $('asr-model').value,
      wakeWord: wakeInput.value.trim(),
      requireWake: $('asr-require').checked,
      silenceMs: Number($('asr-silence').value) || 1200,
      vad: $('asr-vad').checked,
      vadThreshold: Number($('asr-vad-th').value) || 0.5,
    };
    try {
      const r = await fetch('/api/asr/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) { $('asr-saved').textContent = d.error; return; }
      applyAsrState(d.state);
      $('asr-saved').textContent = 'сохранено';
      hintIdle();
      setTimeout(() => { $('asr-saved').textContent = ''; }, 2500);
    } catch (e) {
      $('asr-saved').textContent = 'ошибка: ' + e.message;
    }
  });

  $('hist-clear').addEventListener('click', async () => {
    await fetch('/api/asr/history/clear', { method: 'POST' }).catch(() => {});
    renderHistory([]);
  });

  /* ---------- голосовой вывод: eSpeak NG / RHVoice ---------- */
  const ttsVoice = $('tts-voice');
  const ttsUi = { engines: [], engine: 'espeak', config: null };

  function bindRange(id) {
    const el = $(id);
    const out = $(id + '-v');
    const fmt = (v) => (id.indexOf('pip-') === 0 ? Number(v).toFixed(2) : v);
    const sync = () => { if (out) out.textContent = fmt(el.value); };
    el.addEventListener('input', sync);
    sync();
  }

  function engineById(id) {
    return ttsUi.engines.find((e) => e.id === id) || ttsUi.engines[0];
  }

  const ESPEAK_VARIANTS = (() => {
    const v = [];
    for (const f of [1, 2, 3, 4, 5]) v.push({ id: 'ru+f' + f, name: 'женский ' + f });
    for (const m of [1, 2, 3, 4, 5, 6, 7]) v.push({ id: 'ru+m' + m, name: 'мужской ' + m });
    v.push({ id: 'ru+whisper', name: 'шёпот' });
    return v;
  })();

  function fillVoices(engine) {
    ttsVoice.innerHTML = '';
    const voices = (engine.voices || []).slice();
    if (engine.id === 'espeak') voices.push(...ESPEAK_VARIANTS);
    if (!voices.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '— нет голосов —';
      ttsVoice.appendChild(o);
      return;
    }
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.id;
      if (engine.id === 'piper') {
        o.textContent = v.name + (v.quality ? ' · ' + v.quality : '') + (v.language ? ' · ' + v.language : '');
        ttsVoice.appendChild(o);
        continue;
      }
      let label = v.id;
      if (v.name && v.name !== v.id) label += ' — ' + v.name;
      if (v.language) label += ' · ' + v.language;
      if (v.gender) label += ' · ' + (v.gender === 'male' ? 'муж.' : v.gender === 'female' ? 'жен.' : v.gender);
      o.textContent = label;
      ttsVoice.appendChild(o);
    }
  }

  function applyEngine(id) {
    const engine = engineById(id);
    if (!engine) return;
    ttsUi.engine = engine.id;
    const radio = document.querySelector('input[name="tts-engine"][value="' + engine.id + '"]');
    if (radio && !radio.disabled) radio.checked = true;
    $('params-espeak').hidden = engine.id !== 'espeak';
    $('params-rhvoice').hidden = engine.id !== 'rhvoice';
    $('params-piper').hidden = engine.id !== 'piper';
    fillVoices(engine);
    const cfg = (ttsUi.config && ttsUi.config[engine.id]) || engine.defaults || {};
    if (engine.id === 'espeak') {
      ttsVoice.value = cfg.voice || 'ru';
      if (ttsVoice.selectedIndex < 0) ttsVoice.selectedIndex = 0;
      $('tts-speed').value = cfg.speed || 150;
      $('tts-pitch').value = cfg.pitch != null ? cfg.pitch : 50;
      $('tts-amp').value = cfg.amplitude != null ? cfg.amplitude : 100;
      $('tts-speed-v').textContent = $('tts-speed').value;
      $('tts-pitch-v').textContent = $('tts-pitch').value;
      $('tts-amp-v').textContent = $('tts-amp').value;
      $('engine-note').textContent = (engine.voices.length + ESPEAK_VARIANTS.length) + ' вариантов';
    } else if (engine.id === 'piper') {
      ttsVoice.value = cfg.voice || (engine.voices[0] && engine.voices[0].id) || '';
      if (ttsVoice.selectedIndex < 0) ttsVoice.selectedIndex = 0;
      $('pip-length').value = cfg.lengthScale != null ? cfg.lengthScale : 1;
      $('pip-noise').value = cfg.noiseScale != null ? cfg.noiseScale : 0.667;
      $('pip-silence').value = cfg.sentenceSilence != null ? cfg.sentenceSilence : 0.2;
      ['pip-length', 'pip-noise', 'pip-silence'].forEach((id) => { $(id + '-v').textContent = Number($(id).value).toFixed(2); });
      const langs = [...new Set(engine.voices.map((v) => v.language).filter(Boolean))].join(', ');
      $('engine-note').textContent = !engine.available
        ? 'движок не установлен'
        : 'голосов: ' + engine.voices.length + (langs ? ' · ' + langs : '');
    } else {
      ttsVoice.value = cfg.voice || (engine.voices[0] && engine.voices[0].id) || '';
      if (ttsVoice.selectedIndex < 0) ttsVoice.selectedIndex = 0;
      $('rhv-rate').value = cfg.rate || 100;
      $('rhv-pitch').value = cfg.pitch != null ? cfg.pitch : 100;
      $('rhv-vol').value = cfg.volume != null ? cfg.volume : 100;
      $('rhv-rate-v').textContent = $('rhv-rate').value;
      $('rhv-pitch-v').textContent = $('rhv-pitch').value;
      $('rhv-vol-v').textContent = $('rhv-vol').value;
      const langs = [...new Set(engine.voices.map((v) => v.language).filter(Boolean))].join(', ');
      $('engine-note').textContent = !engine.available
        ? 'движок не установлен'
        : engine.voices.length + ' голосов' + (langs ? ' · ' + langs : '');
    }
  }

  async function loadTts() {
    ['tts-speed', 'tts-pitch', 'tts-amp', 'rhv-rate', 'rhv-pitch', 'rhv-vol', 'pip-length', 'pip-noise', 'pip-silence'].forEach(bindRange);
    document.querySelectorAll('input[name="tts-engine"]').forEach((r) => {
      r.addEventListener('change', () => { if (r.checked) applyEngine(r.value); });
    });
    try {
      const r = await fetch('/api/tts/options', { cache: 'no-store' });
      const d = await r.json();
      ttsUi.engines = d.engines || [];
      ttsUi.config = d.config || {};
      const rh = ttsUi.engines.find((e) => e.id === 'rhvoice');
      const rhRadio = document.querySelector('input[name="tts-engine"][value="rhvoice"]');
      if (rh && !rh.available) {
        rhRadio.disabled = true;
        rhRadio.parentElement.classList.add('disabled');
        rhRadio.parentElement.title = 'RHVoice не установлен на сервере';
      }
      const pi = ttsUi.engines.find((e) => e.id === 'piper');
      const piRadio = document.querySelector('input[name="tts-engine"][value="piper"]');
      if (pi && !pi.available) {
        piRadio.disabled = true;
        piRadio.parentElement.classList.add('disabled');
        piRadio.parentElement.title = 'Piper не установлен на сервере';
      }
      const cfgEngine = ttsUi.config.engine;
      const want = cfgEngine === 'rhvoice' && rh && rh.available ? 'rhvoice'
        : cfgEngine === 'piper' && pi && pi.available ? 'piper'
        : 'espeak';
      applyEngine(want);
    } catch (e) {
      $('tts-info').textContent = 'не удалось получить настройки синтеза: ' + e.message;
    }
  }

  function ttsParamsBody() {
    const engine = ttsUi.engine;
    const body = { engine: engine, voice: ttsVoice.value };
    if (engine === 'rhvoice') {
      body.rate = Number($('rhv-rate').value);
      body.pitch = Number($('rhv-pitch').value);
      body.volume = Number($('rhv-vol').value);
    } else if (engine === 'piper') {
      body.lengthScale = Number($('pip-length').value);
      body.noiseScale = Number($('pip-noise').value);
      body.sentenceSilence = Number($('pip-silence').value);
    } else {
      body.speed = Number($('tts-speed').value);
      body.pitch = Number($('tts-pitch').value);
      body.amplitude = Number($('tts-amp').value);
    }
    return body;
  }

  async function saveTtsSettings() {
    if (!ttsVoice.value) { $('tts-info').textContent = 'нет доступных голосов'; return; }
    const btn = $('tts-save');
    btn.disabled = true;
    try {
      const r = await fetch('/api/tts/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsParamsBody()),
      });
      const d = await r.json();
      if (d.error) { $('tts-info').textContent = d.error; return; }
      ttsUi.config = d.config || ttsUi.config;
      const label = d.engine === 'rhvoice' ? 'RHVoice' : d.engine === 'piper' ? 'Piper' : 'eSpeak NG';
      $('tts-info').textContent = 'сохранено: ' + label + (d.voice ? ' · ' + d.voice : '');
    } catch (e) {
      $('tts-info').textContent = 'ошибка: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  $('tts-save').addEventListener('click', saveTtsSettings);

  $('tts-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('tts-text').value.trim();
    if (!text) { $('tts-info').textContent = 'введите текст'; return; }
    const engine = ttsUi.engine;
    const body = ttsParamsBody();
    body.text = text;
    if (!body.voice) { $('tts-info').textContent = 'нет доступных голосов'; return; }
    const btn = ev.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    $('tts-info').textContent = 'синтезирую…';
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) { $('tts-info').textContent = d.error; return; }
      const label = engine === 'rhvoice' ? 'RHVoice' : engine === 'piper' ? 'Piper' : 'eSpeak NG';
      $('tts-info').textContent = 'готово: ' + d.duration.toFixed(1) + ' с · ' + label + ' · ' +
        (d.played ? 'проговорено на сервере' : 'не воспроизведено' + (d.playError ? ' (' + d.playError + ')' : ''));
      const a = $('tts-player');
      a.src = d.url + '?t=' + Date.now();
      a.hidden = false;
      if (ttsUi.config[engine]) {
        ttsUi.config[engine] = Object.assign({}, ttsUi.config[engine], d.params || {}, { voice: d.voice });
      }
    } catch (e) {
      $('tts-info').textContent = 'ошибка: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- LLM ---------- */
  const llmUi = { enabled: false, model: '', busy: false, speaking: false, answer: '', error: null };

  function llmBadge() {
    const b = $('llm-badge');
    let cls = 'off';
    let label = 'выкл';
    if (llmUi.error) { cls = 'error'; label = 'ошибка'; }
    else if (!llmUi.enabled) { cls = 'off'; label = 'выкл'; }
    else if (llmUi.busy) { cls = 'armed'; label = 'думает'; }
    else if (llmUi.speaking) { cls = 'ready'; label = 'говорит'; }
    else { cls = 'ready'; label = 'готов'; }
    b.className = 'badge ' + cls;
    b.textContent = label;
    b.title = llmUi.error || '';
  }

  function llmApplyConfig(cfg) {
    if (!cfg) return;
    llmUi.enabled = !!cfg.enabled;
    llmUi.model = cfg.model || '';
    $('llm-enabled').checked = !!cfg.enabled;
    $('llm-thinking').checked = !!cfg.thinking;
    $('llm-stream').checked = cfg.stream !== false;
    $('llm-max').value = cfg.maxTokens || 300;
    $('llm-system').value = cfg.systemPrompt || '';
    if ($('llm-model').options.length) $('llm-model').value = llmUi.model;
    llmBadge();
  }

  async function loadLlm() {
    try {
      const r = await fetch('/api/llm/options', { cache: 'no-store' });
      const d = await r.json();
      const sel = $('llm-model');
      sel.innerHTML = '';
      for (const m of d.models || []) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.name && m.name !== m.id ? m.id + ' — ' + m.name : m.id;
        sel.appendChild(o);
      }
      if (!sel.options.length && d.config && d.config.model) {
        const o = document.createElement('option');
        o.value = d.config.model;
        o.textContent = d.config.model;
        sel.appendChild(o);
      }
      llmApplyConfig(d.config);
      if (d.error) { llmUi.error = d.error; $('llm-note').textContent = d.error; }
      else if (!d.key) { $('llm-note').textContent = 'нет API-ключа на сервере'; }
      else { $('llm-note').textContent = d.models.length + ' моделей · ключ найден'; }
      llmBadge();
    } catch (e) {
      $('llm-note').textContent = 'не удалось получить модели: ' + e.message;
      llmUi.error = e.message;
      llmBadge();
    }
  }

  function llmShowAnswer(text) {
    llmUi.answer = text || '';
    $('llm-text').textContent = llmUi.answer || '—';
  }

  $('llm-enabled').addEventListener('change', () => {
    llmUi.enabled = $('llm-enabled').checked;
    llmBadge();
    saveLlm();
  });

  async function saveLlm() {
    const body = {
      enabled: $('llm-enabled').checked,
      model: $('llm-model').value,
      thinking: $('llm-thinking').checked,
      stream: $('llm-stream').checked,
      maxTokens: Number($('llm-max').value) || 300,
      systemPrompt: $('llm-system').value,
    };
    try {
      const r = await fetch('/api/llm/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) { $('llm-saved').textContent = d.error; return; }
      llmApplyConfig(d.config);
      $('llm-saved').textContent = 'сохранено';
      setTimeout(() => { $('llm-saved').textContent = ''; }, 2500);
    } catch (e) {
      $('llm-saved').textContent = 'ошибка: ' + e.message;
    }
  }

  $('llm-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveLlm(); });

  $('llm-reset').addEventListener('click', async () => {
    await fetch('/api/llm/reset', { method: 'POST' }).catch(() => {});
    llmShowAnswer('');
    $('llm-prompt').textContent = '—';
    $('llm-status').textContent = 'контекст сброшен';
  });

  async function askLlm(text) {
    if (!text.trim()) return;
    llmUi.error = null;
    llmUi.busy = true;
    $('llm-prompt').textContent = 'Вы: ' + text.trim();
    llmShowAnswer('');
    $('llm-status').textContent = 'думаю…';
    llmBadge();
    try {
      const r = await fetch('/api/llm/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      const d = await r.json();
      if (d.error) {
        llmUi.error = d.error;
        $('llm-status').textContent = 'ошибка: ' + d.error;
        return;
      }
      llmShowAnswer(d.text);
      $('llm-status').textContent = 'готово · ' + (d.usage && d.usage.completion_tokens ? d.usage.completion_tokens + ' токенов' : '');
    } catch (e) {
      llmUi.error = e.message;
      $('llm-status').textContent = 'ошибка: ' + e.message;
    } finally {
      llmUi.busy = false;
      llmBadge();
    }
  }

  $('llm-ask').addEventListener('click', () => {
    const t = $('llm-test-text').value;
    $('llm-test-text').value = '';
    askLlm(t);
  });

  $('llm-test-text').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); $('llm-ask').click(); }
  });

  /* ---------- системный звук ---------- */
  const audioUi = { sinks: [], sources: [], card: null, sinkTimer: null, sourceTimer: null };

  function fillDevices(sel, items, defaultName) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.name;
      o.textContent = it.label + (it.name === defaultName ? ' · по умолчанию' : '');
      sel.appendChild(o);
    }
    if (prev && items.some((i) => i.name === prev)) sel.value = prev;
    else if (defaultName && items.some((i) => i.name === defaultName)) sel.value = defaultName;
    else if (items.length) sel.value = items[0].name;
  }

  function applySink(name) {
    const s = audioUi.sinks.find((x) => x.name === name);
    if (!s) return;
    $('sink-vol').value = s.volume;
    $('sink-vol-v').textContent = s.volume;
    $('sink-mute').checked = s.mute;
  }

  function applySource(name) {
    const s = audioUi.sources.find((x) => x.name === name);
    if (!s) return;
    $('source-vol').value = s.volume;
    $('source-vol-v').textContent = s.volume;
    $('source-mute').checked = s.mute;
  }

  function renderCardControls(card) {
    const box = $('card-controls');
    box.innerHTML = '';
    audioUi.card = card;
    if (!card || !card.controls || !card.controls.length) return;
    for (const c of card.controls) {
      const wrap = document.createElement('div');
      wrap.className = 'card-ctl';
      if (c.kind === 'int') {
        const label = document.createElement('label');
        const title = document.createElement('span');
        title.textContent = c.id + ' (ALSA)';
        const range = document.createElement('span');
        range.className = 'range';
        const input = document.createElement('input');
        input.type = 'range';
        input.min = c.min;
        input.max = c.max;
        input.value = c.value;
        const out = document.createElement('b');
        out.textContent = c.value;
        input.addEventListener('input', () => { out.textContent = input.value; });
        input.addEventListener('change', () => postCard(card.index, c.id, Number(input.value)));
        range.appendChild(input);
        range.appendChild(out);
        label.appendChild(title);
        label.appendChild(range);
        wrap.appendChild(label);
      } else {
        const label = document.createElement('label');
        label.className = 'chk';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!c.value;
        input.addEventListener('change', () => postCard(card.index, c.id, input.checked));
        const span = document.createElement('span');
        span.textContent = c.id + ' (ALSA)';
        label.appendChild(input);
        label.appendChild(span);
        wrap.appendChild(label);
      }
      box.appendChild(wrap);
    }
  }

  async function loadAudio(sourceName) {
    const q = sourceName || $('source-select').value || $('source').value || '';
    try {
      const r = await fetch('/api/audio' + (q ? '?source=' + encodeURIComponent(q) : ''), { cache: 'no-store' });
      const d = await r.json();
      if (d.error) { $('audio-info').textContent = d.error; return; }
      audioUi.sinks = d.sinks || [];
      audioUi.sources = d.sources || [];
      fillDevices($('sink-select'), audioUi.sinks, d.defaultSink);
      fillDevices($('source-select'), audioUi.sources, d.defaultSource);
      if (q && audioUi.sources.some((s) => s.name === q)) $('source-select').value = q;
      applySink($('sink-select').value);
      applySource($('source-select').value);
      renderCardControls(d.card);
    } catch (e) {
      $('audio-info').textContent = 'не удалось прочитать состояние звука: ' + e.message;
    }
  }

  async function postAudio(path, body, okText) {
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) { $('audio-info').textContent = d.error; return null; }
      $('audio-info').textContent = okText || '';
      return d;
    } catch (e) {
      $('audio-info').textContent = 'ошибка: ' + e.message;
      return null;
    }
  }

  function postCard(card, control, value) {
    postAudio('/api/audio/card', { card, control, value, source: $('source-select').value }, 'применено: ' + control);
  }

  $('sink-select').addEventListener('change', () => {
    applySink($('sink-select').value);
    $('audio-info').textContent = '';
  });

  $('source-select').addEventListener('change', () => {
    applySource($('source-select').value);
    loadAudio($('source-select').value);
  });

  $('sink-vol').addEventListener('input', () => {
    $('sink-vol-v').textContent = $('sink-vol').value;
    clearTimeout(audioUi.sinkTimer);
    audioUi.sinkTimer = setTimeout(() => {
      postAudio('/api/audio/sink', { name: $('sink-select').value, volume: Number($('sink-vol').value) });
    }, 180);
  });

  $('source-vol').addEventListener('input', () => {
    $('source-vol-v').textContent = $('source-vol').value;
    clearTimeout(audioUi.sourceTimer);
    audioUi.sourceTimer = setTimeout(() => {
      postAudio('/api/audio/source', { name: $('source-select').value, volume: Number($('source-vol').value) });
    }, 180);
  });

  $('sink-mute').addEventListener('change', () => {
    postAudio('/api/audio/sink', { name: $('sink-select').value, mute: $('sink-mute').checked },
      $('sink-mute').checked ? 'вывод выключен (mute)' : 'вывод включён');
  });

  $('source-mute').addEventListener('change', () => {
    postAudio('/api/audio/source', { name: $('source-select').value, mute: $('source-mute').checked },
      $('source-mute').checked ? 'ввод выключен (mute)' : 'ввод включён');
  });

  $('sink-default').addEventListener('click', async () => {
    const d = await postAudio('/api/audio/sink', { name: $('sink-select').value, setDefault: true }, 'устройство вывода по умолчанию обновлено');
    if (d && d.state) fillDevices($('sink-select'), d.state.sinks, d.state.defaultSink);
  });

  $('source-default').addEventListener('click', async () => {
    const d = await postAudio('/api/audio/source', { name: $('source-select').value, setDefault: true }, 'устройство ввода по умолчанию обновлено');
    if (d && d.state) fillDevices($('source-select'), d.state.sources, d.state.defaultSource);
  });

  $('sink-test').addEventListener('click', async () => {
    $('audio-info').textContent = 'проигрываю тон…';
    const muted = $('sink-mute').checked;
    const hint = muted ? 'тон проигран, но вывод в mute — снимите mute, чтобы услышать' : 'тон проигран';
    await postAudio('/api/audio/test', { sink: $('sink-select').value }, hint);
  });

  /* ---------- Bluetooth ---------- */
  const btUi = { controller: null, devices: [], busy: false, timer: null };

  function btChip(text, cls) {
    const s = document.createElement('span');
    s.className = 'bt-chip' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
  }

  function btRenderDevice(d) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'bt-main';
    const isMacName = /^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i.test(d.name || '');
    const name = document.createElement('div');
    name.className = 'bt-name';
    name.appendChild(document.createTextNode(isMacName ? 'неизвестное устройство' : (d.name || d.mac)));
    if (d.connected) name.appendChild(btChip('подключено', 'conn'));
    else if (d.paired) name.appendChild(btChip('сопряжено', 'pair'));
    const mac = document.createElement('div');
    mac.className = 'bt-mac';
    mac.textContent = d.mac + (d.trusted ? ' · доверено' : '') + (d.sink ? ' · ' + d.sink.replace('bluez_sink.', '') : '');
    main.appendChild(name);
    main.appendChild(mac);

    const actions = document.createElement('div');
    actions.className = 'bt-actions';

    const mkBtn = (label, handler, title) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.type = 'button';
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', handler);
      if (btUi.busy) b.disabled = true;
      actions.appendChild(b);
      return b;
    };

    if (d.connected) {
      mkBtn('Отключить', () => btAction('/api/bluetooth/disconnect', { mac: d.mac }, 'отключаю…'));
    } else {
      mkBtn(d.paired ? 'Подключить' : 'Подключить', () => btAction('/api/bluetooth/connect', { mac: d.mac }, 'подключаю…'),
        d.paired ? '' : 'устройство не сопряжено — подключение запустит сопряжение');
    }
    if (d.sink) {
      mkBtn('Сделать выводом', async () => {
        const r = await postAudio('/api/audio/sink', { name: d.sink, setDefault: true, mute: false }, 'вывод переключён на ' + d.name);
        if (r) await loadAudio($('source-select').value);
      }, 'Сделать эту колонку устройством вывода по умолчанию');
    }
    if (d.connected && !d.sink) {
      const hint = document.createElement('span');
      hint.className = 'bt-chip';
      hint.textContent = 'нет A2DP-профиля';
      actions.appendChild(hint);
    }

    li.appendChild(main);
    li.appendChild(actions);
    return li;
  }

  function btRender(state) {
    btUi.controller = state.controller;
    btUi.devices = state.devices || [];
    const ctl = state.controller;
    if (ctl) {
      $('bt-adapter').textContent = (ctl.alias || ctl.name || 'адаптер') + ' · ' + ctl.address + ' · ' + (ctl.powered ? 'включён' : 'выключен');
      $('bt-hint').textContent = 'адаптер ' + (ctl.alias || ctl.name || '');
      $('bt-power').textContent = ctl.powered ? 'Выключить' : 'Включить';
      $('bt-scan').disabled = !ctl.powered || btUi.busy;
    } else {
      $('bt-adapter').textContent = 'адаптер не найден';
      $('bt-scan').disabled = true;
    }
    const list = $('bt-list');
    list.innerHTML = '';
    if (!btUi.devices.length) {
      const li = document.createElement('li');
      li.className = 'bt-empty';
      li.textContent = 'устройств нет — включите колонку и нажмите «Сканировать»';
      list.appendChild(li);
      return;
    }
    for (const d of btUi.devices.slice(0, 12)) list.appendChild(btRenderDevice(d));
  }

  async function loadBt() {
    try {
      const r = await fetch('/api/bluetooth', { cache: 'no-store' });
      const d = await r.json();
      if (d.error) { $('bt-info').textContent = d.error; return; }
      btRender(d);
    } catch (e) {
      $('bt-info').textContent = 'не удалось прочитать состояние: ' + e.message;
    }
  }

  function btErrorText(err) {
    if (/page-timeout/i.test(err)) return 'не удалось подключиться: устройство не отвечает (выключено или вне зоны)';
    if (/AlreadyConnected/i.test(err)) return 'устройство уже подключено';
    if (/not available/i.test(err)) return 'адаптер недоступен';
    return err;
  }

  async function btAction(path, body, busyText) {
    if (btUi.busy) return;
    btUi.busy = true;
    $('bt-info').textContent = busyText || '…';
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const d = await r.json();
      if (d.error) { $('bt-info').textContent = btErrorText(d.error); }
      else {
        $('bt-info').textContent = d.warning || (body && body.mac ? 'готово: ' + (body.mac || '') : 'готово');
        if (d.devices) btRender(d);
      }
    } catch (e) {
      $('bt-info').textContent = 'ошибка: ' + e.message;
    } finally {
      btUi.busy = false;
      loadBt();
    }
  }

  $('bt-refresh').addEventListener('click', () => loadBt());

  $('bt-power').addEventListener('click', () => {
    const on = !(btUi.controller && btUi.controller.powered);
    btAction('/api/bluetooth/power', { on: on }, on ? 'включаю адаптер…' : 'выключаю адаптер…');
  });

  $('bt-scan').addEventListener('click', async () => {
    if (btUi.busy) return;
    btUi.busy = true;
    $('bt-info').textContent = 'сканирую 8 секунд…';
    try {
      const r = await fetch('/api/bluetooth/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 8 }),
      });
      const d = await r.json();
      if (d.error) $('bt-info').textContent = d.error;
      else { $('bt-info').textContent = 'найдено устройств: ' + (d.devices || []).length; btRender(d); }
    } catch (e) {
      $('bt-info').textContent = 'ошибка сканирования: ' + e.message;
    } finally {
      btUi.busy = false;
      loadBt();
    }
  });

  function btStartPolling() {
    if (btUi.timer) clearInterval(btUi.timer);
    btUi.timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !btUi.busy) loadBt();
    }, 12000);
  }

  /* ---------- старт ---------- */
  async function init() {
    fitCanvases();
    try {
      const r = await fetch('/api/sources', { cache: 'no-store' });
      const d = await r.json();
      const srcs = d.sources || [];
      sourceSel.innerHTML = '';
      for (const s of srcs) {
        const o = document.createElement('option');
        o.value = s.name;
        o.textContent = s.name;
        sourceSel.appendChild(o);
      }
      const usb = srcs.find((s) => /usb/i.test(s.name));
      const pick = usb ? usb.name : (srcs[0] && srcs[0].name);
      if (pick) sourceSel.value = pick;
      sourceSel.addEventListener('change', () => { connect(sourceSel.value); loadAudio(sourceSel.value); });
      await refreshRecordings();
      await loadAsr();
      await loadTts();
      await loadLlm();
      await loadAudio(pick);
      await loadBt();
      btStartPolling();
      connect(pick);
    } catch (e) {
      subtitle.textContent = 'ошибка подключения: ' + e.message;
      dot.className = 'dot err';
    }
    setInterval(() => {
      if (state.recording) {
        recInfo.textContent = 'запись: ' + (state.recording.ms / 1000).toFixed(1) + ' с';
      }
      if (state.capturing && Date.now() - state.lastFrameAt > 3000) {
        dot.className = 'dot err';
        state.capturing = false;
      }
    }, 500);
  }

  init();
})();
