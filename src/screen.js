'use strict';
/**
 * Screen-recording telemetry - the pure half.
 *
 * Loaded twice, exactly like `audiofx.js` and `captions.js`: as a plain <script> global
 * `ScreenTel` in index.html, and as a CommonJS module by main.js. Main samples the
 * cursor and writes the sidecar; the renderer reads it back on import and, from step 9,
 * draws from it. One copy of "what a telemetry file means" is the only way the two can
 * never disagree.
 *
 * Nothing here touches the DOM, canvas, ffmpeg, Electron or the filesystem.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT, stated once because steps 9 and 14 both lean on it:
 *
 *   Telemetry is OPTIONAL. A clip may carry `clip.screen`, or it may not, and every
 *   consumer must degrade to "no cursor data" rather than break. A recording from
 *   Screen Studio, OBS or a phone imports as an ordinary video clip with no `screen`
 *   field at all, and that is a supported, permanent state - not a missing feature.
 *   Ask `ScreenTel.hasTelemetry(clip)` first; `cursorAt()` and `clicksIn()` answer
 *   `null` / `[]` for a clip without it rather than throwing.
 * ---------------------------------------------------------------------------
 *
 * The sidecar is plain JSON next to the recording, `<name>.screen.json`:
 *
 *   { app:'shortcut-screen', version:1,
 *     video:  { file, w, h, fps, firstFrameEpochMs, durationMs },
 *     region: { x, y, w, h, scaleFactor, displayW, displayH },   // DIP + device px
 *     clicks: true|false,          // false = positions only, the watcher was unavailable
 *     events: [ { t, x, y, type } ] }
 *
 * `x`/`y` are NORMALISED to the captured region, 0..1, so they survive any display
 * scale, any capture resolution and any later reframe. `t` is SECONDS FROM THE VIDEO'S
 * FIRST FRAME - never wall clock, and never from when the user pressed Record. The two
 * differ by however long the encoder took to produce a frame, which on Windows is tens
 * to hundreds of milliseconds, and that is exactly the drift that makes a click ripple
 * land on the wrong pixel.
 */
(function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  const r4 = (x) => Math.round((Number(x) || 0) * 10000) / 10000;
  const r5 = (x) => Math.round((Number(x) || 0) * 100000) / 100000;

  /** Recorder settings. Kept here so the panel and the main process agree on defaults. */
  const DEFAULTS = {
    sampleHz: 60,      // cursor samples per second
    fps: 30,           // capture frame rate asked of the constraint
    countdown: 3,      // seconds before capture starts
    cursor: true,      // log telemetry alongside the video
    maxW: 1920,        // capture is downscaled to this width if the display is bigger
  };

  const MOVE = 'move', DOWN = 'down', UP = 'up';

  /** `C:\x\rec.webm` -> `C:\x\rec.screen.json`. Both separators, because Windows. */
  function sidecarPath(p) {
    const s = String(p || '');
    const cut = s.lastIndexOf('.');
    const sep = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return (cut > sep ? s.slice(0, cut) : s) + '.screen.json';
  }

  /**
   * A screen point (DIP, desktop coordinates) as a fraction of the captured region.
   *
   * Deliberately NOT clamped: a sample taken while the pointer was on another monitor is
   * outside 0..1, and saying so is more useful than pretending it sat on the edge. Draw
   * code clamps; the file records what happened.
   *
   * Note what is absent: `scaleFactor`. Bounds are DIP and the cursor point is DIP, so
   * the ratio is already scale-independent - a 150% display and a 100% one recording the
   * same gesture produce the same numbers. That is the whole reason the file is
   * normalised rather than in pixels.
   */
  function normPoint(x, y, region) {
    const w = (region && region.w) || 1;
    const h = (region && region.h) || 1;
    return {
      x: r5((x - ((region && region.x) || 0)) / w),
      y: r5((y - ((region && region.y) || 0)) / h),
    };
  }

  /** A display's capture region: bounds are DIP, the pixels the capture has are not. */
  function regionOfDisplay(d) {
    const b = (d && d.bounds) || { x: 0, y: 0, width: 1, height: 1 };
    const sf = (d && d.scaleFactor) || 1;
    return {
      x: b.x, y: b.y, w: b.width, h: b.height, scaleFactor: sf,
      displayW: Math.round(b.width * sf), displayH: Math.round(b.height * sf),
    };
  }

  /**
   * Retime raw samples onto the video's own clock and drop what the video never saw.
   *
   * `raw` is [{ms, x, y, type}] with `ms` an epoch millisecond and x/y already
   * normalised; `t0` is the epoch millisecond of the video's FIRST FRAME.
   *
   * Sampling starts before the first frame arrives - the constraint is negotiated and
   * the encoder warms up - so there is always a pre-roll the video does not contain. It
   * is dropped, with one exception: the LAST pre-roll move is kept and retimed to t=0,
   * because otherwise a recording where the pointer sat still for the first two seconds
   * would carry no cursor position at all until it moved. A click before the first frame
   * is genuinely not in the video and is dropped outright.
   */
  function alignEvents(raw, t0) {
    const src = (raw || []).slice().sort((a, b) => a.ms - b.ms);
    const out = [];
    let preroll = null;
    for (const e of src) {
      const t = (e.ms - t0) / 1000;
      if (t < 0) {
        if (!e.type || e.type === MOVE) preroll = { t: 0, x: r5(e.x), y: r5(e.y), type: MOVE };
        continue;
      }
      out.push({ t: r4(t), x: r5(e.x), y: r5(e.y), type: e.type || MOVE });
    }
    if (preroll && !(out.length && out[0].t === 0 && out[0].type === MOVE)) out.unshift(preroll);
    return out;
  }

  function makeDoc(o) {
    const s = o || {};
    return {
      app: 'shortcut-screen', version: 1,
      created: s.created || new Date().toISOString(),
      source: s.source || null,          // { id, name, type, displayId }
      video: s.video || null,            // { file, w, h, fps, firstFrameEpochMs, durationMs }
      region: s.region || null,
      clicks: !!s.clicks,
      events: s.events || [],
    };
  }

  /** Is this parsed JSON a telemetry sidecar we can use? Never throws. */
  function validate(doc) {
    if (!doc || typeof doc !== 'object') return { ok: false, reason: 'not an object' };
    if (doc.app !== 'shortcut-screen') return { ok: false, reason: 'not a ShortCut telemetry file' };
    if (!Array.isArray(doc.events)) return { ok: false, reason: 'no events array' };
    if (!doc.region || !doc.region.displayW) return { ok: false, reason: 'no capture region' };
    if (!doc.video || typeof doc.video.firstFrameEpochMs !== 'number') {
      return { ok: false, reason: 'no first-frame timestamp' };
    }
    return { ok: true };
  }

  /**
   * The sidecar reduced to what goes on the clip.
   *
   * `clip.screen` is deliberately small and plain: undo is JSON.stringify of the track
   * list and the same shape is the .scut file, so the whole document - thumbnails,
   * source names, ISO dates - does not belong on a clip. Events, the pixel size of what
   * was captured, and whether clicks are trustworthy. Nothing else.
   */
  function clipScreen(doc) {
    const v = validate(doc);
    if (!v.ok) return null;
    return {
      events: doc.events.map((e) => ({ t: r4(e.t), x: r5(e.x), y: r5(e.y), type: e.type || MOVE })),
      displayW: doc.region.displayW,
      displayH: doc.region.displayH,
      clicks: !!doc.clicks,
    };
  }

  const hasTelemetry = (clip) =>
    !!(clip && clip.screen && Array.isArray(clip.screen.events) && clip.screen.events.length);

  /**
   * The cursor position at time `t` (seconds from the clip's first frame), or null.
   *
   * Linearly interpolated between the two surrounding move samples and held at the ends.
   * Null when there is no telemetry at all - that is the degradation contract, and step
   * 9's smoothing spline is built on top of this rather than instead of it.
   */
  function cursorAt(screen, t) {
    if (!hasTelemetry({ screen })) return null;
    const ev = screen.events;
    let prev = null, next = null;
    for (const e of ev) {
      if (e.type === DOWN || e.type === UP) continue;   // a click carries a position but is not a sample
      if (e.t <= t) prev = e; else { next = e; break; }
    }
    if (!prev && !next) {
      // A track of nothing but clicks: the nearest one is still a real position.
      let best = null;
      for (const e of ev) if (!best || Math.abs(e.t - t) < Math.abs(best.t - t)) best = e;
      return best ? { x: best.x, y: best.y } : null;
    }
    if (!prev) return { x: next.x, y: next.y };
    if (!next) return { x: prev.x, y: prev.y };
    const span = next.t - prev.t;
    const k = span > 1e-9 ? clamp((t - prev.t) / span, 0, 1) : 0;
    return { x: prev.x + (next.x - prev.x) * k, y: prev.y + (next.y - prev.y) * k };
  }

  /** Mouse-down events in [a, b). `[]` for a clip with no telemetry, never a throw. */
  function clicksIn(screen, a, b) {
    if (!hasTelemetry({ screen })) return [];
    return screen.events.filter((e) => e.type === DOWN && e.t >= a && e.t < b);
  }

  /**
   * One line of the click watcher's output -> an event, or null.
   *
   * The watcher (see `startClickWatcher()` in main.js) prints `D <button> <epochMs>` and
   * `U <button> <epochMs>`, one per line. Parsing lives here so the smoke suite can
   * check it without a mouse.
   */
  function parseClickLine(line) {
    const m = /^([DU])\s+(\d+)\s+(\d+)\s*$/.exec(String(line == null ? '' : line).trim());
    if (!m) return null;
    return { type: m[1] === 'D' ? DOWN : UP, button: Number(m[2]), ms: Number(m[3]) };
  }

  const API = {
    DEFAULTS, MOVE, DOWN, UP,
    sidecarPath, normPoint, regionOfDisplay, alignEvents,
    makeDoc, validate, clipScreen, hasTelemetry, cursorAt, clicksIn, parseClickLine,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.ScreenTel = API;
})();
