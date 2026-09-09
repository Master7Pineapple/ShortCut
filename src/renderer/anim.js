'use strict';
/**
 * The keyframe engine.
 *
 * Everything in here used to live inside text/model.js, where it worked perfectly well
 * and could only ever animate a text card. It is the same maths - the extraction is
 * deliberately behaviour-preserving, and `TextModel` now re-exports these functions so
 * text cards keep behaving byte-identically.
 *
 * `Anim` owns four things and nothing else:
 *
 *   1. Easing - the cubic bezier solver, the named curves a bezier cannot express,
 *      and the preset menu both of those feed.
 *   2. A track - a plain array of `{ t, v, ease }`, sorted by `t`, evaluated at any time.
 *   3. Track editing - add / remove / move / retime one key.
 *   4. A registry of which properties a clip may put keyframes on, so the inspector's
 *      keyframe strip can be built generically instead of listing them by hand.
 *
 * Pure functions, no DOM, no canvas: the UI lives in `TextUI.keyStrip()` and the drawing
 * lives in whoever reads the value back out. Keys are plain JSON on the clip, because
 * undo is `JSON.stringify` of the track list and that is also the `.scut` file.
 */
const Anim = (() => {

  // ------------------------------------------------------------------ easing

  /** Solve a cubic bezier y for a given x, the same curve CSS `cubic-bezier()` uses. */
  function bezier(x1, y1, x2, y2) {
    const A = (a, b) => 1 - 3 * b + 3 * a;
    const B = (a, b) => 3 * b - 6 * a;
    const C = (a) => 3 * a;
    const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
    const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      // Newton-Raphson converges in a handful of steps for well-formed curves.
      for (let i = 0; i < 8; i++) {
        const d = slope(t, x1, x2);
        if (Math.abs(d) < 1e-6) break;
        const err = calc(t, x1, x2) - x;
        if (Math.abs(err) < 1e-6) break;
        t -= err / d;
      }
      return calc(t, y1, y2);
    };
  }

  /** Named curves that a cubic bezier cannot express (overshoot / oscillation). */
  const NAMED = {
    linear: (t) => t,
    bounce: (t) => {
      const n = 7.5625, d = 2.75;
      if (t < 1 / d) return n * t * t;
      if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
      if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
      t -= 2.625 / d; return n * t * t + 0.984375;
    },
    elastic: (t) => {
      if (t === 0 || t === 1) return t;
      const p = 0.3;
      return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * (2 * Math.PI) / p) + 1;
    },
    back: (t) => { const s = 1.70158; return t * t * ((s + 1) * t - s); },
    backOut: (t) => { const s = 1.70158; t -= 1; return t * t * ((s + 1) * t + s) + 1; },
    step: (t) => (t < 1 ? 0 : 1),
  };

  /** Preset menu: bezier presets first, then the named curves. */
  const EASING_PRESETS = {
    linear: { kind: 'named', name: 'linear' },
    ease: { kind: 'bezier', p: [0.25, 0.1, 0.25, 1] },
    easeIn: { kind: 'bezier', p: [0.42, 0, 1, 1] },
    easeOut: { kind: 'bezier', p: [0, 0, 0.58, 1] },
    easeInOut: { kind: 'bezier', p: [0.42, 0, 0.58, 1] },
    easeInQuad: { kind: 'bezier', p: [0.55, 0.085, 0.68, 0.53] },
    easeOutQuad: { kind: 'bezier', p: [0.25, 0.46, 0.45, 0.94] },
    easeInExpo: { kind: 'bezier', p: [0.95, 0.05, 0.795, 0.035] },
    easeOutExpo: { kind: 'bezier', p: [0.19, 1, 0.22, 1] },
    softLand: { kind: 'bezier', p: [0.16, 1, 0.3, 1] },
    back: { kind: 'named', name: 'back' },
    backOut: { kind: 'named', name: 'backOut' },
    bounce: { kind: 'named', name: 'bounce' },
    elastic: { kind: 'named', name: 'elastic' },
    step: { kind: 'named', name: 'step' },
  };

  const bezierCache = new Map();
  /** Evaluate an easing descriptor at t in 0..1. */
  function ease(easing, t) {
    t = Math.max(0, Math.min(1, t));
    if (!easing) return t;
    if (easing.kind === 'named') return (NAMED[easing.name] || NAMED.linear)(t);
    const p = easing.p || [0, 0, 1, 1];
    const key = p.join(',');
    let fn = bezierCache.get(key);
    if (!fn) { fn = bezier(p[0], p[1], p[2], p[3]); bezierCache.set(key, fn); }
    return fn(t);
  }

  const cloneEasing = (e) => JSON.parse(JSON.stringify(e || EASING_PRESETS.easeOut));

  // ------------------------------------------------------------------ tracks

  /**
   * Interpolate one keyframe track at time `t`. Returns null when the track is empty.
   *
   * A track holds its first value before the first key and its last value after the last
   * one, so keys sitting outside the clip's own range still produce a sane value inside
   * it. Sorting is done on a copy: an unsorted track evaluates correctly without the
   * evaluation quietly rewriting the author's data underneath a paint pass.
   *
   * `ease` belongs to the key on the LEFT of a span - it is the curve travelled to reach
   * the next key, which is why the final key's easing is never used.
   */
  function evalTrack(keys, t) {
    if (!keys || !keys.length) return null;
    const sorted = [...keys].sort((a, b) => a.t - b.t);
    if (t <= sorted[0].t) return sorted[0].v;
    const last = sorted[sorted.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        const p = span <= 0 ? 1 : (t - a.t) / span;
        return a.v + (b.v - a.v) * ease(a.ease, p);
      }
    }
    return last.v;
  }

  /** Sort a track in place and hand it back. The one place order is written. */
  function sortKeys(keys) {
    if (Array.isArray(keys)) keys.sort((a, b) => a.t - b.t);
    return keys;
  }

  /**
   * Add a key at time `t`, returning the key that now lives there.
   *
   * With no value given the key takes the track's CURRENT value at `t`, so dropping a key
   * onto an existing curve pins it rather than snapping the curve to a default - that is
   * what makes "hold here, then move" a two-click operation. A key already at `t` (within
   * a frame or so) is updated rather than duplicated: two keys at the same time make a
   * zero-length span whose interpolation is meaningless.
   */
  function addKey(keys, t, v, easing) {
    const existing = keys.find((k) => Math.abs(k.t - t) < 1e-4);
    const value = v == null ? evalTrack(keys, t) : v;
    if (existing) {
      if (value != null) existing.v = value;
      if (easing) existing.ease = cloneEasing(easing);
      return existing;
    }
    const k = {
      t,
      v: value == null ? 0 : value,
      ease: cloneEasing(easing || EASING_PRESETS.easeInOut),
    };
    keys.push(k);
    sortKeys(keys);
    return k;
  }

  /** Remove the key at index `i`. Returns true if something was removed. */
  function removeKey(keys, i) {
    if (!keys || i < 0 || i >= keys.length) return false;
    keys.splice(i, 1);
    return true;
  }

  /** Set a key's VALUE. Order cannot change, so the track is left alone. */
  function moveKey(keys, i, v) {
    if (!keys || !keys[i] || !isFinite(v)) return false;
    keys[i].v = v;
    return true;
  }

  /**
   * Set a key's TIME, then re-sort.
   *
   * Returns the key's new index, because dragging a key past its neighbour changes it and
   * a caller holding the old index would then edit the wrong key.
   */
  function retimeKey(keys, i, t) {
    if (!keys || !keys[i] || !isFinite(t)) return -1;
    const k = keys[i];
    k.t = t;
    sortKeys(keys);
    return keys.indexOf(k);
  }

  // -------------------------------------------------------- keyable properties

  /**
   * How one keyable property behaves: its slider range, its step, and the value a first
   * key takes when the track is empty.
   *
   * `base` matters more than it looks. A property that MULTIPLIES (opacity, scale, glow)
   * has to start at 1 or adding a key would black the clip out; one that ADDS (offsets,
   * rotation) has to start at 0 for the same reason.
   */
  const PROP_SPECS = {
    opacity: { label: 'opacity', min: 0, max: 1, step: 0.01, base: 1 },
    scale: { label: 'scale', min: 0.05, max: 4, step: 0.01, base: 1 },
    glow: { label: 'glow', min: 0, max: 3, step: 0.01, base: 1 },
    rotate: { label: 'rotate', min: -180, max: 180, step: 1, base: 0 },
    x: { label: 'x', min: -1, max: 1, step: 0.005, base: 0 },
    y: { label: 'y', min: -1, max: 1, step: 0.005, base: 0 },
  };

  /** The spec for a property, falling back to a neutral additive one. */
  function propSpec(prop) {
    return Object.assign({ label: prop, min: -1, max: 1, step: 0.005, base: 0 },
      PROP_SPECS[prop] || {});
  }

  /**
   * Which properties a NON-TEXT clip may be keyframed on.
   *
   * Deliberately empty in this build, and deliberately a registry rather than a list:
   * every property in here has to be honoured by both the preview and the render, and
   * today a clip's framing is baked into ffmpeg's crop/scale as a constant. Step 7's
   * effect stack registers its parameters through `registerClipProp()` once step 6 has
   * made the bake the single draw path, at which point one registration is all an effect
   * needs to become animatable. The strip is already generic; only the list is empty.
   */
  const clipProps = [];

  /**
   * Register a keyable clip property.
   *   { prop, label?, min, max, step, base, when?(clip) }
   * `when` filters by clip - an effect parameter only offers itself on a clip that
   * actually carries that effect. Re-registering the same `prop` replaces it.
   */
  function registerClipProp(spec) {
    if (!spec || !spec.prop) return null;
    const full = Object.assign(propSpec(spec.prop), spec);
    const at = clipProps.findIndex((s) => s.prop === full.prop);
    if (at >= 0) clipProps[at] = full; else clipProps.push(full);
    return full;
  }

  /** The registered properties applicable to one clip, in registration order. */
  function clipPropsFor(clip) {
    return clipProps.filter((s) => !s.when || s.when(clip));
  }

  /**
   * The clip's track for `prop`, created on demand.
   *
   * `clip.keys` is OPTIONAL and stays absent until something is keyed, so a project that
   * uses no keyframes serialises exactly as it did before this existed - and an undo
   * snapshot of it hashes the same too.
   */
  function trackFor(clip, prop, create) {
    if (!clip) return null;
    if (!clip.keys) {
      if (!create) return null;
      clip.keys = {};
    }
    if (!clip.keys[prop]) {
      if (!create) return null;
      clip.keys[prop] = [];
    }
    return clip.keys[prop];
  }

  /** Drop empty tracks, and `keys` itself once it holds none. Keeps saved files clean. */
  function pruneKeys(clip) {
    if (!clip || !clip.keys) return;
    for (const p of Object.keys(clip.keys)) {
      if (!Array.isArray(clip.keys[p]) || !clip.keys[p].length) delete clip.keys[p];
    }
    if (!Object.keys(clip.keys).length) delete clip.keys;
  }

  /**
   * A clip's animated value for `prop` at local time `t`, or `fallback` when unkeyed.
   * This is the one call a consumer needs: it never has to know whether `keys` exists.
   */
  function valueAt(clip, prop, t, fallback) {
    const v = evalTrack(trackFor(clip, prop, false), t);
    return v == null ? fallback : v;
  }

  return {
    // easing
    EASING_PRESETS, NAMED, bezier, ease, cloneEasing,
    // tracks
    evalTrack, sortKeys, addKey, removeKey, moveKey, retimeKey,
    // keyable properties
    PROP_SPECS, propSpec, registerClipProp, clipPropsFor, clipProps,
    trackFor, pruneKeys, valueAt,
  };
})();
