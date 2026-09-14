'use strict';
/**
 * The graphics engine: primitives, composites, data objects and diagrams.
 *
 * A graphic is a clip of `kind: 'graphic'` whose WHOLE definition lives on the clip, in
 * exactly the way a text card's does:
 *
 *   clip.graphic = { type, params: {...}, keys: {...} }
 *
 * Plain JSON and nothing else, because undo is `JSON.stringify` of the track list and the
 * same shape is the `.scut` file.
 *
 * WHY THIS FILE HAS NO ffmpeg IN IT, AND NO SECOND IMPLEMENTATION
 *
 * Step 6 made the renderer the only thing that draws a picture. So a graphic is ONE
 * function, `DEFS[type].draw()`, and it satisfies the same paint-at-time-t contract
 * `TextDraw` does - `Graphics.draw(ctx, clip, W, H, t, frameDur)` plus
 * `Graphics.animatedBounds()`. The viewer calls it through `compositeLayers()`, and the
 * baker calls it at output resolution and streams the result into `frames.raw`. Adding an
 * ffmpeg half of a graphic would be a bug.
 *
 * THE UNIT RULE, inherited from `fx.js` word for word.
 *
 * Every length is a FRACTION OF THE FRAME'S SHORTER SIDE and every position is a fraction
 * of W and H. Never a pixel count. The preview paints at 540x960 and the export at
 * 1080x1920, so a "24 px" corner radius would be twice as round in the viewer as in the
 * file. `pxMin()` converts at draw time against whatever W/H the caller is painting at.
 * Font sizes go through it too - that is the only reason a chart's labels sit in the same
 * place at both resolutions, which `smoke-graphics.js` asserts numerically.
 *
 * KEYFRAMES ARE FREE. `Anim.trackFor()` / `valueAt()` only ever touch a `.keys` object, so
 * `clip.graphic` is a keyframe holder exactly as an `fx` entry is, and every numeric
 * parameter in `DEFS` is keyframable with no extra work. Keys are seconds into the CLIP.
 *
 * POSITION BINDING IS NOT HERE, ON PURPOSE. A graphic clip is in `FX_KINDS`, so it carries
 * an ordinary effect stack - and a `transform` effect with a `bind` already follows a
 * motion track, across clips, with the offsets, the follow strength and the smoothing that
 * step 11 built and `smoke-track.js` defends. A second binding here would be a second
 * implementation of the one thing this codebase keeps refusing to write twice.
 *
 * ONE RULE FOR CHARTS, and it is the whole of their correctness:
 *
 *   a SINGLE scale places the marks, the ticks and the labels.
 *
 * `Graphics.scale()` is that scale. Nothing in a chart may compute a position from a value
 * any other way, because the moment a label is placed by a second calculation it starts
 * naming a number the bar does not reach. Every tick it hands back is inside [min, max],
 * so every label names a value the chart actually gets to.
 */
const Graphics = (() => {

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, isFinite(Number(v)) ? Number(v) : lo));
  const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d);

  /** A fraction of the frame's shorter side, in pixels at the size being painted. */
  const pxMin = (f, W, H) => (Number(f) || 0) * Math.min(W, H);

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#000000'));
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + clamp(a, 0, 1) + ')';
  }
  /** Mix two hex colours, 0 = a, 1 = b. The multi-series objects ramp across it. */
  function mix(a, b, f) {
    const x = hexToRgb(a), y = hexToRgb(b), t = clamp(f, 0, 1);
    const p = (i) => Math.round(x[i] + (y[i] - x[i]) * t);
    return 'rgb(' + p(0) + ',' + p(1) + ',' + p(2) + ')';
  }

  /** A rounded rectangle as a SUBPATH - it never calls beginPath(), so holes work. */
  function roundRectSub(c, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    if (rr <= 0) { c.rect(x, y, w, h); return; }
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); roundRectSub(c, x, y, w, h, r); }

  // ------------------------------------------------------------------ entry timing
  //
  // Every graphic reveals itself, and the ones made of several marks reveal them one after
  // another. That is ONE calculation, shared, so "the bars come in staggered" and "the ring
  // sweeps on" are the same two numbers rather than two pieces of hand-timed code.

  /** The shared reveal block, merged into every type's params. */
  const REVEAL = { inDur: 0.5, inDelay: 0, stagger: 0.06, ease: 'easeOut' };

  const REVEAL_SCHEMA = [
    { path: 'params.inDelay', label: 'Entry delay', type: 'range', min: 0, max: 5, step: 0.02, unit: 's', digits: 2 },
    { path: 'params.inDur', label: 'Entry length', type: 'range', min: 0, max: 5, step: 0.02, unit: 's', digits: 2 },
    { path: 'params.stagger', label: 'Stagger', type: 'range', min: 0, max: 1, step: 0.01, unit: 's', digits: 2 },
    {
      path: 'params.ease', label: 'Entry easing', type: 'select',
      options: Object.keys(Anim.EASING_PRESETS).map((k) => ({ value: k, label: k })),
    },
  ];

  /**
   * How far into its entry the `i`th mark of a graphic is at time `t`, 0..1.
   *
   * The stagger is a DELAY per mark, not a compression of the whole entry, so every mark
   * travels the same curve over the same length of time and the group simply arrives in
   * order. `inDur` of 0 is a hard cut on - it must not divide by zero, and it must answer
   * 1 rather than 0 at the instant it lands, or the mark would flicker on its own arrival.
   */
  function stagger(p, t, i) {
    const d = Math.max(0, num(p.inDur, REVEAL.inDur));
    const off = num(p.inDelay, 0) + Math.max(0, num(p.stagger, 0)) * Math.max(0, i || 0);
    const raw = d <= 1e-6 ? (t >= off ? 1 : 0) : (t - off) / d;
    const e = Anim.EASING_PRESETS[p.ease] || Anim.EASING_PRESETS.easeOut;
    return Anim.ease(e, clamp(raw, 0, 1));
  }

  // ------------------------------------------------------------------ the chart scale
  //
  // THE one rule: a single scale places marks, ticks and labels.

  /** A "nice" step at or above `raw` - 1, 2, 2.5 or 5 times a power of ten. */
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return m * mag;
  }

  /**
   * The single scale a chart places everything with.
   *
   * Returns `{ min, max, step, ticks, at(v) }`, where `at()` maps a value to 0..1 across
   * the plot. Two promises, both asserted in the suite:
   *
   *   - `at(min)` is 0 and `at(max)` is 1, so a mark cannot fall outside the plot;
   *   - every tick satisfies `min <= tick <= max`, so every LABEL names a value the chart
   *     actually reaches. A tick outside the data is a label pointing at nothing, which is
   *     the commonest way a hand-built chart lies.
   *
   * A flat series (every value the same, zero included) still gets a usable range rather
   * than a zero-height plot - otherwise `at()` would divide by zero and every bar would be
   * drawn at the same nonsense height.
   */
  function scale(values, opts) {
    const o = opts || {};
    const vals = (values || []).map(Number).filter((v) => isFinite(v));
    let lo = vals.length ? Math.min(...vals) : 0;
    let hi = vals.length ? Math.max(...vals) : 1;
    if (o.zero !== false) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi - lo < 1e-9) { hi = lo + (Math.abs(lo) > 1e-9 ? Math.abs(lo) : 1); }

    const want = Math.max(2, Math.min(10, Math.round(num(o.ticks, 4))));
    const step = niceStep((hi - lo) / (want - 1));
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;

    // Built by multiplication from the index rather than by repeated addition: 0.1 added
    // thirty times is not 3, and a tick at 2.9999999999 formats as "3" while sitting a
    // pixel off the gridline it is labelling.
    const ticks = [];
    const n = Math.round((max - min) / step);
    for (let i = 0; i <= n; i++) ticks.push(i === n ? max : min + i * step);

    const span = max - min;
    return {
      min, max, step, ticks,
      at: (v) => clamp((num(v, min) - min) / span, 0, 1),
    };
  }

  /**
   * Format a tick for a label: as many decimals as the STEP needs, and no more.
   *
   * Read off the step's own decimal spelling rather than computed from its logarithm. A
   * step of 0.25 needs two places, and `ceil(-log10(0.25))` is 1 - which rounds every
   * other gridline's label to the same number as its neighbour, so the axis reads
   * "0 0.3 0.5 0.8 1" and two of those labels name values no gridline sits on. The nice
   * steps this scale produces are 1, 2, 2.5 and 5 times a power of ten, and 2.5 is the one
   * that exposes it.
   */
  function decimalsOf(step) {
    const s = String(Math.abs(Number(step) || 0));
    const exp = /e-(\d+)/i.exec(s);
    if (exp) {
      const mantissa = s.split(/e/i)[0].split('.')[1] || '';
      return Math.min(9, Number(exp[1]) + mantissa.length);
    }
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : Math.min(9, s.length - dot - 1);
  }
  function tickLabel(v, step) {
    return Number(v).toFixed(decimalsOf(step));
  }

  // ------------------------------------------------------------------ value parsing
  //
  // Data objects take REAL values, and they arrive as text a person typed. One parser, so
  // "12, 40, 33" and "12 40 33" and a JSON array all mean the same thing, and a typo
  // degrades to "no marks" rather than to NaN geometry.

  function parseValues(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return [];
    if (s[0] === '[') {
      try {
        const a = JSON.parse(s);
        if (Array.isArray(a)) return a.map(Number).filter((v) => isFinite(v));
      } catch (e) { /* not JSON after all - fall through to the separator split */ }
    }
    return s.split(/[\s,;]+/).map(Number).filter((v) => isFinite(v));
  }
  function parseLabels(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return [];
    return s.split(/\s*[,;|]\s*/).filter((x) => x.length);
  }

  // ------------------------------------------------------------------ text
  //
  // Graphics draw their own labels rather than borrowing TextDraw: a card is a rich,
  // animated, preset-carrying object, and a chart's axis label is a string in a font. Size
  // goes through pxMin like every other length, which is what keeps a label in the same
  // place at 540x960 and at 1080x1920.

  function setFont(c, p, sizeFrac, W, H, weight) {
    const px = Math.max(1, pxMin(sizeFrac, W, H));
    c.font = (weight || '600') + ' ' + px.toFixed(2) + 'px "' +
      (p.font || 'Segoe UI') + '", "Segoe UI", sans-serif';
    return px;
  }
  function label(c, text, x, y, align, baseline) {
    c.textAlign = align || 'left';
    c.textBaseline = baseline || 'alphabetic';
    c.fillText(String(text), x, y);
  }

  // ------------------------------------------------------------------ SVG paths
  //
  // An imported icon is stored as PATH DATA plus its viewBox - a string, not the bytes of a
  // file. `clip.graphic` goes into every undo snapshot and into the .scut file, and an
  // inlined image would put a megabyte of base64 into both. Path data also stays sharp at
  // any output resolution, which is why the chrome presets in step 10 are vectors too.

  const pathCache = new Map();
  function path2d(d) {
    const key = String(d || '');
    if (!key) return null;
    if (pathCache.has(key)) return pathCache.get(key);
    let p = null;
    try { p = typeof Path2D === 'function' ? new Path2D(key) : null; } catch (e) { p = null; }
    pathCache.set(key, p);
    return p;
  }

  /**
   * Draw path data scaled into a box of `size`, preserving its aspect.
   *
   * The viewBox is what makes an imported icon resolution-independent: the path's own
   * coordinates mean nothing on their own, and mapping them through the box is the only
   * thing that puts a 24-unit icon and a 512-unit icon at the same size on screen.
   */
  function drawPathData(c, d, vb, x, y, size, mode, strokeW) {
    const p = path2d(d);
    if (!p) return false;
    const v = vb && vb.length === 4 ? vb : [0, 0, 100, 100];
    const s = size / Math.max(1e-6, Math.max(v[2], v[3]));
    c.save();
    c.translate(x - (v[2] * s) / 2, y - (v[3] * s) / 2);
    c.scale(s, s);
    c.translate(-v[0], -v[1]);
    if (mode === 'stroke') { c.lineWidth = strokeW / s; c.stroke(p); } else c.fill(p);
    c.restore();
    return true;
  }
  function parseViewBox(s) {
    const a = String(s || '').trim().split(/[\s,]+/).map(Number);
    return a.length === 4 && a.every((v) => isFinite(v)) ? a : [0, 0, 100, 100];
  }

  /**
   * Pull the drawable path data out of an .svg file's text.
   *
   * Deliberately small: every `<path d="...">` concatenated, plus the viewBox. That covers
   * the icon sets people actually import (Lucide, Feather, Heroicons, Simple Icons), and it
   * fails by returning null rather than by half-drawing something. A full SVG renderer is
   * a different project, and `icon` says so on the frame when it has nothing to draw.
   */
  function svgPaths(text) {
    const s = String(text || '');
    const ds = [];
    const re = /<path\b[^>]*\bd\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = re.exec(s))) ds.push(m[2] != null ? m[2] : m[3]);
    if (!ds.length) return null;
    const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(s);
    return { d: ds.join(' '), viewBox: vb ? vb[1].trim() : '0 0 24 24' };
  }

  // ------------------------------------------------------------------ diagram layout
  //
  // A whole architecture diagram is ONE clip, laid out from a small JSON spec. The layout
  // is deliberately a separate, pure function returning NORMALISED coordinates (0..1 of the
  // object's own box) and nothing else - no canvas, no W, no H. That is what makes
  // "identical across two runs and two resolutions" something you can assert rather than
  // hope for: the layout does not know what a resolution is, so it cannot vary with one.

  function parseSpec(text, fallback) {
    if (text && typeof text === 'object') return text;
    const s = String(text == null ? '' : text).trim();
    if (!s) return fallback;
    try {
      const o = JSON.parse(s);
      return o && typeof o === 'object' ? o : fallback;
    } catch (e) {
      // A spec being edited is invalid JSON most of the time it is being typed. Falling
      // back keeps the object on screen instead of blinking out between keystrokes.
      return fallback;
    }
  }

  const DIAGRAM_FALLBACK = {
    funnel: {
      stages: [
        { label: 'Visitors', value: 1000 },
        { label: 'Signups', value: 320 },
        { label: 'Paid', value: 78 },
      ],
    },
    flow: {
      before: ['Manual export', 'Email the file', 'Paste into the deck'],
      after: ['One click'],
    },
    nodemap: {
      nodes: [
        { id: 'a', label: 'Client' }, { id: 'b', label: 'API' },
        { id: 'c', label: 'Worker' }, { id: 'd', label: 'Store' },
      ],
      edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['b', 'd']],
    },
  };

  /**
   * Lay a diagram spec out into normalised geometry.
   *
   * Deterministic by construction: every position is computed from an INDEX, and nothing
   * anywhere reads a clock, a random number, or an iteration order a Map could reshuffle.
   * Node columns come from an explicit `col`/`row` when the spec gives one, and from a
   * breadth-first walk of the edge ARRAY in written order when it does not - so the same
   * spec lays out the same way every time, which is exactly what the suite asserts.
   */
  function layoutDiagram(type, spec) {
    const s = parseSpec(spec, DIAGRAM_FALLBACK[type] || {});

    if (type === 'funnel') {
      const stages = (s.stages || []).filter((x) => x && isFinite(Number(x.value)));
      const top = stages.length ? Math.max(...stages.map((x) => Number(x.value))) : 1;
      const gap = 0.06;
      const rowH = stages.length ? (1 - gap * (stages.length - 1)) / stages.length : 1;
      return {
        kind: 'funnel',
        rows: stages.map((st, i) => {
          const f = top > 0 ? clamp(Number(st.value) / top, 0, 1) : 0;
          // A stage that is a rounding error of the top one still has to be a shape you can
          // see and put a label on, so the width floors rather than vanishing.
          const w = 0.18 + 0.82 * f;
          return {
            label: String(st.label == null ? '' : st.label),
            value: Number(st.value),
            frac: f,
            x: (1 - w) / 2, y: i * (rowH + gap), w, h: rowH,
          };
        }),
      };
    }

    if (type === 'flow') {
      const col = (list, x) => (list || []).map((v, i, arr) => ({
        label: String(v),
        x,
        y: arr.length ? i * (1 / arr.length) : 0,
        w: 0.4,
        h: arr.length ? Math.min(0.24, 1 / arr.length - 0.04) : 0.24,
      }));
      return {
        kind: 'flow',
        before: col(s.before, 0.02),
        after: col(s.after, 0.58),
        arrow: { x: 0.44, y: 0.5, w: 0.1 },
      };
    }

    // nodemap
    const nodes = (s.nodes || []).filter((n) => n && n.id != null);
    const edges = (s.edges || [])
      .map((e) => (Array.isArray(e) ? { from: e[0], to: e[1] } : e))
      .filter((e) => e && e.from != null && e.to != null);
    const byId = new Map(nodes.map((n) => [String(n.id), n]));

    // Depth: given, or the breadth-first distance from the first node nothing points at
    // (and from the first node outright when everything is pointed at, so a cycle still
    // lays out instead of producing nothing).
    const depth = new Map();
    for (const n of nodes) {
      if (isFinite(Number(n.col))) depth.set(String(n.id), Math.max(0, Math.round(Number(n.col))));
    }
    if (depth.size < nodes.length && nodes.length) {
      const targets = new Set(edges.map((e) => String(e.to)));
      const roots = nodes.filter((n) => !targets.has(String(n.id)));
      const queue = (roots.length ? roots : [nodes[0]]).map((n) => String(n.id));
      for (const id of queue) if (!depth.has(id)) depth.set(id, 0);
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        const d = depth.get(id) || 0;
        for (const e of edges) {
          if (String(e.from) !== id) continue;
          const to = String(e.to);
          if (!byId.has(to) || depth.has(to)) continue;
          depth.set(to, d + 1);
          queue.push(to);
        }
      }
      for (const n of nodes) if (!depth.has(String(n.id))) depth.set(String(n.id), 0);
    }

    const cols = new Map();
    for (const n of nodes) {
      const d = depth.get(String(n.id)) || 0;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(n);
    }
    const colKeys = [...cols.keys()].sort((a, b) => a - b);
    const nw = 0.2, nh = 0.16;
    const placed = [];
    colKeys.forEach((d, ci) => {
      const list = cols.get(d);
      list.forEach((n, ri) => {
        const row = isFinite(Number(n.row)) ? Number(n.row) : ri;
        const cx = colKeys.length > 1 ? (ci / (colKeys.length - 1)) * (1 - nw) + nw / 2 : 0.5;
        const cy = list.length > 1 ? (row / Math.max(1, list.length - 1)) * (1 - nh) + nh / 2 : 0.5;
        placed.push({
          id: String(n.id),
          label: String(n.label == null ? n.id : n.label),
          cx, cy, w: nw, h: nh,
        });
      });
    });
    const pos = new Map(placed.map((n) => [n.id, n]));
    return {
      kind: 'nodemap',
      nodes: placed,
      edges: edges
        .filter((e) => pos.has(String(e.from)) && pos.has(String(e.to)))
        .map((e) => ({
          from: String(e.from), to: String(e.to),
          x1: pos.get(String(e.from)).cx, y1: pos.get(String(e.from)).cy,
          x2: pos.get(String(e.to)).cx, y2: pos.get(String(e.to)).cy,
        })),
    };
  }

  // ------------------------------------------------------------------ shared params

  /** Every type carries these: where it is, how opaque, and what colour its type is. */
  const COMMON = { x: 0.5, y: 0.5, opacity: 1, fill: '#4f8cff', ink: '#ffffff' };
  const COMMON_SCHEMA = [
    { path: 'params.x', label: 'Position X', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
    { path: 'params.y', label: 'Position Y', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
    { path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
  ];

  const def = (o) => ({
    label: o.label,
    group: o.group,
    // Every type that sets type carries a font family, chosen in the panel like any other
    // text in the app. Primitives draw no text, so they do not get one.
    params: Object.assign({}, COMMON, o.group === 'Primitives' ? {} : { font: 'Segoe UI' }, REVEAL, o.params),
    schema: COMMON_SCHEMA.concat(o.schema || [], REVEAL_SCHEMA),
    bounds: o.bounds,
    draw: o.draw,
  });

  /** The rect a `w`/`h` pair describes, in pixels, centred on the position. */
  function box(p, W, H) {
    const w = pxMin(p.w, W, H), h = pxMin(p.h, W, H);
    return { x: p.x * W - w / 2, y: p.y * H - h / 2, w, h };
  }
  /** A bounds rect grown by `pad` frame-fractions. */
  const grow = (b, pad, W, H) => {
    const g = pxMin(pad, W, H);
    return { x: b.x - g, y: b.y - g, w: b.w + 2 * g, h: b.h + 2 * g };
  };

  // ------------------------------------------------------------------ the type table

  const DEFS = {

    // ------------------------------------------------------------- primitives

    rect: def({
      label: 'Rectangle', group: 'Primitives',
      params: { w: 0.4, h: 0.2, radius: 0.02, stroke: '#000000', strokeW: 0, wipe: 'none' },
      schema: [
        { path: 'params.w', label: 'Width', type: 'range', min: 0.01, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.01, max: 2, step: 0.005, digits: 3 },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.3, step: 0.002, digits: 3 },
        { path: 'params.fill', label: 'Fill', type: 'color' },
        { path: 'params.stroke', label: 'Outline', type: 'color' },
        { path: 'params.strokeW', label: 'Outline width', type: 'range', min: 0, max: 0.05, step: 0.001, digits: 3 },
        {
          path: 'params.wipe', label: 'Reveal', type: 'select',
          options: [
            { value: 'none', label: 'Fade in' },
            { value: 'left', label: 'Wipe from the left' },
            { value: 'right', label: 'Wipe from the right' },
            { value: 'up', label: 'Wipe upward' },
            { value: 'down', label: 'Wipe downward' },
            { value: 'grow', label: 'Grow from the centre' },
          ],
        },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), (p.strokeW || 0) / 2 + 0.004, W, H),
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        const b = box(p, W, H);
        c.globalAlpha = p.opacity * (p.wipe === 'none' ? e : 1);
        c.save();
        // A wipe is a CLIP, not a redrawn smaller shape: the corner radius has to stay put
        // while the reveal passes over it, and a shrunken rect would round its moving edge.
        if (p.wipe !== 'none') {
          c.beginPath();
          if (p.wipe === 'left') c.rect(b.x, b.y, b.w * e, b.h);
          else if (p.wipe === 'right') c.rect(b.x + b.w * (1 - e), b.y, b.w * e, b.h);
          else if (p.wipe === 'up') c.rect(b.x, b.y + b.h * (1 - e), b.w, b.h * e);
          else if (p.wipe === 'down') c.rect(b.x, b.y, b.w, b.h * e);
          else c.rect(b.x + b.w * (1 - e) / 2, b.y + b.h * (1 - e) / 2, b.w * e, b.h * e);
          c.clip();
        }
        roundRect(c, b.x, b.y, b.w, b.h, pxMin(p.radius, W, H));
        c.fillStyle = p.fill;
        c.fill();
        if (p.strokeW > 0) {
          c.strokeStyle = p.stroke;
          c.lineWidth = pxMin(p.strokeW, W, H);
          c.stroke();
        }
        c.restore();
      },
    }),

    ellipse: def({
      label: 'Ellipse', group: 'Primitives',
      params: { w: 0.3, h: 0.3, stroke: '#000000', strokeW: 0 },
      schema: [
        { path: 'params.w', label: 'Width', type: 'range', min: 0.01, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.01, max: 2, step: 0.005, digits: 3 },
        { path: 'params.fill', label: 'Fill', type: 'color' },
        { path: 'params.stroke', label: 'Outline', type: 'color' },
        { path: 'params.strokeW', label: 'Outline width', type: 'range', min: 0, max: 0.05, step: 0.001, digits: 3 },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), (p.strokeW || 0) / 2 + 0.004, W, H),
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        const b = box(p, W, H);
        c.globalAlpha = p.opacity * e;
        c.beginPath();
        c.ellipse(b.x + b.w / 2, b.y + b.h / 2,
          Math.max(0.5, b.w / 2), Math.max(0.5, b.h / 2), 0, 0, Math.PI * 2);
        c.fillStyle = p.fill;
        c.fill();
        if (p.strokeW > 0) {
          c.strokeStyle = p.stroke;
          c.lineWidth = pxMin(p.strokeW, W, H);
          c.stroke();
        }
      },
    }),

    line: def({
      label: 'Line', group: 'Primitives',
      params: { x2: 0.8, y2: 0.5, strokeW: 0.008, cap: 'round', dash: 0 },
      schema: [
        { path: 'params.x2', label: 'End X', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.y2', label: 'End Y', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.fill', label: 'Colour', type: 'color' },
        { path: 'params.strokeW', label: 'Thickness', type: 'range', min: 0.001, max: 0.06, step: 0.001, digits: 3 },
        { path: 'params.dash', label: 'Dash', type: 'range', min: 0, max: 0.1, step: 0.002, digits: 3 },
        {
          path: 'params.cap', label: 'Ends', type: 'select',
          options: [
            { value: 'round', label: 'Round' },
            { value: 'butt', label: 'Flat' },
            { value: 'square', label: 'Square' },
          ],
        },
      ],
      bounds(p, W, H) {
        const x1 = p.x * W, y1 = p.y * H, x2 = p.x2 * W, y2 = p.y2 * H;
        return grow(
          { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
          (p.strokeW || 0) / 2 + 0.004, W, H);
      },
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        const x1 = p.x * W, y1 = p.y * H;
        // The line DRAWS ON rather than fading up: a line is a gesture, and a gesture that
        // arrives whole reads as a label instead of as a stroke.
        const x2 = x1 + (p.x2 * W - x1) * e, y2 = y1 + (p.y2 * H - y1) * e;
        c.globalAlpha = p.opacity;
        c.strokeStyle = p.fill;
        c.lineWidth = pxMin(p.strokeW, W, H);
        c.lineCap = p.cap || 'round';
        if (p.dash > 0) c.setLineDash([pxMin(p.dash, W, H), pxMin(p.dash, W, H) * 0.8]);
        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.stroke();
        c.setLineDash([]);
      },
    }),

    arrow: def({
      label: 'Arrow', group: 'Primitives',
      params: { x2: 0.8, y2: 0.5, strokeW: 0.01, head: 0.05, curve: 0 },
      schema: [
        { path: 'params.x2', label: 'Tip X', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.y2', label: 'Tip Y', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.fill', label: 'Colour', type: 'color' },
        { path: 'params.strokeW', label: 'Thickness', type: 'range', min: 0.001, max: 0.06, step: 0.001, digits: 3 },
        { path: 'params.head', label: 'Head size', type: 'range', min: 0.005, max: 0.2, step: 0.002, digits: 3 },
        { path: 'params.curve', label: 'Curve', type: 'range', min: -0.5, max: 0.5, step: 0.01, digits: 2 },
      ],
      bounds(p, W, H) {
        const x1 = p.x * W, y1 = p.y * H, x2 = p.x2 * W, y2 = p.y2 * H;
        const bow = pxMin(Math.abs(p.curve) * 0.5, W, H);
        return grow({
          x: Math.min(x1, x2) - bow, y: Math.min(y1, y2) - bow,
          w: Math.abs(x2 - x1) + 2 * bow, h: Math.abs(y2 - y1) + 2 * bow,
        }, (p.head || 0) + 0.006, W, H);
      },
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        const x1 = p.x * W, y1 = p.y * H, X2 = p.x2 * W, Y2 = p.y2 * H;
        const dx = X2 - x1, dy = Y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        // The control point sits off the midpoint along the perpendicular, so `curve` bows
        // the shaft the same way at every length rather than only at short ones.
        const bow = p.curve * Math.min(W, H) * 0.5;
        const cxp = (x1 + X2) / 2 - (dy / len) * bow;
        const cyp = (y1 + Y2) / 2 + (dx / len) * bow;
        const at = (u) => ({
          x: (1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * cxp + u * u * X2,
          y: (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * cyp + u * u * Y2,
        });
        const head = pxMin(p.head, W, H);
        c.globalAlpha = p.opacity;
        c.strokeStyle = p.fill;
        c.fillStyle = p.fill;
        c.lineWidth = pxMin(p.strokeW, W, H);
        c.lineCap = 'round';
        // The shaft stops short of the tip by the head's length, or the point would sit on
        // top of a round cap and read as a blob.
        const stop = Math.max(0.001, e - ((head * 0.8) / len) * e);
        c.beginPath();
        c.moveTo(x1, y1);
        const steps = 24;
        for (let i = 1; i <= steps; i++) {
          const q = at((i / steps) * stop);
          c.lineTo(q.x, q.y);
        }
        c.stroke();
        const tip = at(e), before = at(Math.max(0, e - 0.02));
        const a = Math.atan2(tip.y - before.y, tip.x - before.x);
        c.beginPath();
        c.moveTo(tip.x, tip.y);
        c.lineTo(tip.x - head * Math.cos(a - 0.42), tip.y - head * Math.sin(a - 0.42));
        c.lineTo(tip.x - head * Math.cos(a + 0.42), tip.y - head * Math.sin(a + 0.42));
        c.closePath();
        c.fill();
      },
    }),

    path: def({
      label: 'Path', group: 'Primitives',
      params: {
        d: 'M10 90 L50 10 L90 90 Z', viewBox: '0 0 100 100',
        size: 0.3, mode: 'fill', strokeW: 0.006,
      },
      schema: [
        { path: 'params.d', label: 'Path data', type: 'area' },
        { path: 'params.size', label: 'Size', type: 'range', min: 0.02, max: 1.5, step: 0.005, digits: 3 },
        { path: 'params.fill', label: 'Colour', type: 'color' },
        {
          path: 'params.mode', label: 'Draw as', type: 'select',
          options: [{ value: 'fill', label: 'Filled' }, { value: 'stroke', label: 'Outlined' }],
        },
        { path: 'params.strokeW', label: 'Outline width', type: 'range', min: 0.001, max: 0.04, step: 0.001, digits: 3 },
      ],
      bounds(p, W, H) {
        const s = pxMin(p.size, W, H);
        return { x: p.x * W - s / 2 - 4, y: p.y * H - s / 2 - 4, w: s + 8, h: s + 8 };
      },
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        c.globalAlpha = p.opacity * e;
        c.fillStyle = p.fill;
        c.strokeStyle = p.fill;
        drawPathData(c, p.d, parseViewBox(p.viewBox), p.x * W, p.y * H,
          pxMin(p.size, W, H), p.mode, pxMin(p.strokeW, W, H));
      },
    }),

    icon: def({
      label: 'SVG icon', group: 'Primitives',
      params: {
        d: '', viewBox: '0 0 24 24', name: '',
        size: 0.14, mode: 'fill', strokeW: 0.006,
      },
      schema: [
        { path: 'params.size', label: 'Size', type: 'range', min: 0.02, max: 1, step: 0.005, digits: 3 },
        { path: 'params.fill', label: 'Colour', type: 'color' },
        {
          path: 'params.mode', label: 'Draw as', type: 'select',
          options: [{ value: 'fill', label: 'Filled' }, { value: 'stroke', label: 'Outlined' }],
        },
        { path: 'params.strokeW', label: 'Outline width', type: 'range', min: 0.001, max: 0.04, step: 0.001, digits: 3 },
      ],
      bounds(p, W, H) {
        const s = pxMin(p.size, W, H);
        return { x: p.x * W - s / 2 - 4, y: p.y * H - s / 2 - 4, w: s + 8, h: s + 8 };
      },
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        c.globalAlpha = p.opacity * e;
        c.fillStyle = p.fill;
        c.strokeStyle = p.fill;
        const s = pxMin(p.size, W, H);
        if (drawPathData(c, p.d, parseViewBox(p.viewBox), p.x * W, p.y * H,
          s, p.mode, pxMin(p.strokeW, W, H))) return;
        // Nothing imported yet, or path data this engine could not parse. A placeholder
        // square says so ON THE FRAME - an icon that silently draws nothing is the exact
        // failure the FX panel's `needs` warnings exist to stop happening twice.
        c.globalAlpha = p.opacity * e * 0.5;
        c.lineWidth = Math.max(1, s * 0.04);
        c.strokeRect(p.x * W - s / 2, p.y * H - s / 2, s, s);
      },
    }),

    // ------------------------------------------------------------- composites

    lowerThird: def({
      label: 'Lower third', group: 'Composites',
      params: {
        title: 'Jane Okafor', sub: 'Head of Platform',
        w: 0.62, h: 0.16, radius: 0.012, titleSize: 0.045, subSize: 0.028,
        accent: '#4f8cff', accentW: 0.008, bg: '#101418', bgOpacity: 0.88, pad: 0.022,
      },
      schema: [
        { path: 'params.title', label: 'Title', type: 'text' },
        { path: 'params.sub', label: 'Subtitle', type: 'text' },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.1, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.04, max: 0.6, step: 0.005, digits: 3 },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.1, step: 0.002, digits: 3 },
        { path: 'params.titleSize', label: 'Title size', type: 'range', min: 0.01, max: 0.15, step: 0.001, digits: 3 },
        { path: 'params.subSize', label: 'Subtitle size', type: 'range', min: 0.008, max: 0.1, step: 0.001, digits: 3 },
        { path: 'params.bg', label: 'Plate', type: 'color' },
        { path: 'params.bgOpacity', label: 'Plate opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.accent', label: 'Accent', type: 'color' },
        { path: 'params.accentW', label: 'Accent width', type: 'range', min: 0, max: 0.05, step: 0.001, digits: 3 },
        { path: 'params.ink', label: 'Text', type: 'color' },
        { path: 'params.pad', label: 'Padding', type: 'range', min: 0, max: 0.1, step: 0.002, digits: 3 },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), 0.01, W, H),
      draw(c, p, W, H, t) {
        const pe = stagger(p, t, 0);
        if (pe <= 0) return;
        const b = box(p, W, H);
        const pad = pxMin(p.pad, W, H);
        const acc = pxMin(p.accentW, W, H);
        c.globalAlpha = p.opacity;
        c.save();
        // The plate wipes in from its accent edge and the type arrives behind it on the
        // next stagger step. That ordering is the whole composite: the eye reads the bar
        // landing, then the words - a single fade gives you neither.
        c.beginPath();
        c.rect(b.x, b.y, b.w * pe, b.h);
        c.clip();
        roundRect(c, b.x, b.y, b.w, b.h, pxMin(p.radius, W, H));
        c.fillStyle = rgba(p.bg, p.bgOpacity);
        c.fill();
        if (acc > 0) {
          c.fillStyle = p.accent;
          c.fillRect(b.x, b.y, acc, b.h);
        }
        c.restore();

        const te = stagger(p, t, 1);
        if (te <= 0) return;
        c.globalAlpha = p.opacity * te;
        c.fillStyle = p.ink;
        const tx = b.x + acc + pad;
        const tp = setFont(c, p, p.titleSize, W, H, '700');
        const sp = Math.max(1, pxMin(p.subSize, W, H));
        const block = tp + (p.sub ? sp * 1.5 : 0);
        const ty = b.y + b.h / 2 - block / 2 + tp * 0.82;
        label(c, p.title, tx, ty, 'left', 'alphabetic');
        if (!p.sub) return;
        setFont(c, p, p.subSize, W, H, '400');
        c.globalAlpha = p.opacity * te * 0.78;
        label(c, p.sub, tx, ty + sp * 1.45, 'left', 'alphabetic');
      },
    }),

    stepChip: def({
      label: 'Step chip', group: 'Composites',
      params: {
        n: 1, text: 'Connect your data', size: 0.062, textSize: 0.038,
        chipFill: '#4f8cff', chipInk: '#ffffff', gap: 0.022,
      },
      schema: [
        { path: 'params.n', label: 'Number', type: 'range', min: 0, max: 99, step: 1 },
        { path: 'params.text', label: 'Label', type: 'text' },
        { path: 'params.size', label: 'Chip size', type: 'range', min: 0.02, max: 0.3, step: 0.002, digits: 3 },
        { path: 'params.textSize', label: 'Label size', type: 'range', min: 0.01, max: 0.15, step: 0.001, digits: 3 },
        { path: 'params.chipFill', label: 'Chip fill', type: 'color' },
        { path: 'params.chipInk', label: 'Chip text', type: 'color' },
        { path: 'params.ink', label: 'Label colour', type: 'color' },
        { path: 'params.gap', label: 'Gap', type: 'range', min: 0, max: 0.1, step: 0.002, digits: 3 },
      ],
      bounds(p, W, H) {
        const s = pxMin(p.size, W, H);
        const ts = pxMin(p.textSize, W, H);
        const tw = String(p.text || '').length * ts * 0.62;
        return {
          x: p.x * W - s / 2 - 4, y: p.y * H - Math.max(s, ts * 1.6) / 2 - 4,
          w: s + pxMin(p.gap, W, H) + tw + 8, h: Math.max(s, ts * 1.6) + 8,
        };
      },
      draw(c, p, W, H, t) {
        const ce = stagger(p, t, 0);
        if (ce <= 0) return;
        const s = pxMin(p.size, W, H);
        const cx = p.x * W, cy = p.y * H;
        c.globalAlpha = p.opacity * ce;
        c.beginPath();
        c.arc(cx, cy, (s / 2) * (0.6 + 0.4 * ce), 0, Math.PI * 2);
        c.fillStyle = p.chipFill;
        c.fill();
        c.fillStyle = p.chipInk;
        setFont(c, p, p.size * 0.52, W, H, '700');
        label(c, Math.round(p.n), cx, cy, 'center', 'middle');
        const te = stagger(p, t, 1);
        if (te <= 0 || !p.text) return;
        c.globalAlpha = p.opacity * te;
        c.fillStyle = p.ink;
        setFont(c, p, p.textSize, W, H, '600');
        label(c, p.text, cx + s / 2 + pxMin(p.gap, W, H), cy, 'left', 'middle');
      },
    }),

    bracket: def({
      label: 'Callout bracket', group: 'Composites',
      params: {
        w: 0.34, h: 0.22, arm: 0.05, strokeW: 0.008,
        side: 'both', text: '', textSize: 0.032,
      },
      schema: [
        { path: 'params.w', label: 'Width', type: 'range', min: 0.02, max: 1.5, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.02, max: 1.5, step: 0.005, digits: 3 },
        { path: 'params.arm', label: 'Arm length', type: 'range', min: 0.005, max: 0.3, step: 0.002, digits: 3 },
        { path: 'params.strokeW', label: 'Thickness', type: 'range', min: 0.001, max: 0.04, step: 0.001, digits: 3 },
        { path: 'params.fill', label: 'Colour', type: 'color' },
        {
          path: 'params.side', label: 'Corners', type: 'select',
          options: [
            { value: 'both', label: 'All four' },
            { value: 'left', label: 'Left pair' },
            { value: 'right', label: 'Right pair' },
          ],
        },
        { path: 'params.text', label: 'Caption', type: 'text' },
        { path: 'params.textSize', label: 'Caption size', type: 'range', min: 0.01, max: 0.12, step: 0.001, digits: 3 },
        { path: 'params.ink', label: 'Caption colour', type: 'color' },
      ],
      bounds: (p, W, H) => grow(box(p, W, H),
        (p.strokeW || 0) + (p.text ? (p.textSize || 0) * 2 : 0) + 0.01, W, H),
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        const b = box(p, W, H);
        const arm = pxMin(p.arm, W, H) * e;
        c.globalAlpha = p.opacity;
        c.strokeStyle = p.fill;
        c.lineWidth = pxMin(p.strokeW, W, H);
        c.lineCap = 'round';
        c.lineJoin = 'round';
        const corner = (cx, cy, sx, sy) => {
          c.beginPath();
          c.moveTo(cx + sx * arm, cy);
          c.lineTo(cx, cy);
          c.lineTo(cx, cy + sy * arm);
          c.stroke();
        };
        const left = p.side !== 'right', right = p.side !== 'left';
        if (left) { corner(b.x, b.y, 1, 1); corner(b.x, b.y + b.h, 1, -1); }
        if (right) { corner(b.x + b.w, b.y, -1, 1); corner(b.x + b.w, b.y + b.h, -1, -1); }
        const te = stagger(p, t, 1);
        if (te <= 0 || !p.text) return;
        c.globalAlpha = p.opacity * te;
        c.fillStyle = p.ink;
        const px = setFont(c, p, p.textSize, W, H, '600');
        label(c, p.text, b.x + b.w / 2, b.y - px * 0.5, 'center', 'alphabetic');
      },
    }),

    underline: def({
      label: 'Underline stroke', group: 'Composites',
      params: { w: 0.4, thickness: 0.012, tilt: 0, radius: 0.006 },
      schema: [
        { path: 'params.w', label: 'Width', type: 'range', min: 0.02, max: 2, step: 0.005, digits: 3 },
        { path: 'params.thickness', label: 'Thickness', type: 'range', min: 0.001, max: 0.06, step: 0.001, digits: 3 },
        { path: 'params.tilt', label: 'Tilt', type: 'range', min: -20, max: 20, step: 0.5, unit: '°', digits: 1 },
        { path: 'params.radius', label: 'End radius', type: 'range', min: 0, max: 0.03, step: 0.001, digits: 3 },
        { path: 'params.fill', label: 'Colour', type: 'color' },
      ],
      bounds(p, W, H) {
        const w = pxMin(p.w, W, H), th = pxMin(p.thickness, W, H);
        const lift = Math.abs(Math.tan((p.tilt || 0) * Math.PI / 180)) * w / 2;
        return grow({ x: p.x * W - w / 2, y: p.y * H - th / 2 - lift, w, h: th + 2 * lift }, 0.006, W, H);
      },
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        const w = pxMin(p.w, W, H), th = pxMin(p.thickness, W, H);
        c.globalAlpha = p.opacity;
        c.save();
        c.translate(p.x * W, p.y * H);
        c.rotate((p.tilt || 0) * Math.PI / 180);
        c.fillStyle = p.fill;
        // Drawn on from the left: an underline is a pen stroke, and a pen stroke that fades
        // up whole is just a rectangle.
        roundRect(c, -w / 2, -th / 2, w * e, th, pxMin(p.radius, W, H));
        c.fill();
        c.restore();
      },
    }),

    highlighter: def({
      label: 'Highlighter swipe', group: 'Composites',
      params: { w: 0.42, h: 0.07, alpha: 0.45, tilt: -1.2, skew: 0.35 },
      schema: [
        { path: 'params.w', label: 'Width', type: 'range', min: 0.02, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.005, max: 0.4, step: 0.002, digits: 3 },
        { path: 'params.fill', label: 'Colour', type: 'color' },
        { path: 'params.alpha', label: 'Ink', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.tilt', label: 'Tilt', type: 'range', min: -20, max: 20, step: 0.2, unit: '°', digits: 1 },
        { path: 'params.skew', label: 'Nib skew', type: 'range', min: 0, max: 1, step: 0.02, digits: 2 },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), Math.abs(p.tilt || 0) * 0.002 + 0.012, W, H),
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        if (e <= 0) return;
        const w = pxMin(p.w, W, H), h = pxMin(p.h, W, H);
        c.globalAlpha = p.opacity * clamp(p.alpha, 0, 1);
        c.save();
        c.translate(p.x * W, p.y * H);
        c.rotate((p.tilt || 0) * Math.PI / 180);
        c.fillStyle = p.fill;
        // A marker nib leaves a slanted leading edge, so the swipe is a parallelogram whose
        // right edge travels - not a rectangle that grows.
        const sk = h * clamp(p.skew, 0, 1) * 0.5;
        const x1 = -w / 2, x2 = -w / 2 + w * e;
        c.beginPath();
        c.moveTo(x1 - sk, -h / 2);
        c.lineTo(x2 + sk, -h / 2);
        c.lineTo(x2 - sk, h / 2);
        c.lineTo(x1 + sk, h / 2);
        c.closePath();
        c.fill();
        c.restore();
      },
    }),

    // ------------------------------------------------------------- data objects

    counter: def({
      label: 'Counting number', group: 'Data',
      params: {
        from: 0, to: 1240, decimals: 0, prefix: '', suffix: '', group: true,
        size: 0.16, capSize: 0.034, caption: 'active teams',
      },
      schema: [
        { path: 'params.from', label: 'From', type: 'number', min: -1e9, max: 1e9, step: 1 },
        { path: 'params.to', label: 'To', type: 'number', min: -1e9, max: 1e9, step: 1 },
        { path: 'params.decimals', label: 'Decimals', type: 'range', min: 0, max: 4, step: 1 },
        { path: 'params.prefix', label: 'Prefix', type: 'text' },
        { path: 'params.suffix', label: 'Suffix', type: 'text' },
        { path: 'params.group', label: 'Thousands separator', type: 'check' },
        { path: 'params.size', label: 'Number size', type: 'range', min: 0.02, max: 0.5, step: 0.002, digits: 3 },
        { path: 'params.caption', label: 'Caption', type: 'text' },
        { path: 'params.capSize', label: 'Caption size', type: 'range', min: 0.008, max: 0.12, step: 0.001, digits: 3 },
        { path: 'params.ink', label: 'Colour', type: 'color' },
      ],
      bounds(p, W, H) {
        const s = pxMin(p.size, W, H);
        const chars = String(p.prefix || '').length + String(p.suffix || '').length +
          String(Math.round(Math.abs(p.to))).length + (p.decimals > 0 ? p.decimals + 1 : 0) + 1;
        const w = Math.max(chars * s * 0.62, String(p.caption || '').length * pxMin(p.capSize, W, H) * 0.62);
        const h = s * 1.3 + (p.caption ? pxMin(p.capSize, W, H) * 2.4 : 0);
        return { x: p.x * W - w / 2 - 6, y: p.y * H - h / 2 - 6, w: w + 12, h: h + 12 };
      },
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        const v = num(p.from, 0) + (num(p.to, 0) - num(p.from, 0)) * e;
        const d = Math.max(0, Math.min(4, Math.round(p.decimals || 0)));
        let s = Math.abs(v).toFixed(d);
        if (p.group !== false) {
          const parts = s.split('.');
          parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          s = parts.join('.');
        }
        const txt = (v < 0 ? '-' : '') + String(p.prefix || '') + s + String(p.suffix || '');
        c.globalAlpha = p.opacity;
        c.fillStyle = p.ink;
        const px = setFont(c, p, p.size, W, H, '800');
        const cap = p.caption ? pxMin(p.capSize, W, H) : 0;
        const cy = p.y * H - (cap ? cap * 0.9 : 0);
        label(c, txt, p.x * W, cy, 'center', 'middle');
        if (!cap) return;
        setFont(c, p, p.capSize, W, H, '500');
        c.globalAlpha = p.opacity * 0.75;
        label(c, p.caption, p.x * W, cy + px * 0.62 + cap * 1.1, 'center', 'middle');
      },
    }),

    ring: def({
      label: 'Percentage ring', group: 'Data',
      params: {
        value: 0.72, radius: 0.16, thickness: 0.026, trackAlpha: 0.18,
        showLabel: true, labelSize: 0.05, caption: '', capSize: 0.028, start: -90,
      },
      schema: [
        { path: 'params.value', label: 'Value', type: 'range', min: 0, max: 1, step: 0.005, digits: 3 },
        { path: 'params.radius', label: 'Radius', type: 'range', min: 0.02, max: 0.6, step: 0.002, digits: 3 },
        { path: 'params.thickness', label: 'Thickness', type: 'range', min: 0.002, max: 0.2, step: 0.002, digits: 3 },
        { path: 'params.fill', label: 'Ring', type: 'color' },
        { path: 'params.trackAlpha', label: 'Track', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.start', label: 'Start angle', type: 'range', min: -180, max: 180, step: 1, unit: '°' },
        { path: 'params.showLabel', label: 'Show percentage', type: 'check' },
        { path: 'params.labelSize', label: 'Percentage size', type: 'range', min: 0.01, max: 0.2, step: 0.002, digits: 3 },
        { path: 'params.caption', label: 'Caption', type: 'text' },
        { path: 'params.capSize', label: 'Caption size', type: 'range', min: 0.008, max: 0.1, step: 0.001, digits: 3 },
        { path: 'params.ink', label: 'Text', type: 'color' },
      ],
      bounds(p, W, H) {
        const r = pxMin(p.radius, W, H) + pxMin(p.thickness, W, H) / 2;
        const cap = p.caption ? pxMin(p.capSize, W, H) * 2.4 : 0;
        return { x: p.x * W - r - 6, y: p.y * H - r - 6, w: 2 * r + 12, h: 2 * r + 12 + cap };
      },
      draw(c, p, W, H, t) {
        const e = stagger(p, t, 0);
        const r = pxMin(p.radius, W, H);
        const th = pxMin(p.thickness, W, H);
        const cx = p.x * W, cy = p.y * H;
        const a0 = (p.start || -90) * Math.PI / 180;
        c.globalAlpha = p.opacity;
        c.lineWidth = th;
        c.lineCap = 'round';
        if (p.trackAlpha > 0) {
          c.strokeStyle = rgba(p.fill, p.trackAlpha);
          c.beginPath();
          c.arc(cx, cy, r, 0, Math.PI * 2);
          c.stroke();
        }
        const frac = clamp(p.value, 0, 1) * e;
        if (frac > 0) {
          c.strokeStyle = p.fill;
          c.beginPath();
          c.arc(cx, cy, r, a0, a0 + frac * Math.PI * 2);
          c.stroke();
        }
        if (p.showLabel !== false) {
          c.fillStyle = p.ink;
          setFont(c, p, p.labelSize, W, H, '700');
          label(c, Math.round(clamp(p.value, 0, 1) * e * 100) + '%', cx, cy, 'center', 'middle');
        }
        if (!p.caption) return;
        c.globalAlpha = p.opacity * stagger(p, t, 1) * 0.8;
        c.fillStyle = p.ink;
        setFont(c, p, p.capSize, W, H, '500');
        label(c, p.caption, cx, cy + r + th + pxMin(p.capSize, W, H) * 1.2, 'center', 'middle');
      },
    }),

    bars: def({
      label: 'Bar chart', group: 'Data',
      params: {
        values: '18, 34, 27, 52, 44', labels: 'Mon, Tue, Wed, Thu, Fri',
        w: 0.62, h: 0.36, gap: 0.28, radius: 0.006, ticks: 4,
        axis: true, axisAlpha: 0.3, labelSize: 0.024, ink2: '#9fb0bb',
      },
      schema: [
        { path: 'params.values', label: 'Values', type: 'area' },
        { path: 'params.labels', label: 'Labels', type: 'text' },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.gap', label: 'Bar gap', type: 'range', min: 0, max: 0.9, step: 0.02, digits: 2 },
        { path: 'params.radius', label: 'Bar radius', type: 'range', min: 0, max: 0.05, step: 0.001, digits: 3 },
        { path: 'params.fill', label: 'Bars', type: 'color' },
        { path: 'params.ticks', label: 'Gridlines', type: 'range', min: 2, max: 10, step: 1 },
        { path: 'params.axis', label: 'Axis and gridlines', type: 'check' },
        { path: 'params.axisAlpha', label: 'Gridline ink', type: 'range', min: 0, max: 1, step: 0.02, digits: 2 },
        { path: 'params.labelSize', label: 'Label size', type: 'range', min: 0.008, max: 0.08, step: 0.001, digits: 3 },
        { path: 'params.ink2', label: 'Labels', type: 'color' },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), (p.labelSize || 0.024) * 2.5 + 0.01, W, H),
      draw(c, p, W, H, t) {
        const vals = parseValues(p.values);
        if (!vals.length) return;
        const labs = parseLabels(p.labels);
        const b = box(p, W, H);
        // ONE scale. The bars, the gridlines and the tick labels all come out of it, which
        // is the only reason a label can be trusted to name the height beside it.
        const sc = scale(vals, { ticks: p.ticks });
        const zeroY = b.y + b.h * (1 - sc.at(0));
        const ls = pxMin(p.labelSize, W, H);
        c.globalAlpha = p.opacity;

        if (p.axis !== false) {
          c.strokeStyle = rgba(p.ink2, p.axisAlpha);
          c.fillStyle = rgba(p.ink2, Math.min(1, p.axisAlpha + 0.45));
          c.lineWidth = Math.max(1, pxMin(0.0015, W, H));
          setFont(c, p, p.labelSize, W, H, '500');
          for (const tick of sc.ticks) {
            const y = b.y + b.h * (1 - sc.at(tick));
            c.beginPath();
            c.moveTo(b.x, y);
            c.lineTo(b.x + b.w, y);
            c.stroke();
            label(c, tickLabel(tick, sc.step), b.x - ls * 0.4, y, 'right', 'middle');
          }
        }

        const slot = b.w / vals.length;
        const bw = slot * (1 - clamp(p.gap, 0, 0.95));
        vals.forEach((v, i) => {
          const e = stagger(p, t, i);
          const x = b.x + slot * i + (slot - bw) / 2;
          const full = b.y + b.h * (1 - sc.at(v));
          const y = zeroY + (full - zeroY) * e;
          c.globalAlpha = p.opacity;
          c.fillStyle = p.fill;
          roundRect(c, x, Math.min(y, zeroY), bw, Math.abs(y - zeroY), pxMin(p.radius, W, H));
          c.fill();
          if (!labs[i]) return;
          c.globalAlpha = p.opacity * e;
          c.fillStyle = p.ink2;
          setFont(c, p, p.labelSize, W, H, '500');
          label(c, labs[i], x + bw / 2, b.y + b.h + ls * 1.1, 'center', 'middle');
        });
      },
    }),

    linegraph: def({
      label: 'Line graph', group: 'Data',
      params: {
        values: '4, 9, 7, 15, 13, 22, 31', labels: '',
        w: 0.62, h: 0.34, strokeW: 0.008, dots: 0.01, area: 0.18, ticks: 4,
        axis: true, axisAlpha: 0.3, labelSize: 0.024, ink2: '#9fb0bb',
      },
      schema: [
        { path: 'params.values', label: 'Values', type: 'area' },
        { path: 'params.labels', label: 'X labels', type: 'text' },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.fill', label: 'Line', type: 'color' },
        { path: 'params.strokeW', label: 'Thickness', type: 'range', min: 0.001, max: 0.04, step: 0.001, digits: 3 },
        { path: 'params.dots', label: 'Point size', type: 'range', min: 0, max: 0.04, step: 0.001, digits: 3 },
        { path: 'params.area', label: 'Fill under', type: 'range', min: 0, max: 1, step: 0.02, digits: 2 },
        { path: 'params.ticks', label: 'Gridlines', type: 'range', min: 2, max: 10, step: 1 },
        { path: 'params.axis', label: 'Axis and gridlines', type: 'check' },
        { path: 'params.axisAlpha', label: 'Gridline ink', type: 'range', min: 0, max: 1, step: 0.02, digits: 2 },
        { path: 'params.labelSize', label: 'Label size', type: 'range', min: 0.008, max: 0.08, step: 0.001, digits: 3 },
        { path: 'params.ink2', label: 'Labels', type: 'color' },
      ],
      bounds: (p, W, H) => grow(box(p, W, H),
        (p.labelSize || 0.024) * 2.5 + (p.dots || 0) + 0.01, W, H),
      draw(c, p, W, H, t) {
        const vals = parseValues(p.values);
        if (!vals.length) return;
        const labs = parseLabels(p.labels);
        const b = box(p, W, H);
        const sc = scale(vals, { ticks: p.ticks });
        const ls = pxMin(p.labelSize, W, H);
        const px = (i) => b.x + (vals.length > 1 ? (i / (vals.length - 1)) * b.w : b.w / 2);
        const py = (v) => b.y + b.h * (1 - sc.at(v));
        c.globalAlpha = p.opacity;

        if (p.axis !== false) {
          c.strokeStyle = rgba(p.ink2, p.axisAlpha);
          c.fillStyle = rgba(p.ink2, Math.min(1, p.axisAlpha + 0.45));
          c.lineWidth = Math.max(1, pxMin(0.0015, W, H));
          setFont(c, p, p.labelSize, W, H, '500');
          for (const tick of sc.ticks) {
            const y = py(tick);
            c.beginPath();
            c.moveTo(b.x, y);
            c.lineTo(b.x + b.w, y);
            c.stroke();
            label(c, tickLabel(tick, sc.step), b.x - ls * 0.4, y, 'right', 'middle');
          }
        }

        // The line DRAWS ON: `reach` is how far along the series the pen has got, so the
        // leading segment is partial rather than popping in whole. Same single scale for y.
        const e = stagger(p, t, 0);
        const reach = e * (vals.length - 1);
        const pts = [];
        for (let i = 0; i < vals.length; i++) {
          if (i <= reach) { pts.push([px(i), py(vals[i])]); continue; }
          const prev = i - 1;
          if (prev >= 0 && reach > prev) {
            const f = reach - prev;
            pts.push([
              px(prev) + (px(i) - px(prev)) * f,
              py(vals[prev]) + (py(vals[i]) - py(vals[prev])) * f,
            ]);
          }
          break;
        }
        if (pts.length > 1 && p.area > 0) {
          c.globalAlpha = p.opacity * clamp(p.area, 0, 1);
          c.fillStyle = p.fill;
          c.beginPath();
          c.moveTo(pts[0][0], py(sc.min));
          for (const q of pts) c.lineTo(q[0], q[1]);
          c.lineTo(pts[pts.length - 1][0], py(sc.min));
          c.closePath();
          c.fill();
        }
        c.globalAlpha = p.opacity;
        c.strokeStyle = p.fill;
        c.lineWidth = pxMin(p.strokeW, W, H);
        c.lineJoin = 'round';
        c.lineCap = 'round';
        if (pts.length > 1) {
          c.beginPath();
          c.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
          c.stroke();
        }
        if (p.dots > 0) {
          c.fillStyle = p.fill;
          for (let i = 0; i < vals.length && i <= reach; i++) {
            c.beginPath();
            c.arc(px(i), py(vals[i]), pxMin(p.dots, W, H), 0, Math.PI * 2);
            c.fill();
          }
        }
        if (!labs.length) return;
        c.fillStyle = p.ink2;
        setFont(c, p, p.labelSize, W, H, '500');
        for (let i = 0; i < vals.length; i++) {
          if (!labs[i] || i > reach) continue;
          label(c, labs[i], px(i), b.y + b.h + ls * 1.1, 'center', 'middle');
        }
      },
    }),

    donut: def({
      label: 'Donut', group: 'Data',
      params: {
        values: '48, 27, 15, 10', labels: 'Enterprise, Mid-market, SMB, Other',
        radius: 0.18, thickness: 0.06, gapDeg: 2, fill2: '#8b5cf6',
        showLegend: true, labelSize: 0.024, ink2: '#9fb0bb', start: -90,
      },
      schema: [
        { path: 'params.values', label: 'Values', type: 'area' },
        { path: 'params.labels', label: 'Labels', type: 'text' },
        { path: 'params.radius', label: 'Radius', type: 'range', min: 0.02, max: 0.6, step: 0.002, digits: 3 },
        { path: 'params.thickness', label: 'Thickness', type: 'range', min: 0.004, max: 0.3, step: 0.002, digits: 3 },
        { path: 'params.gapDeg', label: 'Segment gap', type: 'range', min: 0, max: 12, step: 0.5, unit: '°', digits: 1 },
        { path: 'params.fill', label: 'Ramp start', type: 'color' },
        { path: 'params.fill2', label: 'Ramp end', type: 'color' },
        { path: 'params.start', label: 'Start angle', type: 'range', min: -180, max: 180, step: 1, unit: '°' },
        { path: 'params.showLegend', label: 'Legend', type: 'check' },
        { path: 'params.labelSize', label: 'Legend size', type: 'range', min: 0.008, max: 0.08, step: 0.001, digits: 3 },
        { path: 'params.ink2', label: 'Legend colour', type: 'color' },
      ],
      bounds(p, W, H) {
        const r = pxMin(p.radius, W, H) + pxMin(p.thickness, W, H) / 2;
        const labs = parseLabels(p.labels);
        const legend = p.showLegend !== false && labs.length
          ? pxMin(p.labelSize, W, H) * 1.7 * (labs.length + 1) : 0;
        return { x: p.x * W - r - 6, y: p.y * H - r - 6, w: 2 * r + 12, h: 2 * r + 12 + legend };
      },
      draw(c, p, W, H, t) {
        const vals = parseValues(p.values).map((v) => Math.max(0, v));
        const total = vals.reduce((a, v) => a + v, 0);
        if (!(total > 0)) return;
        const labs = parseLabels(p.labels);
        const r = pxMin(p.radius, W, H), th = pxMin(p.thickness, W, H);
        const cx = p.x * W, cy = p.y * H;
        const gap = (p.gapDeg || 0) * Math.PI / 180;
        const colFor = (i) => mix(p.fill, p.fill2, vals.length > 1 ? i / (vals.length - 1) : 0);
        c.lineWidth = th;
        c.lineCap = 'butt';
        let a = (p.start || -90) * Math.PI / 180;
        vals.forEach((v, i) => {
          const e = stagger(p, t, i);
          const sweep = (v / total) * Math.PI * 2;
          if (e > 0 && sweep > gap) {
            c.globalAlpha = p.opacity;
            c.strokeStyle = colFor(i);
            c.beginPath();
            c.arc(cx, cy, r, a + gap / 2, a + gap / 2 + (sweep - gap) * e);
            c.stroke();
          }
          a += sweep;
        });
        if (p.showLegend === false || !labs.length) return;
        const ls = pxMin(p.labelSize, W, H);
        setFont(c, p, p.labelSize, W, H, '500');
        labs.forEach((s, i) => {
          if (i >= vals.length) return;
          const e = stagger(p, t, i);
          if (e <= 0) return;
          const y = cy + r + th / 2 + ls * (1.3 + i * 1.7);
          c.globalAlpha = p.opacity * e;
          c.fillStyle = colFor(i);
          roundRect(c, cx - r, y - ls * 0.4, ls * 0.8, ls * 0.8, ls * 0.2);
          c.fill();
          c.fillStyle = p.ink2;
          label(c, s + '  ' + Math.round((vals[i] / total) * 100) + '%',
            cx - r + ls * 1.3, y, 'left', 'middle');
        });
      },
    }),

    // ------------------------------------------------------------- diagrams

    funnel: def({
      label: 'Funnel', group: 'Diagrams',
      params: {
        spec: JSON.stringify(DIAGRAM_FALLBACK.funnel),
        w: 0.66, h: 0.5, fill2: '#8b5cf6', labelSize: 0.028, radius: 0.008, showValue: true,
      },
      schema: [
        { path: 'params.spec', label: 'Spec (JSON)', type: 'area' },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.fill', label: 'Top colour', type: 'color' },
        { path: 'params.fill2', label: 'Bottom colour', type: 'color' },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.05, step: 0.001, digits: 3 },
        { path: 'params.labelSize', label: 'Label size', type: 'range', min: 0.008, max: 0.08, step: 0.001, digits: 3 },
        { path: 'params.showValue', label: 'Show values', type: 'check' },
        { path: 'params.ink', label: 'Text', type: 'color' },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), 0.01, W, H),
      draw(c, p, W, H, t) {
        const L = layoutDiagram('funnel', p.spec);
        const b = box(p, W, H);
        setFont(c, p, p.labelSize, W, H, '600');
        L.rows.forEach((r, i) => {
          const e = stagger(p, t, i);
          if (e <= 0) return;
          const w = b.w * r.w * e;
          c.globalAlpha = p.opacity;
          c.fillStyle = mix(p.fill, p.fill2, L.rows.length > 1 ? i / (L.rows.length - 1) : 0);
          roundRect(c, b.x + b.w / 2 - w / 2, b.y + b.h * r.y, w, b.h * r.h, pxMin(p.radius, W, H));
          c.fill();
          c.globalAlpha = p.opacity * e;
          c.fillStyle = p.ink;
          const txt = r.label + (p.showValue !== false ? '   ' + r.value.toLocaleString('en-US') : '');
          label(c, txt, b.x + b.w / 2, b.y + b.h * (r.y + r.h / 2), 'center', 'middle');
        });
      },
    }),

    flow: def({
      label: 'Before / after', group: 'Diagrams',
      params: {
        spec: JSON.stringify(DIAGRAM_FALLBACK.flow),
        w: 0.82, h: 0.44, fill2: '#22c55e', labelSize: 0.026, radius: 0.01,
      },
      schema: [
        { path: 'params.spec', label: 'Spec (JSON)', type: 'area' },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.fill', label: 'Before', type: 'color' },
        { path: 'params.fill2', label: 'After', type: 'color' },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.05, step: 0.001, digits: 3 },
        { path: 'params.labelSize', label: 'Label size', type: 'range', min: 0.008, max: 0.08, step: 0.001, digits: 3 },
        { path: 'params.ink', label: 'Text', type: 'color' },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), 0.01, W, H),
      draw(c, p, W, H, t) {
        const L = layoutDiagram('flow', p.spec);
        const b = box(p, W, H);
        const r = pxMin(p.radius, W, H);
        const drawCol = (list, colour, base) => {
          setFont(c, p, p.labelSize, W, H, '600');
          list.forEach((n, i) => {
            const e = stagger(p, t, base + i);
            if (e <= 0) return;
            c.globalAlpha = p.opacity * e;
            c.fillStyle = colour;
            roundRect(c, b.x + b.w * n.x, b.y + b.h * n.y, b.w * n.w, b.h * n.h, r);
            c.fill();
            c.fillStyle = p.ink;
            label(c, n.label, b.x + b.w * (n.x + n.w / 2), b.y + b.h * (n.y + n.h / 2), 'center', 'middle');
          });
        };
        drawCol(L.before, p.fill, 0);
        const ae = stagger(p, t, L.before.length);
        if (ae > 0) {
          c.globalAlpha = p.opacity * ae;
          c.strokeStyle = p.ink;
          c.fillStyle = p.ink;
          const ax = b.x + b.w * L.arrow.x, ay = b.y + b.h * L.arrow.y, aw = b.w * L.arrow.w;
          c.lineWidth = pxMin(0.006, W, H);
          c.beginPath();
          c.moveTo(ax, ay);
          c.lineTo(ax + aw * 0.7, ay);
          c.stroke();
          c.beginPath();
          c.moveTo(ax + aw, ay);
          c.lineTo(ax + aw * 0.62, ay - aw * 0.28);
          c.lineTo(ax + aw * 0.62, ay + aw * 0.28);
          c.closePath();
          c.fill();
        }
        drawCol(L.after, p.fill2, L.before.length + 1);
      },
    }),

    nodemap: def({
      label: 'Node map', group: 'Diagrams',
      params: {
        spec: JSON.stringify(DIAGRAM_FALLBACK.nodemap),
        w: 0.86, h: 0.5, labelSize: 0.024, radius: 0.012, edgeW: 0.004, ink2: '#9fb0bb',
      },
      schema: [
        { path: 'params.spec', label: 'Spec (JSON)', type: 'area' },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.05, max: 2, step: 0.005, digits: 3 },
        { path: 'params.fill', label: 'Nodes', type: 'color' },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.05, step: 0.001, digits: 3 },
        { path: 'params.edgeW', label: 'Edge thickness', type: 'range', min: 0.001, max: 0.02, step: 0.001, digits: 3 },
        { path: 'params.ink2', label: 'Edges', type: 'color' },
        { path: 'params.labelSize', label: 'Label size', type: 'range', min: 0.008, max: 0.08, step: 0.001, digits: 3 },
        { path: 'params.ink', label: 'Text', type: 'color' },
      ],
      bounds: (p, W, H) => grow(box(p, W, H), 0.01, W, H),
      draw(c, p, W, H, t) {
        const L = layoutDiagram('nodemap', p.spec);
        const b = box(p, W, H);
        const X = (u) => b.x + b.w * u, Y = (v) => b.y + b.h * v;
        // Edges first, and each one staggered behind the node it arrives at - so a map
        // assembles as a path being walked rather than as boxes that later sprout wires.
        const idx = new Map(L.nodes.map((n, i) => [n.id, i]));
        c.lineCap = 'round';
        c.lineWidth = pxMin(p.edgeW, W, H);
        L.edges.forEach((ed) => {
          const e = stagger(p, t, idx.get(ed.to) || 0);
          if (e <= 0) return;
          c.globalAlpha = p.opacity * 0.75;
          c.strokeStyle = p.ink2;
          c.beginPath();
          c.moveTo(X(ed.x1), Y(ed.y1));
          c.lineTo(X(ed.x1) + (X(ed.x2) - X(ed.x1)) * e, Y(ed.y1) + (Y(ed.y2) - Y(ed.y1)) * e);
          c.stroke();
        });
        setFont(c, p, p.labelSize, W, H, '600');
        L.nodes.forEach((n, i) => {
          const e = stagger(p, t, i);
          if (e <= 0) return;
          c.globalAlpha = p.opacity * e;
          c.fillStyle = p.fill;
          roundRect(c, X(n.cx - n.w / 2), Y(n.cy - n.h / 2), b.w * n.w, b.h * n.h, pxMin(p.radius, W, H));
          c.fill();
          c.fillStyle = p.ink;
          label(c, n.label, X(n.cx), Y(n.cy), 'center', 'middle');
        });
      },
    }),
  };

  const TYPES = Object.keys(DEFS);
  const GROUPS = ['Primitives', 'Composites', 'Data', 'Diagrams'];

  // ------------------------------------------------------------------ the model

  function defaultGraphic(type) {
    const key = DEFS[type] ? type : 'rect';
    return { type: key, params: JSON.parse(JSON.stringify(DEFS[key].params)) };
  }

  /**
   * Fill in parameters a project saved before they existed, drop ones this build does not
   * know, and prune `keys` away when it holds nothing - the same job `FX.normalize()` does,
   * for the same reason: a graphic nobody has keyed must serialise exactly as one saved
   * before keyframes existed.
   */
  function normalize(g) {
    if (!g || !DEFS[g.type]) return null;
    const d = DEFS[g.type];
    const params = JSON.parse(JSON.stringify(d.params));
    for (const k of Object.keys(params)) {
      const v = (g.params || {})[k];
      if (typeof params[k] === 'number') { if (isFinite(Number(v))) params[k] = Number(v); }
      else if (typeof params[k] === 'boolean') { if (v != null) params[k] = !!v; }
      else if (v != null) params[k] = String(v);
    }
    g.params = params;
    if (g.keys && typeof g.keys === 'object') {
      for (const k of Object.keys(g.keys)) {
        if (!Array.isArray(g.keys[k]) || !g.keys[k].length || typeof params[k] !== 'number') delete g.keys[k];
        else Anim.sortKeys(g.keys[k]);
      }
      if (!Object.keys(g.keys).length) delete g.keys;
    } else if (g.keys) delete g.keys;
    return g;
  }

  /**
   * A graphic clip whose type this build does not know keeps its `graphic` UNTOUCHED and
   * simply draws nothing. Dropping it would turn "open this project in an older build"
   * into "lose the object", which is a worse answer than an empty frame.
   */
  function normalizeClip(clip) {
    if (!clip || clip.kind !== 'graphic' || !clip.graphic) return;
    if (DEFS[clip.graphic.type]) normalize(clip.graphic);
  }

  const hasGraphic = (clip) =>
    !!(clip && clip.kind === 'graphic' && clip.graphic && DEFS[clip.graphic.type]);

  /** One parameter at time t: the animated value when it is keyed, the static one when not. */
  function paramAt(g, key, t) {
    const stat = (g.params || {})[key];
    if (typeof stat !== 'number') return stat;   // a colour or a string has no track
    return Anim.valueAt(g, key, t, stat);
  }
  /** Every parameter at time t. */
  function paramsAt(g, t) {
    const d = DEFS[g.type];
    const out = {};
    for (const k of Object.keys(d.params)) out[k] = paramAt(g, k, t);
    return out;
  }

  // ------------------------------------------------------------------ the paint contract
  //
  // The same shape `TextDraw` exposes, which is what lets `compositeLayers()` and the baker
  // treat a graphic and a card as the same kind of thing.

  /**
   * Paint one graphic clip at `t` seconds into the clip.
   *
   * Everything is wrapped in save/restore and nothing leaks: the caller hands over a
   * context that is either the frame or the clip's own FX layer, and either way it must
   * come back with the alpha, the fill, the dash and the transform it arrived with.
   */
  function draw(ctx, clip, W, H, t, frameDur) {
    if (!hasGraphic(clip)) return;
    const g = clip.graphic;
    ctx.save();
    try {
      ctx.globalCompositeOperation = 'source-over';
      ctx.setLineDash([]);
      DEFS[g.type].draw(ctx, paramsAt(g, t), W, H, t, frameDur);
    } catch (e) {
      // A bad frame costs a frame, never the session - the rule `loop()` re-arms for.
      if (typeof console !== 'undefined') console.warn('graphic draw failed', e);
    }
    ctx.restore();
  }

  /** The painted extent at one instant, in pixels. */
  function bounds(ctx, clip, W, H, t) {
    if (!hasGraphic(clip)) return { x: 0, y: 0, w: W, h: H };
    const g = clip.graphic;
    let b = null;
    try { b = DEFS[g.type].bounds(paramsAt(g, t), W, H, ctx); } catch (e) { b = null; }
    // A type whose bounds threw, or answered nonsense, falls back to the WHOLE frame. That
    // bakes a bigger sequence than it needs to and is always correct; the other direction
    // silently crops the object, which is the failure you only notice in the export.
    if (!b || !isFinite(b.x) || !isFinite(b.y) || !(b.w > 0) || !(b.h > 0)) {
      return { x: 0, y: 0, w: W, h: H };
    }
    return b;
  }

  /**
   * Union of the painted bounds across the clip, sampled every `step` seconds.
   *
   * Byte for byte the contract `TextDraw.animatedBounds()` has, so the baker needs no new
   * branch: a graphic in a corner writes a small frame rather than a full-size one. Even
   * width and height, because overlay feeds yuv420p and odd chroma dimensions are how you
   * get a one-pixel seam down the edge.
   */
  function animatedBounds(ctx, clip, W, H, step, from, to) {
    const dur = Math.max(0.001, clip.out - clip.in);
    const t0 = from == null ? 0 : Math.max(0, from);
    const t1 = to == null ? dur : Math.min(dur, to);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let t = t0; t <= t1 + 1e-6; t += (step || 1 / 15)) {
      const b = bounds(ctx, clip, W, H, Math.min(t, t1));
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    const pad = 8;
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
    if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: W, h: H };
    let w = x1 - x0, h = y1 - y0;
    if (w % 2) w = Math.min(W - x0, w + 1);
    if (h % 2) h = Math.min(H - y0, h + 1);
    return { x: x0, y: y0, w, h };
  }

  /** A short, stable name for the timeline lane and the inspector header. */
  function title(clip) {
    if (!hasGraphic(clip)) return 'Graphic';
    const p = clip.graphic.params || {};
    const first = p.title || p.text || p.caption || p.label;
    return DEFS[clip.graphic.type].label + (first ? ' - ' + String(first).slice(0, 24) : '');
  }

  return {
    DEFS, TYPES, GROUPS, REVEAL, DIAGRAM_FALLBACK,
    defaultGraphic, normalize, normalizeClip, hasGraphic, title,
    paramAt, paramsAt,
    draw, bounds, animatedBounds,
    stagger, scale, tickLabel, decimalsOf, layoutDiagram, parseSpec, parseValues, parseLabels,
    svgPaths, parseViewBox, pxMin, rgba, mix, niceStep, roundRect,
  };
})();
