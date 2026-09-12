'use strict';
/**
 * Speed: the map between a clip's SOURCE time and its TIMELINE time.
 *
 * Everything else in the app has been able to assume one sentence: a clip occupies
 * `out - in` seconds of timeline, and the source time under a timeline time `t` is
 * `in + (t - start)`. Speed is the feature that ends that assumption, and it ends it
 * everywhere at once - trimming, splitting, snapping, transitions, the tracker, the
 * mask, the cursor overlays, the baker and `buildArgs()` all did that arithmetic inline.
 *
 * So this module is deliberately small and total. There are exactly two directions:
 *
 *     Speed.srcAt(clip, tLocal)   timeline-local seconds  ->  absolute source seconds
 *     Speed.localOf(clip, tSrc)   absolute source seconds ->  timeline-local seconds
 *
 * and one derived number, `Speed.timelineLen(clip)`, which is what `clipEnd()` now adds
 * to `start`. A clip with no ramp answers `out - in` from all three, arithmetically
 * identically to the code they replaced, which is why a project with no speed on it
 * renders byte-identical arguments and hashes to the same render-cache key.
 *
 * WHICH DOMAIN THE CURVE LIVES IN. The rate curve is keyed in ABSOLUTE SOURCE time, not
 * in timeline time and not relative to the in-point. Two reasons, both load-bearing:
 *
 *   1. Timeline length is the integral of the curve. Keying the curve in timeline time
 *      would define the length in terms of a domain whose size is the length - circular.
 *      Source time is the free variable; the timeline length falls out of it.
 *   2. Trimming must not slide the ramp along the footage. A slow-motion moment belongs
 *      to a moment in the recording, so it is addressed by its time in the recording.
 *      Move the in-point and the ramp stays on the frames it was put on.
 *
 * THE INTEGRAL. Timeline length is the integral of 1/rate over the source range, and it
 * is evaluated by trapezoid on a FIXED grid of `STEP` source seconds. Fixed, because the
 * preview and the export must agree to the sample: a grid that depended on the clip's
 * length or on the output fps would give the viewer and the file two different lengths.
 * The inverse solves the same trapezoid exactly (one quadratic per step), so
 * `localOf(srcAt(t)) === t` to floating point - that round trip is what keeps a split at
 * the playhead landing on the frame the playhead was showing.
 *
 * Nothing here is stored on a clip beyond the plain-JSON `clip.speed`. The integration
 * tables are cached in this module, keyed by the curve itself, so undo is still
 * `JSON.stringify` of the track list and the `.scut` file is unchanged in shape.
 */
const Speed = (() => {

  /** A rate is a multiplier on playback: 2 is twice as fast, 0.5 is half. */
  const MIN_RATE = 0.05;
  const MAX_RATE = 20;
  /** The integration grid, in SOURCE seconds. Fixed for preview/export agreement. */
  const STEP = 1 / 240;

  const AUDIO_MODES = [
    { value: 'pitch', label: 'Keep the pitch (atempo)' },
    { value: 'mute', label: 'Silence it through the ramp' },
  ];

  const DEFAULTS = { rate: 1, audio: 'pitch', keys: [] };

  /** Speed applies to clips that have a source clock. A card has none. */
  const SPEEDABLE = new Set(['video', 'audio']);
  function canSpeed(clip) { return !!clip && SPEEDABLE.has(clip.kind); }

  function clampRate(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return 1;
    return Math.max(MIN_RATE, Math.min(MAX_RATE, n));
  }

  /**
   * The clip's speed block, or null when it has none.
   *
   * `clip.speed` stays ABSENT until the rate is actually changed, exactly as `clip.keys`
   * does - a project that uses no speed serialises as it did before this existed, and an
   * undo snapshot of it hashes the same.
   */
  function of(clip) {
    if (!canSpeed(clip)) return null;
    const s = clip.speed;
    if (!s || typeof s !== 'object') return null;
    return s;
  }

  /** Fill a speed block in, in place, without overwriting anything already set. */
  function normalize(clip) {
    const s = of(clip);
    if (!s) return null;
    if (s.rate == null) s.rate = DEFAULTS.rate;
    s.rate = clampRate(s.rate);
    if (s.audio !== 'mute') s.audio = 'pitch';
    if (!Array.isArray(s.keys)) s.keys = [];
    s.keys = s.keys
      .filter((k) => k && isFinite(k.t) && isFinite(k.v))
      .map((k) => ({ t: k.t, v: clampRate(k.v), ease: k.ease }));
    Anim.sortKeys(s.keys);
    return s;
  }

  /** Create the block on demand. The caller has already pushed undo. */
  function ensure(clip) {
    if (!canSpeed(clip)) return null;
    if (!clip.speed) clip.speed = JSON.parse(JSON.stringify(DEFAULTS));
    return normalize(clip);
  }

  /** Drop a speed block that no longer says anything, so saved files stay clean. */
  function prune(clip) {
    const s = of(clip);
    if (!s) return;
    if (Math.abs(s.rate - 1) < 1e-9 && !s.keys.length && s.audio === 'pitch') delete clip.speed;
  }

  /** Does this clip's picture run at anything other than 1x anywhere? */
  function has(clip) {
    const s = of(clip);
    if (!s) return false;
    if (s.keys && s.keys.length) return true;
    return Math.abs(clampRate(s.rate) - 1) > 1e-9;
  }

  /** Is the rate a CURVE rather than one constant? Decides how audio can be treated. */
  function ramped(clip) {
    const s = of(clip);
    if (!s || !s.keys || !s.keys.length) return false;
    if (s.keys.length === 1) return false;             // one key is a constant
    const v0 = clampRate(s.keys[0].v);
    return s.keys.some((k) => Math.abs(clampRate(k.v) - v0) > 1e-9);
  }

  /** The one constant rate a clip runs at, or null when it ramps. */
  function constantRate(clip) {
    const s = of(clip);
    if (!s) return 1;
    if (!s.keys || !s.keys.length) return clampRate(s.rate);
    if (ramped(clip)) return null;
    return clampRate(s.keys[0].v);
  }

  /** How the clip's own audio is treated. A ramp can only be silenced. */
  function audioMode(clip) {
    const s = of(clip);
    if (!s || !has(clip)) return 'pitch';
    if (ramped(clip)) return 'mute';
    return s.audio === 'mute' ? 'mute' : 'pitch';
  }

  /** The rate at absolute source time `tSrc`. */
  function rateAt(clip, tSrc) {
    const s = of(clip);
    if (!s) return 1;
    if (s.keys && s.keys.length) {
      const v = Anim.evalTrack(s.keys, tSrc);
      if (v != null) return clampRate(v);
    }
    return clampRate(s.rate);
  }

  // ------------------------------------------------------------------- tables

  /**
   * The cumulative timeline time spent reaching each grid point of the source.
   *
   * Built over the clip's whole SOURCE, not over `in..out`, so trimming does not rebuild
   * it and two trims of one file share it. Cached by the curve and the source length -
   * never by the clip, and never by where the clip sits on the timeline.
   */
  const tables = new Map();
  const TABLE_LIMIT = 24;

  function signature(clip) {
    const s = of(clip);
    const md = sourceLen(clip);
    if (!s) return '1|' + md.toFixed(6);
    return md.toFixed(6) + '|' + clampRate(s.rate) +
      '|' + (s.keys || []).map((k) => k.t.toFixed(6) + ':' + clampRate(k.v) +
        ':' + (k.ease ? (k.ease.kind === 'named' ? k.ease.name : (k.ease.p || []).join(',')) : '-')).join(';');
  }

  /** How much source there is to integrate over. */
  function sourceLen(clip) {
    const md = clip && isFinite(clip.mediaDuration) ? clip.mediaDuration : 0;
    const out = clip && isFinite(clip.out) ? clip.out : 0;
    return Math.max(md, out, 0.001);
  }

  function tableFor(clip) {
    const key = signature(clip);
    const hit = tables.get(key);
    if (hit) return hit;
    const T = sourceLen(clip);
    const n = Math.max(1, Math.ceil(T / STEP));
    const w = new Float64Array(n + 1);          // 1/rate at each grid point
    const cum = new Float64Array(n + 1);        // timeline seconds reached at that point
    for (let i = 0; i <= n; i++) w[i] = 1 / rateAt(clip, Math.min(i * STEP, T));
    for (let i = 1; i <= n; i++) {
      const h = Math.min(STEP, T - (i - 1) * STEP);
      cum[i] = cum[i - 1] + (h > 0 ? h * (w[i - 1] + w[i]) / 2 : 0);
    }
    const tbl = { T, n, w, cum };
    tables.set(key, tbl);
    if (tables.size > TABLE_LIMIT) tables.delete(tables.keys().next().value);
    return tbl;
  }

  /** The timeline seconds from source 0 to source `s`, on the same trapezoid. */
  function cumAt(tbl, s) {
    const x = Math.max(0, Math.min(tbl.T, s));
    let i = Math.floor(x / STEP);
    if (i >= tbl.n) return tbl.cum[tbl.n];
    const s0 = i * STEP;
    const h = Math.min(STEP, tbl.T - s0);
    if (h <= 0) return tbl.cum[i];
    const d = x - s0;
    const w0 = tbl.w[i], w1 = tbl.w[i + 1];
    // The trapezoid restricted to [s0, s0+d], with w linear across the step.
    return tbl.cum[i] + d * (w0 + (w1 - w0) * d / (2 * h));
  }

  /** The inverse: the source time at which `c` timeline seconds have elapsed. */
  function srcAtCum(tbl, c) {
    const target = Math.max(0, Math.min(tbl.cum[tbl.n], c));
    // Binary search for the step containing it.
    let lo = 0, hi = tbl.n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tbl.cum[mid] <= target) lo = mid; else hi = mid;
    }
    const s0 = lo * STEP;
    const h = Math.min(STEP, tbl.T - s0);
    if (h <= 0) return tbl.T;
    const w0 = tbl.w[lo], w1 = tbl.w[lo + 1];
    const rest = target - tbl.cum[lo];
    // Solve `a d^2 + b d = rest` for d in [0, h] - the exact inverse of `cumAt`'s
    // partial trapezoid, which is what makes the round trip land on the same instant.
    const a = (w1 - w0) / (2 * h), b = w0;
    let d;
    if (Math.abs(a) < 1e-12) d = rest / Math.max(1e-12, b);
    else {
      const disc = b * b + 4 * a * rest;
      d = disc <= 0 ? 0 : (-b + Math.sqrt(disc)) / (2 * a);
      if (!isFinite(d) || d < 0) d = rest / Math.max(1e-12, b);
    }
    return Math.max(s0, Math.min(s0 + h, s0 + d));
  }

  // ------------------------------------------------------------ the two directions

  /**
   * How many timeline seconds the clip occupies.
   *
   * Identical to `out - in` for an unsped clip, by arithmetic and not by approximation:
   * the trapezoid of a constant is exact, and the unsped path skips the table entirely.
   */
  function timelineLen(clip) {
    if (!clip) return 0;
    const len = Math.max(0, (clip.out || 0) - (clip.in || 0));
    if (!has(clip)) return len;
    const r = constantRate(clip);
    if (r != null) return len / r;
    const tbl = tableFor(clip);
    return Math.max(0, cumAt(tbl, clip.out) - cumAt(tbl, clip.in));
  }

  /** Absolute source time under a timeline time measured from the clip's start. */
  function srcAt(clip, tLocal) {
    if (!clip) return 0;
    if (!has(clip)) return (clip.in || 0) + tLocal;
    const r = constantRate(clip);
    if (r != null) return (clip.in || 0) + tLocal * r;
    const tbl = tableFor(clip);
    return srcAtCum(tbl, cumAt(tbl, clip.in) + tLocal);
  }

  /** Timeline seconds from the clip's start at which source time `tSrc` is shown. */
  function localOf(clip, tSrc) {
    if (!clip) return 0;
    if (!has(clip)) return tSrc - (clip.in || 0);
    const r = constantRate(clip);
    if (r != null) return (tSrc - (clip.in || 0)) / r;
    const tbl = tableFor(clip);
    return cumAt(tbl, tSrc) - cumAt(tbl, clip.in);
  }

  /**
   * The source time `len` timeline seconds AFTER `from` - trimming the tail.
   * `advance(clip, clip.in, L)` is the out-point that makes the clip L seconds long.
   */
  function advance(clip, from, len) {
    if (!clip) return from;
    if (!has(clip)) return from + len;
    const r = constantRate(clip);
    if (r != null) return from + len * r;
    const tbl = tableFor(clip);
    return srcAtCum(tbl, cumAt(tbl, from) + len);
  }

  /**
   * The source time `len` timeline seconds BEFORE `to` - trimming the head.
   * `retreat(clip, clip.out, L)` is the in-point that makes the clip L seconds long.
   */
  function retreat(clip, to, len) {
    if (!clip) return to;
    if (!has(clip)) return to - len;
    const r = constantRate(clip);
    if (r != null) return to - len * r;
    const tbl = tableFor(clip);
    return srcAtCum(tbl, cumAt(tbl, to) - len);
  }

  /**
   * What the render cache needs to know about a clip's speed, and nothing else.
   *
   * `undefined` for an unsped clip so it keys exactly as it did before speed existed.
   * The curve itself goes in because two ramps can produce the same `in`, `out` and
   * timeline length while showing different frames at every instant between them.
   */
  function digest(clip) {
    if (!has(clip)) return undefined;
    const s = of(clip);
    return {
      rate: clampRate(s.rate),
      audio: audioMode(clip),
      keys: (s.keys || []).map((k) => [Number(k.t.toFixed(5)), clampRate(k.v)]),
    };
  }

  /** A human label for the lane and the inspector: "2x", "0.5x", "0.5-2x". */
  function label(clip) {
    if (!has(clip)) return '';
    const r = constantRate(clip);
    const fmt = (v) => (Math.round(v * 100) / 100) + 'x';
    if (r != null) return fmt(r);
    const vs = (of(clip).keys || []).map((k) => clampRate(k.v));
    return fmt(Math.min(...vs)) + '-' + fmt(Math.max(...vs));
  }

  return {
    MIN_RATE, MAX_RATE, STEP, AUDIO_MODES, DEFAULTS,
    canSpeed, of, ensure, normalize, prune, has, ramped, constantRate, audioMode,
    rateAt, timelineLen, srcAt, localOf, advance, retreat, digest, label, clampRate,
  };
})();
