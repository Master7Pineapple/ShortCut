/**
 * Magic Mask: prompt encoding, the propagation loop, the cache key and the matte edges.
 *
 *   SHORTCUT_SMOKE=tools/smoke-mask.js node_modules/.bin/electron .
 *
 * NO FIXTURE AND NO MODEL. Every frame is painted here - a coloured shape translating
 * across a textured ground - which is the only way a masking claim can be exact: the
 * right answer is known to the pixel before anything segments anything. And the segmenter
 * is INJECTED, so the whole loop runs without downloading 45 MB of MobileSAM; the suite
 * installs an engine it wrote, and the app installs one that talks to onnxruntime. That
 * split is the single most valuable design decision in the feature, and this file is what
 * it bought.
 *
 * The nine things it exists to hold down:
 *
 *   1. PROMPT ENCODING. A scribble becomes points along its own length, both ends kept,
 *      the count capped, and the SIGN carried through - a negative stroke must arrive at
 *      the decoder as label 0 or it is just a positive stroke in the wrong place.
 *   2. NEGATIVE STROKES ACTUALLY CUT. The gap between two same-coloured things is only
 *      removable by saying "not that", and a suite that only ever paints positives would
 *      never notice if the sign were being dropped.
 *   3. THE PROPAGATION LOOP follows a moving shape it was only ever shown on one frame,
 *      and it does it by re-deriving its seed from the mask that moved - not by re-using
 *      the anchor's points, which would pin the matte to where the object WAS.
 *   4. CORRECTION RE-ANCHORS FORWARD ONLY. `plan()` restarts at a corrected frame and
 *      leaves the segment before it alone - the contract a dragged tracker keeps, and the
 *      whole reason painting on frame 40 is a usable answer to drift at frame 40.
 *   5. THE CACHE KEY MOVES WITH THE FILE, NOT THE CLIP. Move the clip, trim it, re-frame
 *      it, put it on another track: same key, same mattes. Change one stroke: different
 *      key. This is the load-bearing one, and it is the same rule the render cache, the
 *      track cache and the bake cache all live by.
 *   6. THE EDGE OPERATIONS - grow, choke, feather, invert - and the ORDER they run in,
 *      which is a feature rather than a detail.
 *   7. THE UNIT RULE. A feather is a fraction of the plane's shorter side, so the same
 *      number is the same softness at two resolutions. This is `fx.js`'s parity rule one
 *      file along, stated as a measurement.
 *   8. THE DATA IS PLAIN JSON on the clip: absent until painted, pruned with the last
 *      mask, survives a save and reload, and a stroke is ONE undo entry.
 *   9. THE RENDER KEY. A masked clip keeps its cached render when it MOVES and loses it
 *      when a stroke changes - and a clip that merely carries a mask nothing cuts with
 *      keys exactly as one that never had one.
 *
 * Plus the matte in the picture: a `matte` effect must cut the clip in the composite, and
 * cut it the same way at two resolutions.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

    // ---------------------------------------------------------------- fixtures
    //
    // A frame: a red square on a faintly textured blue-grey ground, with a second SEPARATE
    // red square close by. The second one is the reason negative strokes exist - it is the
    // same colour, so nothing about colour alone can tell them apart, and only "not that"
    // can keep it out.
    const AW = 192, AH = 108;
    const SQ = 34;                 // the tracked square's side
    function frame(dx, dy, withDecoy) {
      const a = new Uint8ClampedArray(AW * AH * 4);
      for (let y = 0; y < AH; y++) {
        for (let x = 0; x < AW; x++) {
          const i = (y * AW + x) * 4;
          const tex = (x * 3 + y * 5) % 5;
          a[i] = 40 + tex; a[i + 1] = 58 + tex; a[i + 2] = 92 + tex;
          const inA = x >= 30 + dx && x < 30 + dx + SQ && y >= 34 + dy && y < 34 + dy + SQ;
          const inB = withDecoy && x >= 120 && x < 120 + SQ && y >= 34 && y < 34 + SQ;
          if (inA || inB) { a[i] = 208; a[i + 1] = 52; a[i + 2] = 48; }
          a[i + 3] = 255;
        }
      }
      return a;
    }

    /** Where the tracked square is at `dx`, as a box in pixels. */
    const truth = (dx, dy) => ({ x0: 30 + dx, y0: 34 + dy, x1: 30 + dx + SQ - 1, y1: 34 + dy + SQ - 1 });

    const clipC = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const inside = (alpha, w, x, y) => alpha[Math.round(y) * w + Math.round(x)] >= 128;
    const count = (alpha) => { let n = 0; for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 128) n++; return n; };

    // ========================================= 0. the defaults actually reach the mask
    //
    // THE REGRESSION THIS SECTION EXISTS FOR, and it shipped.
    //
    // `clamp()` answers `lo` for a value that is not a number, so `clamp(undefined, 128,
    // 2048)` is 128, and the `|| DEFAULTS.res` written after it never fired because 128 is
    // truthy. Every mask painted by that build was cut at 128 px instead of 1024, and
    // MobileSAM at 128 returns 99.9% of the frame - so the feature drew a wash of tint over
    // the picture instead of a cut-out, silently, on the very first stroke.
    //
    // The suite did not catch it because every mask it built passed explicit options. So
    // these assertions pin the NO-ARGUMENT case specifically, which is the only case the
    // app ever uses: there is no control for either value.

    {
      const m = MagicMask.makeMask('Fresh');
      ok('makeMask() with no options uses the DEFAULTS, not the bottom of their clamps - ' +
        'the bug that cut every mask at 128 px and returned the whole frame',
        m.res === MagicMask.DEFAULTS.res && m.rate === MagicMask.DEFAULTS.rate,
        'res ' + m.res + ', rate ' + m.rate);

      const bare = MagicMask.normalizeMask({ strokes: [] });
      ok('...and so does normalizeMask() on a mask that carries neither',
        bare.res === MagicMask.DEFAULTS.res && bare.rate === MagicMask.DEFAULTS.rate);

      const broken = MagicMask.normalizeMask({ res: 128, rate: 1, strokes: [] });
      ok('a project saved by the broken build opens REPAIRED rather than clamped to the ' +
        'band floor - neither value has a control, so anything out of band was written by ' +
        'that bug and no author ever asked for it',
        broken.res === MagicMask.DEFAULTS.res && broken.rate === MagicMask.DEFAULTS.rate,
        'res ' + broken.res + ', rate ' + broken.rate);

      const legal = MagicMask.normalizeMask({ res: 768, rate: 24, strokes: [] });
      ok('...while a value INSIDE the band is left exactly alone',
        legal.res === 768 && legal.rate === 24);

      const sm = MagicMask.makeMask('S');
      const st = MagicMask.addStroke(sm, 0, +1, [0.1, 0.1, 0.2, 0.2]);
      ok('a stroke with no radius gets the default brush, not the smallest one allowed - ' +
        'the same mistake, on the same line shape',
        st.r === MagicMask.DEFAULTS.brush, 'r ' + st.r);

      // And the fourth instance of it, which made the built-in engine's reach 4 instead of
      // 42 - tight enough to refuse a faintly textured region, which is every real one.
      const W = 48, H = 48;
      const rgba = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const inIt = x >= 12 && x < 36 && y >= 12 && y < 36;
          // +/- 12 levels of texture: far more than a reach of 4 admits, and utterly
          // ordinary for real footage.
          const t = ((x * 7 + y * 5) % 25) - 12;
          const v = (inIt ? 200 : 60) + t;
          rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
        }
      }
      const got = MagicMask.localEngine({
        w: W, h: H, rgba, points: [{ x: 24, y: 24, label: 1 }],
      }).alpha;
      let n = 0;
      for (let i = 0; i < got.length; i++) if (got[i] >= 128) n++;
      ok('the built-in engine’s default reach admits a TEXTURED region rather than ' +
        'stopping at the first noisy pixel', n > 24 * 24 * 0.8, n + ' px of ' + 24 * 24);
    }

    // ================================================== 1. prompt encoding

    {
      const m = MagicMask.makeMask('M');
      // A long scribble down the middle of the square, and a single dab.
      const pts = [];
      for (let i = 0; i <= 20; i++) pts.push(0.25, 0.35 + i * 0.01);
      MagicMask.addStroke(m, 1.0, +1, pts, 0.02);
      MagicMask.addStroke(m, 1.0, -1, [0.7, 0.4, 0.71, 0.41], 0.02);

      const P = MagicMask.promptsAt(m, 1.0, AW, AH);
      ok('a scribble and a dab both reach the decoder', P.length >= 3, P.length + ' points');
      ok('the sign survives: the negative stroke arrives as label 0',
        P.some((p) => p.label === 1) && P.some((p) => p.label === 0));
      ok('prompts are in PIXELS of the analysis frame, not fractions',
        P.every((p) => p.x >= 0 && p.x <= AW && p.y >= 0 && p.y <= AH) &&
        P.some((p) => p.x > 1.5));

      const long = MagicMask.strokePoints(m.strokes.find((s) => s.sign > 0), AW, AH);
      ok('a long scribble is resampled along its length rather than kept sample-for-sample',
        long.length > 1 && long.length <= MagicMask.DEFAULTS.maxPts,
        long.length + ' from ' + (pts.length / 2));
      ok('...and BOTH ENDS are kept - the ends of a stroke down an arm are the wrist and ' +
        'the shoulder, which is exactly what the decoder needs told',
        near(long[0].y, 0.35 * AH, 0.75) && near(long[long.length - 1].y, 0.55 * AH, 0.75));

      // The cap, against a deliberately frantic scribble.
      const many = [];
      for (let i = 0; i < 600; i++) many.push(0.2 + i * 0.0005, 0.3 + (i % 7) * 0.02);
      const m2 = MagicMask.makeMask('M2');
      MagicMask.addStroke(m2, 0, +1, many, 0.005);
      const capped = MagicMask.strokePoints(m2.strokes[0], AW, AH);
      ok('a frantic scribble cannot hand the decoder four hundred points',
        capped.length <= MagicMask.DEFAULTS.maxPts, capped.length);
      ok('...and it is THINNED evenly rather than truncated - the tail of a stroke is not ' +
        'less informative than its head',
        capped[capped.length - 1].x > capped[0].x + 0.2 * AW);

      // Prompts belong to a FRAME. A stroke painted at 1.0s must not prompt a solve at 4.0s.
      ok('prompts are per-frame: a stroke painted elsewhere does not leak into this one',
        MagicMask.promptsAt(m, 4.0, AW, AH).length === 0);
    }

    // ================================================== 2. the engine, and negatives

    // The suite's own segmenter is the LOCAL one - a colour region-grow. That is a real
    // engine, not a stub: it is what the app falls back to with no model downloaded, so
    // testing through it tests a path that actually ships.
    MagicMask.setEngine(null);

    {
      const rgba = frame(0, 0, true);
      const m = MagicMask.makeMask('One square');
      MagicMask.addStroke(m, 0, +1, [(30 + 8) / AW, (34 + 8) / AH, (30 + 26) / AW, (34 + 26) / AH], 0.02);

      const a1 = await MagicMask.solveFrame({
        w: AW, h: AH, rgba, points: MagicMask.promptsAt(m, 0, AW, AH), box: null, prev: null,
      });
      const t0 = truth(0, 0);
      ok('a positive scribble selects the shape it was painted on',
        inside(a1, AW, (t0.x0 + t0.x1) / 2, (t0.y0 + t0.y1) / 2));
      ok('...and not the ground around it',
        !inside(a1, AW, 8, 8) && !inside(a1, AW, AW - 8, AH - 8));
      ok('...and a SEPARATE shape of the same colour is not swept in, because the fill is ' +
        'connected rather than a colour threshold over the whole frame',
        !inside(a1, AW, 120 + SQ / 2, 34 + SQ / 2));

      // Now the case negative strokes exist for: one scribble that crosses BOTH squares.
      // Colour cannot separate them; the sign can.
      const wide = [];
      for (let i = 0; i <= 30; i++) wide.push((32 + i * 4.3) / AW, (34 + SQ / 2) / AH);
      const m2 = MagicMask.makeMask('Both');
      MagicMask.addStroke(m2, 0, +1, wide, 0.02);
      const both = await MagicMask.solveFrame({
        w: AW, h: AH, rgba, points: MagicMask.promptsAt(m2, 0, AW, AH), box: null, prev: null,
      });
      ok('one stroke across both squares takes both',
        inside(both, AW, 30 + SQ / 2, 34 + SQ / 2) && inside(both, AW, 120 + SQ / 2, 34 + SQ / 2));

      MagicMask.addStroke(m2, 0, -1, [(120 + 6) / AW, (34 + 6) / AH, (120 + 28) / AW, (34 + 28) / AH], 0.02);
      const cut = await MagicMask.solveFrame({
        w: AW, h: AH, rgba, points: MagicMask.promptsAt(m2, 0, AW, AH), box: null, prev: null,
      });
      ok('A NEGATIVE STROKE CUTS IT BACK OUT. This is the assertion the whole "negative ' +
        'strokes are not optional" argument rests on, and a click-only tool cannot express it',
        inside(cut, AW, 30 + SQ / 2, 34 + SQ / 2) && !inside(cut, AW, 120 + SQ / 2, 34 + SQ / 2));
    }

    // ================================================== 3. the propagation loop

    {
      // The shape moves 3 px a step, for 24 steps. It is painted ONCE, on the first frame.
      const STEPS = 24, DX = 3;
      const m = MagicMask.makeMask('Moving', { rate: 10 });
      MagicMask.addStroke(m, 0, +1, [(30 + 8) / AW, (34 + 8) / AH, (30 + 26) / AW, (34 + 26) / AH], 0.02);

      const steps = MagicMask.plan(m, 0, STEPS / 10, 10);
      ok('the plan covers the range at the mask rate, anchored on the painted frame',
        steps.length >= STEPS - 1 && steps.filter((s) => s.anchor).length === 1,
        steps.length + ' frames, ' + steps.filter((s) => s.anchor).length + ' anchor');

      const dxAt = (t) => Math.round(t * 10) * DX;
      const out = await MagicMask.propagate(m, steps,
        async (t) => ({ w: AW, h: AH, rgba: frame(dxAt(t), 0, false) }), {});

      ok('every planned frame came back with a matte', out.length === steps.length,
        out.length + ' / ' + steps.length);

      let followed = 0, drifted = null;
      for (const rec of out) {
        const b = MagicMask.bbox(rec.alpha, AW, AH, 128);
        const want = truth(dxAt(rec.t), 0);
        if (!b) { drifted = drifted || ('no matte at t=' + rec.t); continue; }
        // The box `bbox()` answers is padded, so it is checked by its CENTRE, which is
        // not - a padded box would pass a centre test it had no business passing only if
        // the matte were symmetrically wrong, which is not a failure mode of a flood fill.
        const cx = (b.x0 + b.x1) / 2, want_cx = (want.x0 + want.x1) / 2;
        if (Math.abs(cx - want_cx) <= 2) followed++;
        else if (!drifted) drifted = 'at t=' + rec.t + ' centre ' + cx.toFixed(1) + ' want ' + want_cx.toFixed(1);
      }
      ok('THE MATTE FOLLOWS THE SHAPE it was only ever painted on once - the seed is ' +
        're-derived from the mask that moved, not re-used from the anchor',
        followed === out.length, followed + ' / ' + out.length + (drifted ? '   first miss: ' + drifted : ''));

      const last = out[out.length - 1];
      ok('...and it is still the right SIZE at the far end, rather than having grown into ' +
        'the background or shrunk to a dot',
        Math.abs(count(last.alpha) - SQ * SQ) < SQ * SQ * 0.25,
        count(last.alpha) + ' px, want ~' + SQ * SQ);

      // Seeding from the previous matte, directly: the centroid of a C-shaped matte is
      // outside it, and a seed there would start the next frame on the background.
      const cShape = new Uint8ClampedArray(AW * AH);
      for (let y = 20; y < 80; y++) for (let x = 20; x < 70; x++) {
        if (x > 32 && y > 32 && y < 68) continue;      // the bite out of the C
        cShape[y * AW + x] = 255;
      }
      const seeds = MagicMask.seedFrom(cShape, AW, AH, 128);
      ok('seeds are taken from INSIDE the matte, even when its centroid is not - a C has ' +
        'its centre of mass in the hole',
        seeds.length > 0 && seeds.every((p) => cShape[Math.round(p.y) * AW + Math.round(p.x)] >= 128));
    }

    // ================================================== 4. corrections re-anchor forward

    {
      const m = MagicMask.makeMask('Corrected', { rate: 10 });
      MagicMask.addStroke(m, 0, +1, [0.2, 0.4, 0.25, 0.45], 0.02);
      MagicMask.addStroke(m, 2.0, +1, [0.6, 0.4, 0.65, 0.45], 0.02);

      const a = MagicMask.anchors(m);
      ok('two frames painted on are two anchors', a.length === 2 && near(a[0], 0) && near(a[1], 2));

      const steps = MagicMask.plan(m, 0, 4, 10);
      const segs = [...new Set(steps.map((s) => s.seg))];
      ok('a correction cuts the range into segments at the frame it was painted on',
        segs.length === 2);
      const before = steps.filter((s) => s.seg === segs[0]);
      const after = steps.filter((s) => s.seg === segs[1]);
      ok('...the first segment ENDS at the correction, so re-solving it never reaches past',
        before.every((s) => s.t <= 2 + 1e-6) && after.every((s) => s.t >= 2 - 1e-6));
      ok('...and each segment is decoded from its OWN anchor, not from the frame before it',
        before[0].anchor && after[0].anchor && near(after[0].t, 2));

      // Painting in the MIDDLE means the whole clip, not the second half of it.
      const mid = MagicMask.makeMask('Mid', { rate: 10 });
      MagicMask.addStroke(mid, 2.0, +1, [0.5, 0.5, 0.52, 0.52], 0.02);
      const st2 = MagicMask.plan(mid, 0, 4, 10);
      ok('painting on the middle of a clip solves BACKWARD as well - the first anchor owns ' +
        'everything before it',
        st2.some((s) => s.t < 1.9) && st2.some((s) => s.t > 2.1));
      // `plan()` names the anchor once per segment, because a segment that did not start
      // from the painted prompts would have nothing to seed itself with. What must not
      // happen is DECODING it twice and putting two records at one instant in the store,
      // so the assertion is on the propagation's output rather than on the plan.
      const midOut = await MagicMask.propagate(mid, st2,
        async () => ({ w: AW, h: AH, rgba: frame(0, 0, false) }), {});
      ok('...and the anchor frame is DECODED once, not once per direction - two records at ' +
        'one instant would be two answers to the same question',
        midOut.filter((r) => near(r.t, 2, 1e-3)).length === 1,
        midOut.filter((r) => near(r.t, 2, 1e-3)).length + ' record(s) at t=2');

      // Strokes on the same frame are one anchor, however many there are.
      const many = MagicMask.makeMask('Many', { rate: 10 });
      MagicMask.addStroke(many, 1.0, +1, [0.2, 0.2, 0.3, 0.3], 0.02);
      MagicMask.addStroke(many, 1.004, -1, [0.4, 0.4, 0.5, 0.5], 0.02);
      MagicMask.addStroke(many, 1.0, +1, [0.6, 0.6, 0.7, 0.7], 0.02);
      ok('four strokes on one frame are ONE anchor, not four',
        MagicMask.anchors(many).length === 1);
    }

    // ================================================== 5. matte edge operations

    {
      const W = 64, H = 64;
      const plane = new Uint8ClampedArray(W * H);
      for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) plane[y * W + x] = 255;
      const n0 = count(plane);

      const grown = MagicMask.edge(plane, W, H, { grow: 4 / 64 });
      const choked = MagicMask.edge(plane, W, H, { grow: -4 / 64 });
      ok('grow makes the matte bigger and choke makes it smaller',
        count(grown) > n0 && count(choked) < n0,
        count(choked) + ' < ' + n0 + ' < ' + count(grown));
      ok('...by the amount asked for, on every side',
        grown[32 * W + 48 + 2] >= 128 && choked[32 * W + 47 - 2] < 128);

      const feathered = MagicMask.edge(plane, W, H, { feather: 4 / 64 });
      ok('feather softens the edge and leaves the middle solid',
        feathered[32 * W + 32] >= 250 &&
        feathered[32 * W + 16] > 10 && feathered[32 * W + 16] < 245);
      ok('...without moving the edge: a feather is symmetric, so the half-value sits where ' +
        'the hard edge did',
        Math.abs(feathered[32 * W + 16] - 128) <= 36, feathered[32 * W + 16]);

      const inv = MagicMask.edge(plane, W, H, { invert: true });
      ok('invert swaps the object and the background',
        inv[32 * W + 32] === 0 && inv[2 * W + 2] === 255);

      // THE ORDER, which is the feature. Choke-then-feather must not come back hard, and
      // a choke must pull the OBJECT in even when the result is inverted.
      const cf = MagicMask.edge(plane, W, H, { grow: -3 / 64, feather: 3 / 64 });
      let ramp = 0;
      for (let x = 0; x < W; x++) { const v = cf[32 * W + x]; if (v > 8 && v < 247) ramp++; }
      ok('grow runs BEFORE feather, so a choked matte still has a soft edge rather than a ' +
        're-hardened one',
        ramp >= 6, ramp + ' ramp pixels');

      const ci = MagicMask.edge(plane, W, H, { grow: -4 / 64, invert: true });
      ok('...and grow runs before INVERT, so a choke shrinks the object rather than the ' +
        'background - the difference between pulling a halo in and pushing it out',
        ci[32 * W + 18] === 255 && ci[32 * W + 32] === 0);

      ok('every operation leaves the input alone - an edge pass is a value, not a mutation',
        count(plane) === n0);

      // THE UNIT RULE. The same fraction at two plane sizes is the same softness.
      const big = 256;
      const pb = new Uint8ClampedArray(big * big);
      for (let y = big / 4; y < big * 3 / 4; y++) for (let x = big / 4; x < big * 3 / 4; x++) pb[y * big + x] = 255;
      const fb = MagicMask.edge(pb, big, big, { feather: 4 / 64 });
      const fs = MagicMask.edge(plane, W, H, { feather: 4 / 64 });
      // Sample the ramp at the same PROPORTIONAL distance in from the edge on each.
      const prof = (a, side) => {
        const y = side / 2, e = side / 4;
        return [-0.06, -0.02, 0, 0.02, 0.06].map((d) => a[y * side + Math.round(e + d * side)]);
      };
      const A = prof(fs, W), B = prof(fb, big);
      const worst = Math.max(...A.map((v, i) => Math.abs(v - B[i])));
      // 20 levels of 255, which is the same shape of claim `smoke-fx.js` makes for the
      // effect stack at two resolutions. It cannot be zero and should not be asked to be:
      // a radius in pixels is an integer at both sizes, so the two ramps are sampled at
      // slightly different sub-pixel phases and the steepest part of the ramp is where
      // that shows. What matters is that the SOFTNESS is the same, not that the two
      // rasterisations are identical.
      ok('THE UNIT RULE: the same feather fraction is the same softness at 64 and at 256, ' +
        'so the viewer and the 1080x1920 file agree', worst <= 20, 'worst ' + worst + ' / 255');

      // And the feather clamps at the frame edge rather than fading to nothing, which is
      // what a matte of someone standing at the side of the shot needs.
      const edgeUp = new Uint8ClampedArray(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) edgeUp[y * W + x] = 255;
      const fe = MagicMask.edge(edgeUp, W, H, { feather: 4 / 64 });
      ok('a matte that runs off the edge of the picture is not eaten by its own feather',
        fe[32 * W + 0] >= 250, fe[32 * W + 0]);
    }

    // ================================================== 6. the cache key

    {
      const mask = MagicMask.makeMask('K', { rate: 10 });
      MagicMask.addStroke(mask, 0.5, +1, [0.3, 0.4, 0.35, 0.45], 0.02);
      const base = { t0: 0, t1: 4, res: 512, rate: 10, engine: 'local', mask };
      const k0 = MagicMask.cacheKey(base);

      ok('the same mask over the same range keys the same, twice running',
        MagicMask.cacheKey(base) === k0);
      ok('a different SOURCE RANGE is a different key - trimming changes which frames ' +
        'were cut',
        MagicMask.cacheKey(Object.assign({}, base, { t1: 3 })) !== k0);
      ok('a different RESOLUTION is a different key',
        MagicMask.cacheKey(Object.assign({}, base, { res: 256 })) !== k0);
      ok('a different ENGINE is a different key - a matte cut by colour and one cut by ' +
        'MobileSAM are different pixels from the same strokes, so a finished download must ' +
        'not serve the old mattes back',
        MagicMask.cacheKey(Object.assign({}, base, { engine: 'sam' })) !== k0);

      const m2 = JSON.parse(JSON.stringify(mask));
      m2.strokes[0].pts[0] += 0.02;
      ok('moving a stroke is a different key',
        MagicMask.cacheKey(Object.assign({}, base, { mask: m2 })) !== k0);
      const m3 = JSON.parse(JSON.stringify(mask));
      m3.strokes[0].sign = -1;
      ok('flipping a stroke\u2019s SIGN is a different key - the sign is half the prompt',
        MagicMask.cacheKey(Object.assign({}, base, { mask: m3 })) !== k0);

      const m4 = JSON.parse(JSON.stringify(mask));
      m4.id = 'mk-somethingelse';
      m4.name = 'renamed';
      ok('...but the mask\u2019s own ID and NAME are NOT in it: an id is an identity handed ' +
        'out when it was created, so leaving it in would mean a duplicated clip never ' +
        'shared the original\u2019s mattes',
        MagicMask.cacheKey(Object.assign({}, base, { mask: m4 })) === k0);

      // Stroke ORDER is not content: the same strokes painted in the other order are the
      // same prompts and must key the same.
      const m5 = MagicMask.makeMask('K5', { rate: 10 });
      MagicMask.addStroke(m5, 1.5, +1, [0.6, 0.6, 0.65, 0.65], 0.02);
      MagicMask.addStroke(m5, 0.5, +1, [0.3, 0.4, 0.35, 0.45], 0.02);
      const m6 = MagicMask.makeMask('K6', { rate: 10 });
      MagicMask.addStroke(m6, 0.5, +1, [0.3, 0.4, 0.35, 0.45], 0.02);
      MagicMask.addStroke(m6, 1.5, +1, [0.6, 0.6, 0.65, 0.65], 0.02);
      ok('the same strokes painted in a different order are the same key - they are sorted ' +
        'by time, so the cache does not depend on the order of the person\u2019s hand',
        MagicMask.cacheKey(Object.assign({}, base, { mask: m5 })) ===
        MagicMask.cacheKey(Object.assign({}, base, { mask: m6 })));
    }

    // ================================================== 7. on the timeline

    {
      const vt = state.tracks.find((t) => t.type === 'video');
      const id = nextId();
      vt.clips.push({
        id, src: 'C:\\fake\\demo.mp4', name: 'demo', kind: 'video',
        start: 2, in: 0, out: 6, mediaDuration: 6,
        srcW: 1920, srcH: 1080, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      sortTracks();
      const live = () => allClips().map((x) => x.clip).find((c) => c.id === id);
      setSelection([id], false);
      renderInspector();

      ok('a video clip gets the Magic Mask panel',
        !!document.querySelector('#inspector .mm-box'));

      // THE END-TO-END VERSION of section 0, which is the assertion that would have caught
      // the shipped bug on its own: what matters is not that `DEFAULTS.res` says 1024, it is
      // that the frame handed to the segmenter is 1024 on its long side.
      ok('a default mask on a 1920x1080 clip is analysed at 1024 on the long side - the ' +
        'scale MobileSAM works at, rather than whatever a clamp floor happened to be',
        (() => {
          const sz = mmSize(live(), MagicMask.makeMask('probe'));
          return sz.aw === 1024 && sz.ah === 576;
        })(),
        (() => { const z = mmSize(live(), MagicMask.makeMask('probe')); return z.aw + 'x' + z.ah; })());
      ok('...and `matte` is offered in the stack menu but DISABLED with a reason until ' +
        'something is painted - the gap that let the pointer effects be added to any clip ' +
        'and then silently draw nothing',
        (() => {
          const o = [...document.querySelectorAll('#inspector .fx-box .fx-add select option')]
            .find((x) => x.value === 'matte');
          return !!o && o.disabled && /painted mask/.test(o.textContent);
        })());

      const c = live();
      ok('a clip with no mask carries no `masks` key at all - absent by default, exactly ' +
        'as `fx`, `keys` and `tracks` are',
        !('masks' in c));

      // Painting a stroke: ONE undo entry, and the data is plain JSON.
      const undo0 = undoStack.length;
      pushUndo();
      c.masks = [MagicMask.makeMask('Mask 1', { rate: 10 })];
      MagicMask.addStroke(c.masks[0], 1.0, +1, [0.4, 0.5, 0.45, 0.55], 0.03);
      MagicMask.normalizeClip(c);
      markDirty();
      renderAll();
      ok('painting a stroke is ONE undo entry', undoStack.length === undo0 + 1,
        undo0 + ' -> ' + undoStack.length);

      const round = JSON.parse(JSON.stringify(c.masks));
      ok('the mask is plain JSON: it survives a stringify/parse round trip intact',
        JSON.stringify(round) === JSON.stringify(c.masks));
      ok('...and nothing non-serialisable rode along - no canvas, no typed array, no matte',
        JSON.stringify(c.masks).length < 600, JSON.stringify(c.masks).length + ' bytes');

      // The RENDER KEY. This is the load-bearing one.
      const digestOf = () => {
        const saved = state.range;
        const job = buildJob('');
        const mine = job.clips.find((x) => x.id === id);
        state.range = saved;
        return JSON.stringify(mine.masks === undefined ? null : mine.masks);
      };
      const noFx = digestOf();
      ok('a clip that merely CARRIES a mask keys exactly as one that never had one - ' +
        'painting is authoring, and a mask nothing cuts with changes no pixels',
        noFx === 'null');

      pushUndo();
      const f = FX.create('matte');
      f.params.mask = c.masks[0].id;
      c.fx = [f];
      FX.normalizeClip(c);
      renderAll();
      const withFx = digestOf();
      ok('putting a `matte` effect on it puts the prompts into the render key',
        withFx !== 'null' && withFx !== noFx);

      const moved = (() => {
        live().start = 7.25;
        sortTracks();
        const d = digestOf();
        live().start = 2;
        sortTracks();
        return d;
      })();
      ok('MOVING THE CLIP DOES NOT CHANGE THE KEY. A matte belongs to the file and the ' +
        'strokes, so dragging the clip down the timeline must keep its cached render - ' +
        'the same rule the render, track and bake caches all live by',
        moved === withFx);

      const reframed = (() => {
        live().panX = 0.2; live().zoom = 1.4;
        const d = digestOf();
        live().panX = 0.5; live().zoom = 1;
        return d;
      })();
      ok('...and neither does RE-FRAMING it: the matte is read through the same crop the ' +
        'picture is, so the framing is already in the job and does not belong in the mask ' +
        'digest twice',
        reframed === withFx);

      const edited = (() => {
        MagicMask.addStroke(live().masks[0], 1.0, -1, [0.8, 0.8, 0.82, 0.82], 0.03);
        MagicMask.normalizeClip(live());
        const d = digestOf();
        live().masks[0].strokes.pop();
        return d;
      })();
      ok('...but painting another stroke DOES change it', edited !== withFx);

      const bypassed = (() => {
        live().fx[0].enabled = false;
        const d = digestOf();
        live().fx[0].enabled = true;
        return d;
      })();
      ok('a BYPASSED matte keys as no matte at all - a clip whose effect is switched off ' +
        'is a clip whose pixels do not depend on the prompts',
        bypassed === 'null');

      // Degradation: a matte effect pointed at a mask that is gone must not throw.
      const gone = (() => {
        const saved = live().masks;
        delete live().masks;
        let threw = null;
        try { FX.paramsAt(live().fx[0], 1, live(), 540, 960); } catch (e) { threw = e; }
        let drew = null;
        try {
          const cv = document.createElement('canvas');
          cv.width = 32; cv.height = 32;
          drew = FX.render(cv.getContext('2d'), 32, 32, live(), 1, fxSurface,
            (tc) => { tc.fillStyle = '#fff'; tc.fillRect(0, 0, 32, 32); }, 1 / 30);
        } catch (e) { threw = threw || e; }
        live().masks = saved;
        return { threw, drew };
      })();
      ok('a matte whose mask has been deleted draws the clip UNMASKED rather than throwing ' +
        'or drawing nothing - "there is no matte yet" must never mean "there is no clip"',
        !gone.threw && gone.drew === true, gone.threw ? String(gone.threw.message) : '');

      // Pruning, the other half of "absent by default".
      pushUndo();
      delete live().fx;
      live().masks = [];
      MagicMask.normalizeClip(live());
      ok('the last mask going takes the `masks` key with it', !('masks' in live()));

      vt.clips.splice(vt.clips.findIndex((x) => x.id === id), 1);
      state.selection.clear();
      renderAll();
    }

    // ================================================== 8. the matte in the picture

    {
      // A `matte` effect must actually cut the clip in the composite, and cut it the SAME
      // at two resolutions - which is this file's half of `fx.js`'s parity rule.
      const W1 = 108, H1 = 192, W2 = 216, H2 = 384;
      const mask = MagicMask.makeMask('Cut', { rate: 10 });
      MagicMask.addStroke(mask, 0, +1, [0.3, 0.4, 0.4, 0.5], 0.02);

      const clip = {
        id: 'mmfake', kind: 'video', src: 'C:\\fake\\demo.mp4',
        start: 0, in: 0, out: 4, mediaDuration: 4, srcW: AW, srcH: AH,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
        masks: [mask],
      };
      const f = FX.create('matte');
      f.params.mask = mask.id;
      f.params.feather = 0;
      clip.fx = [f];

      // A matte that keeps the left half of the source and cuts the right.
      const plane = new Uint8ClampedArray(AW * AH);
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW / 2; x++) plane[y * AW + x] = 255;
      Mask.mattes.set(clip.id + '|' + mask.id, { key: 'test', w: AW, h: AH, frames: [{ t: 0, alpha: plane }] });
      Mask.plate = null;

      const shot = (W, H) => {
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx2 = cv.getContext('2d');
        ctx2.clearRect(0, 0, W, H);
        Mask.plate = null;
        FX.render(ctx2, W, H, clip, 0, fxSurface, (tc) => {
          tc.fillStyle = '#ffffff';
          tc.fillRect(0, 0, W, H);
        }, 1 / 30);
        return ctx2.getImageData(0, 0, W, H).data;
      };
      const a = shot(W1, H1), b = shot(W2, H2);
      const alphaAt = (d, W, fx, fy, H) =>
        d[((Math.round(fy * (H - 1))) * W + Math.round(fx * (W - 1))) * 4 + 3];

      ok('the matte CUTS: the kept side is opaque and the cut side is gone',
        alphaAt(a, W1, 0.2, 0.5, H1) > 240 && alphaAt(a, W1, 0.8, 0.5, H1) < 12,
        alphaAt(a, W1, 0.2, 0.5, H1) + ' / ' + alphaAt(a, W1, 0.8, 0.5, H1));
      ok('...and it cuts in the SAME PLACE at double the resolution, which is preview and ' +
        'render agreeing for this effect, stated as one measurement',
        Math.abs(alphaAt(a, W1, 0.2, 0.5, H1) - alphaAt(b, W2, 0.2, 0.5, H2)) <= 8 &&
        Math.abs(alphaAt(a, W1, 0.8, 0.5, H1) - alphaAt(b, W2, 0.8, 0.5, H2)) <= 8);

      const inv = () => {
        f.params.invert = 1;
        const d = shot(W1, H1);
        f.params.invert = 0;
        return d;
      };
      const iv = inv();
      ok('invert on the effect flips which half survives, and it keyframes like any other ' +
        'parameter because it is an ordinary param on an ordinary DEFS entry',
        alphaAt(iv, W1, 0.2, 0.5, H1) < 12 && alphaAt(iv, W1, 0.8, 0.5, H1) > 240);

      const amt = () => {
        f.params.mix = 0;
        const d = shot(W1, H1);
        f.params.mix = 1;
        return d;
      };
      const zero = amt();
      ok('Amount at 0 is NO MATTE AT ALL rather than a faded-out clip - it fades towards ' +
        'alpha 255 everywhere, not towards 0',
        alphaAt(zero, W1, 0.2, 0.5, H1) > 240 && alphaAt(zero, W1, 0.8, 0.5, H1) > 240);

      // And the one this feature could most easily get wrong in silence.
      ok('the plate is built as TRANSPARENCY, not as black-and-white. A mask painted as ' +
        'opaque black-and-white is opaque everywhere, `destination-in` keeps everything, ' +
        'and the symptom is never an error - it is a matte that masks nothing. This ' +
        'codebase has now hit that four times',
        alphaAt(a, W1, 0.8, 0.5, H1) < 12);

      Mask.mattes.delete(clip.id + '|' + mask.id);
      Mask.plate = null;
    }

    // ================================================== 9. degradation, and the model

    {
      const st = await window.api.maskState();
      ok('main answers a model state rather than throwing, whatever is or is not installed',
        !!st && typeof st.ort === 'boolean' && typeof st.ready === 'boolean');
      note('onnxruntime-node: ' + (st.ort ? 'present' : 'ABSENT (' + st.ortError + ')') +
        ';  MobileSAM: ' + (st.ready ? 'downloaded' : 'not downloaded') +
        ' -> the ' + (st.ready ? 'model' : 'built-in colour') + ' engine is cutting');

      // WITH THE MODEL PRESENT, run it for real. Skipped with a note when it is not
      // downloaded, because a suite that a 45 MB download can fail is a suite nobody runs -
      // but the day it IS there, the coordinate scaling and the tensor shapes are the two
      // things that fail silently rather than loudly, so they get a measurement.
      if (st.ready) {
        // AT THE MASK'S OWN RESOLUTION, which is 1024 on the long side, because that is
        // the scale the encoder resizes everything to anyway. The 192x108 plate the rest
        // of this file uses is far below it, and SAM on a plate it has to upscale six
        // times over answers a region a third too big - which is a fact about asking a
        // segmentation model to work at a sixth of its trained scale, not a bug in the
        // wiring, and it is why `DEFAULTS.res` is 1024.
        const BW = 1024, BH = 576, BQ = 180, BX = 160, BY = 180;
        const big = new Uint8ClampedArray(BW * BH * 4);
        for (let y = 0; y < BH; y++) {
          for (let x = 0; x < BW; x++) {
            const i = (y * BW + x) * 4;
            const tex = (x * 3 + y * 5) % 5;
            big[i] = 40 + tex; big[i + 1] = 58 + tex; big[i + 2] = 92 + tex;
            const inA = x >= BX && x < BX + BQ && y >= BY && y < BY + BQ;
            const inB = x >= BX + BQ * 3 && x < BX + BQ * 4 && y >= BY && y < BY + BQ;
            if (inA || inB) { big[i] = 208; big[i + 1] = 52; big[i + 2] = 48; }
            big[i + 3] = 255;
          }
        }
        const mid = { x: BX + BQ / 2, y: BY + BQ / 2 };
        const t0 = performance.now();
        const r = await window.api.maskSegment({
          w: BW, h: BH, rgba: big,
          points: [{ x: mid.x, y: mid.y, label: 1 }], box: null, prevLow: null,
          key: 'smoke@0',
        });
        const ms = performance.now() - t0;
        ok('MobileSAM segments the painted square through onnxruntime',
          !!r && r.ok && !!r.alpha && inside(r.alpha, BW, mid.x, mid.y),
          r && r.reason ? r.reason : Math.round(ms) + ' ms');
        if (r && r.ok && r.alpha) {
          const b = MagicMask.bbox(r.alpha, BW, BH, 128);
          ok('...and its box lands ON the square, which is what proves the prompt ' +
            'coordinates are scaled into the graph’s own 1024-long-side space - the one ' +
            'mistake here that segments confidently around the wrong pixel instead of ' +
            'failing',
            !!b && Math.abs((b.x0 + b.x1) / 2 - mid.x) <= 6 &&
            Math.abs((b.y0 + b.y1) / 2 - mid.y) <= 6,
            b ? 'centre ' + ((b.x0 + b.x1) / 2).toFixed(0) + ',' + ((b.y0 + b.y1) / 2).toFixed(0) +
              ' want ' + mid.x + ',' + mid.y : 'no matte');
          ok('...and it takes the square it was pointed at and NOT the identical one three ' +
            'squares over - the thing colour alone can never do',
            r.alpha[Math.round(mid.y) * BW + Math.round(BX + BQ * 3.5)] < 128);
          const t1 = performance.now();
          await window.api.maskSegment({
            w: BW, h: BH, rgba: big,
            points: [{ x: mid.x, y: mid.y, label: 1 }, { x: mid.x + 8, y: mid.y + 8, label: 1 }],
            key: 'smoke@0',
          });
          const again = performance.now() - t1;
          ok('...and a second prompt on the SAME frame is far cheaper, because the ' +
            'embedding is cached under the frame key and only the decoder re-runs - which ' +
            'is the whole reason the mask can preview live under the brush',
            again < ms * 0.7, Math.round(ms) + ' ms -> ' + Math.round(again) + ' ms');
        }
      } else {
        note('MobileSAM is not downloaded, so the model path is not measured here. The ' +
          'built-in colour engine is what everything above ran on, and it is what the app ' +
          'falls back to - so nothing in this suite depends on the download.');
      }

      const seg = await window.api.maskSegment({ w: 8, h: 8, rgba: new Uint8Array(8 * 8 * 4), points: [] });
      ok('a segment request with no model answers `{ok:false, reason}` rather than ' +
        'rejecting - a rejected invoke in the middle of a paint is the failure mode this ' +
        'whole design avoids',
        !!seg && (seg.ok === true || (seg.ok === false && !!seg.reason)),
        seg && seg.reason ? seg.reason : 'ok');

      ok('an engine that answers nothing leaves the loop with no matte rather than a ' +
        'broken one', await (async () => {
          MagicMask.setEngine(async () => null);
          const m = MagicMask.makeMask('Dead');
          MagicMask.addStroke(m, 0, +1, [0.3, 0.3, 0.4, 0.4], 0.02);
          const out = await MagicMask.propagate(m, MagicMask.plan(m, 0, 1, 10),
            async () => ({ w: AW, h: AH, rgba: frame(0, 0, false) }), {});
          MagicMask.setEngine(null);
          return out.length === 0;
        })());

      // The matte disk cache round-trips through its run-length encoding.
      const plane = new Uint8Array(64 * 64);
      for (let i = 0; i < plane.length; i++) plane[i] = (i % 640 < 320) ? 255 : 0;
      const wrote = await window.api.matteWrite('C:\\fake\\demo.mp4', 'smokekey', 64, 64,
        [{ t: 0.5, alpha: Array.from(plane) }]);
      note('the matte cache needs a real file to stamp, so a write against a fake path is ' +
        'expected to refuse: ' + (wrote ? 'wrote' : 'refused, as it should'));
      ok('the cache refuses to write against a path it cannot stat, rather than saving a ' +
        'line nothing could ever validate', wrote === false);
    }

    note('no fixture and no model needed: every frame here is painted by the suite and the ' +
      'segmenter is injected, which is why these claims are exact rather than approximate');

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
