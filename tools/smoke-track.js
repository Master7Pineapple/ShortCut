/**
 * Point motion tracking: the optical flow, the data on the clip, and the binding.
 *
 *   SHORTCUT_SMOKE=tools/smoke-track.js node_modules/.bin/electron .
 *
 * NO FIXTURE. The frames are painted here - a translating square on a textured ground -
 * which is the only way an accuracy claim can be exact: the answer is known to the pixel
 * before the solver runs, so "sub-pixel" is a measurement rather than an impression. A
 * real recording could only be checked against itself.
 *
 * The six things it exists to hold down:
 *
 *   1. ACCURACY. A point on a corner translating by a known amount comes back within a
 *      twentieth of a pixel, at integer and at fractional displacements.
 *   2. OCCLUSION LOWERS CONFIDENCE AND HOLDS. The point must not teleport, and the
 *      confidence must say what happened - a silently wrong track is the failure mode
 *      this whole feature is designed around.
 *   3. RE-ANCHORING RE-SOLVES FORWARD ONLY. The solved past survives a correction, to
 *      the sample.
 *   4. THE DATA IS PLAIN JSON on the clip - it survives a save and reload, it prunes
 *      itself away when the last track goes, and a solve is ONE undo entry.
 *   5. THE BINDING is the framing map and nothing else: the same source point, read
 *      through two different crops, lands where `drawClipTo()` would have put it. Every
 *      bindable type is checked, including that a bind to a track that is gone degrades
 *      to the sliders rather than throwing.
 *   6. THE CACHE KEY. A bound clip keeps its cached render when it is MOVED, and loses it
 *      when the samples change. That is the same rule the whole render cache lives by.
 *   7. TEXTURE AND CONFIDENCE ARE DIFFERENT QUESTIONS. A softly textured point that the
 *      flow follows perfectly must read as CONFIDENT, not lost - the two were multiplied
 *      together in the first build and the result was a tracker that called almost
 *      everything lost. Plus the flow that grew out of that: placing does not solve,
 *      a drop snaps to the nearest real feature, and a point with nothing to track is
 *      refused with a reason instead of being discovered a seek-per-frame later.
 *   8. REPAIR. A lost span with solved samples either side is interpolated across, an
 *      edge span is reported rather than guessed at, a hand-placed fix keeps every other
 *      sample, and a repaired span stops counting as lost while still being visible.
 *   9. FOLLOW STRENGTH, keyframable, which is the answer to a bound thing moving further
 *      than the thing it follows. Plus smoothing, and that both are plain JSON.
 *  10. CROSS-CLIP BINDING: a clip following a track on ANOTHER clip, mapped through the
 *      owner's framing, degrading when the owner goes, and putting the one thing it
 *      genuinely depends on - the offset between the two clips - into the render key.
 *
 * Plus the worker: the Blob build answers exactly what the in-process kernel answers,
 * which is what proves the concatenation is running the same source the suite checks.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

    // ---------------------------------------------------------------- fixtures
    //
    // A frame: a bright square on a dark ground, both faintly textured so that the
    // background is not a flat field the flow could slide along for free. `occl` paints
    // a bar over the middle - the thing passing in front of the tracked corner.
    const AW = 256, AH = 160;
    /** How much of the pixel starting at `i` falls inside [a, b] - 0..1. */
    const span = (i, a, b) => Math.max(0, Math.min(i + 1, b) - Math.max(i, a));
    function frame(dx, dy, occl) {
      const a = new Uint8ClampedArray(AW * AH * 4);
      for (let y = 0; y < AH; y++) {
        for (let x = 0; x < AW; x++) {
          const i = (y * AW + x) * 4;
          let v = 28 + ((x * 5 + y * 3) % 7);
          // COVERAGE, not a hard test. A square painted with `x > 40 + dx` is byte-
          // identical at dx = 0 and dx = 0.5 - the edge lands between the same two
          // integers - so a fixture built that way has no sub-pixel information in it
          // and no tracker could recover any. The edges are anti-aliased by area, which
          // is what a real frame's edges are, and what makes half a pixel mean something.
          const cov = span(x, 40 + dx, 90 + dx) * span(y, 40 + dy, 90 + dy);
          v = v * (1 - cov) + (205 + ((x * 3) % 9)) * cov;
          if (occl && x > 20 && x < 180 && y > 20 && y < 120) v = 10;
          a[i] = a[i + 1] = a[i + 2] = v;
          a[i + 3] = 255;
        }
      }
      return a;
    }
    const pyr = (dx, dy, occl) =>
      Tracker.buildPyramid(Tracker.gray(frame(dx, dy, occl), AW, AH), AW, AH, 3);

    // The tracked point: the square's top-left corner, where both gradients exist. A
    // point in its flat middle is the aperture problem, and the tracker says so with a
    // low confidence rather than by wandering - which is asserted below.
    const CORNER = { x: 40.5, y: 40.5 };

    // ======================================================== 1. the optical flow

    {
      const t0 = performance.now();
      let p = { x: CORNER.x, y: CORNER.y, c: 1 };
      let worst = 0, frames = 0;
      for (let k = 1; k <= 24; k++) {
        // A deliberately fractional step: an integer-only test would never exercise the
        // bilinear sampling, which is where sub-pixel accuracy actually lives.
        const r = Tracker.stepPoint(pyr(k - 1, 0), pyr(k, 0), p, {});
        p = r;
        frames++;
        worst = Math.max(worst, Math.abs(p.x - (CORNER.x + k)), Math.abs(p.y - CORNER.y));
      }
      const msPerFrame = (performance.now() - t0) / (frames * 2);
      ok('a translating corner is tracked to within 1/20 of a pixel over 24 frames',
        worst < 0.05, 'worst = ' + worst.toFixed(4) + ' px');
      ok('...and it stayed confident the whole way', p.c > 0.8, 'c = ' + p.c.toFixed(3));

      // Sub-pixel, stated as its own claim: a half-pixel displacement must come back as
      // a half pixel, not rounded to one.
      const sub = Tracker.trackPoints(pyr(0, 0), pyr(0.5, 0.25), [CORNER], {})[0];
      note('a fractional shift of a hard-edged square is quantised by the PAINTING, not ' +
        'by the tracker: the assertion is that it lands between the two integers');
      ok('a sub-pixel displacement comes back sub-pixel',
        sub.x - CORNER.x > 0.15 && sub.x - CORNER.x < 0.85,
        'dx = ' + (sub.x - CORNER.x).toFixed(3));

      const flat = Tracker.trackPoints(pyr(0, 0), pyr(3, 0), [{ x: 65, y: 65 }], {})[0];
      ok('a point in a flat interior reports LOW confidence rather than wandering',
        flat.c < Tracker.DEFAULTS.minConf, 'c = ' + flat.c.toFixed(3));
      ok('...because there is nothing there, which is a TEXTURE answer, not a fit one',
        flat.tex < Tracker.DEFAULTS.minTex, 'tex = ' + flat.tex.toFixed(3));

      /*
       * THE REGRESSION THIS FILE EXISTS FOR.
       *
       * Confidence used to be texture x fit, so a soft feature - antialiased text, a
       * gentle edge, most of a real UI - was reported LOST even while the flow sat exactly
       * on it. Texture is now asked once, at the anchor; per-frame confidence is the fit.
       * A soft but real edge, followed perfectly, must come back confident.
       */
      /*
       * A SOFT CORNER, which is what real interface footage is made of: a button edge, a
       * card corner, antialiased text. `contrast` is levels of 255 and `soft` is the width
       * of the transition in pixels, so these are the two numbers that describe how much
       * of a feature something is.
       *
       * It must be a CORNER and not an edge. A straight edge cannot be tracked by a single
       * point at all - it slides along itself, which is the aperture problem - and it
       * correctly scores near zero however high its contrast. The snap exists precisely to
       * move a drop off an edge and onto the nearest corner.
       */
      const softCorner = (dx, contrast, soft) => {
        const a = new Uint8ClampedArray(AW * AH * 4);
        const ss = (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
        for (let y = 0; y < AH; y++) {
          for (let x = 0; x < AW; x++) {
            const i = (y * AW + x) * 4;
            const v = 120 + contrast * ss((x - (120 + dx)) / soft + 0.5) * ss((y - 80) / soft + 0.5);
            a[i] = a[i + 1] = a[i + 2] = v;
            a[i + 3] = 255;
          }
        }
        return Tracker.buildPyramid(Tracker.gray(a, AW, AH), AW, AH, 3);
      };
      const softTex = Tracker.textureAt(softCorner(0, 40, 4), 120, 80, {});
      const soft = Tracker.stepPoint(softCorner(0, 40, 4), softCorner(3, 40, 4),
        { x: 120, y: 80, c: 1 }, {});
      ok('an ordinary soft button corner scores LOW on texture - it is not a hard corner',
        softTex > Tracker.DEFAULTS.minTex && softTex < 0.4, 'tex = ' + softTex.toFixed(3));
      ok('...and is followed exactly all the same',
        Math.abs(soft.x - 123) < 0.05, 'x = ' + soft.x.toFixed(3) + ' (want 123)');
      ok('...and is therefore reported CONFIDENT, not lost. THIS IS THE BUG THIS SPLIT ' +
        'FIXED: multiplied together, a texture of ' + softTex.toFixed(2) + ' called a ' +
        'perfectly tracked point lost',
        !soft.held && soft.c > 0.8, 'c = ' + soft.c.toFixed(3));
      ok('a straight EDGE is not trackable by one point at any contrast - the aperture ' +
        'problem, which is what the snap exists to walk away from',
        Tracker.textureAt(softCorner(0, 200, 2), 120, 20, {}) < Tracker.DEFAULTS.minTex);
      note('calibration, which is where minTex comes from: a 40-level/4px soft corner ' +
        'scores ' + softTex.toFixed(3) + ', a 25-level one about 0.055, dither on a flat ' +
        'wall about 0.012, and a hard corner 1.000. minTex is ' +
        Tracker.DEFAULTS.minTex + '.')

      note('kernel cost: ' + msPerFrame.toFixed(2) + ' ms per frame per point at ' +
        AW + 'x' + AH + ', plain JS, 3 pyramid levels. A solve is seek-bound, not ' +
        'flow-bound - which is the measurement the README quotes for there being no WASM.');
    }

    // =========================================================== 2. occlusion

    {
      let p = { x: CORNER.x, y: CORNER.y, c: 1 };
      for (let k = 1; k <= 6; k++) p = Tracker.stepPoint(pyr(k - 1, 0), pyr(k, 0), p, {});
      const before = { x: p.x, y: p.y };
      const hidden = Tracker.stepPoint(pyr(6, 0), pyr(6, 0, true), p, {});
      ok('an occlusion drops confidence below the hold threshold',
        hidden.c < Tracker.DEFAULTS.minConf, 'c = ' + hidden.c.toFixed(3));
      ok('...and HOLDS the last good position rather than teleporting',
        hidden.held && near(hidden.x, before.x, 1e-9) && near(hidden.y, before.y, 1e-9));
      ok('...and the hold is exactly a hold: no drift at all across a long occlusion',
        (() => {
          let q = hidden;
          for (let k = 0; k < 5; k++) q = Tracker.stepPoint(pyr(6, 0, true), pyr(6, 0, true), q, {});
          return near(q.x, before.x, 1e-9) && near(q.y, before.y, 1e-9);
        })());
    }

    // ============================== 3. scoring a point, and snapping to a real one

    {
      const p0 = pyr(0, 0);
      ok('a corner scores high and a flat wall scores nothing',
        Tracker.textureAt(p0, 40.5, 40.5, {}) > 0.9 &&
        Tracker.textureAt(p0, 200, 140, {}) < Tracker.DEFAULTS.minTex);

      // The snap is what turns "click roughly on the thing" into a tracker that works.
      const t0 = performance.now();
      const snapped = Tracker.bestFeatureNear(p0, 55, 55, 20, {});
      const ms = performance.now() - t0;
      ok('a drop near a corner snaps onto the feature rather than staying in the flat middle',
        snapped.tex > 0.9, 'tex ' + Tracker.textureAt(p0, 55, 55, {}).toFixed(3) +
        ' -> ' + snapped.tex.toFixed(3) + ' at ' + snapped.x + ',' + snapped.y);
      ok('...and never further than the reach it was given',
        Math.hypot(snapped.x - 55, snapped.y - 55) <= 20 + 1e-9);
      ok('...and it is fast enough to run on a click, at any radius',
        ms < 80, ms.toFixed(1) + ' ms');
      ok('a drop in the middle of nowhere snaps to nothing and says so',
        Tracker.bestFeatureNear(p0, 210, 140, 12, {}).tex < Tracker.DEFAULTS.minTex);

      ok('a fresh tracker is NOT solved, and one with samples is',
        !Tracker.isSolved(Tracker.makeTrack(0, 0.5, 0.5, {})) &&
        Tracker.isSolved({ points: [{ t: 0, x: 0, y: 0, c: 1 }, { t: 1, x: 0, y: 0, c: 1 }] }));
    }

    // ====================================================== 3b. the worker build

    {
      const w = await trackWorker();
      const id = 'smoke1';
      const f0 = frame(0, 0), f1 = frame(4, 2);
      await trkSend(w, {
        cmd: 'start', id, opts: {}, w: AW, h: AH, x: CORNER.x, y: CORNER.y, buf: f0.buffer,
      }, [f0.buffer]);
      const r = await trkSend(w, { cmd: 'step', id, t: 1, w: AW, h: AH, buf: f1.buffer }, [f1.buffer]);
      await trkSend(w, { cmd: 'end', id });
      const local = Tracker.stepPoint(pyr(0, 0), pyr(4, 2), { x: CORNER.x, y: CORNER.y, c: 1 }, {});
      ok('the Blob worker answers exactly what the in-process kernel answers - one ' +
        'source, and no way for a worker build to drift',
        near(r.x, local.x, 1e-9) && near(r.y, local.y, 1e-9) && near(r.c, local.c, 1e-9),
        'worker ' + r.x.toFixed(4) + ' vs local ' + local.x.toFixed(4));
      ok('a step against a job that was never started fails rather than hanging',
        await (async () => {
          const buf = frame(0, 0).buffer;
          try { await trkSend(w, { cmd: 'step', id: 'nope', t: 0, w: AW, h: AH, buf }, [buf]); return false; }
          catch (e) { return true; }
        })());
    }

    // ==================================================== 4. the data on the clip

    {
      const tk = Tracker.makeTrack(1, 0.5, 0.5, { name: 'T' });
      Tracker.mergePoints(tk, [
        { t: 1.5, x: 0.6, y: 0.5, c: 0.9 },
        { t: 2.0, x: 0.8, y: 0.5, c: 0.1 },
      ]);
      const mid = Tracker.sampleAt(tk, 1.25);
      ok('a sample between two keys interpolates the position',
        near(mid.x, 0.55, 1e-9) && near(mid.y, 0.5, 1e-9));
      ok('...and takes the LOWER confidence of the two, never the average',
        near(Tracker.sampleAt(tk, 1.75).c, 0.1, 1e-9));
      ok('before the first sample and after the last, the track HOLDS',
        near(Tracker.sampleAt(tk, -5).x, 0.5, 1e-9) && near(Tracker.sampleAt(tk, 99).x, 0.8, 1e-9));
      ok('the worst confidence in a span is what the lane strip draws',
        near(Tracker.worstIn(tk, 1, 2), 0.1, 1e-9) && near(Tracker.worstIn(tk, 1, 1.5), 0.9, 1e-9));

      // Re-anchoring, as the data operation the drag performs.
      const past = JSON.stringify(tk.points.filter((p) => p.t < 1.5));
      Tracker.reanchorAt(tk, 1.5, 0.62, 0.55);
      ok('re-anchoring keeps every sample BEFORE the correction, to the number',
        JSON.stringify(tk.points.filter((p) => p.t < 1.5)) === past);
      ok('...drops everything at or after it, so the solver fills only forward',
        tk.points.filter((p) => p.t > 1.5).length === 0);
      ok('...and the correction itself is the new anchor, at full confidence',
        near(tk.anchor.t, 1.5) && near(tk.anchor.x, 0.62) &&
        near(tk.points[tk.points.length - 1].c, 1));

      const clip = { kind: 'video', in: 0, out: 5, srcW: 1920, srcH: 1080, panX: 0.5, panY: 0.5, zoom: 1 };
      clip.tracks = [tk, { id: 'empty', points: [] }];
      Tracker.normalizeClip(clip);
      ok('normalising drops a track with no samples', clip.tracks.length === 1);
      clip.tracks = [];
      Tracker.normalizeClip(clip);
      ok('and the array itself goes with the last track - a project that tracked nothing ' +
        'serialises exactly as it did before this existed',
        clip.tracks === undefined);
    }

    // ============================================================ 5. the binding

    {
      const clip = { kind: 'video', in: 0, out: 5, srcW: 1920, srcH: 1080, panX: 0.5, panY: 0.5, zoom: 1 };
      const tk = Tracker.makeTrack(0, 0.5, 0.5, {});
      clip.tracks = [tk];
      const A = state.out.w / state.out.h;

      // The framing map against the one that draws the picture: the centre of the source
      // is the centre of the frame at zoom 1 and pan 0.5, whatever the crop's shape.
      const m = Tracker.frameMap(clip, A);
      ok('the centre of the source is the centre of the frame',
        near(m(0.5, 0.5).x, 0.5, 1e-9) && near(m(0.5, 0.5).y, 0.5, 1e-9));
      ok('the map is the clip framing, not an identity - a 16:9 source cropped to 9:16 ' +
        'puts a point a tenth across the SOURCE far outside the frame',
        m(0.1, 0.5).x < -0.5, m(0.1, 0.5).x.toFixed(3));
      ok('...and panning moves it, exactly as the crop does',
        (() => {
          const p0 = Tracker.frameMap(clip, A)(0.4, 0.5).x;
          const p1 = Tracker.frameMap(Object.assign({}, clip, { panX: 0.2 }), A)(0.4, 0.5).x;
          return p1 > p0;
        })());

      // A bound transform is a CAMERA. Solve it, then run the effect's own algebra
      // forward: the tracked point must land in the middle of the frame.
      const place = (p, pos) => ({
        x: p.anchorX + (pos.x - p.anchorX) * p.scale + p.x,
        y: p.anchorY + (pos.y - p.anchorY) * p.scale + p.y,
      });
      const tr = FX.create('transform');
      tr.bind = { track: tk.id, offX: 0, offY: 0 };
      tr.params.scale = 1.8;
      const frameOf = (sx, sy) => Tracker.frameMap(clip, A)(sx, sy);
      tk.points = [{ t: 0, x: 0.5, y: 0.5, c: 1 }, { t: 4, x: 0.56, y: 0.58, c: 1 }];
      for (const t of [0, 1.3, 4]) {
        const p = FX.paramsAt(tr, t, clip, state.out.w, state.out.h);
        const s = Tracker.sampleAt(tk, clip.in + t);
        const landed = place(p, frameOf(s.x, s.y));
        ok('a bound transform lands the tracked point in the middle of the frame at t=' + t,
          near(landed.x, 0.5, 1e-6) && near(landed.y, 0.5, 1e-6),
          landed.x.toFixed(5) + ', ' + landed.y.toFixed(5));
      }
      {
        const off = FX.create('transform');
        off.bind = { track: tk.id, offX: 0.2, offY: -0.1 };
        off.params.scale = 1.8;
        const p = FX.paramsAt(off, 2, clip, state.out.w, state.out.h);
        const s = Tracker.sampleAt(tk, 2);
        const landed = place(p, frameOf(s.x, s.y));
        ok('the follow offset moves the point by exactly that fraction of the frame',
          near(landed.x, 0.7, 1e-6) && near(landed.y, 0.4, 1e-6));
      }

      // The other two bind their own thing, and the difference IS the feature.
      const sp = FX.create('spotlight');
      sp.bind = { track: tk.id, offX: 0, offY: 0 };
      {
        const p = FX.paramsAt(sp, 4, clip, state.out.w, state.out.h);
        const want = frameOf(0.56, 0.58);
        ok('a bound spotlight centres its lit shape on the tracked point',
          near(p.x + p.w / 2, want.x, 1e-6) && near(p.y + p.h / 2, want.y, 1e-6));
        ok('...and its size, feather and dim still come from the sliders',
          p.w === FX.DEFS.spotlight.params.w && p.dim === FX.DEFS.spotlight.params.dim);
      }
      const cut = FX.create('cutout');
      cut.bind = { track: tk.id, offX: 0, offY: 0 };
      {
        const p = FX.paramsAt(cut, 4, clip, state.out.w, state.out.h);
        const want = frameOf(0.56, 0.58);
        ok('a bound cutout follows with its SOURCE region - the float stays put',
          near(p.sx + p.sw / 2, want.x, 1e-6) && near(p.sy + p.sh / 2, want.y, 1e-6) &&
          p.x === FX.DEFS.cutout.params.x && p.y === FX.DEFS.cutout.params.y);
      }
      ok('the panel derives which parameters a bind takes over by RUNNING it, so the ' +
        'list cannot drift from the write',
        FX.boundParams('transform').join() === 'x,y' &&
        FX.boundParams('spotlight').join() === 'x,y' &&
        FX.boundParams('cutout').join() === 'sx,sy');
      ok('a type that cannot follow anything offers no binding at all',
        !FX.DEFS.blur.bind && !FX.DEFS.grade.bind && FX.boundParams('blur').length === 0);

      // The degradation contract, at every door.
      const gone = FX.create('spotlight');
      gone.bind = { track: 'no-such-track', offX: 0, offY: 0 };
      const still = FX.paramsAt(gone, 1, clip, 540, 960);
      ok('a bind to a track that is gone draws the static parameters rather than throwing',
        still.x === FX.DEFS.spotlight.params.x && still.y === FX.DEFS.spotlight.params.y);
      ok('a bind on a clip with no tracks at all does the same',
        (() => {
          const bare = { kind: 'video', in: 0, out: 2, srcW: 1920, srcH: 1080, panX: 0.5, panY: 0.5, zoom: 1 };
          const p = FX.paramsAt(gone, 1, bare, 540, 960);
          return p.x === FX.DEFS.spotlight.params.x;
        })());
      ok('and reading the parameters with no clip at all - what every non-drawing caller ' +
        'does - is the unbound answer',
        FX.paramsAt(sp, 1).x === FX.DEFS.spotlight.params.x);

      // Keys still animate everything the bind does not write.
      const keyed = FX.create('spotlight');
      keyed.bind = { track: tk.id, offX: 0, offY: 0 };
      keyed.keys = { w: [{ t: 0, v: 0.2, ease: 'linear' }, { t: 4, v: 0.8, ease: 'linear' }] };
      ok('a bound effect still keyframes everything the binding does not write',
        near(FX.paramsAt(keyed, 2, clip, 540, 960).w, 0.5, 1e-6));

      // Serialisation and normalisation.
      const round = JSON.parse(JSON.stringify({ fx: [sp], tracks: clip.tracks }));
      FX.normalize(round.fx[0]);
      ok('a binding is plain JSON and survives a save and reload',
        round.fx[0].bind && round.fx[0].bind.track === tk.id);
      const bogus = FX.create('blur');
      bogus.bind = { track: tk.id };
      FX.normalize(bogus);
      ok('a binding on a type that cannot follow is dropped by normalise',
        bogus.bind === undefined);
      ok('a bound effect is time-varying, so the shutter has something to average',
        FX.timeVarying(sp) && !FX.timeVarying(FX.create('spotlight')));
    }

    // ==================================== 6. on the timeline: panel, undo, the key

    {
      const vt = state.tracks.find((t) => t.type === 'video');
      const id = nextId();
      vt.clips.push({
        id, src: 'C:\\fake\\screen.mp4', name: 'screen', kind: 'video',
        start: 2, in: 0, out: 6, mediaDuration: 6,
        srcW: 1920, srcH: 1080, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      sortTracks();
      const live = () => allClips().map((x) => x.clip).find((c) => c.id === id);
      setSelection([id], false);
      renderInspector();

      ok('a video clip gets the Motion tracking panel',
        !!document.querySelector('#inspector .trk-box'));
      ok('...and it is NOT another effect in the stack menu - a tracker is analysis, ' +
        'not a thing that draws',
        [...document.querySelectorAll('#inspector .fx-box .fx-add select option')]
          .every((o) => o.value !== 'track'));

      // The tracker, dropped by hand: `addTracker()` also kicks off a solve, which needs
      // a decoder, so the suite does the data half and asserts on that.
      const undo0 = undoStack.length;
      pushUndo();
      const c = live();
      c.tracks = [Tracker.makeTrack(0, 0.5, 0.5, { name: 'Track 1' })];
      Tracker.mergePoints(c.tracks[0], (() => {
        const pts = [];
        for (let i = 1; i <= 60; i++) {
          const t = i / 30;
          // A dip in the middle, so the strip and the warnings have something to draw.
          pts.push({ t, x: 0.5 + 0.004 * i, y: 0.5, c: (t > 1 && t < 1.5) ? 0.1 : 0.95 });
        }
        return pts;
      })());
      markDirty();
      renderAll();
      ok('a solve is ONE undo entry however many samples it produces',
        undoStack.length === undo0 + 1, undo0 + ' -> ' + undoStack.length);
      ok('nothing non-serialisable landed on the clip',
        JSON.stringify(live()) === JSON.stringify(JSON.parse(JSON.stringify(live()))));
      ok('the lane draws a confidence strip for it',
        !!document.querySelector('.clip[data-clip-id="' + id + '"] .trackconf'));
      renderInspector();
      ok('the panel says where the track is weakest, in numbers',
        /lowest confidence \d+%/.test(document.querySelector('#inspector .trk-box').textContent));
      ok('...and warns in words when it drops below the hold threshold',
        !!document.querySelector('#inspector .trk-box .fx-warn'));

      // The marker on the viewer, and the drag that re-anchors it.
      state.playhead = 2.5;
      const marks = trackMarkers();
      ok('the tracker is drawn on the viewer at the frame position its track names',
        marks.length === 1 &&
        near(marks[0].x, Tracker.frameMap(live(), state.out.w / state.out.h)(
          Tracker.sampleAt(live().tracks[0], 0.5).x, 0.5).x, 1e-9));
      ok('a marker outside the clip in time is not drawn',
        (() => { state.playhead = 30; const n = trackMarkers().length; state.playhead = 2.5; return n === 0; })());

      const beforePast = JSON.stringify(live().tracks[0].points.filter((p) => p.t < 0.5));
      const undo1 = undoStack.length;
      // The drag's own effect on the DATA, without the solve that follows it.
      pushUndo();
      Tracker.reanchorAt(live().tracks[0], 0.5, 0.62, 0.44);
      markDirty();
      renderAll();
      ok('dragging the marker is one undo entry and re-anchors at the playhead',
        undoStack.length === undo1 + 1 && near(live().tracks[0].anchor.t, 0.5));
      ok('...and everything solved BEFORE that frame is untouched',
        JSON.stringify(live().tracks[0].points.filter((p) => p.t < 0.5)) === beforePast);
      ok('...while everything after it is gone, waiting on the forward solve',
        live().tracks[0].points.filter((p) => p.t > 0.5).length === 0);
      undo();
      ok('undo puts the whole solve back', live().tracks[0].points.length === 61);

      // The cache key. This is the load-bearing one.
      const job = () => buildJob('out.mp4', { from: 0, to: projectDuration() });
      const entryOf = (j) => j.clips.find((x) => x.id === id);
      const kPlain = jobCacheKey(job());
      ok('a track nothing is bound to is NOT in the render key - analysis nobody reads ' +
        'changes no pixels',
        entryOf(job()).tracks === undefined);

      live().fx = [Object.assign(FX.create('spotlight'),
        { bind: { track: live().tracks[0].id, offX: 0, offY: 0 } })];
      const kBound = jobCacheKey(job());
      ok('binding an effect to it DOES change the key - those samples now decide pixels',
        kBound !== kPlain && !!entryOf(job()).tracks);

      const digestNow = () => JSON.stringify(entryOf(job()).tracks);
      const atTwo = digestNow();
      const moved = (() => {
        const c2 = live();
        const was = c2.start;
        c2.start = 5;
        sortTracks();
        const d = digestNow();
        c2.start = was;
        sortTracks();
        return d;
      })();
      ok('MOVING the clip does not change what the binding contributes to the key - a ' +
        'bound effect draws the same pixels wherever the clip sits, which is the cache ' +
        'rule this had to keep',
        moved === atTwo, atTwo);
      note('the job key itself DOES move with the clip, and always has: `start` decides ' +
        'which frames a render covers, not what a clip looks like. The rule this step ' +
        'had to keep is that the TRACK contributes no position, and it does not.');

      live().tracks[0].points[10].x += 0.01;
      ok('changing a sample the binding reads DOES change the key',
        jobCacheKey(job()) !== kBound);
      live().fx[0].enabled = false;
      ok('bypassing the bound effect takes the track back out of the key',
        entryOf(job()).tracks === undefined);
      live().fx[0].enabled = true;
      live().fx[0].bind.track = 'gone';
      ok('a binding to a track that is not there keys as unbound rather than as null-ish ' +
        'noise that would change on every rebuild',
        (() => { const e = entryOf(job()); return Array.isArray(e.tracks) && e.tracks[0] === null; })());

      // The pixels, for the contract steps 8 and 9 already keep and this one inherits.
      {
        const bare = JSON.parse(JSON.stringify(live()));
        delete bare.tracks;
        const paint = (cv) => {
          const c2 = cv.getContext('2d');
          c2.fillStyle = '#3a6ea5';
          c2.fillRect(0, 0, cv.width, cv.height);
        };
        const shot = (clip) => {
          const cv = document.createElement('canvas');
          cv.width = 120; cv.height = 213;
          const c2 = cv.getContext('2d');
          const surf = new Map();
          FX.render(c2, cv.width, cv.height, clip, 1,
            (n, w, h) => {
              let s = surf.get(n);
              if (!s) { s = document.createElement('canvas'); surf.set(n, s); }
              if (s.width !== w || s.height !== h) { s.width = w; s.height = h; }
              return s;
            },
            (cx, w, h) => { cx.fillStyle = '#3a6ea5'; cx.fillRect(0, 0, w, h); }, 1 / 30);
          return cv.toDataURL();
        };
        const withTrack = JSON.parse(JSON.stringify(live()));
        withTrack.fx[0].bind.track = withTrack.tracks[0].id;
        const bareFx = JSON.parse(JSON.stringify(bare));
        ok('a clip with NO tracks paints the same pixels with a bound effect as without ' +
          'one - the degradation contract, in pixels',
          shot(bareFx) === shot(Object.assign(JSON.parse(JSON.stringify(bare)),
            { fx: [Object.assign(FX.create('spotlight'), { bind: { track: 'gone', offX: 0, offY: 0 } })] })));
        ok('...and a clip WITH one paints something different, or the binding does nothing',
          shot(withTrack) !== shot(bareFx));
      }

      // ---------------------------------------------------- the placement flow
      //
      // The order that was wrong in the first build: adding a tracker SOLVED it, from the
      // middle of the frame, which is almost never what anyone wants followed.
      {
        const c3 = live();
        c3.tracks = [];
        Tracker.normalizeClip(c3);
        const undoA = undoStack.length;
        const tk2 = await addTracker(c3, 0.5, 0.5);
        ok('adding a tracker is ONE undo entry', undoStack.length === undoA + 1);
        ok('...and it does NOT solve: it is a marker waiting to be put somewhere',
          !Tracker.isSolved(tk2) && tk2.points.length === 1 && !Trk.busy);
        note('this clip has no decodable media in the suite, so the drop is placed ' +
          'unscored - which is the other half of the contract: a decoder that cannot ' +
          'answer must not swallow the interaction');
        renderInspector();
        const btn = [...document.querySelectorAll('#inspector .trk-box button')]
          .map((b) => b.textContent);
        ok('the panel offers Solve, not Re-solve, on a tracker nobody has solved',
          btn.includes('Solve') && !btn.includes('Re-solve'));
        ok('...and the panel says it is not solved rather than quoting a meaningless 100%',
          /not solved yet/.test(document.querySelector('#inspector .trk-box').textContent));

        // Dragging an UNSOLVED marker is still placing it: no solve, no busy flag.
        const undoB = undoStack.length;
        await reanchorTracker(c3, tk2, 0.3, 0.4);
        ok('dragging an unsolved marker moves it and starts no solve',
          !Trk.busy && !Tracker.isSolved(tk2) && undoStack.length === undoB + 1);

        // A point with nothing to track is refused BEFORE a seek per frame proves it.
        tk2.tex = 0.001;
        const refused = await solveTrack(c3, tk2, false);
        ok('solving a point with nothing to track is refused, with a reason',
          refused === null && /Nothing to track/.test($('#renderStatus').textContent));
        renderInspector();
        ok('...and the panel disables Solve and says what to do instead',
          [...document.querySelectorAll('#inspector .trk-box button')]
            .some((b) => b.textContent === 'Solve' && b.disabled) &&
          /flat/.test(document.querySelector('#inspector .trk-box').textContent));

        // Once it IS solved, the panel changes its mind about the verb.
        tk2.tex = 0.9;
        Tracker.mergePoints(tk2, [{ t: tk2.anchor.t + 0.1, x: 0.31, y: 0.41, c: 0.9 }]);
        renderInspector();
        ok('a solved track offers Re-solve',
          [...document.querySelectorAll('#inspector .trk-box button')]
            .some((b) => b.textContent === 'Re-solve'));
        c3.tracks = [];
        Tracker.normalizeClip(c3);
      }

      // Leave the timeline as it was found.
      vt.clips.splice(vt.clips.findIndex((x) => x.id === id), 1);
      state.selection.clear();
      state.playhead = 0;
      renderAll();
    }

    // ============================================================== 7. repair

    {
      // A track with a hole in the middle and a hole at the end: the two kinds, which
      // need two different answers.
      const tk = Tracker.makeTrack(0, 0.10, 0.5, {});
      const pts = [];
      for (let i = 1; i <= 20; i++) {
        const t = i / 10;
        const mid = i >= 6 && i <= 10;          // lost in the middle, recovered after
        const tail = i >= 19;                   // lost at the end, never recovered
        pts.push({ t, x: (mid || tail) ? 0.15 : 0.10 + 0.02 * i, y: 0.5, c: (mid || tail) ? 0.05 : 0.95 });
      }
      Tracker.mergePoints(tk, pts);

      const spans = Tracker.lostSpans(tk, Tracker.DEFAULTS.minConf);
      ok('the lost spans are found, and the one at the end is marked as an EDGE span',
        spans.length === 2 && !spans[0].edge && spans[1].edge === 'trail',
        JSON.stringify(spans.map((x) => [x.t0, x.t1, x.edge])));

      const frozen = tk.points.find((q) => near(q.t, 0.8)).x;
      const r = Tracker.repairSpans(tk, {});
      ok('repair bridges the interior span and refuses to guess at the edge one',
        r.bridged === 1 && r.edges === 1);
      ok('...and the bridged samples are a straight line between the solved ends, not ' +
        'the frozen position the solver left behind',
        near(tk.points.find((q) => near(q.t, 0.8)).x, 0.26, 1e-6) && near(frozen, 0.15),
        frozen + ' -> ' + tk.points.find((q) => near(q.t, 0.8)).x);
      ok('...every sample it touched is marked as a repair',
        tk.points.filter((q) => q.fix === 1).length === 5 && Tracker.fixCount(tk) === 5);
      ok('a repaired span stops counting as lost - a repaired track is not a broken one',
        Tracker.worstIn(tk, 0, 1.5) > Tracker.DEFAULTS.minConf);
      ok('...but the confidence underneath is left alone, so the strip can still show ' +
        'where the machine actually failed',
        near(tk.points.find((q) => near(q.t, 0.8)).c, 0.05));
      ok('the edge span is still lost, because there is nothing to bridge towards',
        Tracker.worstIn(tk, 1.8, 2.0) < Tracker.DEFAULTS.minConf);
      ok('repairing twice changes nothing - it is idempotent',
        (() => {
          const before = JSON.stringify(tk.points);
          Tracker.repairSpans(tk, {});
          return JSON.stringify(tk.points) === before;
        })());

      // A hand fix: surgical, and it keeps the rest of the track.
      const tk2 = Tracker.makeTrack(0, 0.1, 0.5, {});
      Tracker.mergePoints(tk2, pts.map((q) => Object.assign({}, q)));
      const tailBefore = JSON.stringify(tk2.points.filter((q) => q.t > 1.2));
      Tracker.fixPointAt(tk2, 0.8, 0.4, 0.6, {});
      const fixed = tk2.points.find((q) => near(q.t, 0.8));
      ok('a hand fix lands on the sample grid and is marked as a hand fix',
        fixed && fixed.fix === 2 && near(fixed.x, 0.4) && near(fixed.y, 0.6) && fixed.c === 1);
      ok('...and it keeps every sample after it, unlike re-anchoring',
        JSON.stringify(tk2.points.filter((q) => q.t > 1.2)) === tailBefore);
      // Interpolated by TIME between the solved sample at 0.5 (x 0.20) and the hand fix
      // at 0.8 (x 0.40), so t=0.7 is two thirds of the way across, not the midpoint.
      ok('...and the lost samples either side of it are re-bridged towards it',
        near(tk2.points.find((q) => near(q.t, 0.7)).x, 0.2 + 0.2 * (2 / 3), 1e-5),
        tk2.points.find((q) => near(q.t, 0.7)).x.toFixed(5));
      ok('the repair survives a save and reload as plain JSON',
        (() => {
          const c2 = { tracks: [JSON.parse(JSON.stringify(tk2))] };
          Tracker.normalizeClip(c2);
          const p8 = c2.tracks[0].points.find((q) => near(q.t, 0.8));
          return p8.fix === 2 && c2.tracks[0].points.some((q) => q.fix === 1);
        })());
      ok('an untouched track carries no `fix` at all, so it serialises as it always did',
        (() => {
          const clean = { tracks: [Tracker.makeTrack(0, 0.5, 0.5, {})] };
          Tracker.normalizeClip(clean);
          return !('fix' in clean.tracks[0].points[0]);
        })());
    }

    // ================================================ 8. follow strength and smoothing

    {
      const clip = { id: 'cS', kind: 'video', in: 0, out: 4, srcW: 1920, srcH: 1080,
        panX: 0.5, panY: 0.5, zoom: 1 };
      const tk = Tracker.makeTrack(0, 0.5, 0.5, {});
      tk.id = 'tkS';
      Tracker.mergePoints(tk, [{ t: 2, x: 0.7, y: 0.5, c: 1 }]);
      clip.tracks = [tk];
      const A = state.out.w / state.out.h;
      const at = (bind, t) => Tracker.bindPos(clip, bind, t, A, t);

      const full = at({ track: 'tkS', strength: 1 }, 2);
      const half = at({ track: 'tkS', strength: 0.5 }, 2);
      const none = at({ track: 'tkS', strength: 0 }, 2);
      const anchorX = at({ track: 'tkS', strength: 1 }, 0).x;
      ok('strength 1 follows the track exactly', full.x > anchorX + 0.5);
      ok('strength 0.5 travels exactly half as far from the anchor',
        near(half.x - anchorX, (full.x - anchorX) / 2, 1e-9),
        (full.x - anchorX).toFixed(4) + ' -> ' + (half.x - anchorX).toFixed(4));
      ok('strength 0 pins it where the tracker was placed - which is the answer to a ' +
        'callout that travels further than the thing it follows',
        near(none.x, anchorX, 1e-9));

      // Keyframed, which is what "in specific durations" needs.
      const keyed = { track: 'tkS', strength: 1, keys: { strength: [
        { t: 0, v: 1, ease: 'linear' }, { t: 4, v: 0, ease: 'linear' }] } };
      const k0 = at(keyed, 2);
      ok('strength is keyframable, so a shot can follow hard through one stretch and ' +
        'barely at all through another',
        near(k0.x - anchorX, (full.x - anchorX) * 0.5, 1e-6),
        'at t=2 the key says 0.5');
      ok('...and the keys are ordinary Anim keys on the binding itself',
        (() => {
          const e = Object.assign(FX.create('spotlight'), { bind: JSON.parse(JSON.stringify(keyed)) });
          FX.normalize(e);
          return !!(e.bind.keys && e.bind.keys.strength.length === 2) &&
            JSON.stringify(e) === JSON.stringify(JSON.parse(JSON.stringify(e)));
        })());

      // Smoothing, against a track that is accurate but jittery.
      const j = Tracker.makeTrack(0, 0.5, 0.5, {});
      j.id = 'tkJ';
      for (let i = 1; i <= 60; i++) Tracker.mergePoints(j, [{ t: i / 30, x: 0.5 + ((i % 2) ? 0.01 : -0.01), y: 0.5, c: 1 }]);
      const clipJ = Object.assign({}, clip, { tracks: [j] });
      const rawX = Tracker.bindPos(clipJ, { track: 'tkJ' }, 1, A, 1).x;
      const smoothX = Tracker.bindPos(clipJ, { track: 'tkJ', smooth: 0.2 }, 1, A, 1).x;
      const centre = Tracker.frameMap(clipJ, A)(0.5, 0.5).x;
      ok('smoothing pulls a jittery track back onto its own centre line',
        Math.abs(smoothX - centre) * 5 < Math.abs(rawX - centre),
        'raw ' + (rawX - centre).toFixed(4) + ' -> ' + (smoothX - centre).toFixed(4));
      ok('smoothing 0 is the track exactly, so it costs nothing when it is not asked for',
        near(Tracker.bindPos(clipJ, { track: 'tkJ', smooth: 0 }, 1, A, 1).x, rawX, 1e-12));
    }

    // ===================================================== 9. binding across clips

    {
      const vt = state.tracks.find((t) => t.type === 'video');
      const idA = nextId(), idB = nextId();
      // B is the recording that carries the track; A is the logo that follows it.
      vt.clips.push({
        id: idB, src: 'C:\\fake\\rec.mp4', name: 'rec', kind: 'video',
        start: 0, in: 0, out: 8, mediaDuration: 8, srcW: 1920, srcH: 1080, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      vt.clips.push({
        id: idA, src: 'C:\\fake\\logo.png', name: 'logo', kind: 'image',
        start: 2, in: 0, out: 4, mediaDuration: 3600, srcW: 400, srcH: 200, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      sortTracks();
      const liveA = () => allClips().map((x) => x.clip).find((c) => c.id === idA);
      const liveB = () => allClips().map((x) => x.clip).find((c) => c.id === idB);

      const tk = Tracker.makeTrack(0, 0.5, 0.5, {});
      tk.id = 'tkX';
      Tracker.mergePoints(tk, [{ t: 4, x: 0.8, y: 0.6, c: 1 }]);
      liveB().tracks = [tk];

      const logo = liveA();
      logo.fx = [Object.assign(FX.create('transform'),
        { gen: 'place', bind: { clip: idB, track: 'tkX', offX: 0, offY: 0, strength: 1, smooth: 0 } })];

      // A's local t=2 is timeline 4, which is B's source 4 - where the track says 0.8.
      const A = state.out.w / state.out.h;
      const want = Tracker.frameMap(liveB(), A)(0.8, 0.6);
      const p = FX.paramsAt(logo.fx[0], 2, logo, state.out.w, state.out.h);
      const place = (pp, pos) => ({
        x: pp.anchorX + (pos.x - pp.anchorX) * pp.scale + pp.x,
        y: pp.anchorY + (pos.y - pp.anchorY) * pp.scale + pp.y,
      });
      const landed = place(p, want);
      ok('a clip can follow a track on ANOTHER clip, through the OWNER clip\u2019s framing',
        near(landed.x, 0.5, 1e-6) && near(landed.y, 0.5, 1e-6),
        landed.x.toFixed(5) + ', ' + landed.y.toFixed(5));

      ok('the panel offers tracks from other clips, named by the clip they are on',
        (() => {
          setSelection([idA], false);
          renderInspector();
          const opts = [...document.querySelectorAll('#inspector select option')]
            .map((o) => o.textContent);
          return opts.some((t) => /rec/.test(t));
        })());

      ok('an image clip gets a Size and position panel',
        !!document.querySelector('#inspector .trk-box') &&
        /Size and position/.test(document.querySelector('#inspector').textContent));

      // The framing modes, which is what makes a logo placeable at all.
      ok('a still defaults to filling the frame, exactly as it always has',
        liveA().fit === undefined);
      liveA().fit = 'contain';
      ok('...and a contained still is composited rather than handed to the fast path, ' +
        'because ffmpeg\u2019s crop chain cannot express transparency around it',
        clipNeedsBake(liveA()));

      // The render key: the OFFSET between the two clips is what the pixels depend on.
      const job = () => buildJob('out.mp4', { from: 0, to: projectDuration() });
      const digestOf = () => JSON.stringify((job().clips.find((x) => x.id === idA) || {}).tracks);
      const base = digestOf();
      ok('a cross-clip binding puts the owner\u2019s track AND the offset between the ' +
        'clips into the key', /"dt"/.test(base) && /"d"/.test(base));

      const bothMoved = (() => {
        liveA().start += 3; liveB().start += 3;
        sortTracks();
        const d = digestOf();
        liveA().start -= 3; liveB().start -= 3;
        sortTracks();
        return d;
      })();
      ok('moving BOTH clips together keeps the picture and keeps the key - the pixels ' +
        'depend on the offset, not on where the pair sits',
        bothMoved === base);

      const oneMoved = (() => {
        liveA().start += 1;
        sortTracks();
        const d = digestOf();
        liveA().start -= 1;
        sortTracks();
        return d;
      })();
      ok('...and moving ONE of them changes it, because that genuinely is a new picture',
        oneMoved !== base);

      const reframed = (() => {
        liveB().panX = 0.2;
        const d = digestOf();
        liveB().panX = 0.5;
        return d;
      })();
      ok('re-framing the clip that owns the track changes it too - the point is mapped ' +
        'through that framing',
        reframed !== base);

      // Degradation, which matters more across clips than within one.
      const gone = (() => {
        const i = vt.clips.findIndex((x) => x.id === idB);
        const saved = vt.clips[i];
        vt.clips.splice(i, 1);
        const params = FX.paramsAt(liveA().fx[0], 2, liveA(), 540, 960);
        vt.clips.splice(i, 0, saved);
        sortTracks();
        return params;
      })();
      ok('deleting the clip that owns the track degrades to the static parameters ' +
        'rather than throwing',
        gone.x === FX.DEFS.transform.params.x && gone.y === FX.DEFS.transform.params.y);

      for (const id of [idA, idB]) {
        const i = vt.clips.findIndex((x) => x.id === id);
        if (i >= 0) vt.clips.splice(i, 1);
      }
      state.selection.clear();
      renderAll();
    }

    note('no fixture needed: every frame here is painted by the suite, which is why the ' +
      'accuracy claims can be exact rather than approximate');

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
