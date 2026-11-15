
'use strict';
/**
 * voice-service — отладка микрофона в локальной сети.
 * Захват с серверного микрофона (PulseAudio/parec) -> SSE в браузер (уровни + PCM),
 * запись в WAV и воспроизведение.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT || 8092);
const HOST = process.env.HOST || '0.0.0.0';
const RATE = Number(process.env.RATE || 16000);
const CHUNK_MS = Number(process.env.CHUNK_MS || 40);
const CHUNK_BYTES = (Math.round((RATE * CHUNK_MS) / 1000) * 2) || 1280;
const IDLE_STOP_MS = Number(process.env.IDLE_STOP_MS || 8000);
const REC_DIR = path.join(__dirname, 'recordings');
const DATA_DIR = path.join(__dirname, 'data');
const TTS_DIR = path.join(__dirname, 'tts');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_RECORDS = 100;

fs.mkdirSync(REC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TTS_DIR, { recursive: true });

/* ---------- утилиты ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function wavHeader(dataBytes, rate, channels, bits) {
  const h = Buffer.alloc(44);
  const byteRate = (rate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

function listSources(cb) {
  execFile('pactl', ['list', 'short', 'sources'], { timeout: 5000 }, (err, stdout) => {
    if (err) return cb(err);
    const out = [];
    for (const line of String(stdout).split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const name = parts[1];
      if (!name || name.endsWith('.monitor')) continue;
      out.push({ name, driver: parts[2] || '' });
    }
    cb(null, out);
  });
}

function pickSource(srcs) {
  if (!srcs || !srcs.length) return null;
  const usb = srcs.find((s) => /usb/i.test(s.name));
  return (usb || srcs[0]).name;
}

function resolveSource(cb) {
  if (capture.source) return cb(capture.source);
  listSources((err, srcs) => {
    const src = (!err && pickSource(srcs)) || null;
    if (src) capture.source = src;
    cb(src);
  });
}

/* ---------- захват звука ---------- */
const capture = {
  source: process.env.SOURCE || null,
  proc: null,
  buf: Buffer.alloc(0),
  clients: new Set(),
  rec: null,
  idleTimer: null,
  lastError: null,
  startedAt: 0,
  frames: 0,
};

function stopIdleTimer() {
  if (capture.idleTimer) {
    clearTimeout(capture.idleTimer);
    capture.idleTimer = null;
  }
}

function scheduleIdleStop() {
  stopIdleTimer();
  if (capture.clients.size > 0 || capture.rec || asr.enabled) return;
  capture.idleTimer = setTimeout(() => {
    if (capture.clients.size === 0 && !capture.rec && !asr.enabled) stopCapture();
  }, IDLE_STOP_MS);
}

function startCapture(source) {
  if (source && source !== capture.source) {
    if (capture.proc) stopCapture();
    capture.source = source;
  }
  if (capture.proc) return;
  const args = ['--format=s16le', '--rate=' + RATE, '--channels=1', '--raw', '--latency-msec=20', '--process-time-msec=20'];
  if (capture.source) args.unshift('--device=' + capture.source);
  const proc = spawn('parec', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  capture.proc = proc;
  capture.buf = Buffer.alloc(0);
  capture.startedAt = Date.now();
  capture.lastError = null;

  proc.stdout.on('data', (chunk) => {
    capture.buf = capture.buf.length ? Buffer.concat([capture.buf, chunk]) : chunk;
    let off = 0;
    while (capture.buf.length - off >= CHUNK_BYTES) {
      const frameBuf = capture.buf.subarray(off, off + CHUNK_BYTES);
      off += CHUNK_BYTES;
      handleFrame(frameBuf);
    }
    capture.buf = capture.buf.subarray(off);
    if (capture.buf.length > CHUNK_BYTES * 64) capture.buf = Buffer.alloc(0);
  });

  let errBuf = '';
  proc.stderr.on('data', (d) => {
    errBuf = (errBuf + d.toString()).slice(-2000);
  });

  proc.on('exit', (code, sig) => {
    if (capture.proc === proc) capture.proc = null;
    capture.buf = Buffer.alloc(0);
    capture.lastError = errBuf.trim() || ('parec exited: ' + (code != null ? code : sig));
    broadcast('status', { capturing: false, error: capture.lastError });
    if (capture.rec) finishRecording('capture interrupted');
    if (capture.clients.size > 0) {
      setTimeout(() => {
        if (capture.clients.size > 0 && !capture.proc) startCapture();
      }, 1000);
    }
  });
}

function stopCapture() {
  stopIdleTimer();
  const proc = capture.proc;
  capture.proc = null;
  if (proc) {
    try { proc.kill('SIGTERM'); } catch (e) {}
  }
  broadcast('status', { capturing: false });
}

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of capture.clients) {
    try { res.write(payload); } catch (e) { capture.clients.delete(res); }
  }
}

function handleFrame(buf) {
  capture.frames++;
  let sum = 0;
  let peak = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    if (a >= 32767) capture.clipped = (capture.clipped || 0) + 1;
  }
  const rms = Math.sqrt(sum / (n || 1));
  const db = rms > 0 ? 20 * Math.log10(rms / 32768) : -120;
  const clip = peak >= 32700;

  if (capture.rec) {
    try {
      fs.writeSync(capture.rec.fd, buf);
      capture.rec.bytes += buf.length;
    } catch (e) {
      finishRecording('write error: ' + e.message);
    }
  }

  if (asr.proc && asr.ready && asr.enabled) {
    try {
      if (asr.proc.stdin.writableLength < 160000) asr.proc.stdin.write(buf);
    } catch (e) { /* ignore */ }
  }

  if (capture.clients.size) {
    broadcast('level', {
      t: Date.now(),
      rms: Math.round(rms * 10) / 10,
      peak,
      db: Math.round(db * 10) / 10,
      clip,
      rec: capture.rec ? { name: capture.rec.name, bytes: capture.rec.bytes, ms: Date.now() - capture.rec.startedAt } : null,
      pcm: buf.toString('base64'),
    });
  }
}

/* ---------- запись ---------- */
function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function startRecording(nameOverride) {
  if (capture.rec) return capture.rec;
  const name = nameOverride || 'rec-' + timestampName() + '.wav';
  const file = path.join(REC_DIR, name);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, wavHeader(0, RATE, 1, 16));
  capture.rec = { fd, file, name, bytes: 0, startedAt: Date.now() };
  startCapture();
  broadcast('status', { recording: true, name });
  return capture.rec;
}

function finishRecording(reason) {
  const rec = capture.rec;
  if (!rec) return null;
  capture.rec = null;
  try {
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(rec.bytes, 0);
    fs.writeSync(rec.fd, sizeBuf, 0, 4, 40);
    sizeBuf.writeUInt32LE(rec.bytes + 36, 0);
    fs.writeSync(rec.fd, sizeBuf, 0, 4, 4);
    fs.closeSync(rec.fd);
  } catch (e) { /* ignore */ }
  const info = {
    name: rec.name,
    url: '/recordings/' + encodeURIComponent(rec.name),
    bytes: rec.bytes,
    duration: Math.round((rec.bytes / (RATE * 2)) * 1000) / 1000,
    createdAt: new Date(rec.startedAt).toISOString(),
    reason: reason || 'stopped',
  };
  console.log('[voice-service] recording saved', info.name, info.bytes, 'bytes');
  broadcast('status', { recording: false, saved: info });
  scheduleIdleStop();
  return info;
}

function listRecordings() {
  let files = [];
  try { files = fs.readdirSync(REC_DIR).filter((f) => f.endsWith('.wav')); } catch (e) {}
  return files
    .map((f) => {
      const st = fs.statSync(path.join(REC_DIR, f));
      return {
        name: f,
        url: '/recordings/' + encodeURIComponent(f),
        bytes: Math.max(0, st.size - 44),
        duration: Math.round(((st.size - 44) / (RATE * 2)) * 1000) / 1000,
        mtime: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    .slice(0, MAX_RECORDS);
}

/* ---------- статика ---------- */
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function serveRecording(req, res, name, headOnly, baseDir) {
  const safe = path.basename(decodeURIComponent(name));
  const filePath = path.join(baseDir || REC_DIR, safe);
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const range = req.headers.range;
    const size = st.size;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start > end) { res.writeHead(416); res.end(); return; }
      res.writeHead(206, {
        'Content-Type': 'audio/wav',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache',
      });
      if (headOnly) return res.end();
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    if (headOnly) return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------- конфиг и данные ---------- */
const os = require('os');
const CFG_PATH = path.join(DATA_DIR, 'config.json');
const HIST_PATH = path.join(DATA_DIR, 'history.json');
const PYTHON = process.env.PYTHON || (fs.existsSync('/home/r/bin/python3') ? '/home/r/bin/python3' : 'python3');

function defaultCfg() {
  return {
    asr: { model: '', wakeWord: 'антон', requireWake: true, silenceMs: 1200 },
    tts: {
      engine: 'espeak',
      espeak: { voice: 'ru', speed: 150, pitch: 50, amplitude: 100 },
      rhvoice: { voice: 'aleksandr', rate: 100, pitch: 100, volume: 100 },
    },
  };
}

function clamp(v, a, b) { v = Number(v); return isNaN(v) ? a : Math.min(b, Math.max(a, v)); }

function modelDirs() {
  return [path.join(__dirname, 'models'), path.join(os.homedir(), 'voice_bot')].filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch (e) { return false; }
  });
}

function listModels() {
  const out = [];
  const seen = new Set();
  for (const dir of modelDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/^vosk-model/.test(e.name) || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ name: e.name, path: path.join(dir, e.name) });
    }
  }
  return out;
}

function resolveModel(name) {
  const models = listModels();
  const hit = models.find((m) => m.name === name) || models[0];
  return hit || null;
}

function loadCfg() {
  const base = defaultCfg();
  let c;
  try { c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { return base; }
  const out = { asr: Object.assign(base.asr, c.asr || {}), tts: base.tts };
  const tts = c.tts || {};
  if (tts.engine) out.tts.engine = tts.engine;
  if (tts.espeak) Object.assign(out.tts.espeak, tts.espeak);
  if (tts.rhvoice) Object.assign(out.tts.rhvoice, tts.rhvoice);
  // миграция старого плоского формата {voice,speed,pitch,amplitude}
  if (tts.voice && !tts.espeak) {
    out.tts.engine = 'espeak';
    out.tts.espeak.voice = tts.voice;
    if (tts.speed != null) out.tts.espeak.speed = tts.speed;
    if (tts.pitch != null) out.tts.espeak.pitch = tts.pitch;
    if (tts.amplitude != null) out.tts.espeak.amplitude = tts.amplitude;
  }
  return out;
}

function saveCfg() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) { /* ignore */ }
}

let cfg = loadCfg();
if (!cfg.asr.model) {
  const ms = listModels();
  if (ms.length) cfg.asr.model = ms[0].name;
}

/* ---------- история голосового ввода ---------- */
const history = { items: [] };
(function loadHistory() {
  try {
    const d = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
    if (d && Array.isArray(d.items)) history.items = d.items.slice(0, 50);
  } catch (e) { /* ignore */ }
})();

function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HIST_PATH, JSON.stringify({ items: history.items }, null, 2));
  } catch (e) { /* ignore */ }
}

function addHistory(text, meta) {
  const item = Object.assign(
    { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, at: new Date().toISOString() },
    meta || {}
  );
  history.items.unshift(item);
  history.items = history.items.slice(0, 50);
  saveHistory();
  broadcast('history', { added: item });
  return item;
}

/* ---------- распознавание речи (Vosk) ---------- */
const asr = {
  proc: null, ready: false, enabled: false, model: null, error: null,
  buf: '', partial: '', armed: false, cmd: '', timer: null, disarmTimer: null,
};

function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function wakeIndex(words, wakeWord) {
  const w = normText(wakeWord).split(' ').filter(Boolean);
  if (!w.length) return -1;
  if (w.length === 1) {
    for (let i = 0; i < words.length; i++) {
      if (words[i] === w[0]) return i;
      if (w[0].length >= 4 && words[i].length >= 3 && levenshtein(words[i], w[0]) <= 1) return i;
    }
    return -1;
  }
  for (let i = 0; i + w.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < w.length; k++) {
      if (words[i + k] !== w[k] && levenshtein(words[i + k], w[k]) > 1) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function asrState() {
  return {
    enabled: asr.enabled,
    ready: asr.ready,
    model: asr.model || cfg.asr.model,
    armed: asr.armed,
    partial: asr.partial,
    error: asr.error,
  };
}

function startAsr() {
  if (asr.proc) return;
  const m = resolveModel(cfg.asr.model);
  if (!m) {
    asr.error = 'модель Vosk не найдена (ожидается каталог vosk-model-* в ' + modelDirs().join(' или ') + ')';
    broadcast('asr', { state: 'error', error: asr.error });
    return;
  }
  asr.ready = false;
  asr.error = null;
  asr.buf = '';
  const worker = path.join(__dirname, 'asr_worker.py');
  if (!fs.existsSync(worker)) {
    asr.error = 'не найден ' + worker;
    return;
  }
  const proc = spawn(PYTHON, [worker, '--model', m.path, '--rate', String(RATE)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  asr.proc = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    asr.buf += chunk;
    let i;
    while ((i = asr.buf.indexOf('\n')) >= 0) {
      const line = asr.buf.slice(0, i).trim();
      asr.buf = asr.buf.slice(i + 1);
      if (line) handleAsrLine(line);
    }
    if (asr.buf.length > 1e6) asr.buf = '';
  });
  let errBuf = '';
  proc.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4000); });
  proc.on('exit', (code) => {
    if (asr.proc !== proc) return; // это уже заменённый воркер
    asr.proc = null;
    asr.ready = false;
    if (asr.enabled) {
      asr.error = errBuf.trim().split('\n').slice(-3).join(' ') || ('asr_worker exited: ' + code);
      broadcast('asr', { state: 'error', error: asr.error });
      setTimeout(() => { if (asr.enabled && !asr.proc) startAsr(); }, 3000);
    }
  });
}

function stopAsr() {
  clearTimeout(asr.timer);
  clearTimeout(asr.disarmTimer);
  asr.armed = false;
  asr.cmd = '';
  asr.partial = '';
  const p = asr.proc;
  asr.proc = null;
  asr.ready = false;
  if (p) {
    try { p.stdin.end(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 1500);
  }
}

function handleAsrLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.type === 'ready') {
    asr.ready = true;
    asr.model = msg.model;
    broadcast('asr', Object.assign({ state: 'ready' }, asrState()));
    return;
  }
  if (msg.type === 'error') {
    asr.error = msg.error;
    broadcast('asr', { state: 'error', error: msg.error });
    return;
  }
  if (msg.type === 'partial') {
    asr.partial = msg.text;
    broadcast('asr', Object.assign({ type: 'partial' }, asrState()));
    return;
  }
  if (msg.type === 'final') {
    asr.partial = '';
    handleUtterance(msg.text);
  }
}

function scheduleFinalize() {
  clearTimeout(asr.timer);
  clearTimeout(asr.disarmTimer);
  asr.timer = setTimeout(finalizeCommand, clamp(cfg.asr.silenceMs, 300, 5000));
}

function scheduleDisarm() {
  clearTimeout(asr.disarmTimer);
  asr.disarmTimer = setTimeout(() => {
    if (!asr.cmd) {
      asr.armed = false;
      broadcast('asr', Object.assign({ type: 'idle' }, asrState()));
    }
  }, 8000);
}

function finalizeCommand() {
  const text = asr.cmd.trim();
  asr.cmd = '';
  asr.armed = false;
  clearTimeout(asr.disarmTimer);
  if (!text) {
    broadcast('asr', Object.assign({ type: 'idle' }, asrState()));
    return;
  }
  pushCommand(text, true);
}

function pushCommand(text, viaWake) {
  const item = addHistory(text, { viaWake: !!viaWake, source: 'vosk' });
  broadcast('cmd', { item });
  broadcast('asr', Object.assign({ type: 'idle' }, asrState()));
}

function handleUtterance(rawText) {
  const text = normText(rawText);
  if (!text) return;
  const words = text.split(' ');
  broadcast('asr', Object.assign({ type: 'final', text: text, ts: Date.now() }, asrState()));

  if (!cfg.asr.requireWake) {
    pushCommand(text, false);
    return;
  }
  if (!asr.armed) {
    const idx = wakeIndex(words, cfg.asr.wakeWord);
    if (idx < 0) {
      broadcast('asr', Object.assign({ type: 'ignored', text: text }, asrState()));
      return;
    }
    asr.armed = true;
    asr.cmd = words.slice(idx + 1).join(' ');
    broadcast('asr', Object.assign({ type: 'wake', text: text }, asrState()));
    if (asr.cmd) scheduleFinalize(); else scheduleDisarm();
    return;
  }
  asr.cmd = (asr.cmd ? asr.cmd + ' ' : '') + text;
  scheduleFinalize();
}

/* ---------- синтез речи: eSpeak NG и RHVoice ---------- */
let espeakVoicesCache = [{ id: 'ru', name: 'Russian' }];

function espeakBin() {
  if (process.env.ESPEAK_BIN) return { bin: process.env.ESPEAK_BIN, args: [], env: {} };
  if (fs.existsSync('/usr/bin/espeak-ng')) return { bin: '/usr/bin/espeak-ng', args: [], env: {} };
  const prefix = path.join(os.homedir(), '.local/opt/espeak-ng');
  return {
    bin: path.join(prefix, 'usr/bin/espeak-ng'),
    args: ['--path=' + path.join(prefix, 'usr/lib/x86_64-linux-gnu/espeak-ng-data')],
    env: { LD_LIBRARY_PATH: path.join(prefix, 'usr/lib/x86_64-linux-gnu') },
  };
}

function listVoices() {
  const es = espeakBin();
  return new Promise((resolve) => {
    execFile(es.bin, es.args.concat(['--voices=ru']), { env: Object.assign({}, process.env, es.env), timeout: 8000 }, (err, stdout) => {
      if (err) return resolve([]);
      const lines = String(stdout).split('\n').slice(1);
      const out = [];
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        const lang = cols[1];
        const name = cols[3];
        if (!lang || !name) continue;
        out.push({ id: lang, name: name, age: cols[2] || '', file: cols[4] || '' });
      }
      resolve(out);
    });
  });
}

function wavDuration(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    if (head.toString('ascii', 0, 4) !== 'RIFF') return 0;
    let pos = 12;
    let byteRate = 0;
    const size = fs.statSync(file).size;
    while (pos + 8 <= Math.min(size, 4096)) {
      const id = head.toString('ascii', pos, pos + 4);
      const len = head.readUInt32LE(pos + 4);
      if (id === 'fmt ' && pos + 16 <= 64) byteRate = head.readUInt32LE(pos + 16);
      if (id === 'data') return byteRate ? Math.round((size - (pos + 8)) / byteRate) : 0;
      pos += 8 + len + (len % 2);
    }
    return 0;
  } catch (e) { return 0; }
}

function playWav(file, cb) {
  execFile('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], { env: Object.assign({}, process.env, { LC_ALL: 'C' }), timeout: 5000 }, (err, stdout) => {
    const muted = !err && /yes/i.test(stdout);
    const start = () => {
      const p = spawn('paplay', [file], { stdio: 'ignore' });
      p.on('error', (e) => cb(e));
      p.on('exit', () => {
        if (muted) execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '1'], () => {});
        cb(null);
      });
    };
    if (muted) execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0'], () => start());
    else start();
  });
}

/* ---------- синтез речи: eSpeak NG и RHVoice ---------- */
function rhvoiceBin() {
  const prefix = process.env.RHVOICE_PREFIX || path.join(os.homedir(), '.local/opt/rhvoice');
  return {
    bin: path.join(prefix, 'usr/bin/RHVoice-test'),
    dataPath: path.join(prefix, 'usr/share/RHVoice'),
    libPath: path.join(prefix, 'usr/lib/x86_64-linux-gnu'),
    available: fs.existsSync(path.join(prefix, 'usr/bin/RHVoice-test')),
  };
}

function rhvoiceVoices() {
  const rv = rhvoiceBin();
  const dir = path.join(rv.dataPath, 'voices');
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const meta = {};
    try {
      const raw = fs.readFileSync(path.join(dir, ent.name, 'voice.info'), 'utf8');
      for (const line of raw.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    } catch (e) { /* ignore */ }
    out.push({ id: ent.name, name: meta.name || ent.name, language: meta.language || '', gender: meta.gender || '' });
  }
  const rank = (v) => (v.language === 'Russian' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function ttsEngines() {
  const rv = rhvoiceBin();
  return [
    {
      id: 'espeak',
      name: 'eSpeak NG',
      available: true,
      voices: espeakVoicesCache,
      params: { speed: [80, 450], pitch: [0, 99], amplitude: [0, 200] },
      defaults: { voice: 'ru', speed: 150, pitch: 50, amplitude: 100 },
    },
    {
      id: 'rhvoice',
      name: 'RHVoice',
      available: rv.available,
      voices: rv.available ? rhvoiceVoices() : [],
      params: { rate: [50, 200], pitch: [50, 200], volume: [0, 100] },
      defaults: { voice: '', rate: 100, pitch: 100, volume: 100 },
    },
  ];
}

function runEspeak(text, opts, file, cb) {
  const es = espeakBin();
  const args = es.args.concat([
    '-v', opts.voice,
    '-s', String(opts.speed),
    '-p', String(opts.pitch),
    '-a', String(opts.amplitude),
    '-w', file,
    text,
  ]);
  execFile(es.bin, args, { env: Object.assign({}, process.env, es.env), timeout: 30000, maxBuffer: 1 << 20 }, (err) => {
    if (err) return cb(err);
    cb(null);
  });
}

function runRhvoice(text, opts, file, cb) {
  const rv = rhvoiceBin();
  if (!rv.available) return cb(new Error('RHVoice не установлен (' + rv.bin + ')'));
  const env = Object.assign({}, process.env, {
    LD_LIBRARY_PATH: rv.libPath + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''),
    RHVOICE_DATA_PATH: rv.dataPath,
  });
  const args = [
    '-p', opts.voice,
    '-r', String(opts.rate),
    '-t', String(opts.pitch),
    '-v', String(opts.volume),
    '-o', file,
  ];
  const proc = spawn(rv.bin, args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let errBuf = '';
  proc.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-2000); });
  proc.on('error', (e) => cb(e));
  proc.on('exit', (code) => {
    if (code !== 0) return cb(new Error(errBuf.trim() || ('RHVoice-test exit ' + code)));
    if (!fs.existsSync(file) || fs.statSync(file).size <= 44) {
      return cb(new Error(errBuf.trim() || 'RHVoice не создал звук'));
    }
    cb(null);
  });
  proc.stdin.end(text);
}

function synthesize(text, opts, cb) {
  const engine = opts.engine === 'rhvoice' ? 'rhvoice' : 'espeak';
  const name = 'tts-' + timestampName() + '.wav';
  const file = path.join(TTS_DIR, name);
  const finish = (err) => {
    if (err) return cb(err);
    const info = {
      name: name,
      url: '/tts/' + encodeURIComponent(name),
      duration: wavDuration(file),
      bytes: fs.statSync(file).size,
      engine: engine,
      voice: opts.voice,
      params: opts.params,
      played: false,
    };
    if (opts.play === false) return cb(null, info);
    playWav(file, (perr) => {
      info.played = !perr;
      info.playError = perr ? perr.message : null;
      cb(null, info);
    });
  };
  if (engine === 'rhvoice') runRhvoice(text, opts, file, finish);
  else runEspeak(text, opts, file, finish);
}

function buildTtsOptions(body) {
  const engine = body.engine === 'rhvoice' ? 'rhvoice'
    : body.engine === 'espeak' ? 'espeak'
    : (cfg.tts.engine === 'rhvoice' ? 'rhvoice' : 'espeak');
  if (engine === 'rhvoice') {
    if (!rhvoiceBin().available) return { error: 'RHVoice не установлен на сервере', status: 503 };
    const d = cfg.tts.rhvoice || {};
    const voices = rhvoiceVoices();
    const voice = String(body.voice || d.voice || (voices[0] && voices[0].id) || '');
    if (!voice) return { error: 'нет установленных голосов RHVoice', status: 503 };
    const opts = {
      engine: engine,
      voice: voice,
      rate: clamp(body.rate != null ? body.rate : d.rate, 50, 200),
      pitch: clamp(body.pitch != null ? body.pitch : d.pitch, 50, 200),
      volume: clamp(body.volume != null ? body.volume : d.volume, 0, 100),
      play: body.play !== false,
    };
    cfg.tts.rhvoice = { voice: opts.voice, rate: opts.rate, pitch: opts.pitch, volume: opts.volume };
    opts.params = { rate: opts.rate, pitch: opts.pitch, volume: opts.volume };
    cfg.tts.engine = engine;
    saveCfg();
    return { engine: engine, opts: opts };
  }
  const d = cfg.tts.espeak || {};
  const opts = {
    engine: 'espeak',
    voice: String(body.voice || d.voice || 'ru').slice(0, 32),
    speed: clamp(body.speed != null ? body.speed : d.speed, 80, 450),
    pitch: clamp(body.pitch != null ? body.pitch : d.pitch, 0, 99),
    amplitude: clamp(body.amplitude != null ? body.amplitude : d.amplitude, 0, 200),
    play: body.play !== false,
  };
  cfg.tts.espeak = { voice: opts.voice, speed: opts.speed, pitch: opts.pitch, amplitude: opts.amplitude };
  opts.params = { speed: opts.speed, pitch: opts.pitch, amplitude: opts.amplitude };
  cfg.tts.engine = 'espeak';
  saveCfg();
  return { engine: 'espeak', opts: opts };
}

function readBody(req, cb, limit) {
  let chunks = [];
  let n = 0;
  const max = limit || 1 << 20;
  req.on('data', (d) => {
    n += d.length;
    if (n > max) { req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    const s = Buffer.concat(chunks).toString('utf8');
    if (!s.trim()) return cb(null, {});
    try { cb(null, JSON.parse(s)); } catch (e) { cb(e); }
  });
  req.on('error', (e) => cb(e));
}

/* ---------- системный звук (PulseAudio + ALSA) ---------- */
const { execFileSync } = require('child_process');

function pactlJson(args) {
  const out = execFileSync('pactl', ['--format=json'].concat(args), { timeout: 8000, maxBuffer: 1 << 22 });
  return JSON.parse(out.toString());
}

function pulseVolume(vol) {
  if (!vol) return 100;
  const first = Object.values(vol)[0];
  if (!first) return 100;
  if (first.value_percent) return Math.round(parseFloat(first.value_percent));
  return Math.round((first.value / 65536) * 100);
}

function prettyDevice(name) {
  if (/bluez/.test(name)) return 'Bluetooth';
  if (/usb/i.test(name)) return 'USB-устройство';
  if (/pci-/.test(name)) {
    let label = 'Встроенная карта';
    if (/analog/.test(name)) label += ' · аналог';
    else if (/iec958|hdmi/.test(name)) label += ' · цифровой';
    return label;
  }
  return name;
}

function amixerControls(card) {
  const controls = [];
  let out;
  try {
    out = execFileSync('amixer', ['-c', String(card), 'scontrols'], { timeout: 5000 }).toString();
  } catch (e) {
    return controls;
  }
  const names = Array.from(out.matchAll(/'([^']+)'/g), (m) => m[1]);
  for (const nm of names) {
    if (!/mic|gain|capture|boost/i.test(nm)) continue;
    let txt;
    try {
      txt = execFileSync('amixer', ['-c', String(card), 'sget', nm], { timeout: 5000 }).toString();
    } catch (e) { continue; }
    const lim = txt.match(/Limits:\s+\S+\s+(-?\d+)\s+-\s+(-?\d+)/);
    if (lim) {
      const val = txt.match(/(?:Mono|Front Left|Capture):\s*(?:\S+\s+)?(-?\d+)\s*\[/);
      if (val) {
        controls.push({ id: nm, kind: 'int', min: Number(lim[1]), max: Number(lim[2]), value: Number(val[1]) });
        continue;
      }
    }
    if (/\[(on|off)\]/i.test(txt)) {
      controls.push({ id: nm, kind: 'bool', value: /\[on\]/i.test(txt) });
    }
  }
  return controls;
}

function audioState(sourceName) {
  const sinks = pactlJson(['list', 'sinks']).map((s) => ({
    name: s.name,
    label: prettyDevice(s.name),
    volume: pulseVolume(s.volume),
    mute: !!s.mute,
    monitor: false,
  }));
  const sources = pactlJson(['list', 'sources'])
    .filter((s) => !s.name.endsWith('.monitor'))
    .map((s) => ({
      name: s.name,
      label: prettyDevice(s.name),
      volume: pulseVolume(s.volume),
      mute: !!s.mute,
      card: s.properties && s.properties['alsa.card'] ? Number(s.properties['alsa.card']) : null,
    }));
  const defaultSink = execFileSync('pactl', ['get-default-sink'], { timeout: 5000 }).toString().trim();
  const defaultSource = execFileSync('pactl', ['get-default-source'], { timeout: 5000 }).toString().trim();
  const target = sourceName || defaultSource;
  const src = sources.find((s) => s.name === target) || sources[0];
  const card = src && src.card != null ? { index: src.card, controls: amixerControls(src.card) } : null;
  return { sinks, sources, defaultSink, defaultSource, card };
}

function audioSet(kind, body) {
  const isSink = kind === 'sink';
  const name = String(body.name || '');
  if (!name) return { error: 'не указано устройство' };
  if (body.volume != null) {
    const v = clamp(body.volume, 0, 150);
    execFileSync('pactl', [isSink ? 'set-sink-volume' : 'set-source-volume', name, v + '%'], { timeout: 5000 });
  }
  if (body.mute != null) {
    execFileSync('pactl', [isSink ? 'set-sink-mute' : 'set-source-mute', name, body.mute ? '1' : '0'], { timeout: 5000 });
  }
  if (body.setDefault) {
    execFileSync('pactl', [isSink ? 'set-default-sink' : 'set-default-source', name], { timeout: 5000 });
  }
  return { ok: true };
}

function cardSet(card, control, value) {
  const idx = String(Number(card));
  if (idx === 'NaN' || !control) return { error: 'неверная карта или контрол' };
  const val = typeof value === 'boolean' ? (value ? 'on' : 'off') : String(Number(value));
  if (val === 'NaN') return { error: 'неверное значение' };
  execFileSync('amixer', ['-c', idx, 'sset', String(control), val], { timeout: 5000 });
  return { ok: true };
}

function playTestTone(sink, cb) {
  const file = path.join(TTS_DIR, 'test-tone.wav');
  execFile('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.7', '-af', 'volume=0.35', '-ar', '44100', file], { timeout: 15000 }, (err) => {
    if (err) return cb(err);
    const args = sink ? ['--device=' + sink, file] : [file];
    const proc = spawn('paplay', args, { stdio: 'ignore' });
    proc.on('error', (e) => cb(e));
    proc.on('exit', (code) => cb(code === 0 ? null : new Error('paplay exit ' + code)));
  });
}

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;
  const method = req.method || 'GET';

  if (p.startsWith('/api/')) {
    if (p === '/api/sources') {
      return listSources((err, srcs) => {
        if (err) return sendJson(res, { error: 'pactl failed: ' + err.message }, 500);
        sendJson(res, { sources: srcs, active: capture.source, rate: RATE, chunkMs: CHUNK_MS });
      });
    }
    if (p === '/api/status') {
      return sendJson(res, {
        capturing: !!capture.proc,
        source: capture.source,
        rate: RATE,
        clients: capture.clients.size,
        recording: capture.rec ? { name: capture.rec.name, bytes: capture.rec.bytes, ms: Date.now() - capture.rec.startedAt } : null,
        lastError: capture.lastError,
        asr: asrState(),
        recordings: listRecordings().slice(0, 10),
      });
    }
    if (p === '/api/record/start') {
      if (capture.rec) return sendJson(res, { ok: true, already: true, name: capture.rec.name });
      const q = u.searchParams.get('source');
      if (q && q !== capture.source) stopCapture();
      if (q) capture.source = q;
      resolveSource((src) => {
        if (!src) return sendJson(res, { error: 'no audio source found (pactl list short sources)' }, 503);
        startRecording();
        sendJson(res, { ok: true, name: capture.rec.name, source: src, startedAt: new Date(capture.rec.startedAt).toISOString() });
      });
      return;
    }
    if (p === '/api/record/stop') {
      if (!capture.rec) return sendJson(res, { error: 'not recording' }, 400);
      const info = finishRecording('stopped');
      return sendJson(res, { ok: true, recording: info });
    }
    if (p === '/api/recordings') {
      return sendJson(res, { recordings: listRecordings() });
    }
    if (p === '/api/recordings/delete') {
      const name = u.searchParams.get('name') || '';
      const safe = path.basename(name);
      if (!safe.endsWith('.wav')) return sendJson(res, { error: 'bad name' }, 400);
      try { fs.unlinkSync(path.join(REC_DIR, safe)); } catch (e) { return sendJson(res, { error: e.message }, 404); }
      return sendJson(res, { ok: true });
    }
    if (p === '/api/asr/options') {
      return sendJson(res, {
        models: listModels(),
        config: cfg.asr,
        state: asrState(),
        history: history.items.slice(0, 20),
      });
    }
    if (p === '/api/asr/start') {
      asr.enabled = true;
      asr.error = null;
      startCapture();
      startAsr();
      return sendJson(res, { ok: true, state: asrState() });
    }
    if (p === '/api/asr/stop') {
      asr.enabled = false;
      stopAsr();
      broadcast('asr', Object.assign({ state: 'stopped' }, asrState()));
      scheduleIdleStop();
      return sendJson(res, { ok: true, state: asrState() });
    }
    if (p === '/api/asr/simulate') {
      return readBody(req, (err, body) => {
        if (err) return sendJson(res, { error: 'bad json' }, 400);
        const text = String((body && body.text) || '').trim();
        if (!text) return sendJson(res, { error: 'empty text' }, 400);
        handleUtterance(text);
        sendJson(res, { ok: true, heard: text, state: asrState() });
      });
    }
    if (p === '/api/asr/config') {
      return readBody(req, (err, body) => {
        if (err) return sendJson(res, { error: 'bad json' }, 400);
        const a = cfg.asr;
        if (body.model !== undefined) a.model = String(body.model);
        if (body.wakeWord !== undefined) a.wakeWord = String(body.wakeWord).slice(0, 64);
        if (body.requireWake !== undefined) a.requireWake = !!body.requireWake;
        if (body.silenceMs !== undefined) a.silenceMs = clamp(body.silenceMs, 300, 5000);
        saveCfg();
        const modelChanged = body.model !== undefined;
        if (asr.enabled) {
          stopAsr();
          startAsr();
        }
        broadcast('asr', Object.assign({ state: asr.ready ? 'ready' : 'starting' }, asrState()));
        sendJson(res, { ok: true, config: cfg.asr, state: asrState(), restart: modelChanged });
      });
    }
    if (p === '/api/asr/history') {
      return sendJson(res, { items: history.items });
    }
    if (p === '/api/asr/history/clear') {
      history.items = [];
      saveHistory();
      broadcast('history', { cleared: true });
      return sendJson(res, { ok: true });
    }
    if (p === '/api/asr/history/delete') {
      return readBody(req, (err, body) => {
        const id = String((body && body.id) || u.searchParams.get('id') || '');
        history.items = history.items.filter((x) => x.id !== id);
        saveHistory();
        broadcast('history', { cleared: false });
        sendJson(res, { ok: true });
      });
    }
    if (p === '/api/audio') {
      try {
        return sendJson(res, audioState(u.searchParams.get('source')));
      } catch (e) {
        return sendJson(res, { error: 'pactl: ' + e.message }, 500);
      }
    }
    if (p === '/api/audio/sink' || p === '/api/audio/source') {
      return readBody(req, (err, body) => {
        if (err) return sendJson(res, { error: 'bad json' }, 400);
        try {
          const r = audioSet(p.endsWith('sink') ? 'sink' : 'source', body);
          if (r.error) return sendJson(res, r, 400);
          sendJson(res, { ok: true, state: audioState(body.source || null) });
        } catch (e) {
          sendJson(res, { error: e.message }, 500);
        }
      });
    }
    if (p === '/api/audio/card') {
      return readBody(req, (err, body) => {
        if (err) return sendJson(res, { error: 'bad json' }, 400);
        try {
          const r = cardSet(body.card, body.control, body.value);
          if (r.error) return sendJson(res, r, 400);
          sendJson(res, { ok: true, state: audioState(body.source || null) });
        } catch (e) {
          sendJson(res, { error: e.message }, 500);
        }
      });
    }
    if (p === '/api/audio/test') {
      return readBody(req, (err, body) => {
        if (err) return sendJson(res, { error: 'bad json' }, 400);
        playTestTone(body.sink || null, (terr) => {
          if (terr) return sendJson(res, { error: terr.message }, 500);
          sendJson(res, { ok: true });
        });
      });
    }
    if (p === '/api/tts/options') {
      return listVoices().then((voices) => {
        if (voices.length) espeakVoicesCache = voices;
        const engines = ttsEngines();
        const rv = engines.find((e) => e.id === 'rhvoice');
        if (rv && cfg.tts.rhvoice) {
          const known = rv.voices.some((v) => v.id === cfg.tts.rhvoice.voice);
          if (!known && rv.voices.length) cfg.tts.rhvoice.voice = rv.voices[0].id;
        }
        sendJson(res, {
          engines: engines,
          config: cfg.tts,
          bin: espeakBin().bin,
          rhvoice: { bin: rhvoiceBin().bin, dataPath: rhvoiceBin().dataPath, available: rhvoiceBin().available },
        });
      });
    }
    if (p === '/api/tts/config') {
      if (method !== 'POST') return sendJson(res, { error: 'POST required' }, 405);
      return readBody(req, (err, body) => {
        if (err) return sendJson(res, { error: 'bad json' }, 400);
        const built = buildTtsOptions(body);
        if (built.error) return sendJson(res, { error: built.error }, built.status || 400);
        broadcast('tts', { config: cfg.tts });
        sendJson(res, { ok: true, engine: built.engine, config: cfg.tts, params: built.opts.params, voice: built.opts.voice });
      });
    }
    if (p === '/api/tts') {
      if (method !== 'POST') return sendJson(res, { error: 'POST required' }, 405);
      return readBody(req, (err, body) => {
        if (err) return sendJson(res, { error: 'bad json' }, 400);
        const text = String(body.text || '').trim().slice(0, 2000);
        if (!text) return sendJson(res, { error: 'пустой текст' }, 400);
        const built = buildTtsOptions(body);
        if (built.error) return sendJson(res, { error: built.error }, built.status || 400);
        synthesize(text, built.opts, (serr, info) => {
          if (serr) return sendJson(res, { error: (built.engine === 'rhvoice' ? 'RHVoice: ' : 'espeak: ') + serr.message }, 500);
          broadcast('tts', { spoken: info });
          sendJson(res, { ok: true, ...info });
        });
      });
    }

    if (p === '/api/stream') {
      const src = u.searchParams.get('source');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      res.write('event: hello\ndata: ' + JSON.stringify({ rate: RATE, chunkMs: CHUNK_MS, source: capture.source, capturing: !!capture.proc, asr: asrState(), history: history.items.slice(0, 20) }) + '\n\n');
      capture.clients.add(res);
      stopIdleTimer();
      if (src) startCapture(src); else startCapture();
      req.on('close', () => {
        capture.clients.delete(res);
        scheduleIdleStop();
      });
      return;
    }
    return sendJson(res, { error: 'unknown api' }, 404);
  }

  if (p === '/favicon.ico' || p === '/favicon.svg') {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#171a21"/><g fill="#4cc9f0"><rect x="14" y="26" width="5" height="12" rx="2.5"/><rect x="23" y="18" width="5" height="28" rx="2.5"/><rect x="32" y="10" width="5" height="44" rx="2.5"/><rect x="41" y="22" width="5" height="20" rx="2.5"/><rect x="50" y="28" width="4" height="8" rx="2"/></g></svg>';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    return res.end(svg);
  }
  if (p.startsWith('/recordings/')) {
    return serveRecording(req, res, p.slice('/recordings/'.length), method === 'HEAD');
  }
  if (p.startsWith('/tts/')) {
    return serveRecording(req, res, p.slice('/tts/'.length), method === 'HEAD', TTS_DIR);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return;
  }
  return serveStatic(req, res, p);
});

server.on('error', (e) => {
  console.error('[voice-service] server error:', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('[voice-service] listening on http://' + HOST + ':' + PORT + ' rate=' + RATE + 'Hz');
  resolveSource((src) => console.log('[voice-service] default source:', src || 'none'));
});

function shutdown() {
  finishRecording('shutdown');
  stopCapture();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
