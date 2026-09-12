'use strict';
/**
 * Sound design - the SFX library and the Sonify planner.
 *
 * Loaded twice, exactly as `AudioFX` and `Captions` are: as a plain <script> global
 * `SFX` in index.html, and as a CommonJS module by main.js. The tail of the file does
 * both. Main needs the synthesiser (it writes the library to disk); the renderer needs
 * the planner (it turns a timeline into placements).
 *
 * Three things live here:
 *
 *   1. THE LIBRARY. The bundled sounds are SYNTHESISED, not shipped as files - a few
 *      hundred lines of arithmetic instead of a few megabytes of audio in git, and
 *      royalty-free because nobody else wrote them. `wavFor(id)` returns the bytes of a
 *      16-bit mono WAV; main.js materialises them into `userData/sfx` on first use.
 *      Every generator is SEEDED (see `noise()`), for the same reason the film burn's
 *      streaks are: two runs must produce the same file, or the render cache would see a
 *      new sound every launch.
 *
 *   2. THE TRIGGERS. What sonifying looks for, and what each finds plays. One entry per
 *      trigger type, with a default sound, an offset and a gain - and a schema, so the
 *      panel builds itself out of `TextUI.control` like every other panel in the app.
 *
 *   3. THE PLANNER. `plan(scene, opts)` is a pure function from a description of the
 *      timeline to a list of placements. It touches no clip and no DOM, which is what
 *      makes trigger timing testable without a fixture - the renderer's job is only to
 *      build the scene and to turn each placement into a real audio clip.
 *
 * What is deliberately NOT here: the clips themselves. Every placement becomes an
 * ordinary audio clip on an ordinary audio track, so it is movable, trimmable, deletable
 * and rendered by the audio chain that already exists. Nothing about a sonified project
 * is a hidden effect.
 */
(function () {
  const SR = 48000;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

  // ------------------------------------------------------------------ the synthesiser

  /**
   * A seeded noise source. `Math.random()` is banned here for the same reason it is
   * banned in the film burn: the bytes must be identical on every run, or the file
   * written into `userData/sfx` on Tuesday would not be the file the render cache was
   * built against on Monday.
   */
  function noise(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2147483648 - 1;
    };
  }

  /** A one-pole low-pass, as a closure over its own state. `f` is 0..1. */
  function lp() {
    let y = 0;
    return (x, f) => { y += clamp(f, 0.0005, 1) * (x - y); return y; };
  }
  /** A one-pole high-pass built out of the same filter. */
  function hp() {
    const low = lp();
    return (x, f) => x - low(x, f);
  }

  const exp = (x, k) => Math.exp(-k * x);
  /** A raised-cosine bell over 0..1 - what a whoosh's amplitude does. */
  const bell = (u) => 0.5 - 0.5 * Math.cos(2 * Math.PI * clamp(u, 0, 1));
  /** A short attack and a long decay, both in seconds, normalised to peak 1. */
  function ad(t, dur, attack, k) {
    const a = attack > 0 ? Math.min(1, t / attack) : 1;
    return a * exp(Math.max(0, t - attack), k);
  }

  /**
   * Every bundled sound: a name, a category, a length and a generator.
   *
   * A generator fills `buf` at `SR` and may use `rnd` (seeded) and any number of
   * filters. Peak normalisation happens afterwards, in `samplesFor()`, so a generator
   * only has to get the shape right.
   */
  const SOUNDS = {
    pop: {
      name: 'Pop', cat: 'Pops', dur: 0.16,
      hint: 'A soft blip. The default for something appearing on screen.',
      make(buf, rnd) {
        let ph = 0;
        for (let i = 0; i < buf.length; i++) {
          const t = i / SR;
          const f = 880 * exp(t, 14) + 220;          // a downward chirp
          ph += 2 * Math.PI * f / SR;
          buf[i] = Math.sin(ph) * ad(t, 0.16, 0.004, 34) +
                   rnd() * 0.12 * ad(t, 0.16, 0.001, 220);
        }
      },
    },
    click: {
      name: 'Click', cat: 'Clicks', dur: 0.06,
      hint: 'A mouse click. Short enough that one per click never muddies the mix.',
      make(buf, rnd) {
        const high = hp();
        let ph = 0;
        for (let i = 0; i < buf.length; i++) {
          const t = i / SR;
          ph += 2 * Math.PI * 2400 / SR;
          const n = high(rnd(), 0.55);
          buf[i] = (n * 0.8 + Math.sin(ph) * 0.35) * ad(t, 0.06, 0.0008, 150);
        }
      },
    },
    tick: {
      name: 'Tick', cat: 'Clicks', dur: 0.035,
      hint: 'A tiny mechanical tick, for a counting number stepping up.',
      make(buf, rnd) {
        const high = hp();
        for (let i = 0; i < buf.length; i++) {
          const t = i / SR;
          buf[i] = high(rnd(), 0.75) * ad(t, 0.035, 0.0004, 320);
        }
      },
    },
    whoosh: {
      name: 'Whoosh', cat: 'Whooshes', dur: 0.5,
      hint: 'Filtered noise sweeping up and away. The default for a transition.',
      make(buf, rnd) {
        const low = lp(), high = hp();
        for (let i = 0; i < buf.length; i++) {
          const u = i / buf.length;
          // The sweep is what makes it read as movement: the band climbs through the
          // sound and the amplitude is a bell, so it arrives and leaves rather than
          // simply starting and stopping.
          const n = rnd();
          const band = high(low(n, 0.06 + 0.5 * u), 0.03 + 0.25 * u);
          buf[i] = band * bell(u) * 1.6;
        }
      },
    },
    swipe: {
      name: 'Swipe', cat: 'Whooshes', dur: 0.22,
      hint: 'A short whoosh, for a fast cut or a small element flying in.',
      make(buf, rnd) {
        const low = lp(), high = hp();
        for (let i = 0; i < buf.length; i++) {
          const u = i / buf.length;
          const band = high(low(rnd(), 0.1 + 0.6 * u), 0.08 + 0.3 * u);
          buf[i] = band * bell(u) * 1.7;
        }
      },
    },
    riser: {
      name: 'Riser', cat: 'Risers', dur: 1.3,
      hint: 'A build. Put its END on the beat, not its start.',
      make(buf, rnd) {
        const low = lp();
        let ph = 0;
        for (let i = 0; i < buf.length; i++) {
          const u = i / buf.length;
          const f = 180 * Math.pow(11, u);
          ph += 2 * Math.PI * f / SR;
          const n = low(rnd(), 0.1 + 0.4 * u) * (0.3 + 0.7 * u);
          buf[i] = (Math.sin(ph) * 0.5 + n) * Math.pow(u, 1.6);
        }
      },
    },
    impact: {
      name: 'Impact', cat: 'Impacts', dur: 0.6,
      hint: 'A hit with a body. The default for cutting hard into a stat.',
      make(buf, rnd) {
        const low = lp();
        let ph = 0;
        for (let i = 0; i < buf.length; i++) {
          const t = i / SR;
          const f = 150 * exp(t, 9) + 48;
          ph += 2 * Math.PI * f / SR;
          buf[i] = Math.sin(ph) * ad(t, 0.6, 0.002, 6) +
                   low(rnd(), 0.35) * 0.5 * ad(t, 0.6, 0.001, 60);
        }
      },
    },
    sub: {
      name: 'Sub hit', cat: 'Impacts', dur: 0.8,
      hint: 'Bottom end only. Layer it under an impact rather than using it alone.',
      make(buf) {
        let ph = 0;
        for (let i = 0; i < buf.length; i++) {
          const t = i / SR;
          const f = 62 * exp(t, 3) + 34;
          ph += 2 * Math.PI * f / SR;
          buf[i] = Math.sin(ph) * ad(t, 0.8, 0.01, 4.5);
        }
      },
    },
  };

  const IDS = Object.keys(SOUNDS);
  /** A stable seed per sound, so `wavFor('pop')` is the same bytes in every process. */
  const seedOf = (id) => {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  /** One sound as a Float32Array, peak-normalised to 0.9. */
  function samplesFor(id) {
    const d = SOUNDS[id];
    if (!d) return null;
    const buf = new Float32Array(Math.round(d.dur * SR));
    d.make(buf, noise(seedOf(id)));
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    if (peak > 1e-6) {
      const g = 0.9 / peak;
      for (let i = 0; i < buf.length; i++) buf[i] *= g;
    }
    // A hard edge at either end is a click of its own. 2 ms is inaudible and enough.
    const fade = Math.min(Math.round(0.002 * SR), Math.floor(buf.length / 2));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      buf[i] *= g;
      buf[buf.length - 1 - i] *= g;
    }
    return buf;
  }

  /** A 16-bit mono WAV of one sound, as bytes. */
  function wavFor(id) {
    const s = samplesFor(id);
    if (!s) return null;
    const bytes = new Uint8Array(44 + s.length * 2);
    const v = new DataView(bytes.buffer);
    const tag = (off, str) => { for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + s.length * 2, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, s.length * 2, true);
    for (let i = 0; i < s.length; i++) {
      const x = clamp(s[i], -1, 1);
      v.setInt16(44 + i * 2, Math.round(x * 32767), true);
    }
    return bytes;
  }

  /** The bundled library as metadata - what the panel lists and the planner resolves. */
  function catalogue() {
    return IDS.map((id) => ({
      id, name: SOUNDS[id].name, cat: SOUNDS[id].cat,
      hint: SOUNDS[id].hint, duration: r3(SOUNDS[id].dur), builtin: true,
    }));
  }

  // ------------------------------------------------------------------ the triggers

  /**
   * What Sonify looks for. Adding a trigger is an entry here plus the few lines in the
   * renderer that find its moments - nothing else, because the panel and the planner
   * both build themselves from this table.
   */
  const TRIGGERS = {
    graphic: {
      label: 'Graphic appears', sound: 'pop', offset: 0, gainDb: -2,
      hint: 'A pop when a graphic clip begins its entry.',
    },
    transition: {
      label: 'Transition', sound: 'whoosh', offset: -0.06, gainDb: -3,
      hint: 'A whoosh over each transition. The offset is negative so the sound leads the picture.',
    },
    click: {
      label: 'Mouse click', sound: 'click', offset: 0, gainDb: -6,
      hint: 'A click on every mouse-down in a recording\'s telemetry. Silent without it.',
    },
    counter: {
      label: 'Counting number', sound: 'tick', offset: 0, gainDb: -12,
      hint: 'Ticks while a counting number climbs, capped so a big number is not a machine gun.',
    },
    cut: {
      label: 'Cut into a stat', sound: 'impact', offset: 0, gainDb: -4,
      hint: 'An impact on a hard cut (no transition) into a data graphic.',
    },
  };
  const TRIGGER_IDS = Object.keys(TRIGGERS);

  /** Per-trigger rows. The sound picker's options are filled in by the panel. */
  const TRIGGER_SCHEMA = [
    { path: 'offset', label: 'Offset', type: 'range', min: -0.5, max: 0.5, step: 0.01, unit: 's', digits: 2 },
    { path: 'gainDb', label: 'Gain', type: 'range', min: -24, max: 12, step: 0.5, unit: 'dB', digits: 1 },
  ];

  const DEFAULTS = {
    /** Applied on top of every trigger's own gain - one knob for "all of it, quieter". */
    level: -4,
    /** Two placements of the same trigger closer than this collapse into one. */
    minGap: 0.06,
    /** The most ticks one counting number may get, however many steps it counts. */
    maxTicks: 12,
    /** Ducking is off until a voice track is named - see `duckFor()`. */
    duck: { enabled: false, voiceTrack: '', thresholdDb: -28, ratio: 6, attack: 15, release: 260 },
    triggers: null,   // filled in by defaultOpts()
  };

  function defaultTriggers() {
    const out = {};
    for (const k of TRIGGER_IDS) {
      out[k] = { enabled: true, sound: TRIGGERS[k].sound, offset: TRIGGERS[k].offset, gainDb: TRIGGERS[k].gainDb };
    }
    return out;
  }

  function defaultOpts() {
    return Object.assign({}, DEFAULTS, {
      duck: Object.assign({}, DEFAULTS.duck),
      triggers: defaultTriggers(),
    });
  }

  /**
   * Fill in settings a project saved before they existed and drop what this build does
   * not know - the same job `Trans.normalize()` and `AudioFX.normalize()` do.
   *
   * A trigger pointing at a sound this build has never heard of falls back to its own
   * default rather than planning a placement with no file behind it.
   */
  function normalizeOpts(o) {
    const d = defaultOpts();
    const out = Object.assign(d, o && typeof o === 'object' ? o : {});
    out.level = clamp(out.level, -36, 12);
    out.minGap = clamp(out.minGap, 0, 1);
    out.maxTicks = Math.round(clamp(out.maxTicks, 1, 60));
    out.duck = Object.assign({}, DEFAULTS.duck, out.duck || {});
    out.duck.enabled = !!out.duck.enabled;
    out.duck.voiceTrack = String(out.duck.voiceTrack || '');
    const tr = {};
    for (const k of TRIGGER_IDS) {
      const src = (out.triggers || {})[k] || {};
      tr[k] = {
        enabled: src.enabled !== false,
        // A sound is either a bundled id or the path of an imported file, so anything
        // non-empty is kept: the renderer resolves it against the library and says so
        // when it cannot, rather than this dropping a user's own file as "unknown".
        sound: src.sound ? String(src.sound) : TRIGGERS[k].sound,
        offset: clamp(src.offset == null ? TRIGGERS[k].offset : src.offset, -0.5, 0.5),
        gainDb: clamp(src.gainDb == null ? TRIGGERS[k].gainDb : src.gainDb, -36, 24),
      };
    }
    out.triggers = tr;
    return out;
  }

  /** The ducking effect a placed clip should carry, or null when nothing is ducking. */
  function duckFor(opts) {
    const o = normalizeOpts(opts);
    if (!o.duck.enabled || !o.duck.voiceTrack) return null;
    return {
      voiceTrack: o.duck.voiceTrack,
      thresholdDb: o.duck.thresholdDb,
      ratio: o.duck.ratio,
      attack: o.duck.attack,
      release: o.duck.release,
    };
  }

  // ------------------------------------------------------------------ the planner

  /**
   * How many ticks a counting number gets, and when.
   *
   * A number counting to 1240 does not get 1240 ticks - the cap is what keeps this a
   * sound design decision rather than a denial of service. The ticks are spread over the
   * ENTRY, because that is the window the number is actually moving in; a counter whose
   * entry is instant gets one tick, which `minGap` then leaves alone.
   */
  function counterTicks(n, o) {
    const dur = Math.max(0, Number(n.inDur) || 0);
    const dec = Math.max(0, Math.min(4, Math.round(Number(n.decimals) || 0)));
    const steps = Math.abs(Math.round((Number(n.to) || 0) * Math.pow(10, dec)) -
                           Math.round((Number(n.from) || 0) * Math.pow(10, dec)));
    const count = Math.max(1, Math.min(o.maxTicks, steps || 1));
    const out = [];
    for (let i = 0; i < count; i++) out.push(n.t + (dur * (i + 1)) / count);
    return out;
  }

  /**
   * Turn a description of the timeline into a list of placements.
   *
   * A scene is five arrays of moments, all in TIMELINE seconds - the renderer builds it,
   * because only the renderer knows how a clip's `in` point maps telemetry into timeline
   * time. Each moment carries the id of whatever caused it, which becomes the placement's
   * `key`: that is what a later read of the timeline can point at to say "this pop is
   * that graphic's".
   *
   * Two placements of the SAME trigger closer together than `minGap` collapse into one.
   * Four graphics entering on the same frame are one pop, not a flam - and a transition
   * whose whoosh would land on top of the last one keeps the first.
   *
   * A placement whose offset pushes it before zero is not dropped: `start` clamps to 0
   * and `trim` says how much of the sound's head to cut, so the body of it still lands
   * where it was meant to.
   */
  function plan(scene, opts) {
    const o = normalizeOpts(opts);
    const s = scene || {};
    const raw = [];
    const add = (trigger, t, key, label) => {
      const tr = o.triggers[trigger];
      if (!tr || !tr.enabled) return;
      if (!isFinite(t)) return;
      const at = t + tr.offset;
      raw.push({
        trigger, key: trigger + ':' + key,
        start: r3(Math.max(0, at)),
        trim: r3(Math.max(0, -at)),
        sound: tr.sound,
        gainDb: r3(tr.gainDb + o.level),
        label: label || TRIGGERS[trigger].label,
      });
    };

    for (const g of s.graphics || []) add('graphic', g.t, g.id, g.label);
    for (const t of s.transitions || []) add('transition', t.t, t.id, t.label);
    for (const c of s.clicks || []) add('click', c.t, c.id, c.label);
    for (const n of s.counters || []) {
      const ticks = counterTicks(n, o);
      for (let i = 0; i < ticks.length; i++) add('counter', ticks[i], n.id + '#' + i, n.label);
    }
    for (const c of s.cuts || []) add('cut', c.t, c.id, c.label);

    // Stable: by time, then by the order the trigger types are declared in, then by key.
    raw.sort((a, b) => (a.start - b.start) ||
      (TRIGGER_IDS.indexOf(a.trigger) - TRIGGER_IDS.indexOf(b.trigger)) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const last = {};
    const out = [];
    for (const p of raw) {
      const prev = last[p.trigger];
      if (prev != null && p.start - prev < o.minGap - 1e-9) continue;
      last[p.trigger] = p.start;
      out.push(p);
    }
    return out;
  }

  const API = {
    SR, SOUNDS, IDS, TRIGGERS, TRIGGER_IDS, TRIGGER_SCHEMA, DEFAULTS,
    samplesFor, wavFor, catalogue, seedOf,
    defaultOpts, defaultTriggers, normalizeOpts, duckFor,
    plan, counterTicks,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.SFX = API;
})();
