'use strict';
/**
 * Sound design - the SFX library and the Sonify planner.
 *
 * Loaded twice, exactly as `AudioFX` and `Captions` are: as a plain <script> global
 * `SFX` in index.html, and as a CommonJS module by main.js. The tail of the file does
 * both.
 *
 * THE LIBRARY SHIPS EMPTY. Nothing is bundled and nothing is synthesised: the sounds are
 * the user's own, brought in one file at a time, a folder at a time, or straight out of
 * the QuickBin. An entry is a path and a name - nothing is copied, exactly as the
 * QuickBin does it, so a file that has moved comes back `missing` and the row greys out
 * instead of failing when somebody sonifies with it.
 *
 * That is also why every trigger's default sound is EMPTY. A trigger with no sound
 * chosen plans nothing at all - the panel says so, rather than the planner inventing a
 * placement with no file behind it.
 *
 * Two things live here:
 *
 *   1. THE TRIGGERS. What sonifying looks for, and what each finds plays. One entry per
 *      trigger type, with an offset, a gain and a schema, so the panel builds itself out
 *      of `TextUI.control` like every other panel in the app.
 *
 *   2. THE PLANNER. `plan(scene, opts)` is a pure function from a description of the
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
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

  // ------------------------------------------------------------------ the triggers

  /**
   * What Sonify looks for. Adding a trigger is an entry here plus the few lines in the
   * renderer that find its moments - nothing else, because the panel and the planner
   * both build themselves from this table.
   *
   * `sound` is empty in every one of them: the library is the user's, so there is no
   * sensible default to point at until they have imported something.
   */
  const TRIGGERS = {
    graphic: {
      label: 'Graphic appears', sound: '', offset: 0, gainDb: -2,
      hint: 'A sound when a graphic clip begins its entry. A short pop suits it.',
    },
    transition: {
      label: 'Transition', sound: '', offset: -0.06, gainDb: -3,
      hint: 'A sound over each transition - a whoosh. The offset is negative so it leads the picture.',
    },
    click: {
      label: 'Mouse click', sound: '', offset: 0, gainDb: -6,
      hint: 'A sound on every mouse-down in a recording\'s telemetry. Silent without it.',
    },
    counter: {
      label: 'Counting number', sound: '', offset: 0, gainDb: -12,
      hint: 'Ticks while a counting number climbs, capped so a big number is not a machine gun.',
    },
    cut: {
      label: 'Cut into a stat', sound: '', offset: 0, gainDb: -4,
      hint: 'A sound on a hard cut (no transition) into a data graphic - an impact.',
    },
  };
  const TRIGGER_IDS = Object.keys(TRIGGERS);

  /** Per-trigger rows. The sound picker's options come from the imported library. */
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
        // A sound is the path of an imported file, so anything non-empty is kept: the
        // renderer resolves it against the library and says when it cannot, rather than
        // this dropping a user's own file as "unknown".
        sound: src.sound ? String(src.sound) : '',
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

  /** Which triggers are ready to place something: enabled, and pointed at a sound. */
  function armed(opts) {
    const o = normalizeOpts(opts);
    return TRIGGER_IDS.filter((k) => o.triggers[k].enabled && o.triggers[k].sound);
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
   * A trigger with no sound chosen plans NOTHING. The library ships empty, so this is
   * the normal state of a fresh project and it must be quiet rather than broken.
   *
   * Two placements of the SAME trigger closer together than `minGap` collapse into one.
   * Four graphics entering on the same frame are one sound, not a flam - and a transition
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
      if (!tr || !tr.enabled || !tr.sound) return;
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
    TRIGGERS, TRIGGER_IDS, TRIGGER_SCHEMA, DEFAULTS,
    defaultOpts, defaultTriggers, normalizeOpts, duckFor, armed,
    plan, counterTicks,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.SFX = API;
})();
