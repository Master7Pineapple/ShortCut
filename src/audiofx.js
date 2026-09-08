'use strict';
/**
 * The audio processing chain - shared by the renderer (inspector UI, preview mix) and
 * the main process (ffmpeg filter strings), so the two can never disagree about what an
 * effect means.
 *
 * Loaded twice: as a plain <script> global `AudioFX` in index.html (like TextModel and
 * Trans), and as a CommonJS module by main.js. The tail of this file does both.
 *
 * A clip's chain lives on `clip.afx` - an ordered array of
 *   { id, type, enabled, params: {...} }
 * and nothing else. It is plain JSON, because undo is JSON.stringify of the track list
 * and the same shape is the .scut file.
 *
 * `duck` is the odd one out: every other type is one input to one output and slots
 * straight into the clip's own filter chain, while ducking needs a SECOND input (the
 * voice bus) and so is wired up by buildArgs() after every clip chain exists. chain()
 * skips it deliberately - see duckOf().
 */
(function () {
  // 3 decimals, trailing zeros trimmed - the same rounding r3() uses in main.js, so the
  // strings this builds and the ones buildArgs() builds around them look alike.
  function n3(x) {
    return String(Math.round((Number(x) || 0) * 1000) / 1000);
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

  /** dB -> linear amplitude. */
  function linFromDb(db) { return Math.pow(10, (Number(db) || 0) / 20); }

  function band(f, q, g) {
    return 'equalizer=f=' + n3(clamp(f, 10, 22000)) + ':t=q:w=' + n3(clamp(q, 0.05, 10)) +
      ':g=' + n3(clamp(g, -40, 40));
  }

  /**
   * Every effect type: its label, its defaults, the inspector schema, and the ffmpeg
   * filter it becomes. Adding a type is one entry here and nothing else.
   *
   * `filter(p)` returns an ARRAY of filter strings - an EQ is three `equalizer` filters -
   * or [] for a type that is wired up elsewhere.
   */
  const DEFS = {
    denoise: {
      label: 'Noise reduction',
      params: { nr: 12, nf: -25 },
      schema: [
        { path: 'params.nr', label: 'Reduction', type: 'range', min: 0.01, max: 97, step: 0.5, unit: 'dB', digits: 1 },
        { path: 'params.nf', label: 'Noise floor', type: 'range', min: -80, max: -20, step: 1, unit: 'dB', digits: 0 },
      ],
      filter: (p) => ['afftdn=nr=' + n3(clamp(p.nr, 0.01, 97)) + ':nf=' + n3(clamp(p.nf, -80, -20))],
    },

    eq: {
      label: 'EQ (3 band)',
      params: {
        lowF: 120, lowG: 0, lowQ: 0.7,
        midF: 1000, midG: 0, midQ: 1,
        highF: 8000, highG: 0, highQ: 0.7,
      },
      schema: [
        { path: 'params.lowF', label: 'Low freq', type: 'range', min: 20, max: 500, step: 1, unit: 'Hz', digits: 0 },
        { path: 'params.lowG', label: 'Low gain', type: 'range', min: -24, max: 24, step: 0.5, unit: 'dB', digits: 1 },
        { path: 'params.lowQ', label: 'Low Q', type: 'range', min: 0.1, max: 4, step: 0.05, digits: 2 },
        { path: 'params.midF', label: 'Mid freq', type: 'range', min: 200, max: 6000, step: 10, unit: 'Hz', digits: 0 },
        { path: 'params.midG', label: 'Mid gain', type: 'range', min: -24, max: 24, step: 0.5, unit: 'dB', digits: 1 },
        { path: 'params.midQ', label: 'Mid Q', type: 'range', min: 0.1, max: 4, step: 0.05, digits: 2 },
        { path: 'params.highF', label: 'High freq', type: 'range', min: 2000, max: 18000, step: 50, unit: 'Hz', digits: 0 },
        { path: 'params.highG', label: 'High gain', type: 'range', min: -24, max: 24, step: 0.5, unit: 'dB', digits: 1 },
        { path: 'params.highQ', label: 'High Q', type: 'range', min: 0.1, max: 4, step: 0.05, digits: 2 },
      ],
      // All three bands are always emitted, gain 0 or not: the filter string is then a
      // pure function of the parameters, which is what makes the render cache key and the
      // smoke assertions stable.
      filter: (p) => [
        band(p.lowF, p.lowQ, p.lowG),
        band(p.midF, p.midQ, p.midG),
        band(p.highF, p.highQ, p.highG),
      ],
    },

    deesser: {
      label: 'De-esser',
      params: { i: 0.4, m: 0.5, f: 0.5 },
      schema: [
        { path: 'params.i', label: 'Intensity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.m', label: 'Max reduction', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.f', label: 'Frequency', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      ],
      filter: (p) => ['deesser=i=' + n3(clamp(p.i, 0, 1)) +
        ':m=' + n3(clamp(p.m, 0, 1)) + ':f=' + n3(clamp(p.f, 0, 1))],
    },

    compressor: {
      label: 'Compressor',
      params: { thresholdDb: -18, ratio: 3, attack: 20, release: 250, makeupDb: 0 },
      schema: [
        { path: 'params.thresholdDb', label: 'Threshold', type: 'range', min: -60, max: 0, step: 0.5, unit: 'dB', digits: 1 },
        { path: 'params.ratio', label: 'Ratio', type: 'range', min: 1, max: 20, step: 0.1, digits: 1 },
        { path: 'params.attack', label: 'Attack', type: 'range', min: 0.01, max: 500, step: 1, unit: 'ms', digits: 2 },
        { path: 'params.release', label: 'Release', type: 'range', min: 0.01, max: 2000, step: 5, unit: 'ms', digits: 2 },
        { path: 'params.makeupDb', label: 'Makeup', type: 'range', min: 0, max: 24, step: 0.5, unit: 'dB', digits: 1 },
      ],
      // acompressor takes a LINEAR threshold and a linear makeup, but nobody thinks about
      // a compressor in linear amplitude - the UI is in dB and the conversion is here.
      filter: (p) => ['acompressor=threshold=' + n3(clamp(linFromDb(p.thresholdDb), 0.000977, 1)) +
        ':ratio=' + n3(clamp(p.ratio, 1, 20)) +
        ':attack=' + n3(clamp(p.attack, 0.01, 2000)) +
        ':release=' + n3(clamp(p.release, 0.01, 9000)) +
        ':makeup=' + n3(clamp(linFromDb(p.makeupDb), 1, 64))],
    },

    gain: {
      label: 'Gain',
      params: { db: 0 },
      schema: [
        { path: 'params.db', label: 'Gain', type: 'range', min: -30, max: 24, step: 0.5, unit: 'dB', digits: 1 },
      ],
      filter: (p) => ['volume=' + n3(clamp(p.db, -60, 40)) + 'dB'],
    },

    duck: {
      label: 'Duck under voice',
      params: { voiceTrack: '', thresholdDb: -24, ratio: 8, attack: 20, release: 300 },
      schema: [
        { path: 'params.thresholdDb', label: 'Threshold', type: 'range', min: -60, max: 0, step: 0.5, unit: 'dB', digits: 1 },
        { path: 'params.ratio', label: 'Amount', type: 'range', min: 1, max: 20, step: 0.1, digits: 1 },
        { path: 'params.attack', label: 'Attack', type: 'range', min: 0.01, max: 500, step: 1, unit: 'ms', digits: 2 },
        { path: 'params.release', label: 'Release', type: 'range', min: 0.01, max: 2000, step: 5, unit: 'ms', digits: 2 },
      ],
      // Two inputs, so it cannot live in the clip's own chain. buildArgs() wires it.
      filter: () => [],
    },
  };

  /** The two-input filter for a duck effect, given its parameters. */
  function duckFilter(p) {
    p = Object.assign({}, DEFS.duck.params, p || {});
    return 'sidechaincompress=threshold=' + n3(clamp(linFromDb(p.thresholdDb), 0.000977, 1)) +
      ':ratio=' + n3(clamp(p.ratio, 1, 20)) +
      ':attack=' + n3(clamp(p.attack, 0.01, 2000)) +
      ':release=' + n3(clamp(p.release, 0.01, 9000));
  }

  let seq = 0;
  /** A fresh effect of `type`, with every parameter at its default. */
  function create(type) {
    const d = DEFS[type];
    if (!d) return null;
    return {
      id: 'fx' + Date.now().toString(36) + (seq++).toString(36),
      type,
      enabled: true,
      params: JSON.parse(JSON.stringify(d.params)),
    };
  }

  /**
   * Fill in parameters a project saved before they existed, without clobbering anything
   * already set - the same job Trans.normalize() does for transitions.
   */
  function normalize(fx) {
    const d = DEFS[fx && fx.type];
    if (!d) return fx;
    if (!fx.params || typeof fx.params !== 'object') fx.params = {};
    for (const k of Object.keys(d.params)) {
      if (fx.params[k] === undefined) fx.params[k] = d.params[k];
    }
    if (fx.enabled === undefined) fx.enabled = true;
    if (!fx.id) fx.id = create(fx.type).id;
    return fx;
  }

  /** Normalize a clip's whole chain, dropping entries of a type this build knows nothing about. */
  function normalizeClip(clip) {
    if (!clip || !Array.isArray(clip.afx)) return clip;
    clip.afx = clip.afx.filter((f) => f && DEFS[f.type]);
    for (const f of clip.afx) normalize(f);
    return clip;
  }

  const active = (afx) => (Array.isArray(afx) ? afx : []).filter((f) => f && DEFS[f.type] && f.enabled !== false);

  /**
   * The single-input part of a clip's chain, in order, as ffmpeg filter strings.
   *
   * A clip with no effects returns [] - which is what keeps buildArgs() emitting a
   * byte-identical argument list to the one it emitted before any of this existed.
   */
  function chain(afx) {
    const out = [];
    for (const f of active(afx)) {
      const d = DEFS[f.type];
      for (const s of d.filter(Object.assign({}, d.params, f.params || {}))) out.push(s);
    }
    return out;
  }

  /** The clip's ducking effect, if it has an enabled one pointed at a track. */
  function duckOf(clip) {
    return active(clip && clip.afx).find((f) => f.type === 'duck' && f.params && f.params.voiceTrack) || null;
  }

  /**
   * What the PREVIEW can honour: the clip's volume times every gain effect.
   *
   * The preview is deliberately not a DSP engine - it mirrors level and mute so the mix
   * balance is roughly right while editing, and the inspector says so out loud. Everything
   * else (denoise, EQ, de-ess, compression, ducking, loudness) happens on render.
   */
  function previewGain(clip) {
    let g = clamp(clip && clip.volume != null ? clip.volume : 1, 0, 2);
    for (const f of active(clip && clip.afx)) {
      if (f.type === 'gain') g *= linFromDb((f.params || {}).db);
    }
    return clamp(g, 0, 4);
  }

  // -------------------------------------------------------------- loudness

  const LOUD_DEFAULTS = { enabled: false, lufs: -14, tp: -1, lra: 11 };

  /**
   * The loudnorm filter for the final mix.
   *
   * Pass one measures (`print_format=json`, output thrown away); pass two is handed those
   * measurements plus `linear=true`, which makes the result an exact gain move rather than
   * the dynamic single-pass approximation. `measured` absent means single pass, which is
   * what a draft render gets - close enough, and it does not double the decode time.
   */
  function loudnormFilter(loud, measured, printJson) {
    const l = Object.assign({}, LOUD_DEFAULTS, loud || {});
    let s = 'loudnorm=I=' + n3(clamp(l.lufs, -70, -5)) +
      ':TP=' + n3(clamp(l.tp, -9, 0)) +
      ':LRA=' + n3(clamp(l.lra, 1, 50));
    if (measured) {
      s += ':measured_I=' + n3(measured.input_i) +
        ':measured_TP=' + n3(measured.input_tp) +
        ':measured_LRA=' + n3(measured.input_lra) +
        ':measured_thresh=' + n3(measured.input_thresh) +
        ':offset=' + n3(measured.target_offset) +
        ':linear=true';
    }
    if (printJson) s += ':print_format=json';
    return s;
  }

  const API = {
    DEFS, TYPES: Object.keys(DEFS), LOUD_DEFAULTS,
    create, normalize, normalizeClip, chain, duckOf, duckFilter,
    previewGain, loudnormFilter, linFromDb, n3,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.AudioFX = API;
})();
