'use strict';
/**
 * Magic Mask - the model half. Main process only.
 *
 * `src/renderer/magicmask.js` owns the data model, the prompts, the propagation loop and
 * the matte edge operations, and knows nothing about onnxruntime. This file owns
 * MobileSAM: downloading it, loading it, running it, and caching what it produces. The
 * two meet at one contract, the injected engine:
 *
 *   segment({ w, h, rgba, points, box, prevLow, key }) -> { alpha: Uint8Array(w*h) }
 *
 * WHY THE TWO SESSIONS ARE SEPARATE, AND WHY THAT IS THE WHOLE INTERACTION DESIGN
 *
 * SAM is an encoder and a decoder, and they cost two different orders of magnitude: the
 * encoder is ~900 ms a frame and the decoder ~90 ms. The encoder depends only on the
 * PICTURE and the decoder only on the picture's embedding plus the prompts. So the
 * embedding is computed once per frame and held, and every subsequent stroke re-runs the
 * decoder alone. That is what makes "the mask previews live as you paint" true rather
 * than aspirational, and it is why `mask:segment` takes a frame `key` - the key is what
 * says "this is the same picture you encoded a moment ago".
 *
 * EVERY FAILURE IS A VALUE, NEVER AN EXCEPTION.
 *
 * No onnxruntime, no model, no network, a corrupt download, an out-of-memory session:
 * all of them answer `{ ok: false, reason, error }` and the renderer falls back to the
 * local region-grow engine, which needs nothing. That is the degradation contract step 8
 * wrote down for telemetry, kept here for models - the feature gets worse, it does not
 * break, and the panel says which engine cut the matte.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

/**
 * The two files, their sizes and their digests.
 *
 * The SHA-256 is checked after every download and a mismatch deletes the file rather than
 * keeping it: a truncated 28 MB ONNX loads far enough to throw somewhere deep inside the
 * runtime, and "your model is corrupt, re-downloading" is a better message than a stack
 * trace from a graph optimiser. Set SHORTCUT_SAM_BASE to point at a mirror or a local
 * folder of the same two files.
 */
const BASE = process.env.SHORTCUT_SAM_BASE ||
  'https://huggingface.co/PulpCut/mobilesam-onnx/resolve/main/';

const MODELS = [
  {
    id: 'encoder',
    file: 'mobilesam.encoder.onnx',
    bytes: 28195125,
    sha: '4125037c5e24d6ea58e201b20e8d8fbbbd1135c0b881e34a8074b8c4f07e6918',
  },
  {
    id: 'decoder',
    file: 'mobilesam.decoder.onnx',
    bytes: 16514086,
    sha: 'b0735abf07c7affddf20fffc3ce750f44af387ee6a7323880e909389ed15d279',
  },
];

// MobileSAM's own preprocessing: the encoder takes RAW [H, W, 3] float pixels in 0..255
// and does the resize and the normalisation inside the graph. So prompt coordinates go in
// scaled by the SAME factor the graph resizes with - the long side to 1024 - and
// `orig_im_size` is the untouched frame size. Getting that scale wrong does not throw; it
// segments confidently around the wrong pixel, which is why it is a named constant.
const SAM_SIDE = 1024;
const LOW = 256;             // the side of `mask_input` / `low_res_masks`

let ort = null;              // the runtime, or null if it is not installed
let ortError = null;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  ortError = (e && e.message) || String(e);
}

let sessions = null;         // { enc, dec } once loaded
let loading = null;
let fetching = null;
let cancelFetch = false;

let modelsDir = null;        // set by install()
const dir = () => {
  fs.mkdirSync(modelsDir, { recursive: true });
  return modelsDir;
};
const fileFor = (m) => path.join(dir(), m.file);

function have(m) {
  try {
    const st = fs.statSync(fileFor(m));
    return st.isFile() && st.size === m.bytes;
  } catch (e) { return false; }
}

function ready() { return !!ort && MODELS.every(have); }

function state() {
  return {
    ort: !!ort,
    ortError,
    ready: ready(),
    dir: modelsDir,
    busy: !!fetching,
    loaded: !!sessions,
    models: MODELS.map((m) => ({ id: m.id, file: m.file, bytes: m.bytes, have: have(m) })),
    totalBytes: MODELS.reduce((s, m) => s + m.bytes, 0),
  };
}

// ------------------------------------------------------------------ downloading

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    // A LOCAL mirror is a directory, not a URL. Useful on a machine that is never going
    // to be allowed out, and the only way this feature is testable on one.
    if (!/^https?:/i.test(url)) {
      try { fs.copyFileSync(url, dest); return resolve(true); } catch (e) { return reject(e); }
    }
    const go = (u, depth) => {
      if (depth > 6) return reject(new Error('too many redirects'));
      const req = https.get(u, { headers: { 'user-agent': 'ShortCut' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (b) => {
          got += b.length;
          if (onProgress) onProgress(got, total);
          if (cancelFetch) { req.destroy(); out.destroy(); }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(true)));
        out.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('timed out')));
    };
    go(url, 0);
  });
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/**
 * Fetch whatever is missing. One at a time, to a `.part` file, verified, then renamed.
 *
 * The `.part` dance is what stops a half-downloaded encoder from looking like a complete
 * one after a crash or a quit: nothing is ever at the real name unless it has been
 * checksummed.
 */
async function fetchModels(send) {
  if (!ort) return { ok: false, reason: 'no-runtime', error: ortError };
  if (fetching) return fetching;
  cancelFetch = false;
  const run = (async () => {
    const total = MODELS.filter((m) => !have(m)).reduce((s, m) => s + m.bytes, 0);
    let done = 0;
    for (const m of MODELS) {
      if (have(m)) continue;
      if (cancelFetch) return { ok: false, reason: 'cancelled' };
      const dest = fileFor(m);
      const part = dest + '.part';
      try {
        await download(BASE + m.file, part, (got) => {
          if (send) send({ phase: 'download', file: m.file, got: done + got, total });
        });
        if (cancelFetch) { try { fs.unlinkSync(part); } catch (e) { /* gone anyway */ } return { ok: false, reason: 'cancelled' }; }
        const digest = sha256(part);
        if (digest !== m.sha) {
          try { fs.unlinkSync(part); } catch (e) { /* gone anyway */ }
          return { ok: false, reason: 'corrupt', error: m.file + ' did not match its checksum' };
        }
        fs.renameSync(part, dest);
        done += m.bytes;
        if (send) send({ phase: 'download', file: m.file, got: done, total });
      } catch (e) {
        try { fs.unlinkSync(part); } catch (err) { /* gone anyway */ }
        return { ok: false, reason: 'offline', error: (e && e.message) || String(e) };
      }
    }
    if (send) send({ phase: 'done', got: total, total });
    return { ok: true };
  })();
  fetching = run;
  try { return await run; } finally { fetching = null; }
}

// ------------------------------------------------------------------ the sessions

async function load() {
  if (sessions) return sessions;
  if (!ort) throw new Error('onnxruntime-node is not installed');
  if (!ready()) throw new Error('the MobileSAM model files are not downloaded');
  if (loading) return loading;
  loading = (async () => {
    const opts = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      // The encoder is the expensive half and it parallelises; leave one core for the
      // renderer, which is still painting the viewer while a propagation runs.
      intraOpNumThreads: Math.max(1, Math.min(8, (os.cpus() || []).length - 1)),
    };
    const enc = await ort.InferenceSession.create(fileFor(MODELS[0]), opts);
    const dec = await ort.InferenceSession.create(fileFor(MODELS[1]), opts);
    sessions = { enc, dec };
    return sessions;
  })();
  try { return await loading; } finally { loading = null; }
}

/**
 * The embedding cache: the last few frames, by the caller's frame key.
 *
 * Small on purpose. One embedding is 256 x 64 x 64 floats - 4 MB - and the access pattern
 * is "the frame being painted on, plus the one propagation just left", so four is
 * generous. What it buys is the whole live-painting experience: the second stroke on a
 * frame costs the decoder alone.
 */
const EMB = [];
const EMB_MAX = 4;
function embGet(key) {
  const i = EMB.findIndex((e) => e.key === key);
  if (i < 0) return null;
  const e = EMB.splice(i, 1)[0];
  EMB.push(e);
  return e.emb;
}
function embPut(key, emb) {
  EMB.push({ key, emb });
  while (EMB.length > EMB_MAX) EMB.shift();
}

/**
 * One segmentation. `rgba` is w*h*4 bytes; the answer is one w*h alpha plane.
 *
 * `prevLow` is the previous frame's matte at 256x256 in 0..1, which becomes `mask_input`
 * as LOGITS - the decoder was trained on logits, and handing it probabilities makes a
 * propagation that quietly ignores its own history. The conversion is one line and it is
 * the single most load-bearing line in the loop.
 */
async function segment(req) {
  const { w, h, points } = req;
  const s = await load();
  const key = req.key;

  let emb = key ? embGet(key) : null;
  if (!emb) {
    // [H, W, 3] float 0..255 - the graph resizes and normalises it itself.
    const img = new Float32Array(w * h * 3);
    const rgba = req.rgba;
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      const k = i << 2;
      img[j] = rgba[k]; img[j + 1] = rgba[k + 1]; img[j + 2] = rgba[k + 2];
    }
    const r = await s.enc.run({ input_image: new ort.Tensor('float32', img, [h, w, 3]) });
    emb = r.image_embeddings;
    if (key) embPut(key, emb);
  }

  const scale = SAM_SIDE / Math.max(w, h);
  const pts = points || [];
  const box = req.box;
  // A BOX IS TWO POINTS with labels 2 and 3, and the padding point with label -1 is only
  // needed when there is no box. That asymmetry is in the SAM export itself, and getting
  // it wrong costs a mask of the whole frame rather than an error.
  const coords = [];
  const labels = [];
  if (box) {
    coords.push(box.x0 * scale, box.y0 * scale, box.x1 * scale, box.y1 * scale);
    labels.push(2, 3);
  }
  for (const p of pts) { coords.push(p.x * scale, p.y * scale); labels.push(p.label === 1 ? 1 : 0); }
  if (!box) { coords.push(0, 0); labels.push(-1); }
  const n = labels.length;

  const maskIn = new Float32Array(LOW * LOW);
  let hasMask = 0;
  if (req.prevLow && req.prevLow.length === LOW * LOW) {
    hasMask = 1;
    // Probability -> logit, clamped well short of infinity. A hard 0 or 1 in the input
    // would be +/-inf and the decoder answers NaN for the whole frame.
    for (let i = 0; i < maskIn.length; i++) {
      const p = Math.min(0.999, Math.max(0.001, req.prevLow[i]));
      maskIn[i] = Math.log(p / (1 - p));
    }
  }

  const out = await s.dec.run({
    image_embeddings: emb,
    point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, n, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, n]),
    mask_input: new ort.Tensor('float32', maskIn, [1, 1, LOW, LOW]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([hasMask]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([h, w]), [2]),
  });

  // `masks` comes back at the ORIGINAL frame size as logits: positive is inside. A soft
  // ramp through zero rather than a hard threshold, so the matte has a one-pixel edge to
  // feather rather than a staircase - the feather in `magicmask.js` then widens it, and a
  // feather of zero still gives a clean edge instead of a jagged one.
  const m = out.masks.data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) {
    const v = m[i];
    alpha[i] = v <= -2 ? 0 : v >= 2 ? 255 : Math.round((v + 2) * 63.75);
  }
  const iou = out.iou_predictions && out.iou_predictions.data ? out.iou_predictions.data[0] : 1;
  return { ok: true, alpha, iou: Number(iou) || 0 };
}

// --------------------------------------------------------------- the matte cache
//
// The waveform cache's rules, one feature along: keyed by the FILE (path + size + mtime)
// and by the mask's own key, which `MagicMask.cacheKey()` builds out of the range, the
// prompts, the resolution and the engine - and out of nothing about the clip. Move the
// clip, trim it, duplicate it, put it on another track: the mattes are the same mattes
// and they come back in a file read instead of a minute of inference.
//
// Mattes are stored RUN-LENGTH ENCODED. A matte is mostly a flat 0 and a flat 255 with a
// thin ramp between, so the run lengths are enormous - a 512-side matte that costs 147 KB
// raw lands in a couple of kilobytes, and a hundred of them fit in a file small enough to
// read synchronously.

let cacheRoot = null;
const cacheDir = () => {
  fs.mkdirSync(cacheRoot, { recursive: true });
  return cacheRoot;
};
const cacheFile = (p, key) =>
  path.join(cacheDir(),
    crypto.createHash('sha1').update(String(p) + '|' + String(key)).digest('hex') + '.json');

function fileStamp(p) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch (e) { return null; }
}

/** [value, count, value, count, ...] with counts capped at 65535, as a base64 Uint16 pair. */
function rleEncode(a) {
  const runs = [];
  let v = a[0], n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === v && n < 65535) { n++; continue; }
    runs.push(v, n);
    v = a[i]; n = 1;
  }
  runs.push(v, n);
  const buf = Buffer.alloc(runs.length / 2 * 3);
  for (let i = 0, o = 0; i < runs.length; i += 2, o += 3) {
    buf[o] = runs[i];
    buf.writeUInt16LE(runs[i + 1], o + 1);
  }
  return buf.toString('base64');
}

function rleDecode(b64, len) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i + 3 <= buf.length && o < len; i += 3) {
    const v = buf[i], n = buf.readUInt16LE(i + 1);
    for (let k = 0; k < n && o < len; k++) out[o++] = v;
  }
  return out;
}

function matteRead(p, key) {
  const stamp = fileStamp(p);
  if (!stamp) return null;
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(p, key), 'utf8'));
    if (j.size !== stamp.size || j.mtime !== stamp.mtime) return null;
    if (!Array.isArray(j.frames)) return null;
    return {
      w: j.w, h: j.h,
      frames: j.frames.map((f) => ({ t: f.t, alpha: rleDecode(f.a, j.w * j.h) })),
    };
  } catch (e) { return null; }
}

function matteWrite(p, key, w, h, frames) {
  const stamp = fileStamp(p);
  if (!stamp || !Array.isArray(frames) || !frames.length) return false;
  try {
    fs.writeFileSync(cacheFile(p, key), JSON.stringify({
      size: stamp.size, mtime: stamp.mtime, w, h,
      frames: frames.map((f) => ({ t: f.t, a: rleEncode(f.alpha) })),
    }), 'utf8');
    return true;
  } catch (e) { return false; }
}

// ------------------------------------------------------------------------ wiring

/**
 * Register the handlers. `send` pushes progress at the window.
 *
 * Every handler answers a value. Nothing here may throw across the IPC boundary: a
 * rejected `invoke` surfaces in the renderer as an unhandled rejection in the middle of a
 * paint, and this feature's whole design is that a missing model is a smaller feature
 * rather than a broken app.
 */
function install(ctx) {
  const { app, ipcMain, send } = ctx;
  modelsDir = path.join(app.getPath('userData'), 'models');
  cacheRoot = path.join(app.getPath('userData'), 'cache', 'matte');

  ipcMain.handle('mask:state', () => state());

  ipcMain.handle('mask:fetch', async () => {
    try {
      const r = await fetchModels((d) => { try { send('mask:progress', d); } catch (e) { /* window gone */ } });
      return Object.assign({}, r, { state: state() });
    } catch (e) {
      return { ok: false, reason: 'failed', error: (e && e.message) || String(e), state: state() };
    }
  });

  ipcMain.handle('mask:cancelFetch', () => { cancelFetch = true; return true; });

  ipcMain.handle('mask:segment', async (_e, req) => {
    if (!ort) return { ok: false, reason: 'no-runtime', error: ortError };
    if (!ready()) return { ok: false, reason: 'no-model' };
    try {
      const r = await segment({
        w: req.w, h: req.h,
        rgba: req.rgba,
        points: req.points || [],
        box: req.box || null,
        prevLow: req.prevLow ? Float32Array.from(req.prevLow) : null,
        key: req.key,
      });
      return r;
    } catch (e) {
      // A session that failed to load once will fail again; drop it so a later attempt
      // rebuilds rather than serving the same broken handle forever.
      sessions = null;
      return { ok: false, reason: 'failed', error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('mask:read', (_e, { path: p, key }) => {
    const r = matteRead(p, key);
    if (!r) return null;
    // Uint8Array survives the structured clone; a plane per frame is what the renderer
    // wants and re-encoding it as an array of numbers would be forty times the size.
    return r;
  });

  ipcMain.handle('mask:write', (_e, { path: p, key, w, h, frames }) =>
    matteWrite(p, key, w, h, (frames || []).map((f) => ({ t: f.t, alpha: Uint8Array.from(f.alpha) }))));
}

module.exports = {
  MODELS, BASE, SAM_SIDE, LOW,
  install, state, ready, fetchModels, segment, load,
  rleEncode, rleDecode, matteRead, matteWrite,
};
