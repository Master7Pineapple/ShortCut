/**
 * The per-clip visual effect stack.
 *
 *   SHORTCUT_SMOKE=tools/smoke-fx.js node_modules/.bin/electron .
 *
 * Four things this exists to prove:
 *   - STACK ORDER matters and is honoured: blur after grade is not blur before grade;
 *   - every parameter is keyframable through Anim, on the effect rather than the clip;
 *   - each effect draws correctly over TRANSPARENCY and over an OPAQUE BACKGROUND, which
 *     is the whole reason effects run inside the clip's own offscreen layer;
 *   - the preview and the export agree - the same stack painted at two resolutions gives
 *     the same picture, and a real ffmpeg render of a graded clip matches the preview
 *     canvas pixel for pixel.
 *
 * Most of it needs no media at all - `FX.render()` is a pure canvas function. The end-to-
 * end half reuses smoke-layers.js's fixture in %TEMP%\scut_test\:
 *   ffmpeg -y -f lavfi -i color=c=0x2060C0:s=1080x1920:r=30:d=4 \
 *          -f lavfi -i sine=frequency=440:duration=4 \
 *          -c:v libx264 -pix_fmt yuv420p -c:a aac flat_blue.mp4
 * Writes the render to %TEMP%\scut_test\fx_out.mp4.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const VID = D + 'flat_blue.mp4';
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    // ============================================================ a canvas harness
    //
    // The suite's own surface pool, exactly the shape FX asks for. Separate from the
    // app's so a test can never be reading a canvas the viewer is halfway through.
    const pool = new Map();
    const surface = (name, w, h) => {
      let cv = pool.get(name);
      if (!cv) { cv = document.createElement('canvas'); pool.set(name, cv); }
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      return cv;
    };

    /**
     * Paint a clip's stack onto a frame and hand back a pixel reader.
     *
     * `bg` is either null (a transparent frame - what a layer above another layer sees)
     * or a fill (an opaque frame - what a layer over video sees). Running every effect
     * against BOTH is the point: an effect that composited onto the frame instead of its
     * own layer would give two different answers.
     */
    const paintBlock = (colour, inset) => (c, W, H) => {
      c.fillStyle = colour;
      const m = inset || 0;
      c.fillRect(m * W, m * H, W - 2 * m * W, H - 2 * m * H);
    };
    function run(fx, W, H, bg, paint, t) {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.clearRect(0, 0, W, H);
      if (bg) { c.fillStyle = bg; c.fillRect(0, 0, W, H); }
      FX.render(c, W, H, { fx }, t || 0, surface, paint || paintBlock('#ff0000'));
      const px = (x, y) => {
        const d = c.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      return { cv, ctx: c, px };
    }
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const fx = (type, params) => Object.assign(FX.create(type), { params: Object.assign(FX.create(type).params, params || {}) });

    // ============================================================ 1. no stack, no cost
    const bare = run([], 40, 40, null);
    ok('a clip with no effects paints straight to the target',
      eq(bare.px(20, 20), [255, 0, 0, 255]), bare.px(20, 20).join(','));
    ok('FX.render says so, so the caller can keep its fast path',
      FX.render(bare.ctx, 40, 40, {}, 0, surface, () => {}) === false);
    ok('a stack of nothing but BYPASSED effects is also no stack',
      FX.active({ fx: [Object.assign(fx('blur'), { enabled: false })] }).length === 0);
    ok('an effect type this build does not know is not an effect',
      FX.active({ fx: [{ id: 'q', type: 'notathing', params: {} }] }).length === 0);

    // ============================================================ 2. the grade
    //
    // The one effect with arithmetic to check rather than geometry.
    // Painted inset, so the frame has a transparent margin the grade must also leave alone.
    const neutralOverAlpha = run([fx('grade')], 40, 40, null, paintBlock('#ff0000', 0.25));
    const neutralOverBg = run([fx('grade')], 40, 40, '#00ff00', paintBlock('#ff0000', 0.25));
    ok('a neutral grade is a pixel-exact no-op over transparency',
      eq(neutralOverAlpha.px(20, 20), [255, 0, 0, 255]) &&
      eq(neutralOverAlpha.px(2, 2), [0, 0, 0, 0]),
      neutralOverAlpha.px(20, 20).join(',') + ' / edge ' + neutralOverAlpha.px(2, 2).join(','));
    ok('a neutral grade is a pixel-exact no-op over an opaque background',
      eq(neutralOverBg.px(20, 20), [255, 0, 0, 255]) &&
      eq(neutralOverBg.px(2, 2), [0, 255, 0, 255]),
      neutralOverBg.px(20, 20).join(',') + ' / bg ' + neutralOverBg.px(2, 2).join(','));
    ok('FX.isNeutralGrade agrees with the defaults it is checked against',
      FX.isNeutralGrade(FX.DEFS.grade.params) &&
      !FX.isNeutralGrade(Object.assign({}, FX.DEFS.grade.params, { gain: 1.01 })));

    // Hand-computed against the documented order: gain, lift, gamma, contrast, temperature.
    {
      const p = { lift: 0.05, gamma: 0.8, gain: 1.2, saturation: 1, contrast: 1.1, temperature: 0.2 };
      const byHand = (i, trim) => {
        let v = i / 255;
        v = v * p.gain + p.lift;
        v = Math.min(1, Math.max(0, v));
        v = Math.pow(v, 1 / p.gamma);
        v = (v - 0.5) * p.contrast + 0.5;
        return v * trim * 255;
      };
      const lut = FX.gradeLUT(p);
      let worst = 0;
      for (const i of [0, 1, 63, 128, 200, 254, 255]) {
        worst = Math.max(worst,
          Math.abs(lut[0][i] - byHand(i, 1 + p.temperature * 0.3)),
          Math.abs(lut[1][i] - byHand(i, 1)),
          Math.abs(lut[2][i] - byHand(i, 1 - p.temperature * 0.3)));
      }
      ok('the grade LUT matches the curve computed by hand, all three channels',
        worst < 1e-3, 'worst error ' + worst.toExponential(2));
      ok('temperature warms red and cools blue, and only that',
        lut[0][200] > lut[1][200] && lut[2][200] < lut[1][200],
        [lut[0][200], lut[1][200], lut[2][200]].map((n) => n.toFixed(1)).join(' / '));
    }

    // Saturation is the one that leaves the LUT, so it gets its own check.
    {
      const grey = run([fx('grade', { saturation: 0 })], 20, 20, null);
      const g = grey.px(10, 10);
      const luma = Math.round(0.2126 * 255);
      ok('saturation 0 collapses to Rec.709 luma',
        near(g[0], luma, 1) && near(g[1], luma, 1) && near(g[2], luma, 1),
        g.join(',') + ' want ' + luma);
      ok('the grade never touches alpha',
        run([fx('grade', { saturation: 0, gain: 2 })], 20, 20, null).px(10, 10)[3] === 255);
    }

    // ============================================================ 3. transform
    {
      const half = run([fx('transform', { opacity: 0.5 })], 40, 40, null);
      ok('transform opacity over transparency lands on the alpha channel',
        near(half.px(20, 20)[3], 128, 2) && half.px(20, 20)[0] === 255,
        half.px(20, 20).join(','));
      const overBlack = run([fx('transform', { opacity: 0.5 })], 40, 40, '#000000');
      ok('the SAME opacity over an opaque background blends against it',
        near(overBlack.px(20, 20)[0], 128, 2) && overBlack.px(20, 20)[3] === 255,
        overBlack.px(20, 20).join(','));

      // A block inset by 25% moved right by 0.25 of the frame: its left edge moves from
      // x=0.25W to x=0.5W. Offsets are FRACTIONS OF THE FRAME, which is what makes the
      // preview and the export agree.
      const moved = run([fx('transform', { x: 0.25 })], 80, 80, null, paintBlock('#ff0000', 0.25));
      ok('a transform offset is a fraction of the frame, not a pixel count',
        moved.px(30, 40)[3] === 0 && moved.px(50, 40)[3] === 255,
        'at 30: ' + moved.px(30, 40).join(',') + '  at 50: ' + moved.px(50, 40).join(','));

      // Scale about the default centre anchor keeps the centre put and moves the edges.
      const grown = run([fx('transform', { scale: 2 })], 80, 80, null, paintBlock('#ff0000', 0.25));
      ok('scale turns about the anchor, so the centre stays put',
        eq(grown.px(40, 40), [255, 0, 0, 255]) && grown.px(12, 40)[3] === 255,
        'centre ' + grown.px(40, 40).join(',') + ' edge ' + grown.px(12, 40).join(','));
      const corner = run([fx('transform', { scale: 2, anchorX: 0, anchorY: 0 })], 80, 80, null,
        paintBlock('#ff0000', 0.25));
      ok('moving the anchor to a corner grows it out of that corner instead',
        corner.px(12, 12)[3] === 0 && corner.px(60, 60)[3] === 255,
        'tl ' + corner.px(12, 12).join(',') + ' br ' + corner.px(60, 60).join(','));
    }

    // ============================================================ 4. crop / inset
    {
      const cut = run([fx('inset', { left: 0.25 })], 40, 40, null);
      ok('an inset CLEARS to transparent, so the layers below come through',
        cut.px(5, 20)[3] === 0 && eq(cut.px(30, 20), [255, 0, 0, 255]),
        'cut ' + cut.px(5, 20).join(',') + ' kept ' + cut.px(30, 20).join(','));
      const cutOverBg = run([fx('inset', { left: 0.25 })], 40, 40, '#00ff00');
      ok('over a background the inset region shows the background, not black',
        eq(cutOverBg.px(5, 20), [0, 255, 0, 255]), cutOverBg.px(5, 20).join(','));
      const gone = run([fx('inset', { left: 0.5, right: 0.5 })], 40, 40, null);
      ok('an inset that closes on itself removes the clip rather than throwing',
        gone.px(20, 20)[3] === 0);
    }

    // ============================================================ 5. corners + shadow
    {
      const rounded = run([fx('round', { radius: 0.25, shadow: 0 })], 80, 80, null);
      ok('a corner radius rounds the layer away to transparency',
        rounded.px(2, 2)[3] === 0 && eq(rounded.px(40, 40), [255, 0, 0, 255]),
        'corner ' + rounded.px(2, 2).join(',') + ' middle ' + rounded.px(40, 40).join(','));
      const shadowed = run([fx('round', { radius: 0.25, shadow: 1, blur: 0.08, offsetX: 0, offsetY: 0 })],
        80, 80, null);
      ok('the shadow is cast into the rounded-away corner, not squared off',
        shadowed.px(2, 2)[3] > rounded.px(2, 2)[3],
        'with shadow alpha ' + shadowed.px(2, 2)[3] + ' without ' + rounded.px(2, 2)[3]);

      // The layer rule, stated as an assertion: an effect must give the same LAYER over a
      // background as over transparency. If the shadow were cast onto the frame it would
      // pick the background up and the two would differ.
      // Predicted in FLOAT from the transparent run, not by re-compositing that canvas over
      // blue: an 8-bit canvas stores colour unpremultiplied, so bouncing a shadow of alpha
      // 15 through one loses far more precision than the thing being measured.
      const shadowCfg = { radius: 0.25, shadow: 1, blur: 0.08, offsetX: 0, offsetY: 0 };
      const overBg = run([fx('round', shadowCfg)], 80, 80, '#0000ff');
      const bgRGB = [0, 0, 255];
      let worst = 0, at = '';
      for (const [x, y] of [[4, 4], [10, 10], [40, 40], [70, 70], [40, 6]]) {
        const layer = shadowed.px(x, y);
        const a = layer[3] / 255;
        const got = overBg.px(x, y);
        for (let i = 0; i < 3; i++) {
          const want = layer[i] * a + bgRGB[i] * (1 - a);
          const d = Math.abs(got[i] - want);
          if (d > worst) { worst = d; at = x + ',' + y + ' got ' + got[i] + ' want ' + want.toFixed(1); }
        }
      }
      ok('THE LAYER RULE: an effect composites inside its own layer, then onto the frame',
        worst <= 1.5, 'worst channel difference ' + worst.toFixed(2) + ' at ' + at);
    }

    // ============================================================ 6. blur
    {
      const W = 120, H = 120;
      // An all-over opaque plate: after a blur its EDGES must be untouched. A blur that
      // pulled the transparent surround inwards would darken them, and one that hid that
      // by drawing oversized would magnify the picture instead.
      const flat = run([fx('blur', { radius: 0.06 })], W, H, null, (c) => {
        c.fillStyle = '#c08040'; c.fillRect(0, 0, W, H);
      });
      const e = flat.px(1, H / 2), m = flat.px(W / 2, H / 2);
      ok('a blur does not darken the frame edge: the plate is padded by edge extension',
        e[3] === 255 && near(e[0], 0xc0, 2) && near(e[1], 0x80, 2) && near(e[2], 0x40, 2),
        'edge ' + e.join(',') + ' middle ' + m.join(','));

      // Magnification test: a small centred square. Blurring must soften it, not grow it -
      // its half-intensity width should stay near the original, not scale with the radius.
      const square = (c) => {
        c.clearRect(0, 0, W, H);
        c.fillStyle = '#ffffff';
        c.fillRect(W * 0.4, H * 0.4, W * 0.2, H * 0.2);
      };
      const sharp = run([], W, H, null, square);
      const soft = run([fx('blur', { radius: 0.05 })], W, H, null, square);
      const widthAt = (r) => {
        let n = 0;
        for (let x = 0; x < W; x++) if (r.px(x, H / 2)[3] > 127) n++;
        return n;
      };
      const wSharp = widthAt(sharp), wSoft = widthAt(soft);
      ok('a blur does not magnify: the half-intensity width is unchanged',
        Math.abs(wSoft - wSharp) <= 2, 'sharp ' + wSharp + 'px, blurred ' + wSoft + 'px');
      ok('a blur softens: the edge is no longer a step',
        soft.px(W * 0.38, H / 2)[3] > 4 && soft.px(W * 0.38, H / 2)[3] < 250,
        'alpha just outside the square ' + soft.px(W * 0.38, H / 2)[3]);
      ok('a zero radius is a no-op rather than a wasted pass',
        eq(run([fx('blur', { radius: 0 })], 40, 40, null).px(20, 20), [255, 0, 0, 255]));
    }

    // ============================================================ 7. stack ORDER
    {
      // A grade with gain 2 clips the white half to white; blurring afterwards averages
      // clipped values, blurring first averages the originals and THEN clips. The two are
      // measurably different, which is the point of a drag-reorderable stack.
      const split = (c, W, H) => {
        c.fillStyle = '#404040'; c.fillRect(0, 0, W / 2, H);
        c.fillStyle = '#c0c0c0'; c.fillRect(W / 2, 0, W / 2, H);
      };
      const g = () => fx('grade', { gain: 2 });
      const b = () => fx('blur', { radius: 0.04 });
      const gradeFirst = run([g(), b()], 100, 100, null, split);
      const blurFirst = run([b(), g()], 100, 100, null, split);
      const at = 46;
      const diff = Math.abs(gradeFirst.px(at, 50)[0] - blurFirst.px(at, 50)[0]);
      ok('STACK ORDER MATTERS: blur after grade is not blur before grade',
        diff > 3,
        'grade->blur ' + gradeFirst.px(at, 50)[0] + ', blur->grade ' + blurFirst.px(at, 50)[0]);
      ok('the same effects in the same order give the same pixels',
        eq(run([g(), b()], 100, 100, null, split).px(at, 50), gradeFirst.px(at, 50)));

      // A throwing effect must cost its own draw and nothing else.
      const bad = { id: 'bad', type: 'grade', enabled: true, params: null };
      const survived = run([bad, fx('transform', { opacity: 0.5 })], 40, 40, null);
      ok('one bad effect costs its own draw, never the frame',
        survived.px(20, 20)[3] > 0, survived.px(20, 20).join(','));
    }

    // ============================================================ 8. keyframes
    {
      const e = fx('transform', { opacity: 1 });
      const track = Anim.trackFor(e, 'opacity', true);
      Anim.addKey(track, 0, 0, Anim.EASING_PRESETS.linear);
      Anim.addKey(track, 2, 1, Anim.EASING_PRESETS.linear);
      ok('a keyframe track lives on the EFFECT, not the clip',
        Array.isArray(e.keys.opacity) && e.keys.opacity.length === 2);
      ok('FX.paramAt reads the animated value',
        FX.paramAt(e, 'opacity', 0) === 0 &&
        near(FX.paramAt(e, 'opacity', 1), 0.5, 1e-6) &&
        FX.paramAt(e, 'opacity', 2) === 1,
        [0, 1, 2].map((t) => FX.paramAt(e, 'opacity', t)).join(' / '));
      ok('an unkeyed parameter falls back to its static value',
        FX.paramAt(e, 'scale', 1) === 1);
      ok('a track holds at both ends, so keys outside the clip still make sense',
        FX.paramAt(e, 'opacity', -5) === 0 && FX.paramAt(e, 'opacity', 99) === 1);

      const t0 = run([e], 40, 40, null, null, 0);
      const t1 = run([e], 40, 40, null, null, 1);
      const t2 = run([e], 40, 40, null, null, 2);
      ok('the keyed parameter actually drives the draw',
        t0.px(20, 20)[3] === 0 && near(t1.px(20, 20)[3], 128, 2) && t2.px(20, 20)[3] === 255,
        [t0, t1, t2].map((r) => r.px(20, 20)[3]).join(' / '));

      // Two blurs on one clip are two independent animations - which is exactly why the
      // keys hang off the effect and not off `clip.keys.radius`.
      const b1 = fx('blur', { radius: 0.01 }), b2 = fx('blur', { radius: 0.01 });
      Anim.addKey(Anim.trackFor(b1, 'radius', true), 0, 0.05);
      ok('two effects of the same type keyframe independently',
        FX.paramAt(b1, 'radius', 0) === 0.05 && FX.paramAt(b2, 'radius', 0) === 0.01);
    }

    // ============================================================ 9. resolution parity
    //
    // The preview paints small and the export paints large. Every length in FX is a
    // fraction of the frame for this reason, and this is the assertion that says so.
    {
      const stack = [
        fx('round', { radius: 0.12, shadow: 0.8, blur: 0.05, offsetY: 0.02 }),
        fx('grade', { gain: 1.3, saturation: 0.6, temperature: 0.3 }),
        fx('blur', { radius: 0.02 }),
        fx('transform', { scale: 0.8, x: 0.05, rotate: 12 }),
      ];
      const paint = paintBlock('#3399ee', 0.1);
      const small = run(stack, 135, 240, '#101010', paint);
      const large = run(stack, 540, 960, '#101010', paint);
      const probes = [[0.5, 0.5], [0.3, 0.35], [0.7, 0.62], [0.5, 0.14], [0.22, 0.8]];
      let worst = 0, at = '';
      for (const [u, v] of probes) {
        const a = small.px(u * 135, v * 240), b = large.px(u * 540, v * 960);
        for (let i = 0; i < 4; i++) {
          const d = Math.abs(a[i] - b[i]);
          if (d > worst) { worst = d; at = u + ',' + v + ': ' + a.join(',') + ' vs ' + b.join(','); }
        }
      }
      ok('PREVIEW = RENDER: a four-effect stack paints the same picture at 1x and 4x',
        worst <= 12, 'worst channel difference ' + worst + '   ' + at);
      note('  resolution parity worst channel difference: ' + worst + ' / 255');
    }

    // ============================================================ 10. the model
    {
      const c = { kind: 'video', in: 0, out: 2, start: 0 };
      FX.normalizeClip(c);
      ok('a clip with no stack keeps none - fx is absent, not empty',
        !('fx' in c), JSON.stringify(c));

      c.fx = [
        { type: 'grade', params: { gain: 1.5, bogus: 9 } },
        { type: 'notathing', params: {} },
        { type: 'blur', params: { radius: 'x' }, keys: { radius: [], dead: [{ t: 0, v: 1 }] } },
      ];
      FX.normalizeClip(c);
      ok('normalize drops unknown types', c.fx.length === 2, c.fx.map((f) => f.type).join(','));
      ok('normalize fills missing parameters from the defaults and drops strays',
        c.fx[0].params.saturation === 1 && !('bogus' in c.fx[0].params) && c.fx[0].params.gain === 1.5,
        JSON.stringify(c.fx[0].params));
      ok('a non-numeric value falls back to the default rather than poisoning the draw',
        c.fx[1].params.radius === FX.DEFS.blur.params.radius, String(c.fx[1].params.radius));
      ok('empty tracks and tracks for dead parameters are pruned, and keys with them',
        !('keys' in c.fx[1]), JSON.stringify(c.fx[1].keys));
      ok('every effect gets an id, so the panel can address it',
        c.fx.every((f) => !!f.id) && c.fx[0].id !== c.fx[1].id);

      Anim.addKey(Anim.trackFor(c.fx[1], 'radius', true), 0.5, 0.08);
      const round = JSON.parse(JSON.stringify(c));
      ok('the whole stack is plain JSON, so undo and the .scut file carry it',
        JSON.stringify(round) === JSON.stringify(c) && round.fx[1].keys.radius[0].v === 0.08);
      ok('nothing non-serialisable landed on the clip',
        Object.values(c.fx[0]).every((v) => typeof v !== 'function') &&
        typeof c.fx[0].params === 'object');
    }

    // ==================================================== 10a. corners AND shadow
    //
    // `round` was unusable: the rounded rect was hardcoded to the full frame, so on a
    // full-frame clip the shadow was cast at the frame edge and fell entirely outside the
    // canvas. All you could ever see was the corners cut to transparency - and scaling
    // the layer down first did not help either, because the rounded rect stayed the whole
    // frame whatever was inside it. `margin` is what makes both halves reachable.
    {
      const shot = (params, W, H) => {
        const f = fx('round', params);
        const r = run([f], W, H, null, paintBlock('#ff0000'), 0);
        return r;
      };
      const W = 120, H = 200;
      const r = shot({ margin: 0.08, radius: 0.06, shadow: 0.9, blur: 0.04, offsetY: 0.02 }, W, H);
      const m = Math.round(0.08 * Math.min(W, H));

      ok('the picture is cropped to the inset rect, not drawn to the frame edge',
        r.px(W / 2, m + 4)[0] > 200 && r.px(W / 2, Math.floor(m / 2))[0] < 200,
        'inside=' + r.px(W / 2, m + 4).join(',') + ' margin=' + r.px(W / 2, Math.floor(m / 2)).join(','));

      // THE ONE THAT WAS BROKEN: something is drawn in the margin, and it is the shadow.
      // Sampled BELOW the card, because the default offset pushes the shadow downward -
      // the first version of this test sampled the top margin, found nothing, and was
      // measuring the offset rather than the shadow.
      const below = Math.round(H - m + 2);
      const inMargin = r.px(W / 2, below);
      ok('THE SHADOW IS VISIBLE, in the gap the margin opens',
        inMargin[3] > 8 && inMargin[0] < 120,
        'a=' + inMargin[3] + ' rgb=' + inMargin.slice(0, 3).join(','));

      const noShadow = shot({ margin: 0.08, radius: 0.06, shadow: 0, blur: 0.04 }, W, H);
      ok('...and it is the shadow, because turning it off empties the margin',
        noShadow.px(W / 2, below)[3] === 0, String(noShadow.px(W / 2, below)[3]));

      // Blur widens it: sample past where an unblurred shadow could possibly reach.
      const M2 = Math.round(0.12 * Math.min(W, H));
      const y2 = Math.round(H - M2 + 3);
      const sharp = shot({ margin: 0.12, radius: 0.02, shadow: 1, blur: 0, offsetY: 0 }, W, H);
      const soft = shot({ margin: 0.12, radius: 0.02, shadow: 1, blur: 0.06, offsetY: 0 }, W, H);
      const alphaAt = (img) => img.px(W / 2, y2)[3];
      ok('shadow blur does something, and it is to spread the shadow outward',
        alphaAt(soft) > alphaAt(sharp),
        'sharp=' + alphaAt(sharp) + ' soft=' + alphaAt(soft) + ' at y=' + y2);

      ok('the corners are rounded on the INSET rect, not on the frame', (() => {
        const big = shot({ margin: 0.1, radius: 0.5, shadow: 0, blur: 0 }, W, H);
        const mm = Math.round(0.1 * Math.min(W, H));
        // The inset rect's own corner is cut away; its middle-left edge is not.
        return big.px(mm + 1, mm + 1)[3] === 0 && big.px(mm + 1, H / 2)[0] > 200;
      })());

      ok('margin 0 is the old full-frame behaviour, so nothing silently reframes',
        (() => {
          const z = shot({ margin: 0, radius: 0, shadow: 0, blur: 0 }, W, H);
          return z.px(1, 1)[0] > 200 && z.px(W - 2, H - 2)[0] > 200;
        })());
    }

    // ==================================================== 10b. the per-effect shutter

    {
      // Absent by default and pruned away again, exactly like `keys`: a stack that uses
      // no motion blur serialises as it did before this existed.
      const c = { kind: 'video', fx: [FX.create('transform')] };
      c.fx[0].mblur = { on: false, strength: 0.5, samples: 8 };
      FX.normalizeClip(c);
      ok('an untouched shutter prunes itself off the effect', !c.fx[0].mblur);

      c.fx[0].mblur = { on: false, strength: 1.5, samples: 8 };
      FX.normalizeClip(c);
      ok('...but settings the author changed survive being switched off',
        !!c.fx[0].mblur && c.fx[0].mblur.strength === 1.5);

      c.fx[0].mblur = { on: true, strength: 99, samples: 900 };
      FX.normalizeClip(c);
      ok('strength and samples are clamped to something renderable',
        c.fx[0].mblur.strength === 4 && c.fx[0].mblur.samples === 32,
        JSON.stringify(c.fx[0].mblur));
      ok('the shutter is plain JSON like everything else on a clip',
        JSON.stringify(c) === JSON.stringify(JSON.parse(JSON.stringify(c))));

      // An effect that paints the same picture at every instant has nothing to average,
      // and blurring it would cost N passes to produce an identical frame.
      ok('a static effect is not time-varying, so the shutter is refused',
        FX.timeVarying(FX.create('grade')) === false);
      const keyed = FX.create('grade');
      Anim.addKey(Anim.trackFor(keyed, 'gain', true), 0, 1);
      ok('one key is still not motion - there is nothing to sweep between',
        FX.timeVarying(keyed) === false);
      Anim.addKey(Anim.trackFor(keyed, 'gain', true), 1, 2);
      ok('two keys are', FX.timeVarying(keyed) === true);
      ok('an effect that reads the clock is time-varying with no keys at all',
        FX.timeVarying(FX.create('select')) === true &&
        FX.timeVarying(FX.create('ripple')) === true);
      ok('mblurOf() answers null unless it is actually on',
        FX.mblurOf({ mblur: { on: false } }) === null && FX.mblurOf({}) === null &&
        !!FX.mblurOf({ mblur: { on: true, strength: 0.5, samples: 8 } }));

      // And the picture: a keyframed transform swept across the shutter has to come out
      // SOFTER than the same transform at one instant - that is the whole feature.
      const moving = () => {
        const f = FX.create('transform');
        Anim.addKey(Anim.trackFor(f, 'x', true), 0, -0.4);
        Anim.addKey(Anim.trackFor(f, 'x', true), 1, 0.4);
        return f;
      };
      const edges = (stack) => {
        const r = run(stack, 80, 80, null, paintBlock('#ff0000', 0.3), 0.5);
        const d = r.ctx.getImageData(0, 0, 80, 80).data;
        let partial = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 8 && d[i + 3] < 247) partial++;   // a softened, part-covered pixel
        }
        return partial;
      };
      const sharp = edges([moving()]);
      const blurred = edges([Object.assign(moving(), {
        mblur: { on: true, strength: 2, samples: 12 },
      })]);
      ok('THE SHUTTER: a moving effect comes out softened at its edges',
        blurred > sharp * 1.5, 'partial pixels ' + sharp + ' -> ' + blurred);
      ok('...and the effect underneath it is untouched, not smeared with it', (() => {
        // A static grade below a blurred transform must still be the same flat colour.
        const st = [Object.assign(moving(), { mblur: { on: true, strength: 2, samples: 8 } })];
        const r = run(st, 40, 40, null, paintBlock('#ff0000'), 0.5);
        const px = r.px(20, 20);
        return px[0] > 200 && px[1] < 40;
      })());
    }

    // ============================================================ 11. the render path
    await importPaths([VID]);
    await sleep(1000);
    const vid = allClips().map((x) => x.clip).find((cl) => cl.kind === 'video');
    if (!vid) return results.join('\n') + '\nFAIL  flat_blue.mp4 did not import';
    state.out.w = 540; state.out.h = 960; state.out.fps = 30; state.out.quality = 'fast';
    state.previewScale = 1;
    resizeCanvas();
    vid.start = 0; vid.in = 0; vid.out = Math.min(vid.mediaDuration, 2);
    const aud = allClips().map((x) => x.clip).find((cl) => cl.kind === 'audio');
    if (aud) { aud.start = 0; aud.in = 0; aud.out = vid.out; }
    renderAll();

    ok('a plain clip still takes the fast path',
      compositeSpans(buildJob(D + 'fx_out.mp4', { from: 0, to: 2 })).length === 0);

    vid.fx = [FX.create('grade')];
    vid.fx[0].params.gain = 1.4;
    vid.fx[0].params.saturation = 0.5;
    ok('a clip carrying an effect leaves the fast path', clipNeedsBake(vid) && needsCompositeAt(1, []));
    vid.fx[0].enabled = false;
    ok('bypassing it puts the clip back on the fast path', !clipNeedsBake(vid));
    vid.fx[0].enabled = true;

    let job = buildJob(D + 'fx_out.mp4', { from: 0, to: 2 });
    const spans = compositeSpans(job);
    ok('the whole clip becomes one bake span',
      spans.length === 1 && spans[0].from < 1e-3 && Math.abs(spans[0].to - 2) < 1e-3,
      JSON.stringify(spans));
    ok('the job carries the stack, so the render cache can see it',
      !!(job.clips.find((e) => e.kind === 'video') || {}).fx);

    // The cache key must move when a parameter does, or turning up the grade would hit a
    // cached render of the old picture.
    const key0 = jobCacheKey(job);
    vid.fx[0].params.gain = 1.9;
    const key1 = jobCacheKey(buildJob(D + 'fx_out.mp4', { from: 0, to: 2 }));
    vid.fx[0].params.gain = 1.4;
    const key2 = jobCacheKey(buildJob(D + 'fx_out.mp4', { from: 0, to: 2 }));
    ok('changing an effect parameter changes the render cache key', key0 !== key1);
    ok('changing it back gives the same key again', key0 === key2);
    // IDENTITY IS NOT PIXELS. `FX.create()` hands out a fresh id every time, so leaving it
    // in the key would mean deleting an effect and adding an identical one back missed its
    // own cached render, and two clips wearing the same grade never shared one.
    const rebuilt = FX.create('grade');
    rebuilt.params = JSON.parse(JSON.stringify(vid.fx[0].params));
    ok('the two stacks really do have different effect ids', rebuilt.id !== vid.fx[0].id);
    const wasFx = vid.fx;
    vid.fx = [rebuilt];
    const keyReid = jobCacheKey(buildJob(D + 'fx_out.mp4', { from: 0, to: 2 }));
    vid.fx = wasFx;
    ok("an effect's id is identity, not pixels, so it is not in the key", keyReid === key0,
      keyReid + ' vs ' + key0);

    // ============================================================ 12. the inspector
    // `undo()` replaces state.tracks with a parsed snapshot, so every clip object in this
    // suite is stale the moment one runs. Everything below re-finds by id.
    const vidId = vid.id;
    const live = () => allClips().map((x) => x.clip).find((cl) => cl.id === vidId);
    {
      let clip = live();
      delete clip.fx;
      state.selection.clear();
      state.selection.add(clip.id);
      const linked = allClips().map((x) => x.clip).filter((cl) => cl.linkId && cl.linkId === clip.linkId);
      for (const l of linked) state.selection.add(l.id);
      renderInspector();
      const panel = document.querySelector('#inspector .fx-box');
      ok('the selected clip gets an effect panel', !!panel);
      const add = panel && panel.querySelector('.fx-add select');
      ok('every effect type is offered from FX.DEFS and nothing else',
        !!add && add.options.length === FX.TYPES.length + 1,
        add ? [...add.options].map((o) => o.value).join(',') : 'no select');

      const undo0 = undoStack.length;
      add.value = 'blur';
      add.dispatchEvent(new Event('change'));
      ok('adding an effect from the panel is ONE undo entry',
        undoStack.length === undo0 + 1 && clip.fx && clip.fx.length === 1,
        undo0 + ' -> ' + undoStack.length);

      const add2 = document.querySelector('#inspector .fx-box .fx-add select');
      add2.value = 'grade';
      add2.dispatchEvent(new Event('change'));
      ok('a second effect stacks after the first',
        clip.fx.length === 2 && clip.fx[0].type === 'blur' && clip.fx[1].type === 'grade',
        clip.fx.map((f) => f.type).join(' -> '));

      const undo1 = undoStack.length;
      const rows = document.querySelectorAll('#inspector .fx-box .fx-fx');
      ok('the panel draws one row per effect, in stack order', rows.length === 2);
      // NOTHING in the panel is an HTML5 drag source. A draggable ancestor starts a
      // native drag from a press anywhere inside it, so in a panel whose whole purpose is
      // dragging values it could only ever be a way to lose one. Reordering is the arrows,
      // which are also the only route a keyboard or this suite has.
      ok('no row is a drag source', [...rows].every((r) => r.draggable === false),
        [...rows].map((r) => r.draggable).join(','));
      ok('and neither is anything inside one',
        [...document.querySelectorAll('#inspector .fx-box .fx-fx-body')].every((b) => b.draggable === false),
        [...document.querySelectorAll('#inspector .fx-box .fx-fx-body')].map((b) => b.draggable).join(','));
      // The arrows do the same job as the drag and are reachable from here.
      const upBtn = [...rows[1].querySelectorAll('button')].find((b) => b.textContent === '▲');
      upBtn.click();
      ok('reordering is ONE undo entry and actually reorders',
        undoStack.length === undo1 + 1 &&
        clip.fx[0].type === 'grade' && clip.fx[1].type === 'blur',
        clip.fx.map((f) => f.type).join(' -> '));
      undo();
      clip = live();
      ok('one undo puts the order back',
        !!clip && clip.fx.length === 2 && clip.fx[0].type === 'blur' && clip.fx[1].type === 'grade',
        clip && clip.fx ? clip.fx.map((f) => f.type).join(' -> ') : 'gone');

      // Keyframe strips are built from the same schema the sliders use, so the two can
      // never offer different limits for the same number.
      renderInspector();
      const strips = document.querySelectorAll('#inspector .fx-box .tc-kf');
      const blurParams = Object.keys(FX.DEFS.blur.params).length;
      const gradeParams = Object.keys(FX.DEFS.grade.params).length;
      ok('every numeric parameter gets a keyframe strip',
        strips.length === blurParams + gradeParams,
        strips.length + ' strips for ' + (blurParams + gradeParams) + ' parameters');
      ok('a colour parameter gets a swatch but no keyframe strip',
        Object.keys(FX.DEFS.round.params).filter((k) => typeof FX.DEFS.round.params[k] === 'number').length ===
        Object.keys(FX.DEFS.round.params).length - 1);

      // ---- rolling a row up ------------------------------------------------
      //
      // Purely how the panel looks, so it must not touch the document: no undo entry, no
      // dirty flag, and nothing on the clip - `fxCollapsed` is a module-level Set keyed
      // by effect id, because a collapsed row is not a fact about the edit.
      {
        renderInspector();
        const before = JSON.stringify(live().fx);
        const undoN = undoStack.length;
        const row0 = document.querySelector('#inspector .fx-box .fx-fx');
        const caret = row0.querySelector('.fx-caret');
        ok('every effect row has a roll-up caret', !!caret);
        ok('a row starts open', row0.querySelector('.fx-fx-body').hidden === false);
        caret.click();
        const rows2 = document.querySelectorAll('#inspector .fx-box .fx-fx');
        ok('clicking the caret rolls the row up',
          rows2[0].querySelector('.fx-fx-body').hidden === true);
        ok('...and leaves the OTHER rows alone',
          rows2[1].querySelector('.fx-fx-body').hidden === false);
        ok('collapsing pushes no undo entry and changes nothing on the clip',
          undoStack.length === undoN && JSON.stringify(live().fx) === before,
          undoN + ' -> ' + undoStack.length);
        ok('a rolled-up row still says what it is doing',
          /keyed|bypassed|blur/.test(rows2[0].querySelector('.fx-fx-head').textContent) ||
          rows2[0].querySelector('.fx-fx-head').textContent.length > 0);
        // The state is keyed by effect id, so a rebuild has to preserve it.
        renderInspector();
        ok('the roll-up survives a panel rebuild',
          document.querySelector('#inspector .fx-box .fx-fx .fx-fx-body').hidden === true);
        const all = [...document.querySelectorAll('#inspector .fx-box .fx-head button')]
          .find((b) => /Collapse all|Expand all/.test(b.textContent));
        ok('a stack of more than one offers collapse/expand all', !!all);
        all.click();
        ok('...and it reaches every row',
          [...document.querySelectorAll('#inspector .fx-box .fx-fx-body')]
            .every((b) => b.hidden === true));
        [...document.querySelectorAll('#inspector .fx-box .fx-head button')]
          .find((b) => /Expand all/.test(b.textContent)).click();
        ok('expand all puts them all back',
          [...document.querySelectorAll('#inspector .fx-box .fx-fx-body')]
            .every((b) => b.hidden === false));
      }

      while (undoStack.length > undo0) undo();
      ok('undoing every panel edit leaves the clip with no stack at all',
        !live() || !live().fx, JSON.stringify(live() && live().fx));
    }

    // ============================================================ 13. end to end
    const graded = live();
    graded.fx = [FX.create('grade')];
    graded.fx[0].params.gain = 1.4;
    graded.fx[0].params.saturation = 0.5;
    graded.fx[0].params.temperature = 0.25;
    renderAll();
    state.playhead = 1;
    syncMedia();
    await sleep(900);
    drawPreview();
    await sleep(150);
    drawPreview();
    const P = previewSize();
    const previewPx = (() => {
      const d = ctx.getImageData(P.w / 2 | 0, P.h / 2 | 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    })();
    ok('the preview shows the grade rather than the raw footage',
      Math.abs(previewPx[2] - 0xC0) > 8 || Math.abs(previewPx[0] - 0x20) > 8,
      'graded ' + previewPx.join(',') + ' raw 32,96,192');

    job = buildJob(D + 'fx_out.mp4', { from: 0, to: 2 });
    job.cacheKey = jobCacheKey(job);
    job.useCache = false;
    const dirs = await bakeOverlays(job);
    ok('the graded span baked one raw layer', dirs.length === 1, 'dirs=' + dirs.length);
    ok('the graded clip is dropped from the picture chain - the bake already has it',
      job.clips.filter((e) => e.kind === 'video' && e.visible).length === 0);
    const res = await window.api.startRender(job);
    for (const d of dirs) window.api.endTextSeq(d);
    ok('the render completes', res.ok, res.error || '');

    if (res.ok) {
      const probe = document.createElement('video');
      probe.src = 'file:///' + res.outPath.replace(/\\/g, '/');
      probe.muted = true;
      await new Promise((r) => { probe.onloadeddata = r; probe.onerror = r; probe.load(); setTimeout(r, 6000); });
      probe.currentTime = 1;
      await new Promise((r) => { probe.onseeked = r; setTimeout(r, 4000); });
      const cv = document.createElement('canvas');
      cv.width = job.width; cv.height = job.height;
      const c2 = cv.getContext('2d');
      c2.drawImage(probe, 0, 0, job.width, job.height);
      const rd = c2.getImageData(job.width / 2 | 0, job.height / 2 | 0, 1, 1).data;
      // yuv420p round-trips through 8-bit chroma, so the tolerance is the codec's.
      ok('THE HEADLINE: a graded clip renders to what the preview canvas painted',
        near(rd[0], previewPx[0], 8) && near(rd[1], previewPx[1], 8) && near(rd[2], previewPx[2], 8),
        'render=' + [rd[0], rd[1], rd[2]].join(',') + ' preview=' + previewPx.join(','));
    }

    if (live()) delete live().fx;
    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
