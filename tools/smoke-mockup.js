/**
 * The product-footage framing treatments: chrome, background, spotlight, cutout.
 *
 *   SHORTCUT_SMOKE=tools/smoke-mockup.js node_modules/.bin/electron .
 *
 * Three things this exists to prove, one per treatment that has something to get wrong:
 *
 *   - FRAME GEOMETRY at several aspect ratios. `chromeGeom()` is the only thing that
 *     decides where a device lands, so it is checked as arithmetic rather than by
 *     hunting for pixels - a layout bug and a paint bug then cannot be confused for
 *     each other. It is checked at 9:16, 1:1 and 16:9 output, at four presets, and at
 *     both preview and export resolution.
 *
 *   - SPOTLIGHT MASK ALPHA. The trap this codebase has hit three times: `destination-in`
 *     composites on the ALPHA channel, so a mask painted as opaque black-and-white is
 *     opaque everywhere and masks NOTHING. That failure looks like "the spotlight lights
 *     the whole frame", so the assertion below is specifically that a corner is dark
 *     while the middle is not - which an opaque mask cannot pass.
 *
 *   - CUTOUT SOURCE-TO-DESTINATION MAPPING, again as arithmetic and then once in pixels:
 *     a patch of known colour in the source region must turn up in the destination rect.
 *
 * Plus the two rules the whole file lives by - a blur that does not magnify, and the same
 * parameters painting the same picture at 1x and 4x - and the ordering rule that makes
 * `background` mean anything at all.
 *
 * Needs no media: every effect here is a pure canvas function.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    // ============================================================ a canvas harness
    //
    // The same shape smoke-fx.js uses, and separate from the app's pool for the same
    // reason: a test must never be reading a canvas the viewer is halfway through.
    const pool = new Map();
    const surface = (name, w, h) => {
      let cv = pool.get(name);
      if (!cv) { cv = document.createElement('canvas'); pool.set(name, cv); }
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      return cv;
    };
    const paintFill = (colour) => (c, W, H) => { c.fillStyle = colour; c.fillRect(0, 0, W, H); };
    function run(fx, W, H, bg, paint, t) {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.clearRect(0, 0, W, H);
      if (bg) { c.fillStyle = bg; c.fillRect(0, 0, W, H); }
      FX.render(c, W, H, { fx }, t || 0, surface, paint || paintFill('#ff0000'));
      const px = (x, y) => {
        const d = c.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      return { cv, ctx: c, px };
    }
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const fx = (type, params) => Object.assign(FX.create(type),
      { params: Object.assign(FX.create(type).params, params || {}) });

    // ============================================================ 1. the four exist
    for (const type of ['chrome', 'background', 'spotlight', 'cutout']) {
      ok('FX.DEFS carries "' + type + '" with a label, defaults, a schema and a draw',
        !!FX.DEFS[type] && !!FX.DEFS[type].label && !!FX.DEFS[type].params &&
        Array.isArray(FX.DEFS[type].schema) && typeof FX.DEFS[type].draw === 'function');
      ok('  every "' + type + '" schema row points at a parameter that exists',
        FX.DEFS[type].schema.every((s) => {
          const m = /^params\.(.+)$/.exec(s.path);
          return m && (m[1] in FX.DEFS[type].params);
        }));
    }
    ok('none of the four needs recorded telemetry, so none is greyed out in the menu',
      ['chrome', 'background', 'spotlight', 'cutout'].every((t) => !FX.DEFS[t].needs));

    // ============================================================ 2. frame geometry
    //
    // Chrome's whole layout, at several aspect ratios, without painting anything.
    {
      const P = (o) => Object.assign({}, FX.DEFS.chrome.params, o || {});
      const sizes = [[1080, 1920], [1000, 1000], [1920, 1080], [135, 240]];
      let fits = true, aspects = true, inside = true, where = '';
      for (const [W, H] of sizes) {
        for (const preset of Object.keys(FX.CHROME)) {
          for (const aspect of [0, 0.6, 1, 1.78, 2.4]) {
            const p = P({ preset, aspect, pad: 0.05 });
            const g = FX.chromeGeom(p, W, H);
            if (!g) { fits = false; where = preset + ' ' + W + 'x' + H + ' ar' + aspect; continue; }
            const padPx = 0.05 * Math.min(W, H);
            // Everything the device draws, base included, stays inside the padding.
            const left = Math.min(g.frame.x, g.base ? g.base.x : g.frame.x);
            const right = Math.max(g.frame.x + g.frame.w, g.base ? g.base.x + g.base.w : 0);
            const bottom = (g.base ? g.base.y + g.base.h : g.frame.y + g.frame.h);
            if (left < padPx - 0.6 || right > W - padPx + 0.6 ||
                g.frame.y < padPx - 0.6 || bottom > H - padPx + 0.6) {
              fits = false; where = preset + ' ' + W + 'x' + H + ' ar' + aspect +
                ' [' + left.toFixed(1) + ',' + right.toFixed(1) + ',' + bottom.toFixed(1) + ']';
            }
            // The screen is the aspect that was asked for, or the preset's own at 0.
            const want = aspect > 0.01 ? aspect : FX.CHROME[preset].aspect;
            if (!near(g.screen.w / g.screen.h, want, 0.02)) {
              aspects = false; where = preset + ' wanted ' + want + ' got ' + (g.screen.w / g.screen.h).toFixed(3);
            }
            // The screen is inside the body, and below the title bar when there is one.
            if (g.screen.x < g.frame.x - 0.01 || g.screen.y < g.frame.y + g.bar.h - 0.01 ||
                g.screen.x + g.screen.w > g.frame.x + g.frame.w + 0.01 ||
                g.screen.y + g.screen.h > g.frame.y + g.frame.h + 0.01) {
              inside = false; where = preset + ' screen escapes the body';
            }
          }
        }
      }
      ok('a device frame fits inside its padding at every preset, aspect and output shape',
        fits, where);
      ok('the screen is the aspect ratio it was asked for, and the preset s own at 0',
        aspects, where);
      ok('the screen sits inside the body, below the title bar', inside, where);

      // Scale-invariance, which is the unit rule stated as arithmetic. Same parameters,
      // two resolutions exactly 8x apart, every number 8x apart.
      const small = FX.chromeGeom(P({ preset: 'browser' }), 135, 240);
      const large = FX.chromeGeom(P({ preset: 'browser' }), 1080, 1920);
      const pairs = [['frame.x', 'frame.y', 'frame.w', 'frame.h'],
        ['bar.h'], ['screen.x', 'screen.y', 'screen.w', 'screen.h'], ['radius'], ['innerRadius']].flat();
      const get = (g, path) => path.split('.').reduce((o, k) => o[k], g);
      let worst = 0, atPath = '';
      for (const path of pairs) {
        const d = Math.abs(get(small, path) * 8 - get(large, path));
        if (d > worst) { worst = d; atPath = path; }
      }
      ok('THE UNIT RULE: the same chrome parameters lay out identically at 1x and 8x',
        worst < 0.001, 'worst ' + worst.toFixed(6) + ' at ' + atPath);

      // The presets are shapes, not sizes: what each one has, it has.
      ok('the two browser presets have a title bar and the two devices do not',
        FX.chromeGeom(P({ preset: 'browser' }), 1080, 1920).bar.h > 1 &&
        FX.chromeGeom(P({ preset: 'browserDark' }), 1080, 1920).bar.h > 1 &&
        FX.chromeGeom(P({ preset: 'laptop' }), 1080, 1920).bar.h === 0 &&
        FX.chromeGeom(P({ preset: 'phone' }), 1080, 1920).bar.h === 0);
      ok('only the laptop has a base, and it hangs below the body',
        !FX.chromeGeom(P({ preset: 'browser' }), 1080, 1920).base &&
        FX.chromeGeom(P({ preset: 'laptop' }), 1080, 1920).base.y >=
          FX.chromeGeom(P({ preset: 'laptop' }), 1080, 1920).frame.y +
          FX.chromeGeom(P({ preset: 'laptop' }), 1080, 1920).frame.h - 0.01);
      ok('the phone is the portrait preset and the rest are landscape',
        FX.CHROME.phone.aspect < 1 && FX.CHROME.browser.aspect > 1 && FX.CHROME.laptop.aspect > 1);
      ok('the inner rounding follows the outer, inset by the bezel',
        large.innerRadius < large.radius && large.innerRadius >= 0);
      // The slider's own maximum can never starve the frame - it is clamped to 0.45, so
      // a tenth of the shorter side always survives. Only a frame small enough that the
      // padding eats it outright has no room, and that returns null rather than a device
      // with a negative width.
      ok('the maximum padding still leaves a frame',
        !!FX.chromeGeom(P({ pad: 0.5 }), 1080, 1920));
      ok('a frame the padding eats outright returns null, not a negative one',
        FX.chromeGeom(P({ pad: 0.45 }), 6, 6) === null);
      ok('an unknown preset falls back to the browser rather than throwing',
        !!FX.chromeGeom(P({ preset: 'notathing' }), 1080, 1920));
      ok('four presets ship, and every one of them is paths and colours - no bitmap',
        Object.keys(FX.CHROME).length === 4 &&
        Object.keys(FX.CHROME).every((k) => typeof FX.CHROME[k].aspect === 'number' &&
          !/^data:|\.png$|\.jpg$/i.test(String(FX.CHROME[k].body))));
    }

    // ============================================================ 3. chrome, painted
    {
      const W = 360, H = 640;
      const g = FX.chromeGeom(Object.assign({}, FX.DEFS.chrome.params, { preset: 'browser' }), W, H);
      const r = run([fx('chrome', { preset: 'browser', shadow: 0, pad: 0.06 })], W, H, null,
        paintFill('#ff0000'));
      const mid = r.px(g.screen.x + g.screen.w / 2, g.screen.y + g.screen.h / 2);
      ok('the footage is inside the screen', eq(mid, [255, 0, 0, 255]), mid.join(','));
      const bodyPx = r.px(g.frame.x + g.frame.w / 2, g.frame.y + g.bar.h * 0.5);
      ok('the title bar is drawn in the preset s own colour, not the footage',
        bodyPx[3] === 255 && !(bodyPx[0] === 255 && bodyPx[1] === 0), bodyPx.join(','));
      const outPx = r.px(2, 2);
      ok('OUTSIDE THE DEVICE IS TRANSPARENT - the frame cuts the layer, it does not fill it',
        outPx[3] === 0, outPx.join(','));
      // The corner of the screen rect is outside the rounding, so it must not be footage.
      const corner = r.px(g.screen.x + 1, g.screen.y + 1);
      ok('the screen is clipped to its rounded corners',
        !(corner[0] === 255 && corner[1] === 0 && corner[2] === 0), corner.join(','));
      const dark = run([fx('chrome', { preset: 'browserDark', shadow: 0 })], W, H, null, paintFill('#ff0000'));
      const gd = FX.chromeGeom(Object.assign({}, FX.DEFS.chrome.params, { preset: 'browserDark' }), W, H);
      const darkBody = dark.px(gd.frame.x + gd.frame.w / 2, gd.frame.y + gd.bar.h * 0.5);
      ok('the dark preset is darker than the light one', darkBody[0] < bodyPx[0],
        darkBody[0] + ' vs ' + bodyPx[0]);
      // The override is a SWITCH, not an empty colour - see the comment in fx.js.
      const tinted = run([fx('chrome', { preset: 'browser', shadow: 0, tinted: 1, tint: '#00ff00', pad: 0.06 })],
        W, H, null, paintFill('#ff0000'));
      const tp = tinted.px(g.frame.x + g.frame.w * 0.02, g.frame.y + g.frame.h * 0.5);
      ok('the body colour override is honoured only when its switch is on',
        tp[1] > 200 && tp[0] < 60, tp.join(','));
    }

    // ============================================================ 4. spotlight alpha
    //
    // THE MASK TRAP, asserted directly. An opaque black-and-white mask masks nothing, and
    // the symptom is that the whole frame stays lit - so the corner is the assertion.
    {
      const W = 200, H = 200;
      const p = { shape: 'rect', x: 0.3, y: 0.3, w: 0.4, h: 0.4, radius: 0, feather: 0, dim: 0.75, blur: 0 };
      const r = run([fx('spotlight', p)], W, H, null, paintFill('#ffffff'));
      const lit = r.px(100, 100);
      const dark = r.px(10, 10);
      ok('the lit region keeps the picture exactly', eq(lit, [255, 255, 255, 255]), lit.join(','));
      ok('THE ALPHA MASK: the corner is dimmed - an opaque mask would leave it lit',
        dark[0] < 80 && dark[3] === 255, dark.join(','));
      ok('  and it is dimmed by the amount asked for', near(dark[0], 255 * 0.25, 3), dark[0]);

      // Over transparency, `source-atop` is what stops black being painted into nothing.
      const overAlpha = run([fx('spotlight', p)], W, H, null, (c, w, h) => {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, w, h * 0.5);          // top half only
      });
      const empty = overAlpha.px(10, 190);
      ok('dimming an already-transparent half paints no black into it',
        empty[3] === 0, empty.join(','));
      ok('  while the half that has picture in it is still dimmed',
        overAlpha.px(10, 10)[0] < 80, overAlpha.px(10, 10).join(','));

      // Feather is a blur of the ALPHA, so the edge is a ramp rather than a step.
      const soft = run([fx('spotlight', Object.assign({}, p, { feather: 0.06 }))], W, H, null,
        paintFill('#ffffff'));
      const edge = soft.px(60, 100);           // right on the box's left edge
      ok('feather ramps the mask instead of stepping it',
        edge[0] > dark[0] + 12 && edge[0] < lit[0] - 12, edge.join(','));
      ok('  and it is still fully lit well inside the box', soft.px(100, 100)[0] > 250);

      // An ellipse must actually be an ellipse: the corners of its box fall outside it.
      const ell = run([fx('spotlight', Object.assign({}, p, { shape: 'ellipse' }))], W, H, null,
        paintFill('#ffffff'));
      ok('an ellipse leaves the corners of its own bounding box dark',
        ell.px(100, 100)[0] > 250 && ell.px(64, 64)[0] < 80,
        ell.px(64, 64).join(','));

      // Inverted: the treated copy is what shows through, and the rest stays sharp.
      const inv = run([fx('spotlight', Object.assign({}, p, { invert: 1 }))], W, H, null,
        paintFill('#ffffff'));
      ok('invert swaps which side is treated - a redaction rather than a spotlight',
        inv.px(100, 100)[0] < 80 && inv.px(10, 10)[0] > 250,
        inv.px(100, 100).join(',') + ' / ' + inv.px(10, 10).join(','));

      // A blur outside must not magnify - the picture's edge must stay where it was.
      const blurred = run([fx('spotlight', Object.assign({}, p, { dim: 0, blur: 0.05 }))], 200, 200,
        null, (c, w, h) => { c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h); });
      ok('a blurred outside does not magnify or eat the frame edge',
        blurred.px(2, 2)[3] > 240 && blurred.px(2, 2)[0] > 200, blurred.px(2, 2).join(','));
      ok('a spotlight asking for neither dim nor blur is a pixel-exact no-op',
        eq(run([fx('spotlight', Object.assign({}, p, { dim: 0, blur: 0 }))], W, H, null,
          paintFill('#ffffff')).px(10, 10), [255, 255, 255, 255]));
    }

    // ============================================================ 5. cutout mapping
    {
      const W = 400, H = 800;
      const P = (o) => Object.assign({}, FX.DEFS.cutout.params, o);
      const m = FX.cutoutRect(P({ sx: 0.1, sy: 0.2, sw: 0.3, sh: 0.1, x: 0.5, y: 0.7, scale: 2 }), W, H);
      ok('the source region is the fractions it was given, in pixels',
        m.src.x === 40 && m.src.y === 160 && m.src.w === 120 && m.src.h === 80,
        [m.src.x, m.src.y, m.src.w, m.src.h].join(','));
      ok('the destination is the source scaled by `scale`',
        m.dst.w === 240 && m.dst.h === 160, m.dst.w + 'x' + m.dst.h);
      ok('and it is CENTRED on x,y rather than cornered there',
        m.dst.x + m.dst.w / 2 === 200 && m.dst.y + m.dst.h / 2 === 560,
        (m.dst.x + m.dst.w / 2) + ',' + (m.dst.y + m.dst.h / 2));

      // Which is the whole reason for centring: `scale` carries keyframes, and a float
      // that grew from its top-left would slide across the frame as it grew.
      const a = FX.cutoutRect(P({ scale: 1 }), W, H);
      const b = FX.cutoutRect(P({ scale: 3 }), W, H);
      ok('scaling holds the destination centre still, so a keyframed scale does not slide',
        near(a.dst.x + a.dst.w / 2, b.dst.x + b.dst.w / 2, 1e-9) &&
        near(a.dst.y + a.dst.h / 2, b.dst.y + b.dst.h / 2, 1e-9));

      const s1 = FX.cutoutRect(P({}), 135, 240);
      const s8 = FX.cutoutRect(P({}), 1080, 1920);
      ok('the mapping scales exactly with the frame - preview and export agree',
        ['x', 'y', 'w', 'h'].every((k) => near(s1.src[k] * 8, s8.src[k], 1e-9) &&
          near(s1.dst[k] * 8, s8.dst[k], 1e-9)));

      // And once in pixels: a patch of known colour must turn up where the maths says.
      const paint = (c, w, h) => {
        c.fillStyle = '#202020';
        c.fillRect(0, 0, w, h);
        c.fillStyle = '#00c0ff';
        c.fillRect(0.1 * w, 0.2 * h, 0.3 * w, 0.1 * h);      // exactly the source region
      };
      const e = fx('cutout', { sx: 0.1, sy: 0.2, sw: 0.3, sh: 0.1, x: 0.5, y: 0.7, scale: 2,
        radius: 0, shadow: 0, dimSource: 0, outline: 0 });
      const r = run([e], W, H, null, paint);
      const inDst = r.px(200, 560);
      ok('the lifted region turns up in the destination rect',
        inDst[2] > 200 && inDst[1] > 150 && inDst[0] < 60, inDst.join(','));
      const justOut = r.px(200, 560 - m.dst.h / 2 - 4);
      ok('and nothing outside the destination rect is painted with it',
        justOut[0] === 32 && justOut[1] === 32, justOut.join(','));
      const srcStill = r.px(100, 180);
      ok('the source region is left in place - a cutout copies, it does not move',
        srcStill[2] > 200, srcStill.join(','));

      const dimmed = run([Object.assign(fx('cutout', e.params), {
        params: Object.assign({}, e.params, { dimSource: 0.6 }) })], W, H, null, paint);
      ok('dimming the source pushes it back without touching the float',
        dimmed.px(100, 180)[2] < srcStill[2] - 40 && dimmed.px(200, 560)[2] > 200,
        dimmed.px(100, 180).join(','));
      const overAlpha = run([Object.assign(fx('cutout', e.params), {
        params: Object.assign({}, e.params, { dimSource: 0.6 }) })], W, H, null, (c, w, h) => {
        c.fillStyle = '#00c0ff';
        c.fillRect(0.1 * w, 0.2 * h, 0.3 * w, 0.1 * h);       // ONLY the source region
      });
      ok('dimming the source paints no grey rectangle into transparency',
        overAlpha.px(20, 20)[3] === 0, overAlpha.px(20, 20).join(','));
    }

    // ============================================================ 6. background
    {
      const W = 200, H = 200;
      // On a clip that still fills the frame, a background is invisible. That is correct.
      const covered = run([fx('background', { mode: 'solid', colourA: '#00ff00' })], W, H, null,
        paintFill('#ff0000'));
      ok('a background under a clip that still fills the frame changes nothing',
        eq(covered.px(100, 100), [255, 0, 0, 255]), covered.px(100, 100).join(','));

      // With something in front of it that cut the layer, it fills what was opened.
      const stack = [fx('inset', { left: 0.25, right: 0.25, top: 0.25, bottom: 0.25 }),
        fx('background', { mode: 'solid', colourA: '#00ff00' })];
      const filled = run(stack, W, H, null, paintFill('#ff0000'));
      ok('after an inset it fills the gap the inset opened',
        eq(filled.px(10, 10), [0, 255, 0, 255]) && eq(filled.px(100, 100), [255, 0, 0, 255]),
        filled.px(10, 10).join(',') + ' / ' + filled.px(100, 100).join(','));

      // ORDER IS THE FEATURE: the other way round, the inset cuts the background away too.
      const wrongWay = run([stack[1], stack[0]], W, H, null, paintFill('#ff0000'));
      ok('ORDER MATTERS: background before inset is cut away by it',
        wrongWay.px(10, 10)[3] === 0, wrongWay.px(10, 10).join(','));

      const grad = run([fx('inset', { left: 0.25, right: 0.25, top: 0.25, bottom: 0.25 }),
        fx('background', { mode: 'gradient', colourA: '#000000', colourB: '#ffffff', angle: 0.25 })],
        W, H, null, paintFill('#ff0000'));
      ok('a gradient at a quarter turn runs top to bottom',
        grad.px(100, 4)[0] < 40 && grad.px(100, 196)[0] > 215,
        grad.px(100, 4)[0] + ' -> ' + grad.px(100, 196)[0]);

      const copy = run([fx('inset', { left: 0.25, right: 0.25, top: 0.25, bottom: 0.25 }),
        fx('background', { mode: 'blur', zoom: 1.4, radius: 0.05, dim: 0 })],
        W, H, null, (c, w, h) => {
          c.fillStyle = '#0000ff'; c.fillRect(0, 0, w, h);
          c.fillStyle = '#ffff00'; c.fillRect(0, 0, w, h * 0.5);
        });
      ok('the blurred-copy mode fills the gap out of the clip itself',
        copy.px(100, 10)[3] === 255 && copy.px(100, 10)[1] > 120, copy.px(100, 10).join(','));
      ok('  and the blur reaches the frame edge without a dark rim',
        copy.px(2, 100)[3] === 255 && (copy.px(2, 100)[0] + copy.px(2, 100)[2]) > 60,
        copy.px(2, 100).join(','));
      ok('an opacity of zero is a pixel-exact no-op',
        eq(run([fx('background', { mode: 'solid', colourA: '#00ff00', opacity: 0 })], W, H, null,
          paintFill('#ff0000')).px(100, 100), [255, 0, 0, 255]));
    }

    // ============================================================ 7. the layer rule
    //
    // Every effect runs inside the clip's own layer, so it must give the same answer over
    // video as over transparency: the result over blue must equal the result over nothing,
    // composited onto blue arithmetically.
    {
      const W = 200, H = 200;
      const stack = () => [
        fx('chrome', { preset: 'browser', pad: 0.08, shadow: 0.7, blur: 0.04 }),
        fx('spotlight', { x: 0.3, y: 0.3, w: 0.4, h: 0.4, dim: 0.5, blur: 0.01, feather: 0.03 }),
        fx('cutout', { sx: 0.3, sy: 0.3, sw: 0.3, sh: 0.15, x: 0.5, y: 0.8, scale: 1.6, shadow: 0.6 }),
      ];
      const paint = paintFill('#ff5500');
      const overNothing = run(stack(), W, H, null, paint);
      const overBlue = run(stack(), W, H, '#0000ff', paint);
      let worst = 0, at = '';
      for (const [x, y] of [[100, 100], [8, 8], [100, 20], [40, 170], [100, 165], [190, 100]]) {
        const a = overNothing.px(x, y), b = overBlue.px(x, y);
        const al = a[3] / 255;
        for (let i = 0; i < 3; i++) {
          const composited = a[i] * al + [0, 0, 255][i] * (1 - al);
          const d = Math.abs(composited - b[i]);
          if (d > worst) { worst = d; at = x + ',' + y + ' ' + a.join(',') + ' vs ' + b.join(','); }
        }
      }
      ok('THE LAYER RULE: the same stack over blue equals the same stack over nothing, ' +
        'composited onto blue', worst <= 2, 'worst ' + worst.toFixed(2) + '   ' + at);
    }

    // ============================================================ 8. keyframes
    //
    // Every parameter is keyframable through Anim with no extra work, which is what lets
    // a spotlight follow a feature down a scrolling page.
    {
      const e = fx('spotlight', { y: 0.1 });
      e.keys = { y: [{ t: 0, v: 0.1, ease: 'linear' }, { t: 2, v: 0.6, ease: 'linear' }] };
      ok('a spotlight s position animates through Anim',
        near(FX.paramAt(e, 'y', 0), 0.1, 1e-6) &&
        near(FX.paramAt(e, 'y', 1), 0.35, 1e-6) &&
        near(FX.paramAt(e, 'y', 2), 0.6, 1e-6),
        [0, 1, 2].map((t) => FX.paramAt(e, 'y', t).toFixed(3)).join(' '));

      const W = 200, H = 200;
      const early = run([e], W, H, null, paintFill('#ffffff'), 0);
      const late = run([e], W, H, null, paintFill('#ffffff'), 2);
      // At t=0 the box covers y 20..100 and at t=2 it covers 120..200, so one probe is
      // lit at the start and dimmed at the end and the other does the opposite. `dim` is
      // 0.6, so "dimmed" is 255 * 0.4 = 102 - the threshold is what the parameter asks
      // for, not a number picked to pass.
      ok('  and the picture follows it down the frame',
        early.px(100, 40)[0] > 250 && near(late.px(100, 40)[0], 102, 3) &&
        late.px(100, 160)[0] > 250,
        early.px(100, 40).join(',') + ' / ' + late.px(100, 40).join(','));

      ok('none of the four claims to be time-varying on its own - they animate by keys',
        ['chrome', 'background', 'spotlight', 'cutout'].every((t) => !FX.DEFS[t].timeVarying));
      ok('so the shutter is refused on a static one and offered on a keyed one',
        FX.timeVarying(fx('spotlight')) === false && FX.timeVarying(e) === true);
    }

    // ============================================================ 9. resolution parity
    //
    // The preview paints small and the export paints large. This is that, as one number.
    {
      const stack = [
        fx('chrome', { preset: 'laptop', pad: 0.07, shadow: 0.6, blur: 0.04 }),
        fx('background', { mode: 'gradient', colourA: '#101828', colourB: '#2b4a8b', angle: 0.3 }),
        fx('spotlight', { x: 0.28, y: 0.4, w: 0.44, h: 0.2, dim: 0.55, feather: 0.02, blur: 0.006 }),
        fx('cutout', { sx: 0.3, sy: 0.42, sw: 0.3, sh: 0.12, x: 0.5, y: 0.78, scale: 1.7,
          shadow: 0.5, blur: 0.03, dimSource: 0.3 }),
      ];
      const paint = (c, W, H) => {
        c.fillStyle = '#3399ee'; c.fillRect(0, 0, W, H);
        c.fillStyle = '#ffdd44'; c.fillRect(0, 0.3 * H, W, 0.2 * H);
      };
      const small = run(stack, 135, 240, '#101010', paint);
      const large = run(stack, 540, 960, '#101010', paint);

      // A BLOCK AVERAGE, not a single pixel, and that is the honest way to ask this
      // question of these four. Three of them draw soft edges - a feather, two shadows, a
      // gradient - and the exact value of the one boundary pixel a probe lands on is
      // genuinely resolution-dependent: at 4x there are four pixels where there was one,
      // and the ramp is sampled at four different points along it. Averaging the same
      // FRACTION of the frame at both sizes asks whether the same picture was painted,
      // which is the claim, rather than whether one pixel happened to land identically,
      // which is not. Same 6% window at both, so the two averages cover the same region.
      const block = (r, W, H) => (u, v) => {
        const w = Math.max(1, Math.round(0.06 * W)), h = Math.max(1, Math.round(0.06 * H));
        const x = Math.round(u * W - w / 2), y = Math.round(v * H - h / 2);
        const d = r.ctx.getImageData(x, y, w, h).data;
        const sum = [0, 0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 4; k++) sum[k] += d[i + k];
        return sum.map((s) => s / (d.length / 4));
      };
      const bs = block(small, 135, 240), bl = block(large, 540, 960);
      const probes = [[0.5, 0.5], [0.3, 0.35], [0.7, 0.62], [0.5, 0.14], [0.22, 0.8], [0.5, 0.78]];
      let worst = 0, at = '';
      for (const [u, v] of probes) {
        const a = bs(u, v), b = bl(u, v);
        for (let i = 0; i < 4; i++) {
          const d = Math.abs(a[i] - b[i]);
          if (d > worst) { worst = d; at = u + ',' + v + ': ' + a.map((n) => n.toFixed(1)).join(',') + ' vs ' + b.map((n) => n.toFixed(1)).join(','); }
        }
      }
      ok('PREVIEW = RENDER: the four framing effects paint the same picture at 1x and 4x',
        worst <= 14, 'worst channel difference ' + worst + '   ' + at);
      note('  resolution parity worst channel difference: ' + worst + ' / 255');
    }

    // ============================================================ 10. the model
    {
      const c = { kind: 'video', in: 0, out: 2, start: 0, fx: [FX.create('chrome'), FX.create('spotlight')] };
      const json = JSON.parse(JSON.stringify(c));
      FX.normalizeClip(json);
      ok('the four serialise and reload intact - plain JSON, nothing else',
        json.fx.length === 2 && json.fx[0].type === 'chrome' && json.fx[1].type === 'spotlight' &&
        typeof json.fx[0].params.pad === 'number');
      ok('nothing non-serialisable rides along on them',
        json.fx.every((f) => Object.values(f.params).every((v) =>
          typeof v === 'number' || typeof v === 'string')));
      const old = { kind: 'video', fx: [{ id: 'x', type: 'chrome', params: { pad: 0.1 } }] };
      FX.normalizeClip(old);
      ok('a project saved before a parameter existed gains it from the defaults',
        old.fx[0].params.pad === 0.1 && old.fx[0].params.preset === 'browser' &&
        old.fx[0].params.scale === undefined && typeof old.fx[0].params.radius === 'number');
      const empty = { kind: 'video', fx: [] };
      FX.normalizeClip(empty);
      ok('an empty stack is deleted, not left as an empty array', !('fx' in empty));
    }

    // ============================================================ 11. no ffmpeg half
    //
    // Step 6 made the bake the single draw path. An effect with a filter half would be a
    // bug, and a span carrying any of these four must therefore leave the fast path.
    {
      ok('a clip carrying a framing effect is composited rather than fast-pathed',
        typeof clipNeedsBake === 'function' &&
        clipNeedsBake({ fx: [FX.create('chrome')] }) === true &&
        clipNeedsBake({}) === false);
    }

    // ============================================================ 12. the panel
    //
    // The four build themselves out of `FX.DEFS` like every other type, so the thing
    // worth asserting is that they actually do: a schema row of a kind the panel cannot
    // build would throw, and the row would come up short rather than loudly wrong.
    {
      const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await importPaths([D + 'flat_blue.mp4']);
      await sleep(600);
      const vid = allClips().map((x) => x.clip).find((cl) => cl.kind === 'video');
      if (!vid) {
        ok('flat_blue.mp4 imports so the panel can be driven', false);
      } else {
        const vidId = vid.id;
        const live = () => allClips().map((x) => x.clip).find((cl) => cl.id === vidId);
        delete live().fx;
        state.selection.clear();
        state.selection.add(vidId);
        renderInspector();
        const add = document.querySelector('#inspector .fx-box .fx-add select');
        ok('the four are offered in the add menu, none of them greyed out',
          !!add && ['chrome', 'background', 'spotlight', 'cutout'].every((t) => {
            const o = [...add.options].find((x) => x.value === t);
            return o && !o.disabled;
          }));

        let built = true, where = '';
        for (const type of ['chrome', 'background', 'spotlight', 'cutout']) {
          delete live().fx;
          renderInspector();
          const sel = document.querySelector('#inspector .fx-box .fx-add select');
          const undo0 = undoStack.length;
          sel.value = type;
          sel.dispatchEvent(new Event('change'));
          if (undoStack.length !== undo0 + 1) { built = false; where = type + ': undo'; }
          const row = document.querySelector('#inspector .fx-box .fx-fx-body');
          const rows = row ? row.querySelectorAll('.tc-row').length : 0;
          // One row per schema entry, plus whatever the Keyframes section adds.
          if (!row || rows < FX.DEFS[type].schema.length) {
            built = false;
            where = type + ': ' + rows + ' rows for ' + FX.DEFS[type].schema.length + ' schema entries';
          }
          // A keyframe strip for every NUMERIC parameter and none for a colour or a menu.
          const strips = document.querySelectorAll('#inspector .fx-box .tc-kf').length;
          const numeric = Object.values(FX.DEFS[type].params).filter((v) => typeof v === 'number').length;
          if (strips !== numeric) { built = false; where = type + ': ' + strips + ' strips for ' + numeric + ' numbers'; }
          undo();
        }
        ok('each of the four builds its whole panel row, as ONE undo entry', built, where);
        ok('  and the rows are not drag sources, like every other row in the panel',
          [...document.querySelectorAll('#inspector .fx-box .fx-fx-body')]
            .every((b) => b.draggable === false));
        if (live()) delete live().fx;
      }
    }

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
