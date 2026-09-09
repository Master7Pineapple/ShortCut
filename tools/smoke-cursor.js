/**
 * Screen-recording treatment: cursor smoothing, click ripples and auto-zoom.
 *
 *   SHORTCUT_SMOKE=tools/smoke-cursor.js node_modules/.bin/electron .
 *
 * NO FIXTURE AND NO RECORDING. Step 8 put every rule about telemetry behind
 * `ScreenTel`/`clip.screen`, so a synthetic sidecar built here is indistinguishable from
 * a real one - which means the maths can be checked against paths whose answer is known
 * exactly, instead of against a capture nobody can assert anything about. The one clip
 * this puts on the timeline is built by hand for the same reason: the panel, the undo
 * entry and the render job need a clip, not a decoder.
 *
 * The five things it exists to hold down:
 *
 *   1. SMOOTHING against a known path - a straight line must come back byte-exact
 *      (a filter that bends a straight line is bending everything else too), and a
 *      deliberately jittery one must come back an order of magnitude calmer.
 *   2. The SOURCE -> FRAME map, checked against `drawClipTo()` by painting a marker and
 *      finding it. If those two ever disagree the cursor is drawn on the wrong pixel,
 *      and no amount of smoothing will show it.
 *   3. RIPPLE timing against the click events - on at the click, gone at the end, and
 *      nothing at all from a sidecar whose watcher was unavailable.
 *   4. AUTO-ZOOM on a deliberately jittery input: minimum hold enforced, maximum zoom
 *      respected, the frame never panned off its own edge, and the generated keys
 *      landing the target in the middle of the frame when the transform is applied.
 *   5. That it is a GENERATOR - tagged keys, replaced not doubled on a regenerate, hand
 *      keys untouched, one undo entry, and everything plain JSON on the clip.
 *
 * Plus the contract steps 8 and 9 share: a clip with NO telemetry paints identical
 * pixels with the effects on as with them off, and offers no auto-zoom panel at all.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

    // ---------------------------------------------------------------- fixtures
    //
    // A sidecar reduced to what lands on a clip - the exact shape `ScreenTel.clipScreen()`
    // produces, so nothing here is testing a shape the app does not use.
    const tel = (events, o) => Object.assign(
      { events, displayW: 1920, displayH: 1080, clicks: true }, o || {});
    /**
     * `fn(t) -> {x, y}` sampled at `hz`, as move events.
     *
     * `rounded` writes the timestamps the way a real sidecar carries them - four decimal
     * places, from `ScreenTel`'s `r4()`. It is off by default: a sample time of 0.0167
     * where the maths wants 1/60 puts a rounding error into the fixture, and charging
     * that to the filter would mean the exactness assertions below could never be exact.
     * One assertion turns it on, precisely to measure what that rounding costs.
     */
    const path = (dur, hz, fn, rounded) => {
      const ev = [];
      for (let i = 0; i <= Math.round(dur * hz); i++) {
        const t = i / hz;
        const p = fn(t, i);
        ev.push({ t: rounded ? Math.round(t * 1e4) / 1e4 : t, x: p.x, y: p.y, type: 'move' });
      }
      return ev;
    };
    const LINE = (t) => ({ x: 0.1 + 0.2 * t, y: 0.2 + 0.1 * t });

    // ========================================================== 1. the smoothing

    {
      const straight = tel(path(3, 60, LINE));
      let worst = 0;
      for (const t of [0, 0.017, 0.4, 1.2345, 1.5, 2.5, 2.983, 3]) {
        const p = Cursor.smoothAt(straight, t, { smooth: 0.2, lag: 0 });
        const w = LINE(t);
        worst = Math.max(worst, Math.abs(p.x - w.x), Math.abs(p.y - w.y));
      }
      // The window shrinks symmetrically at the ends rather than clamping or reflecting,
      // which is the only way this holds at t=0 and t=3 as well as in the middle.
      ok('smoothing a straight path returns the straight path, ends included',
        worst < 1e-9, 'worst = ' + worst.toExponential(2));

      const jitter = tel(path(3, 60, (t, i) => {
        const w = LINE(t);
        const d = (i % 2 ? 1 : -1) * 0.02;
        return { x: w.x + d, y: w.y - d };
      }));
      let rawWorst = 0, smoothWorst = 0;
      // Measured away from the ends: the window there is genuinely shorter, so it
      // genuinely smooths less. That is the honest trade for not bending the line.
      for (let t = 0.3; t <= 2.7; t += 0.01) {
        const w = LINE(t);
        rawWorst = Math.max(rawWorst, Math.abs(Cursor.rawAt(jitter, t).x - w.x));
        smoothWorst = Math.max(smoothWorst,
          Math.abs(Cursor.smoothAt(jitter, t, { smooth: 0.2, lag: 0 }).x - w.x));
      }
      ok('a jittery path comes back at least 5x calmer',
        smoothWorst * 5 < rawWorst,
        'raw ' + rawWorst.toFixed(4) + ' -> smoothed ' + smoothWorst.toFixed(4));
      ok('...and it is still on the same path, not offset from it',
        smoothWorst < 0.004, smoothWorst.toFixed(5));

      const a = Cursor.smoothAt(straight, 1.5, { smooth: 0.2, lag: 0.1 });
      const b = Cursor.smoothAt(straight, 1.4, { smooth: 0.2, lag: 0 });
      ok('lag is a shift of the SAMPLE TIME, so it cannot depend on the frame rate',
        near(a.x, b.x, 1e-9) && near(a.y, b.y, 1e-9));

      ok('smoothing off is the recorded path', (() => {
        const p = Cursor.smoothAt(straight, 1.111, { smooth: 0, lag: 0 });
        const w = LINE(1.111);
        return near(p.x, w.x, 1e-9) && near(p.y, w.y, 1e-9);
      })());

      // And the same path with real sidecar timestamps on it. A sidecar rounds `t` to
      // four decimals, so no resampling grid can land exactly on a sample and the
      // rounding travels through the interpolation. It is worth about half a
      // millionth of a frame width, which is the number to know rather than to fear.
      ok('a sidecar-rounded path costs under 1e-5 of the frame, and no more', (() => {
        const rounded = tel(path(3, 60, LINE, true));
        let w = 0;
        for (let t = 0; t <= 3; t += 0.05) {
          w = Math.max(w, Math.abs(Cursor.smoothAt(rounded, t, { smooth: 0.2, lag: 0 }).x - LINE(t).x));
        }
        return w < 1e-5;
      })());

      // The degradation contract, at the very first door it comes to.
      ok('no telemetry answers null rather than throwing',
        Cursor.smoothAt(null, 1) === null && Cursor.rawAt({ events: [] }, 1) === null &&
        Cursor.clicksOf(null).length === 0 && Cursor.ripplesAt(null, 1).length === 0);
      ok('a sidecar of nothing but clicks is still a path',
        !!Cursor.smoothAt(tel([{ t: 1, x: 0.4, y: 0.6, type: 'down' }]), 1));
    }

    // ================================================ 2. source -> frame, checked

    {
      const sw = 1920, sh = 1080;
      const src = document.createElement('canvas');
      src.width = sw; src.height = sh;
      const sc = src.getContext('2d');
      sc.fillStyle = '#000'; sc.fillRect(0, 0, sw, sh);
      const MX = 0.3, MY = 0.62;
      sc.fillStyle = '#fff';
      sc.fillRect(MX * sw - 8, MY * sh - 8, 16, 16);

      const clip = { kind: 'video', srcW: sw, srcH: sh, panX: 0.35, panY: 0.5, zoom: 1.2, in: 0, out: 2 };
      const ow = state.out.w, oh = state.out.h;
      state.out.w = 1080; state.out.h = 1920;
      const W = 270, H = 480;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
      drawClipTo(clip, src, c, W, H);
      // Where the framing actually put the marker, found in the pixels.
      const d = c.getImageData(0, 0, W, H).data;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (d[(y * W + x) * 4] > 200) { sx += x; sy += y; n++; }
        }
      }
      const map = Cursor.mapper(clip, W, H);
      const want = map(MX, MY);
      ok('the marker survives the framing at all', n > 4, n + ' px');
      ok('the cursor map lands on the pixel drawClipTo() put the point on',
        n > 4 && near(sx / n, want.x, 1.5) && near(sy / n, want.y, 1.5),
        'painted ' + (sx / n).toFixed(1) + ',' + (sy / n).toFixed(1) +
        '  mapped ' + want.x.toFixed(1) + ',' + want.y.toFixed(1));

      const mid = Cursor.mapper({ srcW: 1920, srcH: 1080, panX: 0.5, panY: 0.5, zoom: 1 }, W, H);
      const q = mid(0.5, 0.5);
      ok('a centred, unzoomed clip puts the middle of the source in the middle',
        near(q.x, W / 2, 1e-6) && near(q.y, H / 2, 1e-6));
      ok('the map is resolution-independent, which is what preview/render parity means',
        (() => {
          const small = Cursor.mapper(clip, W, H)(MX, MY);
          const big = Cursor.mapper(clip, W * 4, H * 4)(MX, MY);
          return near(big.x / 4, small.x, 1e-9) && near(big.y / 4, small.y, 1e-9);
        })());
      state.out.w = ow; state.out.h = oh;
    }

    // ==================================================== 3. clicks and ripples

    {
      const ev = path(3, 60, LINE);
      ev.push({ t: 1, x: 0.4, y: 0.5, type: 'down' }, { t: 1.05, x: 0.4, y: 0.5, type: 'up' });
      ev.push({ t: 2, x: 0.7, y: 0.3, type: 'down' }, { t: 2.05, x: 0.7, y: 0.3, type: 'up' });
      ev.sort((a, b) => a.t - b.t);
      const scr = tel(ev);

      ok('only mouse-downs make a ripple', Cursor.clicksOf(scr).length === 2);
      ok('nothing before the click', Cursor.ripplesAt(scr, 0.99, { dur: 0.55 }).length === 0);
      ok('the ring starts AT the click, at zero', (() => {
        const r = Cursor.ripplesAt(scr, 1, { dur: 0.55 });
        return r.length === 1 && r[0].k === 0 && r[0].x === 0.4;
      })());
      ok('half way through is half way through',
        near(Cursor.ripplesAt(scr, 1.275, { dur: 0.55 })[0].k, 0.5, 1e-9));
      ok('the ring is gone when its length is up',
        Cursor.ripplesAt(scr, 1.55, { dur: 0.55 }).length === 0);
      ok('length is a parameter, not a constant',
        Cursor.ripplesAt(scr, 1.55, { dur: 1.2 }).length === 1);
      ok('two rings can be alive at once',
        Cursor.ripplesAt(scr, 2.2, { dur: 1.5 }).length === 2);
      // A `move` sample carries a position; a `down` carries a position AND an event. The
      // path must not kink toward a click that happens to sit off the interpolated line.
      ok('a click does not drag the smoothed path toward itself', (() => {
        const p = Cursor.smoothAt(scr, 1, { smooth: 0, lag: 0 });
        const w = LINE(1);
        return near(p.x, w.x, 1e-9);
      })());

      ok('the pointer is unpunched away from a click',
        Cursor.punchAt(scr, 0.5, { punch: 1.5, punchDur: 0.2 }) === 1);
      ok('the punch peaks a quarter of the way in, at exactly the value asked for',
        near(Cursor.punchAt(scr, 1.05, { punch: 1.5, punchDur: 0.2 }), 1.5, 1e-9));
      ok('and it has decayed back by the end',
        near(Cursor.punchAt(scr, 1.199, { punch: 1.5, punchDur: 0.2 }), 1, 0.01));

      // `clicks:false` means the watcher was unavailable, so there ARE no mouse-downs.
      const noClicks = tel(path(2, 60, LINE), { clicks: false });
      ok('a sidecar written without a click watcher simply has no ripples',
        Cursor.ripplesAt(noClicks, 1).length === 0 &&
        Cursor.punchAt(noClicks, 1, { punch: 2 }) === 1);
    }

    // ===================================================== 4. the auto-zoom itself

    const OPT = { sensitivity: 0.5, minHold: 1.2, maxZoom: 2, ramp: 0.4, curve: 'easeInOut', aspect: 9 / 16 };
    const flat = { srcW: 1080, srcH: 1920, panX: 0.5, panY: 0.5, zoom: 1, in: 0, out: 12 };

    {
      // Deliberately hostile, in three acts: four seconds of the pointer flicking
      // between two nearby targets twice a second - the exact input that makes a
      // smoothed-afterwards zoom wobble forever - then a long, still dwell, and finally
      // four seconds of fast wide sweeping that must earn nothing at all.
      //
      // The sweep is a SINE and not a slow pan, and that is not an accident: a pan slow
      // enough to stay inside the segmenter's box for longer than the minimum hold is a
      // legitimate dwell that happens to be drifting, and the generator is right to zoom
      // on it. What must not earn a zoom is motion that never settles anywhere.
      const ev = path(12, 60, (t) => {
        if (t < 4) return (Math.floor(t * 2) % 2) ? { x: 0.42, y: 0.5 } : { x: 0.5, y: 0.52 };
        if (t < 8) return { x: 0.75, y: 0.25 };
        return { x: 0.5 + 0.42 * Math.sin((t - 8) * 5), y: 0.5 + 0.42 * Math.cos((t - 8) * 5) };
      });
      const scr = tel(ev);
      const res = Cursor.autoZoom(scr, flat, OPT);

      ok('a jittery stretch becomes ONE zoom, not a burst of them',
        res.segments.filter((s) => s.t0 < 4).length === 1,
        res.segments.map((s) => s.t0.toFixed(1) + '-' + s.t1.toFixed(1)).join(' '));
      ok('every segment is at least the minimum hold - enforced in the generator',
        res.segments.every((s) => s.t1 - s.t0 >= OPT.minHold - 1e-9),
        res.segments.map((s) => (s.t1 - s.t0).toFixed(2)).join(', '));
      ok('nothing exceeds the maximum zoom',
        res.segments.every((s) => s.scale <= OPT.maxZoom + 1e-9) &&
        res.segments.every((s) => s.scale >= 1),
        res.segments.map((s) => s.scale.toFixed(2)).join(', '));
      ok('and nothing zooms out, which is never what was asked for',
        res.keys.scale.every((k) => k.v >= 1 - 1e-9));
      ok('the still dwell is found', res.segments.some((s) => s.t0 >= 3.5 && s.t1 <= 8.5));
      ok('fast sweeping that never settles earns nothing',
        !res.segments.some((s) => s.t1 > 8.5),
        res.segments.map((s) => s.t0.toFixed(1) + '-' + s.t1.toFixed(1)).join(' '));

      // The centre is clamped so the zoomed window stays inside the frame - otherwise the
      // black beyond the edge would be baked into the export, because the baker and the
      // viewer run the same code.
      ok('the zoomed window never leaves the frame',
        res.segments.every((s) => {
          const half = 0.5 / s.scale;
          return s.x >= half - 1e-9 && s.x <= 1 - half + 1e-9 &&
            s.y >= half - 1e-9 && s.y <= 1 - half + 1e-9;
        }));

      const K = res.keys;
      ok('three tracks come out, all the same length',
        K.x.length === K.y.length && K.y.length === K.scale.length && K.x.length >= 4,
        K.x.length + ' keys each');
      ok('every generated key is TAGGED, which is what makes a regenerate safe',
        [].concat(K.x, K.y, K.scale).every((k) => k.gen === 'autozoom'));
      ok('keys are sorted, and inside the clip',
        K.scale.every((k, i) => (i === 0 || k.t > K.scale[i - 1].t) && k.t >= 0 && k.t <= flat.out - flat.in));
      // A segment clear of the clip's start, so the round trip below reads a HOLD rather
      // than a value part way up a ramp.
      const inner = res.segments.find((s) => s.t0 - flat.in > OPT.ramp) || res.segments[0];
      ok('the keys are plain JSON - undo is JSON.stringify of the track list',
        JSON.stringify(K) === JSON.stringify(JSON.parse(JSON.stringify(K))) &&
        [].concat(K.x, K.y, K.scale).every((k) =>
          typeof k.t === 'number' && typeof k.v === 'number' && typeof k.ease === 'object'));

      // THE ROUND TRIP. Evaluate the generated tracks the way fx.js's transform does and
      // check the dwell lands in the middle of the frame. This is the assertion that
      // would catch an anchor/offset sign error, which nothing above would.
      {
        const seg = inner || res.segments[0];
        const holder = { keys: { x: K.x, y: K.y, scale: K.scale } };
        const tm = (seg.t0 + seg.t1) / 2 - flat.in;
        const s = Anim.valueAt(holder, 'scale', tm, 1);
        const ox = Anim.valueAt(holder, 'x', tm, 0);
        const oy = Anim.valueAt(holder, 'y', tm, 0);
        // fx.js: screen = anchor + (p - anchor) * s + offset, anchor left at 0.5.
        const px = 0.5 + (seg.x - 0.5) * s + ox;
        const py = 0.5 + (seg.y - 0.5) * s + oy;
        ok('THE HEADLINE: applying the generated transform puts the dwell in the middle',
          near(px, 0.5, 1e-4) && near(py, 0.5, 1e-4),
          px.toFixed(5) + ', ' + py.toFixed(5));
      }

      // Two dwells far apart, with a gap wide enough to pull out and back in.
      const two = tel(path(12, 60, (t) => (t < 5 ? { x: 0.25, y: 0.25 }
        : t < 6.5 ? { x: 0.5 + (t - 5) * 0.2, y: 0.5 } : { x: 0.8, y: 0.8 })));
      const r2 = Cursor.autoZoom(two, flat, OPT);
      ok('two separated dwells give two zooms with a neutral between them',
        r2.segments.length === 2 && r2.keys.scale.some((k) => k.v === 1 && k.t > 5 && k.t < 6.5),
        r2.segments.length + ' segments');
      // Four keys per hold - out, in, hold, out - once there is room for them all. The
      // first dwell starts at the clip's own start, so it is the SECOND that has a full
      // bracket; joined dwells drop the two keys between them, which is the assertion
      // after this one.
      ok('a hold with room around it is bracketed by a neutral ramp on each side', (() => {
        const seg = r2.segments[1];
        const at = (t) => r2.keys.scale.find((k) => near(k.t, t, 1e-3));
        const t0 = seg.t0 - flat.in, t1 = seg.t1 - flat.in;
        return !!at(t0) && at(t0).v > 1 && !!at(t0 - OPT.ramp) && at(t0 - OPT.ramp).v === 1 &&
          !!at(t1) && at(t1).v > 1;
      })(), r2.keys.scale.map((k) => k.t.toFixed(2) + ':' + k.v.toFixed(2)).join(' '));

      // And the same two with no room between them: no pointless pull-out.
      const tight = tel(path(12, 60, (t) => (t < 6 ? { x: 0.25, y: 0.25 } : { x: 0.8, y: 0.8 })));
      const r3 = Cursor.autoZoom(tight, flat, Object.assign({}, OPT, { ramp: 1.5 }));
      ok('back-to-back dwells cut straight across instead of pulling out and diving back',
        r3.segments.length === 2 &&
        !r3.keys.scale.some((k) => k.v === 1 && k.t > 5.5 && k.t < 7.5),
        r3.keys.scale.map((k) => k.t.toFixed(1) + ':' + k.v.toFixed(2)).join(' '));
    }

    {
      // Hold time is the control that matters most, so it gets its own case.
      // Everything outside the half-second dwell moves too fast to settle, so the dwell
      // is the only thing on offer - which is what makes this a test of the hold time
      // rather than of the background.
      const brief = tel(path(6, 60, (t) => (t > 2 && t < 2.5 ? { x: 0.8, y: 0.8 }
        : { x: 0.5 + 0.42 * Math.sin(t * 6), y: 0.5 + 0.42 * Math.cos(t * 6) })));
      ok('a dwell shorter than the minimum hold produces no zoom at all',
        Cursor.autoZoom(brief, { in: 0, out: 6 }, Object.assign({}, OPT, { minHold: 1.2 })).segments.length === 0);
      ok('...and lowering the minimum hold finds it',
        Cursor.autoZoom(brief, { in: 0, out: 6 }, Object.assign({}, OPT, { minHold: 0.3 })).segments.length >= 1);

      const pin = tel(path(6, 60, () => ({ x: 0.5, y: 0.5 })));
      const capped = Cursor.autoZoom(pin, { in: 0, out: 6 }, Object.assign({}, OPT, { maxZoom: 1.5 }));
      ok('a pinpoint dwell is capped by max zoom rather than going to infinity',
        capped.segments.length === 1 && near(capped.segments[0].scale, 1.5, 1e-9),
        capped.segments[0] && capped.segments[0].scale.toFixed(3));

      // Source time, not clip time: a trimmed clip must analyse its own piece.
      const half = Cursor.autoZoom(
        tel(path(12, 60, (t) => (t < 6 ? { x: 0.2, y: 0.2 } : { x: 0.8, y: 0.8 }))),
        { in: 6, out: 12 }, OPT);
      ok('a trimmed clip analyses only what it shows, and keys in CLIP-LOCAL time',
        half.segments.length === 1 && half.keys.scale.every((k) => k.t >= 0 && k.t <= 6),
        half.keys.scale.map((k) => k.t.toFixed(2)).join(','));

      // The collision rule at the clip's edge: a dwell already under way when the clip
      // starts opens ALREADY ZOOMED. Keeping the neutral key instead would turn the dwell
      // into a slow creeping push across its whole length.
      const straddle = Cursor.autoZoom(
        tel(path(12, 60, () => ({ x: 0.7, y: 0.3 }))), { in: 4, out: 10 }, OPT);
      ok('a clip trimmed into the middle of a dwell opens already zoomed in',
        straddle.segments.length === 1 && straddle.keys.scale[0].t === 0 &&
        straddle.keys.scale[0].v > 1,
        straddle.keys.scale.map((k) => k.t.toFixed(2) + ':' + k.v.toFixed(2)).join(' '));

      ok('no telemetry generates nothing, rather than failing',
        Cursor.autoZoom(null, flat, OPT).segments.length === 0 &&
        Cursor.autoZoom({ events: [] }, flat, OPT).keys.scale.length === 0);
    }

    // ==================================== 4b. cutting a take up across the clips

    {
      // A take is performed against the TIMELINE and can cross several clips, so it is
      // split on import and each clip gets the piece that happened over it, in its own
      // SOURCE time - the only axis that survives trimming and dragging afterwards.
      const ev = [];
      for (let i = 0; i <= 100; i++) ev.push({ t: i / 10, x: i / 100, y: 0.5, type: 'move' });
      ev.push({ t: 3, x: 0.3, y: 0.5, type: 'down' }, { t: 7, x: 0.7, y: 0.5, type: 'down' });
      ev.sort((a, b) => a.t - b.t);
      const clips = [
        { id: 'A', start: 0, in: 2, out: 7 },      // timeline 0..5, source 2..7
        { id: 'B', start: 5, in: 0, out: 5 },      // timeline 5..10, source 0..5
        { id: 'C', start: 40, in: 0, out: 5 },     // nowhere near the take
      ];
      const takes = Cursor.splitTake(ev, clips);
      ok('a clip the take never crossed gets nothing at all, not an empty take',
        !takes.has('C') && takes.size === 2);
      ok('each clip keeps only what happened over it',
        takes.get('A').events.every((e) => e.t >= 2 && e.t <= 7) &&
        takes.get('B').events.every((e) => e.t >= 0 && e.t <= 5));
      ok('timeline time became SOURCE time through the clip\'s in point', (() => {
        // The click at timeline t=3 is 3 s into clip A, which starts 2 s into its source.
        const hit = takes.get('A').events.find((e) => e.type === 'down');
        return hit && near(hit.t, 5, 1e-6);
      })());
      ok('the boundary is half-open, so a sample on the cut belongs to ONE clip', (() => {
        const atCut = ev.filter((e) => Math.abs(e.t - 5) < 1e-9).length;
        const inA = takes.get('A').events.filter((e) => near(e.t, 7, 1e-9)).length;
        const inB = takes.get('B').events.filter((e) => near(e.t, 0, 1e-9)).length;
        return atCut > 0 && inA + inB === atCut;
      })());
      ok('a take is frame space, and says so',
        takes.get('A').space === 'frame' && Cursor.has(takes.get('A')));
      ok('a take is plain JSON', (() => {
        const t = takes.get('A');
        return JSON.stringify(t) === JSON.stringify(JSON.parse(JSON.stringify(t)));
      })());

      // A drag, whichever way it was dragged, is the same rectangle.
      const r1 = Cursor.normRect(0.8, 0.7, 0.2, 0.1);
      const r2 = Cursor.normRect(0.2, 0.1, 0.8, 0.7);
      ok('a selection drag normalises whichever corner it started from',
        JSON.stringify(r1) === JSON.stringify(r2) && near(r1.w, 0.6, 1e-9));
      ok('a selection with no drag recorded is a static box, as it used to be', (() => {
        const built = Cursor.selectionKeys(
          Object.assign({ t0: 4, t1: 6 }, r1), { start: 2, in: 0 }, 'onrender');
        return built.t0 === 2 && built.t1 === 4 &&
          ['x', 'y', 'w', 'h'].every((k) => built.keys[k].length === 2 &&
            built.keys[k].every((q) => q.gen === 'onrender'));
      })());

      // THE RUBBER BAND. One corner pinned at the press, the other following the pointer,
      // replayed as keys - so the box grows the way it was dragged instead of appearing
      // whole at its final size.
      {
        // Pinned at (0.2, 0.2); the free corner walks to (0.8, 0.6) over two seconds,
        // sampled at 60 Hz because that is the rate pointer events actually arrive at -
        // a sparser fixture would be testing the decimation against nothing.
        const samples = [];
        for (let i = 0; i <= 120; i++) {
          const k = i / 120;
          samples.push({ t: 4 + k * 2, x: 0.2 + k * 0.6, y: 0.2 + k * 0.4 });
        }
        const sel = Object.assign(
          { t0: 4, t1: 6, x0: 0.2, y0: 0.2, samples },
          Cursor.normRect(0.2, 0.2, 0.8, 0.6));
        const built = Cursor.selectionKeys(sel, { start: 2, in: 0 }, 'onrender');

        ok('the drag is replayed as many keys, not two',
          built.keys.w.length > 5, built.keys.w.length + ' keys');
        ok('...but decimated, so the strip stays editable',
          built.keys.w.length <= samples.length / 2,
          built.keys.w.length + ' keys from ' + samples.length + ' samples');
        ok('the band starts at zero size, because the corners start together',
          near(built.keys.w[0].v, 0, 1e-6) && near(built.keys.h[0].v, 0, 1e-6));
        ok('...and ends at the size it was released at',
          near(built.keys.w[built.keys.w.length - 1].v, 0.6, 1e-4) &&
          near(built.keys.h[built.keys.h.length - 1].v, 0.4, 1e-4));

        // The interesting one: half way through the drag the box is half the size. A
        // static two-key version would report the FINAL size here, which is the bug.
        const holder = { keys: built.keys };
        const mid = (built.t0 + built.t1) / 2;
        ok('THE POINT: half way through the drag the box is half drawn',
          near(Anim.valueAt(holder, 'w', mid, 0), 0.3, 0.02) &&
          near(Anim.valueAt(holder, 'h', mid, 0), 0.2, 0.02),
          Anim.valueAt(holder, 'w', mid, 0).toFixed(3) + ' x ' +
          Anim.valueAt(holder, 'h', mid, 0).toFixed(3));
        ok('the easing between drag samples is LINEAR - it is a replay, not an animation',
          built.keys.w.every((k) => k.ease && k.ease.kind === 'named' && k.ease.name === 'linear'),
          JSON.stringify(built.keys.w[1].ease));
        ok('and the track holds after release rather than needing a trailing key',
          near(Anim.valueAt(holder, 'w', built.t1 + 5, 0), 0.6, 1e-4));

        // Dragging up-and-left from the anchor: the rect flips sides, and x/y have to
        // move for it rather than the width going negative.
        const back = [];
        for (let i = 0; i <= 20; i++) {
          const k = i / 20;
          back.push({ t: k, x: 0.5 - k * 0.4, y: 0.5 - k * 0.3 });
        }
        const flipped = Cursor.selectionKeys(
          { t0: 0, t1: 1, x0: 0.5, y0: 0.5, samples: back, x: 0.1, y: 0.2, w: 0.4, h: 0.3 },
          { start: 0, in: 0 }, 'onrender');
        ok('dragging back past the anchor moves the corner, never a negative width',
          flipped.keys.w.every((k) => k.v >= 0) &&
          near(flipped.keys.x[flipped.keys.x.length - 1].v, 0.1, 1e-4));
      }
    }

    // ============================================ 5. generator, not a black box

    {
      const e = { id: 'x', type: 'transform', params: {}, keys: {} };
      const gen1 = { scale: [{ t: 1, v: 2, gen: 'autozoom' }, { t: 2, v: 1, gen: 'autozoom' }] };
      Cursor.applyGenerated(e, gen1);
      ok('a generation lands on the effect', e.keys.scale.length === 2);

      // A key the author added by hand. This is the one that must survive.
      Anim.addKey(e.keys.scale, 5, 1.5);
      Cursor.applyGenerated(e, { scale: [{ t: 1.5, v: 3, gen: 'autozoom' }] });
      ok('regenerating REPLACES its own keys rather than doubling them',
        e.keys.scale.filter((k) => k.gen === 'autozoom').length === 1);
      ok('...and leaves a hand-added key exactly where it was',
        e.keys.scale.some((k) => !k.gen && k.t === 5 && k.v === 1.5),
        JSON.stringify(e.keys.scale));
      ok('the merged track comes back sorted',
        e.keys.scale.every((k, i) => i === 0 || k.t >= e.keys.scale[i - 1].t));

      Cursor.clearGenerated(e);
      ok('clearing takes the generation and nothing else',
        e.keys.scale.length === 1 && e.keys.scale[0].t === 5);
      ok('counting reports what the generator owns',
        Cursor.countGenerated(e) === 0 &&
        Cursor.countGenerated({ keys: gen1 }) === 2);

      const bare = { keys: {} };
      Cursor.applyGenerated(bare, { scale: [] });
      ok('a generation of nothing prunes `keys` away entirely, like every other track',
        !bare.keys);
    }

    // ============================================== 6. the effects, and the panel

    {
      const pool = new Map();
      const surface = (name, w, h) => {
        let cv = pool.get(name);
        if (!cv) { cv = document.createElement('canvas'); pool.set(name, cv); }
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        return cv;
      };
      const paint = (c, W, H) => { c.fillStyle = '#204080'; c.fillRect(0, 0, W, H); };
      const shoot = (clip, t, W, H) => {
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const c = cv.getContext('2d');
        FX.render(c, W, H, clip, t, surface, paint);
        return c.getImageData(0, 0, W, H);
      };
      /** The centre of mass of everything that is not the flat background. */
      const mark = (img, W, H) => {
        const d = img.data;
        let sx = 0, sy = 0, n = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (Math.abs(d[i] - 0x20) + Math.abs(d[i + 1] - 0x40) + Math.abs(d[i + 2] - 0x80) > 40) {
              sx += x; sy += y; n++;
            }
          }
        }
        return { x: sx / (n || 1), y: sy / (n || 1), n };
      };

      // The two pointer effects read `clip.mouse` - a PERFORMED take in FRAME space -
      // and no longer `clip.screen`. A screen capture already has a real cursor in its
      // pixels, so drawing a second one over it was two pointers chasing each other.
      const take = Cursor.makeTake(path(4, 60, () => ({ x: 0.5, y: 0.5 })).concat(
        [{ t: 2, x: 0.5, y: 0.5, type: 'down' }]));
      const base = { kind: 'video', srcW: 1080, srcH: 1920, panX: 0.5, panY: 0.5, zoom: 1, in: 0, out: 4 };

      const withTake = Object.assign({}, base, { mouse: take, fx: [FX.create('cursor')] });
      const drawn = mark(shoot(withTake, 1, 200, 356), 200, 356);
      ok('the pointer is drawn where the take says it is',
        drawn.n > 20 && near(drawn.x, 100, 25) && near(drawn.y, 178, 25),
        drawn.n + ' px at ' + drawn.x.toFixed(0) + ',' + drawn.y.toFixed(0));

      // FRAME space, not source space: a take is performed against the finished 9:16
      // picture, so reframing the clip underneath must NOT move the pointer. Telemetry
      // is the opposite, and `Cursor.mapperFor()` is what keeps the two apart.
      const reframed = Object.assign({}, withTake, { panX: 0.05, zoom: 2.5 });
      const moved = mark(shoot(reframed, 1, 200, 356), 200, 356);
      ok('a performed pointer does NOT move when the clip is reframed',
        near(moved.x, drawn.x, 1) && near(moved.y, drawn.y, 1),
        moved.x.toFixed(1) + ',' + moved.y.toFixed(1) + ' vs ' + drawn.x.toFixed(1) + ',' + drawn.y.toFixed(1));
      ok('...while screen telemetry still goes through the framing, as auto-zoom needs',
        Math.abs(Cursor.mapperFor(reframed, { space: 'source' }, 200, 356)(0.5, 0.5).x -
          Cursor.mapperFor(withTake, { space: 'source' }, 200, 356)(0.5, 0.5).x) > 1);

      // THE UNIT RULE. Every length in fx.js is a fraction of the frame, so the same
      // stack at two resolutions is the same picture scaled - which is what preview and
      // render agreeing means for this file.
      {
        const small = mark(shoot(withTake, 1, 200, 356), 200, 356);
        const big = mark(shoot(withTake, 1, 800, 1424), 800, 1424);
        // Position is the assertion; the area is a sanity check with a loose tolerance
        // on purpose. The count is of pixels that differ from the background by more than
        // a threshold, and a 9-pixel-wide pointer is far more antialiased edge, in
        // proportion, than a 36-pixel one - so the two counts cannot agree closely and it
        // would be dishonest to pretend a tight bound here meant anything.
        ok('the pointer paints the same picture at 1x and 4x',
          near(big.x / 4, small.x, 2) && near(big.y / 4, small.y, 2) &&
          Math.abs(big.n / 16 - small.n) / small.n < 0.3,
          'x ' + (big.x / 4).toFixed(1) + ' vs ' + small.x.toFixed(1) +
          '  px ' + (big.n / 16).toFixed(0) + ' vs ' + small.n);
      }

      const ring = Object.assign({}, base, { mouse: take, fx: [FX.create('ripple')] });
      ok('a ripple appears at the click and is gone before the next second',
        mark(shoot(ring, 2.1, 200, 356), 200, 356).n > 10 &&
        mark(shoot(ring, 1.5, 200, 356), 200, 356).n === 0);
      // The ring's RADIUS is what has to grow. Its brightness falls faster than the
      // radius rises - that is the whole look - so "is anything still drawn" is the wrong
      // question to ask late in the life of one.
      ok('the ring grows outward from the click', (() => {
        const radius = (t) => {
          const W = 200, H = 356;
          const img = shoot(ring, t, W, H);
          const d = img.data;
          const cx = W / 2, cy = H / 2;
          let far = 0, n = 0;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const i = (y * W + x) * 4;
              if (Math.abs(d[i] - 0x20) + Math.abs(d[i + 1] - 0x40) + Math.abs(d[i + 2] - 0x80) > 40) {
                far = Math.max(far, Math.hypot(x - cx, y - cy)); n++;
              }
            }
          }
          return { far, n };
        };
        const early = radius(2.05), late = radius(2.2);
        return early.n > 0 && late.n > 0 && late.far > early.far * 1.5;
      })());

      // THE CONTRACT. No take, no drawing - and identical pixels to no stack at all.
      const none = Object.assign({}, base, { fx: [FX.create('cursor'), FX.create('ripple')] });
      const a = shoot(none, 2, 120, 213).data;
      const b = shoot(Object.assign({}, base), 2, 120, 213).data;
      let same = true;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
      ok('a clip with NO take paints pixel-identically with the effects on', same);

      // ---- the window selection ------------------------------------------
      //
      // Authorable by hand as well as recordable, so unlike the pointer it carries no
      // `needs` - a clip that was never performed over can still be annotated.
      ok('the selection effect needs nothing recorded', !FX.DEFS.select.needs);
      const selOf = (params, t) => {
        const c = Object.assign({}, base, { fx: [FX.create('select')] });
        Object.assign(c.fx[0].params, { showFrom: 0, showTo: 4, fadeIn: 0.2, fadeOut: 0.2 }, params);
        return mark(shoot(c, t, 200, 356), 200, 356);
      };
      ok('a selection draws inside its own window and not outside it',
        selOf({}, 1).n > 0 && selOf({}, 5).n === 0,
        selOf({}, 1).n + ' px on, ' + selOf({}, 5).n + ' px off');
      ok('it fades in rather than appearing',
        selOf({}, 0.02).n < selOf({}, 1).n);
      ok('every outline style paints something, and they differ from each other', (() => {
        const b = selOf({ style: 'brackets' }, 1).n;
        const d = selOf({ style: 'dashed' }, 1).n;
        const o = selOf({ style: 'solid' }, 1).n;
        return b > 0 && d > 0 && o > 0 && b !== d && d !== o;
      })());
      ok('"no outline" really draws no outline, so dim can be used alone',
        selOf({ style: 'none' }, 1).n === 0);
      ok('dim darkens OUTSIDE the box and leaves the inside alone', (() => {
        const c = Object.assign({}, base, { fx: [FX.create('select')] });
        Object.assign(c.fx[0].params,
          { showFrom: 0, showTo: 4, fadeIn: 0.01, fadeOut: 0.01, style: 'none', dim: 0.8,
            x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
        const img = shoot(c, 1, 200, 356);
        const at = (fx2, fy) => {
          const i = ((Math.round(fy * 356) * 200) + Math.round(fx2 * 200)) * 4;
          return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
        };
        const inside = at(0.5, 0.5), outside = at(0.05, 0.05);
        // The inside is the untouched plate; the outside is darker but still OPAQUE -
        // an even-odd fill, not a hole punched through the clip's own layer.
        return inside[0] === 0x20 && inside[2] === 0x80 &&
          outside[2] < 0x80 && outside[3] === 255;
      })());
      ok('the marching dashes are a function of t, so two runs agree',
        selOf({ style: 'dashed' }, 1.234).n === selOf({ style: 'dashed' }, 1.234).n);

      // ---- an imported PNG pointer ---------------------------------------
      ok('an undecodable PNG path falls back to the arrow rather than drawing nothing',
        (() => {
          const c = Object.assign({}, base, { mouse: take, fx: [FX.create('cursor')] });
          c.fx[0].params.image = 'C:\\nope\\missing.png';
          return mark(shoot(c, 1, 200, 356), 200, 356).n > 20;
        })());
      ok('preloading a stack with no images resolves rather than hanging',
        FX.preloadImages([base]) instanceof Promise);
      await FX.preloadImages([Object.assign({}, base, { fx: [FX.create('cursor')] })]);

      ok('both new types normalise and round-trip like every other effect', (() => {
        const c = { kind: 'video', fx: [{ type: 'cursor', params: { size: 'x' } }, { type: 'ripple' }] };
        FX.normalizeClip(c);
        return c.fx.length === 2 && c.fx[0].params.size === FX.DEFS.cursor.params.size &&
          JSON.stringify(c) === JSON.stringify(JSON.parse(JSON.stringify(c)));
      })());
      ok('a nonsense type is still dropped', (() => {
        const c = { fx: [{ type: 'cursor' }, { type: 'nope' }] };
        FX.normalizeClip(c);
        return c.fx.length === 1;
      })());
    }

    // ====================================== 7. on the timeline: panel, undo, job

    {
      const vt = state.tracks.find((t) => t.type === 'video');
      const ev = path(10, 60, (t) => (t < 5 ? { x: 0.3, y: 0.3 } : { x: 0.75, y: 0.7 }));
      ev.push({ t: 3, x: 0.3, y: 0.3, type: 'down' });
      ev.sort((a, b) => a.t - b.t);
      const id = nextId();
      vt.clips.push({
        id, src: 'C:\\fake\\rec.mp4', name: 'rec', kind: 'video',
        start: 0, in: 0, out: 10, mediaDuration: 10,
        srcW: 1920, srcH: 1080, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
        // BOTH, because they now do different jobs: telemetry feeds auto-zoom, and a
        // performed take feeds the pointer. A real clip often carries only one.
        screen: tel(ev),
        mouse: Cursor.makeTake(ev),
      });
      sortTracks();
      const live = () => allClips().map((x) => x.clip).find((c) => c.id === id);
      setSelection([id], false);
      renderInspector();

      ok('a clip with telemetry gets the auto-zoom panel',
        !!document.querySelector('#inspector .fx-az'));
      ok('the generator is NOT another effect in the stack menu',
        [...document.querySelectorAll('#inspector .fx-box .fx-add select option')]
          .every((o) => o.value !== 'autozoom'));
      ok('the pointer effects are offered on a clip that HAS a take',
        [...document.querySelectorAll('#inspector .fx-box .fx-add select option')]
          .filter((o) => o.value === 'cursor' || o.value === 'ripple')
          .every((o) => !o.disabled));
      ok('the panel says how many zooms the current settings would place, before ' +
        'anything is committed',
        /\d+ zooms?|No dwell/.test(
          [...document.querySelectorAll('#inspector .fx-az div')].map((d) => d.textContent).join(' ')));

      const undo0 = undoStack.length;
      const genBtn = [...document.querySelectorAll('#inspector .fx-az button')]
        .find((b) => /Generate/.test(b.textContent));
      genBtn.click();
      const c1 = live();
      ok('generating is ONE undo entry',
        undoStack.length === undo0 + 1, undo0 + ' -> ' + undoStack.length);
      ok('it wrote onto an ordinary transform effect, tagged as its own',
        !!c1.fx && c1.fx.length === 1 && c1.fx[0].type === 'transform' && c1.fx[0].gen === 'autozoom');
      ok('the keys are ordinary Anim keys the strip can edit',
        !!c1.fx[0].keys && c1.fx[0].keys.scale.length >= 4 &&
        c1.fx[0].keys.scale.every((k) => typeof k.t === 'number' && k.ease));
      ok('the settings travel with the clip, for the regenerate two days later',
        !!c1.fx[0].autozoom && typeof c1.fx[0].autozoom.minHold === 'number');
      ok('nothing non-serialisable landed on the clip',
        JSON.stringify(c1) === JSON.stringify(JSON.parse(JSON.stringify(c1))));

      const before = JSON.stringify(c1.fx);
      const nKeys = c1.fx[0].keys.scale.length;
      renderInspector();
      [...document.querySelectorAll('#inspector .fx-az button')]
        .find((b) => /Regenerate/.test(b.textContent)).click();
      ok('regenerating replaces rather than doubles',
        live().fx[0].keys.scale.length === nKeys, nKeys + ' -> ' + live().fx[0].keys.scale.length);
      ok('...and to the same answer, because it is a function of the same data',
        JSON.stringify(live().fx.map((f) => f.keys)) ===
        JSON.stringify(JSON.parse(before).map((f) => f.keys)));

      // A hand key, then a regenerate. The whole design point, on the real clip.
      Anim.addKey(Anim.trackFor(live().fx[0], 'rotate', true), 1, 10);
      renderInspector();
      [...document.querySelectorAll('#inspector .fx-az button')]
        .find((b) => /Regenerate/.test(b.textContent)).click();
      ok('a hand-added key survives a regenerate untouched',
        !!live().fx[0].keys.rotate && live().fx[0].keys.rotate[0].v === 10);

      // Clearing takes the generation; the effect goes with it only if nothing is left.
      renderInspector();
      [...document.querySelectorAll('#inspector .fx-az button')]
        .find((b) => /Clear/.test(b.textContent)).click();
      // `keyStrip()` calls `Anim.trackFor(fx, prop, true)` as it builds, so an open
      // panel leaves an EMPTY array on every keyable parameter; `FX.normalizeClip()`
      // prunes them again on the next structural edit and on load. So "has no keys" is
      // "has no key", not "has no track" - the same thing `smoke-anim.js` says about a
      // cleared strip.
      const kept = (prop) => {
        const k = (live().fx[0].keys || {})[prop];
        return k ? k.length : 0;
      };
      ok('clearing leaves the hand key, so the effect stays',
        !!live().fx && kept('rotate') === 1 && kept('scale') === 0,
        JSON.stringify(live().fx && live().fx.map((f) =>
          ({ t: f.type, gen: f.gen, k: Object.keys(f.keys || {}).filter((x) => f.keys[x].length) }))));
      delete live().fx[0].keys.rotate;
      FX.normalizeClip(live());
      renderInspector();
      const genBtn2 = [...document.querySelectorAll('#inspector .fx-az button')]
        .find((b) => /Generate/.test(b.textContent));
      genBtn2.click();
      renderInspector();
      [...document.querySelectorAll('#inspector .fx-az button')]
        .find((b) => /Clear/.test(b.textContent)).click();
      ok('clearing an untouched generation takes the empty transform with it, so the ' +
        'clip goes back on the render fast path',
        !live().fx);

      while (undoStack.length > undo0) undo();
      ok('undo restores the clip exactly, stack and all',
        !!live() && !live().fx, JSON.stringify(live() && live().fx));

      // ---- the render cache -------------------------------------------------
      const c = live();
      c.fx = [FX.create('ripple')];
      const job = () => buildJob('C:\\out.mp4', { from: 0, to: 10 });
      const entryOf = (j) => j.clips.find((x) => x.id === id);
      ok('a clip drawing from a take carries a digest of it onto the job',
        !!entryOf(job()).mouse && entryOf(job()).mouse.n === c.mouse.events.length);
      const k0 = jobCacheKey(job());
      c.mouse = Cursor.makeTake(ev.concat([{ t: 9.5, x: 0.1, y: 0.1, type: 'down' }]));
      ok('a different take is a different render, so it is a different cache key',
        jobCacheKey(job()) !== k0);
      const k1 = jobCacheKey(job());
      ok('...and the digest does not change when the clip is merely re-keyed',
        JSON.stringify(entryOf(job()).mouse) ===
        JSON.stringify({ n: c.mouse.events.length, t0: c.mouse.events[0].t,
          t1: c.mouse.events[c.mouse.events.length - 1].t, clicks: true }));
      c.fx[0].enabled = false;
      ok('a BYPASSED pointer effect drops the digest - those pixels no longer depend on it',
        entryOf(job()).mouse === undefined && jobCacheKey(job()) !== k1);
      delete c.fx;
      ok('and a clip with no such effect never carried one',
        entryOf(job()).mouse === undefined);
      // Telemetry is back out of the key entirely: it decides no pixels any more, because
      // auto-zoom bakes its answer into ordinary keyframes the job already carries.
      c.fx = [FX.create('ripple')];
      const k2 = jobCacheKey(job());
      c.screen = tel(ev.slice(0, 5));
      ok('screen telemetry is NOT in the render key - it describes the source, not pixels',
        jobCacheKey(job()) === k2);

      // Leave the timeline as it was found.
      vt.clips.splice(vt.clips.findIndex((x) => x.id === id), 1);
      state.selection.clear();
      renderAll();
    }

    note('no fixture needed: every path here is synthetic, which is why they can be ' +
      'asserted exactly rather than approximately');

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
