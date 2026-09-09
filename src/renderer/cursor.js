'use strict';
/**
 * Screen-recording treatment - the pure half.
 *
 * Loaded as a plain <script> global `Cursor` before `fx.js`, exactly the way `anim.js`
 * is, and as a CommonJS module for anything that wants it outside a window. Nothing in
 * here touches the DOM, a canvas, ffmpeg or the filesystem: it is the smoothing, the
 * click timing, the source->frame mapping and the auto-zoom generator, and every one of
 * them is a function of numbers that `tools/smoke-cursor.js` can check without a picture.
 * The drawing half lives in `fx.js` (`cursor` and `ripple`), and the panel that drives
 * the generator lives in `app.js`.
 *
 * TWO INPUTS, AND THEY ARE NOT THE SAME THING.
 *
 *   `clip.screen`  step 8's SCREEN telemetry, sampled by the OS while a display was
 *                  captured. Its x/y are fractions of the SOURCE frame, so they have to
 *                  go through the clip's pan/zoom framing to become pixels. It drives
 *                  AUTO-ZOOM and nothing else.
 *
 *   `clip.mouse`   an ON-RENDER take: the pointer the author performed over the finished
 *                  9:16 picture. Its x/y are fractions of the OUTPUT FRAME, so they are
 *                  already where they belong and must NOT be mapped. It drives the drawn
 *                  CURSOR, the RIPPLES and the SELECTION boxes.
 *
 * Keeping them apart is the whole point of the split. A screen capture already contains a
 * real cursor in its pixels; drawing a second one over it produced two pointers chasing
 * each other, which is the bug this design removes. So a screen recording gets auto-zoom -
 * which has no cursor in it - and a performed take gets the drawn pointer.
 *
 * BOTH ARE OPTIONAL. Every entry point answers `null` / `[]` / "no zoom" for a clip that
 * has neither. That is the contract the README states under "The screen recorder": a
 * recording from Screen Studio, OBS or a phone imports with no telemetry at all and that
 * is a permanent, supported state. Nothing in this file may throw on it.
 *
 * TIME IS SOURCE TIME.
 *
 * Telemetry `t` is seconds from the video file's FIRST FRAME, because that is the only
 * timebase that survives trimming, splitting and dragging. So every function here takes a
 * SOURCE time and the callers convert - `clip.in + tLocal` - the same way `clipCursorAt()`
 * in app.js does. The one exception is `autoZoom()`, which is asked for keyframes: those
 * come back in CLIP-LOCAL seconds, because that is the axis `Anim` keys live on.
 *
 * WHY THE SMOOTHING IS A RESAMPLED GRID AND NOT A FILTER OVER THE EVENTS.
 *
 * The events are irregular: the sampler runs at 60 Hz but a click carries a position of
 * its own, and a pointer that does not move produces nothing at all for a second at a
 * time. A moving average over the event ARRAY therefore weights a busy stretch and a
 * still one differently, and the drawn cursor speeds up wherever the sampler happened to
 * be dense. Resampling onto a fixed 60 Hz grid first makes the filter a filter over TIME,
 * which is what it has to be. The grid is built once per telemetry object and held in a
 * WeakMap - it is derived data, it is large, and it must never touch the clip: undo is
 * `JSON.stringify` of the track list.
 */
(function () {
  const RATE = 60;                    // the resampling grid, in samples per second
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, isFinite(Number(v)) ? Number(v) : lo));
  const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d);
  // The same rounding `screen.js` writes a sidecar with, so a performed take and a
  // recorded one carry numbers of the same precision and neither looks spuriously exact.
  const r4 = (x) => Math.round((Number(x) || 0) * 1e4) / 1e4;
  const r5 = (x) => Math.round((Number(x) || 0) * 1e5) / 1e5;

  /** Every default in one place, so the panel, the effects and the suite agree. */
  const DEFAULTS = {
    cursor: {
      smooth: 0.12,      // seconds of path averaged away
      lag: 0.05,         // seconds the drawn pointer trails the real one
      size: 0.045,       // fraction of the frame's shorter side
      punch: 1.35,       // pointer scale at the peak of a click
      punchDur: 0.22,    // seconds the punch takes
    },
    select: {
      hold: 2,           // seconds the box stays up after the drag is released
      fadeIn: 0.08,      // short: the drag itself is the entrance
    },
    ripple: {
      dur: 0.55,         // seconds one ring lives
      size: 0.09,        // final radius, fraction of the frame's shorter side
      width: 0.006,      // stroke width, same units
    },
    zoom: {
      sensitivity: 0.5,  // 0 = only a very tight dwell counts, 1 = almost any does
      minHold: 1.2,      // seconds a region must hold before it earns a zoom
      maxZoom: 2,        // hard ceiling on the generated scale
      ramp: 0.5,         // seconds to ease in and back out
      curve: 'easeInOut',
      fill: 0.6,         // the dwell region fills this much of the zoomed frame
      aspect: 9 / 16,    // the output's W/H, which decides what the framing left on screen
      rate: 10,          // segmentation samples per second
    },
  };

  /** The brand accent, until step 17 hands it over to the brand kit. */
  const ACCENT = '#22d3ee';

  const DOWN = 'down', UP = 'up';

  const has = (screen) =>
    !!(screen && Array.isArray(screen.events) && screen.events.length);

  /** The position samples: a click carries a position but is not one, same as ScreenTel. */
  function moves(screen) {
    const m = screen.events.filter((e) => e.type !== DOWN && e.type !== UP);
    return m.length ? m : screen.events;      // a track of nothing but clicks is still a path
  }

  /** Every mouse-down, in source time. `[]` without telemetry, never a throw. */
  function clicksOf(screen) {
    return has(screen) ? screen.events.filter((e) => e.type === DOWN) : [];
  }

  // ------------------------------------------------------------------- the grid

  const gridCache = new WeakMap();

  /**
   * The path resampled onto a fixed 60 Hz grid, built once per telemetry object.
   *
   * Held in a WeakMap keyed by the `clip.screen` object rather than stored on it: it is
   * a few hundred kilobytes of derived Float64, and anything that lands on a clip lands
   * in every undo snapshot and in the `.scut` file. The WeakMap also means a project
   * close frees it without anybody remembering to.
   */
  function grid(screen) {
    if (!has(screen)) return null;
    let g = gridCache.get(screen);
    if (g) return g;
    const src = moves(screen).slice().sort((a, b) => a.t - b.t);
    const n = src.length;
    const t0 = src[0].t;
    const t1 = src[n - 1].t;
    const m = Math.max(1, Math.ceil((t1 - t0) * RATE) + 1);
    const xs = new Float64Array(m), ys = new Float64Array(m);
    let j = 0;
    for (let i = 0; i < m; i++) {
      const t = t0 + i / RATE;
      while (j < n - 2 && src[j + 1].t <= t) j++;
      const a = src[j], b = src[Math.min(j + 1, n - 1)];
      const span = b.t - a.t;
      const k = span > 1e-9 ? clamp((t - a.t) / span, 0, 1) : 0;
      xs[i] = a.x + (b.x - a.x) * k;
      ys[i] = a.y + (b.y - a.y) * k;
    }
    g = { t0, t1, m, xs, ys, soft: new Map() };
    gridCache.set(screen, g);
    return g;
  }

  /**
   * A symmetric moving average of the grid, cached per window size.
   *
   * The window SHRINKS at the ends - half-width `min(h, i, m-1-i)` - rather than clamping
   * or reflecting the index. Both of those bias the mean at the ends, so a pointer
   * travelling in a straight line would come out bent for the first and last tenth of a
   * second. A symmetric window is exact on a straight line everywhere, which is the first
   * thing `smoke-cursor.js` asserts.
   */
  function smoothed(g, h) {
    if (h <= 0) return g;
    const hit = g.soft.get(h);
    if (hit) return hit;
    const m = g.m;
    const sx = new Float64Array(m + 1), sy = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) { sx[i + 1] = sx[i] + g.xs[i]; sy[i + 1] = sy[i] + g.ys[i]; }
    const xs = new Float64Array(m), ys = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const hh = Math.min(h, i, m - 1 - i);
      const a = i - hh, b = i + hh, w = b - a + 1;
      xs[i] = (sx[b + 1] - sx[a]) / w;
      ys[i] = (sy[b + 1] - sy[a]) / w;
    }
    const out = { xs, ys, m };
    g.soft.set(h, out);
    return out;
  }

  /**
   * Catmull-Rom through four grid samples. Interpolating (it passes through its control
   * points) and affine-exact on collinear ones, so the smoothing above is not undone by
   * the interpolation on top of it - and a straight path stays straight to the last bit.
   */
  function crom(p0, p1, p2, p3, f) {
    const f2 = f * f, f3 = f2 * f;
    return 0.5 * ((2 * p1) + (-p0 + p2) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
  }

  function at(arr, i, m) { return arr[clamp(i, 0, m - 1) | 0]; }

  /**
   * The SMOOTHED cursor position at source time `t`, in normalised source coordinates,
   * or null without telemetry.
   *
   * `lag` is what makes the replacement pointer feel like a physical object rather than a
   * cursor with a filter on it: it is evaluated slightly in the past, so it trails a fast
   * flick and catches up when the hand stops. It is a shift of the sample time and
   * nothing else - a lag implemented by blending toward the previous drawn position would
   * depend on the frame rate, and the preview and the export do not share one.
   */
  function smoothAt(screen, t, o) {
    const g = grid(screen);
    if (!g) return null;
    const opt = Object.assign({}, DEFAULTS.cursor, o || {});
    const h = Math.round(num(opt.smooth, 0) * RATE / 2);
    const s = smoothed(g, h);
    const u = clamp((num(t, 0) - num(opt.lag, 0) - g.t0) * RATE, 0, g.m - 1);
    const i = Math.floor(u), f = u - i;
    if (f < 1e-9) return { x: at(s.xs, i, g.m), y: at(s.ys, i, g.m) };
    return {
      x: crom(at(s.xs, i - 1, g.m), at(s.xs, i, g.m), at(s.xs, i + 1, g.m), at(s.xs, i + 2, g.m), f),
      y: crom(at(s.ys, i - 1, g.m), at(s.ys, i, g.m), at(s.ys, i + 1, g.m), at(s.ys, i + 2, g.m), f),
    };
  }

  /** The RAW recorded position at source time `t` - where the real cursor pixels are. */
  function rawAt(screen, t) {
    const g = grid(screen);
    if (!g) return null;
    const u = clamp((num(t, 0) - g.t0) * RATE, 0, g.m - 1);
    const i = Math.floor(u), f = u - i;
    const j = Math.min(i + 1, g.m - 1);
    return { x: g.xs[i] + (g.xs[j] - g.xs[i]) * f, y: g.ys[i] + (g.ys[j] - g.ys[i]) * f };
  }

  // ------------------------------------------------------------------- clicks

  /**
   * The rings alive at source time `t`: each click inside the last `dur` seconds, with
   * `k` its progress through 0..1. Ordered oldest first, so a burst of clicks stacks in
   * the order it happened.
   */
  function ripplesAt(screen, t, o) {
    const dur = Math.max(0.01, num((o || {}).dur, DEFAULTS.ripple.dur));
    const out = [];
    for (const c of clicksOf(screen)) {
      const k = (num(t, 0) - c.t) / dur;
      if (k >= 0 && k < 1) out.push({ x: c.x, y: c.y, k, t: c.t });
    }
    return out;
  }

  /**
   * The pointer's scale multiplier at source time `t` - 1 except around a click.
   *
   * A fast attack and a slow release, peaking a quarter of the way in. A symmetric pulse
   * reads as a wobble; the asymmetry is what makes it read as a press.
   */
  function punchAt(screen, t, o) {
    const opt = Object.assign({}, DEFAULTS.cursor, o || {});
    const dur = Math.max(0.01, num(opt.punchDur, DEFAULTS.cursor.punchDur));
    const peak = num(opt.punch, 1);
    let best = 0;
    for (const c of clicksOf(screen)) {
      const k = (num(t, 0) - c.t) / dur;
      if (k < 0 || k >= 1) continue;
      const shape = k < 0.25 ? k / 0.25 : 1 - (k - 0.25) / 0.75;
      if (shape > best) best = shape;
    }
    return 1 + (peak - 1) * best;
  }

  // ------------------------------------------------------- source -> frame space

  /**
   * Normalised SOURCE coordinates -> pixels in a WxH layer, through the clip's framing.
   *
   * Telemetry is normalised to the captured display, and the capture is the whole of the
   * video frame, so a telemetry point is a point in the source frame. The editor then
   * crops that 16:9 source into a 9:16 output with pan and zoom - so a cursor drawn at
   * `x * W` would sit on the wrong pixel the moment anybody reframed the shot.
   *
   * This is deliberately the SAME arithmetic as `drawClipTo()` in app.js, expressed in
   * fractions instead of source pixels: crop `min(sw, sh*A)/zoom` wide, positioned by
   * `panX`, mapped onto the layer. If one of the two ever changes, the other has to, and
   * `smoke-cursor.js` asserts they agree by mapping a point both ways.
   *
   * Returns a function, and also the crop it derived, because the auto-zoom generator
   * needs to know what is actually on screen rather than what is in the file.
   */
  /**
   * The mapper a given data source needs.
   *
   * A SOURCE-space point (screen telemetry) goes through the clip's framing, because it
   * was recorded against the file. A FRAME-space point (an on-render take) is already a
   * fraction of the output and is scaled straight up - putting it through the framing
   * would move a pointer the author placed by eye on the finished picture.
   *
   * One function, so a caller cannot forget which kind it is holding: it asks the data.
   */
  function mapperFor(clip, holder, W, H) {
    if (holder && holder.space === 'frame') {
      const fn = (x, y) => ({ x: num(x, 0) * W, y: num(y, 0) * H });
      fn.crop = { x: 0, y: 0, w: 1, h: 1 };
      return fn;
    }
    return mapper(clip, W, H);
  }

  function mapper(clip, W, H) {
    const c = clip || {};
    const sw = num(c.srcW, 0) || W, sh = num(c.srcH, 0) || H;
    const A = W / H;
    const zoom = Math.max(0.01, num(c.zoom, 1));
    const cw = Math.min(sw, sh * A) / zoom, ch = Math.min(sh, sw / A) / zoom;
    const cx = (sw - cw) * clamp(num(c.panX, 0.5), 0, 1);
    const cy = (sh - ch) * clamp(num(c.panY, 0.5), 0, 1);
    const fn = (x, y) => ({
      x: (num(x, 0) * sw - cx) / cw * W,
      y: (num(y, 0) * sh - cy) / ch * H,
    });
    // The visible window as a fraction of the SOURCE, which is what turns a dwell region
    // measured in source coordinates into a zoom the frame can actually hold.
    fn.crop = { x: cx / sw, y: cy / sh, w: cw / sw, h: ch / sh };
    return fn;
  }

  // ------------------------------------------------------------- the auto-zoom

  /**
   * Where the cursor dwelt, as a list of segments in SOURCE time.
   *
   * Greedy and single-pass: keep extending the current segment while every sample in it
   * still fits inside a box of side `spread`, and start a new one the moment the pointer
   * leaves. Then throw away everything shorter than `minHold`.
   *
   * MINIMUM HOLD IS ENFORCED HERE, NOT SMOOTHED AFTERWARDS. That is the whole reason the
   * generator exists as a generator. A pointer flicking between two nearby targets
   * produces a dozen two-frame segments; smoothing the resulting zoom curve afterwards
   * gives a soft, permanent wobble, because the wobble is in the data. Rejecting the
   * segments removes it - the frame simply does not zoom for a gesture nobody held.
   *
   * Adjacent survivors whose centres are within half a spread are merged, so a dwell that
   * drifted across the boundary is one zoom rather than two nearly identical ones.
   */
  function segments(screen, from, to, o) {
    const opt = Object.assign({}, DEFAULTS.zoom, o || {});
    const g = grid(screen);
    if (!g || !(to > from)) return [];
    const rate = Math.max(1, num(opt.rate, 10));
    const step = 1 / rate;
    const sens = clamp(opt.sensitivity, 0, 1);
    const spread = 0.45 - 0.33 * sens;          // tighter box as sensitivity rises
    const minHold = Math.max(0, num(opt.minHold, 0));

    const raw = [];
    for (let t = from; t <= to + 1e-9; t += step) {
      const p = rawAt(screen, t);
      if (p) raw.push({ t, x: p.x, y: p.y });
    }
    if (raw.length < 2) return [];

    const segs = [];
    let s = null;
    const box = (p) => ({ t0: p.t, t1: p.t, x0: p.x, x1: p.x, y0: p.y, y1: p.y });
    for (const p of raw) {
      if (!s) { s = box(p); continue; }
      const x0 = Math.min(s.x0, p.x), x1 = Math.max(s.x1, p.x);
      const y0 = Math.min(s.y0, p.y), y1 = Math.max(s.y1, p.y);
      if (x1 - x0 <= spread && y1 - y0 <= spread) {
        s.x0 = x0; s.x1 = x1; s.y0 = y0; s.y1 = y1; s.t1 = p.t;
      } else {
        segs.push(s);
        s = box(p);
      }
    }
    if (s) segs.push(s);

    const kept = segs.filter((q) => q.t1 - q.t0 >= minHold);
    const out = [];
    for (const q of kept) {
      const prev = out[out.length - 1];
      const cxA = prev ? (prev.x0 + prev.x1) / 2 : 0, cyA = prev ? (prev.y0 + prev.y1) / 2 : 0;
      const cxB = (q.x0 + q.x1) / 2, cyB = (q.y0 + q.y1) / 2;
      if (prev && Math.abs(cxA - cxB) < spread / 2 && Math.abs(cyA - cyB) < spread / 2) {
        prev.x0 = Math.min(prev.x0, q.x0); prev.x1 = Math.max(prev.x1, q.x1);
        prev.y0 = Math.min(prev.y0, q.y0); prev.y1 = Math.max(prev.y1, q.y1);
        prev.t1 = q.t1;
      } else out.push(Object.assign({}, q));
    }
    return out;
  }

  /**
   * Turn one dwell segment into a target: where to centre, and how far to go in.
   *
   * The scale is whatever makes the dwell box fill `fill` of the zoomed frame, capped by
   * `maxZoom` and never below 1 - zooming OUT of a screen recording is never what was
   * asked for. `crop` is the visible window as a fraction of the source, because the
   * region has to fit inside what the framing already left on screen, not inside the file.
   *
   * The centre is then clamped so the zoomed window stays inside the frame. Without that
   * a dwell in the corner pans past the edge and lets the black through - and the black
   * would be baked into the export, because the baker and the viewer run the same code.
   */
  function target(seg, o, crop) {
    const opt = Object.assign({}, DEFAULTS.zoom, o || {});
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    // The box, in FRAME fractions rather than source fractions.
    const fx0 = (seg.x0 - c.x) / c.w, fx1 = (seg.x1 - c.x) / c.w;
    const fy0 = (seg.y0 - c.y) / c.h, fy1 = (seg.y1 - c.y) / c.h;
    const w = Math.max(0.02, fx1 - fx0), h = Math.max(0.02, fy1 - fy0);
    const fill = clamp(opt.fill, 0.1, 1);
    const maxZoom = Math.max(1, num(opt.maxZoom, 1));
    const s = clamp(Math.min(fill / w, fill / h), 1, maxZoom);
    const half = 0.5 / s;
    return {
      t0: seg.t0, t1: seg.t1, scale: s,
      x: clamp((fx0 + fx1) / 2, half, 1 - half),
      y: clamp((fy0 + fy1) / 2, half, 1 - half),
    };
  }

  /**
   * The transform offset that puts frame point (px, py) in the middle at scale `s`.
   *
   * `fx.js`'s transform draws about an anchor: `screen = a + (p - a) * s + offset`. With
   * the anchor left at the middle - which is where it is, and where a hand edit expects
   * to find it - that solves to `offset = (0.5 - p) * s`. Written here rather than in the
   * generator so the suite can assert the round trip: generate keys, apply this formula,
   * land on 0.5.
   */
  const offsetFor = (p, s) => (0.5 - p) * s;

  /**
   * Auto-zoom: dwell segments -> ORDINARY keyframe tracks the author can then edit.
   *
   * Returns `{ segments, keys: { x, y, scale } }` with key times in CLIP-LOCAL seconds,
   * every key tagged `gen:'autozoom'`. `aspect` is the output's W/H - the crop the
   * framing leaves on screen depends on it, and a target measured against the wrong one
   * would be off centre in exactly the direction nobody would think to look.
   *
   * The tag is the design. This is a generator, not an opaque effect: the result is
   * `Anim` keys on an ordinary `transform`, so they show up on the keyframe strip and can
   * be dragged, retimed and deleted like any others. Regenerating removes the tagged keys
   * and leaves the untagged ones exactly where the author put them, which is what makes
   * "generate, then fix the one that is wrong" a workflow rather than a dead end.
   *
   * Each segment emits four keys - neutral, in, hold, neutral - and consecutive segments
   * whose ramps would collide drop the two neutral keys between them, so the frame moves
   * straight from one target to the next instead of pulling out and diving back in.
   */
  function autoZoom(screen, clip, o) {
    const opt = Object.assign({}, DEFAULTS.zoom, o || {});
    const cIn = num((clip || {}).in, 0), cOut = num((clip || {}).out, 0);
    const dur = Math.max(0, cOut - cIn);
    const empty = { segments: [], keys: { x: [], y: [], scale: [] } };
    if (!has(screen) || dur <= 0) return empty;

    const A = Math.max(0.01, num(opt.aspect, 9 / 16));
    const crop = mapper(clip, A, 1).crop;
    const segs = segments(screen, cIn, cOut, opt).map((s) => target(s, opt, crop));
    if (!segs.length) return empty;

    const ramp = Math.max(0.01, num(opt.ramp, DEFAULTS.zoom.ramp));
    const curve = opt.curve || DEFAULTS.zoom.curve;
    // Local time, clamped into the clip: a key before the clip starts would mean the clip
    // opens halfway through a ramp nobody asked for.
    const L = (t) => clamp(t - cIn, 0, dur);

    const rows = [];       // { t, x, y, scale, neutral }
    segs.forEach((s, i) => {
      const prev = segs[i - 1], next = segs[i + 1];
      const joinBefore = !!prev && (s.t0 - ramp) <= (prev.t1 + ramp);
      const joinAfter = !!next && (next.t0 - ramp) <= (s.t1 + ramp);
      if (!joinBefore) rows.push({ t: L(s.t0 - ramp), neutral: true });
      rows.push({ t: L(s.t0), x: s.x, y: s.y, scale: s.scale });
      rows.push({ t: L(s.t1), x: s.x, y: s.y, scale: s.scale });
      if (!joinAfter) rows.push({ t: L(s.t1 + ramp), neutral: true });
    });

    /*
     * Two keys at the same time make a zero-length span whose interpolation is
     * meaningless, and a segment that runs off the end of the clip produces exactly that:
     * its ramp-in clamps onto its own start, or its hold clamps onto its ramp-out.
     *
     * The collision is resolved TOWARD THE SEGMENT, never toward the neutral. A dwell
     * that was already under way when the clip starts should open already zoomed in -
     * keeping the neutral instead would leave one key at 1 and the next at the target
     * four seconds later, so the whole dwell would be a slow creeping push nobody asked
     * for. The same rule at the tail keeps the hold rather than snapping out on the last
     * frame. `smoke-cursor.js` has a clip trimmed into the middle of a dwell for this.
     */
    const merged = [];
    for (const r of rows) {
      const prev = merged[merged.length - 1];
      if (prev && r.t <= prev.t + 1e-4) {
        if (prev.neutral && !r.neutral) merged[merged.length - 1] = Object.assign({}, r, { t: prev.t });
        continue;
      }
      merged.push(r);
    }

    const keys = { x: [], y: [], scale: [] };
    for (const r of merged) {
      const s = r.neutral ? 1 : r.scale;
      const push = (track, v) => track.push({
        t: Math.round(r.t * 1e4) / 1e4,
        v: Math.round(v * 1e5) / 1e5,
        ease: Anim.cloneEasing(Anim.EASING_PRESETS[curve] || Anim.EASING_PRESETS.easeInOut),
        gen: 'autozoom',
      });
      push(keys.scale, s);
      push(keys.x, r.neutral ? 0 : offsetFor(r.x, s));
      push(keys.y, r.neutral ? 0 : offsetFor(r.y, s));
    }
    return { segments: segs, keys };
  }

  /**
   * Merge generated tracks into an effect entry, replacing the previous generation.
   *
   * Keys carrying `gen === tag` are dropped and the new ones take their place. Every
   * other key on the track survives untouched - that is what the tag is FOR, and it is
   * the difference between a generator and a black box.
   *
   * Note what the rule does NOT say: dragging a generated key does not un-tag it, so the
   * next generation still replaces it. Retiming a machine's guess is a correction to that
   * guess, and a regeneration is a request for a new one. What survives is what the
   * author ADDED, which is the edit the strip makes easy and the one that would otherwise
   * be destroyed without a word.
   *
   * Pure, and it takes any `.keys` holder, so the suite can run it on a bare object.
   */
  function applyGenerated(entry, tracks, tag) {
    if (!entry || !tracks) return entry;
    const t = tag || 'autozoom';
    entry.keys = entry.keys || {};
    for (const prop of Object.keys(tracks)) {
      const kept = (entry.keys[prop] || []).filter((k) => k && k.gen !== t);
      const next = kept.concat(tracks[prop].map((k) => JSON.parse(JSON.stringify(k))));
      if (next.length) entry.keys[prop] = Anim.sortKeys(next);
      else delete entry.keys[prop];
    }
    if (!Object.keys(entry.keys).length) delete entry.keys;
    return entry;
  }

  /** Drop a generation without putting one back: the Clear half of Regenerate. */
  function clearGenerated(entry, tag) {
    if (!entry || !entry.keys) return entry;
    const t = tag || 'autozoom';
    for (const prop of Object.keys(entry.keys)) {
      const kept = entry.keys[prop].filter((k) => k && k.gen !== t);
      if (kept.length) entry.keys[prop] = kept; else delete entry.keys[prop];
    }
    if (!Object.keys(entry.keys).length) delete entry.keys;
    return entry;
  }

  /** How many keys on an entry this generator owns - what the panel reports. */
  function countGenerated(entry, tag) {
    const t = tag || 'autozoom';
    let n = 0;
    for (const prop of Object.keys((entry && entry.keys) || {})) {
      for (const k of entry.keys[prop]) if (k && k.gen === t) n++;
    }
    return n;
  }

  // ------------------------------------------------------------- on-render takes

  /**
   * An on-render take, as it lands on a clip:
   *
   *   clip.mouse = { events: [{t, x, y, type}], space: 'frame', clicks: true }
   *
   * `t` is SOURCE seconds - the same axis `clip.screen` uses, and for the same reason:
   * it is the only timebase that survives trimming, splitting and dragging the clip
   * afterwards. `x`/`y` are fractions of the OUTPUT FRAME, because that is what the
   * author was looking at when they performed it.
   *
   * A take is recorded against the TIMELINE and can cross several clips, so it is split
   * on import and each clip gets the piece that happened over it. That is what makes it
   * behave like every other thing on a clip - one clip, one `mouse`, undo is
   * `JSON.stringify` of the track list, and a clip carried to another project carries its
   * pointer with it.
   */
  function makeTake(events, o) {
    const s = o || {};
    return {
      events: (events || []).map((e) => ({
        t: r4(e.t), x: r5(e.x), y: r5(e.y), type: e.type || MOVE,
      })).sort((a, b) => a.t - b.t),
      space: 'frame',
      clicks: s.clicks !== false,
    };
  }

  /**
   * Cut a timeline-time take into per-clip, source-time takes.
   *
   * `clips` is `[{id, start, in, out}]` - whatever the caller has, as long as it names
   * those four. A clip gets an entry only if something actually happened over it, so
   * recording a pass that never crosses a clip leaves that clip alone rather than
   * writing an empty take onto it.
   *
   * The boundary is half-open, `[start, end)`, exactly like `layersAt()`: a click landing
   * precisely on a cut belongs to the clip that is coming in, not the one going out, and
   * the two must not both claim it.
   */
  function splitTake(events, clips) {
    const out = new Map();
    for (const c of (clips || [])) {
      const len = num(c.out, 0) - num(c.in, 0);
      const a = num(c.start, 0), b = a + len;
      const mine = [];
      for (const e of (events || [])) {
        if (e.t < a || e.t >= b) continue;
        mine.push({ t: e.t - a + num(c.in, 0), x: e.x, y: e.y, type: e.type || MOVE });
      }
      if (mine.length) out.set(c.id, makeTake(mine));
    }
    return out;
  }

  /**
   * A recorded selection drag -> keyframe tracks for a `select` effect.
   *
   * THE RUBBER BAND IS THE ANIMATION, and replaying it is the point. One corner is
   * pinned where the drag began and the opposite one follows the pointer, exactly the way
   * a desktop marquee behaves - so the box grows, shrinks and flips sides as it was
   * actually dragged, instead of appearing whole at its final size. `sel.samples` is that
   * moving corner over time; `sel.x0`/`sel.y0` is the pinned one.
   *
   * The easing between drag samples is LINEAR, and that is not a detail. These keys are a
   * replay of a path, not an animation between poses: an ease on every pair would make
   * the band accelerate and settle between each sample and the next, which at 20 samples
   * a second reads as a stutter.
   *
   * Samples are decimated to `MIN_GAP` - a two-second drag is 120 pointer events and
   * four tracks of 120 keys is a strip nobody can edit, for a path that is straight
   * between any two neighbours anyway. The first and last are always kept.
   *
   * After the last key the track HOLDS, which is `evalTrack()`'s own rule, so the box
   * simply stays at the size it was released at for as long as the effect is on screen.
   * No trailing key is needed and adding one would be a key the author has to delete.
   *
   * Tagged, for the same reason auto-zoom's keys are: a box that can only be re-performed
   * is a box nobody will fix. `t0`/`t1` come back in clip-local seconds alongside, because
   * the effect also needs to know when to be on screen at all.
   *
   * A `sel` with no samples - one built by hand, or by an older build - falls back to a
   * static box, which is what it used to be.
   */
  const MIN_GAP = 0.05;
  function selectionKeys(sel, clip, tag) {
    const start = num((clip || {}).start, 0);
    const L = (t) => Math.max(0, r4(t - start));
    const t0 = L(sel.t0), t1 = L(sel.t1);
    const key = (v, t, linear) => ({
      t,
      v: r5(v),
      ease: Anim.cloneEasing(linear
        ? Anim.EASING_PRESETS.linear
        : Anim.EASING_PRESETS.easeInOut),
      gen: tag || 'onrender',
    });

    const keys = { x: [], y: [], w: [], h: [] };
    const samples = Array.isArray(sel.samples) ? sel.samples : null;
    if (!samples || samples.length < 2) {
      for (const k of ['x', 'y', 'w', 'h']) keys[k] = [key(sel[k], t0), key(sel[k], t1)];
      return { t0, t1, keys };
    }

    const kept = [];
    let last = -Infinity;
    samples.forEach((sm, i) => {
      if (i === samples.length - 1 || sm.t - last >= MIN_GAP) { kept.push(sm); last = sm.t; }
    });
    for (const sm of kept) {
      const r = normRect(sel.x0, sel.y0, sm.x, sm.y);
      const t = L(sm.t);
      keys.x.push(key(r.x, t, true));
      keys.y.push(key(r.y, t, true));
      keys.w.push(key(r.w, t, true));
      keys.h.push(key(r.h, t, true));
    }
    for (const k of ['x', 'y', 'w', 'h']) Anim.sortKeys(keys[k]);
    return { t0, t1, keys };
  }

  /** A drag, normalised so w/h are positive however it was dragged. */
  function normRect(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
    };
  }

  const API = {
    DEFAULTS, ACCENT, RATE,
    makeTake, splitTake, selectionKeys, normRect, mapperFor,
    has, moves, clicksOf, grid, smoothAt, rawAt,
    ripplesAt, punchAt, mapper,
    segments, target, offsetFor, autoZoom,
    applyGenerated, clearGenerated, countGenerated,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.Cursor = API;
})();
