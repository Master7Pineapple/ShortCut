'use strict';
/**
 * Delivery - what leaves the app: formats, hook variants, cover frames and the lint.
 *
 * Loaded twice, exactly as `AudioFX`, `Captions` and `SFX` are: as a plain <script>
 * global `Delivery` in index.html, and as a CommonJS module by anything in main that
 * wants the same table. The tail of the file does both.
 *
 * Everything here is a PURE function over plain data. Not one line of it touches a clip,
 * the DOM, ffmpeg or the render cache - the renderer builds a description, this decides
 * what it means, and the renderer turns the answer back into edits and renders. That is
 * the same split `SFX.plan()` keeps, and it is what makes "does the lint fire on a flat
 * timeline" a test with no fixture, no decode and no window.
 *
 * The four things it knows:
 *
 *   1. THE FORMATS. 9:16, 1:1 and 16:9, each with its own safe zone. A format is a size
 *      and an aspect; it is deliberately NOT a render setting, because a project has one
 *      master format and the others are derived from it.
 *
 *   2. PER-FORMAT FRAMING. A 16:9 source framed for a 9:16 short is framed wrongly for a
 *      1:1 one, and there is no arithmetic that fixes that - it is a judgement about what
 *      matters in the picture. So a clip may carry `clip.frames[fmt]`, an override of
 *      pan/zoom/fit for that format alone. ABSENT means "use the clip's own framing",
 *      which is what keeps a project that never opens the format picker byte-identical to
 *      one saved before this existed.
 *
 *   3. THE HOOK. The first N seconds, held in 2-3 alternative versions so they can be
 *      tested against each other. The load-bearing property is that everything AFTER the
 *      hook is shared: the tail is one range, the same range in every variant, so it
 *      hashes to one render-cache key and is encoded once however many variants ship.
 *      `tailRange()` and `hookRange()` are the only two places that boundary is
 *      expressed, and `crossers()` names the clips that break the promise.
 *
 *   4. THE LINT. Walk the change events and warn wherever nothing happens for too long.
 *      That is the pattern-interrupt rule the whole format runs on, and it is the one
 *      quality check in the app that measures the EDIT rather than the picture.
 */
(function () {
  const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

  // ------------------------------------------------------------------ the formats

  /**
   * The three shapes a short ships in.
   *
   * `id` is what a framing override is keyed by, so it is a stable string and never an
   * index - reordering this table must not silently re-point every override in every
   * saved project at a different format.
   *
   * The safe zone is in FRACTIONS of the frame, inset from each edge, and it describes
   * the platform furniture rather than a broadcast title-safe convention: on 9:16 the
   * bottom fifth is caption, handle, description and the button rail, and the top tenth
   * is the status bar and the follow button. Square and landscape carry the ordinary
   * 5-6% action-safe margin, because nothing is drawn over them.
   */
  const FORMATS = [
    {
      id: '9x16', label: '9:16 Vertical', short: '9:16', w: 1080, h: 1920,
      safe: { top: 0.10, bottom: 0.20, left: 0.06, right: 0.06 },
      note: 'Reels, Shorts, TikTok. The bottom fifth is the caption and button rail.',
    },
    {
      id: '1x1', label: '1:1 Square', short: '1:1', w: 1080, h: 1080,
      safe: { top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 },
      note: 'The feed. Nothing is drawn over it, so this is plain action-safe.',
    },
    {
      id: '16x9', label: '16:9 Landscape', short: '16:9', w: 1920, h: 1080,
      safe: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
      note: 'YouTube and embeds. Plain action-safe.',
    },
  ];
  const FORMAT_IDS = FORMATS.map((f) => f.id);
  const formatById = (id) => FORMATS.find((f) => f.id === id) || null;

  /**
   * Which format a project's own output size IS, or null for a custom one.
   *
   * Matched on ASPECT rather than on the exact pixel size, so a project rendering
   * 720x1280 is still a 9:16 project and still gets the 9:16 safe zone. The tolerance is
   * a hundredth, which separates 9:16 (0.5625) from 1:1 and 16:9 without any of the three
   * ever being ambiguous.
   */
  function formatOf(w, h) {
    if (!(w > 0 && h > 0)) return null;
    const a = w / h;
    let best = null, bestD = 0.01;
    for (const f of FORMATS) {
      const d = Math.abs(f.w / f.h - a);
      if (d < bestD) { best = f; bestD = d; }
    }
    return best;
  }

  /** The safe zone of a format, as a rect in PIXELS of a W x H frame. */
  function safeRect(fmtId, W, H) {
    const f = formatById(fmtId);
    const s = f ? f.safe : { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 };
    return {
      x: W * s.left, y: H * s.top,
      w: W * (1 - s.left - s.right), h: H * (1 - s.top - s.bottom),
    };
  }

  // --------------------------------------------------- per-format framing overrides

  /** The framing properties an override may carry. Exactly what `drawClipTo()` reads. */
  const FRAME_KEYS = ['panX', 'panY', 'zoom', 'fit'];

  /** A clip's own framing, as the base every override is measured against. */
  function baseFraming(c) {
    const out = {
      panX: c && c.panX == null ? 0.5 : c.panX,
      panY: c && c.panY == null ? 0.5 : c.panY,
      zoom: c && c.zoom == null ? 1 : c.zoom,
    };
    // Set only when it means something. An explicit `fit: undefined` would serialise away
    // anyway, but it would also read back as "this clip has a fit" to anything counting
    // keys, and the render key is hashed from exactly this shape.
    if (c && c.fit === 'contain') out.fit = 'contain';
    return out;
  }

  /**
   * How this clip is framed IN this format.
   *
   * The base framing when there is no override, which is the answer for every clip in
   * every project that has never opened the format picker - and the reason a project
   * exported at its master format renders exactly what it always did.
   */
  function framingFor(c, fmtId) {
    const base = baseFraming(c);
    const ov = c && c.frames && c.frames[fmtId];
    if (!ov) return base;
    const out = Object.assign({}, base);
    for (const k of FRAME_KEYS) if (ov[k] !== undefined) out[k] = ov[k];
    if (out.fit !== 'contain') delete out.fit;
    return out;
  }

  function hasOverride(c, fmtId) {
    return !!(c && c.frames && c.frames[fmtId]);
  }

  /** Every format this clip is framed differently in. Empty for almost every clip. */
  function overriddenFormats(c) {
    if (!c || !c.frames) return [];
    return FORMAT_IDS.filter((id) => !!c.frames[id]);
  }

  /**
   * Write an override. Mutates the clip, so the caller owns `pushUndo()` - the same
   * contract `Trans.normalize()` and `FX.normalizeClip()` keep.
   */
  function setOverride(c, fmtId, framing) {
    if (!c || !formatById(fmtId)) return;
    if (!c.frames) c.frames = {};
    const ov = c.frames[fmtId] || {};
    for (const k of FRAME_KEYS) if (framing[k] !== undefined) ov[k] = framing[k];
    if (ov.fit !== 'contain') delete ov.fit;
    c.frames[fmtId] = ov;
  }

  function clearOverride(c, fmtId) {
    if (!c || !c.frames) return;
    delete c.frames[fmtId];
    if (!Object.keys(c.frames).length) delete c.frames;
  }

  /**
   * Drop an override this build cannot mean, and prune the container away when it holds
   * nothing - the rule `Speed.prune()` keeps, and for the same reason: an empty `frames`
   * object on every clip would change the render key of every project that ever opened
   * the panel, for no change in a single pixel.
   */
  function normalizeClip(c) {
    if (!c || !c.frames || typeof c.frames !== 'object') { if (c) delete c.frames; return c; }
    for (const id of Object.keys(c.frames)) {
      const ov = c.frames[id];
      if (!formatById(id) || !ov || typeof ov !== 'object') { delete c.frames[id]; continue; }
      for (const k of Object.keys(ov)) {
        if (!FRAME_KEYS.includes(k)) { delete ov[k]; continue; }
        if (k === 'fit') { if (ov.fit !== 'contain') delete ov.fit; continue; }
        ov[k] = k === 'zoom' ? clamp(ov[k], 0.01, 16) : clamp(ov[k], 0, 1);
      }
      if (!Object.keys(ov).length) delete c.frames[id];
    }
    if (!Object.keys(c.frames).length) delete c.frames;
    return c;
  }

  /** The digest of a clip's overrides for one format - what a multi-format render keys by. */
  function framingDigest(c, fmtId) {
    const f = framingFor(c, fmtId);
    return { panX: r3(f.panX), panY: r3(f.panY), zoom: r3(f.zoom), fit: f.fit || null };
  }

  // ------------------------------------------------------------------ the hook

  const HOOK_DEFAULTS = { len: 3, active: 0, enabled: false };
  const MAX_VARIANTS = 3;

  function defaultHooks() {
    return Object.assign({}, HOOK_DEFAULTS, { variants: [] });
  }

  function normalizeHooks(h) {
    const o = Object.assign(defaultHooks(), h || {});
    o.len = clamp(o.len, 0.5, 30);
    o.enabled = !!o.enabled;
    o.variants = Array.isArray(o.variants) ? o.variants.slice(0, MAX_VARIANTS) : [];
    o.variants = o.variants.map((v, i) => ({
      id: typeof v.id === 'string' && v.id ? v.id : 'hk' + i,
      name: typeof v.name === 'string' && v.name ? v.name : variantName(i),
      tracks: v && typeof v.tracks === 'object' && v.tracks ? v.tracks : {},
    }));
    o.active = o.variants.length ? Math.round(clamp(o.active, 0, o.variants.length - 1)) : 0;
    return o;
  }

  const variantName = (i) => 'Hook ' + String.fromCharCode(65 + i);

  /** The hook's own range, in timeline seconds. */
  function hookRange(hooks) {
    const len = Math.max(0, (hooks && hooks.len) || 0);
    return { from: 0, to: len };
  }

  /**
   * Everything after the hook - the shared half.
   *
   * This is THE range that must be identical across variants, and the only reason the
   * feature is cheap: build a job for it under variant A and under variant B, hash both,
   * and the two keys are the same string, so the second export copies a file the first
   * one encoded. `smoke-delivery.js` asserts exactly that, because it is a promise about
   * the cache rather than about the picture, and nothing on screen would ever show it
   * being broken.
   */
  function tailRange(hooks, duration) {
    const len = Math.max(0, (hooks && hooks.len) || 0);
    return { from: Math.min(len, duration), to: Math.max(0, duration) };
  }

  /**
   * The clips that straddle the hook boundary, by id.
   *
   * A clip starting inside the hook and ending outside it belongs to both halves, so the
   * tail's job is no longer the same under every variant and the shared encode is lost.
   * It still RENDERS correctly - the tail job crops the clip at the boundary like any
   * other ranged render - it is only the saving that goes. So this is a warning the panel
   * shows rather than a refusal, and the export says which clips cost it.
   *
   * `scene` is `[{ id, name, start, end }]` - the renderer's summary of the timeline.
   */
  function crossers(scene, len) {
    const out = [];
    for (const c of (scene || [])) {
      if (c.start < len - 1e-6 && c.end > len + 1e-6) out.push(c);
    }
    return out;
  }

  // ------------------------------------------------------------------ the lint

  const LINT_DEFAULTS = { maxGap: 3, enabled: true };

  /**
   * What counts as something happening. The label is what the row says, so it is written
   * as the thing that occurred rather than as the name of a feature.
   */
  const EVENT_KINDS = {
    cut: 'a cut',
    transition: 'a transition',
    zoom: 'a zoom',
    graphic: 'a graphic',
    caption: 'a caption',
    sfx: 'a sound',
  };

  /**
   * Find every stretch where nothing changes.
   *
   * `events` is `[{ t, kind }]` in any order; `opts` carries `maxGap`, and the range. The
   * answer is one entry per flat stretch: where it starts, where it ends, how long it is,
   * and what the last thing to happen was.
   *
   * THE TWO SENTINELS MATTER. A gap is measured between consecutive events, so a short
   * that opens with eight silent seconds before its first cut has no interval to measure
   * unless the range's start counts as an event - and one that ends with six flat seconds
   * has none unless its end does. Both are the commonest real cases: the top of a short
   * is where retention is lost, and the tail is where an edit runs out of energy. So the
   * walk runs from `from` to `to` and both ends are included.
   *
   * Events at the same instant collapse: a cut, a whoosh and a caption at one timecode is
   * one thing happening, not three.
   */
  function lint(events, opts) {
    const o = Object.assign({}, LINT_DEFAULTS, opts || {});
    const from = Math.max(0, Number(o.from) || 0);
    const to = Number(o.to) || 0;
    const maxGap = Math.max(0.25, Number(o.maxGap) || LINT_DEFAULTS.maxGap);
    if (!(to > from)) return [];

    const marks = new Map();          // t -> the kinds that happened there
    const put = (t, kind) => {
      const k = r3(t);
      if (k < from - 1e-6 || k > to + 1e-6) return;
      if (!marks.has(k)) marks.set(k, []);
      if (kind) marks.get(k).push(kind);
    };
    for (const e of (events || [])) if (e && Number.isFinite(e.t)) put(e.t, e.kind || 'cut');
    put(from, null);                  // the sentinels - see above
    put(to, null);

    const times = [...marks.keys()].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < times.length - 1; i++) {
      const a = times[i], b = times[i + 1];
      const gap = b - a;
      if (gap <= maxGap + 1e-9) continue;
      const kinds = marks.get(a);
      out.push({
        from: r3(a), to: r3(b), gap: r3(gap),
        after: kinds && kinds.length
          ? (EVENT_KINDS[kinds[0]] || kinds[0])
          : (a <= from + 1e-6 ? 'the start' : 'the last thing'),
      });
    }
    return out;
  }

  /** One line summarising a lint result, for the panel's status row. */
  function lintSummary(flat, duration) {
    if (!flat.length) return duration > 0 ? 'Nothing flat - every stretch changes.' : 'Nothing on the timeline.';
    const worst = flat.reduce((m, f) => (f.gap > m.gap ? f : m), flat[0]);
    return flat.length + ' flat stretch' + (flat.length === 1 ? '' : 'es') +
      ', the longest ' + worst.gap.toFixed(1) + 's.';
  }

  // ------------------------------------------------------------------ the cover

  /**
   * What a cover PNG is called for one format. Kept here rather than at the call site so
   * a cover and the video it belongs to are named by the same rule.
   */
  function outputName(base, fmt, ext, variant) {
    const v = variant ? '_' + String(variant).replace(/[^\w-]+/g, '') : '';
    return base + v + '_' + fmt.w + 'x' + fmt.h + '.' + ext;
  }

  const API = {
    FORMATS, FORMAT_IDS, FRAME_KEYS, HOOK_DEFAULTS, LINT_DEFAULTS, EVENT_KINDS, MAX_VARIANTS,
    formatById, formatOf, safeRect,
    baseFraming, framingFor, hasOverride, overriddenFormats,
    setOverride, clearOverride, normalizeClip, framingDigest,
    defaultHooks, normalizeHooks, variantName, hookRange, tailRange, crossers,
    lint, lintSummary, outputName,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.Delivery = API;
})();
