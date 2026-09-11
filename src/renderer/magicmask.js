'use strict';
/**
 * Magic Mask - paint over the object, get the object. The pure half.
 *
 * Loaded as a plain <script> global `MagicMask` before `fx.js`, the way `anim.js`,
 * `cursor.js` and `track.js` are, and as a CommonJS module for anything outside a window.
 * Nothing in here touches the DOM, a canvas, onnxruntime or the filesystem: frames arrive
 * as RGBA arrays, mattes leave as 8-bit alpha planes, and the segmenter itself is
 * INJECTED. That is what lets `smoke-mask.js` drive the whole propagation loop over a
 * synthetic moving shape without a 40 MB download, and what lets the same loop run
 * against MobileSAM in the app.
 *
 * WHAT LANDS ON A CLIP
 *
 *   clip.masks = [ { id, name, res, rate, strokes: [ { t, sign, r, pts:[x,y,...] } ] } ]
 *
 * Plain JSON, absent until something is painted, and pruned away again with the last
 * mask - undo is `JSON.stringify` of the track list and the same shape is the `.scut`
 * file. What is deliberately NOT here is the matte: a minute of mattes is tens of
 * megabytes of pixels, so they live in the disk cache keyed by the source file and the
 * prompts, exactly as solved tracks and waveforms do.
 *
 *   `t`     SOURCE seconds, from the media file's first frame - the axis `clip.tracks`,
 *           `clip.screen` and `clip.mouse` all use, and the only one that survives
 *           trimming, splitting and dragging the clip afterwards.
 *   `x`,`y` fractions of the SOURCE frame, so a stroke painted at preview resolution
 *           means the same thing to a 1080x1920 render.
 *   `sign`  +1 a positive stroke (this is the object), -1 a negative one (this is not).
 *   `r`     brush radius, a fraction of the frame's shorter side.
 *
 * NEGATIVE STROKES ARE NOT OPTIONAL.
 *
 * A click-only UI cannot express "the bright gap between the arm and the torso is
 * background". One positive scribble down an arm and one negative scribble in that gap is
 * the difference between a cut-out and a cut-out wearing a halo, and there is no amount
 * of positive painting that says it. So the brush has a sign, the sign is in the prompt,
 * and both are in the cache key.
 *
 * PROPAGATION DRIFTS, AND THE ANSWER IS A CORRECTION, NOT A BETTER GUESS.
 *
 * Each frame is decoded from the previous frame's low-resolution logits plus a box
 * derived from it, which is the standard SAM-2-shaped loop and it works until the object
 * turns, is occluded, or meets something the same colour. When it slips, painting on THAT
 * frame adds an anchor there, and `plan()` re-starts propagation from it: the frames
 * before the correction keep the mattes they already had. That is the same contract
 * `Tracker.reanchorAt()` keeps for a dragged tracker, for the same reason - the solved
 * past is work already accepted.
 */
(function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, isFinite(Number(v)) ? Number(v) : lo));
  const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d);
  const r4 = (x) => Math.round((Number(x) || 0) * 1e4) / 1e4;

  /**
   * A default, THEN a clamp - and never `clamp()` on its own for a value that may be absent.
   *
   * `clamp()` answers `lo` for anything that is not a number, so `clamp(undefined, 128, 2048)`
   * is 128, and a `|| DEFAULTS.res` written after it never fires because 128 is truthy.
   * That is not a hypothetical: it shipped, and every mask painted by that build was cut at
   * 128 px instead of 1024, where MobileSAM answers "the whole frame" - a blue wash over the
   * picture rather than a cut-out. Four values in this file were written that way. One
   * helper, so there cannot be a fifth.
   */
  const fill = (v, d, lo, hi) => clamp(num(v, d), lo, hi);

  /** Every default in one place, so the panel, the loop and the suite agree. */
  const DEFAULTS = {
    /*
     * 1024, WHICH IS SAM'S OWN SCALE AND NOT AN ARBITRARY ONE.
     *
     * The encoder resizes whatever it is handed so its long side is 1024 and then pads to
     * a square, so feeding it 512 buys no speed at all - the graph does the same work -
     * and it costs accuracy: measured on a synthetic plate whose answer is known to the
     * pixel, a 1024-long-side frame comes back exact and a 512 one comes back with a
     * region a third too big. Nothing downstream cares: the matte is stored run-length
     * encoded, so a flat one costs kilobytes whatever its nominal size.
     */
    res: 1024,         // the long side the decoder runs at, in pixels
    rate: 12,          // mattes per second of source; the matte moves slower than the frame
    low: 256,          // the side of the low-resolution logit map fed to the next frame
    boxPad: 0.08,      // how far the derived box is grown, as a fraction of its own size
    thresh: 128,       // alpha at or above this is "inside" when a box is derived
    maxPts: 24,        // point prompts a single stroke may contribute
    minR: 0.004,       // the smallest brush that still means something
    brush: 0.03,       // the default brush radius, a fraction of the frame's shorter side
    tol: 42,           // the built-in colour engine's reach, in RGB distance
  };

  /*
   * The bands `res` and `rate` are allowed to hold.
   *
   * `res` stops at 512 rather than at something small because MobileSAM degrades sharply
   * below its own scale: measured on a plate whose answer is known to the pixel, 1024 comes
   * back exact, 512 a third too big, and 128 returns 99.9% of the frame. A resolution that
   * cannot produce a usable matte is not a resolution, it is a bug waiting to be reported
   * as "the mask does nothing but tint the picture".
   */
  const RES_MIN = 512, RES_MAX = 2048;
  const RATE_MIN = 4, RATE_MAX = 60;
  const inBand = (v, lo, hi) => isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;

  // ------------------------------------------------------------------- the data model

  let seq = 0;
  const uid = () => 'mk' + Date.now().toString(36) + (seq++).toString(36);

  /** A fresh, empty mask. It has no strokes yet, so it segments nothing yet. */
  function makeMask(name, opts) {
    const o = opts || {};
    return {
      id: uid(),
      name: name || 'Mask 1',
      res: Math.round(fill(o.res, DEFAULTS.res, RES_MIN, RES_MAX)),
      rate: Math.round(fill(o.rate, DEFAULTS.rate, RATE_MIN, RATE_MAX)),
      strokes: [],
    };
  }

  function hasMasks(clip) {
    return !!(clip && Array.isArray(clip.masks) && clip.masks.length);
  }

  function maskById(clip, id) {
    if (!hasMasks(clip) || !id) return null;
    return clip.masks.find((m) => m && m.id === id) || null;
  }

  /**
   * Fill a mask in against the defaults and drop anything malformed. Absent stays absent:
   * a project that has never painted one serialises exactly as it did before this existed.
   */
  function normalizeMask(m) {
    if (!m || typeof m !== 'object') return null;
    if (!m.id) m.id = uid();
    m.name = String(m.name || 'Mask');
    /*
     * OUT OF BAND IS REPAIRED TO THE DEFAULT, not clamped to the nearest edge.
     *
     * Neither of these has a control, so the only value either has ever legitimately held
     * is the default - which means anything outside the band was written by the build that
     * shipped the `clamp()` bug above, and lifting it to the band's floor would leave a
     * mask cut at 512 that the author never asked for. So a project saved by that build
     * opens repaired. When a control for these does arrive, it must offer values inside
     * the bands, and this becomes an ordinary clamp.
     */
    m.res = inBand(m.res, RES_MIN, RES_MAX) ? Math.round(Number(m.res)) : DEFAULTS.res;
    m.rate = inBand(m.rate, RATE_MIN, RATE_MAX) ? Math.round(Number(m.rate)) : DEFAULTS.rate;
    const out = [];
    for (const s of (Array.isArray(m.strokes) ? m.strokes : [])) {
      if (!s || !Array.isArray(s.pts) || s.pts.length < 2) continue;
      const pts = [];
      for (let i = 0; i + 1 < s.pts.length; i += 2) {
        const x = Number(s.pts[i]), y = Number(s.pts[i + 1]);
        if (!isFinite(x) || !isFinite(y)) continue;
        pts.push(r4(clamp(x, 0, 1)), r4(clamp(y, 0, 1)));
      }
      if (pts.length < 2) continue;
      out.push({
        t: r4(num(s.t, 0)),
        sign: Number(s.sign) < 0 ? -1 : 1,
        r: r4(fill(s.r, DEFAULTS.brush, DEFAULTS.minR, 0.5)),
        pts,
      });
    }
    // Sorted by time, so `plan()`, `promptsAt()` and the panel all see one order and the
    // cache key of a mask does not depend on the order the strokes happened to be painted.
    out.sort((a, b) => a.t - b.t);
    m.strokes = out;
    return m;
  }

  function normalizeClip(clip) {
    if (!clip || !Array.isArray(clip.masks)) return;
    clip.masks = clip.masks.map(normalizeMask).filter(Boolean);
    if (!clip.masks.length) delete clip.masks;
  }

  /** Add one painted stroke. `pts` is a flat [x,y,x,y,...] in SOURCE fractions. */
  function addStroke(mask, t, sign, pts, r) {
    if (!mask || !Array.isArray(pts) || pts.length < 2) return null;
    const s = { t: r4(num(t, 0)), sign: sign < 0 ? -1 : 1,
      r: r4(fill(r, DEFAULTS.brush, DEFAULTS.minR, 0.5)), pts: pts.slice() };
    mask.strokes = Array.isArray(mask.strokes) ? mask.strokes : [];
    mask.strokes.push(s);
    normalizeMask(mask);
    return s;
  }

  /** Drop every stroke painted on the frame nearest `t`. The panel's "undo this frame". */
  function clearStrokesAt(mask, t, eps) {
    if (!mask || !Array.isArray(mask.strokes)) return 0;
    const e = num(eps, 1 / (2 * (mask.rate || DEFAULTS.rate)));
    const before = mask.strokes.length;
    mask.strokes = mask.strokes.filter((s) => Math.abs(s.t - t) > e);
    return before - mask.strokes.length;
  }

  /**
   * The frames that carry strokes, in order - the anchors propagation starts from.
   *
   * Strokes painted within half a matte-step of each other are the SAME anchor: a person
   * scrubbing one frame and painting four strokes on it is correcting one frame, and
   * letting a 3 ms scrub difference split that into two anchors would re-solve the clip
   * twice and disagree with itself in the overlap.
   */
  function anchors(mask) {
    if (!mask || !Array.isArray(mask.strokes) || !mask.strokes.length) return [];
    const e = 1 / (2 * (mask.rate || DEFAULTS.rate));
    const out = [];
    for (const s of mask.strokes) {
      if (!out.length || s.t - out[out.length - 1] > e) out.push(s.t);
    }
    return out;
  }

  /** The anchor a frame at `t` propagates from, or null when there are none. */
  function anchorFor(mask, t) {
    const a = anchors(mask);
    if (!a.length) return null;
    let best = a[0];
    for (const x of a) { if (x <= t + 1e-6) best = x; }
    return best;
  }

  // ------------------------------------------------------------------ prompt encoding

  /**
   * One stroke as point prompts, in PIXELS of a `w` x `h` analysis frame.
   *
   * A scribble is resampled along its own length at roughly one point per brush radius,
   * so a long drag becomes a line of prompts and a dab becomes one. Both ends are always
   * kept - the ends of a stroke down an arm are the wrist and the shoulder, which are
   * exactly the two places the decoder most needs telling about - and the count is capped
   * so a frantic scribble cannot hand the decoder four hundred points.
   */
  function strokePoints(s, w, h) {
    const minSide = Math.max(1, Math.min(w, h));
    const step = Math.max(1, clamp(s.r, DEFAULTS.minR, 0.5) * minSide);
    const px = [];
    for (let i = 0; i + 1 < s.pts.length; i += 2) px.push({ x: s.pts[i] * w, y: s.pts[i + 1] * h });
    if (px.length === 1) return [{ x: px[0].x, y: px[0].y, label: s.sign > 0 ? 1 : 0 }];
    const out = [px[0]];
    let acc = 0;
    for (let i = 1; i < px.length; i++) {
      acc += Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y);
      if (acc >= step) { out.push(px[i]); acc = 0; }
    }
    if (out[out.length - 1] !== px[px.length - 1]) out.push(px[px.length - 1]);
    // Thin evenly rather than truncating: the tail of a stroke is not less informative
    // than its head, and dropping it is how a scribble ends up masking only its first half.
    let keep = out;
    if (out.length > DEFAULTS.maxPts) {
      keep = [];
      for (let i = 0; i < DEFAULTS.maxPts; i++) {
        keep.push(out[Math.round(i * (out.length - 1) / (DEFAULTS.maxPts - 1))]);
      }
    }
    return keep.map((p) => ({ x: p.x, y: p.y, label: s.sign > 0 ? 1 : 0 }));
  }

  /**
   * Every prompt for the anchor frame at `t`, in pixels of a `w` x `h` frame.
   *
   * Label 1 is the object and label 0 is the background, which is the convention the SAM
   * decoder takes and the one the local engine follows, so the two are interchangeable.
   */
  function promptsAt(mask, t, w, h, eps) {
    const e = num(eps, 1 / (2 * ((mask && mask.rate) || DEFAULTS.rate)));
    const pts = [];
    for (const s of ((mask && mask.strokes) || [])) {
      if (Math.abs(s.t - t) > e) continue;
      for (const p of strokePoints(s, w, h)) pts.push(p);
    }
    return pts;
  }

  // --------------------------------------------------------------- planning a solve

  /**
   * The schedule for solving a mask across [t0, t1] at its own rate.
   *
   * Anchors cut the range into segments. The first anchor also owns everything BEFORE it,
   * solved backward - a person who paints on the middle of a clip means the whole clip,
   * not the second half of it. Every other segment runs forward from its anchor to the
   * next one, which is what makes a correction re-solve the future and leave the past.
   *
   * Each entry is `{ t, anchor, seg }`: `anchor` marks the frame decoded from the painted
   * prompts alone, and every other frame in `seg` is decoded from the one before it.
   */
  function plan(mask, t0, t1, rate) {
    const a = anchors(mask);
    if (!a.length || !(t1 > t0)) return [];
    const step = 1 / Math.max(1, num(rate, (mask && mask.rate) || DEFAULTS.rate));
    const out = [];
    let seg = 0;

    // Backward from the first anchor. The anchor frame itself belongs to the forward
    // segment - decoding it twice would put two different mattes at one instant.
    const first = clamp(a[0], t0, t1);
    if (first - t0 > step / 2) {
      out.push({ t: r4(first), anchor: true, seg });
      for (let t = first - step; t > t0 - 1e-6; t -= step) out.push({ t: r4(Math.max(t, t0)), anchor: false, seg });
      seg++;
    }

    for (let i = 0; i < a.length; i++) {
      const from = clamp(a[i], t0, t1);
      const to = i + 1 < a.length ? Math.min(clamp(a[i + 1], t0, t1), t1) : t1;
      out.push({ t: r4(from), anchor: true, seg });
      for (let t = from + step; t < to - 1e-6; t += step) out.push({ t: r4(t), anchor: false, seg });
      seg++;
    }
    return out;
  }

  // -------------------------------------------------------------- matte edge operations

  /**
   * THE UNIT RULE, inherited from `fx.js`: every length here is a fraction of the matte
   * plane's SHORTER SIDE, never a pixel count.
   *
   * The plane is built at the mask's own resolution and then drawn scaled to whatever is
   * being painted - 540x960 in the viewer, 1080x1920 in the file. A "4 px" feather would
   * therefore be twice as soft in the viewer as in the export, which is the exact class of
   * bug the unit rule in `fx.js` exists to prevent, one file along.
   */
  function radiusPx(f, w, h) {
    return Math.max(0, Math.round(clamp(f, 0, 0.5) * Math.max(1, Math.min(w, h))));
  }

  /** Separable box min/max: grow > 0 dilates by that many pixels, < 0 erodes. */
  function growPlane(a, w, h, px) {
    const r = Math.abs(px | 0);
    if (!r) return a;
    const wide = px > 0;
    const pick = wide ? Math.max : Math.min;
    const tmp = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = a[y * w + Math.min(w - 1, Math.max(0, x))];
        for (let d = 1; d <= r; d++) {
          v = pick(v, a[y * w + Math.min(w - 1, x + d)]);
          v = pick(v, a[y * w + Math.max(0, x - d)]);
        }
        tmp[y * w + x] = v;
      }
    }
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = tmp[y * w + x];
        for (let d = 1; d <= r; d++) {
          v = pick(v, tmp[Math.min(h - 1, y + d) * w + x]);
          v = pick(v, tmp[Math.max(0, y - d) * w + x]);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  /**
   * Three box blurs is a gaussian to well within an 8-bit level, and it is separable, so
   * feathering a 512-side plane costs six passes of a few hundred thousand adds.
   *
   * The edges CLAMP rather than reading zero. A feather that faded towards nothing at the
   * frame's border would eat a matte that runs off the edge of the picture - which is
   * what a matte of a person standing at the side of the shot does - and the symptom is a
   * cut-out with a soft grey stripe down one side.
   */
  function blurPlane(a, w, h, px) {
    const r = px | 0;
    if (r <= 0) return a;
    let src = a;
    for (let pass = 0; pass < 3; pass++) {
      const tmp = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let d = -r; d <= r; d++) sum += src[y * w + clamp(d, 0, w - 1)];
        const n = 2 * r + 1;
        for (let x = 0; x < w; x++) {
          tmp[y * w + x] = sum / n;
          sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
        }
      }
      const out = new Uint8ClampedArray(w * h);
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let d = -r; d <= r; d++) sum += tmp[clamp(d, 0, h - 1) * w + x];
        const n = 2 * r + 1;
        for (let y = 0; y < h; y++) {
          out[y * w + x] = sum / n;
          sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
      }
      src = out;
    }
    return src;
  }

  /**
   * Grow, then feather, then invert - and the order is the feature, not a detail.
   *
   * Growing after feathering would re-harden the edge that was just softened, so a
   * "feather 0.02, choke -0.01" would come back hard. Inverting first would grow the
   * BACKGROUND, so a choke meant to pull a halo in would push it out instead. One order,
   * stated here, and `smoke-mask.js` asserts each of the three against the other two.
   */
  function edge(alpha, w, h, opts) {
    const o = opts || {};
    let a = alpha;
    const g = radiusPx(Math.abs(num(o.grow, 0)), w, h) * (num(o.grow, 0) < 0 ? -1 : 1);
    if (g) a = growPlane(a, w, h, g);
    const f = radiusPx(num(o.feather, 0), w, h);
    if (f) a = blurPlane(a === alpha ? Uint8ClampedArray.from(alpha) : a, w, h, f);
    if (o.invert) {
      const out = new Uint8ClampedArray(w * h);
      for (let i = 0; i < out.length; i++) out[i] = 255 - a[i];
      return out;
    }
    return a === alpha ? Uint8ClampedArray.from(alpha) : a;
  }

  /** The tight box around everything at or above `thresh`, in pixels, or null. */
  function bbox(alpha, w, h, thresh) {
    const th = num(thresh, DEFAULTS.thresh);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] < th) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < x0 || y1 < y0) return null;
    const pad = DEFAULTS.boxPad;
    const dx = (x1 - x0 + 1) * pad, dy = (y1 - y0 + 1) * pad;
    return {
      x0: Math.max(0, x0 - dx), y0: Math.max(0, y0 - dy),
      x1: Math.min(w - 1, x1 + dx), y1: Math.min(h - 1, y1 + dy),
    };
  }

  /** Downsample a matte to the low-resolution logit map the next frame is seeded with. */
  function lowRes(alpha, w, h, side) {
    const n = Math.max(4, Math.round(num(side, DEFAULTS.low)));
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      const sy0 = Math.floor(y * h / n), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / n));
      for (let x = 0; x < n; x++) {
        const sx0 = Math.floor(x * w / n), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / n));
        let s = 0, c = 0;
        for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { s += alpha[yy * w + xx]; c++; }
        out[y * n + x] = c ? (s / c) / 255 : 0;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------- the engine

  /**
   * THE SEGMENTER IS INJECTED, for the same reason `FX.setBinder()` is.
   *
   *   engine(req) -> { alpha: Uint8ClampedArray(w*h) }   (or a promise of one)
   *   req = { w, h, rgba, points:[{x,y,label}], box, prev, key }
   *
   * `app.js` installs one that runs MobileSAM through the main process; `smoke-mask.js`
   * installs one that segments a painted shape it already knows the answer to. Neither
   * this file nor `fx.js` knows or cares which, which is what makes the propagation loop
   * testable without a 40 MB download and what keeps a model failure from being an
   * exception in the middle of a draw.
   */
  let ENGINE = null;
  function setEngine(fn) { ENGINE = typeof fn === 'function' ? fn : null; }
  function hasEngine() { return !!(ENGINE || true); }   // LOCAL is always available

  /**
   * The engine of last resort: a colour region-grow from the positive prompts, fenced by
   * the negative ones.
   *
   * It is here so that Magic Mask WORKS with no model downloaded and no network - the
   * degradation contract step 8 wrote down, kept. It is not MobileSAM and the panel says
   * so: it follows colour, so it holds a logo, a coloured button, a UI panel or a solid
   * shape very well and a person in a patterned shirt poorly. What it gives up is
   * semantics; what it keeps is the whole workflow - paint, correct, propagate, feather -
   * so the expensive half can be swapped in underneath without the UI noticing.
   *
   * Deterministic, seeded by nothing, no `Math.random()`: the preview and the export build
   * this matte independently and they have to agree, which is the same rule the film
   * burn's streaks and step 16's grain live by.
   */
  function localEngine(req) {
    const { w, h, rgba } = req;
    const pos = (req.points || []).filter((p) => p.label === 1);
    const neg = (req.points || []).filter((p) => p.label !== 1);
    const out = new Uint8ClampedArray(w * h);
    if (!pos.length) return { alpha: out };

    const tol = fill(req.tol, DEFAULTS.tol, 4, 160);
    const box = req.box;
    const bx0 = box ? Math.max(0, Math.floor(box.x0)) : 0;
    const by0 = box ? Math.max(0, Math.floor(box.y0)) : 0;
    const bx1 = box ? Math.min(w - 1, Math.ceil(box.x1)) : w - 1;
    const by1 = box ? Math.min(h - 1, Math.ceil(box.y1)) : h - 1;

    const at = (x, y) => ((y * w + x) << 2);
    const seedsOf = (list) => list.map((p) => {
      const x = clamp(Math.round(p.x), 0, w - 1), y = clamp(Math.round(p.y), 0, h - 1);
      const i = at(x, y);
      return { x, y, r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] };
    });
    const dist2 = (i, c) => {
      const dr = rgba[i] - c.r, dg = rgba[i + 1] - c.g, db = rgba[i + 2] - c.b;
      return dr * dr + dg * dg + db * db;
    };

    /**
     * A connected region grown from a set of seeds, bounded by the box.
     *
     * Four-connected and ITERATIVE - a recursive fill on a 512-side plane overflows the
     * stack, which is a thing this file learned the boring way.
     */
    const grow = (seeds) => {
      const hit = new Uint8Array(w * h);
      if (!seeds.length) return hit;
      const fits = (k) => {
        const i = k << 2;
        for (const s of seeds) if (dist2(i, s) <= tol * tol) return true;
        return false;
      };
      const seen = new Uint8Array(w * h);
      const stack = [];
      for (const s of seeds) {
        if (s.x < bx0 || s.x > bx1 || s.y < by0 || s.y > by1) continue;
        stack.push(s.y * w + s.x);
      }
      while (stack.length) {
        const k = stack.pop();
        if (seen[k]) continue;
        seen[k] = 1;
        const x = k % w, y = (k - x) / w;
        if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
        if (!fits(k)) continue;
        hit[k] = 1;
        if (x > bx0 && !seen[k - 1]) stack.push(k - 1);
        if (x < bx1 && !seen[k + 1]) stack.push(k + 1);
        if (y > by0 && !seen[k - w]) stack.push(k - w);
        if (y < by1 && !seen[k + w]) stack.push(k + w);
      }
      return hit;
    };

    /*
     * A NEGATIVE STROKE REMOVES THE REGION IT SITS IN. It is not a colour to stay away
     * from, and that distinction is the whole of why this took two attempts.
     *
     * The first version rejected any pixel nearer a negative seed's colour than a positive
     * one, and it fails on the case the feature exists for: two things the SAME colour,
     * one of them wanted. Colour cannot tell them apart, so a colour rule either keeps
     * both or throws both away. What the author meant by scribbling on the second one is
     * "not that THING" - a region - so the negative grows its own region and that region
     * is subtracted. The leak between an arm and a torso is the same shape of problem: the
     * positive fill escapes through the gap into the background, and a negative in the gap
     * carves the escaped component back out.
     */
    const keep = grow(seedsOf(pos));
    const drop = neg.length ? grow(seedsOf(neg)) : null;
    for (let k = 0; k < out.length; k++) {
      if (keep[k] && !(drop && drop[k])) out[k] = 255;
    }
    return { alpha: out };
  }

  /**
   * One frame of the loop. `prev` is the previous frame's matte, or null on an anchor.
   *
   * On an anchor the prompts are the painted strokes. On every other frame there are no
   * strokes, so the seed is the previous matte: its box bounds the search and its
   * interior supplies the seed points. That is the propagation, and it is deliberately
   * the ONLY difference between the two cases - one code path, two inputs.
   */
  async function solveFrame(req) {
    const fn = ENGINE || localEngine;
    const r = await fn(req);
    if (!r || !r.alpha) return null;
    return r.alpha.length === req.w * req.h ? r.alpha : null;
  }

  /**
   * Seed points taken from a previous matte: its centroid plus a few interior samples.
   *
   * Not the whole matte re-fed as points - that would pin the object to where it WAS and
   * the loop would stop following anything. A handful of deep-interior points move with
   * the object because they are re-derived from the mask that moved.
   */
  function seedFrom(alpha, w, h, thresh) {
    const th = num(thresh, DEFAULTS.thresh);
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] >= th) { sx += x; sy += y; n++; }
    }
    if (!n) return [];
    const cx = sx / n, cy = sy / n;
    const pts = [];
    if (alpha[clamp(Math.round(cy), 0, h - 1) * w + clamp(Math.round(cx), 0, w - 1)] >= th) {
      pts.push({ x: cx, y: cy, label: 1 });
    }
    // Four more, a quarter of the way out along each axis, kept only where the matte
    // actually is - a C-shaped object's centroid is outside it and one point there would
    // seed the loop on the background.
    const b = bbox(alpha, w, h, th);
    if (b) {
      const qs = [[0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
      for (const [fx, fy] of qs) {
        const x = clamp(Math.round(b.x0 + (b.x1 - b.x0) * fx), 0, w - 1);
        const y = clamp(Math.round(b.y0 + (b.y1 - b.y0) * fy), 0, h - 1);
        if (alpha[y * w + x] >= th) pts.push({ x, y, label: 1 });
      }
    }
    if (pts.length) return pts;
    // THE FALL-BACK MUST BE INSIDE. Handing back the centroid of a C-shaped matte seeds
    // the next frame on the background, and the loop then follows the background - which
    // looks exactly like a tracking failure and is not one. Scan for a pixel that is
    // actually in the matte instead; there is one, because `n` was not zero.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] >= th) return [{ x, y, label: 1 }];
      }
    }
    return [];
  }

  /**
   * Run the whole loop over a planned schedule. `getFrame(t)` hands back `{w,h,rgba}`.
   *
   * Nothing here mutates a clip: it answers `{ t, alpha }` per frame and the caller
   * decides what to do with them, under ONE `pushUndo()`. Same contract `trkSolveRun()`
   * keeps, and for the same reason.
   *
   * `onFrame` is called per matte so the caller can stream them to disk instead of
   * holding a minute of planes in memory, and `should()` is the cancel hook.
   */
  async function propagate(mask, steps, getFrame, opts) {
    const o = opts || {};
    const out = [];
    let prevAlpha = null, prevSeg = -1;
    /*
     * ONE DECODE PER ANCHOR, however many segments begin on it.
     *
     * `plan()` gives every segment its own anchor entry, because a segment that did not
     * start from the painted prompts would have nothing to seed itself with. The frame a
     * person paints on the MIDDLE of a clip is therefore named twice - once by the segment
     * running backward from it and once by the one running forward - and decoding it twice
     * would cost a second inference and put two records at one instant in the store. So
     * the anchor is decoded on its first mention and re-used on the second, which is both
     * the cheap answer and the only self-consistent one.
     */
    const solvedAnchors = new Map();
    for (const step of steps) {
      if (o.should && !o.should()) break;
      if (step.anchor && solvedAnchors.has(step.t)) {
        prevAlpha = solvedAnchors.get(step.t);
        prevSeg = step.seg;
        continue;
      }
      const fr = await getFrame(step.t);
      if (!fr) break;
      const { w, h, rgba } = fr;
      if (step.anchor || step.seg !== prevSeg) { prevAlpha = null; prevSeg = step.seg; }
      const points = step.anchor
        ? promptsAt(mask, step.t, w, h)
        : (prevAlpha ? seedFrom(prevAlpha, w, h, o.thresh) : []);
      if (!points.length) { prevAlpha = null; continue; }
      const box = step.anchor ? null : (prevAlpha ? bbox(prevAlpha, w, h, o.thresh) : null);
      const alpha = await solveFrame({
        w, h, rgba, points, box,
        prev: prevAlpha || null,
        prevLow: prevAlpha ? lowRes(prevAlpha, w, h, DEFAULTS.low) : null,
        anchor: !!step.anchor, key: o.key,
      });
      if (!alpha) { prevAlpha = null; continue; }
      prevAlpha = alpha;
      if (step.anchor) solvedAnchors.set(step.t, alpha);
      const rec = { t: step.t, alpha };
      if (o.onFrame) await o.onFrame(rec);
      else out.push(rec);
    }
    return out;
  }

  // ----------------------------------------------------------------- keys and digests

  /** A stable 32-bit hash. Not cryptography - an identity for a cache line. */
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /** Everything about a mask that decides its pixels, and nothing else. */
  function maskSig(mask) {
    if (!mask) return '';
    return mask.res + ':' + mask.rate + ':' + (mask.strokes || []).map((s) =>
      s.t + ',' + s.sign + ',' + s.r + ',' + s.pts.join(',')).join(';');
  }

  /**
   * The matte cache key: the source range, the prompts, the resolution and the engine.
   *
   * WHAT IS NOT IN IT is the point: the clip's start, its track, its id, its pan, zoom or
   * volume. A matte is a property of the FILE and the strokes painted on it, so moving,
   * trimming, duplicating or re-framing the clip must serve the same cached mattes - the
   * rule the render cache, the track cache and the bake cache all keep, and the one
   * `smoke-mask.js` checks by moving a clip and hashing the key either side.
   *
   * The engine IS in it. A matte cut by the local region-grow and one cut by MobileSAM are
   * different pixels from the same prompts, so a machine that finishes its model download
   * mid-project must not serve the old mattes back.
   */
  function cacheKey(o) {
    const p = o || {};
    return hash([
      'mm1',
      r4(p.t0), r4(p.t1), Math.round(num(p.res, DEFAULTS.res)), Math.round(num(p.rate, DEFAULTS.rate)),
      String(p.engine || 'local'),
      maskSig(p.mask),
    ].join('|'));
  }

  /**
   * The smallest thing that says which matte a clip is wearing, for the RENDER key.
   *
   * The same shape `Tracker.digest()` and `mouseDigest()` answer, and absent for the same
   * reason: a mask nobody has put a `matte` effect on decides no pixels, so a clip merely
   * carrying one must key exactly as a clip that never had one.
   */
  function digest(clip, id) {
    const m = maskById(clip, id);
    if (!m || !m.strokes.length) return null;
    return { n: m.strokes.length, s: hash(maskSig(m)) };
  }

  const API = {
    DEFAULTS, RES_MIN, RES_MAX, RATE_MIN, RATE_MAX,
    makeMask, normalizeMask, normalizeClip, hasMasks, maskById,
    addStroke, clearStrokesAt, anchors, anchorFor,
    strokePoints, promptsAt, plan,
    edge, growPlane, blurPlane, radiusPx, bbox, lowRes, seedFrom,
    setEngine, hasEngine, localEngine, solveFrame, propagate,
    hash, maskSig, cacheKey, digest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.MagicMask = API;
  else if (typeof self !== 'undefined') self.MagicMask = API;
})();
