'use strict';
/**
 * ShortCut - renderer.
 *
 * Layout of this file:
 *   1. State + small helpers
 *   2. Media elements (one <video>/<audio> per clip, lazily created)
 *   3. Import
 *   4. Timeline rendering (heads, lanes, clips, ruler)
 *   5. Timeline interaction (drag, trim, playhead)
 *   6. Preview compositing + playback loop
 *   7. Editing operations (split, delete, link, tracks, undo)
 *   8. Project save/open
 *   9. Render
 *  10. Keyboard shortcuts + wiring
 */

// ============================================================ 1. state

const TRACK_H = 54;

const state = {
  filePath: null,
  dirty: false,
  /** Display order: index 0 is the topmost track. Video tracks sit above audio tracks. */
  tracks: [],
  selection: new Set(),
  playhead: 0,
  playing: false,
  pxPerSec: 60,
  snap: true,
  /** In/out marks, in seconds. Null when unset. They bound a ranged render. */
  inPoint: null,
  outPoint: null,
  /** Rendered spans still matching the project: [{ from, to, key, file }]. The ruler
   *  draws these, and the viewer plays them back instead of compositing live. */
  cacheBands: [],
  /** Whether the viewer should use those rendered spans at all. */
  usePreviewRender: true,
  /** Resolution the viewer (and its preview renders) work at, as a fraction of output. */
  previewScale: 0.5,
  /** Id of the selected transition, or null. Transitions select separately from clips. */
  selTransition: null,
  /** `loudness` is the project-level target for the final mix - see AudioFX. Off by
   *  default, so a project renders exactly as it did before the audio chain existed
   *  until somebody asks for normalisation. */
  out: { w: 1080, h: 1920, fps: 30, quality: 'medium', loudness: Object.assign({}, AudioFX.LOUD_DEFAULTS) },
  /** Tighten's settings. Not timeline state: changing them snapshots no undo entry and
   *  dirties nothing, it only changes what the next Tighten would remove. */
  tighten: { threshold: 0.35, pad: 0.05, noise: -30 },
};

let undoStack = [];
let redoStack = [];
let uid = 1;
const nextId = () => 'c' + (uid++) + '_' + Math.random().toString(36).slice(2, 6);

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTc = (t, fps) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * (fps || state.out.fps));
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return p(h) + ':' + p(m) + ':' + p(s) + '.' + p(f);
};

function log(msg) {
  const el = document.createElement('div');
  el.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  $('#log').prepend(el);
  while ($('#log').childElementCount > 200) $('#log').lastElementChild.remove();
}

const allClips = () => state.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
const findClip = (id) => allClips().find((x) => x.clip.id === id);
const clipEnd = (c) => c.start + (c.out - c.in);

function projectDuration() {
  let d = 0;
  for (const t of state.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

/**
 * Recompute which cached renders still match the project, then redraw the ruler.
 *
 * Debounced because it runs after every edit: each stored entry costs one job build plus
 * a hash, which is cheap but not free.
 */
let cacheBandTimer = null;
function refreshCacheBands(immediate) {
  clearTimeout(cacheBandTimer);
  const run = async () => {
    try {
      const index = await window.api.renderCacheIndex();
      const bands = [];
      for (const entry of index) {
        // Rebuild the job for that exact span and see whether it still hashes the same.
        if (entry.kind && entry.kind !== 'preview') continue;   // exports are not played back
        const job = buildPreviewJob({ from: entry.from, to: entry.to });
        if (jobCacheKey(job) === entry.key) {
          bands.push({ from: entry.from, to: entry.to, key: entry.key, file: entry.file });
        }
      }
      state.cacheBands = bands;
    } catch (e) {
      state.cacheBands = [];
    }
    prunePreviewEls();
    renderRuler();
    drawPreview();
  };
  if (immediate) run(); else cacheBandTimer = setTimeout(run, 250);
}

function markDirty() {
  state.dirty = true;
  const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : 'Untitled';
  window.api.setTitle('ShortCut - ' + name + ' *');
  window.api.setDirty(true);   // main needs this to decide whether to warn on close
  refreshCacheBands();
}
function markClean() {
  state.dirty = false;
  const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : 'Untitled';
  window.api.setTitle('ShortCut - ' + name);
  window.api.setDirty(false);
}

// ============================================ 2. media elements

/** clip.id -> HTMLMediaElement. Each clip gets its own so overlapping clips can coexist. */
const mediaEls = new Map();

function mediaFor(clip) {
  let el = mediaEls.get(clip.id);
  if (el) return el;
  el = document.createElement(clip.kind === 'video' ? 'video' : 'audio');
  el.src = 'file:///' + clip.src.replace(/\\/g, '/').replace(/^\/+/, '');
  el.preload = 'auto';
  if (clip.kind === 'video') el.muted = true; // audio always comes from the paired audio clip
  el.load();
  mediaEls.set(clip.id, el);
  return el;
}

function dropMedia(clipId) {
  const el = mediaEls.get(clipId);
  if (el) { try { el.pause(); } catch (e) {} el.removeAttribute('src'); el.load(); }
  mediaEls.delete(clipId);
  dropPreviewGain(clipId);
}

// ------------------------------------------------ the preview mix (WebAudio)

/**
 * A gain node per audio clip, so the preview can honour a level above 1.0.
 *
 * This is deliberately NOT a preview of the whole audio chain. The DSP - denoise, EQ,
 * de-ess, compression, ducking, loudness - happens in ffmpeg at render time, and the
 * inspector says so where the controls are. What the preview mirrors is level and mute,
 * which is what you actually need while cutting: the balance between voice and music.
 *
 * Two traps this is shaped around:
 *
 * - `el.volume` is capped at 1, so a +6 dB gain effect could not be heard at all without
 *   a gain node. With one, the element runs at 1 and the node carries the level.
 * - Routing an element through a SUSPENDED AudioContext silences it outright, and a
 *   context created before any user gesture starts suspended. So the node is only ever
 *   attached once the context is actually running; until then the element's own volume
 *   is used, clamped. That way the worst case is "a boost is quieter than it should be",
 *   never "the preview went silent".
 */
const previewMix = {
  ctx: null,
  nodes: new Map(),
  /** Every clip gain lands here, so the meter sees the mix rather than one clip. */
  master: null,
  /** The same, per rendered span - see previewBandNode(). Keyed by band key. */
  bandNodes: new Map(),
  /** The metering session (Meter.Session) and its worklet node, once it is running. */
  session: null,
  meterNode: null,
  meterState: 'off',   // off | starting | on | unavailable
};

function ensureAudioCtx() {
  if (!previewMix.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { previewMix.ctx = new Ctx(); } catch (e) { previewMix.ctx = null; }
  }
  const ctx = previewMix.ctx;
  if (!ctx) return null;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (!previewMix.master) {
    previewMix.master = ctx.createGain();
    previewMix.master.connect(ctx.destination);
    startMeter();
  }
  return ctx;
}

/**
 * Hang the loudness meter off the master bus.
 *
 * The signal splits in two here, and the split is the point: the meter's loudness input
 * is K-WEIGHTED (two IIR stages straight out of BS.1770, via Meter.kWeighting) because
 * LUFS is defined on weighted energy, while its peak input is the raw mix, because a peak
 * read off the weighted signal would be several dB out - the weighting curve is not flat.
 *
 * Everything here is best-effort. An AudioWorklet that will not load costs the meter and
 * nothing else: the mix still reaches the speakers through master -> destination, which
 * is wired up before any of this runs.
 */
function startMeter() {
  const ctx = previewMix.ctx;
  if (!ctx || previewMix.meterState !== 'off') return;
  if (typeof Meter === 'undefined' || !ctx.audioWorklet || !ctx.createIIRFilter) {
    previewMix.meterState = 'unavailable';
    return;
  }
  previewMix.meterState = 'starting';
  ctx.audioWorklet.addModule('meter-worklet.js').then(() => {
    const [s1, s2] = Meter.kWeighting(ctx.sampleRate);
    const k1 = ctx.createIIRFilter(Float64Array.from(s1.b), Float64Array.from(s1.a));
    const k2 = ctx.createIIRFilter(Float64Array.from(s2.b), Float64Array.from(s2.a));
    const node = new AudioWorkletNode(ctx, 'shortcut-meter', {
      numberOfInputs: 2,
      numberOfOutputs: 0,
      processorOptions: { blockMs: Meter.BLOCK_MS },
    });
    previewMix.session = new Meter.Session();
    node.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.ms) previewMix.session.push(d.ms, d.peak);
    };
    previewMix.master.connect(k1);
    k1.connect(k2);
    k2.connect(node, 0, 0);
    previewMix.master.connect(node, 0, 1);
    previewMix.meterNode = node;
    previewMix.meterState = 'on';
  }).catch(() => {
    previewMix.meterState = 'unavailable';
    log('Loudness meter unavailable (the audio worklet did not load); playback is unaffected.');
  });
}

/** Forget the integrated reading and start the programme again. */
function resetMeter() {
  if (previewMix.session) previewMix.session.reset();
  meterPeakHold = { v: -Infinity, at: 0 };
}

// The peak bar falls back slowly instead of snapping, so a transient is actually visible.
let meterPeakHold = { v: -Infinity, at: 0 };
let meterFall = -Infinity;

const METER_FLOOR = -60;   // dBFS / LUFS bottom of the scale
const METER_TOP = 0;

/**
 * Draw the loudness meter.
 *
 * Two scales in one panel, which is the whole reason it is worth drawing rather than
 * printing numbers: the top bar is sample peak in dBFS (are you clipping?) and the bottom
 * bar is short-term loudness in LUFS (are you at the target?). They are NOT the same
 * question and they routinely disagree - a heavily compressed mix can sit 3 dB from
 * clipping and still be 6 LU under target.
 *
 * The signs on the loudness bar:
 *   ▼ target   - the project's loudness target, from the render panel
 *   |          - integrated so far, the number the render will actually be normalised to
 *   ░          - the ±1 LU tolerance band around the target
 *
 * Called from loop(), which re-arms in a finally - a fault here costs a frame, never the
 * session.
 */
function drawMeter() {
  const cv = $('#meterCanvas');
  if (!cv) return;
  // Match the backing store to the CSS box once, so the bars are not blurry.
  const rect = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(80, Math.round(rect.width * dpr));
  const h = Math.max(40, Math.round(rect.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.save();
  g.scale(dpr, dpr);
  const W = w / dpr, H = h / dpr;

  const s = previewMix.session;
  const x0 = 26, x1 = W - 6;
  const span = x1 - x0;
  const at = (db) => x0 + span * (clamp(db, METER_FLOOR, METER_TOP) - METER_FLOOR) / (METER_TOP - METER_FLOOR);

  const peakDb = s ? s.peakDb() : -Infinity;
  const shortDb = s ? s.shortTerm() : -Infinity;
  const intDb = s ? s.integrated() : -Infinity;
  const momDb = s ? s.momentary() : -Infinity;

  // Peak falls at ~20 dB/s so the bar reads as a level, not a strobe.
  const now = performance.now();
  if (peakDb > meterFall) meterFall = peakDb;
  else if (isFinite(meterFall)) meterFall = Math.max(peakDb, meterFall - 0.35);
  if (peakDb > meterPeakHold.v || now - meterPeakHold.at > 2000) {
    meterPeakHold = { v: peakDb, at: now };
  }

  const label = (text, y) => {
    g.fillStyle = '#7d8694';
    g.font = '9px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText(text, 2, y);
  };

  // ---- scale ticks ----------------------------------------------------
  g.strokeStyle = 'rgba(255,255,255,.10)';
  g.fillStyle = '#5d6673';
  g.font = '8px system-ui, sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 1;
  // Every 10 dB gets a rule; only every 20 gets a number, because the panel is narrow
  // and overlapping labels read as a smear rather than a scale.
  for (const db of [-60, -50, -40, -30, -20, -10, -6, -3, 0]) {
    const x = Math.round(at(db)) + 0.5;
    g.beginPath();
    g.moveTo(x, 12);
    g.lineTo(x, H - 14);
    g.stroke();
  }
  for (const db of [-60, -40, -20, -6, 0]) {
    g.fillText(String(db), Math.round(at(db)), H - 4);
  }

  // ---- peak bar -------------------------------------------------------
  const peakY = 16, barH = 14;
  label('PK', peakY + 11);
  g.fillStyle = 'rgba(255,255,255,.05)';
  g.fillRect(x0, peakY, span, barH);
  if (isFinite(meterFall)) {
    const grad = g.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, '#3f7fd6');
    grad.addColorStop(0.72, '#4fc27a');
    grad.addColorStop(0.9, '#e0c341');
    grad.addColorStop(1, '#ff5e4d');
    g.fillStyle = grad;
    g.fillRect(x0, peakY, Math.max(0, at(meterFall) - x0), barH);
  }
  // The hold mark, and the one sign that matters most: over 0 dBFS is clipping.
  if (isFinite(meterPeakHold.v)) {
    g.fillStyle = meterPeakHold.v >= -0.1 ? '#ff5e4d' : '#dfe4ea';
    g.fillRect(Math.round(at(meterPeakHold.v)) - 1, peakY, 2, barH);
  }

  // ---- loudness bar ---------------------------------------------------
  const loudY = peakY + barH + 12;
  label('LUFS', loudY + 11);
  const target = Object.assign({}, AudioFX.LOUD_DEFAULTS, state.out.loudness).lufs;

  // The tolerance band, drawn under everything as a sign of "close enough".
  g.fillStyle = 'rgba(111,220,140,.14)';
  g.fillRect(at(target - 1), loudY, Math.max(1, at(target + 1) - at(target - 1)), barH);
  g.fillStyle = 'rgba(255,255,255,.05)';
  g.fillRect(x0, loudY, span, barH);
  g.fillStyle = 'rgba(111,220,140,.16)';
  g.fillRect(at(target - 1), loudY, Math.max(1, at(target + 1) - at(target - 1)), barH);

  if (isFinite(shortDb)) {
    g.fillStyle = Math.abs(shortDb - target) <= 1 ? '#6fdc8c' : '#5a8fd8';
    g.fillRect(x0, loudY, Math.max(0, at(shortDb) - x0), barH);
  }
  if (isFinite(momDb)) {           // momentary rides on top as a thin line
    g.fillStyle = 'rgba(255,255,255,.5)';
    g.fillRect(Math.round(at(momDb)) - 1, loudY, 2, barH);
  }
  if (isFinite(intDb)) {           // integrated: the number the render is judged on
    g.fillStyle = '#ffd166';
    g.fillRect(Math.round(at(intDb)), loudY - 3, 2, barH + 6);
  }

  // The target sign itself.
  const tx = at(target);
  g.fillStyle = '#e8ebf0';
  g.beginPath();
  g.moveTo(tx - 4, loudY - 8);
  g.lineTo(tx + 4, loudY - 8);
  g.lineTo(tx, loudY - 2);
  g.closePath();
  g.fill();

  g.restore();

  // ---- the numbers ----------------------------------------------------
  const fmt = (v) => (isFinite(v) ? v.toFixed(1) : '-');
  const set = (id, v, cls) => {
    const n = $(id);
    if (!n) return;
    n.textContent = fmt(v);
    n.className = cls || '';
  };
  set('#mM', momDb);
  set('#mS', shortDb);
  set('#mI', intDb, isFinite(intDb) && Math.abs(intDb - target) <= 1 ? 'on' : '');
  set('#mPk', meterPeakHold.v, isFinite(meterPeakHold.v) && meterPeakHold.v >= -0.1 ? 'over' : '');

  const note = $('#meterNote');
  if (note) {
    note.textContent =
      previewMix.meterState === 'unavailable' ? 'Meter unavailable; playback is unaffected.'
        : previewMix.meterState !== 'on' ? 'Play to meter the preview mix.'
          : 'Preview mix, K-weighted (BS.1770). Target ' + target + ' LUFS.';
  }
}

function previewGainNode(clip, el) {
  const ctx = previewMix.ctx;
  // Attaching to a context that is not running would mute the element permanently -
  // createMediaElementSource cannot be undone.
  if (!ctx || ctx.state !== 'running') return null;
  const have = previewMix.nodes.get(clip.id);
  if (have) return have.el === el ? have : null;
  try {
    const src = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    src.connect(gain);
    // Into the master bus, not straight to the speakers, so the meter reads the mix.
    gain.connect(previewMix.master || ctx.destination);
    const node = { src, gain, el };
    previewMix.nodes.set(clip.id, node);
    return node;
  } catch (e) {
    return null;   // already routed, or the element is not eligible - fall back below
  }
}

/**
 * Route a rendered span's player through the master bus too.
 *
 * Inside a rendered span the viewer plays a finished MP4 instead of compositing, and that
 * file's audio IS the mix - but it was reaching the speakers directly, so the loudness
 * meter went dead the moment the playhead crossed into a rendered band and came back to
 * life on the way out. The meter hangs off `previewMix.master`, so anything audible has
 * to arrive there. Same rules as a clip's node: only while the context is running, and
 * `createMediaElementSource` cannot be undone, so it is created once per element and
 * disconnected with it.
 */
function previewBandNode(key, el) {
  const ctx = previewMix.ctx;
  if (!ctx || ctx.state !== 'running') return null;
  const have = previewMix.bandNodes.get(key);
  if (have) return have.el === el ? have : null;
  try {
    const src = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(previewMix.master || ctx.destination);
    const node = { src, gain, el };
    previewMix.bandNodes.set(key, node);
    return node;
  } catch (e) {
    return null;
  }
}

function dropPreviewBandNode(key) {
  const n = previewMix.bandNodes.get(key);
  if (!n) return;
  try { n.src.disconnect(); n.gain.disconnect(); } catch (e) { /* already gone */ }
  previewMix.bandNodes.delete(key);
}

function dropPreviewGain(clipId) {
  const n = previewMix.nodes.get(clipId);
  if (!n) return;
  try { n.src.disconnect(); n.gain.disconnect(); } catch (e) { /* already gone */ }
  previewMix.nodes.delete(clipId);
}

/** Put a clip's audible level and mute state onto its element for this frame. */
function applyPreviewMix(clip, el, trackMuted) {
  const lin = AudioFX.previewGain(clip);
  el.muted = !!trackMuted;
  const node = previewGainNode(clip, el);
  if (node) { node.gain.gain.value = lin; el.volume = 1; }
  else el.volume = clamp(lin, 0, 1);
}

// =================================================== 3. import

function ensureTrack(type) {
  let t = state.tracks.find((x) => x.type === type);
  if (!t) t = addTrack(type, false);
  return t;
}

function makeTrack(type, index) {
  return {
    id: nextId(),
    type,
    name: (type === 'video' ? 'V' : 'A') + index,
    muted: false,
    hidden: false,
    locked: false,
    clips: [],
    // Transitions live on the track that owns the cut they sit on, keyed by the two
    // clips either side. A transition whose clips stop being adjacent is simply ignored.
    transitions: [],
  };
}

function addTrack(type, push) {
  const count = state.tracks.filter((t) => t.type === type).length + 1;
  const t = makeTrack(type, count);
  if (type === 'video') {
    state.tracks.unshift(t); // new video tracks go on top
  } else {
    state.tracks.push(t);
  }
  if (push !== false) { pushUndo(); markDirty(); }
  renderAll();
  return t;
}

/** The first track of `type` with nothing on it between `from` and `to`, or a new one. */
function freeTrack(type, from, to) {
  const busy = (t) => t.clips.some((c) => from < clipEnd(c) - 1e-6 && to > c.start + 1e-6);
  const t = state.tracks.find((x) => x.type === type && !x.locked && !busy(x));
  return t || addTrack(type, false);
}

/**
 * Append imported media to the end of the first video/audio track, in the given order.
 *
 * `opts.at` drops it at that time instead - what the QuickBin does at the playhead. In
 * that case the clips go on the first track that is actually free over the span rather
 * than on top of whatever is already there, adding a track if every one is taken.
 */
async function importPaths(paths, opts) {
  if (!paths || !paths.length) return;
  log('Scanning ' + paths.length + ' path(s)...');
  const metas = await window.api.scanMedia(paths);
  if (!metas.length) { log('No supported media found.'); return; }
  pushUndo();

  const at = opts && opts.at != null ? Math.max(0, opts.at) : null;
  const vTrack = ensureTrack('video');
  const aTrack = ensureTrack('audio');
  // Append after whatever is already on the tracks, unless a drop time was given.
  let cursor = at != null ? at : Math.max(
    vTrack.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0),
    aTrack.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
  );

  for (const m of metas) {
    const linkId = nextId();
    const vt = at == null ? vTrack : freeTrack('video', cursor, cursor + m.duration);
    const at_ = at == null ? aTrack : freeTrack('audio', cursor, cursor + m.duration);
    if (m.kind === 'video') {
      vt.clips.push({
        id: nextId(), src: m.path, name: m.name, kind: 'video',
        start: cursor, in: 0, out: m.duration, mediaDuration: m.duration,
        srcW: m.width, srcH: m.height, fps: m.fps,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
        linkId: m.hasAudio ? linkId : null,
      });
      if (m.hasAudio) {
        at_.clips.push({
          id: nextId(), src: m.path, name: m.name, kind: 'audio',
          start: cursor, in: 0, out: m.duration, mediaDuration: m.duration,
          srcW: 0, srcH: 0, fps: 0,
          panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
          linkId,
        });
      }
    } else {
      at_.clips.push({
        id: nextId(), src: m.path, name: m.name, kind: 'audio',
        start: cursor, in: 0, out: m.duration, mediaDuration: m.duration,
        srcW: 0, srcH: 0, fps: 0,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
    }
    cursor += m.duration;
  }
  sortTracks();
  markDirty();
  renderAll();
  log('Imported ' + metas.length + ' clip(s).');
}

/** The range a render should cover: the in/out marks if set, else the whole project. */
function renderRange() {
  const dur = projectDuration();
  let a = state.inPoint == null ? 0 : state.inPoint;
  let b = state.outPoint == null ? dur : state.outPoint;
  a = clamp(a, 0, dur);
  b = clamp(b, 0, dur);
  if (b <= a) { a = 0; b = dur; }
  return { from: a, to: b, ranged: state.inPoint != null || state.outPoint != null };
}

function setInPoint(t) {
  state.inPoint = clamp(t == null ? state.playhead : t, 0, projectDuration());
  if (state.outPoint != null && state.outPoint <= state.inPoint) state.outPoint = null;
  renderRuler(); renderRangeOverlay(); updateRenderUI();
  log('In point at ' + fmtTc(state.inPoint));
}
function setOutPoint(t) {
  state.outPoint = clamp(t == null ? state.playhead : t, 0, projectDuration());
  if (state.inPoint != null && state.inPoint >= state.outPoint) state.inPoint = null;
  renderRuler(); renderRangeOverlay(); updateRenderUI();
  log('Out point at ' + fmtTc(state.outPoint));
}
function clearRange() {
  state.inPoint = state.outPoint = null;
  renderRuler(); renderRangeOverlay(); updateRenderUI();
  log('Cleared the in/out marks.');
}

function sortTracks() {
  for (const t of state.tracks) t.clips.sort((a, b) => a.start - b.start);
}

/**
 * Add a text card at the playhead.
 *
 * Text clips live on video tracks alongside footage, so track order gives them their
 * z-order for free. They have no source file: `card` holds everything (see
 * text/model.js), `in` stays 0 and the clip length is simply `out`.
 */
function addTextCard(text) {
  pushUndo();
  const DEFAULT_LEN = 3;
  const start = state.playhead;

  // Prefer a video track that is free at the playhead so the card does not cover footage.
  let track = state.tracks.find((t) => t.type === 'video' && !t.locked &&
    !t.clips.some((c) => start < clipEnd(c) && start + DEFAULT_LEN > c.start));
  if (!track) track = addTrack('video', false);

  const clip = {
    id: nextId(),
    src: null,
    name: 'Text',
    kind: 'text',
    start,
    in: 0,
    out: DEFAULT_LEN,
    mediaDuration: 3600,      // a card can be stretched to any length
    srcW: 0, srcH: 0, fps: 0,
    panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
    linkId: null,
    card: TextModel.defaultCard(text),
  };
  track.clips.push(clip);
  sortTracks();
  setSelection([clip.id], false);
  markDirty();
  renderAll();
  log('Added a text card at ' + fmtTc(start) + '.');
  return clip;
}

/** The single selected text clip, or null. Drives the text editor panel. */
function selectedTextClip() {
  const sel = selectedClips().filter((x) => x.clip.kind === 'text');
  return sel.length === 1 ? sel[0].clip : null;
}

/** Text clips under the playhead, bottom track first so upper tracks draw last. */
function activeTextClips() {
  const out = [];
  for (const t of state.tracks) {
    if (t.type !== 'video' || t.hidden) continue;
    for (const c of t.clips) {
      if (c.kind !== 'text') continue;
      if (state.playhead >= c.start && state.playhead < clipEnd(c)) out.push(c);
    }
  }
  return out.reverse();
}

// =============================================== 3b. transitions

/** Every cut on a track: a pair of clips that touch, with the time they meet at. */
function trackCuts(track) {
  const out = [];
  const clips = track.clips.filter((c) => c.kind !== 'audio').slice().sort((x, y) => x.start - y.start);
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i], b = clips[i + 1];
    if (Math.abs(clipEnd(a) - b.start) < 0.002) out.push({ a, b, cut: b.start, track });
  }
  return out;
}

function allCuts() {
  return state.tracks.filter((t) => t.type === 'video').flatMap(trackCuts);
}

/** Resolve a stored transition against the current timeline. Null if its cut is gone. */
function resolveTransition(tr, track) {
  const a = track.clips.find((c) => c.id === tr.aId);
  const b = track.clips.find((c) => c.id === tr.bId);
  if (!a || !b) return null;
  if (Math.abs(clipEnd(a) - b.start) > 0.002) return null;   // no longer adjacent
  const w = Trans.windowOf(tr, b.start);
  return { tr, track, a, b, cut: b.start, from: w.from, to: w.to, dur: w.dur };
}

/** Every live transition, bottom track first (same order the render chain uses). */
function activeTransitions() {
  const out = [];
  for (const t of state.tracks) {
    if (t.type !== 'video') continue;
    for (const tr of (t.transitions || [])) {
      const r = resolveTransition(tr, t);
      if (r) out.push(r);
    }
  }
  return out;
}

/** The transition under the playhead, topmost track first (what the preview shows). */
function transitionAt(time) {
  const t = time == null ? state.playhead : time;
  const live = activeTransitions();
  for (let i = live.length - 1; i >= 0; i--) {
    const r = live[i];
    if (r.track.hidden) continue;
    if (t >= r.from && t < r.to) return r;
  }
  return null;
}

const findTransition = (id) => activeTransitions().find((r) => r.tr.id === id) || null;
const selectedTransition = () => (state.selTransition ? findTransition(state.selTransition) : null);

/** How long a transition can be before it runs past either clip. */
function maxTransitionDuration(a, b) {
  const lenA = a.out - a.in, lenB = b.out - b.in;
  return Math.max(0.04, Math.min(lenA, lenB) * 1.9);
}

/**
 * Add a transition to the cut nearest the playhead.
 *
 * This is the "fast grab": one key (T) or one button, no dialog - it lands on the
 * closest cut with a sensible length and selects itself so it can be tuned right away.
 */
function addTransition(type, cutInfo) {
  const cuts = cutInfo ? [cutInfo] : allCuts();
  if (!cuts.length) { log('No cut to put a transition on - two clips must touch.'); return null; }
  let best = cuts[0], bestD = Math.abs(cuts[0].cut - state.playhead);
  for (const c of cuts) {
    const d = Math.abs(c.cut - state.playhead);
    if (d < bestD) { best = c; bestD = d; }
  }
  const existing = (best.track.transitions || []).find((t) => t.aId === best.a.id && t.bId === best.b.id);
  if (existing) {
    setSelection([], false);
    state.selTransition = existing.id;
    renderAll();
    log('That cut already has a transition - selected it.');
    return existing;
  }
  pushUndo();
  const tr = Trans.defaults(type || 'swipe');
  tr.aId = best.a.id;
  tr.bId = best.b.id;
  tr.duration = Math.min(tr.duration, maxTransitionDuration(best.a, best.b));
  if (!best.track.transitions) best.track.transitions = [];
  best.track.transitions.push(tr);
  setSelection([], false);
  state.selTransition = tr.id;
  state.lastTransitionType = tr.type;
  markDirty();
  renderAll();
  log('Added a ' + Trans.TYPES[tr.type].label.toLowerCase() + ' transition at ' + fmtTc(best.cut) + '.');
  return tr;
}

/** Object transitions need their PNG decoded before anything can draw them. */
function preloadTransitionImages() {
  for (const t of state.tracks) {
    for (const tr of (t.transitions || [])) {
      if (tr.type === 'object' && tr.params && tr.params.src) Trans.loadImage(tr.params.src);
    }
  }
}

function deleteTransition(id) {
  const r = findTransition(id || state.selTransition);
  if (!r) return;
  pushUndo();
  r.track.transitions = r.track.transitions.filter((t) => t.id !== r.tr.id);
  if (state.selTransition === r.tr.id) state.selTransition = null;
  markDirty();
  renderAll();
  log('Removed the transition.');
}

// ========================================== 4. timeline rendering

function renderAll() {
  renderHeads();
  renderLanes();
  renderRuler();
  renderRangeOverlay();
  updateRenderUI();
  renderPlayhead();
  renderInspector();
  drawPreview();
}

function renderHeads() {
  const wrap = $('#trackHeads');
  wrap.innerHTML = '';
  for (const t of state.tracks) {
    const d = document.createElement('div');
    d.className = 'track-head';
    d.style.height = TRACK_H + 'px';
    const isV = t.type === 'video';
    d.innerHTML =
      '<div class="name"><i class="dot ' + (isV ? 'v' : 'a') + '"></i>' + t.name + '</div>' +
      '<div class="ctrls">' +
      (isV
        ? '<button data-act="hide" class="' + (t.hidden ? 'off' : '') + '" title="Hide track">' + (t.hidden ? 'Hidden' : 'Shown') + '</button>'
        : '<button data-act="mute" class="' + (t.muted ? 'off' : '') + '" title="Mute track (M)">' + (t.muted ? 'Muted' : 'Audible') + '</button>') +
      '<button data-act="lock" class="' + (t.locked ? 'on' : '') + '" title="Lock track against editing">' + (t.locked ? 'Locked' : 'Lock') + '</button>' +
      '<button data-act="del" title="Delete this track and its clips">Del</button>' +
      '</div>';
    d.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        pushUndo();
        if (act === 'hide') t.hidden = !t.hidden;
        else if (act === 'mute') t.muted = !t.muted;
        else if (act === 'lock') t.locked = !t.locked;
        else if (act === 'del') {
          if (state.tracks.length <= 1) return;
          for (const c of t.clips) dropMedia(c.id);
          state.tracks = state.tracks.filter((x) => x !== t);
        }
        markDirty();
        renderAll();
      });
    });
    wrap.appendChild(d);
  }
}

/** A little empty room past the last clip so there is somewhere to drag things to. */
function timelinePadSec() {
  return Math.max(2, projectDuration() * 0.15);
}
function timelineWidthPx() {
  return Math.max(600, (projectDuration() + timelinePadSec()) * state.pxPerSec);
}

function renderLanes() {
  const tracks = $('#tracks');
  tracks.innerHTML = '';
  const w = timelineWidthPx();
  tracks.style.width = w + 'px';

  state.tracks.forEach((t, ti) => {
    const lane = document.createElement('div');
    lane.className = 'track-lane ' + t.type;
    lane.style.height = TRACK_H + 'px';
    lane.dataset.trackIndex = String(ti);

    for (const c of t.clips) {
      const el = document.createElement('div');
      el.className = 'clip ' + c.kind +
        (state.selection.has(c.id) ? ' selected' : '') +
        (c.linkId ? ' linked' : '') +
        ((t.muted || t.hidden) ? ' muted' : '');
      el.style.left = (c.start * state.pxPerSec) + 'px';
      el.style.width = Math.max(6, (c.out - c.in) * state.pxPerSec) + 'px';
      el.dataset.clipId = c.id;
      const label = c.kind === 'text'
        ? (String(c.card.text).split(/\r?\n/)[0].slice(0, 40) || 'Text')
        : c.name;
      el.innerHTML =
        '<div class="handle l"></div>' +
        '<div class="label">' + escapeHtml(label) + '</div>' +
        '<div class="handle r"></div>';
      if (c.kind === 'audio') drawClipWave(el, c);
      lane.appendChild(el);
    }

    // Transitions straddle the cut they sit on, with a grab handle at each end.
    for (const tr of (t.transitions || [])) {
      const r = resolveTransition(tr, t);
      if (!r) continue;
      const el = document.createElement('div');
      el.className = 'transition' + (state.selTransition === tr.id ? ' selected' : '') +
        ' ttype-' + tr.type;
      el.style.left = (r.from * state.pxPerSec) + 'px';
      el.style.width = Math.max(8, r.dur * state.pxPerSec) + 'px';
      el.dataset.transId = tr.id;
      el.title = Trans.TYPES[tr.type].label + '  ' + r.dur.toFixed(2) + 's';
      el.innerHTML =
        '<div class="thandle l"></div>' +
        '<div class="tlabel">' + escapeHtml(Trans.TYPES[tr.type].label) + '</div>' +
        '<div class="thandle r"></div>';
      lane.appendChild(el);
    }
    tracks.appendChild(lane);
  });
  $('#tracksArea').style.width = w + 'px';
  $('#tracksArea').style.height = (state.tracks.length * TRACK_H) + 'px';
}

/**
 * Paint the audio clip's waveform behind its label.
 *
 * The peaks belong to the source file, so trimming or splitting a clip only changes
 * which slice is drawn - nothing is decoded again. The canvas width is capped because
 * this runs inside `renderLanes()`, which fires on every mouse move while a clip is
 * being dragged; a zoomed-in clip a few thousand pixels wide would otherwise cost a
 * few thousand fillRects per frame, per clip.
 */
const WAVE_MAX_PX = 1600;
/** Painted waveforms, keyed by everything that changes the picture. */
const waveCanvases = new Map();
function drawClipWave(el, c) {
  if (!c.src) return;
  const wPx = Math.round(Math.max(6, (c.out - c.in) * state.pxPerSec));
  if (wPx < 12) return;
  const w = Math.min(WAVE_MAX_PX, wPx);
  const h = TRACK_H - 8;
  // Dragging a clip changes neither its slice nor its width, so the same canvas can be
  // moved into the rebuilt lane instead of being repainted on every mouse move. The old
  // lane has already been thrown away, so nothing else is holding this element.
  const key = c.id + '|' + c.src + '|' + c.in.toFixed(4) + '|' + c.out.toFixed(4) + '|' + w + 'x' + h;
  let cv = waveCanvases.get(key);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.className = 'wave';
    cv.width = w;
    cv.height = h;
    try {
      if (!Wave.draw(cv, c.src, c.in, c.out, c.mediaDuration, 'rgba(210,255,236,.55)')) return;
    } catch (e) { return; }
    if (waveCanvases.size > 300) waveCanvases.clear();   // cheap bound; they are all redrawable
    waveCanvases.set(key, cv);
  }
  el.insertBefore(cv, el.firstChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

const RULER_H = 38;
const CACHE_BAR_H = 6;

function renderRuler() {
  const cv = $('#ruler');
  const w = timelineWidthPx();
  cv.width = w; cv.style.width = w + 'px';
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, RULER_H);
  ctx.fillStyle = '#22262f'; ctx.fillRect(0, 0, w, RULER_H);

  // Pick a tick spacing that stays readable at any zoom.
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * state.pxPerSec >= 70) || 600;
  ctx.strokeStyle = '#3a4152'; ctx.fillStyle = '#8b93a3';
  ctx.font = '10px Consolas, monospace';
  // Sub-second ticks need a decimal, or every label reads the same.
  const label = (t) => {
    const m = Math.floor(t / 60), s = t % 60;
    const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0');
    return m + ':' + ss;
  };
  for (let t = 0; t * state.pxPerSec <= w; t += step) {
    const x = Math.round(t * state.pxPerSec) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, 26); ctx.stroke();
    ctx.fillText(label(t), x + 3, 11);
  }

  drawCacheBar(ctx, w);
  drawRangeMarks(ctx, w);
}

/**
 * The strip along the bottom of the ruler showing which spans of the timeline already
 * have a valid cached render. A band disappears the moment anything inside it is edited,
 * because its cache key stops matching - so the bar is a live readout of what a render
 * would actually have to re-encode.
 */
function drawCacheBar(ctx, w) {
  const y = RULER_H - CACHE_BAR_H;
  ctx.fillStyle = '#191c22';
  ctx.fillRect(0, y, w, CACHE_BAR_H);
  ctx.fillStyle = '#43b98f';
  for (const b of state.cacheBands) {
    const x0 = b.from * state.pxPerSec;
    const x1 = b.to * state.pxPerSec;
    if (x1 <= x0) continue;
    ctx.fillRect(x0, y, Math.max(2, x1 - x0), CACHE_BAR_H);
  }
  ctx.strokeStyle = '#2f343f';
  ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
}

/** In/out marks, drawn as brackets on the ruler. */
function drawRangeMarks(ctx, w) {
  const mark = (t, isIn) => {
    const x = Math.round(t * state.pxPerSec) + 0.5;
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(x - (isIn ? 0 : 2), 0, 2, RULER_H - CACHE_BAR_H);
    ctx.beginPath();
    if (isIn) { ctx.moveTo(x, 0); ctx.lineTo(x + 9, 0); ctx.lineTo(x, 9); }
    else { ctx.moveTo(x, 0); ctx.lineTo(x - 9, 0); ctx.lineTo(x, 9); }
    ctx.closePath();
    ctx.fill();
  };
  if (state.inPoint != null) mark(state.inPoint, true);
  if (state.outPoint != null) mark(state.outPoint, false);
}

/** Shade the parts of the timeline a ranged render would ignore. */
function renderRangeOverlay() {
  const ov = $('#rangeOverlay');
  const useMarks = $('#renderRange') && $('#renderRange').value === 'marks';
  if (!useMarks || (state.inPoint == null && state.outPoint == null)) {
    ov.classList.add('off');
    return;
  }
  ov.classList.remove('off');
  const r = renderRange();
  ov.querySelector('.before').style.width = (r.from * state.pxPerSec) + 'px';
  const total = timelineWidthPx();
  ov.querySelector('.after').style.width = Math.max(0, total - r.to * state.pxPerSec) + 'px';
}

function renderPlayhead() {
  $('#playhead').style.left = (state.playhead * state.pxPerSec) + 'px';
  $('#timecode').textContent = fmtTc(state.playhead) + ' / ' + fmtTc(projectDuration());
}

function selectedClips() {
  return allClips().filter((x) => state.selection.has(x.clip.id));
}

/**
 * The transition inspector.
 *
 * Built from the same `TextUI.control` rows as the text panel, so every value here is a
 * slider AND a typable box AND scroll-adjustable AND resettable, without duplicating any
 * of that logic.
 */
/** Names of the saved transition presets, refreshed from the library in the background. */
let transPresetNames = [];

async function refreshTransPresets(rebuild) {
  try {
    const all = await window.api.listPresets();
    transPresetNames = (all && all.trans) || [];
  } catch (e) { transPresetNames = []; }
  if (rebuild) renderTransitionPanel();
}

/** Save / load / share transition looks, using the same library as the text presets. */
function transitionPresetBar(tr) {
  const el = TextUI.el;
  const box = el('div', 'tc-preset-box');

  const head = el('div', 'tc-preset-head');
  head.appendChild(el('b', null, 'Presets'));
  head.appendChild(el('span', 'tc-hint', transPresetNames.length + ' saved'));
  box.appendChild(head);

  const sel = el('select', 'tc-preset-sel');
  const o0 = el('option');
  o0.value = '';
  o0.textContent = transPresetNames.length ? 'Choose a saved preset...' : 'Nothing saved yet';
  sel.appendChild(o0);
  for (const n of transPresetNames) {
    const o = el('option'); o.value = n; o.textContent = n; sel.appendChild(o);
  }
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    const data = await window.api.loadPreset('trans', sel.value);
    if (!data) { log('Could not read that transition preset.'); return; }
    pushUndo();
    Trans.applyPreset(tr, data);
    if (tr.type === 'object' && tr.params.src) await Trans.loadImage(tr.params.src);
    tr.duration = Math.min(tr.duration, maxTransitionDuration(
      findTransition(tr.id).a, findTransition(tr.id).b));
    markDirty();
    renderAll();
    log('Applied transition preset "' + sel.value + '".');
  });
  box.appendChild(sel);

  const saveRow = el('div', 'tc-preset-save');
  const nameInput = el('input', 'tc-preset-input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Save as...';
  // window.prompt does not exist in Electron, hence the inline field - see the README.
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') doSave();
  });
  const doSave = async () => {
    const name = nameInput.value.trim() || (Trans.TYPES[tr.type].label + ' ' + (transPresetNames.length + 1));
    const data = Trans.extractPreset(tr);
    data.name = name;
    nameInput.value = '';
    await window.api.savePreset('trans', name, data);
    await refreshTransPresets(true);
    log('Saved transition preset "' + name + '".');
  };
  const save = el('button', 'mini', 'Save');
  save.addEventListener('click', doSave);
  saveRow.appendChild(nameInput);
  saveRow.appendChild(save);
  box.appendChild(saveRow);

  const acts = el('div', 'tc-preset-acts');
  const del = el('button', 'mini', 'Delete');
  del.addEventListener('click', async () => {
    if (!sel.value) { log('Pick a saved transition preset above first.'); return; }
    await window.api.deletePreset('trans', sel.value);
    await refreshTransPresets(true);
  });
  const exp = el('button', 'mini', 'Export');
  exp.addEventListener('click', async () => {
    const data = Trans.extractPreset(tr);
    data.name = nameInput.value.trim() || (Trans.TYPES[tr.type].label + ' transition');
    await window.api.exportPreset('trans', data);
  });
  const imp = el('button', 'mini', 'Import');
  imp.addEventListener('click', async () => {
    const data = await window.api.importPreset('trans');
    if (!data) return;
    pushUndo();
    Trans.applyPreset(tr, data);
    if (tr.type === 'object' && tr.params.src) await Trans.loadImage(tr.params.src);
    markDirty();
    renderAll();
  });
  acts.appendChild(del); acts.appendChild(exp); acts.appendChild(imp);
  box.appendChild(acts);
  box.appendChild(el('div', 'tc-hint',
    'A preset carries the look - type, length, curve, motion blur and every parameter - but never which cut it sits on.'));
  return box;
}

function renderTransitionPanel() {
  const host = $('#transPanel');
  const head = $('#transPanelHead');
  const r = selectedTransition();
  head.hidden = !r;
  host.hidden = !r;
  if (!r) { host.innerHTML = ''; return; }

  const tr = r.tr;
  // Changing the type leaves the new type's own parameters absent, which rendered every
  // control blank. Filling them from the type's defaults here catches that, and old
  // projects saved before a parameter existed, without clobbering anything already set.
  Trans.normalize(tr);
  const D = Trans.defaults(tr.type);
  const opts = { rebuild: renderTransitionPanel };
  const C = (spec) => TextUI.control(spec, tr, D, opts);
  const el = TextUI.el;

  $('#transMeta').textContent = fmtTc(r.cut) + '  ' + r.dur.toFixed(2) + 's';
  host.innerHTML = '';

  const body = el('div', 'tc-body');
  body.appendChild(C({
    path: 'type', label: 'Type', type: 'select',
    options: Object.keys(Trans.TYPES).map((k) => ({ value: k, label: Trans.TYPES[k].label })),
  }));
  body.appendChild(C({
    path: 'duration', label: 'Length', type: 'range',
    min: 0.04, max: Math.max(0.5, maxTransitionDuration(r.a, r.b)), step: 0.01, unit: 's', digits: 2,
  }));
  body.appendChild(C({
    path: 'align', label: 'Sits', type: 'select',
    options: [
      { value: 'center', label: 'Centred on the cut' },
      { value: 'before', label: 'Before the cut' },
      { value: 'after', label: 'After the cut' },
    ],
  }));

  const p = tr.params;
  if (tr.type === 'swipe') {
    body.appendChild(C({ path: 'params.direction', label: 'Direction', type: 'select', options: Trans.DIRECTIONS }));
    body.appendChild(C({ path: 'params.softness', label: 'Softness', type: 'range', min: 0.01, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.blur', label: 'Blur', type: 'range', min: 0, max: 120, step: 1, unit: 'px' }));
    body.appendChild(C({ path: 'params.deform', label: 'Smear', type: 'range', min: 0, max: 2, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.stretch', label: 'Stretch', type: 'range', min: 0, max: 0.5, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.deformAxis', label: 'Deform along', type: 'select', options: Trans.DEFORM_AXES }));
    body.appendChild(C({ path: 'params.deformSamples', label: 'Smear steps', type: 'range', min: 2, max: 32, step: 1 }));
    body.appendChild(el('div', 'tc-hint',
      'Both clips blur, smear and stretch as they swap, peaking halfway through. Smear is how far ' +
      'the picture is dragged along the axis, stretch how much it is squashed and pulled while it ' +
      'travels; more steps make a longer smear smoother at the cost of drawing time. Softness is ' +
      'how wide the swipe edge is.'));
  } else if (tr.type === 'burn') {
    body.appendChild(C({ path: 'params.direction', label: 'Sweeps', type: 'select', options: Trans.DIRECTIONS }));
    body.appendChild(C({ path: 'params.angle', label: 'Diagonal', type: 'range', min: -90, max: 90, step: 1, unit: 'deg' }));
    body.appendChild(C({ path: 'params.edge', label: 'Spread', type: 'range', min: 0.05, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.color', label: 'Ember', type: 'color' }));
    body.appendChild(C({ path: 'params.hot', label: 'Hot core', type: 'color' }));
    body.appendChild(C({ path: 'params.glow', label: 'Leak strength', type: 'range', min: 0, max: 2, step: 0.05, digits: 2 }));
    body.appendChild(C({ path: 'params.flash', label: 'Bloom', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.peakAt', label: 'Peaks at', type: 'range', min: 0.1, max: 0.9, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.seed', label: 'Streaks', type: 'range', min: 0, max: 9999, step: 1 }));
    body.appendChild(el('div', 'tc-hint',
      'A warm light leak blooms across the frame and the clips cut underneath it at the peak, ' +
      'where the bloom is bright enough to hide the join. Spread is how far ember colour trails ' +
      'behind the hot edge; the streaks are seeded, not random, so the preview and the render agree.'));
  } else {
    const row = el('div', 'tc-row');
    row.appendChild(el('label', 'tc-label', 'Image'));
    const file = el('div', 'tc-file');
    const name = el('span', null, p.src ? String(p.src).split(/[\\/]/).pop() : 'none chosen');
    name.title = p.src || '';
    const pick = el('button', 'mini', 'Choose...');
    pick.addEventListener('click', async () => {
      const f = await window.api.pickImage();
      if (!f) return;
      pushUndo();
      p.src = f;
      await Trans.loadImage(f);
      markDirty();
      renderTransitionPanel();
      drawPreview();
    });
    file.appendChild(name);
    file.appendChild(pick);
    row.appendChild(file);
    body.appendChild(row);

    body.appendChild(C({ path: 'params.direction', label: 'Moves', type: 'select', options: Trans.DIRECTIONS }));
    body.appendChild(C({ path: 'params.scale', label: 'Size', type: 'range', min: 0.05, max: 4, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.travel', label: 'Travel', type: 'range', min: 0.2, max: 3, step: 0.05, digits: 2 }));
    body.appendChild(C({ path: 'params.rotate', label: 'Rotation', type: 'range', min: -180, max: 180, step: 1, unit: 'deg' }));
    body.appendChild(C({ path: 'params.spin', label: 'Spin', type: 'range', min: -720, max: 720, step: 5, unit: 'deg' }));
    body.appendChild(C({ path: 'params.offsetX', label: 'Offset X', type: 'range', min: -1, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.offsetY', label: 'Offset Y', type: 'range', min: -1, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.fadeIn', label: 'Fade in', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.fadeOut', label: 'Fade out', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(C({ path: 'params.switchAt', label: 'Cut at', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 }));
    body.appendChild(el('div', 'tc-hint',
      'The clips swap when the object is at "Cut at" through its travel - set it to the point ' +
      'where the image covers the frame. Offset shifts the whole path within the frame without ' +
      'changing how far it moves; fade in and out are fractions of the transition.'));
  }

  // Curve + motion blur apply to every type.
  const curveRow = el('div', 'tc-row');
  curveRow.appendChild(el('label', 'tc-label', 'Curve'));
  const curveBtn = el('button', 'mini', 'Edit curve');
  curveRow.appendChild(curveBtn);
  body.appendChild(curveRow);
  const curveBox = el('div', 'tc-curve-host');
  curveBox.hidden = true;
  curveBtn.addEventListener('click', () => {
    if (curveBox.hidden) {
      curveBox.innerHTML = '';
      curveBox.appendChild(TextUI.curveEditor(tr));
    }
    curveBox.hidden = !curveBox.hidden;
    curveBtn.classList.toggle('on', !curveBox.hidden);
  });
  body.appendChild(curveBox);

  body.appendChild(C({ path: 'motionBlur.on', label: 'Motion blur', type: 'check' }));
  body.appendChild(C({ path: 'motionBlur.strength', label: 'MB strength', type: 'range', min: 0, max: 2, step: 0.05, digits: 2 }));
  body.appendChild(C({ path: 'motionBlur.samples', label: 'MB samples', type: 'range', min: 2, max: 32, step: 1 }));
  if (tr.type !== 'object') {
    body.appendChild(el('div', 'tc-hint', 'Motion blur only moves the object layer, so it has no effect on this type.'));
  }

  body.appendChild(transitionPresetBar(tr));
  host.appendChild(body);
}

function renderInspector() {
  const box = $('#inspector');
  const sel = selectedClips();
  renderTransitionPanel();

  // A selected text card opens the editor drawer on the far right. The left column keeps
  // showing the normal clip inspector, so the preview area is never resized by it.
  const textClip = selectedTextClip();
  $('#textPanelHead').hidden = !textClip;
  $('#textPanel').hidden = !textClip;
  if (textClip) {
    $('#textCardMeta').textContent =
      fmtTc(textClip.start) + '  +' + (textClip.out - textClip.in).toFixed(2) + 's';
  }
  if (typeof TextUI !== 'undefined') TextUI.refresh();

  if (!sel.length) { box.innerHTML = '<div class="empty">No clip selected.</div>'; return; }

  // One link group is ONE thing, not a multi-selection.
  //
  // Clicking a clip selects its whole link group (see the lane mousedown handler), so an
  // imported video with sound always arrives here as two clips - and treating that as a
  // multi-selection meant the commonest selection in the app produced "2 clips selected."
  // and no inspector at all: no framing, no volume, no audio effects. The pair is shown
  // as the video clip, which is the half with a picture, framing and a name on it.
  const row = singleUnit(sel);
  if (!row) {
    // A genuine multi-selection has no single clip to describe - but Tighten works over
    // as many link groups as are selected, so it is offered here rather than being
    // reachable only one clip at a time.
    box.innerHTML = '<div class="empty">' + sel.length + ' clips selected.</div>';
    if (sel.some((x) => tightenAudioFor(x.clip))) box.appendChild(tightenPanel());
    return;
  }
  const c = row.clip;
  const isText = c.kind === 'text';
  const source = isText ? 'text card'
    : (c.srcW ? c.srcW + 'x' + c.srcH + ' @' + c.fps + 'fps' : 'audio');
  const name = isText
    ? (String(c.card.text).split(/\r?\n/)[0].slice(0, 40) || '(empty)')
    : c.name;

  box.innerHTML =
    '<div class="kv">' +
    '<b>Name</b><span title="' + escapeHtml(c.src || source) + '">' + escapeHtml(name) + '</span>' +
    '<b>Track</b><span>' + row.track.name + '</span>' +
    '<b>Source</b><span>' + source + '</span>' +
    '<b>Start</b><span>' + fmtTc(c.start) + '</span>' +
    '<b>Length</b><span>' + fmtTc(c.out - c.in) + '</span>' +
    (isText ? '' : '<b>In / Out</b><span>' + fmtTc(c.in) + ' - ' + fmtTc(c.out) + '</span>') +
    (isText ? '' : '<b>Linked</b><span>' + (c.linkId ? 'yes' : 'no') + '</span>') +
    (isText ? '' :
      '<b>Volume</b><span class="kv-range">' +
      '<input id="clipVol" type="range" min="0" max="2" step="0.01" value="' + c.volume + '">' +
      '<input id="clipVolN" class="tc-num" type="number" min="0" max="4" step="0.01" value="' + c.volume + '">' +
      '</span>') +
    '</div>';
  const vol = $('#clipVol');
  const volN = $('#clipVolN');
  if (vol) {
    const setVol = (v, from) => {
      if (!isFinite(v)) return;
      c.volume = v;
      if (from !== 'range') vol.value = clamp(v, 0, 2);
      if (from !== 'num') volN.value = v;
      markDirty();
    };
    vol.addEventListener('pointerdown', () => pushUndo());
    vol.addEventListener('input', () => setVol(parseFloat(vol.value), 'range'));
    volN.addEventListener('focus', () => pushUndo());
    volN.addEventListener('keydown', (e) => e.stopPropagation());
    volN.addEventListener('input', () => setVol(parseFloat(volN.value), 'num'));
    const volWheel = {
      step: 0.01, min: 0, max: 4,
      get: () => c.volume,
      set: (v) => setVol(v, 'wheel'),
    };
    TextUI.attachWheel(vol, volWheel);
    TextUI.attachWheel(volN, volWheel);
  }
  const fxTarget = audioFxTarget(c);
  if (fxTarget) box.appendChild(audioFxPanel(fxTarget.clip, fxTarget.viaLink));
  if (tightenAudioFor(c)) box.appendChild(tightenPanel());
  syncFramingControls();
}

/**
 * The one clip a selection is really about, or null if it is a genuine multi-selection.
 *
 * A selection of several clips that all share one `linkId` is a single A/V pair, which is
 * what clicking any linked clip produces. The video half is the one to show: it carries
 * the framing, the source dimensions and the name. Its audio half is still reachable -
 * audioFxTarget() walks the link to find it.
 */
function singleUnit(sel) {
  if (sel.length === 1) return sel[0];
  const id = sel[0].clip.linkId;
  if (!id || !sel.every((x) => x.clip.linkId === id)) return null;
  return sel.find((x) => x.clip.kind === 'video') || sel[0];
}

/**
 * Which clip an audio chain edited from this selection belongs to.
 *
 * Selecting a video clip is what people actually do - the video half is the one with the
 * picture on it, and importing a file with sound puts the audio on a separate track and
 * a separate lane. Routing through the link group means the audio chain is reachable
 * from either half of a linked pair instead of only from the one nobody clicks.
 *
 * Returns null for a text card, or a video clip with no linked audio - there is nothing
 * to put effects on.
 */
function audioFxTarget(clip) {
  if (!clip || clip.kind === 'text') return null;
  if (clip.kind === 'audio') return { clip, viaLink: null };
  if (clip.kind !== 'video' || !clip.linkId) return null;
  const mate = linkGroup(clip).find((x) => x.kind === 'audio');
  if (!mate) return null;
  const row = allClips().find((x) => x.clip === mate);
  return { clip: mate, viaLink: row ? row.track.name : 'linked audio' };
}

/**
 * The Tighten panel.
 *
 * Threshold, pad and noise floor, with a LIVE count of what would come out before
 * anything is committed - the whole point of separating `tightenPlan()` from `tighten()`.
 * The rows are `TextUI.control`, so each one is a slider AND a typable box AND
 * scroll-adjustable AND resettable, but they pass their own hooks: these are settings,
 * not timeline state, so moving a slider here snapshots no undo entry and dirties nothing.
 */
let tightenBusy = false;

function tightenPanel() {
  const el = TextUI.el;
  const box = el('div', 'afx-box tighten-box');

  const head = el('div', 'afx-head');
  head.appendChild(el('b', null, 'Tighten'));
  const count = el('span', 'tc-hint');
  head.appendChild(count);
  box.appendChild(head);

  box.appendChild(el('div', 'tc-hint',
    'Removes silences from the selection and ripples the cut through its link group, ' +
    'so picture and sound stay together. One undo entry for the whole pass.'));

  const status = el('div', 'tc-hint tighten-status');
  const body = el('div', 'tc-body');
  const bar = el('div', 'tc-btns tighten-bar');
  const analyseBtn = el('button', 'mini', 'Analyse');
  const runBtn = el('button', 'mini', 'Tighten');
  analyseBtn.title = 'Measure the selection with ffmpeg silencedetect (cached per file)';
  runBtn.title = 'Remove the silences shown above';

  const paint = () => {
    const plan = tightenPlan();
    count.textContent = plan.pending ? 'not measured'
      : plan.count ? plan.count + ' cut' + (plan.count === 1 ? '' : 's') : 'nothing to cut';
    status.textContent = plan.pending
      ? (tightenBusy ? 'Analysing...' : plan.pending + ' clip(s) still to measure.')
      : plan.count
        ? 'Would remove ' + plan.count + ' span(s), ' + plan.removed.toFixed(2) + 's of ' +
          projectDuration().toFixed(2) + 's.'
        : 'No silence over ' + tightenOpts().threshold.toFixed(2) + 's at this noise floor.';
    runBtn.disabled = !plan.count;
    analyseBtn.disabled = tightenBusy;
  };

  const hooks = { onEdit: () => {}, onEditEnd: () => {}, onChanged: paint };
  const C = (spec) => TextUI.control(spec, state.tighten, TIGHTEN_DEFAULTS, hooks);
  body.appendChild(C({
    path: 'threshold', label: 'Silence over', type: 'range',
    min: 0.05, max: 3, step: 0.01, unit: 's', digits: 2,
  }));
  body.appendChild(C({
    path: 'pad', label: 'Keep either side', type: 'range',
    min: 0, max: 0.5, step: 0.01, unit: 's', digits: 2,
  }));
  // The noise floor is what ffmpeg was asked, so changing it needs a fresh measurement.
  const noiseRow = C({
    path: 'noise', label: 'Noise floor', type: 'range',
    min: -60, max: -10, step: 1, unit: 'dB', digits: 0,
  });
  body.appendChild(noiseRow);
  box.appendChild(body);
  box.appendChild(status);

  const analyse = async () => {
    if (tightenBusy) return;
    tightenBusy = true;
    paint();
    const r = await analyzeTightenSelection();
    tightenBusy = false;
    if (r.failed) log('Could not analyse ' + r.failed + ' file(s) for silence.');
    paint();
  };

  analyseBtn.addEventListener('click', analyse);
  runBtn.addEventListener('click', () => { tighten(); });
  bar.appendChild(analyseBtn);
  bar.appendChild(runBtn);
  box.appendChild(bar);

  paint();
  // Measuring is cheap after the first time (both caches answer from disk), so a panel
  // that opens on an unmeasured clip just measures it rather than making the user ask.
  if (tightenPlan().pending) analyse();
  return box;
}

/**
 * The audio effect chain for the selected audio clip.
 *
 * Rows come from `TextUI.control` and the per-type schema in AudioFX, so every parameter
 * here is a slider AND a typable box AND scroll-adjustable AND resettable without any of
 * that being written twice. Adding an effect type is an entry in AudioFX.DEFS and nothing
 * more - this panel builds itself from it.
 *
 * Structural edits (add, remove, reorder, enable) snapshot and rebuild here; parameter
 * edits go through TextUI's own once-per-gesture snapshot.
 */
function audioFxPanel(clip, viaLink) {
  const el = TextUI.el;
  const box = el('div', 'afx-box');
  if (!Array.isArray(clip.afx)) clip.afx = [];
  AudioFX.normalizeClip(clip);

  const head = el('div', 'afx-head');
  head.appendChild(el('b', null, 'Audio effects'));
  head.appendChild(el('span', 'tc-hint', clip.afx.length ? clip.afx.length + ' in chain' : 'none'));
  box.appendChild(head);

  if (viaLink) {
    // Say which clip is being edited. Silently editing something other than the clip the
    // user selected is exactly the kind of thing that gets blamed on the app later.
    box.appendChild(el('div', 'tc-hint afx-via',
      'Editing the linked audio clip on ' + viaLink + '.'));
  }

  const note = el('div', 'tc-hint afx-note',
    'Preview mirrors level and mute only. Noise reduction, EQ, de-ess, compression, ' +
    'ducking and loudness are applied on render.');
  box.appendChild(note);

  // A structural change is one undo entry and a full rebuild.
  const edit = (fn) => {
    pushUndo();
    fn();
    markDirty();
    renderAll();
  };

  // A clip's own track is not offered as a duck source: ducking to it would compress the
  // clip against its own track-mates, which buildArgs() drops for the same reason.
  const clipTrack = allClips().find((x) => x.clip === clip);
  const audioTracks = state.tracks.filter(
    (t) => t.type === 'audio' && !(clipTrack && t.id === clipTrack.track.id));

  clip.afx.forEach((fx, i) => {
    const d = AudioFX.DEFS[fx.type];
    const row = el('div', 'afx-fx' + (fx.enabled === false ? ' off' : ''));

    const bar = el('div', 'afx-fx-head');
    const on = el('input');
    on.type = 'checkbox';
    on.checked = fx.enabled !== false;
    on.title = 'Bypass this effect';
    on.addEventListener('change', () => edit(() => { fx.enabled = on.checked; }));
    bar.appendChild(on);
    bar.appendChild(el('b', null, d.label));

    const btns = el('div', 'afx-fx-btns');
    const mk = (label, title, fn, disabled) => {
      const b = el('button', 'mini', label);
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      btns.appendChild(b);
    };
    mk('▲', 'Move earlier in the chain', () => edit(() => {
      clip.afx.splice(i - 1, 0, clip.afx.splice(i, 1)[0]);
    }), i === 0);
    mk('▼', 'Move later in the chain', () => edit(() => {
      clip.afx.splice(i + 1, 0, clip.afx.splice(i, 1)[0]);
    }), i === clip.afx.length - 1);
    mk('✕', 'Remove this effect', () => edit(() => { clip.afx.splice(i, 1); }));
    bar.appendChild(btns);
    row.appendChild(bar);

    const body = el('div', 'afx-fx-body');
    if (fx.type === 'duck') {
      // The voice source is a whole track, not a clip: ducking follows the speaker for
      // the length of the music, across every cut in the voice-over.
      const sel = el('select');
      const o0 = el('option');
      o0.value = '';
      o0.textContent = 'Choose a voice track...';
      sel.appendChild(o0);
      for (const t of audioTracks) {
        const o = el('option');
        o.value = t.id;
        o.textContent = t.name;
        sel.appendChild(o);
      }
      sel.value = fx.params.voiceTrack || '';
      sel.addEventListener('change', () => edit(() => { fx.params.voiceTrack = sel.value; }));
      const r = el('div', 'tc-row');
      r.appendChild(el('label', 'tc-label', 'Voice track'));
      r.appendChild(sel);
      body.appendChild(r);
      if (!fx.params.voiceTrack) {
        body.appendChild(el('div', 'tc-hint',
          'Without a voice track this effect does nothing.'));
      }
    }
    for (const spec of d.schema) body.appendChild(TextUI.control(spec, fx, { params: d.params }));
    row.appendChild(body);
    box.appendChild(row);
  });

  const addRow = el('div', 'afx-add');
  const add = el('select');
  const a0 = el('option');
  a0.value = '';
  a0.textContent = 'Add an effect...';
  add.appendChild(a0);
  for (const type of AudioFX.TYPES) {
    const o = el('option');
    o.value = type;
    o.textContent = AudioFX.DEFS[type].label;
    add.appendChild(o);
  }
  add.addEventListener('change', () => {
    if (!add.value) return;
    const type = add.value;
    edit(() => { clip.afx.push(AudioFX.create(type)); });
  });
  addRow.appendChild(add);
  box.appendChild(addRow);

  box.appendChild(audioFxPresetBar(clip));

  // A level change should be audible immediately rather than at the next seek.
  box.addEventListener('input', () => syncMedia());
  return box;
}

/** Names of the saved audio-chain presets, refreshed from the library in the background. */
let audioPresetNames = [];

async function refreshAudioPresets(rebuild) {
  try {
    const all = await window.api.listPresets();
    audioPresetNames = (all && all.audiofx) || [];
  } catch (e) { audioPresetNames = []; }
  if (rebuild) renderInspector();
}

/**
 * Save / load / share a whole audio chain, in the same preset library as the text and
 * transition presets - one `audiofx` kind alongside `style`, `anim`, `full` and `trans`.
 *
 * A preset is the CHAIN, not the clip: applying one replaces whatever chain was there,
 * as one undo entry. A duck's voice track is not carried, because a track id means
 * nothing in another project - see AudioFX.extractPreset().
 */
function audioFxPresetBar(clip) {
  const el = TextUI.el;
  const box = el('div', 'tc-preset-box');

  const head = el('div', 'tc-preset-head');
  head.appendChild(el('b', null, 'Chain presets'));
  head.appendChild(el('span', 'tc-hint', audioPresetNames.length + ' saved'));
  box.appendChild(head);

  const sel = el('select', 'tc-preset-sel');
  const o0 = el('option');
  o0.value = '';
  o0.textContent = audioPresetNames.length ? 'Choose a saved chain...' : 'Nothing saved yet';
  sel.appendChild(o0);
  for (const n of audioPresetNames) {
    const o = el('option'); o.value = n; o.textContent = n; sel.appendChild(o);
  }
  const apply = (data, what) => {
    pushUndo();
    const applied = AudioFX.applyPreset(clip, data);
    markDirty();
    renderAll();
    const ducks = applied.filter((f) => f.type === 'duck').length;
    log('Applied audio chain "' + what + '" (' + applied.length + ' effect(s)).' +
      (ducks ? ' Choose a voice track for the ducking.' : ''));
  };
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    const data = await window.api.loadPreset('audiofx', sel.value);
    if (!data) { log('Could not read that audio preset.'); return; }
    apply(data, sel.value);
  });
  box.appendChild(sel);

  const saveRow = el('div', 'tc-preset-save');
  const nameInput = el('input', 'tc-preset-input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Save as...';
  // window.prompt does not exist in Electron, hence the inline field - see the README.
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') doSave();
  });
  const doSave = async () => {
    if (!clip.afx.length) { log('Add an effect before saving a chain preset.'); return; }
    const name = nameInput.value.trim() || ('Audio chain ' + (audioPresetNames.length + 1));
    const data = AudioFX.extractPreset(clip.afx);
    data.name = name;
    nameInput.value = '';
    await window.api.savePreset('audiofx', name, data);
    await refreshAudioPresets(true);
    log('Saved audio chain preset "' + name + '".');
  };
  const save = el('button', 'mini', 'Save');
  save.addEventListener('click', doSave);
  saveRow.appendChild(nameInput);
  saveRow.appendChild(save);
  box.appendChild(saveRow);

  const acts = el('div', 'tc-preset-acts');
  const del = el('button', 'mini', 'Delete');
  del.addEventListener('click', async () => {
    if (!sel.value) { log('Pick a saved audio preset above first.'); return; }
    await window.api.deletePreset('audiofx', sel.value);
    await refreshAudioPresets(true);
  });
  const exp = el('button', 'mini', 'Export');
  exp.addEventListener('click', async () => {
    if (!clip.afx.length) { log('Add an effect before exporting a chain.'); return; }
    const data = AudioFX.extractPreset(clip.afx);
    data.name = nameInput.value.trim() || 'Audio chain';
    await window.api.exportPreset('audiofx', data);
  });
  const imp = el('button', 'mini', 'Import');
  imp.addEventListener('click', async () => {
    const data = await window.api.importPreset('audiofx');
    if (!data) return;
    apply(data, data.name || 'imported');
  });
  acts.appendChild(del); acts.appendChild(exp); acts.appendChild(imp);
  box.appendChild(acts);
  box.appendChild(el('div', 'tc-hint',
    'A preset carries the effects, their order and every parameter - but never the voice ' +
    'track a duck points at, which only means something inside one project.'));
  return box;
}

// ======================================= 5. timeline interaction

function xToTime(clientX) {
  const area = $('#tracksArea').getBoundingClientRect();
  return Math.max(0, (clientX - area.left) / state.pxPerSec);
}

/**
 * Snap `t` to the nearest edge, reporting whether it actually landed on one.
 *
 * Candidates are 0, the playhead, the in/out marks and every clip edge on EVERY track
 * that is not part of the group being dragged - audio and video alike, so an audio clip
 * snaps to a video cut and to another audio clip just as a video clip does.
 *
 * Callers need `hit`, not just the time. A caller that compares two candidates by
 * `|snapped - raw|` alone cannot tell "snapped exactly onto an edge" from "did not snap
 * at all": a miss returns `raw`, a distance of zero, which then beats every real snap.
 * That is what made snapping look broken while dragging - the losing edge always won.
 */
function snapTime(t, movingIds) {
  return snapDetail(t, movingIds).t;
}

function snapDetail(t, movingIds) {
  if (!state.snap) return { t, hit: false, d: Infinity };
  const tol = 8 / state.pxPerSec;
  const pts = [0, state.playhead];
  if (state.inPoint != null) pts.push(state.inPoint);
  if (state.outPoint != null) pts.push(state.outPoint);
  for (const { clip } of allClips()) {
    if (movingIds && movingIds.has(clip.id)) continue;
    pts.push(clip.start, clipEnd(clip));
  }
  let best = t, bestD = tol, hit = false;
  for (const p of pts) {
    const d = Math.abs(p - t);
    if (d < bestD) { bestD = d; best = p; hit = true; }
  }
  return { t: best, hit, d: hit ? bestD : Infinity };
}

/** Every clip that must move with `clip` because of A/V linking. */
function linkGroup(clip) {
  if (!clip.linkId) return [clip];
  return allClips().filter((x) => x.clip.linkId === clip.linkId).map((x) => x.clip);
}

function setSelection(ids, additive) {
  if (ids && ids.length) state.selTransition = null;   // clips and transitions are exclusive
  if (!additive) state.selection.clear();
  for (const id of ids) state.selection.add(id);
  renderLanes();
  renderInspector();
}

$('#tracks').addEventListener('mousedown', (e) => {
  const trEl = e.target.closest('.transition');
  if (trEl) {
    const r = findTransition(trEl.dataset.transId);
    if (r) {
      setSelection([], false);
      state.selTransition = r.tr.id;
      renderAll();
      const handle = e.target.closest('.thandle');
      if (handle) startTransitionResize(e, r);
    }
    return;
  }

  const clipEl = e.target.closest('.clip');
  if (!clipEl) {
    // Ctrl+drag is the playhead scrub, which #tracksArea handles; everything else on
    // empty timeline is a selection box.
    if (!e.ctrlKey && !e.metaKey) startMarquee(e, e.shiftKey);
    return;
  }
  const found = findClip(clipEl.dataset.clipId);
  if (!found || found.track.locked) return;
  const c = found.clip;

  if (!state.selection.has(c.id)) {
    const group = linkGroup(c).map((x) => x.id);
    setSelection(group, e.shiftKey);
  } else if (e.shiftKey) {
    state.selection.delete(c.id);
    renderLanes(); renderInspector();
    return;
  }

  const handle = e.target.closest('.handle');
  if (handle) startTrim(e, c, handle.classList.contains('l') ? 'in' : 'out');
  else startMove(e, c);
});

/**
 * Window (marquee) selection: drag a box over empty timeline to select what it touches.
 *
 * It starts on a mousedown that hits no clip and no transition. A press that never moves
 * is still a click, and a click on empty timeline still clears the selection - the 3px
 * threshold is what keeps both behaviours out of each other's way.
 *
 * A clip is caught if the box overlaps it at all, in BOTH time and track: overlap rather
 * than containment, because a box drawn across the middle of a long clip is obviously
 * meant to include it. Locked tracks are skipped, exactly as a click on one is ignored.
 *
 * Whatever is caught is then extended to full link groups, so a box drawn over the audio
 * lane alone still takes the picture with it. Selecting half of an A/V pair and then
 * dragging it is how sync gets broken, and clicking already behaves this way.
 */
function startMarquee(e, additive) {
  const area = $('#tracksArea');
  const areaRect = area.getBoundingClientRect();
  const tracksRect = $('#tracks').getBoundingClientRect();
  const x0 = e.clientX, y0 = e.clientY;

  const box = document.createElement('div');
  box.id = 'marquee';
  box.hidden = true;
  area.appendChild(box);

  const base = additive ? new Set(state.selection) : new Set();
  let live = false;

  const paint = (ev) => {
    const l = Math.min(x0, ev.clientX), r = Math.max(x0, ev.clientX);
    const t = Math.min(y0, ev.clientY), b = Math.max(y0, ev.clientY);
    box.hidden = false;
    box.style.left = (l - areaRect.left) + 'px';
    box.style.top = (t - areaRect.top) + 'px';
    box.style.width = (r - l) + 'px';
    box.style.height = (b - t) + 'px';
    return { l, r, t, b };
  };

  const hits = (r) => {
    const t0 = Math.max(0, (r.l - tracksRect.left) / state.pxPerSec);
    const t1 = Math.max(0, (r.r - tracksRect.left) / state.pxPerSec);
    const i0 = Math.floor((r.t - tracksRect.top) / TRACK_H);
    const i1 = Math.floor((r.b - tracksRect.top) / TRACK_H);
    const out = [];
    state.tracks.forEach((track, i) => {
      if (track.locked || i < i0 || i > i1) return;
      for (const c of track.clips) {
        if (c.start < t1 && clipEnd(c) > t0) out.push(c);
      }
    });
    return out;
  };

  const onMove = (ev) => {
    if (!live && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
    live = true;
    const ids = new Set(base);
    for (const c of hits(paint(ev))) for (const m of linkGroup(c)) ids.add(m.id);
    state.selection = ids;
    state.selTransition = null;
    renderLanes();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    box.remove();
    // A press that never became a drag is a plain click on empty timeline.
    if (!live && !additive) setSelection([], false);
    else renderInspector();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/**
 * Close the gaps between the selected clips.
 *
 * Local, not a ripple: nothing outside the selection moves. The selection is taken as
 * LINK GROUPS ordered by start, the earliest stays put, and each later group slides left
 * until it butts against the end of everything before it. Moving whole groups is what
 * keeps a pair's picture and sound together - shifting the two halves independently is
 * the same sync bug in a different coat.
 *
 * Groups that already overlap are left where they are: there is no gap between them to
 * close, and pulling one further left would only bury it deeper under the other.
 */
function closeGaps() {
  const seen = new Set();
  const units = [];
  for (const { clip } of selectedClips()) {
    const key = clip.linkId || clip.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const clips = linkGroup(clip).filter((c) => {
      const row = allClips().find((x) => x.clip === c);
      return row && !row.track.locked;
    });
    if (!clips.length) continue;
    units.push({
      clips,
      start: Math.min(...clips.map((c) => c.start)),
      end: Math.max(...clips.map((c) => clipEnd(c))),
    });
  }
  if (units.length < 2) { log('Select at least two clips to close the gaps between them.'); return null; }

  units.sort((a, b) => a.start - b.start);
  let cursor = units[0].end;
  let moved = 0, closed = 0;
  for (let i = 1; i < units.length; i++) {
    const u = units[i];
    const shift = u.start - cursor;
    if (shift > 1e-6) {
      if (!moved) pushUndo();               // snapshot once, and only if something moves
      for (const c of u.clips) c.start -= shift;
      moved++;
      closed += shift;
    }
    cursor = Math.max(cursor, u.end - Math.max(0, shift));
  }
  if (!moved) { log('No gaps between the selected clips.'); return null; }

  sortTracks();
  markDirty();
  renderAll();
  log('Closed ' + moved + ' gap(s), ' + closed.toFixed(2) + 's.');
  return { moved, closed };
}

function startMove(e, anchor) {
  pushUndo();
  const startX = e.clientX, startY = e.clientY;
  const moving = [];
  const ids = new Set();
  for (const { clip, track } of selectedClips()) {
    if (track.locked) continue;
    for (const c of linkGroup(clip)) if (!ids.has(c.id)) { ids.add(c.id); }
  }
  for (const id of ids) {
    const f = findClip(id);
    if (f) moving.push({ clip: f.clip, track: f.track, start0: f.clip.start, trackIdx0: state.tracks.indexOf(f.track) });
  }
  let moved = false;

  const onMove = (ev) => {
    moved = true;
    const dt = (ev.clientX - startX) / state.pxPerSec;
    const dRow = Math.round((ev.clientY - startY) / TRACK_H);

    // Keep the whole group together: clamp by the earliest clip, snap using the anchor.
    const minStart = Math.min(...moving.map((m) => m.start0));
    let delta = Math.max(dt, -minStart);
    const anchorMove = moving.find((m) => m.clip === anchor) || moving[0];
    if (anchorMove) {
      const raw = anchorMove.start0 + delta;
      const len = anchor.out - anchor.in;
      // Try both edges of the dragged clip and take whichever actually caught an edge,
      // nearest first. Comparing them by distance alone would let a MISS (which returns
      // the raw time, distance zero) beat a real snap and cancel it out.
      const head = snapDetail(raw, ids);
      const tail = snapDetail(raw + len, ids);
      let pick = raw;
      if (head.hit && (!tail.hit || head.d <= tail.d)) pick = head.t;
      else if (tail.hit) pick = tail.t - len;
      delta = Math.max(pick - anchorMove.start0, -minStart);
    }
    for (const m of moving) {
      m.clip.start = Math.max(0, m.start0 + delta);
      if (dRow !== 0 && !ev.altKey) {
        const target = state.tracks[clamp(m.trackIdx0 + dRow, 0, state.tracks.length - 1)];
        const wantType = m.clip.kind === 'audio' ? 'audio' : 'video';
        if (target && target !== findClip(m.clip.id).track && target.type === wantType && !target.locked) {
          const from = findClip(m.clip.id).track;
          from.clips = from.clips.filter((c) => c !== m.clip);
          target.clips.push(m.clip);
        }
      }
    }
    sortTracks();
    renderLanes();
    renderRuler();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) undoStack.pop(); else { markDirty(); renderAll(); }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/**
 * Drag either end of a transition to change how long it is.
 *
 * Both ends move together around the cut for a centred transition, so grabbing either
 * side feels the same; the length is capped so it cannot run past either clip.
 */
function startTransitionResize(e, r) {
  e.preventDefault();
  e.stopPropagation();
  pushUndo();
  const startX = e.clientX;
  const d0 = r.tr.duration;
  const max = maxTransitionDuration(r.a, r.b);
  const grow = e.target.closest('.thandle').classList.contains('l') ? -1 : 1;
  const factor = r.tr.align === 'center' ? 2 : 1;   // a centred edge moves half the length
  let moved = false;

  const onMove = (ev) => {
    moved = true;
    const dt = (ev.clientX - startX) / state.pxPerSec;
    r.tr.duration = clamp(d0 + grow * dt * factor, 0.04, max);
    renderLanes();
    renderTransitionPanel();
    drawPreview();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) undoStack.pop(); else { markDirty(); renderAll(); }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startTrim(e, anchor, edge) {
  pushUndo();
  const startX = e.clientX;
  const group = linkGroup(anchor);
  const snaps = new Set(group.map((c) => c.id));
  const orig = group.map((c) => ({ c, start: c.start, in: c.in, out: c.out }));
  let moved = false;

  const onMove = (ev) => {
    moved = true;
    const dt = (ev.clientX - startX) / state.pxPerSec;
    for (const o of orig) {
      if (edge === 'in') {
        const rawStart = snapTime(o.start + dt, snaps);
        const d = clamp(rawStart - o.start, -o.in, (o.out - o.in) - 0.05);
        o.c.in = o.in + d;
        o.c.start = Math.max(0, o.start + d);
      } else {
        const rawEnd = snapTime(o.start + (o.out - o.in) + dt, snaps);
        const d = clamp(rawEnd - (o.start + (o.out - o.in)), -((o.out - o.in) - 0.05), o.c.mediaDuration - o.out);
        o.c.out = o.out + d;
      }
    }
    renderLanes(); renderRuler(); renderPlayhead();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) undoStack.pop(); else { markDirty(); renderAll(); }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Scrubbing: ruler drag, and ctrl-drag anywhere in the tracks area.
function scrubFrom(e) {
  const set = (ev) => { seek(xToTime(ev.clientX)); };
  set(e);
  const onUp = () => {
    document.removeEventListener('mousemove', set);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', set);
  document.addEventListener('mouseup', onUp);
}
// Double-clicking near a cut is the other "fast grab": no menu, no dialog.
$('#tracks').addEventListener('dblclick', (e) => {
  if (e.target.closest('.transition')) return;
  const lane = e.target.closest('.track-lane');
  if (!lane) return;
  const track = state.tracks[Number(lane.dataset.trackIndex)];
  if (!track || track.type !== 'video' || track.locked) return;
  const t = xToTime(e.clientX);
  const cuts = trackCuts(track);
  let best = null, bestD = 12 / state.pxPerSec;   // within ~12px of the cut
  for (const c of cuts) {
    const d = Math.abs(c.cut - t);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best) addTransition(state.lastTransitionType || 'swipe', best);
});

$('#ruler').addEventListener('mousedown', scrubFrom);
$('#tracksArea').addEventListener('mousedown', (e) => { if (e.ctrlKey) scrubFrom(e); });

$('#tracksScroll').addEventListener('scroll', () => {
  $('#rulerScroll').scrollLeft = $('#tracksScroll').scrollLeft;
});
$('#tracksScroll').addEventListener('wheel', (e) => {
  if (e.ctrlKey) { e.preventDefault(); zoomTimeline(e.deltaY < 0 ? 1.2 : 1 / 1.2); }
}, { passive: false });

function zoomTimeline(f) {
  state.pxPerSec = clamp(state.pxPerSec * f, 2, 600);
  renderLanes(); renderRuler(); renderPlayhead();
}
function zoomFit() {
  const w = $('#tracksScroll').clientWidth - 150 - 24; // minus track heads and scrollbar
  const d = (projectDuration() || 10) * 1.15;
  state.pxPerSec = clamp(w / d, 2, 600);
  renderLanes(); renderRuler(); renderPlayhead();
}

// ================================= 6. preview + playback

const canvas = $('#preview');
const ctx = canvas.getContext('2d');

/**
 * The size the viewer actually draws at.
 *
 * Everything in the preview - compositing, text, motion blur - costs time per pixel, and
 * so does baking and encoding a preview render. Working at half or quarter resolution cuts
 * that by 4x or 16x. The aspect is preserved, so framing and text placement are identical;
 * only the pixel count changes. Dimensions stay even for yuv420p.
 */
function previewSize() {
  const s = state.previewScale || 1;
  const w = Math.max(2, Math.round(state.out.w * s / 2) * 2);
  const h = Math.max(2, Math.round(state.out.h * s / 2) * 2);
  return { w, h };
}

function resizeCanvas() {
  const p = previewSize();
  canvas.width = p.w;
  canvas.height = p.h;
  frameCacheValid = false;
  $('#aspectBadge').textContent = state.out.w > state.out.h ? '16:9' : '9:16';
}

/** Clips under the playhead, topmost visible video first. */
function activeVideoClip() {
  const eps = 1e-6;
  for (const t of state.tracks) {
    if (t.type !== 'video' || t.hidden) continue;
    for (const c of t.clips) {
      if (c.kind !== 'video') continue;
      if (state.playhead >= c.start - eps && state.playhead < clipEnd(c) - eps) return c;
    }
  }
  // Sitting exactly on the end of the timeline: hold the final frame rather than go black.
  const dur = projectDuration();
  if (dur > 0 && state.playhead >= dur - eps) {
    for (const t of state.tracks) {
      if (t.type !== 'video' || t.hidden) continue;
      for (const c of t.clips) if (c.kind === 'video' && Math.abs(clipEnd(c) - dur) < 0.001) return c;
    }
  }
  return null;
}

/**
 * Draw one clip into the output frame using its pan/zoom framing.
 * Mirrors the ffmpeg crop in main.js so the preview matches the render.
 */
/** Framed draw at an explicit size, for baking at the job's resolution. */
function drawClipTo(c, el, target, W, H) {
  const sw = el.videoWidth || c.srcW, sh = el.videoHeight || c.srcH;
  if (!sw || !sh) return;
  const outAspect = state.out.w / state.out.h;
  const cw = Math.min(sw, sh * outAspect) / c.zoom;
  const ch = Math.min(sh, sw / outAspect) / c.zoom;
  target.drawImage(el, (sw - cw) * c.panX, (sh - ch) * c.panY, cw, ch, 0, 0, W, H);
}

function drawClip(c, el, target) {
  const sw = el.videoWidth || c.srcW, sh = el.videoHeight || c.srcH;
  if (!sw || !sh) return;
  // Aspect comes from the OUTPUT, not the preview canvas: the crop must match the render.
  const outAspect = state.out.w / state.out.h;
  let cw = Math.min(sw, sh * outAspect) / c.zoom;
  let ch = Math.min(sh, sw / outAspect) / c.zoom;
  const cx = (sw - cw) * c.panX;
  const cy = (sh - ch) * c.panY;
  const P = previewSize();
  (target || ctx).drawImage(el, cx, cy, cw, ch, 0, 0, P.w, P.h);
}

// ---------------------------------------------------------- rendered spans

/**
 * One <video> per rendered span, playing the file the render cache holds.
 *
 * This is the point of rendering a preview: inside a rendered span the viewer decodes a
 * finished MP4 instead of re-compositing every clip, crop, text card and motion blur for
 * each frame. It also means the span's audio is the real mix, already in sync.
 */
const previewEls = new Map();   // band key -> HTMLVideoElement

function previewElFor(band) {
  let el = previewEls.get(band.key);
  if (el) return el;
  el = document.createElement('video');
  el.src = 'file:///' + String(band.file).replace(/\\/g, '/').replace(/^\/+/, '');
  el.preload = 'auto';
  el.load();
  previewEls.set(band.key, el);
  return el;
}

function dropPreviewEl(key) {
  const el = previewEls.get(key);
  if (el) { try { el.pause(); } catch (e) {} el.removeAttribute('src'); el.load(); }
  dropPreviewBandNode(key);
  previewEls.delete(key);
}

/** Forget any player whose span is no longer valid (its content changed). */
function prunePreviewEls() {
  const live = new Set(state.cacheBands.map((b) => b.key));
  for (const key of [...previewEls.keys()]) if (!live.has(key)) dropPreviewEl(key);
}

/** The rendered span under the playhead, if the viewer is set to use them. */
function activePreviewBand() {
  if (!state.usePreviewRender) return null;
  for (const b of state.cacheBands) {
    if (!b.file) continue;
    if (state.playhead >= b.from && state.playhead < b.to) return b;
  }
  return null;
}

/**
 * Keep the rendered span's player in step with the playhead, and silence everything else
 * while it is on screen - otherwise the source clips' audio would play on top of the
 * mix that is already inside the rendered file.
 */
function syncPreviewBand(band) {
  for (const [key, el] of previewEls) {
    if (!band || key !== band.key) { if (!el.paused) el.pause(); }
  }
  if (!band) return null;
  const el = previewElFor(band);
  const target = state.playhead - band.from;
  el.muted = false;
  // The audio context only exists once something has played; until then the element's own
  // volume carries the sound, exactly as a clip's does before its gain node is attached.
  if (previewMix.ctx) {
    const node = previewBandNode(band.key, el);
    if (node) { node.gain.gain.value = 1; el.volume = 1; }
  }
  if (state.playing) {
    if (!el.seeking && Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (!el.seeking && Math.abs(el.currentTime - target) > 0.06) el.currentTime = target;
  }
  return el;
}

/**
 * Last successfully decoded video frame, already cropped to the output size.
 *
 * Text has to be composited over the video every frame, which means clearing the canvas
 * every frame - but a video element that is mid-seek has no frame to redraw, and clearing
 * to black was the old flicker bug. Caching the last good frame lets us always clear and
 * still have something to draw underneath the text.
 */
let frameCache = null;
let frameCacheValid = false;

function videoFrameCache() {
  const p = previewSize();
  if (!frameCache) frameCache = document.createElement('canvas');
  if (frameCache.width !== p.w || frameCache.height !== p.h) {
    frameCache.width = p.w;
    frameCache.height = p.h;
    frameCacheValid = false;
  }
  return frameCache;
}

function drawPreview() {
  const P = previewSize();

  // Inside a rendered span the finished frame IS the answer - no compositing to do.
  const band = activePreviewBand();
  if (band) {
    const pel = previewEls.get(band.key) || previewElFor(band);
    if (pel.readyState >= 2 && pel.videoWidth) {
      // Scaled to the canvas, so a span rendered at a different preview scale still shows.
      ctx.drawImage(pel, 0, 0, P.w, P.h);
      frameCacheValid = false;   // the composited cache is stale while the render is up
      return;
    }
    // Still decoding: fall through and composite this frame live rather than flash black.
  }

  // A transition owns the frame for its whole window: it needs BOTH clips, so the
  // normal single-clip path cannot express it.
  const trans = transitionAt();
  if (trans) {
    if (drawTransitionFrame(trans, P)) {
      const overText = activeTextClips();
      if (overText.length) drawTextLayer(overText);
      return;
    }
    // Frames not ready yet - fall through and show the plain clip rather than black.
  }

  const c = activeVideoClip();
  const texts = activeTextClips();
  const cache = videoFrameCache();

  if (c) {
    const el = mediaFor(c);
    if (el.readyState >= 2 && el.videoWidth) {
      const cctx = cache.getContext('2d');
      cctx.fillStyle = '#000';
      cctx.fillRect(0, 0, P.w, P.h);
      drawClip(c, el, cctx);
      frameCacheValid = true;
    }
  } else {
    frameCacheValid = false; // a real gap shows black, not the previous clip
  }

  // Without text there is nothing to composite, so keep the old cheap path: repaint only
  // when a frame exists, and otherwise leave the canvas alone.
  if (!texts.length) {
    if (frameCacheValid) ctx.drawImage(cache, 0, 0);
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, P.w, P.h); }
    return;
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, P.w, P.h);
  if (frameCacheValid) ctx.drawImage(cache, 0, 0);
  drawTextLayer(texts);
}

/**
 * Render one clip's framed frame into a scratch canvas, or null if it is not decodable.
 * `atTime` is a time on the timeline; the clip is sampled there even if that is outside
 * its trimmed range, which is exactly what a transition needs (it reaches into the
 * handles either side of the cut).
 */
function clipFrameAt(clip, atTime, name, P) {
  const el = mediaFor(clip);
  if (!el || el.readyState < 2 || !el.videoWidth) return null;
  const cv = transSurface(name, P.w, P.h);
  const c2 = cv.getContext('2d');
  c2.fillStyle = '#000';
  c2.fillRect(0, 0, P.w, P.h);
  drawClip(clip, el, c2);
  heldFrames[name] = clip.id;
  return cv;
}

/**
 * Which clip the `transA`/`transB` scratch surfaces are still holding a picture of.
 *
 * A <video> that is mid-seek has no frame to hand over, and inside a transition BOTH
 * elements are being seeked every frame - so `clipFrameAt` returning null is normal, not
 * exceptional. The surface it draws into still holds the last good frame of that clip, so
 * as long as it belongs to the clip we are asking about it is far better than nothing:
 * one stale frame is invisible at these durations, a black one is the flicker the user
 * sees at each end of the window.
 */
const heldFrames = {};
function clipFrameOrHeld(clip, atTime, name, P) {
  const fresh = clipFrameAt(clip, atTime, name, P);
  if (fresh) return fresh;
  return heldFrames[name] === clip.id ? transSurface(name, P.w, P.h) : null;
}

const transSurfaces = {};
function transSurface(name, w, h) {
  let c = transSurfaces[name];
  if (!c) c = transSurfaces[name] = document.createElement('canvas');
  // Resizing a canvas clears it, so whatever frame it was holding is gone with it -
  // switching preview scale mid-transition must not hand back an empty surface.
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; heldFrames[name] = null; }
  return c;
}

/** Where in each clip's source a transition samples at timeline time `t`. */
function transitionSourceTimes(r, t) {
  return {
    a: clamp(r.a.in + (t - r.a.start), 0, Math.max(0, r.a.mediaDuration - 0.03)),
    b: clamp(r.b.in + (t - r.b.start), 0, Math.max(0, r.b.mediaDuration - 0.03)),
  };
}

/** Paint the transition covering the playhead. Returns false if frames are not ready. */
function drawTransitionFrame(r, P) {
  const aImg = clipFrameOrHeld(r.a, state.playhead, 'transA', P);
  const bImg = clipFrameOrHeld(r.b, state.playhead, 'transB', P);
  if (!aImg && !bImg) return false;
  const p = (state.playhead - r.from) / Math.max(0.001, r.dur);
  // Composited into the frame cache rather than straight onto the canvas: the moment the
  // playhead leaves the window the incoming clip's element is usually still catching up,
  // and without a valid cache to fall back on the viewer went black until it did.
  const cache = videoFrameCache();
  const cctx = cache.getContext('2d');
  cctx.fillStyle = '#000';
  cctx.fillRect(0, 0, P.w, P.h);
  Trans.draw(cctx, P.w, P.h, r.tr, p, aImg, bImg, 1 / state.out.fps);
  ctx.drawImage(cache, 0, 0);
  frameCacheValid = true;
  return true;
}

/** Paint the active text cards over the current video frame. */
function drawTextLayer(texts) {
  if (!texts || !texts.length) return;
  const P = previewSize();
  const frameDur = 1 / state.out.fps;
  // TextDraw scales its sizes off the frame height, so a smaller canvas simply gives a
  // proportionally smaller card - the layout is identical, there is just less to paint.
  for (const tc of texts) {
    TextDraw.draw(ctx, tc, P.w, P.h, state.playhead - tc.start, frameDur);
  }
}

/** How far ahead of the playhead to start decoding clips, in seconds. */
const PRELOAD_AHEAD = 8;
/** Release a clip's decoder once the playhead is this far away (hysteresis vs. preload). */
const EVICT_BEYOND = 60;

/**
 * The clips a transition needs decoded right now, with the source time each should be
 * parked at. Both sides have to be live at once, and both may be outside their trimmed
 * range - the transition reaches into the handles either side of the cut.
 */
function transitionMediaTargets() {
  const r = transitionAt();
  if (!r) return null;
  const st = transitionSourceTimes(r, state.playhead);
  return [{ clip: r.a, t: st.a }, { clip: r.b, t: st.b }];
}

/** Keep every clip's media element in sync with the playhead. */
function syncMedia() {
  // A rendered span carries its own picture and audio, so the source clips must be
  // silent and idle underneath it.
  const band = activePreviewBand();
  syncPreviewBand(band);
  if (band) {
    for (const el of mediaEls.values()) { if (!el.paused) el.pause(); }
    return;
  }

  // A transition parks its two clips itself; they are outside their normal ranges.
  const transTargets = transitionMediaTargets();
  const transIds = new Set((transTargets || []).map((x) => x.clip.id));
  if (transTargets) {
    for (const { clip, t } of transTargets) {
      const m = mediaFor(clip);
      m.muted = true;             // audio during a transition comes from the audio track
      if (state.playing) {
        // Both clips simply RUN through the window - their source times advance at 1x
        // exactly as the playhead does, so playback keeps them aligned for free. Pausing
        // and re-seeking them every frame (what this used to do) left both elements
        // permanently mid-seek: no frame to draw during the transition, and none for the
        // incoming clip once it was over either, which is what turned the viewer black.
        if (!m.seeking && Math.abs(m.currentTime - t) > 0.25) m.currentTime = t;
        if (m.paused) m.play().catch(() => {});
      } else {
        if (!m.paused) m.pause();
        if (!m.seeking && Math.abs(m.currentTime - t) > 0.04) m.currentTime = t;
      }
    }
  }

  for (const { clip, track } of allClips()) {
    if (clip.kind === 'text') continue; // drawn from canvas, nothing to decode
    if (transIds.has(clip.id)) continue;
    const active = state.playhead >= clip.start && state.playhead < clipEnd(clip);
    const el = mediaEls.get(clip.id);

    if (!active) {
      if (el && !el.paused) el.pause();
      // Warm up clips we are about to reach. Creating the element only once the playhead
      // arrives meant every cut started on an empty, still-loading video element.
      if (!el && clip.start > state.playhead && clip.start - state.playhead < PRELOAD_AHEAD) {
        const warm = mediaFor(clip);
        const seed = () => { try { warm.currentTime = clip.in; } catch (e) {} };
        if (warm.readyState >= 1) seed();
        else warm.addEventListener('loadedmetadata', seed, { once: true });
      } else if (el) {
        // Long timelines would otherwise end up holding a decoder open for every clip.
        const dist = Math.max(clip.start - state.playhead, state.playhead - clipEnd(clip));
        if (dist > EVICT_BEYOND) dropMedia(clip.id);
      }
      continue;
    }

    const target = clip.in + (state.playhead - clip.start);
    const m = mediaFor(clip);
    if (clip.kind === 'audio') applyPreviewMix(clip, m, track.muted);
    // Never stack a seek on top of one still in flight - that kept readyState pinned low.
    if (state.playing) {
      if (!m.seeking && Math.abs(m.currentTime - target) > 0.3) m.currentTime = target;
      if (m.paused) m.play().catch(() => {});
    } else {
      if (!m.paused) m.pause();
      if (!m.seeking && Math.abs(m.currentTime - target) > 0.06) m.currentTime = target;
    }
  }
}

let playT0 = 0, playHead0 = 0;

function play() {
  if (state.playing) return;
  // Pressing play is the user gesture the audio context is waiting for.
  ensureAudioCtx();
  if (state.playhead >= projectDuration() - 0.01) state.playhead = 0;
  state.playing = true;
  playT0 = performance.now();
  playHead0 = state.playhead;
  $('#btnPlay').textContent = '⏸';
}
function pause() {
  state.playing = false;
  $('#btnPlay').textContent = '▶';
  for (const el of mediaEls.values()) { if (!el.paused) el.pause(); }
  // A rendered span plays from its own element, and syncMedia() - which would stop it -
  // only runs while playing. Without this, stop left the render running with no way to
  // halt it.
  for (const el of previewEls.values()) { if (!el.paused) el.pause(); }
}
function togglePlay() { state.playing ? pause() : play(); }

function seek(t) {
  state.playhead = clamp(t, 0, Math.max(0, projectDuration()));
  if (state.playing) { playT0 = performance.now(); playHead0 = state.playhead; }
  renderPlayhead();
  syncMedia();
  drawPreview();
  scrollPlayheadIntoView();
}

function scrollPlayheadIntoView() {
  const sc = $('#tracksScroll');
  const x = state.playhead * state.pxPerSec;
  const headW = 150;
  if (x < sc.scrollLeft + 40) sc.scrollLeft = Math.max(0, x - 40);
  else if (x > sc.scrollLeft + sc.clientWidth - headW - 40) sc.scrollLeft = x - sc.clientWidth + headW + 40;
}

let lastLoopError = null;

/**
 * The frame loop.
 *
 * The animation frame is re-armed in a `finally`, and that placement is load-bearing: it
 * used to be re-armed only after drawPreview() returned, so ONE throw anywhere in the
 * draw path stopped the loop for good - the playhead froze, the viewer stopped repainting
 * and nothing on screen said why. A bad frame has to cost a frame, not the session.
 */
function loop() {
  try {
    if (state.playing) {
      const t = playHead0 + (performance.now() - playT0) / 1000;
      if (t >= projectDuration()) { state.playhead = projectDuration(); pause(); }
      else state.playhead = t;
      renderPlayhead();
      syncMedia();
      scrollPlayheadIntoView();
    }
    drawPreview();
    drawMeter();
  } catch (e) {
    // Reported once per distinct fault, so a persistent one does not flood the log at
    // 60fps but a new one is never swallowed.
    const msg = (e && e.message) ? e.message : String(e);
    if (msg !== lastLoopError) {
      lastLoopError = msg;
      console.error('frame failed:', e);
      log('Preview error (the editor is still running): ' + msg);
    }
  } finally {
    requestAnimationFrame(loop);
  }
}
requestAnimationFrame(loop);

// Drag on the preview to reposition the crop frame.
let framingDrag = null;
canvas.addEventListener('mousedown', (e) => {
  const c = activeVideoClip();
  if (!c) return;
  canvas.classList.add('dragging');
  framingDrag = { c, x: e.clientX, y: e.clientY, panX: c.panX, panY: c.panY };
  pushUndo();
});
document.addEventListener('mousemove', (e) => {
  if (!framingDrag) return;
  const rect = canvas.getBoundingClientRect();
  const c = framingDrag.c;
  // Full pan range across roughly one canvas width of mouse travel.
  c.panX = clamp(framingDrag.panX - (e.clientX - framingDrag.x) / rect.width, 0, 1);
  c.panY = clamp(framingDrag.panY - (e.clientY - framingDrag.y) / rect.height, 0, 1);
  syncFramingControls();
});
document.addEventListener('mouseup', () => {
  if (framingDrag) { framingDrag = null; canvas.classList.remove('dragging'); markDirty(); }
  canvas.classList.remove('dragging');
});

function framingTarget() {
  const sel = selectedClips().map((x) => x.clip).filter((c) => c.kind === 'video');
  if (sel.length) return sel;
  const a = activeVideoClip();
  return a ? [a] : [];
}

const FRAMING_DEFAULTS = { panX: 0.5, panY: 0.5, zoom: 1 };

function syncFramingControls() {
  const t = framingTarget()[0];
  const on = !!t;
  ['panX', 'panY', 'zoom'].forEach((k) => {
    $('#' + k).disabled = !on;
    $('#' + k + 'v').disabled = !on;
  });
  if (!on) return;
  // Don't fight the user while they are mid-edit in a number box.
  const skip = document.activeElement && document.activeElement.classList.contains('tc-num')
    ? document.activeElement.id : null;
  for (const k of ['panX', 'panY', 'zoom']) {
    $('#' + k).value = t[k];
    if (skip !== k + 'v') $('#' + k + 'v').value = Number(t[k]).toFixed(3);
  }
}

function setFraming(prop, value) {
  const targets = framingTarget();
  if (!targets.length) return;
  for (const c of targets) c[prop] = value;
  markDirty();
  syncFramingControls();
}
// Sliders and their number boxes drive the same property; every framing value is typable.
['panX', 'panY', 'zoom'].forEach((k) => {
  const range = $('#' + k);
  const num = $('#' + k + 'v');
  range.addEventListener('pointerdown', () => pushUndo());
  range.addEventListener('input', () => setFraming(k, parseFloat(range.value)));
  num.addEventListener('focus', () => pushUndo());
  num.addEventListener('keydown', (e) => e.stopPropagation());
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (isFinite(v)) setFraming(k, v);
  });
});
// Scroll over any framing control to nudge it, same as the text panel.
['panX', 'panY', 'zoom'].forEach((k) => {
  const opts = {
    step: k === 'zoom' ? 0.01 : 0.005,
    min: k === 'zoom' ? 1 : 0,
    max: k === 'zoom' ? 8 : 1,
    get: () => {
      const t = framingTarget()[0];
      return t ? t[k] : 0;
    },
    set: (v) => setFraming(k, v),
  };
  TextUI.attachWheel($('#' + k), opts);
  TextUI.attachWheel($('#' + k + 'v'), opts);
});

document.querySelectorAll('#framing .tc-reset').forEach((b) => {
  b.addEventListener('click', () => {
    const k = b.dataset.reset;
    pushUndo();
    setFraming(k, FRAMING_DEFAULTS[k]);
  });
});
$('#btnFrameLeft').addEventListener('click', () => { pushUndo(); setFraming('panX', 0); });
$('#btnFrameCenter').addEventListener('click', () => { pushUndo(); setFraming('panX', 0.5); });
$('#btnFrameRight').addEventListener('click', () => { pushUndo(); setFraming('panX', 1); });
$('#btnResetFrame').addEventListener('click', () => {
  pushUndo();
  for (const c of framingTarget()) { c.panX = 0.5; c.panY = 0.5; c.zoom = 1; }
  markDirty(); syncFramingControls();
});
$('#btnFrameAll').addEventListener('click', () => {
  const src = framingTarget()[0];
  if (!src) return;
  pushUndo();
  for (const { clip } of allClips()) {
    if (clip.kind !== 'video') continue;
    clip.panX = src.panX; clip.panY = src.panY; clip.zoom = src.zoom;
  }
  markDirty();
  log('Framing applied to all video clips.');
});

// ============================== 7. editing operations

function pushUndo() {
  undoStack.push(JSON.stringify({ tracks: state.tracks, selection: [...state.selection] }));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
function restore(snapshot) {
  const s = JSON.parse(snapshot);
  state.tracks = s.tracks;
  state.selection = new Set(s.selection);
  renderAll();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify({ tracks: state.tracks, selection: [...state.selection] }));
  restore(undoStack.pop());
  markDirty();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify({ tracks: state.tracks, selection: [...state.selection] }));
  restore(redoStack.pop());
  markDirty();
}

/** Split every clip under the playhead (or just the selected ones, if any). */
function splitAtPlayhead() {
  const t = state.playhead;
  const sel = state.selection.size ? selectedClips().map((x) => x.clip) : null;
  let did = false;
  pushUndo();
  for (const track of state.tracks) {
    if (track.locked) continue;
    for (const c of [...track.clips]) {
      if (t <= c.start + 0.02 || t >= clipEnd(c) - 0.02) continue;
      if (sel && !sel.includes(c)) continue;
      const offset = t - c.start;
      const right = Object.assign({}, c, {
        id: nextId(),
        start: t,
        in: c.in + offset,
        linkId: c.linkId ? c.linkId + '_r' + Math.random().toString(36).slice(2, 5) : null,
      });
      c.out = c.in + offset;
      track.clips.push(right);
      did = true;
    }
  }
  // Re-pair the halves that were linked before the cut.
  if (did) {
    relinkAfterSplit(t);
    sortTracks();
    markDirty();
    renderAll();
    log('Split at ' + fmtTc(t));
  } else undoStack.pop();
}

/** After a split, right-hand halves that came from the same original pair share a link id again. */
function relinkAfterSplit(t) {
  const rights = allClips().map((x) => x.clip).filter((c) => c.linkId && c.linkId.includes('_r') && Math.abs(c.start - t) < 0.001);
  const byBase = new Map();
  for (const c of rights) {
    const base = c.linkId.split('_r')[0];
    if (!byBase.has(base)) byBase.set(base, nextId());
    c.linkId = byBase.get(base);
  }
}

function deleteSelected(ripple) {
  const sel = selectedClips();
  if (!sel.length) return;
  pushUndo();
  const ids = new Set();
  for (const { clip } of sel) for (const c of linkGroup(clip)) ids.add(c.id);
  let gapStart = Infinity, gapEnd = 0;
  for (const track of state.tracks) {
    if (track.locked) continue;
    for (const c of track.clips) {
      if (ids.has(c.id)) { gapStart = Math.min(gapStart, c.start); gapEnd = Math.max(gapEnd, clipEnd(c)); }
    }
    track.clips = track.clips.filter((c) => !ids.has(c.id));
  }
  for (const id of ids) dropMedia(id);
  if (ripple && isFinite(gapStart)) {
    const amount = gapEnd - gapStart;
    for (const track of state.tracks) {
      if (track.locked) continue;
      for (const c of track.clips) if (c.start >= gapEnd - 0.001) c.start -= amount;
    }
  }
  state.selection.clear();
  markDirty();
  renderAll();
}

// ------------------------------------------------------------------ Tighten
//
// Silence removal. The detection is the easy half - ffmpeg's `silencedetect` does it in
// the main process and the spans are cached per file. The half that matters is rippling
// the cut through a link group without breaking A/V sync, and doing the whole pass as ONE
// undo entry however many spans it removes.
//
// Three time bases meet here, and mixing them up is the bug this code exists to avoid:
//   * SOURCE time   - what silencedetect reports, and what `clip.in`/`clip.out` are in.
//   * CLIP time     - source time minus `clip.in`.
//   * TIMELINE time - clip time plus `clip.start`. Everything removed is expressed here.

const TIGHTEN_DEFAULTS = { threshold: 0.35, pad: 0.05, noise: -30 };

/** The smallest span worth cutting once the pad has eaten into it. */
const TIGHTEN_MIN_CUT = 0.02;

/** Raw silence spans per source file, keyed `src|noise`. Mirrors the main-process cache. */
const silenceCache = new Map();

/**
 * Step 3's hook: extra SOURCE-time spans to cut alongside the detected silences.
 *
 * Register a function `(audioClip, opts) => [[startSec, endSec], ...]` in the source
 * file's own time base. Captions will feed filler words ("um", "uh", "like") in through
 * here, so a filler cut and a silence cut are one ripple and one undo entry rather than
 * two passes over the same timeline.
 *
 * Filler spans are NOT subject to the silence threshold - a filler word is short by
 * definition - but they do get the same pad, so a cut never lands hard against speech.
 */
const tightenSpanSources = [];
function registerTightenSpans(fn) {
  if (typeof fn === 'function') tightenSpanSources.push(fn);
  return fn;
}
function extraTightenSpans(clip, opts) {
  const out = [];
  for (const fn of tightenSpanSources) {
    let spans = null;
    // A broken provider must cost its own spans, never the whole Tighten pass.
    try { spans = fn(clip, opts); } catch (e) { spans = null; }
    if (!Array.isArray(spans)) continue;
    for (const s of spans) {
      if (Array.isArray(s) && isFinite(s[0]) && isFinite(s[1]) && s[1] > s[0]) out.push([s[0], s[1]]);
    }
  }
  return out;
}

/** Sort and union a list of [start, end] spans. */
function mergeSpans(spans) {
  const list = spans.filter((s) => s && s[1] > s[0]).map((s) => [s[0], s[1]])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

function tightenOpts() {
  return Object.assign({}, TIGHTEN_DEFAULTS, state.tighten);
}

/**
 * The audio clip a selection's silence should be read from.
 *
 * People click the video half - it is the one with a picture on it - so a video clip
 * routes through its link group to the audio that came in with it, exactly as the audio
 * effect chain does.
 */
function tightenAudioFor(clip) {
  if (!clip || clip.kind === 'text') return null;
  if (clip.kind === 'audio') return clip.src ? clip : null;
  if (clip.kind !== 'video' || !clip.linkId) return null;
  return linkGroup(clip).find((x) => x.kind === 'audio' && x.src) || null;
}

/** The selection as link groups: [{ clips, audio }], each group listed once. */
function tightenUnits() {
  const seen = new Set();
  const units = [];
  for (const { clip } of selectedClips()) {
    const key = clip.linkId || clip.id;
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({ clips: linkGroup(clip), audio: tightenAudioFor(clip) });
  }
  return units;
}

/** Cached spans for a source, or null if it has not been analysed at this noise floor. */
function silenceFor(src, noise) {
  return silenceCache.get(src + '|' + Math.round(noise)) || null;
}

/**
 * Analyse every source the current selection needs, filling the renderer-side cache.
 *
 * Safe to call repeatedly: a file already in the cache costs nothing, and the main
 * process serves a previous session's result from disk.
 */
async function analyzeTightenSelection() {
  const opts = tightenOpts();
  const noise = Math.round(opts.noise);
  const srcs = new Set();
  for (const u of tightenUnits()) if (u.audio && !silenceFor(u.audio.src, noise)) srcs.add(u.audio.src);
  let failed = 0;
  for (const src of srcs) {
    let r = null;
    try { r = await window.api.analyzeSilence(src, noise); } catch (e) { r = null; }
    if (r && r.ok) silenceCache.set(src + '|' + noise, { spans: r.spans || [], duration: r.duration || 0 });
    else failed++;
  }
  return { analysed: srcs.size - failed, failed };
}

/**
 * What Tighten would remove, as merged TIMELINE spans. Pure: it reads the cache and the
 * settings and mutates nothing, so the inspector can show a live count on every slider
 * move without touching the project.
 */
function tightenPlan() {
  const opts = tightenOpts();
  const noise = Math.round(opts.noise);
  const cutIds = new Set();
  const raw = [];
  let pending = 0;

  for (const u of tightenUnits()) {
    if (!u.audio) continue;
    const a = u.audio;
    const data = silenceFor(a.src, noise);
    if (!data) { pending++; continue; }

    const spans = [];
    // The threshold is measured on the silence as DETECTED, before the pad eats into it.
    for (const s of data.spans) if (s[1] - s[0] >= opts.threshold) spans.push(s);
    for (const s of extraTightenSpans(a, opts)) spans.push(s);

    for (const s of mergeSpans(spans)) {
      // Only the part of a silence this clip actually uses can be cut.
      const s0 = Math.max(s[0], a.in) + opts.pad;
      const s1 = Math.min(s[1], a.out) - opts.pad;
      if (s1 - s0 < TIGHTEN_MIN_CUT) continue;
      raw.push([a.start + (s0 - a.in), a.start + (s1 - a.in)]);
    }
    for (const c of u.clips) cutIds.add(c.id);
  }

  const merged = mergeSpans(raw);
  let removed = 0;
  for (const s of merged) removed += s[1] - s[0];
  return { spans: merged, cutIds, removed, count: merged.length, pending };
}

/**
 * Remove one TIMELINE span and close the gap.
 *
 * `cutIds` is the set of clips the span may cut into - the selection's link groups.
 * Everything else on an unlocked track only SHIFTS, and only if it starts after the span:
 * a music bed or a second interview is not silent just because the voice-over is, and
 * slicing it would be a surprise nobody asked for.
 *
 * Text clips are never cut either, whether or not they are in the group. Their `in` is
 * always 0 and their length is `out` (see the data model), and cutting a card's animation
 * in half is never the intent - they ride the ripple and keep their length.
 *
 * A locked track is left entirely alone, neither cut nor shifted, exactly as ripple
 * delete already leaves it.
 */
function removeTimelineSpan(a, b, cutIds) {
  const amount = b - a;
  if (amount <= 0) return;
  const E = 1e-6;
  const relink = new Map();   // original linkId -> the id shared by this span's right halves
  const dropped = [];

  for (const track of state.tracks) {
    if (track.locked) continue;
    const kept = [];
    for (const c of track.clips) {
      const s = c.start, e = clipEnd(c);
      const cuttable = cutIds.has(c.id) && c.kind !== 'text';

      if (e <= a + E) { kept.push(c); continue; }                     // wholly before
      if (s >= b - E) { c.start -= amount; kept.push(c); continue; }  // wholly after
      if (!cuttable) { kept.push(c); continue; }                      // ours to move, not to cut

      if (s >= a - E && e <= b + E) { dropped.push(c); continue; }    // wholly inside

      if (s < a - E && e > b + E) {
        // Straddles the span: keep the head where it is, and start a new clip at the tail.
        const right = Object.assign({}, c, {
          id: nextId(),
          start: a,
          in: c.in + (b - s),
          out: c.out,
        });
        // Both halves of a cut pair must stay linked to their opposite numbers, or the
        // next drag moves the picture without the sound.
        if (c.linkId) {
          if (!relink.has(c.linkId)) relink.set(c.linkId, nextId());
          right.linkId = relink.get(c.linkId);
        }
        c.out = c.in + (a - s);
        kept.push(c);
        kept.push(right);
      } else if (s < a - E) {
        c.out = c.in + (a - s);                                       // trim the tail off
        kept.push(c);
      } else {
        c.in += (b - s);                                              // trim the head off
        c.start = a;
        kept.push(c);
      }
    }
    track.clips = kept;
  }

  for (const c of dropped) dropMedia(c.id);
}

/** Transitions whose clips the ripple removed are dropped rather than left dangling. */
function pruneTransitions() {
  const ids = new Set(allClips().map((x) => x.clip.id));
  for (const t of state.tracks) {
    if (!t.transitions) continue;
    t.transitions = t.transitions.filter((tr) => ids.has(tr.aId) && ids.has(tr.bId));
  }
}

/**
 * Tighten: remove the planned spans and close the gaps.
 *
 * ONE pushUndo() for the whole pass, however many spans come out - what the user asked
 * for is "tighten this", not "make ninety cuts". Spans are removed right to left so that
 * each one's coordinates are still valid when its turn comes.
 */
function tighten() {
  const plan = tightenPlan();
  if (plan.pending) { log('Analyse the selection first (' + plan.pending + ' clip(s) not measured).'); return null; }
  if (!plan.spans.length) { log('Nothing to tighten at this threshold.'); return null; }

  pushUndo();
  for (let i = plan.spans.length - 1; i >= 0; i--) {
    removeTimelineSpan(plan.spans[i][0], plan.spans[i][1], plan.cutIds);
  }
  sortTracks();
  pruneTransitions();
  const live = new Set(allClips().map((x) => x.clip.id));
  state.selection = new Set([...state.selection].filter((id) => live.has(id)));
  markDirty();
  renderAll();
  log('Tightened: removed ' + plan.count + ' span(s), ' + plan.removed.toFixed(2) + 's.');
  return plan;
}

function linkSelected() {
  const sel = selectedClips().map((x) => x.clip);
  if (sel.length < 2) { log('Select at least two clips to link.'); return; }
  pushUndo();
  const id = nextId();
  for (const c of sel) c.linkId = id;
  markDirty(); renderAll();
  log('Linked ' + sel.length + ' clips.');
}
function unlinkSelected() {
  const sel = selectedClips().map((x) => x.clip);
  if (!sel.length) return;
  pushUndo();
  const ids = new Set(sel.map((c) => c.linkId).filter(Boolean));
  for (const { clip } of allClips()) if (clip.linkId && ids.has(clip.linkId)) clip.linkId = null;
  markDirty(); renderAll();
  log('Unlinked.');
}

/** Trim the selected clip's in/out point to the playhead. */
function trimToPlayhead(edge) {
  const sel = selectedClips();
  if (!sel.length) return;
  pushUndo();
  for (const { clip } of sel) {
    for (const c of linkGroup(clip)) {
      if (edge === 'in') {
        const d = clamp(state.playhead - c.start, -c.in, (c.out - c.in) - 0.05);
        c.in += d; c.start = Math.max(0, c.start + d);
      } else {
        const d = clamp(state.playhead - clipEnd(c), -((c.out - c.in) - 0.05), c.mediaDuration - c.out);
        c.out += d;
      }
    }
  }
  markDirty(); renderAll();
}

function selectAll() {
  state.selection = new Set(allClips().map((x) => x.clip.id));
  renderLanes(); renderInspector();
}

/** Put the Loudness select back in step with `state.out.loudness`. */
function syncLoudnessControl() {
  const l = Object.assign({}, AudioFX.LOUD_DEFAULTS, state.out.loudness);
  const sel = $('#loudness');
  if (!sel) return;
  sel.value = l.enabled ? String(l.lufs) : 'off';
  // A target the dropdown does not list (from a hand-edited .scut) must not silently
  // read as "off" - show it rather than lying about it.
  if (sel.value !== (l.enabled ? String(l.lufs) : 'off')) {
    const o = document.createElement('option');
    o.value = String(l.lufs);
    o.textContent = l.lufs + ' LUFS';
    sel.appendChild(o);
    sel.value = String(l.lufs);
  }
}

function newProject() {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  for (const id of [...mediaEls.keys()]) dropMedia(id);
  state.tracks = [makeTrack('video', 1), makeTrack('audio', 1)];
  state.selection.clear();
  state.playhead = 0;
  state.selTransition = null;
  state.inPoint = state.outPoint = null;
  state.filePath = null;
  state.out.loudness = Object.assign({}, AudioFX.LOUD_DEFAULTS);
  state.tighten = Object.assign({}, TIGHTEN_DEFAULTS);
  syncLoudnessControl();
  undoStack = []; redoStack = [];
  markClean();
  renderAll();
  zoomFit();
}

// ================================== 8. project save/open

function serialize() {
  return {
    app: 'shortcut',
    version: 1,
    out: state.out,
    pxPerSec: state.pxPerSec,
    playhead: state.playhead,
    inPoint: state.inPoint,
    outPoint: state.outPoint,
    tighten: state.tighten,
    tracks: state.tracks,
  };
}

async function saveProject(asNew) {
  const r = await window.api.saveProject(serialize(), asNew ? null : state.filePath);
  if (r.canceled) return;
  state.filePath = r.filePath;
  markClean();
  log('Saved ' + r.filePath);
}

async function openProject() {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  const r = await window.api.openProject(null);
  if (r.canceled) return;
  if (r.error) { log(r.error); alert(r.error); return; }
  for (const id of [...mediaEls.keys()]) dropMedia(id);
  const d = r.data;
  state.tracks = d.tracks || [];
  state.out = Object.assign(state.out, d.out || {});
  state.pxPerSec = d.pxPerSec || 60;
  state.playhead = d.playhead || 0;
  state.inPoint = d.inPoint == null ? null : d.inPoint;
  state.outPoint = d.outPoint == null ? null : d.outPoint;
  state.selTransition = null;
  state.out.loudness = Object.assign({}, AudioFX.LOUD_DEFAULTS, (d.out || {}).loudness);
  state.tighten = Object.assign({}, TIGHTEN_DEFAULTS, d.tighten);
  for (const t of state.tracks) {
    if (!t.transitions) t.transitions = [];
    for (const tr of t.transitions) Trans.normalize(tr);
    // Fill in effect parameters a project saved before they existed, and drop effect
    // types this build does not know - the same job Trans.normalize does above.
    for (const c of t.clips) AudioFX.normalizeClip(c);
  }
  preloadTransitionImages();
  state.selection.clear();
  state.filePath = r.filePath;
  undoStack = []; redoStack = [];
  $('#preset').value = state.out.w + 'x' + state.out.h;
  $('#quality').value = state.out.quality;
  $('#fps').value = String(state.out.fps);
  syncLoudnessControl();
  resizeCanvas();
  markClean();
  renderAll();
  log('Opened ' + r.filePath);
  if (r.missing && r.missing.length) {
    log('WARNING: ' + r.missing.length + ' media file(s) missing.');
    alert('These media files are missing:\n\n' + r.missing.slice(0, 10).join('\n'));
  }
}

// ========================================== 9. render

/**
 * Flatten the timeline into a render job.
 *
 * `range` limits the job to a slice of the timeline: clips are cropped to it and shifted
 * so the slice starts at zero. That is what makes reviewing one part of an edit quick -
 * a five second look does not have to re-encode a two minute timeline.
 */
function buildJob(outPath, range) {
  const r = range || { from: 0, to: projectDuration() };
  const clips = [];
  // Bottom video track first so higher tracks overlay on top.
  const ordered = [...state.tracks].reverse();
  for (const t of ordered) {
    for (const c of t.clips) {
      const cEnd = clipEnd(c);
      if (cEnd <= r.from + 1e-6 || c.start >= r.to - 1e-6) continue;   // outside the range

      // How much of the clip's head and tail the range cuts off.
      const headCut = Math.max(0, r.from - c.start);
      const tailCut = Math.max(0, cEnd - r.to);

      const entry = {
        src: c.src,
        kind: c.kind,
        start: Math.max(0, c.start - r.from),
        in: c.in + headCut,
        out: c.out - tailCut,
        panX: c.panX, panY: c.panY, zoom: c.zoom,
        volume: c.volume,
        // The audio chain and the track it sits on. `trackId` is what a ducking effect
        // names as its voice source, so buildArgs() needs it to find the sidechain feed.
        trackId: t.id,
        afx: c.afx && c.afx.length ? JSON.parse(JSON.stringify(c.afx)) : undefined,
        visible: (c.kind === 'video' || c.kind === 'text') && t.type === 'video' && !t.hidden,
        audible: t.type === 'audio' && !t.muted && c.volume > 0,
      };
      if (c.kind === 'text') {
        // A card's animation is timed from ITS start, not the clip's source in-point, so a
        // range that begins mid-card has to bake from that point in the animation.
        entry.tStart = headCut;
        entry.textClip = c;
      }
      clips.push(entry);
    }

    // A transition's layer is opaque and belongs above its own track's clips but below
    // anything on a higher track, so it goes in right after them.
    if (t.type === 'video' && !t.hidden) {
      for (const trDef of (t.transitions || [])) {
        const rv = resolveTransition(trDef, t);
        if (!rv) continue;
        const from = Math.max(rv.from, r.from);
        const to = Math.min(rv.to, r.to);
        if (to - from <= 0.002) continue;
        clips.push({
          src: null,
          kind: 'trans',
          start: Math.max(0, from - r.from),
          in: 0,
          out: to - from,
          panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
          visible: true,
          audible: false,
          tStart: from - rv.from,     // where in the window this baked segment starts
          transRef: rv,               // stripped before IPC, like textClip
        });
      }
    }
  }
  return {
    width: state.out.w, height: state.out.h, fps: state.out.fps,
    quality: state.out.quality, outPath, clips,
    loudness: Object.assign({}, AudioFX.LOUD_DEFAULTS, state.out.loudness),
    duration: Math.max(0, r.to - r.from),
    rangeFrom: r.from, rangeTo: r.to,
  };
}

/**
 * Key for the render cache: everything that decides the output pixels.
 *
 * Computed here rather than in main so the timeline can ask "is this span still cached?"
 * by rebuilding that job and hashing it, without baking or rendering anything.
 *
 * That is exactly why the bake artefacts have to be normalised away. A job that has been
 * through bakeTextClips() has swapped each card for a `seqDir` and dropped `textClip`; a
 * job built fresh for the timeline check still has the card and no seqDir. Hashing them
 * raw gives two different keys for identical content, and the cache bar would never light
 * up. Hash the card itself and the two paths agree.
 *
 * `outPath` is excluded deliberately - rendering the same content to a new filename is a
 * copy, not an encode.
 */
function jobCacheKey(job) {
  const copy = Object.assign({}, job);
  delete copy.outPath;
  delete copy.cacheKey;
  delete copy.useCache;
  // How the render was triggered is not part of the picture. Leaving `preview` in would
  // give the same frames two different keys - the cache bar would never match a preview
  // render, and exporting a span you had already previewed would encode it a second time.
  delete copy.preview;
  copy.clips = (job.clips || []).map((c) => {
    const e = Object.assign({}, c);
    delete e.textClip;
    delete e.transRef;
    delete e.seqDir; delete e.bx; delete e.by; delete e.bw; delete e.bh;
    if (c.textClip) e.card = c.textClip.card;
    if (c.transRef) {
      // Everything a transition's pixels depend on: its settings and both clips' framing.
      const framing = (x) => ({ src: x.src, in: x.in, start: x.start, out: x.out,
        panX: x.panX, panY: x.panY, zoom: x.zoom });
      e.trans = c.transRef.tr;
      e.transA = framing(c.transRef.a);
      e.transB = framing(c.transRef.b);
    }
    return e;
  });
  return hashString(JSON.stringify(copy));
}

let rendering = false;

/** Park a media element on an exact source time and wait for the frame to land. */
function seekMedia(el, t) {
  return new Promise((resolve) => {
    if (el.readyState >= 2 && Math.abs(el.currentTime - t) < 0.004) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('seeked', finish);
      el.removeEventListener('loadeddata', kick);
      resolve();
    };
    const kick = () => { try { el.currentTime = t; } catch (e) { finish(); } };
    el.addEventListener('seeked', finish);
    if (el.readyState >= 1) kick();
    else el.addEventListener('loadeddata', kick);
    // A stubborn seek must never hang a render; take whatever frame is there.
    setTimeout(finish, 1500);
  });
}

/**
 * Bake each transition window into an opaque full-frame raw RGBA layer.
 *
 * A transition needs BOTH clips at once, including frames outside their trimmed range,
 * which no ffmpeg overlay of the existing chain can express. Baking it here sidesteps all
 * of that: the renderer can seek either source anywhere, `Trans.draw` paints exactly what
 * the preview paints, and the exporter just overlays the result. The cost is two video
 * seeks per frame, which is fine for a window measured in tenths of a second.
 */
async function bakeTransitions(job) {
  const entries = job.clips.filter((c) => c.kind === 'trans' && c.transRef);
  const dirs = [];
  if (!entries.length) {
    for (const c of job.clips) delete c.transRef;
    return dirs;
  }

  const frame = document.createElement('canvas');
  frame.width = job.width; frame.height = job.height;
  const fctx = frame.getContext('2d');
  const aCv = document.createElement('canvas');
  const bCv = document.createElement('canvas');
  aCv.width = bCv.width = job.width;
  aCv.height = bCv.height = job.height;
  const actx = aCv.getContext('2d');
  const bctx = bCv.getContext('2d');

  const totalFrames = entries.reduce(
    (n, e) => n + Math.max(1, Math.round((e.out - e.in) * job.fps)), 0);
  let done = 0;

  try {
    for (const e of entries) {
      const r = e.transRef;
      if (r.tr.type === 'object') await Trans.loadImage(r.tr.params.src);

      const frames = Math.max(1, Math.round((e.out - e.in) * job.fps));
      const aEl = mediaFor(r.a);
      const bEl = mediaFor(r.b);
      aEl.muted = bEl.muted = true;

      const slot = await window.api.textSeq();
      e.seqDir = slot.dir;
      e.bx = 0; e.by = 0; e.bw = job.width; e.bh = job.height;
      dirs.push(slot.dir);

      const BATCH = 4;                       // full-frame RGBA is bulky, so smaller batches
      const frameBytes = job.width * job.height * 4;
      const batch = new Uint8Array(frameBytes * BATCH);
      let inBatch = 0;
      const flush = async () => {
        if (!inBatch) return;
        await window.api.writeTextFrames(slot.dir,
          inBatch === BATCH ? batch : batch.slice(0, inBatch * frameBytes));
        inBatch = 0;
      };

      for (let i = 0; i < frames; i++) {
        const t = r.from + e.tStart + i / job.fps;
        const st = transitionSourceTimes(r, t);
        await Promise.all([seekMedia(aEl, st.a), seekMedia(bEl, st.b)]);

        let aImg = null, bImg = null;
        if (aEl.readyState >= 2 && aEl.videoWidth) {
          actx.fillStyle = '#000'; actx.fillRect(0, 0, job.width, job.height);
          drawClipTo(r.a, aEl, actx, job.width, job.height);
          aImg = aCv;
        }
        if (bEl.readyState >= 2 && bEl.videoWidth) {
          bctx.fillStyle = '#000'; bctx.fillRect(0, 0, job.width, job.height);
          drawClipTo(r.b, bEl, bctx, job.width, job.height);
          bImg = bCv;
        }

        fctx.fillStyle = '#000';
        fctx.fillRect(0, 0, job.width, job.height);
        const p = (e.tStart + i / job.fps) / Math.max(0.001, r.dur);
        Trans.draw(fctx, job.width, job.height, r.tr, p, aImg, bImg, 1 / job.fps);

        batch.set(fctx.getImageData(0, 0, job.width, job.height).data, inBatch * frameBytes);
        inBatch++;
        if (inBatch === BATCH) await flush();

        done++;
        if (i % 4 === 0 || i === frames - 1) {
          setStatus('Baking transitions... ' + done + ' / ' + totalFrames + ' frames');
          $('#renderBar').style.width = (done / totalFrames * 100) + '%';
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      await flush();
      await window.api.textSeqDone(slot.dir, frames);
      log('Baked ' + frames + ' frames of a ' + Trans.TYPES[r.tr.type].label.toLowerCase() +
        ' transition at ' + fmtTc(r.cut) + '.');
    }
  } finally {
    for (const c of job.clips) delete c.transRef;
  }
  return dirs;
}

/** Bake every canvas-drawn overlay a job needs: text cards and transitions. */
async function bakeOverlays(job) {
  const a = await bakeTextClips(job);
  const b = await bakeTransitions(job);
  return a.concat(b);
}

/**
 * Bake every visible text card into a raw RGBA stream for ffmpeg to overlay.
 *
 * Each card is cropped to the union of its painted bounds across the whole clip
 * (TextDraw.animatedBounds), so a caption in a corner writes a small frame rather than a
 * full-size one.
 *
 * Frames go out as raw bytes, NOT PNGs. Encoding a PNG of a large, glowing text frame
 * costs 100-1500 ms depending on how much alpha detail it carries, and that single line
 * was responsible for a four second title card taking minutes to render. `getImageData`
 * costs about 4 ms. Returns the scratch dirs so they can be deleted afterwards.
 */
/**
 * Stable 32-bit hash of a string (FNV-1a). Good enough to key the bake cache: a
 * collision would only ever reuse frames for a card that serialises identically.
 */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + '_' + str.length.toString(36);
}

async function bakeTextClips(job) {
  const entries = job.clips.filter((c) => c.kind === 'text' && c.visible);
  const dirs = [];
  if (!entries.length) {
    for (const c of job.clips) delete c.textClip;
    return dirs;
  }

  const scratch = document.createElement('canvas');
  scratch.width = job.width; scratch.height = job.height;
  const sctx = scratch.getContext('2d');

  const totalFrames = entries.reduce(
    (n, e) => n + Math.max(1, Math.round((e.out - e.in) * job.fps)), 0);
  let done = 0;

  for (const e of entries) {
    const clip = e.textClip;
    // Only scan the part of the card this job actually shows.
    const scanFrom = e.tStart || 0;
    const scanTo = scanFrom + (e.out - e.in);
    const bounds = TextDraw.animatedBounds(sctx, clip, job.width, job.height,
      1 / Math.min(job.fps, 20), scanFrom, scanTo);
    const cv = document.createElement('canvas');
    cv.width = bounds.w; cv.height = bounds.h;
    const cctx = cv.getContext('2d');

    const dur = e.out - e.in;
    const frames = Math.max(1, Math.round(dur * job.fps));
    const tStart = e.tStart || 0;   // where in the card's own timeline this bake begins

    // Everything that changes the baked pixels goes into the key. Anything else (where
    // the card sits on the timeline, the output file, other clips) must NOT, or the cache
    // would miss on edits that cannot change a single frame.
    const slot = await window.api.textSeq();
    e.seqDir = slot.dir;
    e.bx = bounds.x; e.by = bounds.y; e.bw = bounds.w; e.bh = bounds.h;
    dirs.push(slot.dir);

    // Frames are sent in batches: one IPC round trip per frame would now cost more than
    // drawing the frame does.
    const BATCH = 8;
    const frameBytes = bounds.w * bounds.h * 4;
    const batch = new Uint8Array(frameBytes * BATCH);
    let inBatch = 0;
    const flush = async () => {
      if (!inBatch) return;
      await window.api.writeTextFrames(slot.dir,
        inBatch === BATCH ? batch : batch.slice(0, inBatch * frameBytes));
      inBatch = 0;
    };

    for (let i = 0; i < frames; i++) {
      cctx.clearRect(0, 0, bounds.w, bounds.h);
      cctx.save();
      cctx.translate(-bounds.x, -bounds.y); // TextDraw works in full-frame coordinates
      TextDraw.draw(cctx, clip, job.width, job.height, tStart + i / job.fps, 1 / job.fps);
      cctx.restore();

      batch.set(cctx.getImageData(0, 0, bounds.w, bounds.h).data, inBatch * frameBytes);
      inBatch++;
      if (inBatch === BATCH) await flush();

      done++;
      if (i % 15 === 0 || i === frames - 1) {
        setStatus('Baking text cards... ' + done + ' / ' + totalFrames + ' frames');
        $('#renderBar').style.width = (done / totalFrames * 100) + '%';
        await new Promise((r) => setTimeout(r, 0)); // let the UI repaint
      }
    }
    await flush();
    await window.api.textSeqDone(slot.dir, frames);
    log('Baked ' + frames + ' text frames (' + bounds.w + 'x' + bounds.h + ') for "' +
      String(clip.card.text).split(/\r?\n/)[0].slice(0, 24) + '".');
  }

  for (const c of job.clips) delete c.textClip; // not serialisable across IPC, and not needed
  return dirs;
}

/** Keep the render controls in step with the marks. */
function updateRenderUI() {
  const sel = $('#renderRange');
  if (!sel) return;
  const r = renderRange();
  const marks = sel.value === 'marks';
  $('#rangeInfo').textContent = marks
    ? 'range ' + fmtTc(r.from) + ' - ' + fmtTc(r.to) + '  (' + (r.to - r.from).toFixed(2) + 's)'
    : 'whole project (' + projectDuration().toFixed(2) + 's)';
  renderRangeOverlay();
}

/**
 * A job for a preview render: the same timeline, at the viewer's working resolution.
 *
 * `refreshCacheBands()` and `doPreviewRender()` MUST build it the same way, or the key
 * the bar recomputes will not match the key the render was filed under and no span will
 * ever light up.
 */
function buildPreviewJob(range) {
  const job = buildJob('', range);
  const p = previewSize();
  job.width = p.w;
  job.height = p.h;
  return job;
}

/**
 * Render the current range into the app's own cache and play it back in the viewer.
 *
 * No save dialog and no file in the user's folders: the output IS the cache entry, which
 * the viewer then decodes instead of compositing. This is the review loop - `Export...`
 * is the separate action that writes a deliverable somewhere.
 */
async function doPreviewRender(opts) {
  if (rendering) return;
  const force = !!(opts && opts.force);
  const dur = projectDuration();
  if (dur <= 0) { setStatus('Nothing to render - the timeline is empty.', 'err'); return; }

  const useMarks = $('#renderRange').value === 'marks';
  const range = useMarks ? renderRange() : { from: 0, to: dur };
  if (range.to - range.from <= 0.01) {
    setStatus('That range is empty - move the in/out marks.', 'err');
    return;
  }

  rendering = true;
  $('#btnRenderPreview').disabled = true;
  $('#btnCancelRender').disabled = false;
  $('#renderBar').style.width = '0%';
  const t0 = Date.now();

  const job = buildPreviewJob(range);
  job.preview = true;
  job.cacheKey = jobCacheKey(job);
  job.useCache = !force;
  let res;
  let bakeMs = 0, encodeMs = 0;
  let dirs = [];
  try {
    setStatus('Rendering preview ' + fmtTc(range.from) + ' - ' + fmtTc(range.to) +
      ' at ' + job.width + 'x' + job.height + '...');
    const tb = Date.now();
    dirs = await bakeOverlays(job);
    bakeMs = Date.now() - tb;
    const te = Date.now();
    res = await window.api.startRender(job);
    encodeMs = Date.now() - te;
  } catch (err) {
    res = { ok: false, error: 'Preview render failed: ' + (err && err.message ? err.message : err) };
  } finally {
    for (const d of dirs) window.api.endTextSeq(d);   // raw frames are scratch
  }

  rendering = false;
  $('#btnRenderPreview').disabled = false;
  $('#btnCancelRender').disabled = true;

  if (res.ok) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    $('#renderBar').style.width = '100%';
    setStatus(res.cached
      ? 'That range was already rendered - playing it back.'
      : 'Preview rendered in ' + secs + 's - the viewer is playing it back.', 'ok');
    // Break the time down: a slow render is nearly always one half or the other, and
    // without this there is no way to tell which.
    log((res.cached ? 'Reused' : 'Rendered') + ' the preview for ' +
      fmtTc(range.from) + ' - ' + fmtTc(range.to) + ' at ' + job.width + 'x' + job.height +
      ' in ' + secs + 's  (text bake ' + (bakeMs / 1000).toFixed(1) + 's, encode ' +
      (encodeMs / 1000).toFixed(1) + 's)');
    await refreshCacheBands(true);
refreshTransPresets(false);
refreshAudioPresets(false);
    refreshCacheInfo();
    seek(range.from);
  } else {
    $('#renderBar').style.width = '0%';
    setStatus(res.error, res.cancelled ? '' : 'err');
    log('Preview render failed: ' + String(res.error).split('\n').slice(-3).join(' '));
  }
}

async function doRender(opts) {
  if (rendering) return;
  const force = !!(opts && opts.force);
  const dur = projectDuration();
  if (dur <= 0) { setStatus('Nothing to render - the timeline is empty.', 'err'); return; }

  const useMarks = $('#renderRange').value === 'marks';
  const range = useMarks ? renderRange() : { from: 0, to: dur };
  if (range.to - range.from <= 0.01) {
    setStatus('That range is empty - move the in/out marks.', 'err');
    return;
  }

  const base = (state.filePath ? state.filePath.split(/[\\/]/).pop().replace(/\.scut$/i, '') : 'output');
  const suffix = useMarks
    ? '_' + Math.round(range.from * 1000) + '-' + Math.round(range.to * 1000) + 'ms'
    : '';
  const name = base + suffix + '_' + state.out.w + 'x' + state.out.h + '.mp4';
  const outPath = await window.api.pickOutput(name);
  if (!outPath) return;

  rendering = true;
  $('#btnRender').disabled = true;
  $('#btnCancelRender').disabled = false;
  setStatus('Rendering ' + state.out.w + 'x' + state.out.h + ' (' + state.out.quality + ')...');
  $('#renderBar').style.width = '0%';
  const t0 = Date.now();

  const job = buildJob(outPath, range);
  let dirs = [];
  let res;
  try {
    // The key must be taken BEFORE baking, while the job still carries the cards.
    job.cacheKey = jobCacheKey(job);
    job.useCache = !force;
    dirs = await bakeOverlays(job);
    setStatus('Rendering ' + (range.to - range.from).toFixed(2) + 's at ' +
      state.out.w + 'x' + state.out.h + ' (' + state.out.quality + ')...');
    res = await window.api.startRender(job);
  } catch (err) {
    res = { ok: false, error: 'Text baking failed: ' + (err && err.message ? err.message : err) };
  } finally {
    // Raw frames are bulky and now cheap to regenerate, so they are scratch rather than
    // cache. What gets cached is the finished MP4.
    for (const d of dirs) window.api.endTextSeq(d);
  }

  rendering = false;
  $('#btnRender').disabled = false;
  $('#btnCancelRender').disabled = true;
  if (res.ok) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    $('#renderBar').style.width = '100%';
    if (res.cached) {
      setStatus('Nothing changed - reused the cached render (' + secs + 's) -> ' + res.outPath, 'ok');
      log('Reused the cached render for ' + res.outPath + ' (' + secs + 's).');
    } else {
      setStatus('Done in ' + secs + 's -> ' + res.outPath, 'ok');
      log('Rendered ' + res.outPath + ' in ' + secs + 's');
    }
    refreshCacheInfo();
    refreshCacheBands(true);
    window.api.showItem(res.outPath);
  } else {
    $('#renderBar').style.width = '0%';
    setStatus(res.error, res.cancelled ? '' : 'err');
    log('Render failed: ' + String(res.error).split('\n').slice(-3).join(' '));
  }
}

function setStatus(msg, cls) {
  const el = $('#renderStatus');
  el.className = 'status ' + (cls || '');
  el.textContent = msg;
}

window.api.onRenderProgress((d) => {
  if (!d.total) return;
  // The loudness measurement pass reports a stage rather than a time: it is a whole
  // decode of its own, and saying "0:00 / 0:30" through it looks like a stall.
  if (d.stage) { $('#renderBar').style.width = '0%'; setStatus(d.stage + '...'); return; }
  $('#renderBar').style.width = clamp(d.time / d.total * 100, 0, 100) + '%';
  setStatus('Rendering... ' + fmtTc(d.time) + ' / ' + fmtTc(d.total));
});

// ============================ 10. wiring + shortcuts

$('#btnImport').addEventListener('click', async () => importPaths(await window.api.pickMedia()));
$('#btnImportFolder').addEventListener('click', async () => importPaths(await window.api.pickFolder()));

// ---- the QuickBin --------------------------------------------------------
//
// The bin is the library, the timeline is the edit: nothing in the bin is part of the
// project, and putting something on the timeline is an ordinary import at the playhead.
QuickBin.init({
  log,
  insert: (paths) => importPaths(paths, { at: state.playhead }),
  // A still cannot go on the timeline, but it is exactly what an object transition
  // wants, so double-clicking one in the bin hands it to the selected transition.
  useImage: async (p) => {
    const r = selectedTransition();
    if (!r || r.tr.type !== 'object') {
      log('Select an object transition first - a still has nowhere else to go yet.');
      return;
    }
    pushUndo();
    r.tr.params.src = p;
    await Trans.loadImage(p);
    markDirty();
    renderAll();
    log('Object transition now uses ' + p.split(/[\\/]/).pop() + '.');
  },
});
$('#btnBinAdd').addEventListener('click', async () => {
  const n = await QuickBin.importPaths(await window.api.binPick(), QuickBin.targetFolder());
  if (n) log('QuickBin: added ' + n + ' item(s).');
});
$('#btnBinAddFolder').addEventListener('click', async () => {
  const n = await QuickBin.importPaths(await window.api.binPickFolder(), QuickBin.targetFolder());
  if (n) log('QuickBin: added ' + n + ' item(s).');
});
$('#btnBinNewFolder').addEventListener('click', () => {
  QuickBin.addFolder('New folder', QuickBin.targetFolder());
  QuickBin.render();
});
$('#btnBinUse').addEventListener('click', () => QuickBin.useSelection());
$('#btnBinRemove').addEventListener('click', () => QuickBin.removeSelection());
$('#btnBinCollapse').addEventListener('click', toggleBin);

function toggleBin(show) {
  const hide = show == null ? !$('#quickBin').hidden : !show;
  $('#quickBin').hidden = hide;
  $('#binBar').hidden = hide;
  $('#btnBinCollapse').textContent = hide ? '+' : '−';
}

// A decode finishing has to reach the lanes, or the waveform only appears after the next
// unrelated edit. Coalesced: importing a folder finishes a great many of them at once.
let waveRedraw = null;
Wave.onReady(() => {
  clearTimeout(waveRedraw);
  waveRedraw = setTimeout(renderLanes, 120);
});
$('#btnNew').addEventListener('click', newProject);
$('#btnOpen').addEventListener('click', openProject);
$('#btnSave').addEventListener('click', () => saveProject(false));
$('#btnSaveAs').addEventListener('click', () => saveProject(true));
$('#btnSplit').addEventListener('click', splitAtPlayhead);
$('#btnDelete').addEventListener('click', () => deleteSelected(false));
$('#btnRipple').addEventListener('click', () => deleteSelected(true));
$('#btnCloseGaps').addEventListener('click', closeGaps);
$('#btnLink').addEventListener('click', linkSelected);
$('#btnUnlink').addEventListener('click', unlinkSelected);
$('#btnDuplicate').addEventListener('click', duplicateSelected);
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#btnAddVideoTrack').addEventListener('click', () => addTrack('video'));
$('#btnAddAudioTrack').addEventListener('click', () => addTrack('audio'));
$('#snapToggle').addEventListener('change', (e) => { state.snap = e.target.checked; });
$('#btnZoomIn').addEventListener('click', () => zoomTimeline(1.25));
$('#btnZoomOut').addEventListener('click', () => zoomTimeline(1 / 1.25));
$('#btnZoomFit').addEventListener('click', zoomFit);
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnStart').addEventListener('click', () => seek(0));
$('#btnEnd').addEventListener('click', () => seek(projectDuration()));
$('#btnPrevFrame').addEventListener('click', () => seek(state.playhead - 1 / state.out.fps));
$('#btnNextFrame').addEventListener('click', () => seek(state.playhead + 1 / state.out.fps));
$('#btnRender').addEventListener('click', () => doRender());
$('#btnRenderPreview').addEventListener('click', () => doPreviewRender());
$('#btnRenderFull').addEventListener('click', () => doPreviewRender({ force: true }));
$('#previewScale').addEventListener('change', (e) => {
  state.previewScale = parseFloat(e.target.value) || 1;
  resizeCanvas();
  // Spans rendered at another scale are different pixels, so their keys no longer match.
  refreshCacheBands(true);
  drawPreview();
  const p = previewSize();
  log('Viewer resolution is now ' + p.w + 'x' + p.h + '.');
});
$('#usePreviewRender').addEventListener('change', (e) => {
  state.usePreviewRender = e.target.checked;
  syncMedia();
  drawPreview();
  log('Viewer is ' + (state.usePreviewRender ? 'playing rendered spans' : 'compositing live') + '.');
});
$('#renderRange').addEventListener('change', () => { updateRenderUI(); renderRuler(); });
$('#btnCancelRender').addEventListener('click', () => window.api.cancelRender());

/** Show how much disk the baked-text cache is using. */
async function refreshCacheInfo() {
  try {
    const i = await window.api.textCacheInfo();
    $('#cacheInfo').textContent = i.entries
      ? 'cache: ' + i.frames.entries + ' bake(s) + ' + i.renders.entries + ' render(s), ' +
        (i.size / 1048576).toFixed(1) + ' MB'
      : 'cache empty';
  } catch (e) { $('#cacheInfo').textContent = ''; }
}
$('#btnClearCache').addEventListener('click', async () => {
  await window.api.textCacheClear();
  await refreshCacheInfo();
  refreshCacheBands(true);
  log('Cleared the cached bakes and renders.');
});
refreshCacheInfo();

$('#preset').addEventListener('change', (e) => {
  const parts = e.target.value.split('x').map(Number);
  state.out.w = parts[0]; state.out.h = parts[1];
  resizeCanvas(); markDirty(); drawPreview();
});
$('#quality').addEventListener('change', (e) => { state.out.quality = e.target.value; markDirty(); });
// Loudness is one project-level target for the finished mix, not a per-clip effect: it
// has to see the whole amix to know how loud the video actually is.
$('#btnMeterReset').addEventListener('click', () => { resetMeter(); log('Loudness meter reset.'); });
$('#loudness').addEventListener('change', (e) => {
  const v = e.target.value;
  state.out.loudness = Object.assign({}, AudioFX.LOUD_DEFAULTS, state.out.loudness, {
    enabled: v !== 'off',
    lufs: v === 'off' ? (state.out.loudness || AudioFX.LOUD_DEFAULTS).lufs : Number(v),
  });
  markDirty();
  refreshCacheBands(true);   // a different mix is a different render
});
$('#fps').addEventListener('change', (e) => { state.out.fps = Number(e.target.value); markDirty(); renderPlayhead(); });

// ---- drag and drop -------------------------------------------------------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropOverlay').classList.add('show'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.remove('show'); } });
// The QuickBin swallows drops that land on it (they go into the bin, not the timeline),
// so the overlay has to be cleared in the capture phase or it would stay up over an
// import that the bubble-phase handler below never sees.
window.addEventListener('drop', () => {
  dragDepth = 0;
  $('#dropOverlay').classList.remove('show');
}, true);
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.remove('show');
  const paths = [];
  for (const f of e.dataTransfer.files) {
    const p = window.api.pathForFile(f);
    if (p) paths.push(p);
  }
  await importPaths(paths);
});

// ---- shortcuts -----------------------------------------------------------
const SHORTCUTS = [
  ['Space / K', 'Play / pause'],
  ['J / L', 'Step back / forward 1 second'],
  ['Left / Right', 'Step one frame'],
  ['Shift+Left / Right', 'Step one second'],
  ['Home / End', 'Go to start / end'],
  ['S or Ctrl+K', 'Split at playhead'],
  ['Delete', 'Delete selected clips'],
  ['Shift+Delete', 'Ripple delete (close the gap)'],
  ['G', 'Close the gaps between the selected clips'],
  ['Drag on empty timeline', 'Window-select the clips the box touches'],
  ['I / O', 'Set the in / out mark for a ranged render'],
  ['X', 'Clear the in / out marks'],
  ['Alt+I / Alt+O', 'Trim the selected clip in / out to the playhead'],
  ['Ctrl+L / Ctrl+Shift+L', 'Link / unlink selected clips'],
  ['Ctrl+A', 'Select all clips'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+I / Ctrl+Shift+I', 'Import media / import folder'],
  ['Ctrl+N / Ctrl+O', 'New / open project'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'],
  ['Ctrl+R', 'Render a preview of the range into the viewer'],
  ['Ctrl+Shift+R', 'Export a file to disk'],
  ['P', 'Play rendered spans / composite live'],
  ['+ / -', 'Zoom timeline in / out'],
  ['Shift+Z', 'Zoom to fit'],
  ['Ctrl+Wheel', 'Zoom timeline at the pointer'],
  ['Ctrl+Drag in timeline', 'Scrub the playhead'],
  ['Drag on preview', 'Reposition the crop frame'],
  ['Shift+R', 'Reset framing'],
  ['1 / 2 / 3', 'Frame left / center / right'],
  ['Ctrl+T', 'Add a text card at the playhead'],
  ['T', 'Drop a transition on the nearest cut'],
  ['Double-click a cut', 'Drop a transition there'],
  ['Ctrl+D', 'Duplicate the selected clips'],
  ['A', 'Toggle animation on the selected text card'],
  ['N', 'Toggle snapping'],
  ['B', 'Show / hide the QuickBin'],
  ['Double-click in the bin', 'Put that clip on the timeline at the playhead'],
  ['M', 'Mute or unmute the first audio track'],
];
$('#shortcutList').innerHTML = SHORTCUTS
  .map((s) => '<kbd>' + escapeHtml(s[0]) + '</kbd><span>' + escapeHtml(s[1]) + '</span>').join('');
$('#btnShortcuts').addEventListener('click', () => { $('#modal').hidden = false; });
$('#modalClose').addEventListener('click', () => { $('#modal').hidden = true; });

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const ctrl = e.ctrlKey || e.metaKey;
  const frame = 1 / state.out.fps;
  let handled = true;

  if (ctrl && e.key.toLowerCase() === 's') { saveProject(e.shiftKey); }
  else if (ctrl && e.key.toLowerCase() === 'o') { openProject(); }
  else if (ctrl && e.key.toLowerCase() === 'n') { newProject(); }
  else if (ctrl && e.key.toLowerCase() === 'i') { (e.shiftKey ? window.api.pickFolder() : window.api.pickMedia()).then(importPaths); }
  else if (ctrl && e.key.toLowerCase() === 'r') { e.shiftKey ? doRender() : doPreviewRender(); }
  else if (ctrl && e.key.toLowerCase() === 'z') { e.shiftKey ? redo() : undo(); }
  else if (ctrl && e.key.toLowerCase() === 'y') { redo(); }
  else if (ctrl && e.key.toLowerCase() === 'a') { selectAll(); }
  else if (ctrl && e.key.toLowerCase() === 'l') { e.shiftKey ? unlinkSelected() : linkSelected(); }
  else if (ctrl && e.key.toLowerCase() === 'k') { splitAtPlayhead(); }
  else if (ctrl && e.key.toLowerCase() === 't') { addTextCard(); }
  else if (ctrl && e.key.toLowerCase() === 'd') { duplicateSelected(); }
  else if (e.key === ' ' || e.key.toLowerCase() === 'k') { togglePlay(); }
  else if (e.key.toLowerCase() === 'j') { seek(state.playhead - 1); }
  else if (e.key.toLowerCase() === 'l') { seek(state.playhead + 1); }
  else if (e.key === 'ArrowLeft') { seek(state.playhead - (e.shiftKey ? 1 : frame)); }
  else if (e.key === 'ArrowRight') { seek(state.playhead + (e.shiftKey ? 1 : frame)); }
  else if (e.key === 'Home') { seek(0); }
  else if (e.key === 'End') { seek(projectDuration()); }
  else if (e.key.toLowerCase() === 's') { splitAtPlayhead(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selTransition) deleteTransition(); else deleteSelected(e.shiftKey);
  }
  else if (e.key.toLowerCase() === 't' && !ctrl) { addTransition(state.lastTransitionType); }
  else if (e.key.toLowerCase() === 'i') { e.altKey ? trimToPlayhead('in') : setInPoint(); }
  else if (e.key.toLowerCase() === 'o') { e.altKey ? trimToPlayhead('out') : setOutPoint(); }
  else if (e.key.toLowerCase() === 'x') { clearRange(); }
  else if (e.key.toLowerCase() === 'g' && !ctrl) { closeGaps(); }
  else if (e.key.toLowerCase() === 'p') {
    const cb = $('#usePreviewRender');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  }
  else if (e.key === '+' || e.key === '=') { zoomTimeline(1.25); }
  else if (e.key === '-' || e.key === '_') { zoomTimeline(1 / 1.25); }
  else if (e.shiftKey && e.key.toLowerCase() === 'z') { zoomFit(); }
  else if (e.shiftKey && e.key.toLowerCase() === 'r') { $('#btnResetFrame').click(); }
  else if (e.key === '1') { $('#btnFrameLeft').click(); }
  else if (e.key === '2') { $('#btnFrameCenter').click(); }
  else if (e.key === '3') { $('#btnFrameRight').click(); }
  else if (e.key.toLowerCase() === 'a' && !ctrl) { toggleCardAnimation(); }
  else if (e.key.toLowerCase() === 'b' && !ctrl) { toggleBin(); }
  else if (e.key.toLowerCase() === 'n') {
    state.snap = !state.snap;
    $('#snapToggle').checked = state.snap;
    log('Snapping ' + (state.snap ? 'on' : 'off'));
  }
  else if (e.key.toLowerCase() === 'm') {
    const t = state.tracks.find((x) => x.type === 'audio');
    if (t) { t.muted = !t.muted; markDirty(); renderAll(); }
  }
  else if (e.key === 'F5') { location.reload(); }
  else if (e.key === 'Escape') { $('#modal').hidden = true; setSelection([], false); }
  else handled = false;

  if (handled) e.preventDefault();
});

// The unsaved-changes prompt lives in the main process (see win.on('close')); a
// beforeunload handler here would block the close silently instead of asking.
window.api.onRequestSave(async () => {
  try {
    const r = await window.api.saveProject(serialize(), state.filePath);
    if (r.canceled) { window.api.saveResult(false); return; }
    state.filePath = r.filePath;
    markClean();
    window.api.saveResult(true);
  } catch (e) {
    log('Save before quit failed: ' + e.message);
    window.api.saveResult(false);
  }
});
window.addEventListener('resize', renderRuler);

// ---- text cards ----------------------------------------------------------

$('#btnAddText').addEventListener('click', () => addTextCard());
$('#btnAddTransition').addEventListener('click', () => addTransition(state.lastTransitionType));
$('#btnDelTransition').addEventListener('click', () => deleteTransition());

// Closing the drawer just clears the selection - the drawer follows the selected card.
$('#btnCloseText').addEventListener('click', () => setSelection([], false));

// Drag the inspector's left edge to widen it. Only the middle column gives up space -
// the left third stays exactly one third, holding nothing but the preview.
$('#inspectorResize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = $('#inspectorCol').getBoundingClientRect().width;
  const move = (ev) => {
    const w = clamp(startW - (ev.clientX - startX), 300, Math.min(760, window.innerWidth * 0.45));
    document.documentElement.style.setProperty('--insp-w', w + 'px');
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
});

/**
 * Duplicate the selection. Copies land one clip-length to the right, which makes
 * Ctrl+D the fast way to build a sequence of similar cards.
 */
function duplicateSelected() {
  const sel = selectedClips();
  if (!sel.length) return;
  pushUndo();
  const ids = new Set();
  for (const { clip } of sel) for (const c of linkGroup(clip)) ids.add(c.id);

  const newLinks = new Map();
  const created = [];
  for (const track of state.tracks) {
    if (track.locked) continue;
    for (const c of [...track.clips]) {
      if (!ids.has(c.id)) continue;
      const copy = JSON.parse(JSON.stringify(c));
      copy.id = nextId();
      copy.start = clipEnd(c);
      if (c.linkId) {
        if (!newLinks.has(c.linkId)) newLinks.set(c.linkId, nextId());
        copy.linkId = newLinks.get(c.linkId);
      }
      track.clips.push(copy);
      created.push(copy.id);
    }
  }
  sortTracks();
  setSelection(created, false);
  markDirty();
  renderAll();
  log('Duplicated ' + created.length + ' clip(s).');
}

/** Toggle the animation switch on every selected text card. */
function toggleCardAnimation() {
  const cards = selectedClips().map((x) => x.clip).filter((c) => c.kind === 'text');
  if (!cards.length) return;
  pushUndo();
  const on = !cards[0].card.animEnabled;
  for (const c of cards) c.card.animEnabled = on;
  markDirty();
  renderAll();
  log('Card animation ' + (on ? 'on' : 'off') + '.');
}

TextUI.init({
  container: $('#textPanel'),
  getFonts: async () => {
    try { return await window.api.listFonts(); } catch (e) { return ['Segoe UI', 'Arial']; }
  },
  listPresets: () => window.api.listPresets(),
  saveLibraryPreset: async (kind, name, data) => {
    await window.api.savePreset(kind, name, data);
    await TextUI.reloadPresets();
    log('Saved ' + kind + ' preset "' + name + '".');
  },
  loadLibraryPreset: (kind, name) => window.api.loadPreset(kind, name),
  deleteLibraryPreset: async (kind, name) => {
    await window.api.deletePreset(kind, name);
    await TextUI.reloadPresets();
    log('Deleted ' + kind + ' preset "' + name + '".');
  },
  exportPreset: async (kind, data) => {
    const p = await window.api.exportPreset(kind, data);
    if (p) log('Exported preset to ' + p);
  },
  importPreset: async (kind) => {
    const d = await window.api.importPreset(kind);
    if (d) log('Imported a ' + kind + ' preset.');
    return d;
  },
  getClip: () => selectedTextClip(),
  getLocalTime: () => {
    const c = selectedTextClip();
    return c ? state.playhead - c.start : 0;
  },
  seekLocal: (t) => {
    const c = selectedTextClip();
    if (c) seek(c.start + t);
  },
  // The panel snapshots once per gesture, then reports the change.
  onEdit: () => pushUndo(),
  onChanged: () => { markDirty(); drawPreview(); },
  log,
}).then(() => {
  log('Loaded ' + TextUI.fonts.length + ' system fonts.');
  renderInspector();
});

// ---- boot ----------------------------------------------------------------
resizeCanvas();
newProject();
refreshCacheBands(true);
log('Ready. Drop files or a folder anywhere to import.');
