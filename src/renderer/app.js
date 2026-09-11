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
  /** Caption settings - the look and the phrasing, not the words. Settings like
   *  Tighten's: changing one snapshots no undo entry, it only changes what the next
   *  Generate would produce. Saved in the .scut so a project keeps its caption style. */
  captions: Object.assign({}, Captions.DEFAULTS),
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
  // A still is an <img>: no decoder, no clock, nothing to seek. It lives in the same map
  // as the media elements because everything downstream - the compositor, the framing
  // draw, eviction - only ever asks it for a picture and its natural size.
  if (clip.kind === 'image') {
    el = document.createElement('img');
    el.src = 'file:///' + clip.src.replace(/\\/g, '/').replace(/^\/+/, '');
    mediaEls.set(clip.id, el);
    return el;
  }
  el = document.createElement(clip.kind === 'video' ? 'video' : 'audio');
  el.src = 'file:///' + clip.src.replace(/\\/g, '/').replace(/^\/+/, '');
  el.preload = 'auto';
  if (clip.kind === 'video') el.muted = true; // audio always comes from the paired audio clip
  el.load();
  mediaEls.set(clip.id, el);
  return el;
}

/** Does this element have a picture to draw right now? */
function frameReady(el) {
  if (!el) return false;
  if (el.tagName === 'IMG') return !!(el.complete && el.naturalWidth);
  return el.readyState >= 2 && !!el.videoWidth;
}
/** Natural pixel size of whatever kind of element this is. */
function elW(el) { return (el && (el.videoWidth || el.naturalWidth)) || 0; }
function elH(el) { return (el && (el.videoHeight || el.naturalHeight)) || 0; }

function dropMedia(clipId) {
  const el = mediaEls.get(clipId);
  if (el && el.tagName !== 'IMG') {
    try { el.pause(); } catch (e) {}
    el.removeAttribute('src');
    el.load();
  }
  mediaEls.delete(clipId);
  dropLayerSurface(clipId);
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
/**
 * Where the meter's two bars and its dB scale go, for a canvas of height `H`.
 *
 * Pure, and separate from the drawing, so `smoke-meter.js` can assert the invariants at
 * every height the panel can produce instead of squinting at pixels: the bars never
 * overlap each other, never run into the scale strip, and never get thinner than their
 * own labels.
 *
 * It exists because the layout used to be constants - rows at 16 and 42, the scale pinned
 * to `H - 4` - which needs about 70 px. The canvas is a flex child of a fixed-height
 * panel, so a tight panel squeezed it below that and the constants then drew the loudness
 * bar straight through the scale with the "LUFS" label running under it. Nothing clipped
 * and nothing errored; it just became unreadable, which is the failure a fixed layout in
 * a flexible box always has.
 */
function meterLayout(H) {
  const scaleH = 13;                       // the dB numbers along the bottom
  const topPad = 4;
  const gap = 12;                          // between the two bars, and where the sign goes
  const avail = Math.max(20, H - scaleH - topPad);
  let g = gap;
  let barH = Math.min(14, Math.floor((avail - g) / 2));
  // Below about 46px the two bars and a 12px gap no longer fit. The BAR is the thing that
  // has to stay legible - it carries its own label - so the gap gives way first, down to
  // the 4px the target sign needs. Letting the bar shrink instead drew rows thinner than
  // the text on them, and letting neither give ran the loudness bar into the dB scale.
  if (barH < 6) { barH = 6; g = Math.max(4, avail - 2 * barH); }
  const peakY = topPad + Math.max(0, Math.floor((avail - g - barH * 2) / 2));
  const loudY = peakY + barH + g;
  return { scaleH, topPad, gap: g, barH, peakY, loudY, barsBottom: loudY + barH };
}

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

  /*
   * EVERY VERTICAL POSITION HERE IS DERIVED FROM `H`, and the left gutter from the width
   * of the widest label. Both used to be constants - a 26 px gutter and rows at 16 / 42
   * with the scale pinned to `H - 4` - which needs about 70 px of canvas. The canvas is a
   * flex child of a fixed-height panel, so when the panel got tight it was squeezed below
   * that, and the constants then drew the loudness bar straight through the dB scale with
   * the "LUFS" label running under it. Nothing clipped or errored; it just became
   * unreadable, which is the failure mode a fixed layout in a flexible box always has.
   *
   * The gutter is measured rather than assumed for the same reason: "LUFS" at 9 px is
   * about 24 px wide and the gutter was 26, so a font fallback one size bigger put the
   * label under the bar.
   */
  g.font = '8px system-ui, sans-serif';
  const gutter = Math.ceil(Math.max(g.measureText('LUFS').width, g.measureText('PK').width)) + 6;
  const x0 = gutter, x1 = W - 6;
  const span = x1 - x0;

  const { scaleH, gap, barH, peakY, loudY, barsBottom } = meterLayout(H);
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
    g.font = '8px system-ui, sans-serif';
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
    g.moveTo(x, peakY - 3);
    g.lineTo(x, barsBottom + 3);
    g.stroke();
  }
  for (const db of [-60, -40, -20, -6, 0]) {
    g.fillText(String(db), Math.round(at(db)), H - 3);
  }

  // ---- peak bar -------------------------------------------------------
  label('PK', peakY + barH - 3);
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
  label('LUFS', loudY + barH - 3);
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
  const signH = Math.min(6, gap - 4);
  g.fillStyle = '#e8ebf0';
  g.beginPath();
  g.moveTo(tx - 4, loudY - signH - 2);
  g.lineTo(tx + 4, loudY - signH - 2);
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
    if (m.kind === 'image') {
      // A still has no decoder and no source duration to run out of, so - exactly like a
      // text card - `in` stays 0, the clip's length is simply `out`, and `mediaDuration`
      // is left effectively unbounded so it can be stretched as far as anyone wants.
      vt.clips.push({
        id: nextId(), src: m.path, name: m.name, kind: 'image',
        start: cursor, in: 0, out: m.duration, mediaDuration: 3600,
        srcW: m.width, srcH: m.height, fps: 0,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
        linkId: null,
      });
    } else if (m.kind === 'video') {
      vt.clips.push({
        id: nextId(), src: m.path, name: m.name, kind: 'video',
        start: cursor, in: 0, out: m.duration, mediaDuration: m.duration,
        srcW: m.width, srcH: m.height, fps: m.fps,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
        linkId: m.hasAudio ? linkId : null,
        // Screen-recording telemetry, when the file has a sidecar next to it. ABSENT
        // otherwise, which is the normal case for anything not recorded in ShortCut -
        // see the contract at the top of src/screen.js. Plain JSON, like everything else
        // on a clip, because undo is JSON.stringify of the track list.
        ...(m.screen ? { screen: m.screen } : {}),
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

/**
 * Every selected text clip, in timeline order (top track first, then by start).
 *
 * `selectedClips()` already walks the tracks in display order, so the first entry is a
 * stable, predictable choice of LEAD - the card the panel actually shows and edits.
 */
function selectedTextClips() {
  return selectedClips().filter((x) => x.clip.kind === 'text').map((x) => x.clip);
}

/**
 * The text clip the editor panel edits: the lead of the selection, or null.
 *
 * With several cards selected the panel still edits ONE card - the lead - and every
 * property it changes is mirrored onto the rest by `syncTextPeers()`. Editing the lead
 * and copying the delta is what keeps the panel itself single-card: it reads one card,
 * writes one card, and knows nothing about the selection.
 */
function selectedTextClip() {
  const sel = selectedTextClips();
  return sel.length ? sel[0] : null;
}

/**
 * Properties that belong to a card rather than to its look, and so never propagate to
 * the other selected cards. They are all CONTENT: the wording, the spoken word times,
 * and which of those words are keywords - copying any of them across a multi-selection
 * would give every caption the lead's text and the lead's timing.
 */
const TEXT_PEER_SKIP = new Set(['text', 'words', 'highlight']);

/** Every path whose value differs, walking plain objects and treating arrays as leaves. */
function cardDiff(cur, prev, out, prefix) {
  for (const k of Object.keys(cur)) {
    const path = prefix ? prefix + '.' + k : k;
    if (TEXT_PEER_SKIP.has(path)) continue;
    const a = cur[k];
    const b = prev ? prev[k] : undefined;
    const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
    // An array is replaced whole - adding an animation layer or a gradient stop is one
    // change to `anims`, not a per-index reconciliation nobody would benefit from.
    if (plain(a) && plain(b)) cardDiff(a, b, out, path);
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push([path, a]);
  }
  return out;
}

/** The lead card as it was when this gesture began, so the change can be isolated. */
let textEditBase = null;

function snapshotTextEdit() {
  const lead = selectedTextClip();
  textEditBase = lead ? JSON.parse(JSON.stringify(lead.card)) : null;
}

/**
 * Mirror what just changed on the lead card onto the other selected cards.
 *
 * Only the properties that ACTUALLY changed are copied. Applying the lead's whole card
 * would be far simpler and quite wrong: selecting five differently-styled cards and
 * nudging the size by one pixel would flatten four of them to the lead's look. A diff
 * against the start of the gesture means one nudge changes one property, everywhere.
 */
function syncTextPeers() {
  const sel = selectedTextClips();
  if (sel.length < 2 || !textEditBase) { snapshotTextEdit(); return 0; }
  const lead = sel[0];
  const changes = cardDiff(lead.card, textEditBase, []);
  if (!changes.length) return 0;
  for (const clip of sel.slice(1)) {
    for (const [path, value] of changes) {
      const parts = path.split('.');
      const last = parts.pop();
      let target = clip.card;
      for (const k of parts) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        target = target[k];
      }
      target[last] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }
  }
  snapshotTextEdit();
  return changes.length;
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
  pruneLayerSurfaces();
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
    /**
     * Clicking the head selects everything on the track.
     *
     * A track is not a third kind of selection - it IS its clips. Tighten, the audio
     * chain and Captions all work over a selection already, so selecting a track is the
     * whole feature: "clean up this voice-over track" becomes one click rather than a
     * marquee that has to catch every clip and nothing on the track below.
     *
     * Shift adds, exactly as it does on the timeline, so two tracks can be worked at
     * once. The buttons stopPropagation so muting a track does not also select it.
     */
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (t.locked) { log('Track ' + t.name + ' is locked.'); return; }
      const ids = [];
      for (const c of t.clips) for (const g of linkGroup(c)) ids.push(g.id);
      setSelection(ids, e.shiftKey);
      state.selTransition = null;
      renderAll();
    });

    d.querySelectorAll('button').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
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
      if (Tracker.hasTracks(c)) drawClipTrackConf(el, c);
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

/**
 * The confidence strip: where a solved track is sure, and where it is not.
 *
 * This is half of what makes tracking usable rather than merely present. A track that
 * lost its point looks exactly like one that did not - the callout is simply in the wrong
 * place for forty frames - so confidence is drawn along the clip, at the time it applies
 * to, and a dip is visible without opening anything. The worst track wins each column:
 * one lost point is a problem even when three others are fine.
 *
 * Painted into a canvas keyed like the waveform's, so dragging a clip moves the strip
 * rather than repainting it on every mouse move.
 */
const trackConfCanvases = new Map();
function drawClipTrackConf(el, c) {
  const wPx = Math.round(Math.max(6, (c.out - c.in) * state.pxPerSec));
  if (wPx < 12) return;
  const w = Math.min(WAVE_MAX_PX, wPx);
  const h = 4;
  const key = c.id + '|' + Tracker.hasTracks(c) + '|' + c.in.toFixed(4) + '|' + c.out.toFixed(4) +
    '|' + w + '|' + (c.tracks || []).map((t) =>
      t.id + ':' + t.points.length + ':' + Tracker.fixCount(t) +
      ':' + Tracker.worstIn(t, c.in, c.out).toFixed(3)).join(',');
  let cv = trackConfCanvases.get(key);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.className = 'trackconf';
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    const per = (c.out - c.in) / w;
    for (let x = 0; x < w; x++) {
      const t0 = c.in + x * per, t1 = t0 + per;
      let worst = 1, repaired = false;
      for (const tk of c.tracks) {
        const s = Tracker.sampleAt(tk, (t0 + t1) / 2);
        const span = Math.min(Tracker.worstIn(tk, t0, t1), s ? s.c : 1);
        if (span < worst) worst = span;
        // A repaired sample stops being an alarm but must not become invisible: the
        // machine still failed here, and that is worth being able to see when the shot
        // looks wrong later.
        for (const q of tk.points) {
          if (q.fix && q.t >= t0 - 1e-6 && q.t <= t1 + 1e-6) { repaired = true; break; }
        }
      }
      // Sure is quiet, repaired is amber, lost is loud. A strip that shouted at a good
      // track would be ignored by the time it mattered.
      g.fillStyle = (worst < Tracker.DEFAULTS.minConf && !repaired)
        ? 'rgba(224,83,63,.95)'
        : repaired
          ? 'rgba(224,178,65,.9)'
          : 'rgba(120,220,190,' + (0.18 + 0.35 * (1 - worst)).toFixed(3) + ')';
      g.fillRect(x, 0, 1, h);
    }
    if (trackConfCanvases.size > 300) trackConfCanvases.clear();
    trackConfCanvases.set(key, cv);
  }
  el.appendChild(cv);
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

/**
 * The inspector's telemetry line: what a screen recording knows about the cursor.
 *
 * Empty for everything that is not a video clip with telemetry on it, which is most
 * clips - the row appears when there is something to report and stays out of the way
 * otherwise.
 */
function telemetryRow(c) {
  if (!c || c.kind !== 'video') return '';
  const t = clipTelemetry(c);
  if (!t) return '';
  const clicks = t.events.filter((e) => e.type === ScreenTel.DOWN).length;
  return '<b>Cursor</b><span title="Recorded alongside the capture. Timed from the ' +
    'video\'s first frame, and normalised to the captured display.">' +
    t.events.length + ' samples' + (t.clicks ? ', ' + clicks + ' clicks' : ', no click data') +
    '</span>';
}

function renderInspector() {
  const box = $('#inspector');
  const sel = selectedClips();
  renderTransitionPanel();
  renderCaptionsPanel();

  // A selected text card opens the editor drawer on the far right. The left column keeps
  // showing the normal clip inspector, so the preview area is never resized by it.
  const textClip = selectedTextClip();
  $('#textPanelHead').hidden = !textClip;
  $('#textPanel').hidden = !textClip;
  if (textClip) {
    const cards = selectedTextClips();
    $('#textCardMeta').textContent = cards.length > 1
      ? cards.length + ' cards - editing all'
      : fmtTc(textClip.start) + '  +' + (textClip.out - textClip.in).toFixed(2) + 's';
    $('#textCardMeta').title = cards.length > 1
      ? 'The panel shows the first card. Every change is applied to all ' +
        cards.length + ' selected cards; the wording and the word timings stay their own.'
      : '';
  }
  // A fresh selection is a fresh gesture baseline, or the first edit would replay every
  // difference between the old lead and the new one onto the whole selection.
  snapshotTextEdit();
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
    // A multi-selection is what a track head produces, so the audio chain and Tighten
    // both have to be reachable from one - "clean up this whole voice track" is the
    // commonest thing anybody wants to do to a track.
    const fxTargets = audioFxTargets(sel);
    if (fxTargets.length) {
      const lead = allClips().find((x) => x.clip === fxTargets[0]);
      box.appendChild(audioFxPanel(fxTargets[0], lead ? lead.track.name : null, fxTargets.slice(1)));
    }
    if (sel.some((x) => tightenAudioFor(x.clip))) box.appendChild(tightenPanel());
    return;
  }
  const c = row.clip;
  const isText = c.kind === 'text';
  const isStill = c.kind === 'image';
  // A still and a card share every "there is no source clock here" row: no in/out to
  // show, no link, and nothing to set a volume on.
  const noClock = isText || isStill;
  const source = isText ? 'text card'
    : isStill ? (c.srcW ? c.srcW + 'x' + c.srcH + ' still' : 'still')
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
    (noClock ? '' : '<b>In / Out</b><span>' + fmtTc(c.in) + ' - ' + fmtTc(c.out) + '</span>') +
    (noClock ? '' : '<b>Linked</b><span>' + (c.linkId ? 'yes' : 'no') + '</span>') +
    // Screen telemetry is worth a line precisely because its ABSENCE is normal: an OBS
    // or Screen Studio capture never has any, and the user needs to know that before
    // they go looking for auto-zoom on it.
    (telemetryRow(c)) +
    (noClock ? '' :
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
  // Above the stack, because the stack READS it: a binding row on an effect is only
  // offered once something has been tracked, so the tracker is the first of the two.
  const place = imagePlacePanel(c);
  if (place) box.appendChild(place);
  const trk = trackPanel(c);
  if (trk) box.appendChild(trk);
  const fx = clipFxPanel(c);
  if (fx) box.appendChild(fx);
  const keys = clipKeyPanel(c);
  if (keys) box.appendChild(keys);
  syncFramingControls();
}

/**
 * Once-per-gesture undo for the CLIP inspector's controls.
 *
 * `TextUI.control()` and `TextUI.keyStrip()` have this guard built in, but it is bound to
 * the text panel's own `onEdit`. A panel that passes its own hooks - which every clip
 * panel must, because it is editing timeline state rather than a card - replaces the
 * guard along with the hook, and then a slider drag or a burst of wheel-nudging pushes
 * one undo entry per notch instead of one per gesture. This is the same guard, owned by
 * the clip inspector: opened on the first edit of a gesture and closed by whatever ends
 * it - pointerup, a blur, or the wheel handler's own 400 ms idle timer.
 */
let inspectorGesture = false;
function inspectorEdit() {
  if (inspectorGesture) return;
  inspectorGesture = true;
  pushUndo();
}
function inspectorEditEnd() { inspectorGesture = false; }
document.addEventListener('pointerup', inspectorEditEnd);
document.addEventListener('pointercancel', inspectorEditEnd);

/**
 * Which clips are OFFERED an effect stack.
 *
 * Picture clips, and deliberately not text cards. Two reasons, and the second is the real
 * one: a card already owns a transform, an opacity, a rotation, a glow and a drop shadow
 * in its own model, with its own keyframes and its own preset system, so a second and
 * competing `transform` effect beside all of that would be a coin toss for the author
 * every time. And `#textPanel` shares a scrolling column with `#inspector`, so a stack
 * panel above it pushes the card editor off the bottom of the screen the moment a card is
 * selected - `tools/smoke-text2.js` caught that, which is what it is for.
 *
 * `compositeLayers()` still runs the stack for ANY layer that carries one, text included,
 * so widening this set is all a later step needs to do.
 */
const FX_KINDS = new Set(['video', 'image']);

/**
 * Which effect rows are rolled up, by effect id.
 *
 * UI state, so it lives HERE and never on the clip. Undo is `JSON.stringify` of the track
 * list and the same shape is the `.scut` file - a collapsed row is not a fact about the
 * edit, and putting it on the effect would mean rolling a row up dirtied the project and
 * showed up as a change in every undo snapshot.
 *
 * Keyed by `fx.id`, which is stable for the life of an effect and is exactly what the
 * cache key strips out for being identity rather than pixels. Ids are never reused, so a
 * deleted effect's entry is dead weight and nothing worse; the set is rebuilt every
 * session anyway.
 */
const fxCollapsed = new Set();

/**
 * The visual effect stack for the selected clip.
 *
 * Built entirely from `FX.DEFS`: the rows are `TextUI.control` over each type's schema,
 * so every parameter is a slider AND a typable box AND scroll-adjustable AND resettable
 * without any of that being written twice, and each numeric parameter gets the same
 * `TextUI.keyStrip()` the clip's own keyframe panel uses. Adding an effect type is an
 * entry in `FX.DEFS` and nothing else.
 *
 * ORDER MATTERS, so it is draggable as well as button-driven. Blur after grade is not
 * blur before grade: the grade lifts what the blur has already averaged together. The
 * arrows exist alongside the drag because a drag is not reachable from the keyboard and
 * is not reachable from a smoke suite either.
 *
 * Structural edits (add, remove, reorder, bypass) snapshot and rebuild here as ONE undo
 * entry; parameter edits go through the inspector's once-per-gesture guard above.
 */
/**
 * Every motion track on the timeline that something could bind to.
 *
 * Deliberately not just this clip's. A callout, a logo or an arrow is almost never on the
 * same clip as the thing it points at - it is a separate clip on a track above - so a
 * picker that only offered the clip's own tracks would be useless for the commonest case
 * there is.
 */
function bindableTracks(forClip) {
  const out = [];
  for (const { clip } of allClips()) {
    if (!Tracker.hasTracks(clip)) continue;
    for (const tk of clip.tracks) {
      const own = clip.id === forClip.id;
      out.push({
        clipId: clip.id,
        trackId: tk.id,
        value: clip.id + '::' + tk.id,
        label: tk.name + (own ? '' : '  \u2014 ' + clip.name) +
          (Tracker.isSolved(tk) ? '' : '  (not solved)'),
        own,
      });
    }
  }
  return out;
}

/**
 * The rows that make an effect follow a track: which track, how hard, how smoothly.
 *
 * Shared by the effect stack and by an image's placement panel, because they are the same
 * controls over the same data and the second copy is always the one that goes stale.
 */
function fxBindSection(clip, fx, d, rowHooks, edit) {
  const el = TextUI.el;
  const nodes = [];
  const opts = bindableTracks(clip);
  const bound = fx.bind && fx.bind.track;
  const owner = bound ? bindOwner(clip, fx.bind) : null;
  const missing = bound && (!owner || !Tracker.trackById(owner, fx.bind.track));

  const brow = el('div', 'tc-row');
  brow.appendChild(el('label', 'tc-label', d.bind.label || 'Follow a track'));
  const sel = el('select');
  const none = el('option');
  none.value = '';
  none.textContent = 'Not bound';
  sel.appendChild(none);
  for (const o of opts) {
    const opt = el('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  if (missing) {
    const opt = el('option');
    opt.value = 'missing';
    opt.textContent = 'a deleted track';
    sel.appendChild(opt);
  }
  sel.value = missing ? 'missing'
    : (bound ? ((fx.bind.clip || clip.id) + '::' + fx.bind.track) : '');
  sel.disabled = !opts.length && !bound;
  sel.title = d.bind.hint || '';
  sel.addEventListener('change', () => edit(() => {
    if (!sel.value || sel.value === 'missing') { delete fx.bind; return; }
    const [clipId, trackId] = sel.value.split('::');
    const next = Object.assign({ offX: 0, offY: 0, strength: 1, smooth: 0 }, fx.bind || {});
    next.track = trackId;
    // The field is absent for the ordinary same-clip case, so nothing that never crosses
    // a clip boundary carries it at all.
    if (clipId === clip.id) delete next.clip; else next.clip = clipId;
    fx.bind = next;
  }));
  brow.appendChild(sel);
  nodes.push(brow);

  if (!opts.length && !bound) {
    nodes.push(el('div', 'tc-hint',
      'Nothing on the timeline has been tracked yet. Add a tracker to a video clip in ' +
      'Motion tracking, solve it, and it will be offered here - including from other clips.'));
    return nodes;
  }
  if (missing) {
    nodes.push(el('div', 'tc-hint fx-warn',
      'The track this follows is gone, so it is drawing the values below instead. ' +
      'Pick another, or set it to Not bound.'));
    return nodes;
  }
  if (!bound) return nodes;

  if (owner && owner.id !== clip.id) {
    nodes.push(el('div', 'tc-hint',
      'Following a track on ' + owner.name + '. The two clips are locked together in ' +
      'time - move one without the other and this follows the new alignment.'));
  }

  const dur = Math.max(0.001, clip.out - clip.in);
  const bindDefaults = { bind: { offX: 0, offY: 0, strength: 1, smooth: 0 } };
  const C = (spec) => TextUI.control(spec, fx, bindDefaults, rowHooks);
  nodes.push(C({ path: 'bind.strength', label: 'Follow strength', type: 'range',
    min: 0, max: 2, step: 0.01, digits: 2 }));
  nodes.push(C({ path: 'bind.smooth', label: 'Smoothing', type: 'range',
    min: 0, max: 1, step: 0.01, unit: 's', digits: 2 }));
  nodes.push(C({ path: 'bind.offX', label: 'Follow offset X', type: 'range',
    min: -1, max: 1, step: 0.002, digits: 3 }));
  nodes.push(C({ path: 'bind.offY', label: 'Follow offset Y', type: 'range',
    min: -1, max: 1, step: 0.002, digits: 3 }));
  nodes.push(el('div', 'tc-hint',
    'Strength scales how far this moves against how far the tracked point moved: 1 ' +
    'follows exactly, 0.4 travels 40% as far, 0 pins it where the tracker was placed. ' +
    'Smoothing averages the path over time, for a track that is accurate but jittery.'));

  // The binding keyframes its OWN numbers, on its own `keys` object - which is how
  // "follow hard through this bit, barely at all through that bit" is expressed. `Anim`
  // only ever touches a `.keys` object, so `fx.bind` is a keyframe holder for free.
  if (!fx.bind.keys) fx.bind.keys = {};
  const keyHooks = Object.assign({}, rowHooks, {
    dur,
    getLocalTime: () => clamp(state.playhead - clip.start, 0, dur),
    seekLocal: (t) => seek(clip.start + t),
  });
  const BIND_KEYS = [
    { prop: 'strength', label: 'Follow strength', min: 0, max: 2, step: 0.01, base: 1 },
    { prop: 'offX', label: 'Follow offset X', min: -1, max: 1, step: 0.002, base: 0 },
    { prop: 'offY', label: 'Follow offset Y', min: -1, max: 1, step: 0.002, base: 0 },
  ];
  nodes.push(TextUI.section('bindkeys_' + fx.id, 'Follow keyframes', (kb) => {
    kb.appendChild(el('div', 'tc-hint',
      'Keys are times within this clip. Keyframe Follow strength to track hard through ' +
      'one stretch and hold still through another.'));
    for (const spec of BIND_KEYS) {
      const base = isFinite(Number(fx.bind[spec.prop])) ? Number(fx.bind[spec.prop]) : spec.base;
      kb.appendChild(TextUI.keyStrip(spec.prop, Object.assign({}, keyHooks, {
        spec: Object.assign({}, Anim.propSpec(spec.prop), spec, { base }),
        getKeys: () => Anim.trackFor(fx.bind, spec.prop, true),
        clear: () => { Anim.trackFor(fx.bind, spec.prop, true).length = 0; Anim.pruneKeys(fx.bind); },
        emptyHint: 'No keys - ' + spec.label + ' holds the value above.',
      })));
    }
  }));

  const taken = FX.boundParams(fx.type);
  nodes.push(el('div', 'tc-hint',
    'The track is writing ' + taken.join(' and ') + ' every frame, so the sliders and ' +
    'keyframes for those are ignored while it is bound. Everything else still animates.'));
  return nodes;
}

function clipFxPanel(clip) {
  if (!clip || !FX_KINDS.has(clip.kind)) return null;
  const el = TextUI.el;
  const box = el('div', 'fx-box');
  FX.normalizeClip(clip);

  const head = el('div', 'fx-head');
  head.appendChild(el('b', null, 'Effects'));
  const count = FX.active(clip).length;
  head.appendChild(el('span', 'tc-hint',
    !clip.fx ? 'none' : clip.fx.length + ' in stack' + (count < clip.fx.length ? ', ' + count + ' on' : '')));
  if ((clip.fx || []).length > 1) {
    const anyOpen = clip.fx.some((f) => !fxCollapsed.has(f.id));
    const all = el('button', 'mini', anyOpen ? 'Collapse all' : 'Expand all');
    all.title = 'Roll every effect in this stack up or down. Nothing is edited.';
    all.addEventListener('click', () => {
      for (const f of clip.fx) {
        if (anyOpen) fxCollapsed.add(f.id); else fxCollapsed.delete(f.id);
      }
      renderInspector();      // UI only: no pushUndo, no markDirty
    });
    head.appendChild(all);
  }
  box.appendChild(head);

  box.appendChild(el('div', 'tc-hint fx-note',
    'Drawn once, by the baker - the preview and the export run the same code. Any clip ' +
    'carrying an effect is composited rather than handed to ffmpeg, so it renders slower ' +
    'than a plain one. Effects do not apply inside a transition window.'));

  // A structural change is one undo entry and a full rebuild.
  const edit = (fn) => {
    pushUndo();
    fn();
    FX.normalizeClip(clip);
    markDirty();
    renderAll();
  };
  const rowHooks = {
    onEdit: inspectorEdit,
    onEditEnd: inspectorEditEnd,
    onChanged: () => { markDirty(); drawPreview(); },
    rebuild: renderInspector,
  };

  const list = el('div', 'fx-list');
  const stack = clip.fx || [];

  stack.forEach((fx, i) => {
    const d = FX.DEFS[fx.type];
    // DELIBERATELY NOT DRAGGABLE. Reordering is the arrow buttons and nothing else.
    //
    // The row used to be an HTML5 drag source, and in Chromium a draggable ancestor
    // starts a native drag from a press anywhere inside it - so every attempt to drag a
    // slider tore the whole row out as a drag image and the value never moved. That was
    // patched by exempting the body, which fixed the sliders and left a drag affordance
    // that was still easy to trigger by accident on the row's own padding, in a panel
    // whose entire purpose is dragging values.
    //
    // The arrows already do the job, they are the only way a keyboard or a smoke suite
    // could ever reorder a stack, and they cannot be triggered by accident. So the drag
    // is gone rather than defended, and `smoke-fx.js` asserts that it stays gone.
    const row = el('div', 'fx-fx' + (fx.enabled === false ? ' off' : ''));

    const bar = el('div', 'fx-fx-head');
    const shut = fxCollapsed.has(fx.id);
    const caret = el('button', 'mini fx-caret', shut ? '\u25b8' : '\u25be');
    caret.title = shut ? 'Show this effect\u2019s controls' : 'Roll this effect up';
    caret.addEventListener('click', () => {
      // Purely how the panel looks: no snapshot, no dirty flag, no redraw of the picture.
      if (fxCollapsed.has(fx.id)) fxCollapsed.delete(fx.id); else fxCollapsed.add(fx.id);
      renderInspector();
    });
    bar.appendChild(caret);
    const on = el('input');
    on.type = 'checkbox';
    on.checked = fx.enabled !== false;
    on.title = 'Bypass this effect';
    on.addEventListener('change', () => edit(() => { fx.enabled = on.checked; }));
    bar.appendChild(on);
    const title = el('b', null, (i + 1) + '. ' + d.label);
    // The title is the other half of the caret: a stack of rolled-up rows is a list, and
    // a list you cannot click is a worse list.
    title.classList.add('fx-title');
    title.addEventListener('click', () => caret.click());
    bar.appendChild(title);
    // Rolled up, the row still has to say what it is doing - a bypassed or motion-blurred
    // effect that looks identical to a plain one is how a stack stops being readable.
    if (shut) {
      const marks = [];
      if (fx.enabled === false) marks.push('bypassed');
      if (fx.keys && Object.keys(fx.keys).some((k) => fx.keys[k].length)) marks.push('keyed');
      if (fx.mblur && fx.mblur.on) marks.push('blur');
      if (fx.gen) marks.push(fx.gen);
      if (marks.length) bar.appendChild(el('span', 'tc-hint', marks.join(' \u00b7 ')));
    }

    const btns = el('div', 'fx-fx-btns');
    const mk = (label, title, fn, disabled) => {
      const b = el('button', 'mini', label);
      b.title = title;
      b.disabled = !!disabled;
      b.draggable = false;
      b.addEventListener('click', fn);
      btns.appendChild(b);
    };
    mk('▲', 'Draw this effect earlier in the stack', () => edit(() => {
      clip.fx.splice(i - 1, 0, clip.fx.splice(i, 1)[0]);
    }), i === 0);
    mk('▼', 'Draw this effect later in the stack', () => edit(() => {
      clip.fx.splice(i + 1, 0, clip.fx.splice(i, 1)[0]);
    }), i === stack.length - 1);
    mk('✕', 'Remove this effect', () => edit(() => { clip.fx.splice(i, 1); }));
    bar.appendChild(btns);
    row.appendChild(bar);

    // An effect on a clip that cannot feed it is not an error - a take can be recorded
    // afterwards, and a clip can be replaced under a stack - but it must not be silent.
    if (d.needs === 'mouse' && !clipHasTake(clip)) {
      row.appendChild(el('div', 'tc-hint fx-warn',
        'No mouse take on this clip, so this draws nothing. Record one with Mouse.'));
    }

    // A `round` shadow that cannot be seen, and why. Read at the PLAYHEAD and from the
    // animated values, because the commonest way to lose the shadow is a keyframe on
    // Inset holding it at 0 - which overrides the slider above and shows up nowhere else.
    if (fx.type === 'round') {
      const dur0 = Math.max(0.001, clip.out - clip.in);
      const tNow = clamp(state.playhead - clip.start, 0, dur0);
      const anim = FX.paramsAt(fx, tNow);
      const why = FX.shadowProblem(anim);
      const keyed = !!(fx.keys && fx.keys.margin && fx.keys.margin.length);
      if (why === 'no-room') {
        row.appendChild(el('div', 'tc-hint fx-warn',
          keyed
            ? 'A keyframe is holding Inset at ' + anim.margin.toFixed(3) + ' here, which ' +
              'overrides the slider above - so the shadow is cast at the frame edge and ' +
              'falls outside it. Clear the Inset keys, or raise that key.'
            : 'Inset is 0, so the shadow is cast at the frame edge and falls outside the ' +
              'frame. Raise Inset to open the gap the shadow needs.'));
      } else if (why === 'pushed-out') {
        const reach = Math.max(Math.abs(anim.offsetX), Math.abs(anim.offsetY));
        row.appendChild(el('div', 'tc-hint fx-warn',
          'Shadow X/Y is offset ' + reach.toFixed(3) + ', further than the ' +
          anim.margin.toFixed(3) + ' Inset opens - so most of the shadow falls outside ' +
          'the frame. Raise Inset, or bring Shadow X/Y under it.'));
      }
    }

    const body = el('div', 'fx-fx-body');
    body.hidden = shut;
    // Belt and braces now that the row is not a drag source either: an explicit `false`
    // here means a future ancestor that becomes draggable cannot silently swallow the
    // controls again, which is the bug this pair of lines exists to make impossible.
    body.draggable = false;
    for (const spec of d.schema) {
      body.appendChild(TextUI.control(spec, fx, { params: d.params }, rowHooks));
    }

    // The binding, built by the one function that knows how - the placement panel for
    // an image shows the same rows, and two copies of this would drift within a week.
    if (d.bind) for (const node of fxBindSection(clip, fx, d, rowHooks, edit)) body.appendChild(node);

    // An imported PNG pointer. A PATH, not the bytes: `clip.fx` is plain JSON that goes
    // into every undo snapshot and into the .scut file, and an inlined image would put a
    // megabyte of base64 into both. `FX.preloadImages()` is what makes a path safe to
    // read from a synchronous draw - see its comment in fx.js.
    if (fx.type === 'cursor') {
      const prow = el('div', 'tc-row');
      prow.appendChild(el('label', 'tc-label', 'PNG pointer'));
      const nm = el('span', 'tc-hint',
        fx.params.image ? String(fx.params.image).split(/[\/]/).pop() : 'built-in arrow');
      nm.title = fx.params.image ||
        'The built-in arrow is drawn as vectors, so it stays sharp at any resolution.';
      prow.appendChild(nm);
      const pick = el('button', 'mini', 'Choose...');
      pick.draggable = false;
      pick.addEventListener('click', async () => {
        const f = await window.api.pickImage();
        if (!f) return;
        pushUndo();
        fx.params.image = f;
        await FX.preloadImages([clip]);
        markDirty();
        renderAll();
      });
      prow.appendChild(pick);
      if (fx.params.image) {
        const clr = el('button', 'mini', 'Clear');
        clr.draggable = false;
        clr.addEventListener('click', () => edit(() => { fx.params.image = ''; }));
        prow.appendChild(clr);
      }
      body.appendChild(prow);
    }

    // The shutter, per effect. `TextUI.set()` needs the object to exist before a control
    // can write into it, so it is created here the way `keyStrip()` creates empty tracks -
    // and `FX.normalize()` prunes it away again when it is off and untouched, so a stack
    // that uses no motion blur still serialises exactly as it did before this existed.
    if (!fx.mblur) fx.mblur = Object.assign({}, FX.MBLUR);
    const varying = FX.timeVarying(fx);
    body.appendChild(TextUI.section('fxmb_' + fx.id, 'Motion blur', (mb) => {
      mb.appendChild(el('div', 'tc-hint',
        varying
          ? 'Samples this effect across the shutter and averages them. Costs one extra ' +
            'pass per sample, so it is the most expensive switch in the panel.'
          : 'This effect paints the same picture at every instant, so the shutter has ' +
            'nothing to average. Keyframe a parameter and it turns on.'));
      mb.appendChild(TextUI.control(
        { path: 'mblur.on', label: 'Motion blur', type: 'check' }, fx, { mblur: FX.MBLUR }, rowHooks));
      mb.appendChild(TextUI.control(
        { path: 'mblur.strength', label: 'Strength', type: 'range', min: 0, max: 2, step: 0.05, digits: 2 },
        fx, { mblur: FX.MBLUR }, rowHooks));
      mb.appendChild(TextUI.control(
        { path: 'mblur.samples', label: 'Samples', type: 'range', min: 2, max: 32, step: 1 },
        fx, { mblur: FX.MBLUR }, rowHooks));
    }));

    // Every numeric parameter is keyframable, and the keys live on the EFFECT, not the
    // clip - two blurs on one clip are two independent animations, which a single
    // `clip.keys.radius` could never express. `Anim` only ever touches a `.keys` object,
    // so an effect entry is a keyframe holder for free.
    const numeric = Object.keys(d.params).filter((k) => typeof d.params[k] === 'number');
    if (numeric.length) {
      const dur = Math.max(0.001, clip.out - clip.in);
      const keyHooks = Object.assign({}, rowHooks, {
        dur,
        getLocalTime: () => clamp(state.playhead - clip.start, 0, dur),
        seekLocal: (t) => seek(clip.start + t),
      });
      body.appendChild(TextUI.section('fxkeys_' + fx.id, 'Keyframes', (kb) => {
        kb.appendChild(el('div', 'tc-hint',
          'Keys are times within the clip, so moving the clip moves its animation with it.'));
        for (const k of numeric) {
          const spec = Object.assign({}, Anim.propSpec(k), specForParam(d, k));
          // `base` is what a FIRST key on an empty track takes, and it has to be the
          // parameter's CURRENT value rather than its default - otherwise adding a key to
          // an Inset the author had moved to 0.040 would pin it at the 0.05 default and
          // jump the picture the moment they asked to animate it. `keyStrip()` promises
          // that adding a key never moves anything; this is what makes that true.
          if (typeof fx.params[k] === 'number') spec.base = fx.params[k];
          kb.appendChild(TextUI.keyStrip(k, Object.assign({}, keyHooks, {
            spec,
            getKeys: () => Anim.trackFor(fx, k, true),
            // Clearing empties the track and prunes it away, so an effect that ends up
            // with no keys serialises exactly as one that never had any.
            clear: () => { Anim.trackFor(fx, k, true).length = 0; Anim.pruneKeys(fx); },
            emptyHint: 'No keys - ' + k + ' holds the value above.',
          })));
        }
      }));
    }
    row.appendChild(body);
    list.appendChild(row);
  });
  box.appendChild(list);

  const addRow = el('div', 'fx-add');
  const add = el('select');
  const a0 = el('option');
  a0.value = '';
  a0.textContent = 'Add an effect...';
  add.appendChild(a0);
  // An effect whose data the clip does not carry is offered but DISABLED, not hidden.
  // Hiding it answers "why can I not find the cursor effect" with silence; disabling it
  // with a reason on the row answers it on the spot. This is the gap that made the two
  // pointer effects addable to any clip and then silently draw nothing.
  for (const type of FX.TYPES) {
    const o = el('option');
    o.value = type;
    const need = FX.DEFS[type].needs;
    o.disabled = need === 'mouse' && !clipHasTake(clip);
    o.textContent = FX.DEFS[type].label + (o.disabled ? '  - needs a mouse take' : '');
    add.appendChild(o);
  }
  add.addEventListener('change', () => {
    if (!add.value) return;
    const type = add.value;
    edit(() => {
      if (!Array.isArray(clip.fx)) clip.fx = [];
      clip.fx.push(FX.create(type));
    });
  });
  addRow.appendChild(add);
  box.appendChild(addRow);
  if (!clipHasTake(clip)) {
    addRow.appendChild(el('div', 'tc-hint',
      'The pointer and ripple effects need a performed mouse take on this clip - ' +
      'record one with Mouse over the viewer. They are greyed out until then.'));
  }

  const az = autoZoomPanel(clip);
  if (az) box.appendChild(az);
  return box;
}

// ---- auto-zoom: a generator, not an effect -------------------------------
//
// The design point of the whole feature, stated once: auto-zoom writes ORDINARY `Anim`
// keyframes onto an ordinary `transform` effect, and then gets out of the way. It does
// not draw anything, it owns no state at render time, and there is no "auto-zoom mode"
// to be in. What comes out is what a patient author would have keyed by hand, sitting on
// the same strip with the same handles, so the answer to "the third one goes too far" is
// to drag it rather than to fight a slider that regenerates everything.
//
// The keys it writes are TAGGED (`gen:'autozoom'`), which is what makes regenerating
// safe: `Cursor.applyGenerated()` replaces the tagged ones and leaves anything the author
// added alone. Without the tag, Regenerate would either double the animation or destroy
// hand work, and both of those turn a generator back into a black box.

/** The transform this generator owns on a clip, created on demand. `null` if absent. */
function autoZoomFx(clip, create) {
  if (!clip) return null;
  const found = (clip.fx || []).find((f) => f && f.type === 'transform' && f.gen === 'autozoom');
  if (found || !create) return found || null;
  if (!Array.isArray(clip.fx)) clip.fx = [];
  const e = FX.create('transform');
  e.gen = 'autozoom';
  // APPENDED, so it draws last. `cursor` and `ripple` paint at the pixel the framing put
  // the telemetry on; a transform after them moves the picture and the pointer together,
  // which is what makes the zoom carry its own cursor with it. Before them it would dive
  // into the frame while the pointer sat still on top of the result.
  clip.fx.push(e);
  return e;
}

/**
 * The generator's settings, which live on the effect once there is one.
 *
 * Before the first Generate there is nothing to hang them on, so the panel edits a
 * session-level copy and the first generation carries it onto the effect. After that the
 * settings travel with the clip - they are what a Regenerate two days later has to reuse,
 * and they are plain JSON like everything else that lands on a clip.
 */
const autoZoomDefaults = JSON.parse(JSON.stringify(Cursor.DEFAULTS.zoom));
function autoZoomSettings(clip) {
  const e = autoZoomFx(clip, false);
  if (e) {
    e.autozoom = Object.assign({}, Cursor.DEFAULTS.zoom, e.autozoom || {});
    return e.autozoom;
  }
  return autoZoomDefaults;
}

/** What the current settings WOULD produce, without touching the clip. */
function autoZoomPreview(clip) {
  if (!ScreenTel.hasTelemetry(clip)) return { segments: [], keys: { x: [], y: [], scale: [] } };
  return Cursor.autoZoom(clip.screen, clip,
    Object.assign({}, autoZoomSettings(clip), { aspect: state.out.w / state.out.h }));
}

/**
 * Generate (or regenerate) the zoom. ONE undo entry, then a full rebuild.
 *
 * A run that finds no dwell long enough is not an error and not a no-op to be silent
 * about: if there is an existing generation it is CLEARED, because the settings the
 * author just moved say those zooms should not be there. With no existing generation and
 * nothing to place, nothing is pushed onto the undo stack at all - an undo entry for an
 * operation that changed nothing is worse than no feedback.
 */
function applyAutoZoom(clip) {
  const res = autoZoomPreview(clip);
  const existing = autoZoomFx(clip, false);
  if (!res.segments.length && !existing) return res;
  pushUndo();
  const e = autoZoomFx(clip, true);
  e.autozoom = JSON.parse(JSON.stringify(autoZoomSettings(clip)));
  Cursor.applyGenerated(e, res.keys);
  FX.normalizeClip(clip);
  markDirty();
  renderAll();
  return res;
}

/**
 * Drop the generation. The effect goes too if nothing is left of it - a transform with
 * default parameters and no keys draws the identity, but it still takes the clip off the
 * render fast path, so leaving one behind would quietly cost every future export.
 */
function clearAutoZoom(clip) {
  const e = autoZoomFx(clip, false);
  if (!e) return;
  pushUndo();
  Cursor.clearGenerated(e);
  if (!e.keys) clip.fx.splice(clip.fx.indexOf(e), 1);
  FX.normalizeClip(clip);
  markDirty();
  renderAll();
}

/**
 * The auto-zoom section of the effect panel.
 *
 * Only for a clip that actually carries telemetry: without it there is nothing to
 * analyse, and a row of dead sliders is worse than no row. That is the same degradation
 * contract the two effects keep, shown rather than described.
 *
 * The sliders push NO undo entry, exactly like Tighten's threshold and pad - they are
 * settings for an operation, not the operation. What they do change, live, is the count
 * of zooms they would place, so the sensitivity is judged before it is committed rather
 * than by generating and undoing three times.
 */
function autoZoomPanel(clip) {
  if (!ScreenTel.hasTelemetry(clip)) return null;
  const el = TextUI.el;
  const settings = autoZoomSettings(clip);
  // Its own class, NOT `fx-box`: the stack panel's box is how the suites find the
  // stack, and a generator answering to that selector would make them find two.
  const box = el('div', 'fx-az');

  const head = el('div', 'fx-head');
  head.appendChild(el('b', null, 'Auto-zoom'));
  const owned = Cursor.countGenerated(autoZoomFx(clip, false));
  head.appendChild(el('span', 'tc-hint', owned ? owned + ' generated keys' : 'not generated'));
  box.appendChild(head);

  box.appendChild(el('div', 'tc-hint fx-note',
    'Reads the recorded cursor and writes ordinary keyframes onto a Transform effect, ' +
    'which you can then drag, retime or delete like any others. Regenerating replaces ' +
    'what it wrote last time and leaves keys you added alone.'));

  const count = el('div', 'tc-hint');
  const refresh = () => {
    const n = autoZoomPreview(clip).segments.length;
    count.textContent = n ? n + ' zoom' + (n === 1 ? '' : 's') + ' at these settings'
      : 'No dwell long enough at these settings.';
  };

  const hooks = {
    // Settings, not timeline state: no snapshot, no dirty flag - the same treatment the
    // Tighten panel's own controls get, and for the same reason.
    onEdit: () => {}, onEditEnd: () => {}, onChanged: refresh,
    rebuild: () => {},
  };
  const holder = { params: settings };
  const C = (spec) => TextUI.control(spec, holder, { params: Cursor.DEFAULTS.zoom }, hooks);
  box.appendChild(C({ path: 'params.sensitivity', label: 'Sensitivity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 }));
  box.appendChild(C({ path: 'params.minHold', label: 'Min hold', type: 'range', min: 0.2, max: 5, step: 0.05, unit: 's', digits: 2 }));
  box.appendChild(C({ path: 'params.maxZoom', label: 'Max zoom', type: 'range', min: 1, max: 4, step: 0.05, digits: 2 }));
  box.appendChild(C({ path: 'params.ramp', label: 'Ramp', type: 'range', min: 0.05, max: 2, step: 0.05, unit: 's', digits: 2 }));
  box.appendChild(C({ path: 'params.curve', label: 'Easing', type: 'select', options: Object.keys(Anim.EASING_PRESETS) }));
  refresh();
  box.appendChild(count);

  const row = el('div', 'fx-add');
  const gen = el('button', 'mini', owned ? 'Regenerate' : 'Generate');
  gen.title = 'Write zoom keyframes from the recorded cursor. One undo entry.';
  gen.addEventListener('click', () => applyAutoZoom(clip));
  row.appendChild(gen);
  const clr = el('button', 'mini', 'Clear generated');
  clr.disabled = !owned;
  clr.title = 'Remove the keys this generated, leaving any you added by hand.';
  clr.addEventListener('click', () => clearAutoZoom(clip));
  row.appendChild(clr);
  box.appendChild(row);
  return box;
}

/**
 * A keyframe strip's slider range for one effect parameter, taken from the same schema
 * row the static control uses - so the two cannot drift apart and offer different limits
 * for the same number. `base` is the parameter's default, which is the right value for a
 * first key on an empty track: a scale that starts at 0 would black the clip out.
 */
function specForParam(def, key) {
  const row = def.schema.find((s) => s.path === 'params.' + key) || {};
  return {
    label: row.label || key,
    min: row.min != null ? row.min : 0,
    max: row.max != null ? row.max : 1,
    step: row.step != null ? row.step : 0.01,
    base: def.params[key],
  };
}

/**
 * The generic keyframe strip for a clip.
 *
 * `Anim.clipPropsFor()` decides what is on offer, so this panel never names a property:
 * anything registered through `Anim.registerClipProp()` grows a strip here, with the
 * typable boxes, wheel-nudging and per-gesture undo that every other control in the app
 * has. A text card is not routed through here - its own panel already keyframes the card
 * itself, which is a richer thing than a clip property.
 *
 * Returns null when nothing is registered for this clip, which is the case in this build:
 * a keyframable property must be honoured by the preview AND the render, and until step 6
 * makes the bake the single draw path a clip's framing is a constant in an ffmpeg crop.
 * Step 7's effect stack is what fills the registry.
 */
function clipKeyPanel(clip) {
  if (!clip || clip.kind === 'text') return null;
  const props = Anim.clipPropsFor(clip);
  if (!props.length) return null;
  const dur = clip.out - clip.in;

  const hooks = {
    dur,
    // Structural edits (add, delete, clear) rebuild the inspector; value edits do not,
    // or a slider would be torn out of the DOM halfway through a drag.
    rebuild: renderInspector,
    onEdit: inspectorEdit,
    onEditEnd: inspectorEditEnd,
    onChanged: () => { markDirty(); drawPreview(); },
    getLocalTime: () => clamp(state.playhead - clip.start, 0, dur),
    seekLocal: (t) => seek(clip.start + t),
  };

  return TextUI.section('clipkeys', 'Keyframes', (b) => {
    b.appendChild(TextUI.el('div', 'tc-hint',
      'Keys are times within the clip, so moving the clip moves its animation with it.'));
    for (const spec of props) {
      b.appendChild(TextUI.keyStrip(spec.prop, Object.assign({}, hooks, {
        spec,
        getKeys: () => Anim.trackFor(clip, spec.prop, true),
        // Clearing empties the track and then prunes it away, so a clip that ends up with
        // no keys serialises exactly as one that never had any.
        clear: () => { Anim.trackFor(clip, spec.prop, true).length = 0; Anim.pruneKeys(clip); },
        emptyHint: 'No keys - ' + (spec.label || spec.prop) + ' holds its clip value.',
      })));
    }
  });
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
 * Every distinct audio clip a selection can put an effect chain on, in selection order.
 *
 * A multi-selection - which is what clicking a track head now produces - has as many
 * chains in it as it has audio clips. The panel edits the FIRST and mirrors the whole
 * chain onto the rest: unlike a text card, an `afx` chain is pure processing with no
 * content in it, so "these clips share this chain" is the only thing multi-editing one
 * could sensibly mean.
 */
function audioFxTargets(sel) {
  const seen = new Set();
  const out = [];
  for (const { clip } of sel) {
    const t = audioFxTarget(clip);
    if (t && !seen.has(t.clip.id)) { seen.add(t.clip.id); out.push(t.clip); }
  }
  return out;
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
function audioFxPanel(clip, viaLink, peers) {
  const el = TextUI.el;
  const box = el('div', 'afx-box');
  if (!Array.isArray(clip.afx)) clip.afx = [];
  AudioFX.normalizeClip(clip);
  const others = (peers || []).filter((c) => c && c !== clip);

  const head = el('div', 'afx-head');
  head.appendChild(el('b', null, 'Audio effects'));
  head.appendChild(el('span', 'tc-hint', clip.afx.length ? clip.afx.length + ' in chain' : 'none'));
  box.appendChild(head);

  /**
   * Give every other selected audio clip the same chain.
   *
   * The whole array is copied rather than diffed (which is what the text panel does)
   * because a chain carries no per-clip content: two clips with the same chain are two
   * clips processed the same way, which is exactly what was asked for. Deep-cloned, so
   * the clips do not end up sharing one array and undo cannot tell them apart.
   */
  const mirror = () => {
    for (const c of others) c.afx = JSON.parse(JSON.stringify(clip.afx));
  };

  if (others.length) {
    box.appendChild(el('div', 'tc-hint afx-via',
      'Editing ' + (others.length + 1) + ' audio clips' + (viaLink ? ' from ' + viaLink : '') +
      '. They all get this chain.'));
  } else if (viaLink) {
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
    mirror();
    markDirty();
    renderAll();
  };
  // Parameter rows keep the panel's once-per-gesture undo but have to mirror too, or a
  // slider would move the lead's compressor and leave the rest of the track behind.
  const rowHooks = others.length
    ? { onChanged: () => { mirror(); markDirty(); drawPreview(); } }
    : undefined;

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
    for (const spec of d.schema) {
      body.appendChild(TextUI.control(spec, fx, { params: d.params }, rowHooks));
    }
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

  box.appendChild(audioFxPresetBar(clip, others.length ? mirror : null));

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
// The audio chain preset picked last, remembered across the panel rebuilding - see the
// comment where the <select> is built.
let lastAudioPreset = '';

function audioFxPresetBar(clip, mirror) {
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
  // Same trap as the text preset bar: applying a chain calls renderAll(), which rebuilds
  // this panel and puts a fresh <select> back on "Choose a saved chain...". Without a
  // remembered name, Delete could never see one.
  if (lastAudioPreset && audioPresetNames.includes(lastAudioPreset)) sel.value = lastAudioPreset;
  else lastAudioPreset = '';
  const apply = (data, what) => {
    pushUndo();
    const applied = AudioFX.applyPreset(clip, data);
    // A preset applied to a multi-selection lands on every clip in it, like every other
    // edit in this panel - otherwise the one place a whole chain arrives at once would
    // be the one place that only touched the lead.
    if (mirror) mirror();
    markDirty();
    renderAll();
    const ducks = applied.filter((f) => f.type === 'duck').length;
    log('Applied audio chain "' + what + '" (' + applied.length + ' effect(s)).' +
      (ducks ? ' Choose a voice track for the ducking.' : ''));
  };
  sel.addEventListener('change', async () => {
    lastAudioPreset = sel.value;
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
    lastAudioPreset = name;          // so Delete and Export act on what was just saved
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
    const name = sel.value || lastAudioPreset;
    if (!name) { log('Pick a saved audio preset above first.'); return; }
    lastAudioPreset = '';
    await window.api.deletePreset('audiofx', name);
    await refreshAudioPresets(true);
    log('Deleted audio chain preset "' + name + '".');
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

/** A clip that puts pixels on the canvas through an element: footage or a still. */
function isPictureClip(c) { return c && (c.kind === 'video' || c.kind === 'image'); }

/** Picture clips under the playhead, topmost visible first. */
function activeVideoClip() {
  const eps = 1e-6;
  for (const t of state.tracks) {
    if (t.type !== 'video' || t.hidden) continue;
    for (const c of t.clips) {
      if (!isPictureClip(c)) continue;
      if (state.playhead >= c.start - eps && state.playhead < clipEnd(c) - eps) return c;
    }
  }
  // Sitting exactly on the end of the timeline: hold the final frame rather than go black.
  const dur = projectDuration();
  if (dur > 0 && state.playhead >= dur - eps) {
    for (const t of state.tracks) {
      if (t.type !== 'video' || t.hidden) continue;
      for (const c of t.clips) if (isPictureClip(c) && Math.abs(clipEnd(c) - dur) < 0.001) return c;
    }
  }
  return null;
}

/**
 * Every visible clip under the playhead, BOTTOM track first - the order they composite in.
 *
 * This is the same order `buildJob()` walks the tracks in, which is what makes the
 * preview and the render agree about who is on top: a clip on V2 draws over a clip on
 * V1, and a text card on V1 draws under both.
 *
 * The last frame of the timeline is a deliberate special case for the same reason
 * `activeVideoClip()` has one: parking the playhead on the very end should hold the final
 * picture rather than fall off into black.
 */
function activeLayers() { return layersAt(state.playhead); }

/**
 * The same thing at an arbitrary timeline time, which is what the composite baker walks.
 *
 * `atEnd` is only the viewer's courtesy - parking the playhead on the very last instant
 * should hold the final picture rather than fall off into black. A bake asks for times
 * strictly inside spans, so it never sees it.
 */
function layersAt(time) {
  const eps = 1e-6;
  const dur = projectDuration();
  const atEnd = dur > 0 && time >= dur - eps;
  const out = [];
  for (const t of state.tracks) {
    if (t.type !== 'video' || t.hidden) continue;
    for (const c of t.clips) {
      if (!isPictureClip(c) && c.kind !== 'text') continue;
      const live = time >= c.start - eps && time < clipEnd(c) - eps;
      if (live || (atEnd && Math.abs(clipEnd(c) - dur) < 0.001)) out.push(c);
    }
  }
  return out.reverse();
}

/**
 * Paint one composited frame - THE single draw path for the picture.
 *
 * The preview calls it with its held per-clip layer surfaces; the baker calls it with
 * freshly seeked media elements at output resolution. Same order, same arithmetic, same
 * pixels - which is the whole point of step 6: a visual feature is written here once and
 * both the viewer and the export get it.
 *
 * `srcFor(clip)` hands back either a canvas already framed to WxH, or a raw media
 * element to be framed by drawClipTo(), or null when the clip has no picture yet. A null
 * layer is SKIPPED, never cleared - that is the black-flash rule, and it holds in the
 * baker too, where a stubborn seek would otherwise punch a hole through the stack.
 *
 * Returns false when nothing at all painted, so the caller can leave what it had.
 */
/**
 * The effect stack's canvas pool.
 *
 * `FX` allocates nothing per frame; it asks for named surfaces and gets the same canvases
 * back every time, exactly as `Anim.temporalAverage()` does. The names are namespaced by
 * FX itself ('fxLayer', 'fxA', ...), and the pool is separate from `transSurface`'s
 * because that one carries the transition's held-frame bookkeeping with it.
 *
 * A resize clears the canvas, which is what we want: the preview asks at 540x960 and the
 * baker at 1080x1920, and a stale half-size picture must never survive the switch.
 */
const fxSurfaces = new Map();
function fxSurface(name, w, h) {
  let cv = fxSurfaces.get(name);
  if (!cv) { cv = document.createElement('canvas'); fxSurfaces.set(name, cv); }
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv;
}

function compositeLayers(cctx, W, H, layers, time, srcFor, frameDur) {
  cctx.save();
  cctx.globalCompositeOperation = 'source-over';
  cctx.fillStyle = '#000';
  cctx.fillRect(0, 0, W, H);
  let painted = false;
  for (const c of layers) {
    const local = time - c.start;
    if (c.kind === 'text') {
      // TextDraw scales its sizes off the frame height, so a smaller canvas gives a
      // proportionally smaller card - the layout is identical, there is just less to paint.
      FX.render(cctx, W, H, c, local, fxSurface,
        (tc) => TextDraw.draw(tc, c, W, H, local, frameDur), frameDur);
      painted = true;
      continue;
    }
    const layer = srcFor(c);
    if (!layer) continue;      // still decoding: skip it, keep what is underneath
    // With no effect stack this is the same single drawImage it has always been - FX.render
    // hands the target straight to the painter and allocates nothing. With one, the clip is
    // painted into its own transparent layer first, because an effect that composited
    // directly onto the frame would behave differently over video than over transparency.
    FX.render(cctx, W, H, c, local, fxSurface, (tc) => {
      if (layer.tagName === 'CANVAS') tc.drawImage(layer, 0, 0, W, H);
      else drawClipTo(c, layer, tc, W, H);
    }, frameDur);
    painted = true;
  }
  cctx.restore();
  return painted;
}

/**
 * Draw one clip into the output frame using its pan/zoom framing.
 * Mirrors the ffmpeg crop in main.js so the preview matches the render.
 */
/** Framed draw at an explicit size, for baking at the job's resolution. */
/**
 * Frame one clip into a target of W x H. The ONLY framing path there is.
 *
 * Two modes, and `fit` names which:
 *
 *   'crop'     (the default, and what every clip did before stills grew a placement
 *              panel) takes the largest source rect matching the output aspect, divides
 *              it by `zoom` and offsets it by `pan` - so the picture FILLS the frame and
 *              whatever does not fit is cropped away.
 *   'contain'  fits the WHOLE picture inside the frame and leaves the rest transparent.
 *              `zoom` becomes its size and `panX`/`panY` its position, which is what a
 *              logo, a screenshot or a badge needs: a wide logo cropped to 9:16 is a
 *              detail of a logo.
 *
 * `contain` means the layer has transparency in it, so a clip using it must be COMPOSITED
 * rather than handed to ffmpeg's crop-and-fill chain - `clipNeedsBake()` says so.
 */
function drawClipTo(c, el, target, W, H) {
  const sw = elW(el) || c.srcW, sh = elH(el) || c.srcH;
  if (!sw || !sh) return;
  if (c.fit === 'contain') {
    // Scaled to fit inside the frame, then multiplied by `zoom` - so zoom 1 is "as large
    // as it goes while whole", and the aspect ratio is the source's own at every size.
    const s = Math.min(W / sw, H / sh) * Math.max(0.01, c.zoom || 1);
    const dw = sw * s, dh = sh * s;
    // pan 0.5 centres it; 0 and 1 put its edges against the frame's, so the whole range
    // is reachable at any size and the control means the same thing as it does in 'crop'.
    target.drawImage(el, 0, 0, sw, sh, (W - dw) * c.panX, (H - dh) * c.panY, dw, dh);
    return;
  }
  const outAspect = state.out.w / state.out.h;
  const cw = Math.min(sw, sh * outAspect) / c.zoom;
  const ch = Math.min(sh, sw / outAspect) / c.zoom;
  target.drawImage(el, (sw - cw) * c.panX, (sh - ch) * c.panY, cw, ch, 0, 0, W, H);
}

/**
 * The same framing, at preview size. It DELEGATES rather than repeating the maths.
 *
 * These were two copies of the crop, which is exactly the pairing the whole bake-first
 * architecture exists to stop: the aspect comes from the output in both, so the only
 * thing the second copy could ever do was drift away from the first.
 */
function drawClip(c, el, target) {
  const P = previewSize();
  drawClipTo(c, el, target || ctx, P.w, P.h);
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

/**
 * One scratch canvas per picture clip, holding its last successfully decoded frame,
 * already framed to the output size and with its own alpha intact.
 *
 * Compositing several tracks means clearing and repainting the whole frame every time,
 * and a <video> that is mid-seek has no frame to give back - so a naive loop would drop
 * a layer to nothing the instant its element started seeking, which is the black-flash
 * bug the single-clip path learned about years ago, only now it can punch a hole in the
 * MIDDLE of a stack. Holding each layer's last good picture means a not-yet-decoded
 * element is skipped without clearing what is underneath it.
 *
 * The surface is cleared to TRANSPARENT, never to black: a still with an alpha channel
 * has to let the layers below it through.
 */
const layerSurfaces = new Map();   // clip.id -> canvas holding its last good frame

function dropLayerSurface(clipId) { layerSurfaces.delete(clipId); }

/**
 * This clip's layer, repainted if its element has a frame, or its last good one if not.
 * Returns null when it has never had a frame to hold.
 */
function layerFor(clip, P) {
  let cv = layerSurfaces.get(clip.id);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = P.w; cv.height = P.h;
    cv.dataset.held = '';
    layerSurfaces.set(clip.id, cv);
  }
  // Resizing clears the canvas, so whatever it was holding goes with it.
  if (cv.width !== P.w || cv.height !== P.h) {
    cv.width = P.w; cv.height = P.h; cv.dataset.held = '';
  }
  const el = mediaFor(clip);
  if (frameReady(el)) {
    const c2 = cv.getContext('2d');
    c2.clearRect(0, 0, P.w, P.h);
    drawClip(clip, el, c2);
    cv.dataset.held = '1';
  }
  return cv.dataset.held ? cv : null;
}

/** Forget the held frame of anything no longer on the timeline. */
function pruneLayerSurfaces() {
  const live = new Set();
  for (const { clip } of allClips()) live.add(clip.id);
  for (const id of [...layerSurfaces.keys()]) if (!live.has(id)) layerSurfaces.delete(id);
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

  // Composite every visible video track, bottom-up, with alpha.
  const layers = activeLayers();
  const cache = videoFrameCache();

  if (!layers.length) {
    // A real gap shows black, not the previous frame.
    frameCacheValid = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, P.w, P.h);
    return;
  }

  const cctx = cache.getContext('2d');
  const painted = compositeLayers(cctx, P.w, P.h, layers, state.playhead,
    (c) => layerFor(c, P), 1 / state.out.fps);

  // Nothing in the whole stack has a frame yet (every element mid-seek, on the very first
  // paint after an import). Leave the canvas exactly as it was rather than flash black.
  if (!painted) return;

  frameCacheValid = true;
  ctx.clearRect(0, 0, P.w, P.h);
  ctx.drawImage(cache, 0, 0);
}

/**
 * Render one clip's framed frame into a scratch canvas, or null if it is not decodable.
 * `atTime` is a time on the timeline; the clip is sampled there even if that is outside
 * its trimmed range, which is exactly what a transition needs (it reaches into the
 * handles either side of the cut).
 */
function clipFrameAt(clip, atTime, name, P) {
  const el = mediaFor(clip);
  if (!frameReady(el)) return null;
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
  // A rendered span carries its own picture and audio, so nothing underneath it may be
  // heard. The PICTURE is parked; the AUDIO is kept running and silent. See below.
  const band = activePreviewBand();
  syncPreviewBand(band);
  if (band) {
    // Parking the audio too was a hole at the far edge of every rendered span.
    //
    // This used to pause every element and return, which abandoned their clocks: an
    // audio element sat paused at wherever it happened to be - usually 0 - for as long
    // as the band played. The moment the playhead left the band, `syncMedia()` needed
    // that element AT the playhead, so it issued a cold seek across the whole span.
    // Measured on a 0-2s band: readyState fell from 4 to 1, roughly 300 ms of silence,
    // and the element came back ~150 ms behind - under the 0.3 s correction threshold,
    // so nothing ever closed the gap. Land in a band edge repeatedly and each cold seek
    // starts the next one before the last has finished, which is the stutter that ends
    // in no audio at all.
    //
    // Kept running and muted, the handoff at the edge is an UNMUTE: no seek, no decode
    // gap, and already in sync because it never stopped tracking the playhead.
    //
    // The picture is the opposite trade and stays parked. Decoding video nobody can see
    // is precisely what a rendered span exists to avoid, and a cold first frame is
    // covered by `frameCache`. Audio has no equivalent of a held frame, and the ear is
    // far less forgiving of a 300 ms hole than the eye is of one stale frame.
    for (const { clip } of allClips()) {
      const el = mediaEls.get(clip.id);
      if (clip.kind !== 'audio') { if (el && !el.paused) el.pause(); continue; }
      const live = state.playhead >= clip.start && state.playhead < clipEnd(clip);
      if (!live) { if (el && !el.paused) el.pause(); continue; }
      const m = mediaFor(clip);
      m.muted = true;                       // the band already carries this mix
      const target = clip.in + (state.playhead - clip.start);
      if (state.playing) {
        if (!m.seeking && Math.abs(m.currentTime - target) > 0.3) m.currentTime = target;
        if (m.paused) m.play().catch(() => {});
      } else {
        if (!m.paused) m.pause();
        if (!m.seeking && Math.abs(m.currentTime - target) > 0.06) m.currentTime = target;
      }
    }
    return;
  }

  // A transition parks its two clips itself; they are outside their normal ranges.
  const transTargets = transitionMediaTargets();
  const transIds = new Set((transTargets || []).map((x) => x.clip.id));
  if (transTargets) {
    for (const { clip, t } of transTargets) {
      if (clip.kind === 'image') continue;   // a still has no clock to park
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
    if (clip.kind === 'image') {
      // A still has no clock to keep in step, only a picture to have ready. Warming it
      // on approach is the same reason video clips are pre-created: arriving at the cut
      // with an <img> that has not loaded yet is one skipped layer.
      const near = state.playhead >= clip.start - PRELOAD_AHEAD && state.playhead < clipEnd(clip) + 1;
      if (near) mediaFor(clip);
      else if (mediaEls.has(clip.id)) {
        const dist = Math.max(clip.start - state.playhead, state.playhead - clipEnd(clip));
        if (dist > EVICT_BEYOND) dropMedia(clip.id);
      }
      continue;
    }
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
      // A take ends when its range does, rather than running on over whatever follows.
      if (Mouse.recording && state.playhead >= Mouse.range.to - 1e-3) stopMouseTake();
    }
    drawPreview();
    // AFTER the picture, and outside it: the selection rubber-band is an affordance for
    // the person performing, not a layer. It is never composited and never baked - what
    // gets baked is the `select` effect the drag turns into when the take is committed.
    drawMouseOverlay(ctx, previewSize().w, previewSize().h);
    // And the track markers, for the same reason and on the same terms: an
    // affordance over the picture, never a layer in it.
    drawTrackOverlay(ctx, previewSize().w, previewSize().h);
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

// While a take is being performed the viewer is an input surface, not a framing control:
// a drag has to move the pointer being recorded, never the clip's pan. These run BEFORE
// the framing handlers and stop them.
canvas.addEventListener('pointerdown', (e) => {
  if (!Mouse.recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey) { mouseBeginSelection(e); return; }
  Mouse.down = true;
  mouseSample(e, ScreenTel.DOWN);
}, true);
canvas.addEventListener('pointermove', (e) => {
  if (!Mouse.recording) return;
  if (Mouse.drag) {
    const p = mousePointAt(e);
    Mouse.drag.x1 = p.x; Mouse.drag.y1 = p.y;
    // Timed by the playhead like every other sample, so the band replays against the
    // picture it was dragged over rather than against how fast the events arrived.
    Mouse.drag.samples.push({ t: state.playhead, x: p.x, y: p.y });
    return;
  }
  mouseSample(e, ScreenTel.MOVE);
}, true);
canvas.addEventListener('pointerup', (e) => {
  if (!Mouse.recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (Mouse.drag) { mouseEndSelection(); return; }
  Mouse.down = false;
  mouseSample(e, ScreenTel.UP);
}, true);

canvas.addEventListener('mousedown', (e) => {
  if (Mouse.recording) return;
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
  const sel = selectedClips().map((x) => x.clip).filter(isPictureClip);
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

// ==================================== 7b. transcription + captions

/**
 * Captions.
 *
 * A caption is an ORDINARY TEXT CARD - `kind:'text'` with a `card` on it, exactly like
 * one typed by hand. That is the whole design: TextDraw is already the single source of
 * truth for preview and export, so a generated caption is pixel-identical in the viewer
 * and in the MP4 for free, and there is no second drawing path to keep in step.
 *
 * The pieces:
 *
 *   window.api.transcribeRun -> word timings in SOURCE time  (whisper.cpp, cached in main)
 *   Captions.groupPhrases    -> 2-3 word phrases on word boundaries
 *   Captions.phraseCard      -> a TextCard placed in the safe zone
 *   generateCaptions()       -> one pushUndo() for the whole pass
 *
 * Word timings are in the SOURCE time base of the audio clip they came from - the same
 * base `silencedetect` reports in, and for the same reason: they belong to the file, not
 * to where the clip currently sits. `start + (word - clip.in)` is what puts them on the
 * timeline, and it is the only place that conversion happens.
 */

const CAPTION_DEFAULTS = Captions.DEFAULTS;

/** Word timings per source file, mirroring the on-disk cache in main. */
const transcriptCache = new Map();

function captionOpts() {
  return Object.assign({}, CAPTION_DEFAULTS, state.captions);
}

/** The words for a source, or null if it has not been transcribed in this session. */
function transcriptFor(src) {
  return transcriptCache.get(src) || null;
}

/**
 * Put a transcript on a source by hand - what "Import transcript" uses, and what the
 * smoke suite uses so the whole caption pipeline is testable on a machine with no
 * whisper.cpp on it.
 */
function setTranscript(src, words) {
  const clean = Captions.cleanWords(words);
  transcriptCache.set(src, clean);
  return clean;
}

/** The selection as link groups with the audio clip each one's words come from. */
function captionUnits() {
  return tightenUnits();
}

/**
 * Transcribe every source the selection needs. Cheap after the first time: main serves
 * a previous session's words from disk.
 *
 * Nothing here throws. A missing binary, a missing model or no network all come back as
 * a `reason` and a message that ends up in the panel and the log - the editor keeps
 * working, it simply has no words yet.
 */
async function transcribeSelection(opts) {
  const force = !!(opts && opts.force);
  const model = (opts && opts.model) || state.captions.model;
  const srcs = new Set();
  for (const u of captionUnits()) {
    if (u.audio && (force || !transcriptFor(u.audio.src))) srcs.add(u.audio.src);
  }
  let done = 0, failed = 0, last = null;
  for (const src of srcs) {
    let r = null;
    try { r = await window.api.transcribeRun({ path: src, model, force }); } catch (e) { r = null; }
    if (r && r.ok) { setTranscript(src, r.words); done++; }
    else { failed++; last = r || { error: 'Transcription failed.' }; }
  }
  return { done, failed, error: last && last.error, reason: last && last.reason, sources: srcs.size };
}

/**
 * The `full` text presets a caption can be built from.
 *
 * A preset is a LOOK - style, animation layers and keyframes - so a caption built from
 * one is an ordinary text card wearing it. What the preset never supplies is content:
 * the wording, the word timings and the keyword highlight are the caption's own, which
 * is the same rule `TextModel.applyPreset(card, p, { keepText: true })` already follows.
 *
 * Names are listed for the picker; the data is loaded lazily and cached, because
 * generateCaptions() is synchronous and must not wait on a file read per card.
 */
let capPresetNames = [];
const capPresetCache = new Map();

async function refreshCaptionPresets() {
  try {
    const all = await window.api.listPresets();
    capPresetNames = (all && all.full) || [];
  } catch (e) { capPresetNames = []; }
  return capPresetNames;
}

async function ensureCaptionPreset(name) {
  if (!name) return null;
  if (capPresetCache.has(name)) return capPresetCache.get(name);
  let d = null;
  try { d = await window.api.loadPreset('full', name); } catch (e) { d = null; }
  capPresetCache.set(name, d);
  return d;
}

/**
 * The card every caption starts from, and whether it came from a preset.
 *
 * Synchronous on purpose - it reads the cache `ensureCaptionPreset()` filled. A preset
 * that is named but not loaded falls back to the built-in look and says so, rather than
 * silently generating thirty cards in the wrong style.
 */
function captionBaseCard() {
  const name = state.captions.preset || '';
  const card = TextModel.defaultCard('');
  if (!name) return { card, fromPreset: false };
  const p = capPresetCache.get(name);
  if (!p) {
    log('Caption preset "' + name + '" is not loaded - using the built-in look.');
    return { card, fromPreset: false };
  }
  TextModel.applyPreset(card, p, { keepText: true });
  return { card, fromPreset: true };
}

/**
 * The caption track: one video track marked `captions: true`, kept at the top so
 * captions sit above the footage.
 *
 * The flag is a plain boolean on the track, so it serialises with everything else and a
 * regenerate can find its own previous output without guessing from the track name.
 */
function captionTrack(create) {
  let t = state.tracks.find((x) => x.type === 'video' && x.captions);
  if (t || create === false) return t || null;
  t = makeTrack('video', state.tracks.filter((x) => x.type === 'video').length + 1);
  t.name = 'CAP';
  t.captions = true;
  state.tracks.unshift(t);
  return t;
}

/**
 * The phrases for one audio clip, as timeline-time entries.
 *
 * Only the part of the source the clip actually uses is captioned, and a phrase that
 * straddles the clip's in or out point is clipped to it rather than dropped - the words
 * inside the clip were still said inside it.
 */
function captionPhrasesFor(clip, opts) {
  const words = transcriptFor(clip.src);
  if (!words || !words.length) return [];
  const o = opts || captionOpts();
  const inside = words.filter((w) => w.end > clip.in + 1e-6 && w.start < clip.out - 1e-6);
  const out = [];
  for (const p of Captions.groupPhrases(inside, o)) {
    const s = Math.max(p.start, clip.in);
    const e = Math.min(p.end, clip.out);
    if (e - s < 0.05) continue;
    out.push({
      phrase: p,
      start: clip.start + (s - clip.in),
      end: clip.start + (e - clip.in),
    });
  }
  return out;
}

/** Caption clips this app generated, optionally only those from a given set of sources. */
function generatedCaptionClips(srcs) {
  const out = [];
  for (const track of state.tracks) {
    for (const c of track.clips) {
      if (!c.captions || !c.captions.gen) continue;
      if (srcs && !srcs.has(c.captions.src)) continue;
      out.push({ track, clip: c });
    }
  }
  return out;
}

/**
 * Generate caption cards for the selection. ONE pushUndo() for the whole pass.
 *
 * Regenerating REPLACES this generator's own previous output for the same sources and
 * leaves everything else alone - a hand-made card on the caption track survives, because
 * only clips carrying `captions.gen` are swept. Doubling the captions every time someone
 * nudges the font size is the failure mode this avoids.
 */
function generateCaptions() {
  const o = captionOpts();
  const units = captionUnits().filter((u) => u.audio && transcriptFor(u.audio.src));
  if (!units.length) { log('No transcript for the selection yet - press Transcribe first.'); return null; }

  const srcs = new Set(units.map((u) => u.audio.src));
  const plan = [];
  for (const u of units) {
    for (const p of captionPhrasesFor(u.audio, o)) plan.push(Object.assign({ src: u.audio.src }, p));
  }
  if (!plan.length) { log('The transcript has no words inside the selected clips.'); return null; }

  pushUndo();
  const old = generatedCaptionClips(srcs);
  for (const { track, clip } of old) {
    track.clips = track.clips.filter((c) => c !== clip);
    dropMedia(clip.id);
  }

  const track = captionTrack(true);
  const { card: base, fromPreset } = captionBaseCard();
  const cardOpts = Object.assign({}, o, { fromPreset });
  const made = [];
  for (const p of plan) {
    const clip = {
      id: nextId(),
      src: null,
      name: 'Caption',
      kind: 'text',
      start: p.start,
      in: 0,
      out: Math.max(0.05, p.end - p.start),
      mediaDuration: 3600,
      srcW: 0, srcH: 0, fps: 0,
      panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
      linkId: null,
      card: Captions.phraseCard(base, p.phrase, cardOpts),
      // The tag is what makes a regenerate replace instead of double, and it is plain
      // JSON like everything else on a clip. It names the source these
      // words came from, so regenerating ONE clip's captions sweeps away nobody else's.
      captions: { gen: true, src: p.src },
    };
    made.push(clip);
    track.clips.push(clip);
  }

  sortTracks();
  markDirty();
  renderAll();
  log('Captions: ' + made.length + ' card(s) from ' + srcs.size + ' source(s)' +
      (fromPreset ? ' using preset "' + state.captions.preset + '"' : '') +
      (old.length ? ', replacing ' + old.length + ' previous card(s).' : '.'));
  return { made: made.length, replaced: old.length, clips: made };
}

/** Remove this generator's caption cards. One undo entry, or none if there are none. */
function clearCaptions(all) {
  const srcs = all ? null : new Set(captionUnits().filter((u) => u.audio).map((u) => u.audio.src));
  const doomed = generatedCaptionClips(srcs);
  if (!doomed.length) { log('No generated captions to remove.'); return 0; }
  pushUndo();
  for (const { track, clip } of doomed) {
    track.clips = track.clips.filter((c) => c !== clip);
    dropMedia(clip.id);
  }
  const live = new Set(allClips().map((x) => x.clip.id));
  state.selection = new Set([...state.selection].filter((id) => live.has(id)));
  markDirty();
  renderAll();
  log('Removed ' + doomed.length + ' caption card(s).');
  return doomed.length;
}

/**
 * Step 2's filler-word hook, wired up.
 *
 * Tighten asks every registered provider for extra SOURCE-time spans and merges them
 * with the silences, so a filler cut and a silence cut are ONE ripple and ONE undo entry.
 * Off by default (`cutFillers`), because deciding on the user's behalf that every "like"
 * is a mistake is not a decision an editor gets to make silently.
 */
registerTightenSpans((clip) => {
  const o = captionOpts();
  if (!o.cutFillers || !clip || !clip.src) return [];
  const words = transcriptFor(clip.src);
  if (!words || !words.length) return [];
  return Captions.fillerSpans(words, o);
});

/**
 * The Captions panel.
 *
 * Its rows are `TextUI.control` like every other panel in the app - slider AND typable
 * box AND scroll-nudge AND reset - but, exactly as the Tighten panel does, they pass
 * their own hooks: these are project SETTINGS, not timeline state, so moving one
 * snapshots no undo entry. Only Generate and Clear touch the timeline, and each is one
 * undo entry.
 */
let capBusy = false;
let capStatusMsg = '';
let capPanelPaint = null;
let capWhisper = null;   // { bin, models } from the main process, fetched once

function captionsPanelBody() {
  const el = TextUI.el;
  const box = el('div', 'afx-box cap-box');
  const o = captionOpts();

  const head = el('div', 'afx-head');
  head.appendChild(el('b', null, 'Transcript'));
  const count = el('span', 'tc-hint');
  head.appendChild(count);
  box.appendChild(head);

  const status = el('div', 'tc-hint cap-status');
  const bar = el('div', 'tc-btns cap-bar');
  const runBtn = el('button', 'mini', 'Transcribe');
  const impBtn = el('button', 'mini', 'Import...');
  const genBtn = el('button', 'mini primary', 'Generate captions');
  const clrBtn = el('button', 'mini', 'Clear');
  runBtn.title = 'Transcribe the selected clips with whisper.cpp (cached per file)';
  impBtn.title = 'Load a transcript you already have: whisper JSON, SRT or VTT';
  genBtn.title = 'Make caption cards from the transcript - one undo entry';
  clrBtn.title = 'Remove the caption cards this generator made';

  const paint = () => {
    const u2 = captionUnits().filter((x) => x.audio);
    const have = u2.filter((x) => transcriptFor(x.audio.src)).length;
    count.textContent = !u2.length ? 'no audio selected'
      : have === u2.length ? have + ' transcribed' : have + ' of ' + u2.length + ' transcribed';
    const words = u2.reduce((n, x) => n + ((transcriptFor(x.audio.src) || []).length), 0);
    let phrases = 0;
    for (const x of u2) phrases += captionPhrasesFor(x.audio, captionOpts()).length;
    status.textContent = capStatusMsg || (!u2.length
      ? 'Select a clip with sound to caption it.'
      : have
        ? words + ' words -> ' + phrases + ' caption card(s) at these settings.'
        : (capWhisper && !capWhisper.bin
          ? 'whisper.cpp not found. Put whisper-cli.exe in ' + (capWhisper.whisperDir || 'userData/whisper') +
            ', or set SHORTCUT_WHISPER - or import a transcript.'
          : 'Not transcribed yet.'));
    runBtn.disabled = capBusy || !u2.length;
    impBtn.disabled = capBusy || !u2.length;
    genBtn.disabled = capBusy || !phrases;
    clrBtn.disabled = capBusy || !generatedCaptionClips(null).length;
  };
  capPanelPaint = paint;

  const hooks = {
    onEdit: () => {}, onEditEnd: () => {}, onChanged: paint,
    rebuild: () => renderCaptionsPanel(),
  };
  const C = (spec) => TextUI.control(spec, state.captions, CAPTION_DEFAULTS, hooks);

  box.appendChild(status);
  bar.appendChild(runBtn); bar.appendChild(impBtn);
  bar.appendChild(genBtn); bar.appendChild(clrBtn);
  box.appendChild(bar);

  // ---- phrasing
  box.appendChild(TextUI.section('capPhrase', 'Phrasing', (body) => {
    body.appendChild(C({
      path: 'maxWords', label: 'Words per card', type: 'range',
      min: 1, max: 8, step: 1, digits: 0,
    }));
    body.appendChild(C({
      path: 'maxDur', label: 'Max on screen', type: 'range',
      min: 0.4, max: 5, step: 0.05, unit: 's', digits: 2,
    }));
    body.appendChild(C({
      path: 'maxGap', label: 'Break on a pause of', type: 'range',
      min: 0.05, max: 2, step: 0.01, unit: 's', digits: 2,
    }));
    body.appendChild(C({
      path: 'minDur', label: 'Hold at least', type: 'range',
      min: 0.05, max: 1.5, step: 0.01, unit: 's', digits: 2,
    }));
  }));

  // ---- placement
  box.appendChild(TextUI.section('capPlace', 'Safe zone', (body) => {
    body.appendChild(el('div', 'tc-hint',
      'Captions are centred in this band, as fractions of the frame height. The default ' +
      'keeps them clear of the platform UI along the bottom of the screen.'));
    body.appendChild(C({
      path: 'zoneTop', label: 'Zone top', type: 'range', min: 0, max: 1, step: 0.01, digits: 2,
    }));
    body.appendChild(C({
      path: 'zoneBottom', label: 'Zone bottom', type: 'range', min: 0, max: 1, step: 0.01, digits: 2,
    }));
    body.appendChild(C({
      path: 'maxWidth', label: 'Wrap width', type: 'range', min: 0.3, max: 1, step: 0.01, digits: 2,
    }));
  }));

  // ---- look
  box.appendChild(TextUI.section('capLook', 'Look', (body) => {
    // A saved `full` text preset is the whole look in one pick. Chosen, it supplies the
    // style and the animation layers and the rows below it stop applying - so say that
    // rather than leaving them to look live and do nothing.
    body.appendChild(C({
      path: 'preset', label: 'Preset', type: 'select',
      options: [{ value: '', label: '(built-in caption look)' }]
        .concat(capPresetNames.map((n) => ({ value: n, label: n }))),
    }));
    if (o.preset) {
      body.appendChild(C({
        path: 'presetPlacement', label: "Keep the preset's position", type: 'check',
      }));
      body.appendChild(el('div', 'tc-hint',
        'Built from the "' + o.preset + '" preset: its style, animation and keyframes. ' +
        'The rows below do not apply. The wording, the word timings and the keyword ' +
        'highlight all still belong to the caption. Unticked, the safe zone still places it.'));
      return;
    }
    const fonts = (TextUI.fonts && TextUI.fonts.length) ? TextUI.fonts : [o.fontFamily];
    body.appendChild(C({ path: 'fontFamily', label: 'Font', type: 'select', options: fonts }));
    body.appendChild(C({
      path: 'fontSize', label: 'Size', type: 'range', min: 30, max: 220, step: 1, unit: 'px', digits: 0,
    }));
    body.appendChild(C({ path: 'color', label: 'Colour', type: 'color' }));
    body.appendChild(C({ path: 'uppercase', label: 'Uppercase', type: 'check' }));
    body.appendChild(C({ path: 'popIn', label: 'Pop each word in', type: 'check' }));
    body.appendChild(C({
      path: 'popDur', label: 'Pop over', type: 'range', min: 0.05, max: 1, step: 0.01, unit: 's', digits: 2,
    }));
  }));

  // ---- keywords
  box.appendChild(TextUI.section('capKeys', 'Keyword highlight', (body) => {
    body.appendChild(el('div', 'tc-hint',
      'Words listed here are painted in the highlight colour wherever they appear. ' +
      'The override is per word on the card, so it survives a save and can be edited by hand.'));
    body.appendChild(C({ path: 'highlight', label: 'Highlight', type: 'color' }));
    body.appendChild(C({ path: 'keywords', label: 'Keywords', type: 'area' }));
  }));

  // ---- word timing
  box.appendChild(TextUI.section('capWord', 'Word timing', (body) => {
    body.appendChild(el('div', 'tc-hint',
      'The transcript is word-level, so a caption can land on the syllable instead of ' +
      'arriving whole. Reveal makes each word appear as it is spoken; emphasis lights ' +
      'the word being said right now and lets it settle back as the next one starts. ' +
      'Both read the times stored on the card, so they can be switched on later without ' +
      'regenerating.'));
    body.appendChild(C({ path: 'wordReveal', label: 'Reveal word by word', type: 'check' }));
    body.appendChild(C({ path: 'wordEmphasis', label: 'Emphasise the spoken word', type: 'check' }));
    body.appendChild(C({ path: 'emphasisColor', label: 'Emphasis colour', type: 'color' }));
    body.appendChild(C({
      path: 'emphasisScale', label: 'Emphasis size', type: 'range',
      min: 1, max: 1.8, step: 0.01, digits: 2,
    }));
    body.appendChild(C({
      path: 'emphasisRise', label: 'Emphasis lift', type: 'range',
      min: 0, max: 60, step: 1, unit: 'px', digits: 0,
    }));
    body.appendChild(C({
      path: 'emphasisAttack', label: 'Ease over', type: 'range',
      min: 0.01, max: 0.4, step: 0.01, unit: 's', digits: 2,
    }));
    body.appendChild(el('div', 'tc-hint',
      'A word records the moment the NEXT word starts, so its span swallows the pause ' +
      'after it. These three turn that record into a window that tracks the voice: lead ' +
      'it slightly so it lands on the beat, let go after Hold at most rather than sitting ' +
      'lit through a pause, and keep it up for At least so a very short word still reads.'));
    body.appendChild(C({
      path: 'wordLead', label: 'Lead the voice by', type: 'range',
      min: 0, max: 0.3, step: 0.01, unit: 's', digits: 2,
    }));
    body.appendChild(C({
      path: 'wordHold', label: 'Hold at most', type: 'range',
      min: 0.1, max: 2, step: 0.05, unit: 's', digits: 2,
    }));
    body.appendChild(C({
      path: 'wordMinHold', label: 'Hold at least', type: 'range',
      min: 0.02, max: 0.6, step: 0.01, unit: 's', digits: 2,
    }));
  }));

  // ---- fillers
  box.appendChild(TextUI.section('capFill', 'Filler words', (body) => {
    body.appendChild(el('div', 'tc-hint',
      'With this on, Tighten cuts these words as well as the silences - one ripple, one ' +
      'undo entry. They are not subject to the silence threshold (a filler word is short ' +
      'by definition) but they do get the same pad.'));
    body.appendChild(C({ path: 'cutFillers', label: 'Cut fillers with Tighten', type: 'check' }));
    body.appendChild(C({ path: 'fillers', label: 'Fillers', type: 'area' }));
  }));

  // ---- engine
  box.appendChild(TextUI.section('capEngine', 'Engine', (body) => {
    body.appendChild(el('div', 'tc-hint',
      'whisper.cpp, run on the audio and cached per file. The model downloads on first ' +
      'use; the binary does not - see the README.'));
    body.appendChild(C({
      path: 'model', label: 'Model', type: 'select',
      options: ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3-turbo'],
    }));
  }));

  const busy = (msg) => { capBusy = !!msg; capStatusMsg = msg || ''; paint(); };

  runBtn.addEventListener('click', async () => {
    if (capBusy) return;
    busy('Transcribing...');
    const r = await transcribeSelection({});
    busy('');
    if (r.failed) { capStatusMsg = r.error || 'Transcription failed.'; log('Transcribe: ' + capStatusMsg); }
    else if (r.done) log('Transcribed ' + r.done + ' source(s).');
    paint();
  });

  impBtn.addEventListener('click', async () => {
    if (capBusy) return;
    let r = null;
    try { r = await window.api.transcribeImport(); } catch (e) { r = null; }
    if (!r || r.canceled) return;
    if (!r.ok) { capStatusMsg = r.error || 'Could not read that transcript.'; paint(); return; }
    const targets = captionUnits().filter((u) => u.audio);
    for (const u of targets) setTranscript(u.audio.src, r.words);
    capStatusMsg = '';
    log('Imported ' + r.words.length + ' word timings from ' + r.filePath + '.');
    paint();
  });

  genBtn.addEventListener('click', async () => {
    // Loaded BEFORE generating: generateCaptions() is synchronous so that the whole pass
    // stays one undo entry, which means the preset has to already be in the cache.
    await ensureCaptionPreset(state.captions.preset);
    generateCaptions();
    paint();
  });
  clrBtn.addEventListener('click', () => { clearCaptions(false); paint(); });

  paint();
  return box;
}

/** Rebuild the Captions panel. Called from renderInspector, like every other panel. */
function renderCaptionsPanel() {
  const host = $('#capPanel');
  if (!host) return;
  host.innerHTML = '';
  capPanelPaint = null;
  // The count is on the HEAD, so it still reports while the panel is collapsed.
  const meta = $('#capMeta');
  if (meta) {
    const n = generatedCaptionClips(null).length;
    meta.textContent = n ? n + ' card' + (n === 1 ? '' : 's') : '';
  }
  if (host.hidden) return;
  host.appendChild(captionsPanelBody());
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

/**
 * "Discard unsaved changes?" - and never on a smoke run.
 *
 * `confirm()` BLOCKS the renderer until somebody answers it, and on a smoke run nobody
 * is there. Nine suites call `newProject()` or `openProject()`, both of which ask this
 * whenever the project is dirty - and every suite dirties the project the moment it
 * imports a clip. The run then sits on a modal until something kills it, having printed
 * nothing, which is indistinguishable from a hang and is exactly what it was.
 *
 * `createWindow()` already forces the MAIN process's unsaved-changes guard open on the
 * smoke path; this is the same rule for the renderer's own prompt, which that guard does
 * not cover. A smoke run has nothing worth keeping, always.
 */
function confirmDiscard() {
  if (window.api.smoke) return true;
  return confirm('Discard unsaved changes?');
}

function newProject() {
  if (state.dirty && !confirmDiscard()) return;
  for (const id of [...mediaEls.keys()]) dropMedia(id);
  state.tracks = [makeTrack('video', 1), makeTrack('audio', 1)];
  state.selection.clear();
  state.playhead = 0;
  state.selTransition = null;
  state.inPoint = state.outPoint = null;
  state.filePath = null;
  state.out.loudness = Object.assign({}, AudioFX.LOUD_DEFAULTS);
  state.tighten = Object.assign({}, TIGHTEN_DEFAULTS);
  state.captions = Object.assign({}, Captions.DEFAULTS);
  transcriptCache.clear();
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
    captions: state.captions,
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

/**
 * A path argument, or `null` meaning "ask me". ONLY a string is a path.
 *
 * `openProject` is wired to a click listener, and a listener hands its handler an Event.
 * That was harmless while the function took no arguments at all - the moment it took one,
 * `#btnOpen` began sending a structured-cloned Event to main, and `fs.readFileSync`
 * refused it: *the "path" argument must be of type string ... received an instance of
 * Object*. The listener passes nothing now, and this exists so the next caller cannot
 * reintroduce it - a function that is both a handler and an API needs the coercion at the
 * door rather than at every call site.
 *
 * Separate and named so `smoke.js` can assert it. `window.api` is frozen by
 * `contextBridge`, so a suite cannot stub the IPC call to watch what it was sent.
 */
function projectPathArg(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Open a project. With no argument it asks; with a path it opens that file.
 *
 * The path form is what the launch argument uses - `ShortCut.bat some.scut`, or
 * `npx electron . some.scut` - so a project under test can be reopened without walking
 * the file dialog every time. It is the same code either way; only the dialog is skipped.
 */
async function openProject(filePath) {
  if (state.dirty && !confirmDiscard()) return;
  const r = await window.api.openProject(projectPathArg(filePath));
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
  state.captions = Object.assign({}, Captions.DEFAULTS, d.captions);
  transcriptCache.clear();
  for (const t of state.tracks) {
    if (!t.transitions) t.transitions = [];
    for (const tr of t.transitions) Trans.normalize(tr);
    // Fill in effect parameters a project saved before they existed, and drop effect
    // types this build does not know - the same job Trans.normalize does above.
    for (const c of t.clips) {
      AudioFX.normalizeClip(c);
      FX.normalizeClip(c);
      Tracker.normalizeClip(c);
      // 'contain' or absent, and nothing else: an unknown value from a hand-edited or
      // newer file would fall through every branch of drawClipTo() as 'crop' anyway, so
      // it is normalised away rather than carried around meaning nothing.
      if (c.fit !== 'contain') delete c.fit;
    }
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
        id: c.id,
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
        // The visual stack is carried for ONE reason: `jobCacheKey()` hashes the job, and
        // a composited span's pixels depend on every effect on every clip under it. Leave
        // it out and turning up a blur would hit the cached render of the old picture.
        // ffmpeg never sees it - the baker has already drawn it by the time main runs.
        fx: c.fx && c.fx.length ? JSON.parse(JSON.stringify(c.fx)) : undefined,
        // The take itself stays off the job - it is thousands of samples. But a `cursor`
        // or `ripple` effect DRAWS from it, so the picture depends on something the key
        // could not otherwise see: two cuts of one file with different takes would share
        // a cached render. A digest is enough, because a take is recorded once and
        // replaced wholesale - what changes is which one is attached.
        mouse: mouseDigest(c),
        // Same reasoning one step along: a BOUND effect draws where a solved track says,
        // so those samples decide pixels the key could not otherwise see. Only the tracks
        // something is actually bound to are digested - a solved track nothing reads
        // changes no pixels, and putting it in the key would miss the cache of a render
        // it is identical to. `Tracker.digest()` carries no timeline position, which is
        // the rule that lets a bound clip keep its cached render when it is dragged.
        tracks: trackDigests(c),
        visible: (c.kind === 'video' || c.kind === 'image' || c.kind === 'text') &&
          t.type === 'video' && !t.hidden,
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
/**
 * The smallest thing that says WHICH on-render take a clip carries, for the render cache.
 *
 * `undefined` - so it serialises away entirely - unless the clip both has a take and
 * carries an enabled effect that draws from it. A clip whose cursor effect is bypassed is
 * a clip whose pixels do not depend on the take, and it must key the same as one that
 * never had the effect at all.
 *
 * Note what is NOT here any more: `clip.screen`. Screen telemetry no longer decides a
 * single pixel - the two effects that read it now read `clip.mouse` instead, and
 * auto-zoom bakes its answer into ordinary keyframes on `clip.fx`, which the job already
 * carries. Telemetry went back to describing the source rather than the picture, so it
 * went back out of the key.
 */
function mouseDigest(c) {
  if (!Cursor.has(c && c.mouse)) return undefined;
  const uses = (c.fx || []).some((f) =>
    f && f.enabled !== false && FX.DEFS[f.type] && FX.DEFS[f.type].needs === 'mouse');
  if (!uses) return undefined;
  const ev = c.mouse.events;
  return { n: ev.length, t0: ev[0].t, t1: ev[ev.length - 1].t, clicks: !!c.mouse.clicks };
}

/**
 * The solved samples every BOUND effect on this clip reads, reduced to a checksum.
 *
 * Undefined when nothing is bound, so a clip that merely carries a track keys exactly as
 * one that never had one - a solve is analysis, and analysis nothing reads changes no
 * pixels.
 */
function trackDigests(c) {
  // NOT gated on this clip owning tracks. A logo following a button in the recording
  // underneath it carries no track of its own, and an early return here left exactly that
  // case - the commonest cross-clip one there is - out of the render key entirely.
  // In STACK ORDER and without the track ids, for the same reason `jobCacheKey()` strips
  // an effect's `id`: an id is an identity handed out when the tracker was dropped, so
  // leaving it in would mean a duplicated clip never shared the original's cached render.
  const out = [];
  for (const f of (c.fx || [])) {
    if (!(f && f.enabled !== false && f.bind && f.bind.track)) continue;
    if (!(FX.DEFS[f.type] && FX.DEFS[f.type].bind)) continue;
    const owner = bindOwner(c, f.bind);
    if (!owner) { out.push(null); continue; }
    if (owner === c) { out.push(Tracker.digest(c, f.bind.track) || null); continue; }
    /*
     * A CROSS-CLIP binding does make these pixels depend on the relationship between two
     * clips, and the key has to say so or a cached render outlives the truth. What the
     * pixels actually depend on is not either clip's position but the OFFSET between
     * them: the constant that turns this clip's local time into the owner's source time.
     * Slide both clips down the timeline together and the picture is identical and the
     * key is unchanged; slide one, and it is neither.
     *
     * The owner's framing goes in for the same reason - the track is mapped through it,
     * so re-framing the recording moves everything bound to it.
     */
    out.push({
      d: Tracker.digest(owner, f.bind.track) || null,
      dt: Math.round((owner.in + c.start - owner.start) * 1e4) / 1e4,
      fr: { panX: owner.panX, panY: owner.panY, zoom: owner.zoom },
    });
  }
  return out.length ? out : undefined;
}

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
    // Identity, not pixels: two identical cuts of the same source must key the same.
    delete e.id;
    delete e.textClip;
    delete e.transRef;
    delete e.seqDir; delete e.bx; delete e.by; delete e.bw; delete e.bh;
    if (c.textClip) e.card = c.textClip.card;
    // Same rule one level down: an effect's `id` is an identity handed out by FX.create()
    // so the panel can address it, and it is different every time one is made. Leaving it
    // in would mean two clips wearing the same grade never shared a cached render, and
    // deleting an effect and adding it back would miss its own cache.
    if (e.fx) e.fx = e.fx.map((f) => { const g = Object.assign({}, f); delete g.id; return g; });
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


// ------------------------------------------------- the composite baker (bake-first)

/**
 * BAKE-FIRST RENDERING.
 *
 * Until step 6 every visual feature had to be written twice - a canvas draw for the
 * preview and a matching ffmpeg filter for the export - and the two drifted, repeatedly.
 * That is survivable for framing and transitions. It is not survivable for an effect
 * stack. So the renderer now bakes the picture and ffmpeg only encodes: for each output
 * frame of a disqualified span we seek the contributing elements, run the SAME
 * `compositeLayers()` the viewer runs, at output resolution, and stream RGBA into
 * frames.raw. ffmpeg overlays that one opaque full-frame layer and encodes.
 *
 * THE FAST PATH, exactly. A span still goes down the existing trim -> crop -> scale ->
 * overlay chain when both of these hold:
 *
 *   1. at most ONE picture clip (kind 'video' or 'image') is visible across the span, and
 *   2. no clip contributing to the span carries an effect stack (`clip.fx`, step 7 on).
 *
 * Anything else bakes. In practice that means real alpha compositing - two or more
 * pictures stacked - and, from step 7, any effect.
 *
 * Text cards and transitions do NOT disqualify a span, and that is not a loophole: they
 * are already baked from the one canvas implementation, so the stated reason for the fast
 * path ("far faster, and the pixels are identical") applies to them word for word. A card
 * is baked cropped to its painted bounds, which is a fraction of a full frame; folding it
 * into a full-frame composite would cost 20-100x the bytes for the same picture. A
 * transition additionally OWNS its window - its baked layer sits between tracks in the
 * overlay chain, while a composite layer is appended last and would cover it - so a
 * transition window is excluded from bake spans outright.
 *
 * The bake cache rules are unchanged and still load-bearing: a clip's position on the
 * timeline is not in the key (`jobCacheKey`), and frames stay raw, never PNG - PNG
 * encoding a large alpha-heavy frame costs 100-1500 ms against about 4 ms for
 * getImageData, which once turned a four second title card into a ten minute render.
 */

/**
 * Does this clip carry anything the ffmpeg chain cannot express?
 *
 * From step 7 that means an effect stack, and it means ANY effect: there is no ffmpeg
 * half of an effect to fall back on, so a clip carrying one has to be drawn by the
 * baker or the export would simply not have it. A bypassed effect, or one of a type this
 * build does not know, is not an effect - `FX.active()` decides, so the answer here and
 * the answer the draw path gives can never disagree.
 */
function clipNeedsBake(c) {
  // A 'contain' still is transparent around its edges, which ffmpeg's crop-and-fill chain
  // cannot express - it would scale the picture up to fill the frame and crop it, which
  // is the opposite of what the mode says. So it composites, exactly as an effect does.
  if (c.fit === 'contain') return true;
  return FX.active(c).length > 0;
}

/** Windows a transition owns, in timeline time. Those spans keep the existing chain. */
function transitionWindows(job) {
  return job.clips
    .filter((c) => c.kind === 'trans')
    .map((c) => ({ from: job.rangeFrom + c.start, to: job.rangeFrom + c.start + (c.out - c.in) }));
}

/** Would the frame at `t` have to be composited, rather than overlaid by ffmpeg? */
function needsCompositeAt(t, windows) {
  for (const w of windows) if (t >= w.from - 1e-6 && t < w.to + 1e-6) return false;
  const layers = layersAt(t);
  let pictures = 0;
  for (const c of layers) {
    if (isPictureClip(c)) pictures++;
    if (clipNeedsBake(c)) return true;
  }
  return pictures >= 2;
}

/**
 * The spans of a job that must be composited, in timeline time.
 *
 * Every clip edge and transition edge is a boundary; between two boundaries the visible
 * stack is constant, so one midpoint sample decides the whole slice. Adjacent slices with
 * the same answer are merged, which keeps a long two-layer sequence one bake rather than
 * one bake per cut underneath it.
 */
function compositeSpans(job) {
  const from = job.rangeFrom, to = job.rangeTo;
  if (!(to > from)) return [];
  const windows = transitionWindows(job);
  const edges = new Set([from, to]);
  for (const { clip } of allClips()) {
    for (const e of [clip.start, clipEnd(clip)]) if (e > from + 1e-6 && e < to - 1e-6) edges.add(e);
  }
  for (const w of windows) {
    for (const e of [w.from, w.to]) if (e > from + 1e-6 && e < to - 1e-6) edges.add(e);
  }
  const cuts = [...edges].sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a < 1e-4) continue;
    if (!needsCompositeAt((a + b) / 2, windows)) continue;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.to - a) < 1e-4) last.to = b;
    else spans.push({ from: a, to: b });
  }
  return spans;
}

/**
 * Bake every composited span into an opaque full-frame raw RGBA layer.
 *
 * Runs BEFORE bakeTextClips/bakeTransitions, because a clip whose whole visible extent
 * falls inside a bake span is dropped from the job here - the composite already contains
 * it, and leaving it in would decode it twice and paint it twice. A clip that straddles a
 * span edge stays: the composite layer is appended last, so it wins inside its own window
 * and the clip's own chain draws outside it.
 */
async function bakeComposite(job) {
  const dirs = [];
  const spans = compositeSpans(job);
  if (!spans.length) return dirs;

  const frame = document.createElement('canvas');
  frame.width = job.width; frame.height = job.height;
  const fctx = frame.getContext('2d');
  const frameDur = 1 / job.fps;
  const totalFrames = spans.reduce(
    (n, sp) => n + Math.max(1, Math.round((sp.to - sp.from) * job.fps)), 0);
  let done = 0;

  for (const span of spans) {
    const frames = Math.max(1, Math.round((span.to - span.from) * job.fps));
    const slot = await window.api.textSeq();
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
      const t = span.from + i / job.fps;
      const layers = layersAt(t);
      // Park every contributing element on this exact frame first. A still has no clock
      // and nothing to seek; a <video> gets the same bounded seek the transition baker
      // uses, so a stubborn one costs a frame and never the render.
      const pics = layers.filter(isPictureClip);
      await Promise.all(pics.map((c) => {
        const el = mediaFor(c);
        if (el.tagName === 'IMG') return Promise.resolve();
        el.muted = true;
        return seekMedia(el, clamp(c.in + (t - c.start), 0, Math.max(0, c.mediaDuration - 0.03)));
      }));

      compositeLayers(fctx, job.width, job.height, layers, t,
        (c) => { const el = mediaFor(c); return frameReady(el) ? el : null; }, frameDur);

      batch.set(fctx.getImageData(0, 0, job.width, job.height).data, inBatch * frameBytes);
      inBatch++;
      if (inBatch === BATCH) await flush();

      done++;
      if (i % 4 === 0 || i === frames - 1) {
        setStatus('Baking the composite... ' + done + ' / ' + totalFrames + ' frames');
        $('#renderBar').style.width = (done / totalFrames * 100) + '%';
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await flush();
    await window.api.textSeqDone(slot.dir, frames);

    job.clips.push({
      id: null,
      src: null,
      kind: 'baked',
      start: span.from - job.rangeFrom,
      in: 0,
      out: span.to - span.from,
      panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
      visible: true, audible: false,
      seqDir: slot.dir, bx: 0, by: 0, bw: job.width, bh: job.height,
    });
    log('Baked ' + frames + ' composited frames (' + job.width + 'x' + job.height + ') for ' +
      fmtTc(span.from) + ' - ' + fmtTc(span.to) + '.');
  }

  // Anything wholly inside a bake span is already in those pixels. Dropping it here is
  // what makes the bake a saving rather than a surcharge: buildArgs() only opens an input
  // for a clip that is still visible or audible, so its decoder goes with it.
  const covered = (a, b) => spans.some((sp) => a >= sp.from - 1e-4 && b <= sp.to + 1e-4);
  for (const e of job.clips) {
    if (!e.visible || e.kind === 'baked' || e.kind === 'trans') continue;
    const a = job.rangeFrom + e.start;
    if (covered(a, a + (e.out - e.in))) {
      e.visible = false;
      delete e.textClip;    // its card is in the composite; there is nothing left to bake
    }
  }
  return dirs;
}

/** Bake every canvas-drawn layer a job needs: the composite, text cards, transitions. */
async function bakeOverlays(job) {
  // An imported PNG pointer that has not decoded yet would be baked as the fallback
  // arrow, and that frame is in the file forever. The viewer can miss one and catch it
  // 16 ms later; the export cannot, so it waits here. Nothing else in the bake is allowed
  // to depend on a decode landing in time either - this is the one door.
  await FX.preloadImages(allClips().map((x) => x.clip));
  // The composite goes first: it decides which cards and clips are left to bake at all.
  const c = await bakeComposite(job);
  const a = await bakeTextClips(job);
  const b = await bakeTransitions(job);
  return c.concat(a, b);
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

  // A RENDER STOPS PLAYBACK, and it has to.
  //
  // `bakeComposite()` drives `mediaFor()` - the viewer's OWN element per clip, the same
  // one `syncMedia()` keeps under the playhead - and parks it on each bake frame in turn.
  // Left playing, the two fight over every element: the baker seeks one backwards, the
  // next frame of `loop()` seeks it forward again, and neither gets what it asked for.
  // The audible half is worse than the visible one. Baking a frame is a full-resolution
  // composite plus an 8 MB `getImageData`, and it only yields every fourth frame, so the
  // frame loop starves; `syncMedia()` then runs far too slowly to keep the audio elements
  // under a playhead that is still advancing in real time, and they drift, get corrected
  // by a large seek, drift again - which is the stutter - and end the render parked
  // mid-seek, which is the silence.
  //
  // Stopping first is the whole fix: there is one element per clip by design (a second
  // decoder per clip is what the pool exists to avoid), so the baker can only borrow it,
  // and it cannot borrow what is still in use.
  pause();
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

  // Same reason as the preview render above: the baker borrows the viewer's own elements
  // and cannot borrow what is still playing.
  pause();
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



// ---- motion tracking ----------------------------------------------------
//
// A tracker is dropped on a pixel, solved across the clip, and then READ - by an effect
// whose position is bound to it. Everything the solve produces is plain JSON on the clip
// (`clip.tracks`, see track.js), so undo, save and reload carry it exactly like anything
// else, and everything about HOW it is solved lives in the worker.
//
// TWO THINGS CARRY THE FEATURE, and both are here rather than in the kernel:
//
//   1. CONFIDENCE IS DRAWN, on the timeline lane. A lost track that looks like a solved
//      one is the failure mode of every tracker: the callout sits in the wrong place for
//      forty frames and nobody notices until the export. The strip under the clip is
//      quiet where the solve is sure and red where it is not.
//   2. DRAGGING THE MARKER RE-ANCHORS AND RE-SOLVES FORWARD ONLY. The frames before the
//      correction were either right already or corrected earlier, and re-solving them
//      would throw that work away - which is what turns "fix the one bad stretch" into
//      "track the whole thing again" and stops people correcting at all.

const Trk = {
  busy: false,
  cancel: false,
  drag: null,      // { clip, track, x, y } while a marker is being dragged
  worker: null,    // the Worker, built once
  job: 0,
};

/**
 * The worker, built from `track.js` + `track-worker.js` concatenated into one Blob.
 *
 * A Blob because `new Worker('track-worker.js')` is refused under `file://`, and a
 * concatenation because the kernel then has ONE source: the window, the worker and
 * `smoke-track.js` all run the same optical flow, and a worker build cannot drift away
 * from the one the suite checks.
 */
async function trackWorker() {
  if (Trk.worker) return Trk.worker;
  const [kernel, driver] = await Promise.all([
    fetch('track.js').then((r) => r.text()),
    fetch('track-worker.js').then((r) => r.text()),
  ]);
  const url = URL.createObjectURL(new Blob([kernel + '\n;\n' + driver], { type: 'text/javascript' }));
  Trk.worker = new Worker(url);
  URL.revokeObjectURL(url);
  return Trk.worker;
}

/** One round trip to the worker. Rejects rather than hanging if the worker answers badly. */
function trkSend(w, msg, transfer) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (!e.data || e.data.id !== msg.id) return;
      w.removeEventListener('message', onMsg);
      if (e.data.ok) resolve(e.data); else reject(new Error(e.data.error || 'worker failed'));
    };
    w.addEventListener('message', onMsg);
    w.postMessage(msg, transfer || []);
  });
}

const trkCanvas = document.createElement('canvas');

/**
 * One analysis frame: the clip's SOURCE picture, unframed, at the solve resolution.
 *
 * Unframed on purpose. A track is stored in source fractions precisely so that panning,
 * zooming or re-framing the clip afterwards does not move it, and solving through the
 * crop would bake today's framing into the answer.
 */
async function trkFrame(el, t, aw, ah) {
  await seekMedia(el, t);
  if (!frameReady(el)) return null;
  trkCanvas.width = aw; trkCanvas.height = ah;
  const c = trkCanvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(el, 0, 0, aw, ah);
  return c.getImageData(0, 0, aw, ah);
}

function trkStatus(msg, cls) {
  setStatus(msg, cls);
  renderInspector();
}

/**
 * Solve one track across a SOURCE-time range, in one direction.
 *
 * `dir` is +1 forward from the anchor and -1 backward from it. Backward is a second run
 * with the frames fed in reverse - the flow does not care which way time runs, and a
 * separate pass keeps the worker's "previous frame" state honest in both.
 *
 * Nothing here mutates the clip: it answers samples, and the caller decides what to do
 * with them under one `pushUndo()`.
 */
async function trkSolveRun(clip, track, el, from, to, dir, aw, ah, onProgress) {
  const rate = Math.max(1, track.rate || Tracker.DEFAULTS.rate);
  const step = 1 / rate;
  const w = await trackWorker();
  const id = 'j' + (++Trk.job);
  const anchorT = track.anchor.t;
  const first = await trkFrame(el, anchorT, aw, ah);
  if (!first) throw new Error('that clip has no decodable frame at the anchor');
  await trkSend(w, {
    cmd: 'start', id, opts: { win: track.win, levels: Tracker.DEFAULTS.levels },
    w: aw, h: ah, x: track.anchor.x * aw, y: track.anchor.y * ah, buf: first.data.buffer,
  }, [first.data.buffer]);

  const out = [];
  const n = Math.max(0, Math.floor(Math.abs((dir > 0 ? to : from) - anchorT) / step));
  try {
    for (let i = 1; i <= n; i++) {
      if (Trk.cancel) break;
      const t = anchorT + dir * i * step;
      if (t < from - 1e-6 || t > to + 1e-6) break;
      const img = await trkFrame(el, t, aw, ah);
      if (!img) break;
      const r = await trkSend(w, { cmd: 'step', id, t, w: aw, h: ah, buf: img.data.buffer },
        [img.data.buffer]);
      out.push({ t, x: r.x / aw, y: r.y / ah, c: r.c });
      if (onProgress && (i % 5 === 0)) onProgress(i, n);
      // Never hang the render loop: the solve yields the thread between frames, so the
      // viewer keeps painting and the window keeps answering while it runs.
      await new Promise((res) => setTimeout(res, 0));
    }
  } finally {
    try { await trkSend(w, { cmd: 'end', id }); } catch (e) { /* the job is over anyway */ }
  }
  return out;
}

/**
 * Solve a track over a clip, both ways from its anchor, and write the result.
 *
 * ONE undo entry for the whole solve, taken after the frames are in and before anything
 * is written - a solve is one operation however many hundred samples it produces.
 * `forwardOnly` is the re-anchor path: the solved past is kept exactly as it was.
 */
async function solveTrack(clip, track, forwardOnly) {
  if (Trk.busy) { setStatus('A track is already solving.', 'err'); return null; }
  const el = mediaFor(clip);
  if (!el) { setStatus('That clip has no media to track.', 'err'); return null; }
  const sw = clip.srcW || 1920, sh = clip.srcH || 1080;
  const long = Math.max(1, Math.max(sw, sh));
  const scale = Math.min(1, (track.res || Tracker.DEFAULTS.res) / long);
  const aw = Math.max(16, Math.round(sw * scale)), ah = Math.max(16, Math.round(sh * scale));
  const from = forwardOnly ? track.anchor.t : clip.in;
  const to = clip.out;

  // The disk cache first, keyed by the file and by the solve - the waveform cache's
  // rules. A solve costs a seek per frame, so a clip tracked from this pixel before
  // comes back in a file read.
  const key = Tracker.cacheKey({
    t0: from, t1: to, ax: track.anchor.x, ay: track.anchor.y, anchorT: track.anchor.t,
    res: track.res, rate: track.rate, win: track.win, levels: Tracker.DEFAULTS.levels,
  });
  let pts = null;
  try { pts = clip.src ? await window.api.trackRead(clip.src, key) : null; } catch (e) { pts = null; }

  // A point with nothing to track is refused BEFORE the solve, not discovered after it.
  //
  // This is what the first build got wrong and it was the whole of the bad experience:
  // dropping a tracker on a flat area and solving produced four hundred samples of zero
  // confidence, a lane strip of solid red, and no hint that the answer was "you put it
  // somewhere there is nothing to follow". A seek per frame is an expensive way to learn
  // that, and the texture score answers it from one frame.
  if (!(track.tex == null) && track.tex < Tracker.DEFAULTS.minTex) {
    trkStatus('Nothing to track at that point - it is a flat area. Drag the marker onto ' +
      'an edge, a corner, an icon or some text and try again.', 'err');
    return null;
  }

  Trk.busy = true;
  Trk.cancel = false;
  const t0 = performance.now();
  try {
    if (!pts) {
      trkStatus('Tracking...');
      const fwd = await trkSolveRun(clip, track, el, from, to, +1, aw, ah,
        (i, n) => setStatus('Tracking... ' + Math.round(100 * i / Math.max(1, n)) + '%'));
      const back = forwardOnly ? []
        : await trkSolveRun(clip, track, el, from, to, -1, aw, ah, null);
      pts = fwd.concat(back);
      if (!Trk.cancel && clip.src) {
        try { await window.api.trackWrite(clip.src, key, pts); } catch (e) { /* cache only */ }
      }
    }
    pushUndo();
    if (forwardOnly) {
      // Everything after the anchor is replaced; everything before it survives, which is
      // the whole point of correcting one frame rather than re-tracking the clip.
      track.points = track.points.filter((p) => p.t <= track.anchor.t + 1e-6);
    }
    Tracker.mergePoints(track, pts);
    Tracker.normalizeClip(clip);
    markDirty();
    renderAll();
    const worst = Tracker.worstIn(track, clip.in, clip.out);
    trkStatus('Tracked ' + track.points.length + ' samples in ' +
      ((performance.now() - t0) / 1000).toFixed(1) + 's, lowest confidence ' +
      Math.round(worst * 100) + '%', worst < Tracker.DEFAULTS.minConf ? 'err' : '');
    return track;
  } catch (e) {
    trkStatus('Tracking failed: ' + ((e && e.message) || e), 'err');
    return null;
  } finally {
    Trk.busy = false;
  }
}

/** The analysis frame size for a clip - one place, so a drop and a solve agree. */
function trkAnalysisSize(clip, res) {
  const sw = clip.srcW || 1920, sh = clip.srcH || 1080;
  const scale = Math.min(1, (res || Tracker.DEFAULTS.res) / Math.max(1, Math.max(sw, sh)));
  return { aw: Math.max(16, Math.round(sw * scale)), ah: Math.max(16, Math.round(sh * scale)) };
}

/** Frame fractions to SOURCE fractions - the inverse of the map a binding reads forwards. */
function trkSourcePoint(clip, fx, fy) {
  const crop = Tracker.frameMap(clip, state.out.w / state.out.h).crop;
  return {
    x: clamp(crop.x + fx * crop.w, 0, 1),
    y: clamp(crop.y + fy * crop.h, 0, 1),
  };
}

// How far a drop is allowed to snap, as a fraction of the analysis frame's shorter side.
const TRK_SNAP = 0.035;

/**
 * Score a point on one frame, and snap it to the best feature within a short reach.
 *
 * SNAPPING IS NOT A CONVENIENCE, it is most of what makes the feature usable by a person
 * rather than by someone who knows what an eigenvalue is. People aim at the MIDDLE of the
 * thing they want to follow, and the middle of a button, a card or an icon is its
 * flattest, least trackable part - its corners, a few pixels away, are what optical flow
 * can actually hold. So a drop lands on the best point near where it was aimed, and the
 * panel then says how good that point is.
 *
 * Answers `null` when no frame can be decoded, and the caller places the point unscored
 * rather than refusing - a clip whose decoder is busy must not swallow the interaction.
 */
async function trkScorePoint(clip, tSrc, sx, sy) {
  const el = mediaFor(clip);
  if (!el) return null;
  const { aw, ah } = trkAnalysisSize(clip, Tracker.DEFAULTS.res);
  const img = await trkFrame(el, tSrc, aw, ah);
  if (!img) return null;
  const pyr = Tracker.buildPyramid(Tracker.gray(img.data, aw, ah), aw, ah, Tracker.DEFAULTS.levels);
  const reach = clamp(Math.round(TRK_SNAP * Math.min(aw, ah)), 6, 24);
  const best = Tracker.bestFeatureNear(pyr, sx * aw, sy * ah, reach, {});
  return { x: best.x / aw, y: best.y / ah, tex: best.tex };
}

/** How a texture score reads in the panel and in the status line. */
function trkQuality(tex) {
  // The bands are calibrated against the measurements in track.js: an ordinary soft
  // button corner scores around 0.11, a hard high-contrast corner scores 1.0, and dither
  // on a flat wall scores about 0.012. Calling everything under 0.3 weak would flag most
  // real interface footage, which is how a warning stops being read.
  if (tex == null) return { word: 'not measured', cls: '' };
  if (tex < Tracker.DEFAULTS.minTex) return { word: 'nothing to track here', cls: 'err' };
  if (tex < 0.08) return { word: 'weak', cls: 'err' };
  if (tex < 0.4) return { word: 'usable', cls: '' };
  return { word: 'strong', cls: '' };
}

/**
 * Drop a tracker at the playhead. IT DOES NOT SOLVE.
 *
 * Placing and solving used to be one action, and that was the wrong order: the marker
 * landed in the middle of the frame - which is almost never the thing anyone wants to
 * follow - and immediately spent a seek per frame proving it could not follow it. Place,
 * look, drag it onto the feature, THEN solve. The button that solves says so.
 */
async function addTracker(clip, fx, fy) {
  const tSrc = clamp(clip.in + (state.playhead - clip.start), clip.in, clip.out);
  const p = trkSourcePoint(clip, fx, fy);
  const scored = await trkScorePoint(clip, tSrc, p.x, p.y);
  pushUndo();
  if (!Array.isArray(clip.tracks)) clip.tracks = [];
  const tk = Tracker.makeTrack(tSrc, scored ? scored.x : p.x, scored ? scored.y : p.y, {
    name: 'Track ' + (clip.tracks.length + 1),
    tex: scored ? scored.tex : null,
  });
  clip.tracks.push(tk);
  markDirty();
  renderAll();
  const q = trkQuality(tk.tex);
  trkStatus('Tracker placed (' + q.word + '). Drag it onto what you want to follow, ' +
    'then press Solve.', q.cls);
  return tk;
}

function deleteTracker(clip, id) {
  pushUndo();
  // A binding to a track that is gone is LEFT ALONE rather than tidied up: the effect
  // degrades to its static parameters and the panel says why. Silently editing the stack
  // because a track was deleted would be a second, invisible edit inside one undo entry.
  clip.tracks = (clip.tracks || []).filter((t) => t.id !== id);
  Tracker.normalizeClip(clip);
  markDirty();
  renderAll();
}

/**
 * The clip a binding's track lives on - this one, or another clip on the timeline.
 *
 * `bind.clip` is absent for the ordinary same-clip case, so nothing that never crosses a
 * clip boundary carries the field at all.
 */
function bindOwner(clip, bind) {
  if (!bind || !bind.clip || bind.clip === clip.id) return clip;
  const f = findClip(bind.clip);
  return f ? f.clip : null;
}

/**
 * Resolve a binding, including one that reaches ACROSS CLIPS.
 *
 * This is the half `fx.js` deliberately cannot do. A logo on V2 following a button in the
 * screen recording on V1 needs the timeline - the two clips' positions on it - and an
 * effect that could read `clip.start` would be putting a timeline position into its own
 * pixels, which the render cache's key rules forbid. So the resolver lives out here,
 * where the timeline is legitimately visible, and the matching duty comes with it:
 * `trackDigests()` puts the resulting dependency into the render key, so a cached render
 * cannot survive a change to the relationship between the two clips.
 *
 * The point is mapped through the framing of the clip that OWNS the track, not of the
 * clip being drawn. A track is a place on its own source; where it appears on screen is
 * that source's pan, zoom and crop. Mapping it through the logo's framing would put the
 * logo wherever the logo's own crop happened to point, which is nowhere in particular.
 *
 * Everything degrades: a binding to a clip that has been deleted, or to a track that has,
 * answers null and the effect draws its own parameters instead.
 */
FX.setBinder((clip, bind, tLocal, W, H) => {
  const owner = bindOwner(clip, bind);
  if (!owner) return null;
  const A = (Number(W) || 9) / (Number(H) || 16);
  if (owner === clip) return Tracker.bindPos(clip, bind, clip.in + tLocal, A, tLocal);
  // Across clips: this clip's local time -> the timeline -> the owner's source time.
  const tOwner = owner.in + ((clip.start + tLocal) - owner.start);
  return Tracker.bindPos(owner, bind, tOwner, A, tLocal);
});

/** Every track marker visible on the viewer right now, in frame fractions. */
function trackMarkers() {
  const sel = selectedClips().map((x) => x.clip).filter((c) => Tracker.hasTracks(c));
  const out = [];
  for (const c of sel) {
    const tLocal = state.playhead - c.start;
    if (tLocal < -1e-6 || tLocal > (c.out - c.in) + 1e-6) continue;
    const m = Tracker.frameMap(c, state.out.w / state.out.h);
    for (const tk of c.tracks) {
      const s = Tracker.sampleAt(tk, c.in + tLocal);
      if (!s) continue;
      const p = m(s.x, s.y);
      out.push({ clip: c, track: tk, x: p.x, y: p.y, c: s.c });
    }
  }
  return out;
}

/**
 * The markers, drawn over the viewer and never into it.
 *
 * Like the take's rubber band, this is an affordance rather than a layer: it is painted
 * after `drawPreview()`, and it is never composited, never baked and never in a cache
 * key. A tracker you cannot see is a tracker you cannot drag onto the right pixel.
 */
function drawTrackOverlay(c, W, H) {
  const marks = trackMarkers();
  if (!marks.length) return;
  for (const m of marks) {
    const x = m.x * W, y = m.y * H;
    // "Lost" is only a thing a SOLVED track can be. A marker that has not been solved yet
    // is not failing at anything - it is waiting to be put somewhere and solved, and
    // painting it in the alarm colour was half of why the first build read as broken.
    const solved = Tracker.isSolved(m.track);
    const lost = solved && m.c < Tracker.DEFAULTS.minConf;
    const col = lost ? '#e0533f' : Cursor.ACCENT;
    c.save();
    c.strokeStyle = col;
    c.fillStyle = col;
    c.lineWidth = 1.5;
    const r = 9;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(x - r - 5, y); c.lineTo(x - 3, y);
    c.moveTo(x + 3, y); c.lineTo(x + r + 5, y);
    c.moveTo(x, y - r - 5); c.lineTo(x, y - 3);
    c.moveTo(x, y + 3); c.lineTo(x, y + r + 5);
    c.stroke();
    c.font = '11px system-ui, sans-serif';
    c.fillText(m.track.name + (lost ? '  lost' : (solved ? '' : '  drag me, then Solve')),
      x + r + 8, y - r - 2);
    c.restore();
  }
  if (Trk.drag) {
    c.save();
    c.strokeStyle = Cursor.ACCENT;
    c.setLineDash([4, 3]);
    c.beginPath();
    c.arc(Trk.drag.x * W, Trk.drag.y * H, 11, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
}

const TRK_GRAB = 16;   // how near the pointer has to be, in canvas pixels, to grab one

/** The marker under a pointer event, or null. The nearest wins when two overlap. */
function markerAt(e) {
  const P = previewSize();
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / Math.max(1, r.width) * P.w;
  const y = (e.clientY - r.top) / Math.max(1, r.height) * P.h;
  let best = null, bestD = TRK_GRAB * TRK_GRAB;
  for (const m of trackMarkers()) {
    const dx = m.x * P.w - x, dy = m.y * P.h - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = m; }
  }
  return best;
}

/**
 * Dragging a marker RE-ANCHORS it, and re-solves forward of that frame only.
 *
 * These run in the capture phase, ahead of the framing drag, for the same reason the
 * take's handlers do: while the pointer is on a tracker the viewer is a tracking surface,
 * not a framing control. A press that lands anywhere else is a framing drag as before.
 */
canvas.addEventListener('pointerdown', (e) => {
  if (Mouse.recording || Trk.busy) return;
  const m = markerAt(e);
  if (!m) return;
  e.preventDefault();
  e.stopPropagation();
  // ALT is "fix just this frame". The two repairs are genuinely different operations and
  // the difference is what happens to the solved future: a plain drag says the solve went
  // wrong from here on and re-solves it, and an Alt-drag says this one frame is wrong and
  // leaves every other sample alone. In the middle of a long track with one bad stretch,
  // re-solving the remaining minute to correct six frames is a bad trade.
  Trk.drag = { clip: m.clip, track: m.track, x: m.x, y: m.y, fixOnly: !!e.altKey };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
}, true);

canvas.addEventListener('pointermove', (e) => {
  if (!Trk.drag) return;
  const p = mousePointAt(e);
  Trk.drag.x = p.x; Trk.drag.y = p.y;
}, true);

canvas.addEventListener('pointerup', (e) => {
  const d = Trk.drag;
  if (!d) return;
  Trk.drag = null;
  e.preventDefault();
  e.stopPropagation();
  if (d.fixOnly) fixTrackerHere(d.clip, d.track, d.x, d.y);
  else reanchorTracker(d.clip, d.track, d.x, d.y);
}, true);

/**
 * Move a tracker onto a frame-fraction point at the playhead.
 *
 * Whether that re-solves depends on whether there was a solve to correct, and the
 * difference matters: dragging a FRESH marker into place is still placing it, and firing
 * a solve off every time someone nudges an unsolved tracker is the same impatience that
 * made the first build unusable. A SOLVED track dragged is a correction, and that does
 * re-solve - forward of that frame only, because the past is work already accepted.
 */
async function reanchorTracker(clip, track, fx, fy) {
  const wasSolved = Tracker.isSolved(track);
  const tSrc = clamp(clip.in + (state.playhead - clip.start), clip.in, clip.out);
  const p = trkSourcePoint(clip, fx, fy);
  const scored = await trkScorePoint(clip, tSrc, p.x, p.y);
  pushUndo();
  Tracker.reanchorAt(track, tSrc, scored ? scored.x : p.x, scored ? scored.y : p.y);
  if (scored) track.tex = Math.round(scored.tex * 1e5) / 1e5;
  markDirty();
  renderAll();
  const q = trkQuality(track.tex);
  if (!wasSolved) {
    trkStatus('Tracker moved (' + q.word + '). Press Solve when it is where you want it.', q.cls);
    return null;
  }
  return solveTrack(clip, track, true);
}

/**
 * Pin one frame of a track to a point, without disturbing anything else.
 *
 * The Alt-drag, and the surgical half of repair. It also re-bridges the lost runs this
 * new fixed point now bounds, which is what makes correcting the middle of a bad stretch
 * worth doing: one drag in the right place turns a frozen span into a line through the
 * frame the object actually crossed.
 */
function fixTrackerHere(clip, track, fx, fy) {
  const p = trkSourcePoint(clip, fx, fy);
  const tSrc = clamp(clip.in + (state.playhead - clip.start), clip.in, clip.out);
  pushUndo();
  Tracker.fixPointAt(track, tSrc, p.x, p.y);
  Tracker.normalizeClip(clip);
  markDirty();
  renderAll();
  trkStatus('Fixed this frame by hand. The rest of the track is untouched - ' +
    Tracker.fixCount(track) + ' fixed sample(s) in all.');
}

/** Interpolate across every lost span that has solved samples on both sides. ONE undo. */
function repairTrack(clip, track) {
  const before = Tracker.lostSpans(track, Tracker.DEFAULTS.minConf);
  if (!before.length) { trkStatus('Nothing lost on this track.'); return; }
  pushUndo();
  const r = Tracker.repairSpans(track, {});
  Tracker.normalizeClip(clip);
  markDirty();
  renderAll();
  const msg = r.bridged
    ? 'Repaired ' + r.bridged + ' lost span' + (r.bridged === 1 ? '' : 's') +
      ' by interpolating across ' + (r.bridged === 1 ? 'it' : 'them') + '.'
    : 'Nothing could be interpolated.';
  trkStatus(msg + (r.edges
    ? ' ' + r.edges + ' span' + (r.edges === 1 ? ' is' : 's are') + ' at the start or end ' +
      'of the track, which cannot be bridged - scrub there, drag the marker onto the ' +
      'right pixel and it will re-solve.'
    : ''), r.edges ? 'err' : '');
}

/**
 * The `transform` an image's placement panel owns, created on demand.
 *
 * Tagged `gen:'place'` the way auto-zoom tags its own, so the panel can find the one it
 * is responsible for among however many transforms the author has added by hand. It is
 * put FIRST in the stack, because placement is what the picture is - a blur or a grade
 * added later should apply to the placed image, not to a full-frame one that a later
 * transform then shrinks.
 */
function placeFx(clip, create) {
  const found = (clip.fx || []).find((f) => f && f.type === 'transform' && f.gen === 'place');
  if (found || !create) return found || null;
  if (!Array.isArray(clip.fx)) clip.fx = [];
  const e = FX.create('transform');
  e.gen = 'place';
  clip.fx.unshift(e);
  return e;
}

/**
 * Size and position for a still, in one place, plus the option to follow a tracker.
 *
 * Everything here already existed - `fit` on the clip, a `transform` in the stack, a
 * binding on that transform - and that was the problem: placing a logo meant knowing that
 * an image is framed like video, that the stack is where position lives, and which effect
 * to add. This panel is the answer to "I put an image on the timeline, how do I size and
 * place it", and it writes the same plain JSON any of those routes would have.
 */
function imagePlacePanel(clip) {
  if (!clip || clip.kind !== 'image') return null;
  const el = TextUI.el;
  const box = el('div', 'fx-az trk-box');

  const head = el('div', 'fx-head');
  head.appendChild(el('b', null, 'Size and position'));
  box.appendChild(head);

  const hooks = {
    onEdit: inspectorEdit,
    onEditEnd: inspectorEditEnd,
    onChanged: () => { markDirty(); drawPreview(); },
    rebuild: renderInspector,
  };

  // Fit first, because it decides what every control under it means.
  const fitRow = el('div', 'tc-row');
  fitRow.appendChild(el('label', 'tc-label', 'Fit'));
  const fitSel = el('select');
  for (const [value, label] of [['crop', 'Fill the frame (crop)'], ['contain', 'Whole image']]) {
    const o = el('option');
    o.value = value;
    o.textContent = label;
    fitSel.appendChild(o);
  }
  fitSel.value = clip.fit === 'contain' ? 'contain' : 'crop';
  fitSel.title = 'Fill crops the image to 9:16. Whole image keeps all of it and leaves ' +
    'the rest of the frame transparent - what a logo or a screenshot wants.';
  fitSel.addEventListener('change', () => {
    pushUndo();
    if (fitSel.value === 'contain') clip.fit = 'contain'; else delete clip.fit;
    markDirty();
    renderAll();
  });
  fitRow.appendChild(fitSel);
  box.appendChild(fitRow);

  const contain = clip.fit === 'contain';
  box.appendChild(el('div', 'tc-hint fx-note', contain
    ? 'Size is how large the whole image is drawn; X and Y place it in the frame. It ' +
      'composites with alpha, so a transparent PNG stays transparent.'
    : 'The image fills the frame and is cropped to it. Size zooms into it and X and Y ' +
      'choose which part shows. Switch to Whole image to place a logo or a screenshot.'));

  const C = (spec) => TextUI.control(spec, clip, FRAMING_DEFAULTS, hooks);
  box.appendChild(C({ path: 'zoom', label: contain ? 'Size' : 'Zoom', type: 'range',
    min: contain ? 0.05 : 1, max: 4, step: 0.01, digits: 2 }));
  box.appendChild(C({ path: 'panX', label: 'X', type: 'range', min: 0, max: 1, step: 0.005, digits: 3 }));
  box.appendChild(C({ path: 'panY', label: 'Y', type: 'range', min: 0, max: 1, step: 0.005, digits: 3 }));

  // Rotation, opacity and - the point of the exercise - a binding, all of which live on a
  // transform in the stack. The panel owns one and shows the parts that belong here.
  const d = FX.DEFS.transform;
  const fx = placeFx(clip, false);
  const edit = (fn) => {
    pushUndo();
    fn();
    FX.normalizeClip(clip);
    markDirty();
    renderAll();
  };

  const ensure = el('div', 'fx-add');
  if (!fx) {
    const b = el('button', 'mini', 'Add rotation, opacity, or follow a tracker');
    b.title = 'Adds a Transform to this clip\u2019s effect stack and shows its controls here.';
    b.addEventListener('click', () => edit(() => placeFx(clip, true)));
    ensure.appendChild(b);
    box.appendChild(ensure);
    return box;
  }

  const rowHooks = Object.assign({}, hooks);
  for (const path of ['params.rotate', 'params.opacity']) {
    const spec = d.schema.find((x) => x.path === path);
    if (spec) box.appendChild(TextUI.control(spec, fx, { params: d.params }, rowHooks));
  }
  // Offset X/Y on the transform stack on top of the X/Y above. They are what a binding
  // writes, so they are shown only to say so rather than as another pair of sliders.
  for (const node of fxBindSection(clip, fx, d, rowHooks, edit)) box.appendChild(node);
  return box;
}

/**
 * The Motion tracking section of the inspector.
 *
 * Only for a clip with moving media to track - an image has one frame and a text card
 * has none, and a row of dead buttons is worse than no row. That is the same degradation
 * contract the pointer effects keep, shown rather than described.
 */
function trackPanel(clip) {
  if (!clip || clip.kind !== 'video' || !clip.src) return null;
  const el = TextUI.el;
  const box = el('div', 'fx-az trk-box');

  const head = el('div', 'fx-head');
  head.appendChild(el('b', null, 'Motion tracking'));
  const n = (clip.tracks || []).length;
  head.appendChild(el('span', 'tc-hint', n ? n + (n === 1 ? ' track' : ' tracks') : 'none'));
  box.appendChild(head);

  box.appendChild(el('div', 'tc-hint fx-note',
    'Three steps: add a tracker, drag it on the viewer onto the thing you want to ' +
    'follow, then Solve. Put it on an edge, a corner, an icon or some text - the middle ' +
    'of a flat button has nothing to follow. Once it is solved, an effect can bind its ' +
    'position to it, and dragging the marker corrects the track from that frame forward.'));

  for (const tk of (clip.tracks || [])) {
    const row = el('div', 'trk-row');
    const bar = el('div', 'fx-fx-head');
    bar.appendChild(el('b', null, tk.name));
    const solved = Tracker.isSolved(tk);
    const worst = Tracker.worstIn(tk, clip.in, clip.out);
    const isLost = solved && worst < Tracker.DEFAULTS.minConf;
    const q = trkQuality(tk.tex);
    // Unsolved says what it IS, not a confidence of 100% over a single sample - a number
    // that would be true, meaningless, and read as "this track is fine".
    bar.appendChild(el('span', 'tc-hint' + (isLost || q.cls ? ' fx-warn' : ''),
      solved
        ? tk.points.length + ' samples · lowest confidence ' + Math.round(worst * 100) + '%'
        : 'not solved yet · point quality: ' + q.word));
    const btns = el('div', 'fx-fx-btns');
    const mk = (label, title, fn, disabled) => {
      const b = el('button', 'mini', label);
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      btns.appendChild(b);
    };
    const lost = Tracker.lostSpans(tk, Tracker.DEFAULTS.minConf);
    const inner = lost.filter((sp) => !sp.edge).length;
    mk(solved ? 'Re-solve' : 'Solve',
      solved
        ? 'Solve this track again from its anchor, in both directions.'
        : 'Follow this point across the clip, both ways from here. One undo entry.',
      () => solveTrack(clip, tk, false),
      Trk.busy || (tk.tex != null && tk.tex < Tracker.DEFAULTS.minTex));
    if (solved && inner) {
      mk('Repair ' + inner + ' gap' + (inner === 1 ? '' : 's'),
        'Interpolate across every lost span that has solved samples on both sides. ' +
        'One undo entry.',
        () => repairTrack(clip, tk), Trk.busy);
    }
    mk('✕', 'Delete this track. Anything bound to it keeps its own settings.',
      () => deleteTracker(clip, tk.id));
    bar.appendChild(btns);
    row.appendChild(bar);
    // Said BEFORE a solve, which is the whole point of measuring the point at all: a
    // seek per frame is an expensive way to find out the answer was always going to be
    // "there is nothing there".
    if (tk.tex != null && tk.tex < Tracker.DEFAULTS.minTex) {
      row.appendChild(el('div', 'tc-hint fx-warn',
        'There is nothing to follow at that point - it is flat. Drag the marker onto an ' +
        'edge, a corner, an icon or some text. Solve is disabled until then.'));
    } else if (!solved && tk.tex != null && tk.tex < 0.08) {
      row.appendChild(el('div', 'tc-hint fx-warn',
        'That point is weak - it may drift. A corner holds far better than the middle ' +
        'of a shape or a soft gradient.'));
    }
    const fixes = Tracker.fixCount(tk);
    if (isLost) {
      const edges = lost.filter((sp) => sp.edge).length;
      const bits = [];
      if (inner) {
        bits.push(inner + ' gap' + (inner === 1 ? '' : 's') + ' in the middle of the ' +
          'track, which Repair can interpolate across');
      }
      if (edges) {
        bits.push(edges + ' at the start or end, which cannot be interpolated - scrub ' +
          'there, drag the marker onto the right pixel and it re-solves from there');
      }
      row.appendChild(el('div', 'tc-hint fx-warn',
        'This track loses the point: ' + bits.join(', and ') + '. The strip under the ' +
        'clip shows where.'));
    }
    if (solved) {
      row.appendChild(el('div', 'tc-hint',
        'Alt-drag the marker to fix just the frame you are on, leaving the rest of the ' +
        'track alone. A plain drag re-anchors and re-solves everything after it.' +
        (fixes ? '  ' + fixes + ' sample' + (fixes === 1 ? '' : 's') + ' fixed by hand ' +
          'or interpolated.' : '')));
    }
    box.appendChild(row);
  }

  const row = el('div', 'fx-add');
  const add = el('button', 'mini', 'Add tracker at playhead');
  add.title = 'Drops a tracker at the centre of the frame. It does not solve yet - ' +
    'drag it onto what you want to follow first, then press Solve.';
  add.disabled = Trk.busy;
  add.addEventListener('click', () => addTracker(clip, 0.5, 0.5));
  row.appendChild(add);
  if (Trk.busy) {
    const stop = el('button', 'mini', 'Stop');
    stop.title = 'Stop the solve. Whatever has been solved so far is kept.';
    stop.addEventListener('click', () => { Trk.cancel = true; });
    row.appendChild(stop);
  }
  box.appendChild(row);
  return box;
}


// ---- the on-render mouse take -------------------------------------------
//
// The SECOND kind of recording, and the one the drawn pointer belongs to.
//
// A screen capture already contains a real cursor in its pixels, so drawing another one
// over it gave two pointers chasing each other - the bug that split this feature in two.
// A mouse take is performed over the FINISHED 9:16 picture, which has no pointer in it,
// so the drawn one is the only one and the conflict is gone by construction rather than
// patched over. Screen captures keep auto-zoom, which draws no cursor at all.
//
// WHAT IS RECORDED, AND IN WHAT SPACE
//
//   moves and clicks   -> `clip.mouse`, x/y as fractions of the OUTPUT FRAME
//   Shift-drag boxes   -> a `select` effect per box, as tagged keyframes
//
// Frame fractions, not source fractions: the author is pointing at the composited
// picture, so that is the space the data means. `Cursor.mapperFor()` is what keeps the
// two straight - it asks the data which space it is in rather than trusting the caller.
//
// TIME COMES FROM THE PLAYHEAD, NOT THE CLOCK
//
// `state.playhead` is the authoritative time of the frame on screen, so a sample taken
// during a stutter is timed by the frame it belongs to rather than by when the pointer
// event happened to arrive. Step 8 needed a whole first-frame alignment pass to achieve
// the same thing against a real encoder; here it is free, and it is exact.

const Mouse = {
  recording: false,
  range: null,       // {from, to} in timeline seconds
  events: [],        // {t, x, y, type} in TIMELINE time, frame-fraction coordinates
  sels: [],          // finished Shift-drag selections, timeline time
  drag: null,        // the selection being dragged right now
  down: false,
};

/** Does this clip carry a performed take? The question every pointer effect asks. */
function clipHasTake(clip) {
  return !!(clip && Cursor.has(clip.mouse));
}

/** The pointer, as a fraction of the frame. Clamped: a drag off the edge still ends. */
function mousePointAt(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1),
    y: clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1),
  };
}

function mouseStatus(msg, kind) {
  const b = $('#btnMouse');
  if (b) b.classList.toggle('on', Mouse.recording);
  if (msg) setStatus(msg, kind);
}

/**
 * Start a take over the current range.
 *
 * The range must be PRE-RENDERED, and this refuses rather than limping: compositing a
 * stack of clips, cards and effects live while also asking the author to perform a
 * pointer against it drops frames, and a take performed against a stuttering picture is
 * timed to a picture nobody will ever see again. A preview render of the range makes the
 * viewer decode one finished MP4 instead, which is the whole reason preview renders
 * exist. `state.usePreviewRender` has to be on for the same reason.
 */
function startMouseTake() {
  if (Mouse.recording) return stopMouseTake();
  if (Rec.recording) { setStatus('Stop the screen recording first.', 'err'); return; }
  const dur = projectDuration();
  if (dur <= 0) { setStatus('Nothing to perform over - the timeline is empty.', 'err'); return; }
  const r = renderRange();
  if (r.to - r.from <= 0.05) { setStatus('That range is empty - move the in/out marks.', 'err'); return; }

  const covered = mouseRangeCovered(r);
  if (!covered) {
    setStatus('Render a preview of this range first (Preview render) - a take performed ' +
      'against a live composite is timed to dropped frames.', 'err');
    return;
  }
  if (!state.usePreviewRender) {
    setStatus('Turn on "Use preview renders" so the viewer plays the rendered picture.', 'err');
    return;
  }

  Mouse.recording = true;
  Mouse.range = { from: r.from, to: r.to };
  Mouse.events = [];
  Mouse.sels = [];
  Mouse.drag = null;
  Mouse.down = false;
  canvas.classList.add('taking');
  seek(r.from);
  play();
  mouseStatus('Performing - move the pointer over the viewer, click, Shift-drag to ' +
    'select. Esc or Mouse to stop.');
}

/** Is every part of the range covered by a valid rendered span? */
function mouseRangeCovered(r) {
  let t = r.from;
  const bands = state.cacheBands.filter((b) => b.file).slice().sort((a, b) => a.from - b.from);
  for (const b of bands) {
    if (b.from > t + 0.05) return false;
    if (b.to > t) t = b.to;
    if (t >= r.to - 0.05) return true;
  }
  return t >= r.to - 0.05;
}

/** Record one sample at the playhead. Called from the canvas handlers below. */
function mouseSample(e, type) {
  if (!Mouse.recording) return;
  const t = state.playhead;
  if (t < Mouse.range.from - 1e-6 || t > Mouse.range.to + 1e-6) return;
  const p = mousePointAt(e);
  Mouse.events.push({ t, x: p.x, y: p.y, type: type || ScreenTel.MOVE });
}

/**
 * Finish the take and write it onto the clips underneath it.
 *
 * ONE `pushUndo()` for the whole pass, however many clips it touches - a bulk operation
 * is one undo entry. Re-performing REPLACES: the previous take on each clip is dropped
 * and the previously generated `select` effects go with it, so a second attempt is a
 * second attempt rather than two pointers on top of each other. Effects the author added
 * by hand are left exactly where they are, the same rule auto-zoom keeps.
 */
function stopMouseTake() {
  if (!Mouse.recording) return;
  Mouse.recording = false;
  canvas.classList.remove('taking');
  pause();
  if (Mouse.drag) { mouseEndSelection(); }

  const events = Mouse.events.slice();
  const sels = Mouse.sels.slice();
  Mouse.events = [];
  Mouse.sels = [];
  if (!events.length) { mouseStatus('Nothing was performed - the take is discarded.', 'err'); return; }

  // Only picture clips on visible tracks, and only ones the range actually crossed.
  const targets = [];
  for (const t of state.tracks) {
    if (t.type !== 'video' || t.locked) continue;
    for (const c of t.clips) {
      if (!isPictureClip(c)) continue;
      if (clipEnd(c) <= Mouse.range.from + 1e-6 || c.start >= Mouse.range.to - 1e-6) continue;
      targets.push(c);
    }
  }
  if (!targets.length) { mouseStatus('No picture clip under that range.', 'err'); return; }

  const takes = Cursor.splitTake(events, targets);
  if (!takes.size) { mouseStatus('Nothing was performed over a clip.', 'err'); return; }

  pushUndo();
  let nClips = 0, nSel = 0;
  for (const c of targets) {
    const take = takes.get(c.id);
    if (!take) continue;
    nClips++;
    c.mouse = take;

    // The two pointer effects, added once and then left alone - re-performing must not
    // stack a second pair on top of the author's tuned first pair.
    if (!Array.isArray(c.fx)) c.fx = [];
    for (const type of ['cursor', 'ripple']) {
      if (!c.fx.some((f) => f && f.type === type)) c.fx.unshift(FX.create(type));
    }

    // Generated selections are replaced wholesale; hand-made ones are not touched.
    c.fx = c.fx.filter((f) => !(f && f.type === 'select' && f.gen === 'onrender'));

    // The rectangle has to track the pointer the viewer can SEE, which is the smoothed,
    // lagged one - so it is built from the same path, with this clip's own cursor
    // settings rather than the defaults, in case they have been tuned. Timeline time in,
    // frame-space out; `splitTake` put the take on the clip's source axis, so the
    // conversion is the same one `clipCursorAt()` makes.
    const cur = (c.fx || []).find((f) => f && f.type === 'cursor');
    const cp = (cur && cur.params) || Cursor.DEFAULTS.cursor;
    const pointerAt = (tt) => Cursor.smoothAt(
      c.mouse, tt - c.start + (Number(c.in) || 0), { smooth: cp.smooth, lag: cp.lag });

    for (const sel of sels) {
      const mid = (sel.t0 + sel.t1) / 2;
      if (mid < c.start || mid >= clipEnd(c)) continue;
      const built = Cursor.selectionKeys(sel, c, 'onrender', pointerAt);
      const fx = FX.create('select');
      fx.gen = 'onrender';
      // The static values are the box as RELEASED, so bypassing the keys or deleting them
      // leaves the shape that was drawn rather than a default rectangle somewhere else.
      // Taken from the generated keys rather than from `sel`, so they agree with what is
      // actually drawn - `sel` holds the raw corners and the keys hold the smoothed ones.
      const lastOf = (k) => (built.keys[k] && built.keys[k].length
        ? built.keys[k][built.keys[k].length - 1].v : sel[k]);
      fx.params.x = lastOf('x'); fx.params.y = lastOf('y');
      fx.params.w = lastOf('w'); fx.params.h = lastOf('h');
      fx.params.showFrom = built.t0;
      // The band is its own entrance, so the envelope's fade is short and the box holds
      // for a couple of seconds after the drag - long enough to be looked at, and an
      // ordinary parameter to drag out further.
      fx.params.fadeIn = Cursor.DEFAULTS.select.fadeIn;
      fx.params.showTo = Math.min(
        built.t1 + Cursor.DEFAULTS.select.hold, Math.max(0.05, c.out - c.in));
      Cursor.applyGenerated(fx, built.keys, 'onrender');
      c.fx.push(fx);
      nSel++;
    }
    FX.normalizeClip(c);
  }
  markDirty();
  renderAll();
  mouseStatus('Take recorded onto ' + nClips + ' clip' + (nClips === 1 ? '' : 's') +
    (nSel ? ' with ' + nSel + ' selection' + (nSel === 1 ? '' : 's') : '') + '.');
}

function mouseBeginSelection(e) {
  const p = mousePointAt(e);
  // `samples` is the MOVING corner over time. One corner is pinned at the press and the
  // other follows the pointer, so the committed effect can replay the band rather than
  // appear whole at its final size - the way a desktop marquee behaves.
  Mouse.drag = {
    x0: p.x, y0: p.y, x1: p.x, y1: p.y,
    t0: state.playhead,
    samples: [{ t: state.playhead, x: p.x, y: p.y }],
  };
}

function mouseEndSelection() {
  const d = Mouse.drag;
  Mouse.drag = null;
  if (!d) return;
  const rect = Cursor.normRect(d.x0, d.y0, d.x1, d.y1);
  // A Shift-click that never moved is not a selection; it would produce a zero-area box
  // that draws nothing and clutters the stack.
  if (rect.w < 0.02 || rect.h < 0.02) return;
  const t1 = Math.max(state.playhead, d.t0 + 0.1);
  d.samples.push({ t: t1, x: d.x1, y: d.y1 });
  Mouse.sels.push(Object.assign(
    { t0: d.t0, t1, x0: d.x0, y0: d.y0, samples: d.samples }, rect));
}

/** The live selection rectangle, drawn over the viewer while it is being dragged. */
function drawMouseOverlay(c, W, H) {
  if (!Mouse.recording || !Mouse.drag) return;
  const d = Mouse.drag;
  const r = Cursor.normRect(d.x0, d.y0, d.x1, d.y1);
  c.save();
  c.strokeStyle = Cursor.ACCENT;
  c.lineWidth = 2;
  c.setLineDash([6, 5]);
  c.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
  c.restore();
}

// ---- the screen recorder -------------------------------------------------
//
// The panel picks a source and starts the capture; main owns the capture itself and the
// telemetry (see "The screen recorder" in the README). What comes back is a file path,
// which then goes through importPaths() like anything else the user dropped in - so a
// recording is an ordinary clip on an ordinary track, and the telemetry rides in on its
// sidecar rather than through a second, special import path.
const Rec = {
  sources: [],
  pick: null,      // the chosen source object
  busy: false,
  recording: false,
  since: 0,
  timer: null,
  file: null,
};

/** Is this clip carrying screen telemetry? The one question every consumer asks first. */
function clipTelemetry(clip) {
  return ScreenTel.hasTelemetry(clip) ? clip.screen : null;
}

/**
 * The cursor position at `tLocal` seconds into a clip, or null.
 *
 * Telemetry `t` is in SOURCE time - seconds from the video file's first frame - which is
 * the only timebase that survives what the editor does to a clip afterwards. Trimming
 * moves `in`, splitting makes two clips out of one and both keep the whole event list,
 * and dragging changes `start`; none of that may move a click ripple off the pixel it
 * happened on. So every lookup goes through `clip.in`, exactly the way `mediaFor()` and
 * the framing maths do, and that is what steps 9 and 14 must use rather than reaching
 * into `clip.screen.events` themselves.
 */
function clipCursorAt(clip, tLocal) {
  const t = clipTelemetry(clip);
  return t ? ScreenTel.cursorAt(t, clip.in + tLocal) : null;
}

/** Mouse-downs inside a clip's visible span, retimed to seconds from the clip's start. */
function clipClicks(clip) {
  const t = clipTelemetry(clip);
  if (!t) return [];
  return ScreenTel.clicksIn(t, clip.in, clip.out).map((e) => ({ t: e.t - clip.in, x: e.x, y: e.y }));
}

function recSetStatus(msg) {
  const el = $('#recStatus');
  if (el) el.textContent = msg || '';
}

function recPaintSources() {
  const host = $('#recSources');
  if (!host) return;
  host.innerHTML = '';
  if (!Rec.sources.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No capturable screens or windows were offered.';
    host.appendChild(e);
    return;
  }
  for (const s of Rec.sources) {
    const b = document.createElement('button');
    b.className = 'rec-src' + (Rec.pick && Rec.pick.id === s.id ? ' sel' : '');
    b.title = s.name;
    const img = document.createElement('img');
    if (s.thumbnail) img.src = s.thumbnail;
    b.appendChild(img);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = s.name;
    b.appendChild(n);
    const k = document.createElement('span');
    k.className = 'k';
    // Say it on the card, not in a footnote: this is the choice that decides whether
    // step 9's auto-zoom has anything to work with.
    k.textContent = s.region ? 'display - cursor telemetry' : 'window - picture only';
    b.appendChild(k);
    b.addEventListener('click', () => {
      if (Rec.recording) return;
      Rec.pick = s;
      recPaintSources();
      recUpdate();
    });
    host.appendChild(b);
  }
}

function recUpdate() {
  const start = $('#recStart'), stop = $('#recStop'), cur = $('#recCursor');
  if (!start) return;
  start.disabled = Rec.recording || Rec.busy || !Rec.pick;
  stop.disabled = !Rec.recording;
  if (cur) cur.disabled = Rec.recording || !(Rec.pick && Rec.pick.region);
  if (Rec.recording) {
    const secs = Math.max(0, (Date.now() - Rec.since) / 1000);
    recSetStatus('Recording  ' + fmtTc(secs));
  }
}

async function recOpen() {
  $('#recModal').hidden = false;
  if (Rec.recording) { recUpdate(); return; }
  recSetStatus('Looking for screens...');
  const r = await window.api.screenSources();
  if (!Array.isArray(r)) {
    Rec.sources = [];
    recSetStatus('Screen capture is unavailable: ' + ((r && r.error) || 'unknown error'));
  } else {
    Rec.sources = r;
    // A whole display is what the feature is for, so it is what is selected by default.
    Rec.pick = r.find((s) => s.type === 'screen' && s.region) || r[0] || null;
    recSetStatus('');
  }
  recPaintSources();
  recUpdate();
}

function recClose() { $('#recModal').hidden = true; }

async function startRecording() {
  if (Rec.recording || Rec.busy || !Rec.pick) return;
  Rec.busy = true;
  recUpdate();
  const wantCursor = $('#recCursor') ? $('#recCursor').checked : true;
  recSetStatus('Starting...');
  const r = await window.api.screenStart({
    sourceId: Rec.pick.id,
    name: Rec.pick.name,
    type: Rec.pick.type,
    displayId: Rec.pick.displayId,
    cursor: wantCursor,
  });
  Rec.busy = false;
  if (!r || !r.ok) {
    recSetStatus('Could not start: ' + ((r && r.error) || 'unknown error'));
    log('Screen recording failed to start: ' + ((r && r.error) || 'unknown error'));
    recUpdate();
    return;
  }
  Rec.recording = true;
  Rec.since = Date.now();
  Rec.file = r.file;
  // The sheet is closed on purpose: it is on the screen being recorded. Ctrl+Shift+F9
  // is the way back, and it works while another application has focus.
  recClose();
  setStatus('Recording the screen - Ctrl+Shift+F9 to stop');
  log('Recording ' + (r.cursor ? 'with cursor telemetry' : 'picture only') +
    (r.cursor && !r.clicks ? ' (no click watcher - positions only)' : '') + '.');
  if (Rec.timer) clearInterval(Rec.timer);
  Rec.timer = setInterval(recUpdate, 250);
  recUpdate();
}

/**
 * Stop, then import what was recorded.
 *
 * The import is an ordinary `importPaths()` at the playhead, which means one pushUndo()
 * entry covering the whole arrival - and it means a recording behaves like any other
 * media from the moment it lands.
 */
async function stopRecording() {
  if (!Rec.recording) return;
  Rec.recording = false;
  if (Rec.timer) { clearInterval(Rec.timer); Rec.timer = null; }
  recSetStatus('Finishing...');
  setStatus('Finishing the recording...');
  const r = await window.api.screenStop();
  recUpdate();
  if (!r || !r.ok) {
    recSetStatus('Recording failed: ' + ((r && r.error) || 'unknown error'));
    log('Recording failed: ' + ((r && r.error) || 'unknown error'));
    setStatus('Ready');
    return;
  }
  const secs = Math.max(0, (Date.now() - Rec.since) / 1000);
  log('Recorded ' + fmtTc(secs) + ' -> ' + r.file +
    (r.cursor ? '  (' + r.samples + ' cursor samples, ' + r.clicks + ' clicks)' : '  (no telemetry)'));
  recSetStatus('Saved ' + fmtTc(secs));
  setStatus('Ready');
  await importPaths([r.file], { at: state.playhead });
  return r;
}

/**
 * The one gesture: start if idle, stop if recording.
 *
 * A toggle rather than two keys because the moment you want to START is the moment you
 * have already switched to the app you are demonstrating - and a key that only stopped
 * meant every recording opened on a shot of ShortCut's own toolbar while the user went
 * back to find the Record button.
 *
 * It also has to work when the panel has never been opened, so it resolves a source of
 * its own: the primary display, which is the only defensible default and the one that
 * carries cursor telemetry. Anything else - a second monitor, a single window - is a
 * deliberate choice and is made in the panel.
 */
async function toggleRecording() {
  if (Rec.busy) return;
  if (Rec.recording) { await stopRecording(); return; }
  if (!Rec.pick) {
    const list = await window.api.screenSources();
    if (!Array.isArray(list) || !list.length) {
      log('Nothing to record: ' + ((list && list.error) || 'no capturable screen was offered') + '.');
      return;
    }
    Rec.sources = list;
    Rec.pick = list.find((s) => s.type === 'screen' && s.primary && s.region) ||
      list.find((s) => s.type === 'screen' && s.region) || list[0];
    recPaintSources();
  }
  await startRecording();
}

$('#btnMouse').addEventListener('click', () => {
  Mouse.recording ? stopMouseTake() : startMouseTake();
});

$('#btnRecord').addEventListener('click', () => recOpen());
$('#recClose').addEventListener('click', () => recClose());
$('#recStart').addEventListener('click', () => startRecording());
$('#recStop').addEventListener('click', () => stopRecording());
// The hotkey is registered in main, because it has to fire while another app has focus.
// It toggles, and it does not need the panel to have been opened first - see
// toggleRecording().
// A project named on the command line. Nothing has been edited yet at this point, so
// there is no unsaved work for openProject()'s discard prompt to ask about.
window.api.onOpenOnLaunch((p) => { openProject(p); });

window.api.onScreenHotkeyToggle(() => toggleRecording());
window.api.onScreenFailed((m) => {
  Rec.recording = false;
  if (Rec.timer) { clearInterval(Rec.timer); Rec.timer = null; }
  recUpdate();
  log('The recorder stopped: ' + m);
});

// ---- the QuickBin --------------------------------------------------------
//
// The bin is the library, the timeline is the edit: nothing in the bin is part of the
// project, and putting something on the timeline is an ordinary import at the playhead.
QuickBin.init({
  log,
  insert: (paths) => importPaths(paths, { at: state.playhead }),
  // A still goes on the timeline like anything else - UNLESS an object transition is
  // selected, which is the one thing in the app that wants a PNG rather than a clip.
  // Selecting the transition first is what says "this one is for you".
  useImage: async (paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    if (!list.length) return;
    const p = list[0];
    const r = selectedTransition();
    if (!r || r.tr.type !== 'object') {
      await importPaths(list, { at: state.playhead });
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
// Wrapped, like #btnCapCollapse below it. Bound directly, the click Event arrived as
// `show` - which is truthy, so `hide` was always false and the button could open the bin
// but never close it. `toggleBin()` with no argument is what flips it.
$('#btnBinCollapse').addEventListener('click', () => toggleBin());

$('#btnCapCollapse').addEventListener('click', () => toggleCaptions());

/** Show / hide the Captions panel. Collapsed it costs nothing: it builds no rows. */
function toggleCaptions(show) {
  const hide = show == null ? !$('#capPanel').hidden : !show;
  $('#capPanel').hidden = hide;
  $('#btnCapCollapse').textContent = hide ? '+' : '−';
  renderCaptionsPanel();
}

// Transcription reports over its own channel, the way the render bar does. It only ever
// writes into the panel's status line - a slow model must never touch the timeline.
window.api.onTranscribeProgress((d) => {
  if (!d) return;
  if (d.phase === 'download') {
    const pct = d.total ? Math.round(d.got / d.total * 100) : 0;
    capStatusMsg = 'Downloading the ' + d.model + ' model... ' + pct + '%';
  } else if (d.phase === 'extract') capStatusMsg = 'Extracting audio...';
  else if (d.phase === 'transcribe') {
    capStatusMsg = 'Transcribing' + (d.percent != null ? ' ' + d.percent + '%' : '') + '...';
  } else if (d.phase === 'done') capStatusMsg = '';
  if (capPanelPaint) capPanelPaint();
});

// The panel says whether whisper.cpp is actually there, rather than only finding out
// when somebody presses Transcribe.
window.api.transcribeState().then((st) => {
  capWhisper = st;
  if (capPanelPaint) capPanelPaint();
}).catch(() => {});

// The caption preset picker lists the same `full` presets the text panel saves, so a
// look authored on one card is one pick away from being every caption's look.
refreshCaptionPresets().then(() => renderCaptionsPanel()).catch(() => {});

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
// Wrapped, NOT passed directly: a listener hands its handler the click Event, and
// openProject() now takes a path as its first argument. See the guard inside it.
$('#btnOpen').addEventListener('click', () => openProject());
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
  ['Ctrl+Shift+F9', 'Start / stop recording the screen (works from any app)'],
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
  // Esc stops a take FIRST and does nothing else: the person performing has both hands
  // busy and the nearest exit has to be unambiguous, not also a deselect.
  else if (e.key === 'Escape' && Mouse.recording) { stopMouseTake(); }
  else if (e.key === 'Escape') { $('#modal').hidden = true; $('#recModal').hidden = true; setSelection([], false); }
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
    // The caption picker lists the same library, and it is a snapshot - without this a
    // look saved here is invisible to captions until the app restarts. Re-saving over a
    // name also has to drop the cached copy, or captions keep building from the old one.
    capPresetCache.delete(name);
    await refreshCaptionPresets();
    renderCaptionsPanel();
    log('Saved ' + kind + ' preset "' + name + '".');
  },
  loadLibraryPreset: (kind, name) => window.api.loadPreset(kind, name),
  deleteLibraryPreset: async (kind, name) => {
    await window.api.deletePreset(kind, name);
    await TextUI.reloadPresets();
    capPresetCache.delete(name);
    if (state.captions.preset === name) state.captions.preset = '';
    await refreshCaptionPresets();
    renderCaptionsPanel();
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
  selectedCardCount: () => selectedTextClips().length,
  applyToSelected: (kind, data, label) => {
    const cards = selectedTextClips();
    if (cards.length < 2) { log('Select more than one text card first.'); return; }
    // ONE undo entry for the whole spread, like every other bulk operation.
    pushUndo();
    // `keepText` is not optional here even for a 'full' payload: the wording and the word
    // timings are CONTENT, and copying the lead's across a selection of captions would
    // give thirty cards the same sentence. It is the same rule TEXT_PEER_SKIP enforces
    // for the panel's ordinary propagation.
    for (const c of cards.slice(1)) TextModel.applyPreset(c.card, data, { keepText: true });
    // The gesture baseline has to be re-taken, or the next edit to the lead would replay
    // the differences this just erased back across the whole selection.
    snapshotTextEdit();
    markDirty();
    renderAll();
    log('Applied this card\'s ' + String(label || kind).toLowerCase() + ' to ' +
      (cards.length - 1) + ' other selected card(s).');
  },
  getLocalTime: () => {
    const c = selectedTextClip();
    return c ? state.playhead - c.start : 0;
  },
  seekLocal: (t) => {
    const c = selectedTextClip();
    if (c) seek(c.start + t);
  },
  // The panel snapshots once per gesture, then reports the change. With several cards
  // selected the change is mirrored from the lead onto the rest - see syncTextPeers().
  onEdit: () => { pushUndo(); snapshotTextEdit(); },
  onChanged: () => { syncTextPeers(); markDirty(); drawPreview(); },
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
