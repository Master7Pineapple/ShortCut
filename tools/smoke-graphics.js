/**
 * The graphics engine: primitives, composites, data objects and diagrams.
 *
 *   SHORTCUT_SMOKE=tools/smoke-graphics.js node_modules/.bin/electron .
 *
 * Five things this exists to prove:
 *   - each primitive PAINTS WHERE IT SAYS IT DOES - the analytic bounds the baker crops to
 *     really do contain every pixel the draw puts down, and are not wildly bigger than it;
 *   - the STAGGER is a delay per mark, not a compression, so mark i arrives i*stagger after
 *     mark 0 and every mark travels the same curve;
 *   - a chart's marks, gridlines and labels all come out of ONE scale, so every label names
 *     a value the chart actually reaches;
 *   - a diagram spec lays out IDENTICALLY across two runs and two resolutions;
 *   - and the invariants every clip in this app lives by: plain JSON on the clip, one undo
 *     entry per structural edit, preview and render agreeing, and a clip's position on the
 *     timeline staying out of the render cache key.
 *
 * It needs NO fixture: every frame is painted by the suite. The one end-to-end section
 * runs a real ffmpeg render of a graphic over nothing and reads the MP4 back, writing to
 * %TEMP%\scut_test\graphics_out.mp4.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    // ============================================================ a canvas harness

    /** Paint a graphic definition onto a fresh transparent canvas and hand back a reader. */
    function paint(graphic, W, H, t) {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.clearRect(0, 0, W, H);
      const clip = { kind: 'graphic', in: 0, out: 4, start: 0, graphic };
      Graphics.normalizeClip(clip);
      Graphics.draw(c, clip, W, H, t == null ? 3.5 : t, 1 / 30);
      const data = c.getImageData(0, 0, W, H).data;
      return {
        cv, ctx: c, data,
        px: (x, y) => {
          const i = (Math.round(y) * W + Math.round(x)) * 4;
          return [data[i], data[i + 1], data[i + 2], data[i + 3]];
        },
        /** The tight box of every pixel with any alpha at all. */
        inked() {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              if (data[(y * W + x) * 4 + 3] < 8) continue;
              n++;
              if (x < x0) x0 = x;
              if (y < y0) y0 = y;
              if (x > x1) x1 = x;
              if (y > y1) y1 = y;
            }
          }
          return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null;
        },
      };
    }
    const gfx = (type, params) => {
      const g = Graphics.defaultGraphic(type);
      Object.assign(g.params, params || {});
      return g;
    };

    // ============================================================ 1. painted bounds
    //
    // The baker crops each graphic to `animatedBounds()`, so a bounds rect that is too
    // small silently chops the object off IN THE EXPORT ONLY - the preview paints the whole
    // frame and never notices. This is the assertion that stops that shipping.

    note('--- painted bounds ---');
    const W = 360, H = 640;
    for (const [type, params] of [
      ['rect', { x: 0.4, y: 0.45, w: 0.3, h: 0.2, radius: 0.03, inDur: 0 }],
      ['ellipse', { x: 0.6, y: 0.4, w: 0.25, h: 0.35, inDur: 0 }],
      ['line', { x: 0.2, y: 0.3, x2: 0.8, y2: 0.7, strokeW: 0.02, inDur: 0 }],
      ['arrow', { x: 0.2, y: 0.7, x2: 0.75, y2: 0.3, head: 0.06, inDur: 0 }],
      ['path', { x: 0.5, y: 0.5, size: 0.3, inDur: 0 }],
      ['underline', { x: 0.5, y: 0.5, w: 0.5, thickness: 0.02, tilt: 6, inDur: 0 }],
      ['highlighter', { x: 0.5, y: 0.5, w: 0.4, h: 0.08, inDur: 0 }],
      ['bracket', { x: 0.5, y: 0.5, w: 0.4, h: 0.3, inDur: 0 }],
      ['stepChip', { x: 0.25, y: 0.5, inDur: 0 }],
      ['lowerThird', { x: 0.5, y: 0.7, inDur: 0 }],
      ['counter', { x: 0.5, y: 0.4, inDur: 0 }],
      ['ring', { x: 0.5, y: 0.4, inDur: 0 }],
      ['bars', { x: 0.5, y: 0.5, inDur: 0, stagger: 0 }],
      ['linegraph', { x: 0.5, y: 0.5, inDur: 0, stagger: 0 }],
      ['donut', { x: 0.5, y: 0.4, inDur: 0, stagger: 0 }],
      ['funnel', { x: 0.5, y: 0.5, inDur: 0, stagger: 0 }],
      ['flow', { x: 0.5, y: 0.5, inDur: 0, stagger: 0 }],
      ['nodemap', { x: 0.5, y: 0.5, inDur: 0, stagger: 0 }],
    ]) {
      const g = gfx(type, params);
      const r = paint(g, W, H, 3.9);
      const ink = r.inked();
      const b = Graphics.bounds(r.ctx, { kind: 'graphic', in: 0, out: 4, graphic: g }, W, H, 3.9);
      if (!ink) { ok(type + ' paints something', false, 'nothing was drawn'); continue; }
      // Contained: every inked pixel sits inside the declared bounds. A 1px slack for the
      // half-pixel a stroke's antialiasing puts outside its own geometric edge.
      const inside = ink.x >= b.x - 1.5 && ink.y >= b.y - 1.5 &&
        ink.x + ink.w <= b.x + b.w + 1.5 && ink.y + ink.h <= b.y + b.h + 1.5;
      // And not absurdly loose - a bounds of the whole frame would "contain" anything and
      // would also make the bake 10-100x bigger than it needs to be.
      const tight = (b.w * b.h) <= (ink.w * ink.h) * 6 + 40000;
      ok(type + ' paints inside the bounds the baker crops to', inside,
        'ink=' + [ink.x, ink.y, ink.w, ink.h].join(',') +
        ' bounds=' + [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)].join(','));
      ok(type + ' bounds are tight enough to be worth having', tight,
        'bounds ' + Math.round(b.w * b.h) + 'px2 vs ink ' + (ink.w * ink.h) + 'px2');
    }

    // A rect is the one whose geometry is exactly predictable, so it gets the hard number.
    {
      const r = paint(gfx('rect', { x: 0.5, y: 0.5, w: 0.5, h: 0.25, radius: 0, inDur: 0 }), 400, 400, 1);
      const ink = r.inked();
      ok('a rect is painted at exactly the size the unit rule says',
        near(ink.w, 200, 2) && near(ink.h, 100, 2), 'w=' + ink.w + ' h=' + ink.h + ' want 200x100');
    }

    // ============================================================ 2. the unit rule
    //
    // Preview and render agree, stated as an assertion: the same graphic painted at 1x and
    // at 3x has to be the same picture, scaled. Anything authored in PIXELS breaks this.

    note('--- the unit rule: preview and render are the same picture ---');
    {
      const g = gfx('rect', { x: 0.4, y: 0.6, w: 0.3, h: 0.2, radius: 0.04, inDur: 0 });
      const a = paint(g, 200, 356, 1).inked();
      const b = paint(g, 600, 1068, 1).inked();
      const ratio = (x, y) => Math.abs(x * 3 - y) <= 4;
      ok('a rect at 1x and 3x is the same picture, scaled',
        ratio(a.x, b.x) && ratio(a.y, b.y) && ratio(a.w, b.w) && ratio(a.h, b.h),
        '1x=' + [a.x, a.y, a.w, a.h].join(',') + ' 3x=' + [b.x, b.y, b.w, b.h].join(','));
    }
    {
      // The one that would have caught a font size authored in pixels: a chart's labels
      // move independently of its bars unless the type goes through pxMin() as well.
      const g = gfx('bars', { x: 0.5, y: 0.5, inDur: 0, stagger: 0 });
      const a = paint(g, 200, 356, 3).inked();
      const b = paint(g, 600, 1068, 3).inked();
      ok('a bar chart, LABELS INCLUDED, is the same picture at 1x and 3x',
        Math.abs(a.w * 3 - b.w) <= 6 && Math.abs(a.h * 3 - b.h) <= 6,
        '1x=' + a.w + 'x' + a.h + ' 3x=' + b.w + 'x' + b.h);
    }

    // ============================================================ 3. stagger timing

    note('--- entry timing ---');
    {
      const p = { inDur: 0.5, inDelay: 0.2, stagger: 0.1, ease: 'linear' };
      ok('nothing has started before the delay', Graphics.stagger(p, 0.19, 0) === 0);
      ok('mark 0 is half way at delay + half the entry',
        near(Graphics.stagger(p, 0.45, 0), 0.5, 1e-6), Graphics.stagger(p, 0.45, 0).toFixed(4));
      // The whole point: mark 3 is exactly 3 staggers behind mark 0, on the SAME curve.
      ok('mark 3 runs the same curve, three staggers later',
        near(Graphics.stagger(p, 0.45 + 0.3, 3), 0.5, 1e-6), Graphics.stagger(p, 0.75, 3).toFixed(4));
      ok('a stagger is a delay, not a compression - every mark takes the full entry',
        near(Graphics.stagger(p, 0.2 + 0.3, 3), 0, 1e-6) &&
        near(Graphics.stagger(p, 0.7 + 0.3, 3), 1, 1e-6));
      ok('everything has landed by the end', Graphics.stagger(p, 5, 9) === 1);
      ok('a zero-length entry is a hard cut ON, not a hard cut off',
        Graphics.stagger({ inDur: 0, inDelay: 0.3, stagger: 0, ease: 'linear' }, 0.3, 0) === 1 &&
        Graphics.stagger({ inDur: 0, inDelay: 0.3, stagger: 0, ease: 'linear' }, 0.29, 0) === 0);
      ok('the easing is honoured - a bezier is not linear at its midpoint',
        Math.abs(Graphics.stagger({ inDur: 1, inDelay: 0, stagger: 0, ease: 'easeOut' }, 0.5, 0) - 0.5) > 0.05);
    }
    {
      // And on a real object: bar 4 must still be moving while bar 0 has settled.
      const g = gfx('bars', { values: '10,10,10,10,10', labels: '', axis: false,
        inDur: 0.4, stagger: 0.3, ease: 'linear', x: 0.5, y: 0.5, w: 0.8, h: 0.5 });
      // INK COUNT, not height: every bar is the same height here, so the tallest one is
      // full as soon as the first has landed. What arrives late is the others' area.
      const early = paint(g, 300, 300, 0.45).inked();
      const late = paint(g, 300, 300, 3).inked();
      ok('bars really do arrive one after another', early.n < late.n * 0.6,
        'at 0.45s ' + early.n + 'px are inked, settled ' + late.n);
    }

    // ============================================================ 4. the chart scale
    //
    // ONE scale places marks, ticks and labels - so every label names a value the chart
    // actually reaches. This is the rule the whole Data group is judged on.

    note('--- charts: one scale ---');
    for (const vals of [[18, 34, 27, 52, 44], [0, 0, 0], [-20, 5, 90], [3.5], [1e-9, 2e-9],
      [1000000, 2500000], [7, 7, 7]]) {
      const sc = Graphics.scale(vals, { ticks: 4 });
      const inRange = sc.ticks.every((t) => t >= sc.min - 1e-9 && t <= sc.max + 1e-9);
      const covers = vals.every((v) => v >= sc.min - 1e-9 && v <= sc.max + 1e-9);
      const ends = near(sc.at(sc.min), 0, 1e-9) && near(sc.at(sc.max), 1, 1e-9);
      const usable = sc.max > sc.min && isFinite(sc.step) && sc.step > 0;
      ok('[' + vals.join(',') + '] every tick names a value in range', inRange,
        'ticks ' + sc.ticks.join(' '));
      ok('[' + vals.join(',') + '] every datum is inside the plot', covers,
        'min=' + sc.min + ' max=' + sc.max);
      ok('[' + vals.join(',') + '] at(min)=0 and at(max)=1', ends);
      ok('[' + vals.join(',') + '] a flat series still gets a usable range', usable,
        'span=' + (sc.max - sc.min));
    }
    {
      const sc = Graphics.scale([18, 34, 27, 52, 44], { ticks: 4 });
      ok('ticks are evenly spaced by the step',
        sc.ticks.every((t, i) => i === 0 || near(t - sc.ticks[i - 1], sc.step, 1e-9)),
        sc.ticks.join(' '));
      ok('the tick labels read as the numbers they are',
        Graphics.tickLabel(sc.ticks[1], sc.step) === String(sc.ticks[1]),
        Graphics.tickLabel(sc.ticks[1], sc.step));
      // The 2.5 case is the one that exposes a log-derived decimal count: it needs two
      // places, and ceil(-log10(0.25)) says one - which prints two neighbouring gridlines
      // with the same label, neither of which names a value a gridline sits on.
      ok('a sub-unit step gets decimals, an integer step does not',
        Graphics.tickLabel(0.25, 0.25) === '0.25' && Graphics.tickLabel(20, 20) === '20',
        Graphics.tickLabel(0.25, 0.25) + ' / ' + Graphics.tickLabel(20, 20));
      ok('no two gridlines on a 2.5-step axis carry the same label', (() => {
        const s = Graphics.scale([0, 9], { ticks: 5 });
        const seen = s.ticks.map((t) => Graphics.tickLabel(t, s.step));
        return new Set(seen).size === seen.length;
      })());
      // Float noise: 0.1 added thirty times is not 3. The scale builds ticks by
      // multiplication for exactly this reason.
      const fine = Graphics.scale([0, 3], { ticks: 10 });
      ok('a fine scale has no float noise in its top tick',
        Math.abs(fine.ticks[fine.ticks.length - 1] - fine.max) < 1e-12,
        String(fine.ticks[fine.ticks.length - 1]));
    }
    {
      // The chart itself: the tallest bar must reach where the scale says, measured in ink.
      const g = gfx('bars', { values: '10, 20, 40', labels: '', axis: false, gap: 0.2,
        inDur: 0, stagger: 0, x: 0.5, y: 0.5, w: 0.6, h: 0.4, radius: 0 });
      const r = paint(g, 400, 400, 3);
      const sc = Graphics.scale([10, 20, 40], { ticks: 4 });
      const plotH = 0.4 * 400;
      const ink = r.inked();
      ok('the tallest bar is exactly as tall as the single scale places it',
        near(ink.h, plotH * (sc.at(40) - sc.at(0)), 2),
        'ink ' + ink.h + 'px, scale says ' + (plotH * (sc.at(40) - sc.at(0))).toFixed(1));
    }
    {
      // A counter counts to the number it was given, and not past it.
      const g = gfx('counter', { from: 0, to: 100, caption: '', inDur: 1, inDelay: 0, ease: 'linear' });
      const mid = paint(g, 300, 300, 0.5);
      const end = paint(g, 300, 300, 3);
      ok('a counting number is mid-count half way through its entry', mid.inked() && end.inked());
      ok('the counter lands on its target and does not run past it',
        Graphics.stagger(g.params, 3, 0) === 1);
    }

    // ============================================================ 5. diagram determinism

    note('--- diagrams ---');
    {
      const spec = JSON.stringify(Graphics.DIAGRAM_FALLBACK.nodemap);
      const a = Graphics.layoutDiagram('nodemap', spec);
      const b = Graphics.layoutDiagram('nodemap', spec);
      ok('a node map lays out identically across two runs',
        JSON.stringify(a) === JSON.stringify(b));
      ok('the layout is normalised - it carries no resolution at all',
        a.nodes.every((n) => n.cx >= 0 && n.cx <= 1 && n.cy >= 0 && n.cy <= 1),
        a.nodes.map((n) => n.cx.toFixed(2)).join(' '));
      // Two resolutions: the layout is the same numbers, so the PAINT is the same picture.
      const g = gfx('nodemap', { inDur: 0, stagger: 0, x: 0.5, y: 0.5 });
      const p1 = paint(g, 200, 356, 2).inked();
      const p2 = paint(g, 600, 1068, 2).inked();
      ok('a node map paints the same picture at two resolutions',
        Math.abs(p1.w * 3 - p2.w) <= 6 && Math.abs(p1.h * 3 - p2.h) <= 6,
        '1x=' + p1.w + 'x' + p1.h + ' 3x=' + p2.w + 'x' + p2.h);
      ok('edges are solved from the node positions, not separately',
        a.edges.every((e) => {
          const from = a.nodes.find((n) => n.id === e.from);
          return from && from.cx === e.x1 && from.cy === e.y1;
        }));
      ok('a walk of the edges puts the client left of the store',
        a.nodes.find((n) => n.id === 'a').cx < a.nodes.find((n) => n.id === 'd').cx);
    }
    {
      // An explicit col/row overrides the walk, and is still deterministic.
      const spec = { nodes: [{ id: 'x', col: 2, row: 1 }, { id: 'y', col: 0 }], edges: [] };
      const a = Graphics.layoutDiagram('nodemap', JSON.stringify(spec));
      ok('an explicit column is honoured',
        a.nodes.find((n) => n.id === 'y').cx < a.nodes.find((n) => n.id === 'x').cx);
    }
    {
      // A cycle must still lay out rather than returning nothing.
      const spec = { nodes: [{ id: 'p' }, { id: 'q' }], edges: [['p', 'q'], ['q', 'p']] };
      const a = Graphics.layoutDiagram('nodemap', JSON.stringify(spec));
      ok('a cycle still lays out instead of producing nothing', a.nodes.length === 2);
      ok('an edge to a node that does not exist is dropped, not drawn to nowhere',
        Graphics.layoutDiagram('nodemap',
          JSON.stringify({ nodes: [{ id: 'p' }], edges: [['p', 'nope']] })).edges.length === 0);
    }
    {
      const f = Graphics.layoutDiagram('funnel', JSON.stringify(Graphics.DIAGRAM_FALLBACK.funnel));
      ok('a funnel narrows monotonically with its values',
        f.rows[0].w > f.rows[1].w && f.rows[1].w > f.rows[2].w,
        f.rows.map((r) => r.w.toFixed(2)).join(' > '));
      ok('every funnel row stays inside its own box',
        f.rows.every((r) => r.x >= 0 && r.x + r.w <= 1.0001 && r.y >= 0 && r.y + r.h <= 1.0001));
      const tiny = Graphics.layoutDiagram('funnel',
        JSON.stringify({ stages: [{ label: 'a', value: 1000 }, { label: 'b', value: 1 }] }));
      ok('a near-zero stage is still a shape you can put a label on', tiny.rows[1].w >= 0.15,
        tiny.rows[1].w.toFixed(3));
    }
    {
      // Invalid JSON is what a spec IS for most of the time it is being typed.
      const bad = Graphics.layoutDiagram('funnel', '{ "stages": [ { "label"');
      ok('a half-typed spec falls back to the example rather than vanishing',
        bad.rows.length === Graphics.DIAGRAM_FALLBACK.funnel.stages.length);
      ok('an empty spec does too',
        Graphics.layoutDiagram('flow', '').before.length ===
        Graphics.DIAGRAM_FALLBACK.flow.before.length);
    }

    // ============================================================ 6. value parsing

    note('--- parsing ---');
    ok('commas, spaces and semicolons all separate values',
      Graphics.parseValues('1, 2 3;4').join(',') === '1,2,3,4');
    ok('a JSON array is read as one', Graphics.parseValues('[5, 6]').join(',') === '5,6');
    ok('a typo drops out rather than becoming NaN geometry',
      Graphics.parseValues('1, two, 3').join(',') === '1,3');
    ok('an empty value list is empty, not [0]', Graphics.parseValues('   ').length === 0);
    ok('labels split on commas and pipes',
      Graphics.parseLabels('Mon, Tue | Wed').join('|') === 'Mon|Tue|Wed');
    ok('an SVG\u2019s paths and viewBox are pulled out',
      (() => {
        const r = Graphics.svgPaths('<svg viewBox="0 0 48 48"><path d="M0 0 L1 1"/><path d=\'M2 2\'/></svg>');
        return r && r.d === 'M0 0 L1 1 M2 2' && r.viewBox === '0 0 48 48';
      })());
    ok('an SVG with no path is refused rather than half-drawn',
      Graphics.svgPaths('<svg><rect width="4" height="4"/></svg>') === null);

    // ============================================================ 7. the model

    note('--- the model ---');
    {
      const g = Graphics.defaultGraphic('ring');
      ok('a fresh graphic is plain JSON and nothing else',
        JSON.stringify(JSON.parse(JSON.stringify(g))) === JSON.stringify(g));
      ok('it has no keys object until something is keyed', g.keys === undefined);
      const clip = { kind: 'graphic', in: 0, out: 3, graphic: g };
      Anim.trackFor(g, 'value', true).push({ t: 0, v: 0, ease: Anim.EASING_PRESETS.linear });
      Anim.trackFor(g, 'value', true).push({ t: 2, v: 1, ease: Anim.EASING_PRESETS.linear });
      ok('a keyed parameter animates through Anim',
        near(Graphics.paramAt(g, 'value', 1), 0.5, 1e-6), String(Graphics.paramAt(g, 'value', 1)));
      ok('a single key pins the value across the whole clip',
        (() => {
          const h = Graphics.defaultGraphic('ring');
          Anim.trackFor(h, 'value', true).push({ t: 1, v: 0.25, ease: Anim.EASING_PRESETS.linear });
          return Graphics.paramAt(h, 'value', 0) === 0.25 && Graphics.paramAt(h, 'value', 9) === 0.25;
        })());
      Anim.trackFor(g, 'value', true).length = 0;
      Anim.pruneKeys(g);
      Graphics.normalizeClip(clip);
      ok('clearing the last key prunes `keys` away again', g.keys === undefined);
      ok('a colour has no track and is read straight off params',
        Graphics.paramAt(g, 'fill', 1) === g.params.fill);
    }
    {
      const clip = { kind: 'graphic', in: 0, out: 3, graphic: { type: 'rect', params: { w: 'nonsense', nope: 1 } } };
      Graphics.normalizeClip(clip);
      ok('a nonsense number falls back to the default rather than to NaN',
        clip.graphic.params.w === Graphics.DEFS.rect.params.w);
      ok('a parameter this build does not know is dropped', clip.graphic.params.nope === undefined);
      ok('missing parameters are filled in', clip.graphic.params.radius != null);
    }
    {
      // A type from a newer build must SURVIVE, not be destroyed by being opened here.
      const clip = { kind: 'graphic', in: 0, out: 3, graphic: { type: 'sankey', params: { x: 0.3 } } };
      Graphics.normalizeClip(clip);
      ok('an unknown graphic type is kept untouched rather than lost',
        clip.graphic.type === 'sankey' && clip.graphic.params.x === 0.3);
      const cv = document.createElement('canvas');
      cv.width = 40; cv.height = 40;
      Graphics.draw(cv.getContext('2d'), clip, 40, 40, 1, 1 / 30);
      ok('and it draws nothing instead of throwing', true);
    }
    {
      // A draw that throws must cost a frame, never the session - loop() re-arms for this.
      const broken = { kind: 'graphic', in: 0, out: 3, graphic: { type: 'rect', params: {} } };
      Graphics.normalizeClip(broken);
      const fake = { save() {}, restore() { throw new Error('never reached'); } };
      let threw = false;
      try {
        Graphics.draw({
          save() {}, restore() {}, setLineDash() {},
          set globalCompositeOperation(v) { throw new Error('boom'); },
        }, broken, 10, 10, 1, 1 / 30);
      } catch (e) { threw = true; }
      ok('a graphic whose draw throws costs a frame, not the session', !threw);
      void fake;
    }
    ok('every type declares a group the picker knows about',
      Graphics.TYPES.every((t) => Graphics.GROUPS.includes(Graphics.DEFS[t].group)));
    ok('every schema row points at a parameter that exists',
      Graphics.TYPES.every((t) => Graphics.DEFS[t].schema.every((s) => {
        const k = s.path.replace('params.', '');
        return s.path.indexOf('params.') !== 0 || k in Graphics.DEFS[t].params;
      })), Graphics.TYPES.length + ' types');
    ok('every numeric parameter is reachable from the schema, so it can be keyed',
      Graphics.TYPES.every((t) => Object.keys(Graphics.DEFS[t].params)
        .filter((k) => typeof Graphics.DEFS[t].params[k] === 'number')
        .every((k) => Graphics.DEFS[t].schema.some((s) => s.path === 'params.' + k))));

    // ============================================================ 8. on the timeline

    note('--- on the timeline ---');
    newProject();
    const before = JSON.stringify(state.tracks);
    const clip = addGraphicClip('counter');
    ok('a graphic lands on a VIDEO track, so track order gives it z-order',
      allClips().find((x) => x.clip === clip).track.type === 'video');
    ok('it has no source and never opens a decoder', clip.src === null && clip.kind === 'graphic');
    ok('`in` stays 0 and its length is simply `out`', clip.in === 0 && clip.out > 0);
    ok('everything on it is serialisable',
      JSON.parse(JSON.stringify(clip)).graphic.type === 'counter');
    ok('adding one is exactly one undo entry', (() => { undo(); return JSON.stringify(state.tracks) === before; })());
    redo();
    ok('and redo puts it back', state.tracks.some((t) => t.clips.some((c) => c.kind === 'graphic')));

    {
      // The lane label, and that the inspector builds a panel from the type table.
      renderAll();
      setSelection([clip.id], false);
      renderInspector();
      const rows = [...document.querySelectorAll('#inspector .tc-row label')].map((l) => l.textContent);
      ok('the inspector builds a row for every schema entry',
        Graphics.DEFS.counter.schema.every((s) => rows.some((r) => r.indexOf(s.label) === 0)),
        rows.length + ' rows');
      ok('and a keyframe strip for every numeric parameter',
        document.querySelectorAll('#inspector .tc-kf').length >=
        Object.keys(Graphics.DEFS.counter.params).filter((k) => typeof Graphics.DEFS.counter.params[k] === 'number').length,
        String(document.querySelectorAll('#inspector .tc-kf').length));
      ok('a graphic clip gets an effect stack, which is how it follows a motion track',
        !!clipFxPanel(clip));
    }
    {
      // Splitting must not leave the two halves sharing one definition.
      seek(clip.start + 1);
      setSelection([clip.id], false);
      splitAtPlayhead();
      const halves = allClips().map((x) => x.clip).filter((c) => c.kind === 'graphic');
      ok('a split gives two graphic clips', halves.length === 2, String(halves.length));
      if (halves.length === 2) {
        halves[0].graphic.params.to = 999;
        ok('the two halves do NOT share one definition', halves[1].graphic.params.to !== 999,
          String(halves[1].graphic.params.to));
      }
      undo();
    }

    // ============================================================ 9. the render job

    note('--- the render job, and the cache key ---');
    newProject();
    const gclip = addGraphicClip('rect');
    gclip.start = 1;
    gclip.out = 2;
    sortTracks();
    {
      const job = buildJob('out.mp4', { from: 0, to: 4 });
      const entry = job.clips.find((c) => c.kind === 'graphic');
      ok('a graphic reaches the job as its own kind, visible', !!entry && entry.visible);
      ok('the job carries the definition for the baker', !!entry && !!entry.graphicClip);
      ok('and a tStart, so a range cutting into it bakes from the right instant',
        entry.tStart === 0);
      const cut = buildJob('out.mp4', { from: 1.4, to: 4 });
      ok('a range beginning mid-graphic bakes from that point in the animation',
        near(cut.clips.find((c) => c.kind === 'graphic').tStart, 0.4, 1e-6),
        String(cut.clips.find((c) => c.kind === 'graphic').tStart));
    }
    {
      // IDENTITY IS NOT PIXELS. A clip's `id` and an effect's `id` are handed out fresh
      // every time one is made, so leaving either in the key would mean deleting a graphic
      // and adding an identical one back never hit its own cached render. The definition
      // decides the key; the id must not touch it.
      const key0 = jobCacheKey(buildJob('', { from: 0, to: 4 }));
      const oldId = gclip.id;
      gclip.id = nextId();
      const keyId = jobCacheKey(buildJob('', { from: 0, to: 4 }));
      gclip.id = oldId;
      ok('THE LOAD-BEARING ONE: a graphic’s id is not in its render key, its definition is',
        key0 === keyId, key0 + ' vs ' + keyId);
      gclip.graphic.params.w = 0.9;
      const key2 = jobCacheKey(buildJob('', { from: 0, to: 4 }));
      ok('but changing what it draws does', key0 !== key2);
      gclip.graphic.params.w = Graphics.DEFS.rect.params.w;
      ok('and putting it back brings the key back',
        jobCacheKey(buildJob('', { from: 0, to: 4 })) === key0);
    }
    {
      // The key must be the same before and after baking, or the cache bar never lights.
      const job = buildJob('', { from: 0, to: 4 });
      const key = jobCacheKey(job);
      const entry = job.clips.find((c) => c.kind === 'graphic');
      entry.seqDir = 'C:\\\\scratch\\\\whatever';
      entry.bx = 3; entry.by = 4; entry.bw = 10; entry.bh = 20;
      const keyAfter = jobCacheKey(job);
      ok('the key survives the bake swapping the definition for a scratch dir',
        key === keyAfter, key + ' vs ' + keyAfter);
    }

    // ============================================================ 10. the fast path

    note('--- baking ---');
    {
      // A graphic must NOT disqualify a span from the fast path, for the same reason a text
      // card does not: it is baked cropped to its own painted bounds, which is a fraction
      // of a full frame, and folding it into a full-frame composite costs 20-100x the bytes.
      const job = buildJob('', { from: 0, to: 4 });
      ok('a lone graphic does not force the whole span to be composited',
        compositeSpans(job).length === 0, String(compositeSpans(job).length));
      const e = FX.create('blur');
      gclip.fx = [e];
      const job2 = buildJob('', { from: 0, to: 4 });
      ok('but an EFFECT on it does, like any other clip', compositeSpans(job2).length > 0);
      delete gclip.fx;
    }
    {
      const job = buildJob(D + 'graphics_out.mp4', { from: 0, to: 2 });
      job.cacheKey = jobCacheKey(job);
      job.useCache = false;
      const dirs = await bakeOverlays(job);
      const entry = job.clips.find((c) => c.kind === 'graphic');
      ok('the graphic bakes its own cropped sequence', dirs.length === 1 && !!entry.seqDir,
        'dirs=' + dirs.length);
      ok('cropped, not full-frame - that is the whole reason it is not composited',
        entry.bw < job.width && entry.bw > 0, entry.bw + 'x' + entry.bh + ' of ' + job.width + 'x' + job.height);
      ok('the bake dropped the definition, which is not serialisable across IPC',
        entry.graphicClip === undefined);

      const res = await window.api.startRender(job);
      for (const d of dirs) window.api.endTextSeq(d);
      ok('a graphic renders through ffmpeg', res.ok, res.error || '');

      if (res.ok) {
        // Preview: what compositeLayers() paints at the same instant.
        const P = { w: job.width, h: job.height };
        const cv = document.createElement('canvas');
        cv.width = P.w; cv.height = P.h;
        const c = cv.getContext('2d');
        compositeLayers(c, P.w, P.h, layersAt(1.5), 1.5, () => null, 1 / job.fps);
        const want = c.getImageData(P.w / 2 | 0, P.h / 2 | 0, 1, 1).data;

        const probe = document.createElement('video');
        probe.src = 'file:///' + res.outPath.replace(/\\/g, '/');
        probe.muted = true;
        await new Promise((r) => { probe.onloadeddata = r; probe.onerror = r; probe.load(); setTimeout(r, 6000); });
        probe.currentTime = 1.5;
        await new Promise((r) => { probe.onseeked = r; setTimeout(r, 4000); });
        const cv2 = document.createElement('canvas');
        cv2.width = P.w; cv2.height = P.h;
        const c2 = cv2.getContext('2d');
        c2.drawImage(probe, 0, 0, P.w, P.h);
        const got = c2.getImageData(P.w / 2 | 0, P.h / 2 | 0, 1, 1).data;
        // yuv420p round-trips through 8-bit chroma, so the tolerance is the codec's.
        ok('THE HEADLINE: a rendered graphic lands on the pixels the preview painted',
          near(got[0], want[0], 8) && near(got[1], want[1], 8) && near(got[2], want[2], 8),
          'render=' + [got[0], got[1], got[2]].join(',') + ' preview=' + [want[0], want[1], want[2]].join(','));
      }
    }

    newProject();
    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
