'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('ffprobe-static').path.replace('app.asar', 'app.asar.unpacked');
// Shared with the renderer, which loads the same file as a <script> global. One
// definition of what an audio effect means, so preview and render cannot drift apart.
const AudioFX = require('./audiofx.js');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.ts']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);
/** Stills. The timeline cannot hold one yet, but the QuickBin keeps them for transitions. */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

let win = null;
/** @type {import('child_process').ChildProcess|null} */
let activeRender = null;
/** Mirrored from the renderer so the close handler knows whether to warn. */
let projectDirty = false;
/** Set once the user has answered the "save before closing?" prompt. */
let allowClose = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    title: 'ShortCut - 9:16 Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Needed so <video src="file:///..."> can load the user's media in the renderer.
      webSecurity: false,
      // The playback clock rides on requestAnimationFrame. Chromium throttles that to a
      // crawl for backgrounded windows, which would freeze the playhead while the audio
      // elements kept running - the two would drift apart every time the window lost
      // focus. Media apps want the real clock.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Set SHORTCUT_DEBUG=1 to mirror renderer console output into the terminal.
  if (process.env.SHORTCUT_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log('[renderer:' + level + '] ' + message + ' (' + source + ':' + line + ')');
    });
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // Set SHORTCUT_SMOKE=<path-to-js> to run a script against the live renderer and exit.
  // Used by the smoke test in tools/ - see README.
  if (process.env.SHORTCUT_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const script = fs.readFileSync(process.env.SHORTCUT_SMOKE, 'utf8');
      try {
        const out = await win.webContents.executeJavaScript(script, true);
        console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      } catch (e) {
        console.log('SMOKE ERROR: ' + (e && e.message));
        process.exitCode = 1;
      }
      // Set SHORTCUT_SHOT=<path.png> alongside it to also capture the window.
      if (process.env.SHORTCUT_SHOT) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.SHORTCUT_SHOT, img.toPNG());
        console.log('screenshot -> ' + process.env.SHORTCUT_SHOT);
      }
      // A smoke run is headless by definition, and every suite dirties the project as
      // soon as it imports a clip. Without this, app.quit() hits the unsaved-changes
      // guard below, which preventDefault()s and opens a modal nobody is there to answer
      // - electron then sits on that dialog until something kills it, holding the machine
      // and writing no output. This is the "Don't save" path, taken automatically.
      allowClose = true;
      app.quit();
    });
  }

  // Closing with unsaved work asks first. This MUST live in the main process: a
  // renderer `beforeunload` handler that calls preventDefault just blocks the close
  // silently in Electron, which is why the window used to ignore the quit button until
  // the project had been saved.
  win.on('close', async (e) => {
    if (allowClose || !projectDirty) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save and quit', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: 'This project has unsaved changes.',
      detail: 'Save them before closing?',
      noLink: true,
    });
    if (response === 2) return;                    // cancel: stay open
    if (response === 1) { allowClose = true; win.close(); return; }

    // Save and quit: the renderer owns the project data, so ask it to save and wait.
    saveThenQuit = true;
    win.webContents.send('app:requestSave');
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------------------------------------------------------------- media scan

/** Natural sort so "clip2" comes before "clip10" - the order the user sees in Explorer. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

/**
 * Expand dropped paths into an ordered, flat list of media files.
 *
 * `withImages` widens the filter to stills, which the timeline has no use for but the
 * QuickBin does.
 */
function expandPaths(paths, withImages) {
  const out = [];
  const wanted = (p) =>
    !!classify(p) || (withImages && IMAGE_EXT.has(path.extname(p).toLowerCase()));
  const walk = (p, depth) => {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      if (depth > 6) return;
      const entries = fs.readdirSync(p).sort(collator.compare);
      const files = [];
      const dirs = [];
      for (const e of entries) {
        try {
          if (fs.statSync(path.join(p, e)).isDirectory()) dirs.push(e); else files.push(e);
        } catch (err) { /* unreadable entry - skip */ }
      }
      // Files first (in folder order), then recurse into subfolders.
      for (const f of files) walk(path.join(p, f), depth + 1);
      for (const d of dirs) walk(path.join(p, d), depth + 1);
    } else if (wanted(p)) {
      out.push(p);
    }
  };
  for (const p of [...paths].sort(collator.compare)) walk(p, 0);
  return out;
}

function probe(file) {
  return new Promise((resolve) => {
    execFile(ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { maxBuffer: 1024 * 1024 * 16 }, (err, stdout) => {
      if (err) return resolve(null);
      let json;
      try { json = JSON.parse(stdout); } catch (e) { return resolve(null); }
      const streams = json.streams || [];
      const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const a = streams.find((s) => s.codec_type === 'audio');
      const dur = parseFloat((json.format && json.format.duration) || (v && v.duration) || (a && a.duration) || 0) || 0;
      let fps = 30;
      if (v && v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
        const parts = v.avg_frame_rate.split('/').map(Number);
        if (parts[1]) fps = parts[0] / parts[1];
      }
      resolve({
        path: file,
        name: path.basename(file),
        kind: v ? 'video' : 'audio',
        duration: dur,
        width: v ? Number(v.width) : 0,
        height: v ? Number(v.height) : 0,
        fps: Math.round(fps * 1000) / 1000,
        hasAudio: !!a,
      });
    });
  });
}

ipcMain.handle('media:scan', async (_e, paths) => {
  const files = expandPaths(paths || []);
  const metas = [];
  for (const f of files) {
    const m = await probe(f);
    if (m && m.duration > 0) metas.push(m);
  }
  return metas;
});

ipcMain.handle('media:pick', async () => {
  const exts = [...VIDEO_EXT, ...AUDIO_EXT].map((e) => e.slice(1));
  const r = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: exts }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('media:pickImage', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a PNG for the transition',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'webp', 'gif', 'jpg', 'jpeg'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('media:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import folder', properties: ['openDirectory'] });
  return r.canceled ? [] : r.filePaths;
});

// ----------------------------------------------------------------- QuickBin

/**
 * The QuickBin is a media library that outlives the project.
 *
 * It lives in userData, not in the .scut, precisely so the same clips, music and stills
 * are there in every project without importing them again. Nothing in it is copied - an
 * entry is a path plus the probe result, so the bin is small and the media stays where
 * the user put it.
 */
const binFile = () => path.join(app.getPath('userData'), 'quickbin.json');
const EMPTY_BIN = () => ({ version: 1, folders: [], items: [] });

function readBin() {
  try {
    const b = JSON.parse(fs.readFileSync(binFile(), 'utf8'));
    if (!b || typeof b !== 'object') return EMPTY_BIN();
    if (!Array.isArray(b.folders)) b.folders = [];
    if (!Array.isArray(b.items)) b.items = [];
    b.version = 1;
    return b;
  } catch (e) { return EMPTY_BIN(); }
}

ipcMain.handle('bin:read', () => {
  const b = readBin();
  // Tell the renderer which entries have gone missing so it can grey them out rather
  // than failing at the moment someone drops one on the timeline.
  for (const it of b.items) it.missing = !(it.path && fs.existsSync(it.path));
  return b;
});

ipcMain.handle('bin:write', (_e, data) => {
  const b = data && typeof data === 'object' ? data : EMPTY_BIN();
  const clean = {
    version: 1,
    folders: Array.isArray(b.folders) ? b.folders : [],
    // `missing` is a live check, not state - never persist it.
    items: (Array.isArray(b.items) ? b.items : []).map((it) => {
      const { missing, ...rest } = it;
      return rest;
    }),
  };
  const f = binFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(clean, null, 2), 'utf8');
  return true;
});

/** Like `media:scan`, but stills count too: the bin holds them for object transitions. */
ipcMain.handle('bin:scan', async (_e, paths) => {
  const files = expandPaths(paths || [], true);
  const out = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      let size = 0;
      try { size = fs.statSync(f).size; } catch (err) { continue; }
      out.push({
        path: f, name: path.basename(f), kind: 'image',
        duration: 0, width: 0, height: 0, fps: 0, hasAudio: false, size,
      });
      continue;
    }
    const m = await probe(f);
    if (m && m.duration > 0) out.push(m);
  }
  return out;
});

ipcMain.handle('bin:pick', async () => {
  const exts = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].map((e) => e.slice(1));
  const r = await dialog.showOpenDialog(win, {
    title: 'Add to the QuickBin',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: exts }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('bin:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add a folder to the QuickBin',
    properties: ['openDirectory', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

/** The immediate children of a folder, so importing one can mirror its subfolders. */
ipcMain.handle('bin:listDir', (_e, dir) => {
  const out = { isDir: false, files: [], dirs: [] };
  try { out.isDir = fs.statSync(dir).isDirectory(); } catch (e) { return out; }
  if (!out.isDir) return out;
  try {
    for (const name of fs.readdirSync(dir).sort(collator.compare)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch (err) { continue; }
      if (st.isDirectory()) out.dirs.push({ path: p, name });
      else if (classify(p) || IMAGE_EXT.has(path.extname(p).toLowerCase())) out.files.push(p);
    }
  } catch (e) { /* unreadable folder - report nothing rather than throwing */ }
  return out;
});

// -------------------------------------------------------- waveform peak cache

/**
 * Decoded audio peaks, cached on disk by path + size + mtime.
 *
 * Decoding a few minutes of audio in the renderer costs seconds, and the timeline needs
 * the peaks on every redraw. Keyed on the file's stats rather than its content so a
 * re-encoded file under the same name is redrawn rather than served stale.
 */
const waveDir = () => {
  const dir = path.join(app.getPath('userData'), 'cache', 'wave');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const waveFile = (p) =>
  path.join(waveDir(), crypto.createHash('sha1').update(String(p)).digest('hex') + '.json');

function fileStamp(p) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch (e) { return null; }
}

ipcMain.handle('wave:read', (_e, p) => {
  const stamp = fileStamp(p);
  if (!stamp) return null;
  try {
    const j = JSON.parse(fs.readFileSync(waveFile(p), 'utf8'));
    if (j.size !== stamp.size || j.mtime !== stamp.mtime) return null;
    return { peaks: j.peaks, duration: j.duration };
  } catch (e) { return null; }
});

ipcMain.handle('wave:write', (_e, { path: p, peaks, duration }) => {
  const stamp = fileStamp(p);
  if (!stamp || !Array.isArray(peaks)) return false;
  try {
    fs.writeFileSync(waveFile(p), JSON.stringify({
      size: stamp.size, mtime: stamp.mtime, duration: duration || 0, peaks,
    }), 'utf8');
    return true;
  } catch (e) { return false; }
});

// ------------------------------------------------------- silence detection

/**
 * Silence spans in a media file's audio, cached on disk by path + size + mtime.
 *
 * `silencedetect` is run ONCE per file at a permissive minimum duration (0.10s) and the
 * raw spans are cached whole. The editor's own "silences longer than N" threshold and its
 * pad are applied in the renderer, over the cached list - so dragging the threshold
 * slider re-counts instantly instead of re-decoding the file. The noise floor DOES change
 * what ffmpeg reports, so it is part of the cache key; the threshold and pad are not.
 *
 * Keyed on the file's stats rather than its content, exactly like the waveform cache, so
 * a re-encoded file under the same name is re-analysed rather than served stale.
 */
const RAW_SILENCE_MIN = 0.10;

const silenceDir = () => {
  const dir = path.join(app.getPath('userData'), 'cache', 'silence');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const silenceFile = (p, noise) =>
  path.join(silenceDir(),
    crypto.createHash('sha1').update(String(p) + '|' + noise).digest('hex') + '.json');

ipcMain.handle('analyze:silence', async (_e, { path: p, noise }) => {
  const db = Math.round(Number(noise) || -30);
  const stamp = fileStamp(p);
  if (!stamp) return { ok: false, error: 'File not found.' };

  const cacheFile = silenceFile(p, db);
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j.size === stamp.size && j.mtime === stamp.mtime && j.noise === db) {
      return { ok: true, cached: true, noise: db, spans: j.spans, duration: j.duration, hasAudio: j.hasAudio };
    }
  } catch (e) { /* no usable cache entry - measure it */ }

  const meta = await probe(p);
  const duration = meta ? meta.duration : 0;
  if (meta && !meta.hasAudio) {
    const empty = { size: stamp.size, mtime: stamp.mtime, noise: db, spans: [], duration, hasAudio: false };
    try { fs.writeFileSync(cacheFile, JSON.stringify(empty), 'utf8'); } catch (e) { /* cache is optional */ }
    return { ok: true, cached: false, noise: db, spans: [], duration, hasAudio: false };
  }

  const spans = await new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats', '-i', p, '-map', '0:a:0',
      '-af', 'silencedetect=noise=' + db + 'dB:d=' + RAW_SILENCE_MIN,
      '-f', 'null', '-',
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let log = '';
    proc.stderr.on('data', (d) => {
      log += d.toString();
      if (log.length > 4000000) log = log.slice(-2000000);
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const out = [];
      let open = null;
      // silencedetect prints one `silence_start` line, then a matching `silence_end`.
      for (const line of log.split(/\r?\n/)) {
        let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (m) { open = Math.max(0, parseFloat(m[1])); continue; }
        m = /silence_end:\s*(-?[\d.]+)/.exec(line);
        if (m && open != null) {
          const end = parseFloat(m[1]);
          if (isFinite(end) && end > open) out.push([r3(open), r3(end)]);
          open = null;
        }
      }
      // A file that ENDS in silence never gets its closing line. Closing it at the stream
      // duration is what makes trailing dead air cuttable at all.
      if (open != null && duration > open) out.push([r3(open), r3(duration)]);
      resolve(out);
    });
  });

  if (!spans) return { ok: false, error: 'ffmpeg could not read that file.' };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      size: stamp.size, mtime: stamp.mtime, noise: db, duration, hasAudio: true, spans,
    }), 'utf8');
  } catch (e) { /* an unwritable cache must never fail the analysis */ }
  return { ok: true, cached: false, noise: db, spans, duration, hasAudio: true };
});

/// ------------------------------------------------------------- transcription

/**
 * Speech to text, with WORD-level timings, cached on disk.
 *
 * WHY whisper.cpp AND NOT onnxruntime-node
 * ----------------------------------------
 * The other candidate was Whisper exported to ONNX and run through onnxruntime-node.
 * Three things ruled it out, and the third is decisive:
 *
 *  - it is not one model but two (encoder and decoder) plus a greedy/beam search loop, a
 *    tokenizer and a mel front-end, all of which would have to be written and maintained
 *    here in JS;
 *  - onnxruntime-node is a native module, so it needs an `asarUnpack` entry and a
 *    per-platform rebuild - exactly the packaging cost this app has so far paid only for
 *    ffmpeg;
 *  - word-level timestamps do not fall out of the model. Whisper emits them by aligning
 *    cross-attention with dynamic time warping, which whisper.cpp already implements and
 *    prints in `--output-json-full`. Re-deriving that in JS is the whole feature, and
 *    getting it subtly wrong makes every caption subtly late.
 *
 * whisper.cpp is one self-contained executable that reads a WAV and writes the JSON this
 * file parses. The trade is that the binary is not bundled - see `whisperBin()`.
 *
 * WHAT IS AND IS NOT DOWNLOADED
 * The MODEL is fetched on first use into `userData/models` with progress: it is one file
 * over plain HTTPS, identical on every platform. The BINARY is not - it is a
 * per-platform archive with per-build GPU variants, and quietly downloading and then
 * executing one is not something an editor should do behind the user's back. Point
 * SHORTCUT_WHISPER at it, or drop it in `userData/whisper`, and the panel says so while
 * it is missing. Every failure here degrades to a message, never to a broken render.
 */
const Captions = require('./captions.js');

/**
 * `dtw` is whisper.cpp's own name for that model's alignment-head preset, which is NOT
 * always the model's name (`large-v3-turbo` is `large.v3.turbo`). Pass the wrong one and
 * whisper refuses the flag; pass none and there are no word timings at all.
 */
const WHISPER_MODELS = {
  'tiny.en': { size: 77691713, dtw: 'tiny.en' },
  'base.en': { size: 147964211, dtw: 'base.en' },
  'small.en': { size: 487601967, dtw: 'small.en' },
  'medium.en': { size: 1533763059, dtw: 'medium.en' },
  'large-v3-turbo': { size: 1624555275, dtw: 'large.v3.turbo' },
};
const DEFAULT_MODEL = 'base.en';
const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

const modelsDir = () => {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const modelFile = (name) => path.join(modelsDir(), 'ggml-' + name + '.bin');

/** The whisper.cpp executable, or null. Env first, then userData, then PATH. */
function whisperBin() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const cands = [];
  if (process.env.SHORTCUT_WHISPER) cands.push(process.env.SHORTCUT_WHISPER);
  const dir = path.join(app.getPath('userData'), 'whisper');
  for (const n of ['whisper-cli', 'whisper', 'main']) cands.push(path.join(dir, n + exe));
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* try the next one */ }
  }
  // Last resort: something already on PATH. spawn() resolves it, so hand back the name.
  for (const n of ['whisper-cli', 'whisper']) {
    const found = (process.env.PATH || '').split(path.delimiter).some((d) => {
      try { return fs.statSync(path.join(d, n + exe)).isFile(); } catch (e) { return false; }
    });
    if (found) return n + exe;
  }
  return null;
}

const transcriptDir = () => {
  const dir = path.join(app.getPath('userData'), 'cache', 'transcript');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/**
 * Cache path for a transcript. Keyed by path and MODEL, because a bigger model produces
 * different words for the same audio; size and mtime are checked inside the file, the
 * same rule the waveform and silence caches follow, so a re-encoded file under the same
 * name is transcribed again rather than served stale.
 */
const transcriptFile = (p, model) =>
  path.join(transcriptDir(),
    crypto.createHash('sha1').update(String(p) + '|' + model).digest('hex') + '.json');

function readTranscriptCache(p, model) {
  const stamp = fileStamp(p);
  if (!stamp) return null;
  try {
    const j = JSON.parse(fs.readFileSync(transcriptFile(p, model), 'utf8'));
    if (j.size !== stamp.size || j.mtime !== stamp.mtime || j.model !== model) return null;
    return j;
  } catch (e) { return null; }
}

function writeTranscriptCache(p, model, words, language) {
  const stamp = fileStamp(p);
  if (!stamp) return;
  try {
    fs.writeFileSync(transcriptFile(p, model), JSON.stringify({
      size: stamp.size, mtime: stamp.mtime, model, language: language || '', words,
    }), 'utf8');
  } catch (e) { /* an unwritable cache must never fail the transcription */ }
}

const sendTrProgress = (d) => {
  try { if (win && !win.isDestroyed()) win.webContents.send('transcribe:progress', d); } catch (e) {}
};

let modelDownload = null;     // the in-flight request, so Cancel can abort it
let activeTranscribe = null;  // the running whisper.cpp process

/** Fetch a ggml model, following HuggingFace's redirect, reporting bytes as they land. */
function downloadModel(name) {
  const https = require('https');
  const dest = modelFile(name);
  const tmp = dest + '.part';
  const expected = (WHISPER_MODELS[name] || {}).size || 0;

  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; modelDownload = null; resolve(r); } };
    const get = (url, depth) => {
      if (depth > 5) return finish({ ok: false, error: 'Too many redirects fetching the model.' });
      const req = https.get(url, { headers: { 'User-Agent': 'ShortCut' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, url).toString(), depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish({ ok: false, error: 'Model download failed (HTTP ' + res.statusCode + ').' });
        }
        const total = Number(res.headers['content-length']) || expected;
        let got = 0;
        const out = fs.createWriteStream(tmp);
        res.on('data', (c) => {
          got += c.length;
          sendTrProgress({ phase: 'download', model: name, got, total });
        });
        res.pipe(out);
        out.on('error', () => finish({ ok: false, error: 'Could not write the model file.' }));
        out.on('finish', () => out.close(() => {
          // A dropped connection ends the stream cleanly and SHORT. Renaming that into
          // place gives you a model file that looks present and then fails to load with
          // "not all tensors loaded" every time, forever - the download never retries
          // because the file is there. So the byte count is checked before the rename,
          // and a short file is thrown away rather than kept.
          if (total && got < total) {
            try { fs.unlinkSync(tmp); } catch (e2) {}
            return finish({
              ok: false,
              error: 'The model download ended early (' + Math.round(got / 1e6) + ' of ' +
                     Math.round(total / 1e6) + ' MB). Try again.',
            });
          }
          try { fs.renameSync(tmp, dest); } catch (e) {
            return finish({ ok: false, error: 'Could not save the model.' });
          }
          finish({ ok: true, path: dest });
        }));
      });
      modelDownload = req;
      req.on('error', (e) => {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        finish({ ok: false, error: 'Offline, or the model host is unreachable (' + e.code + ').' });
      });
    };
    get(MODEL_HOST + 'ggml-' + name + '.bin', 0);
  });
}

/** Decode any source to the 16 kHz mono WAV whisper.cpp wants. */
function extractWav(src, dest) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      '-y', '-hide_banner', '-nostats', '-i', src,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', dest,
    ], { windowsHide: true });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

ipcMain.handle('transcribe:state', () => {
  const bin = whisperBin();
  const models = Object.keys(WHISPER_MODELS).filter((m) => {
    try { return fs.statSync(modelFile(m)).size > 1000000; } catch (e) { return false; }
  });
  return {
    bin, models, all: Object.keys(WHISPER_MODELS), defaultModel: DEFAULT_MODEL,
    dir: modelsDir(), whisperDir: path.join(app.getPath('userData'), 'whisper'),
  };
});

ipcMain.handle('transcribe:cancel', () => {
  if (modelDownload) { try { modelDownload.destroy(); } catch (e) {} }
  if (activeTranscribe) { try { activeTranscribe.kill(); } catch (e) {} }
  return true;
});

/**
 * Transcribe one file. Answers `{ ok, cached, words, language }`, or `{ ok: false,
 * error, reason }` - it never throws, and never leaves the caller guessing which half is
 * missing: `reason` is 'missing', 'no-binary', 'no-model', 'no-audio' or 'failed'.
 */
ipcMain.handle('transcribe:run', async (_e, { path: p, model, language, force }) => {
  const name = WHISPER_MODELS[model] ? model : DEFAULT_MODEL;
  const stamp = fileStamp(p);
  if (!stamp) return { ok: false, error: 'File not found.', reason: 'missing' };

  if (!force) {
    const hit = readTranscriptCache(p, name);
    if (hit) return { ok: true, cached: true, model: name, words: hit.words, language: hit.language };
  }

  const bin = whisperBin();
  if (!bin) {
    return {
      ok: false, reason: 'no-binary',
      error: 'whisper.cpp was not found. Put whisper-cli.exe in ' +
             path.join(app.getPath('userData'), 'whisper') + ', or set SHORTCUT_WHISPER.',
    };
  }

  const mf = modelFile(name);
  let have = false;
  try { have = fs.statSync(mf).size > 1000000; } catch (e) { have = false; }
  if (!have) {
    sendTrProgress({ phase: 'download', model: name, got: 0, total: (WHISPER_MODELS[name] || {}).size || 0 });
    const d = await downloadModel(name);
    if (!d.ok) return { ok: false, reason: 'no-model', error: d.error };
  }

  const meta = await probe(p);
  if (meta && !meta.hasAudio) return { ok: false, reason: 'no-audio', error: 'That file has no audio track.' };

  const scratch = fs.mkdtempSync(path.join(app.getPath('temp'), 'scut-stt-'));
  const wav = path.join(scratch, 'a.wav');
  try {
    sendTrProgress({ phase: 'extract', model: name });
    if (!await extractWav(p, wav)) {
      return { ok: false, reason: 'failed', error: 'ffmpeg could not extract the audio.' };
    }

    sendTrProgress({ phase: 'transcribe', model: name, duration: meta ? meta.duration : 0 });
    const outBase = path.join(scratch, 'out');
    // Three flags here are load-bearing and none of them is obvious:
    //
    //  -oj   `-ojf` only says "put MORE in the JSON file" - it does not ask for one.
    //        Without `-oj` alongside it whisper.cpp writes no JSON at all, and the run
    //        ends in "wrote no JSON", which reads like a parse failure and is not one.
    //  --dtw word-level timestamps are not a by-product of decoding: whisper derives them
    //        by aligning cross-attention with dynamic time warping, and ONLY when asked.
    //        Without this every token carries its segment's bounds instead, which looks
    //        like timing and is not - one caption held for the whole line.
    //  -nfa  flash attention is ON by default in these builds and silently turns DTW back
    //        off again: "dtw_token_timestamps is not supported with flash_attn -
    //        disabling", on stderr, followed by a perfectly normal-looking transcript.
    //        Disabling it costs some speed and buys the entire feature.
    const args = ['-m', mf, '-f', wav, '-oj', '-ojf', '--output-file', outBase, '-nt', '-pp'];
    const dtw = (WHISPER_MODELS[name] || {}).dtw;
    if (dtw) args.push('-nfa', '--dtw', dtw);
    if (language) args.push('-l', language);

    let whisperLog = '';
    const code = await new Promise((resolve) => {
      const proc = spawn(bin, args, { windowsHide: true });
      activeTranscribe = proc;
      // whisper.cpp prints progress with -pp. Scraping it is the same trick the render
      // bar uses on ffmpeg's `time=` - except that whisper writes several ticks into one
      // line without a newline between them, so the line really does read
      // `progress = 1060%` when it has passed 10 and then 60. A value outside 0-100 is
      // therefore two readings stuck together and cannot be untangled: show no number at
      // all rather than a made-up one.
      const onData = (d) => {
        const s = d.toString();
        whisperLog += s;
        if (whisperLog.length > 200000) whisperLog = whisperLog.slice(-100000);
        const m = /progress\s*=\s*(\d+)%/.exec(s);
        if (!m) return;
        const pct = Number(m[1]);
        sendTrProgress({
          phase: 'transcribe', model: name,
          percent: pct >= 0 && pct <= 100 ? pct : null,
        });
      };
      proc.stderr.on('data', onData);
      proc.stdout.on('data', onData);
      proc.on('error', () => resolve(-1));
      proc.on('close', (c) => resolve(c));
    });
    activeTranscribe = null;
    if (code !== 0) {
      // A half-downloaded model loads as far as "not all tensors" and then exits. Saying
      // so, and naming the file to delete, beats "exited with 1".
      const badModel = /not all tensors loaded|failed to load model/i.test(whisperLog);
      return {
        ok: false,
        reason: code === -1 ? 'no-binary' : badModel ? 'no-model' : 'failed',
        error: code === -1 ? 'whisper.cpp could not be started.'
          : badModel ? 'The ' + name + ' model is incomplete. Delete ' + mf + ' and transcribe again.'
          : 'whisper.cpp exited with ' + code + '.',
      };
    }

    let doc = null;
    for (const cand of [outBase + '.json', outBase + '.wav.json', wav + '.json']) {
      try { doc = JSON.parse(fs.readFileSync(cand, 'utf8')); break; } catch (e) { /* next candidate */ }
    }
    if (!doc) return { ok: false, reason: 'failed', error: 'whisper.cpp wrote no JSON.' };

    // The probed duration clips whisper's 30 s padding off the tail - see parseWhisper.
    const words = Captions.parseWhisper(doc, meta ? meta.duration : 0);
    const lang = (doc.result && doc.result.language) || language || '';
    if (words.length) writeTranscriptCache(p, name, words, lang);
    sendTrProgress({ phase: 'done', model: name, words: words.length });
    return { ok: true, cached: false, model: name, words, language: lang };
  } finally {
    activeTranscribe = null;
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
  }
});

/** Open a transcript the user already has: whisper JSON, a word array, SRT or VTT. */
ipcMain.handle('transcribe:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import a transcript',
    filters: [{ name: 'Transcripts', extensions: ['json', 'srt', 'vtt', 'txt'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  try {
    const words = Captions.parseTranscript(fs.readFileSync(r.filePaths[0], 'utf8'));
    return { ok: true, filePath: r.filePaths[0], words };
  } catch (e) {
    return { ok: false, error: 'Could not read that transcript: ' + e.message };
  }
});

// ------------------------------------------------------------------ projects

ipcMain.handle('project:save', async (_e, payload) => {
  let target = payload.filePath;
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save project',
      defaultPath: 'project.scut',
      filters: [{ name: 'ShortCut Project', extensions: ['scut'] }],
    });
    if (r.canceled) return { canceled: true };
    target = r.filePath;
  }
  fs.writeFileSync(target, JSON.stringify(payload.data, null, 2), 'utf8');
  return { canceled: false, filePath: target };
});

ipcMain.handle('project:open', async (_e, filePath) => {
  let target = filePath;
  if (!target) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'ShortCut Project', extensions: ['scut'] }],
    });
    if (r.canceled) return { canceled: true };
    target = r.filePaths[0];
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    return { canceled: false, error: 'Could not read project: ' + e.message };
  }
  const missing = [];
  for (const t of data.tracks || []) {
    for (const c of t.clips || []) if (!fs.existsSync(c.src)) missing.push(c.src);
  }
  return { canceled: false, filePath: target, data, missing };
});

// --------------------------------------------------------------- fonts

let fontCache = null;

/**
 * Family names of every font installed on this machine.
 *
 * InstalledFontCollection gives real family names ("Segoe UI"), which is what canvas
 * needs; the registry fallback only has display names ("Segoe UI Bold (TrueType)") and
 * has to be de-suffixed, so it is second choice.
 */
function listFonts() {
  if (fontCache) return Promise.resolve(fontCache);
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Drawing; ' +
      '[System.Drawing.Text.InstalledFontCollection]::new().Families | ForEach-Object { $_.Name }',
    ], { maxBuffer: 1024 * 1024 * 4, windowsHide: true }, (err, stdout) => {
      let names = [];
      if (!err && stdout) {
        names = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
      if (!names.length) {
        try {
          const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
          const out = require('child_process').execSync('reg query "' + key + '"', { encoding: 'utf8' });
          const styles = /\s+(Bold|Italic|Light|Semilight|Semibold|Black|Thin|Medium|Regular|Oblique|Condensed|Extrabold|Ultralight)+$/i;
          const seen = new Set();
          for (const line of out.split(/\r?\n/)) {
            const m = /^\s{4}(.+?)\s{4}REG_SZ/.exec(line);
            if (!m) continue;
            let n = m[1].replace(/\s*\((TrueType|OpenType|VGA res)\)\s*$/i, '').split('&')[0].trim();
            while (styles.test(n)) n = n.replace(styles, '').trim();
            if (n && !seen.has(n)) { seen.add(n); names.push(n); }
          }
        } catch (e) { /* fall through to the built-in list */ }
      }
      if (!names.length) {
        names = ['Segoe UI', 'Arial', 'Calibri', 'Times New Roman', 'Georgia', 'Verdana',
          'Tahoma', 'Impact', 'Comic Sans MS', 'Courier New', 'Consolas', 'Trebuchet MS'];
      }
      names = [...new Set(names)].sort((a, b) => a.localeCompare(b));
      fontCache = names;
      resolve(names);
    });
  });
}

ipcMain.handle('fonts:list', () => listFonts());

// -------------------------------------------------------------- presets

const PRESET_KINDS = ['style', 'anim', 'full', 'trans', 'audiofx'];
const presetDir = (kind) => {
  const k = PRESET_KINDS.includes(kind) ? kind : 'full';
  const dir = path.join(app.getPath('userData'), 'presets', k);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const presetFile = (kind, name) =>
  path.join(presetDir(kind), String(name).replace(/[^\w\- ()\[\]]/g, '_') + '.json');

ipcMain.handle('preset:list', () => {
  const out = {};
  for (const k of PRESET_KINDS) {
    try {
      out[k] = fs.readdirSync(presetDir(k))
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .map((f) => f.replace(/\.json$/i, ''))
        .sort();
    } catch (e) { out[k] = []; }
  }
  return out;
});

ipcMain.handle('preset:save', (_e, { kind, name, data }) => {
  fs.writeFileSync(presetFile(kind, name), JSON.stringify(data, null, 2), 'utf8');
  return true;
});

ipcMain.handle('preset:load', (_e, { kind, name }) => {
  try { return JSON.parse(fs.readFileSync(presetFile(kind, name), 'utf8')); } catch (e) { return null; }
});

ipcMain.handle('preset:delete', (_e, { kind, name }) => {
  try { fs.unlinkSync(presetFile(kind, name)); return true; } catch (e) { return false; }
});

ipcMain.handle('preset:export', async (_e, { kind, data }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export ' + kind + ' preset',
    defaultPath: (data && data.name ? data.name : kind) + '.shortcut-' + kind + '.json',
    filters: [{ name: 'ShortCut preset', extensions: ['json'] }],
  });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
  return r.filePath;
});

ipcMain.handle('preset:import', async (_e, kind) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import ' + kind + ' preset',
    properties: ['openFile'],
    filters: [{ name: 'ShortCut preset', extensions: ['json'] }],
  });
  if (r.canceled) return null;
  try { return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch (e) { return null; }
});

// ------------------------------------------------- baked text frame sequences

/**
 * Text cards are drawn on canvas in the renderer and handed here as PNG frames, which
 * ffmpeg then overlays as an image sequence. That keeps one drawing implementation for
 * both preview and export - see src/renderer/text/draw.js.
 */
/**
 * Baked frames are cached by a hash of everything that affects the pixels (the card, the
 * output size, the fps and the clip length). Re-rendering an unchanged card reuses the
 * PNGs instead of redrawing them, which is the slow half of exporting a text-heavy edit.
 */
const textCacheRoot = () => {
  const dir = path.join(app.getPath('userData'), 'cache', 'text');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Trim the cache to a budget, oldest entries first. */
function pruneTextCache(budgetBytes) {
  const root = textCacheRoot();
  let entries = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) continue;
      let size = 0;
      for (const f of fs.readdirSync(dir)) {
        try { size += fs.statSync(path.join(dir, f)).size; } catch (e) { /* racing */ }
      }
      entries.push({ dir, size, used: st.mtimeMs });
    } catch (e) { /* unreadable */ }
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (total <= budgetBytes) break;
    try { fs.rmSync(e.dir, { recursive: true, force: true }); total -= e.size; } catch (err) { /* in use */ }
  }
  return total;
}

/**
 * A scratch directory for one baked sequence.
 *
 * Frames are written as a single raw RGBA stream rather than one PNG each. PNG encoding a
 * large text frame costs 100-1500 ms depending on how much alpha detail it has, which made
 * baking dwarf everything else - a four second title card could take ten minutes. Dumping
 * the bytes straight out of the canvas costs about 4 ms a frame, so baking is now cheap
 * enough that these do not need caching: they are temporary and deleted after the render.
 * The finished MP4 is what gets cached (see the render cache).
 */
ipcMain.handle('text:seq', () => ({
  dir: fs.mkdtempSync(path.join(app.getPath('temp'), 'shortcut-text-')),
  cached: false,
}));

ipcMain.handle('text:seqDone', () => true);

/**
 * Finished renders are cached too.
 *
 * The frame cache only removes the drawing half of an export - ffmpeg still re-encodes
 * the whole timeline, which is the bigger cost on a text-light edit. Keying the finished
 * file by the whole job means pressing Render again after changing nothing (or after only
 * changing where the file goes) is a file copy instead of an encode.
 */
const renderCacheRoot = () => {
  const dir = path.join(app.getPath('userData'), 'cache', 'render');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Everything that decides the output pixels - deliberately NOT the destination path.
 *
 * The renderer computes the same key (`jobCacheKey` in app.js) so the timeline can ask
 * "is this span still cached?" without starting a render; when it sends one along we use
 * it, so the two implementations can never drift apart.
 */
function jobKey(job) {
  if (job.cacheKey) return String(job.cacheKey).replace(/[^\w-]/g, '');

  // Without a key from the renderer we can only hash what is in the job - and for a job
  // with text that is not enough. Baking replaces each card with a scratch directory
  // whose name is random, so the hash would differ on every render (never a hit) while
  // stripping it out would let two different cards collide (a wrong hit). Refuse instead:
  // callers that want caching send `cacheKey`, computed before baking.
  if ((job.clips || []).some((c) => c.kind === 'text')) return null;

  const copy = Object.assign({}, job);
  delete copy.outPath;
  delete copy.cacheKey;
  delete copy.useCache;
  delete copy.preview;
  return crypto.createHash('sha1').update(JSON.stringify(copy)).digest('hex').slice(0, 24);
}

/**
 * What each cached render covers, so the timeline can draw its cached spans.
 * Entries are (key, from, to); the renderer decides whether a key is still valid by
 * rebuilding that span's job and comparing hashes.
 */
const renderIndexFile = () => path.join(renderCacheRoot(), 'index.json');

function readRenderIndex() {
  try { return JSON.parse(fs.readFileSync(renderIndexFile(), 'utf8')); } catch (e) { return []; }
}

function writeRenderIndex(list) {
  try { fs.writeFileSync(renderIndexFile(), JSON.stringify(list), 'utf8'); } catch (e) { /* best effort */ }
}

function noteRender(key, from, to, kind) {
  const list = readRenderIndex().filter((e) => e.key !== key);
  list.push({ key, from, to, kind: kind || 'export', at: Date.now() });
  writeRenderIndex(list.slice(-200));
}

ipcMain.handle('render:cacheIndex', () => {
  // Drop entries whose file has been pruned or cleared away, and hand back the file so
  // the viewer can play a rendered span instead of compositing it live.
  const list = [];
  for (const e of readRenderIndex()) {
    const file = path.join(renderCacheRoot(), e.key + '.mp4');
    try { if (fs.existsSync(file)) list.push(Object.assign({}, e, { file })); } catch (err) { /* skip */ }
  }
  writeRenderIndex(list.map((e) => ({ key: e.key, from: e.from, to: e.to, kind: e.kind, at: e.at })));
  return list;
});

function pruneRenderCache(budgetBytes) {
  const root = renderCacheRoot();
  const files = [];
  for (const name of fs.readdirSync(root)) {
    try {
      const f = path.join(root, name);
      const st = fs.statSync(f);
      if (st.isFile()) files.push({ f, size: st.size, used: st.mtimeMs });
    } catch (e) { /* unreadable */ }
  }
  let total = files.reduce((n, e) => n + e.size, 0);
  files.sort((a, b) => a.used - b.used);
  for (const e of files) {
    if (total <= budgetBytes) break;
    try { fs.unlinkSync(e.f); total -= e.size; } catch (err) { /* in use */ }
  }
}

function dirSize(dir) {
  let size = 0, entries = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { size, entries }; }
  for (const name of names) {
    const p2 = path.join(dir, name);
    try {
      const st = fs.statSync(p2);
      if (st.isDirectory()) {
        entries++;
        for (const f of fs.readdirSync(p2)) {
          try { size += fs.statSync(path.join(p2, f)).size; } catch (e) { /* racing */ }
        }
      } else { entries++; size += st.size; }
    } catch (e) { /* unreadable */ }
  }
  return { size, entries };
}

ipcMain.handle('text:cacheInfo', () => {
  const t = dirSize(textCacheRoot());
  const r = dirSize(renderCacheRoot());
  return {
    entries: t.entries + r.entries,
    size: t.size + r.size,
    frames: t,
    renders: r,
    root: path.join(app.getPath('userData'), 'cache'),
  };
});

ipcMain.handle('text:cacheClear', () => {
  for (const root of [textCacheRoot(), renderCacheRoot()]) {
    for (const name of fs.readdirSync(root)) {
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch (e) { /* in use */ }
    }
  }
  writeRenderIndex([]);
  return true;
});

/** Append a batch of raw RGBA frames to the sequence's single stream file. */
ipcMain.handle('text:writeFrames', (_e, { dir, data }) => {
  fs.appendFileSync(path.join(dir, 'frames.raw'), Buffer.from(data));
  return true;
});

ipcMain.handle('text:endSeq', (_e, dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  return true;
});



// -------------------------------------------------------------------- render

// Microsecond precision: rounding to milliseconds was enough to open sub-frame gaps
// between clips whose durations are not round numbers.
const r3 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Build the ffmpeg argument list for a render job.
 *
 * Video: a black base of the full duration; each clip is trimmed, PTS-shifted to its
 * timeline position, cropped/panned to the output aspect, then overlaid with `enable`.
 * Clips arrive already sorted bottom track -> top track, so later overlays win.
 *
 * Audio: each audible clip is trimmed, run through its own effect chain (`clip.afx`),
 * levelled, delayed to its position, optionally sidechained to a voice track, then amixed
 * and - if the project asks for it - loudness-normalised. See buildAudioGraph() below.
 *
 * `opts.measureLoudness` builds the audio-only pass-one variant instead; it returns null
 * when there is nothing to measure.
 */
function buildArgs(job, opts) {
  // The loudness measurement pass decodes audio only and throws the picture away - see
  // measureLoudness(). Everything below that would build a video filter is skipped, so
  // pass one costs an audio decode rather than a full composite.
  const measure = !!(opts && opts.measureLoudness);
  const { width, height, fps, quality, outPath, clips, duration } = job;
  // Visual clips carry z-order: they arrive bottom track first, so later overlays win.
  // Text cards sit in the same chain as video, so a card on V2 lands above a clip on V1.
  const vClips = measure ? [] : clips.filter((c) => c.visible);
  const aClips = clips.filter((c) => c.audible);
  const args = ['-y', '-hide_banner'];

  // One ffmpeg input per clip occurrence - simple, and lets one file appear many times.
  const inputs = [];
  for (const c of clips) {
    if (measure ? c.audible : (c.visible || c.audible)) inputs.push(c);
  }
  for (const c of inputs) {
    if (c.kind === 'text' || c.kind === 'trans') {
      // A raw RGBA stream straight from the canvas - see text:seq for why not PNG.
      // Transitions bake the same way text does; the only difference is that a
      // transition's layer is opaque and covers the full frame.
      args.push('-f', 'rawvideo', '-pixel_format', 'rgba',
        '-video_size', c.bw + 'x' + c.bh,
        '-framerate', String(fps),
        '-i', path.join(c.seqDir, 'frames.raw'));
    } else {
      args.push('-i', c.src);
    }
  }

  const fc = [];

  /**
   * The audio graph, from the clips up to `[aout]`.
   *
   * Shared by the real render and the loudness measurement pass so pass one measures
   * exactly the mix pass two normalises - a measurement of anything else is worse than
   * no measurement at all.
   *
   * Order inside a clip is: trim -> position -> format -> the clip's own effect chain ->
   * clip volume -> delay. A clip with an empty `afx` contributes nothing to that string,
   * which is what keeps the argument list byte-identical to the pre-effects one.
   *
   * Returns false when there is nothing audible.
   */
  function buildAudioGraph(printLoudness) {
    if (!aClips.length) return false;

    // Every clip's current output label. Ducking and sidechain splits rewrite entries
    // here rather than renumbering anything, so the final amix just reads them off.
    const names = [];
    aClips.forEach((c, i) => {
      const idx = inputs.indexOf(c);
      const dur = c.out - c.in;
      const delay = Math.max(0, Math.round(c.start * 1000));
      const parts = [
        'atrim=start=' + r3(c.in) + ':duration=' + r3(dur),
        'asetpts=PTS-STARTPTS',
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      ]
        .concat(AudioFX.chain(c.afx))
        .concat([
          'volume=' + r3(c.volume),
          'adelay=' + delay + '|' + delay,
        ]);
      fc.push('[' + idx + ':a]' + parts.join(',') + '[a' + i + ']');
      names.push('a' + i);
    });

    // ---- ducking -------------------------------------------------------
    // A ducked clip is compressed by the level of a whole VOICE TRACK, so the voice has
    // to reach two places at once: the mix, and the sidechain input. An ffmpeg filter
    // output pad may only be consumed once, so each contributing voice stream is split
    // explicitly - and the bus itself is split again when several clips duck to it.
    const users = new Map();          // voice track id -> [index into aClips]
    aClips.forEach((c, i) => {
      const d = AudioFX.duckOf(c);
      // A clip cannot duck to the track it lives on. Without this the effect would
      // quietly pick up the clip's own TRACK-MATES as the sidechain source, which is
      // not what anyone means by "duck under the voice" - it is just a clip being
      // compressed by whatever happens to sit next to it. The inspector leaves the
      // clip's own track out of the list for the same reason.
      if (!d || d.params.voiceTrack === c.trackId) return;
      const list = users.get(d.params.voiceTrack) || [];
      list.push(i);
      users.set(d.params.voiceTrack, list);
    });

    let busN = 0;
    for (const [trackId, consumers] of users) {
      // A clip never ducks to its own signal, and a track with nothing audible on it
      // cannot be a sidechain source - in both cases the duck is simply dropped.
      const feed = [];
      aClips.forEach((c, i) => {
        if (c.trackId !== trackId || consumers.indexOf(i) !== -1) return;
        fc.push('[' + names[i] + ']asplit=2[' + names[i] + 'm][' + names[i] + 's]');
        feed.push(names[i] + 's');
        names[i] = names[i] + 'm';
      });
      if (!feed.length) continue;

      const bus = 'duckbus' + (busN++);
      if (feed.length === 1) fc.push('[' + feed[0] + ']anull[' + bus + ']');
      else {
        fc.push(feed.map((n) => '[' + n + ']').join('') +
          'amix=inputs=' + feed.length + ':normalize=0:dropout_transition=0[' + bus + ']');
      }

      const taps = consumers.map((_, k) => bus + 'x' + k);
      if (taps.length === 1) fc.push('[' + bus + ']anull[' + taps[0] + ']');
      else fc.push('[' + bus + ']asplit=' + taps.length + taps.map((n) => '[' + n + ']').join(''));

      consumers.forEach((i, k) => {
        const d = AudioFX.duckOf(aClips[i]);
        fc.push('[' + names[i] + '][' + taps[k] + ']' + AudioFX.duckFilter(d.params) + '[' + names[i] + 'd]');
        names[i] = names[i] + 'd';
      });
    }

    // ---- the mix -------------------------------------------------------
    const ins = names.map((n) => '[' + n + ']').join('');
    let mix = ins + 'amix=inputs=' + aClips.length + ':normalize=0:dropout_transition=0' +
      ',atrim=duration=' + r3(duration);

    const loud = job.loudness;
    if (printLoudness) {
      // Pass one: measure the finished mix and throw the samples away.
      fc.push(mix + ',' + AudioFX.loudnormFilter(loud, null, true) + '[aout]');
      return true;
    }
    if (loud && loud.enabled) {
      // loudnorm runs its own resampler internally; put the rate back before the encoder
      // so the output stays the 48 kHz the rest of the graph assumes.
      mix += ',' + AudioFX.loudnormFilter(loud, loud.measured, false) + ',aresample=48000';
    }
    fc.push(mix + ',alimiter=limit=0.98[aout]');
    return true;
  }

  if (measure) {
    if (!buildAudioGraph(true)) return null;
    args.push('-filter_complex', fc.join(';'));
    args.push('-map', '[aout]', '-f', 'null', '-');
    return args;
  }

  fc.push('color=c=black:s=' + width + 'x' + height + ':r=' + fps + ':d=' + r3(duration) + '[base0]');

  let last = 'base0';
  vClips.forEach((c, i) => {
    const idx = inputs.indexOf(c);
    const dur = c.out - c.in;

    if (c.kind === 'text') {
      fc.push('[' + idx + ':v]setpts=PTS-STARTPTS+' + r3(c.start) + '/TB,format=rgba[v' + i + ']');
      // eof_action=pass, not repeat: once a card's frames run out the base must show
      // through untouched, otherwise the last text frame would stick on screen.
      fc.push(
        '[' + last + '][v' + i + ']overlay=' + Math.round(c.bx) + ':' + Math.round(c.by) +
        ':eof_action=pass:enable=' +
        "'between(t," + r3(c.start) + ',' + r3(c.start + dur) + ")'[base" + (i + 1) + ']'
      );
      last = 'base' + (i + 1);
      return;
    }

    const zoom = c.zoom || 1;
    // Largest source region matching the target aspect, divided by zoom, then panned.
    const cw = 'min(iw,ih*' + width + '/' + height + ')/' + r3(zoom);
    const ch = 'min(ih,iw*' + height + '/' + width + ')/' + r3(zoom);
    const scaleFlags = quality === 'draft' ? 'fast_bilinear' : 'bicubic';
    fc.push(
      '[' + idx + ':v]trim=start=' + r3(c.in) + ':duration=' + r3(dur) +
      ',setpts=PTS-STARTPTS+' + r3(c.start) + '/TB' +
      ",crop=w='" + cw + "':h='" + ch + "':x='(iw-ow)*" + r3(c.panX) + "':y='(ih-oh)*" + r3(c.panY) + "'" +
      ',scale=' + width + ':' + height + ':flags=' + scaleFlags + ',setsar=1,fps=' + fps + '[v' + i + ']'
    );
    // eof_action=repeat holds the clip's last frame instead of punching through to the
    // black base. Container duration often outruns the video stream (audio is longer, or
    // the last frame is short), and `pass` turned that overrun into black frames at every
    // cut. `enable` still switches the overlay off cleanly outside the clip's window.
    fc.push(
      '[' + last + '][v' + i + ']overlay=0:0:eof_action=repeat:enable=' +
      "'between(t," + r3(c.start) + ',' + r3(c.start + dur) + ")'[base" + (i + 1) + ']'
    );
    last = 'base' + (i + 1);
  });
  fc.push('[' + last + ']trim=duration=' + r3(duration) + ',format=yuv420p[vout]');

  // buildAudioGraph() appends the whole mix to `fc`, ending at [aout]. Nothing audible
  // means no graph at all, and the file gets a silent track so it still has audio.
  if (!buildAudioGraph(false)) {
    args.push('-f', 'lavfi', '-t', String(r3(duration)), '-i', 'anullsrc=r=48000:cl=stereo');
  }

  args.push('-filter_complex', fc.join(';'));
  args.push('-map', '[vout]');
  args.push('-map', aClips.length ? '[aout]' : inputs.length + ':a');

  const presets = {
    high: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18'],
    medium: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22'],
    fast: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'],
    draft: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-tune', 'zerolatency'],
  };
  args.push(...(presets[quality] || presets.medium));
  args.push('-pix_fmt', 'yuv420p', '-r', String(fps));
  args.push('-c:a', 'aac', '-b:a', quality === 'draft' ? '96k' : '192k', '-ar', '48000');
  args.push('-movflags', '+faststart', '-t', String(r3(duration)), outPath);
  return args;
}

/**
 * Loudness pass one: decode the mix, read what loudnorm measured, hand it back.
 *
 * Single-pass loudnorm works, but it is a dynamic estimator - it moves the gain as it
 * goes and can pump on a mix whose level changes. Feeding pass two the real measurements
 * turns it into one exact gain move, which is what "normalised to -14 LUFS" is supposed
 * to mean. The cost is an extra audio-only decode, so a draft render skips it.
 *
 * Failure here is never fatal: no measurements simply means the render falls back to the
 * single pass. It must not cost the export.
 */
function measureLoudness(job) {
  let args;
  try { args = buildArgs(job, { measureLoudness: true }); } catch (e) { return Promise.resolve(null); }
  if (!args) return Promise.resolve(null);

  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    activeRender = p;                       // so Cancel can stop pass one too
    let log = '';
    p.stderr.on('data', (d) => {
      log += d.toString();
      if (log.length > 200000) log = log.slice(-100000);
    });
    p.on('error', () => { activeRender = null; resolve(null); });
    p.on('close', () => {
      const wasCancelled = activeRender === null;
      activeRender = null;
      if (wasCancelled) return resolve({ cancelled: true });
      // loudnorm prints its JSON block last, after all the usual ffmpeg noise.
      const open = log.lastIndexOf('{');
      const close = log.lastIndexOf('}');
      if (open === -1 || close < open) return resolve(null);
      try {
        const m = JSON.parse(log.slice(open, close + 1));
        const nums = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
        for (const k of nums) if (!isFinite(parseFloat(m[k]))) return resolve(null);
        resolve({
          input_i: parseFloat(m.input_i), input_tp: parseFloat(m.input_tp),
          input_lra: parseFloat(m.input_lra), input_thresh: parseFloat(m.input_thresh),
          target_offset: parseFloat(m.target_offset),
        });
      } catch (e) { resolve(null); }
    });
  });
}

ipcMain.handle('render:pickOutput', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Render to',
    defaultPath: defaultName || 'output.mp4',
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('render:start', async (_e, job) => {
  if (activeRender) return { ok: false, error: 'A render is already running.' };

  const key = jobKey(job);
  const cacheFile = key ? path.join(renderCacheRoot(), key + '.mp4') : null;

  // A preview render has no destination of its own: it IS the cache entry. That is what
  // keeps reviewing from littering the user's folder with export byproducts.
  if (job.preview) {
    if (!cacheFile) return { ok: false, error: 'A preview render needs a cacheKey from the renderer.' };
    job.outPath = cacheFile;
  }

  if (key && job.useCache !== false && fs.existsSync(cacheFile)) {
    try {
      if (!job.preview) fs.copyFileSync(cacheFile, job.outPath);
      const now = new Date();
      fs.utimesSync(cacheFile, now, now);   // most-recently-used, for pruning
      noteRender(key, job.rangeFrom || 0, job.rangeTo == null ? job.duration : job.rangeTo,
        job.preview ? 'preview' : 'export');
      return { ok: true, outPath: job.outPath, file: cacheFile, cached: true };
    } catch (e) {
      // A broken cache entry must never block a real render.
      try { fs.unlinkSync(cacheFile); } catch (err) { /* gone already */ }
    }
  }

  // Pass one, if the project asked for loudness normalisation. This happens AFTER the
  // cache key was taken, deliberately: the measurements are derived from the job, not
  // part of it, and putting them in the key would give the same content two keys - the
  // renderer, which computes the same key for the cache bar, has never seen them.
  if (job.loudness && job.loudness.enabled && !job.loudness.measured &&
      job.quality !== 'draft' && (job.clips || []).some((c) => c.audible)) {
    if (win) win.webContents.send('render:progress', { time: 0, total: job.duration, stage: 'Measuring loudness' });
    const measured = await measureLoudness(job);
    // Cancelling pass one cancels the render - not "carry on without measurements".
    if (measured && measured.cancelled) return { ok: false, cancelled: true, error: 'Render cancelled.' };
    if (measured) job.loudness = Object.assign({}, job.loudness, { measured });
  }

  let args;
  try {
    args = buildArgs(job);
  } catch (e) {
    return { ok: false, error: 'Could not build render command: ' + e.message };
  }
  // Dropped next to the temp dir so a failed render can be reproduced by hand.
  try {
    fs.writeFileSync(path.join(app.getPath('temp'), 'shortcut-last-ffmpeg-args.txt'), args.join('\n'), 'utf8');
  } catch (e) { /* diagnostics only */ }

  return await new Promise((resolve) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    activeRender = p;
    let log = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      log += s;
      if (log.length > 200000) log = log.slice(-100000);
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
      if (m && win) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        win.webContents.send('render:progress', { time: t, total: job.duration });
      }
    });
    p.on('error', (err) => { activeRender = null; resolve({ ok: false, error: err.message }); });
    p.on('close', (code) => {
      const wasCancelled = activeRender === null;
      activeRender = null;
      if (code === 0) {
        try {
          if (!key) throw new Error('uncacheable job');
          // A preview render wrote straight into the cache; an export needs copying in.
          if (!job.preview) fs.copyFileSync(job.outPath, cacheFile);
          noteRender(key, job.rangeFrom || 0, job.rangeTo == null ? job.duration : job.rangeTo,
            job.preview ? 'preview' : 'export');
          pruneRenderCache(3 * 1024 * 1024 * 1024);   // keep finished renders under ~3 GB
        } catch (e) { /* caching is best-effort */ }
        resolve({ ok: true, outPath: job.outPath, file: cacheFile, cached: false });
      }
      else if (wasCancelled) resolve({ ok: false, cancelled: true, error: 'Render cancelled.' });
      else resolve({ ok: false, error: log.split('\n').slice(-25).join('\n') || 'ffmpeg exited ' + code });
    });
  });
});

ipcMain.handle('render:cancel', () => {
  if (activeRender) {
    const p = activeRender;
    activeRender = null;
    p.kill();
    return true;
  }
  return false;
});

let saveThenQuit = false;

ipcMain.handle('app:setDirty', (_e, dirty) => { projectDirty = !!dirty; });

/** The renderer reports the outcome of a save it was asked to do before quitting. */
ipcMain.handle('app:saveResult', (_e, saved) => {
  if (saveThenQuit && saved) {
    saveThenQuit = false;
    allowClose = true;
    if (win) win.close();
  } else {
    saveThenQuit = false;   // save cancelled or failed: stay open
  }
});

/**
 * Test-only: inject REAL (trusted) input events.
 *
 * Synthetic MouseEvents dispatched from a script never perform the default action, so they
 * cannot focus an input or type into one - a smoke test using them cannot tell a working
 * field from a dead one. sendInputEvent goes through the same path as a physical mouse or
 * keyboard, so it can. Only available while a smoke script is driving the app.
 */
ipcMain.handle('debug:input', (_e, ev) => {
  if (!process.env.SHORTCUT_SMOKE || !win) return false;
  win.webContents.sendInputEvent(ev);
  return true;
});

/**
 * Test-only: build a render job's ffmpeg arguments without running anything.
 *
 * buildArgs() lives in main and the smoke suites run in the renderer, so without this a
 * test of the emitted filter graph would have to re-implement it - and a test that
 * re-implements what it is testing proves nothing. tools/smoke-audiofx.js uses this.
 */
ipcMain.handle('debug:buildArgs', (_e, { job, opts }) => {
  if (!process.env.SHORTCUT_SMOKE) return null;
  try { return { ok: true, args: buildArgs(job, opts) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

/** Test-only: write a file, so a smoke script can make its own fixtures. */
ipcMain.handle('debug:writeFile', (_e, { file, data }) => {
  if (!process.env.SHORTCUT_SMOKE) return false;
  fs.writeFileSync(file, Buffer.from(data));
  return true;
});

ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('app:title', (_e, t) => { if (win) win.setTitle(t); });
