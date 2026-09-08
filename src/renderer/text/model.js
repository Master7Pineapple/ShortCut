'use strict';
/**
 * Text card data model: defaults, easing curves, animation and keyframe evaluation.
 *
 * Pure functions only - no DOM, no canvas. `TextDraw` turns the state this produces into
 * pixels, `TextUI` edits it, and `app.js` stores it on clips of kind 'text'.
 */
const TextModel = (() => {

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

  // ---------------------------------------------------------------- defaults

  function defaultStyle() {
    return {
      fontFamily: 'Segoe UI',
      fontSize: 110,           // px at the project's output height
      letterSpacing: 0,
      lineHeight: 1.15,
      bold: true,
      italic: false,
      underline: false,
      strikethrough: false,
      uppercase: false,
      align: 'center',         // left | center | right
      x: 0.5,                  // 0..1, centre of the text block within the frame
      y: 0.5,
      maxWidth: 0.86,          // wrap width as a fraction of the frame
      rotate: 0,
      opacity: 1,
      fill: {
        type: 'solid',         // solid | gradient
        color: '#ffffff',
        gradient: {
          angle: 90,
          stops: [{ pos: 0, color: '#ffd166' }, { pos: 1, color: '#ef476f' }],
        },
      },
      stroke: { on: false, color: '#000000', width: 6 },
      shadow: { on: true, distance: 8, angle: 135, blur: 18, opacity: 0.65, color: '#000000' },
      // `over` puts the glow ON the glyphs as well as behind them, so it reads as
      // emitted light rather than a coloured drop shadow. 0 = halo only.
      glow: { on: false, color: '#4f8cff', intensity: 3, size: 26, spread: 0.4, over: 0.5 },
      blur: { on: false, amount: 0 },
      bg: { on: false, color: '#000000', opacity: 0.5, padding: 26, radius: 18 },
    };
  }

  /** Per-type parameter defaults for a new animation layer. */
  const ANIM_TYPES = {
    slide: { label: 'Slide', params: { from: 'left', distance: 0.35 } },
    zoom: { label: 'Zoom', params: { amount: 0.5 } },
    fade: { label: 'Fade', params: {} },
    typewriter: {
      label: 'Typewriter',
      // `effect` animates each unit as it appears or leaves; `overlap` is how many units
      // are mid-animation at once (1 = strictly one at a time, higher = softer cascade);
      // `order` is which end the sweep starts from; `scaleFrom` is the pop size.
      params: {
        unit: 'char', effect: 'up', distance: 0.6, overlap: 2,
        order: 'forward', scaleFrom: 0.3,
      },
    },
    flicker: { label: 'Flicker', params: { hz: 9, duty: 0.55, min: 0 } },
  };

  function defaultAnim(type, mode) {
    const t = ANIM_TYPES[type] || ANIM_TYPES.fade;
    return {
      id: 'a' + Math.random().toString(36).slice(2, 9),
      type,
      mode: mode || 'in',              // in | out
      anchor: mode === 'out' ? 'end' : 'start',
      start: 0,                        // offset from the anchor, seconds
      duration: type === 'flicker' ? 1.2 : 0.6,
      easing: cloneEasing(mode === 'out' ? EASING_PRESETS.easeIn : EASING_PRESETS.easeOut),
      motionBlur: { on: false, strength: 0.6, samples: 8 },
      params: JSON.parse(JSON.stringify(t.params)),
    };
  }

  /** Properties that can carry keyframes. `glow` scales the whole glow effect. */
  const KEYABLE = ['opacity', 'x', 'y', 'scale', 'rotate', 'glow'];

  function defaultCard(text) {
    return {
      text: text || 'Your text here',
      style: defaultStyle(),
      animEnabled: true,
      anims: [defaultAnim('fade', 'in'), defaultAnim('slide', 'in')],
      keys: { opacity: [], x: [], y: [], scale: [], rotate: [], glow: [] },
    };
  }

  // -------------------------------------------------------------- evaluation

  /** Window of a single animation layer within a clip of length `dur`, in seconds. */
  function animWindow(a, dur) {
    const d = Math.max(0.001, a.duration);
    const from = a.anchor === 'end' ? dur - d - a.start : a.start;
    return { from, to: from + d, d };
  }

  /**
   * Combine every animation layer at local time `t` into one transform.
   * Layers multiply (opacity, scale) or add (offsets, rotation), so they stack
   * predictably in any order: slide + zoom + fade behaves as you would expect.
   */
  function evalAnims(card, t, dur) {
    const out = {
      opacity: 1, dx: 0, dy: 0, scale: 1, rotate: 0,
      reveal: 1, motionBlur: 0, mbSamples: 8,
    };
    if (!card.animEnabled) return out;

    for (const a of card.anims || []) {
      if (a.disabled) continue;
      const w = animWindow(a, dur);
      const raw = (t - w.from) / w.d;
      // Outside its window an animation holds its end state, not its start state:
      // an "in" layer stays finished, an "out" layer stays un-started.
      const before = raw < 0, after = raw > 1;
      const p = Math.max(0, Math.min(1, raw));
      const e = ease(a.easing, p);
      const active = !before && !after;
      const isIn = a.mode === 'in';
      // Progress toward "fully on screen": 1 = settled, 0 = fully off.
      const on = isIn ? (before ? 0 : after ? 1 : e) : (before ? 1 : after ? 0 : 1 - e);

      switch (a.type) {
        case 'fade':
          out.opacity *= on;
          break;
        case 'slide': {
          const dist = a.params.distance == null ? 0.35 : a.params.distance;
          const off = (1 - on) * dist;
          if (a.params.from === 'left') out.dx -= off;
          else if (a.params.from === 'right') out.dx += off;
          else if (a.params.from === 'up') out.dy -= off;
          else out.dy += off;
          break;
        }
        case 'zoom': {
          const amt = a.params.amount == null ? 0.5 : a.params.amount;
          // amount > 0 grows into place, < 0 shrinks into place.
          out.scale *= 1 + (1 - on) * -amt;
          break;
        }
        case 'typewriter':
          out.reveal = Math.min(out.reveal, isIn ? on : 1 - (1 - on));
          break;
        case 'flicker': {
          if (active || (a.anchor === 'end' ? after : before)) {
            const hz = a.params.hz || 9;
            const duty = a.params.duty == null ? 0.55 : a.params.duty;
            const min = a.params.min || 0;
            const phase = (t * hz) % 1;
            const lit = phase < duty;
            if (active) out.opacity *= lit ? 1 : min;
          }
          break;
        }
      }
      if (a.motionBlur && a.motionBlur.on && active) {
        out.motionBlur = Math.max(out.motionBlur, a.motionBlur.strength || 0);
        out.mbSamples = Math.max(out.mbSamples, a.motionBlur.samples || 8);
      }
    }
    out.opacity = Math.max(0, Math.min(1, out.opacity));
    out.scale = Math.max(0.001, out.scale);
    return out;
  }

  /** Interpolate one keyframe track at time `t`. Returns null when the track is empty. */
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

  /**
   * Full transform for a card at local time `t`.
   * Keyframes compose on top of the animation layers: multiplicative for opacity and
   * scale, additive for position and rotation. A property with no keyframes is untouched.
   */
  function evalCard(card, t, dur) {
    const a = evalAnims(card, t, dur);
    const k = card.keys || {};
    const ko = evalTrack(k.opacity, t);
    const kx = evalTrack(k.x, t);
    const ky = evalTrack(k.y, t);
    const ks = evalTrack(k.scale, t);
    const kr = evalTrack(k.rotate, t);
    const kg = evalTrack(k.glow, t);
    return {
      opacity: a.opacity * (ko == null ? 1 : ko) * (card.style.opacity == null ? 1 : card.style.opacity),
      dx: a.dx + (kx == null ? 0 : kx),
      dy: a.dy + (ky == null ? 0 : ky),
      scale: a.scale * (ks == null ? 1 : ks),
      rotate: a.rotate + (card.style.rotate || 0) + (kr == null ? 0 : kr),
      glow: kg == null ? 1 : Math.max(0, kg),
      reveal: a.reveal,
      motionBlur: a.motionBlur,
      mbSamples: a.mbSamples,
    };
  }

  /** Deep clone helper used by presets, duplication and undo. */
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /** Split a card into the three preset flavours. */
  function extractPreset(kind, card) {
    if (kind === 'style') return { kind: 'style', style: clone(card.style) };
    if (kind === 'anim') {
      return { kind: 'anim', animEnabled: card.animEnabled, anims: clone(card.anims), keys: clone(card.keys) };
    }
    return {
      kind: 'full', text: card.text, style: clone(card.style),
      animEnabled: card.animEnabled, anims: clone(card.anims), keys: clone(card.keys),
    };
  }

  /** Merge a preset into a card in place. Unknown//missing fields keep their values. */
  function applyPreset(card, preset, opts) {
    const p = preset || {};
    if (p.style) card.style = Object.assign(defaultStyle(), clone(p.style));
    if (p.anims) card.anims = clone(p.anims);
    if (p.keys) card.keys = Object.assign({ opacity: [], x: [], y: [], scale: [], rotate: [], glow: [] }, clone(p.keys));
    if (typeof p.animEnabled === 'boolean') card.animEnabled = p.animEnabled;
    if (p.text != null && !(opts && opts.keepText)) card.text = p.text;
    return card;
  }

  return {
    EASING_PRESETS, ANIM_TYPES, KEYABLE, NAMED,
    ease, bezier, cloneEasing,
    defaultStyle, defaultAnim, defaultCard,
    animWindow, evalAnims, evalTrack, evalCard,
    extractPreset, applyPreset, clone,
  };
})();
