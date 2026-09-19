'use strict';
/**
 * Point motion tracking - the pure half.
 *
 * Loaded as a plain <script> global `Tracker` before `fx.js`, the way `anim.js` and
 * `cursor.js` are, and as a CommonJS module for anything outside a window. It is also
 * loaded INSIDE the worker: `track-worker.js` is concatenated onto this file, so the
 * optical flow that solves a clip and the optical flow a smoke suite checks are the same
 * source and can never drift. Nothing here touches the DOM, a canvas, ffmpeg or the
 * filesystem - the frames arrive as luma arrays and the answers leave as numbers.
 *
 * WHAT LANDS ON A CLIP
 *
 *   clip.tracks = [ { id, name, res, rate, points: [{ t, x, y, c }], anchor: {t, x, y} } ]
 *
 * Plain JSON, absent until a tracker is dropped, and pruned away again with the last one -
 * undo is `JSON.stringify` of the track list and the same shape is the `.scut` file.
 *
 *   `t`     SOURCE seconds, from the media file's first frame. The same axis `clip.screen`
 *           and `clip.mouse` use, and for the same reason: it is the only timebase that
 *           survives trimming, splitting and dragging the clip afterwards.
 *   `x`,`y` fractions of the SOURCE frame, so they are independent of the resolution the
 *           solve happened to run at and of the clip's pan/zoom framing.
 *   `c`     confidence, 0..1. It is a first-class part of the data, not a diagnostic:
 *           the timeline draws it, so a lost track is VISIBLE rather than silently wrong.
 *
 * OCCLUSION HOLDS, IT NEVER TELEPORTS.
 *
 * When the window a point sits in stops looking like the window it was anchored on -
 * something passed in front of it, it left the frame, it dissolved - the residual rises,
 * confidence falls, and the solver keeps the LAST GOOD POSITION rather than accepting
 * whatever the flow guessed. A tracker that jumps to the other side of the screen for
 * six frames and comes back is worse than one that sits still and says so: the first
 * throws a callout across the picture, the second draws a dip on the timeline.
 *
 * THE MEASUREMENT, which the README carries.
 *
 * Plain JS, no WASM. `smoke-track.js` times the kernel on a real solve and prints it;
 * those numbers are why there is no WASM build in this file. A handful of points at
 * preview resolution costs single-digit milliseconds a frame, and the seek that produced
 * the frame costs far more - so the flow is not what makes a solve take time.
 */
(function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, isFinite(Number(v)) ? Number(v) : lo));
  const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d);
  const r4 = (x) => Math.round((Number(x) || 0) * 1e4) / 1e4;
  const r5 = (x) => Math.round((Number(x) || 0) * 1e5) / 1e5;

  /** Every default in one place, so the panel, the solver and the suite agree. */
  const DEFAULTS = {
    win: 15,          // odd; the side of the correlation window in pixels, at every level
    levels: 3,        // pyramid levels including the full-resolution one
    iters: 14,        // Newton steps per level
    eps: 0.008,       // stop when a step moves less than this many pixels
    minEig: 0.0015,   // the scale the texture score is measured against
    minTex: 0.03,     // below this there is NOTHING here to track - a flat wall
    resid: 22,        // luma RMS residual, in levels of 255, that reads as "lost"
    minConf: 0.35,    // below this the point is HELD rather than moved
    res: 480,         // the long side the solve runs at, in pixels
    rate: 30,         // samples per second of source
  };

  // ------------------------------------------------------------------ the kernel

  /** Luma from RGBA bytes. One Float32 per pixel, 0..255. */
  function gray(rgba, w, h) {
    const out = new Float32Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }
    return out;
  }

  /** Halve an image with a 2x2 box. Cheap, and its blur is what makes the level useful. */
  function half(d, w, h) {
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
    const out = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const y0 = 2 * y, y1 = Math.min(h - 1, y0 + 1);
      for (let x = 0; x < w2; x++) {
        const x0 = 2 * x, x1 = Math.min(w - 1, x0 + 1);
        out[y * w2 + x] = 0.25 * (d[y0 * w + x0] + d[y0 * w + x1] + d[y1 * w + x0] + d[y1 * w + x1]);
      }
    }
    return { d: out, w: w2, h: h2 };
  }

  /** `[{d,w,h}, ...]`, index 0 full resolution and each one after it half the last. */
  function buildPyramid(d, w, h, levels) {
    const pyr = [{ d, w, h }];
    const n = Math.max(1, Math.min(6, Math.round(num(levels, DEFAULTS.levels))));
    for (let i = 1; i < n; i++) {
      const prev = pyr[i - 1];
      if (prev.w < 8 || prev.h < 8) break;
      pyr.push(half(prev.d, prev.w, prev.h));
    }
    return pyr;
  }

  /** Bilinear sample, clamped at the edges so a window may hang off the frame. */
  function sample(im, x, y) {
    const w = im.w, d = im.d;
    const fx = clamp(x, 0, w - 1.001), fy = clamp(y, 0, im.h - 1.001);
    const x0 = fx | 0, y0 = fy | 0;
    const ax = fx - x0, ay = fy - y0;
    const i = y0 * w + x0;
    const a = d[i], b = d[i + 1], c = d[i + w], e = d[i + w + 1];
    return a + (b - a) * ax + (c - a) * ay + (a - b - c + e) * ax * ay;
  }

  /**
   * One point, one pyramid level. Returns the refined displacement and what it cost.
   *
   * Standard Lucas-Kanade: the spatial gradient matrix of the PREVIOUS window is built
   * once, and each iteration only re-samples the next frame. The 2x2 solve is by hand -
   * it is two numbers, and a matrix library here would cost more than the flow does.
   */
  function lkLevel(prev, next, px, py, gx, gy, o) {
    const hw = (Math.max(3, o.win | 0) - 1) >> 1;
    let Gxx = 0, Gxy = 0, Gyy = 0;
    const n = (2 * hw + 1) * (2 * hw + 1);
    const Ix = new Float32Array(n), Iy = new Float32Array(n), I0 = new Float32Array(n);
    let k = 0;
    for (let j = -hw; j <= hw; j++) {
      for (let i = -hw; i <= hw; i++, k++) {
        const x = px + i, y = py + j;
        const ix = 0.5 * (sample(prev, x + 1, y) - sample(prev, x - 1, y));
        const iy = 0.5 * (sample(prev, x, y + 1) - sample(prev, x, y - 1));
        Ix[k] = ix; Iy[k] = iy; I0[k] = sample(prev, x, y);
        Gxx += ix * ix; Gxy += ix * iy; Gyy += iy * iy;
      }
    }
    // The smaller eigenvalue of G, normalised by the window size and by 255^2, is
    // "how much texture is there to track" - the Shi-Tomasi score. A flat window has
    // none, and every displacement fits it equally well, which is how a tracker ends up
    // sliding along a gradient or wandering across a plain background.
    const tr = (Gxx + Gyy) / 2, det = Gxx * Gyy - Gxy * Gxy;
    const disc = Math.max(0, tr * tr - det);
    const minEig = (tr - Math.sqrt(disc)) / n / (255 * 255);
    let dx = gx, dy = gy;
    if (!(det > 1e-7)) return { dx, dy, minEig, rms: Infinity };

    let rms = Infinity;
    for (let it = 0; it < Math.max(1, o.iters | 0); it++) {
      let bx = 0, by = 0, ss = 0;
      k = 0;
      for (let j = -hw; j <= hw; j++) {
        for (let i = -hw; i <= hw; i++, k++) {
          const dI = I0[k] - sample(next, px + dx + i, py + dy + j);
          bx += dI * Ix[k]; by += dI * Iy[k]; ss += dI * dI;
        }
      }
      rms = Math.sqrt(ss / n);
      const ux = (Gyy * bx - Gxy * by) / det;
      const uy = (Gxx * by - Gxy * bx) / det;
      dx += ux; dy += uy;
      if (ux * ux + uy * uy < o.eps * o.eps) break;
    }
    return { dx, dy, minEig, rms };
  }

  /**
   * Track points from one frame to the next, coarse to fine.
   *
   * `pts` are pixel positions in the PREVIOUS frame, at full analysis resolution. What
   * comes back is the position in the next frame plus a confidence, and the two are
   * independent answers: a point can be found precisely in a window with no texture
   * (high precision, low confidence), and a well-textured window can go behind something
   * (the residual rises, and the confidence says so).
   */
  function trackPoints(prevPyr, nextPyr, pts, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const levels = Math.min(prevPyr.length, nextPyr.length);
    return pts.map((p) => {
      let gx = 0, gy = 0, minEig = 0, rms = 0;
      for (let l = levels - 1; l >= 0; l--) {
        const s = 1 / (1 << l);
        const r = lkLevel(prevPyr[l], nextPyr[l], p.x * s, p.y * s, gx, gy, o);
        gx = r.dx; gy = r.dy; minEig = r.minEig; rms = r.rms;
        if (l > 0) { gx *= 2; gy *= 2; }
      }
      /*
       * TEXTURE AND FIT ARE DIFFERENT QUESTIONS, AND CONFIDENCE IS ONLY THE SECOND ONE.
       *
       * They were multiplied together once, and the result was a tracker that reported
       * "lost" on footage it was following perfectly. Texture - the window's Shi-Tomasi
       * score - asks "is there anything here worth anchoring to", and most of a real UI
       * is soft: antialiased text, a gentle gradient, a button with one crisp edge. Those
       * score modestly and track beautifully, so folding texture into a per-frame
       * confidence marked every one of them lost while the point sat exactly where it
       * belonged.
       *
       * Texture is a property of the POINT and is asked ONCE, when the tracker is
       * anchored - `textureAt()` below, which is what the panel warns from and what
       * `bestFeatureNear()` searches with. Confidence is a property of each FRAME and is
       * the fit: does this window still look like the one we anchored on. That is exactly
       * the question occlusion makes fail, which is what confidence is for.
       *
       * The one thing texture still does here is act as a FLOOR. A perfectly flat window
       * matches everywhere, so its residual is tiny and its fit is excellent and utterly
       * meaningless - it would report high confidence while sliding anywhere at all. Below
       * `minTex` there is no information, so the answer is zero rather than a good-looking
       * number, and `smoke-track.js` asserts exactly that on a flat interior.
       */
      const tex = clamp(minEig / o.minEig, 0, 1);
      const fit = clamp(1 - rms / Math.max(1, o.resid), 0, 1);
      const x = p.x + gx, y = p.y + gy;
      const inFrame = x >= 0 && y >= 0 && x <= prevPyr[0].w - 1 && y <= prevPyr[0].h - 1;
      const usable = isFinite(x) && isFinite(y) && inFrame && tex >= o.minTex;
      return { x, y, tex, fit, c: usable ? fit : 0 };
    });
  }

  /**
   * How much there is to track at a point: 0 (a flat wall) to 1 (a hard corner).
   *
   * Measured on ONE frame against itself, so it is a property of the picture rather than
   * of any motion. The scale is calibrated against soft corners rather than hard ones,
   * because real interface footage is made of soft corners: a 40-level, 4-pixel-soft
   * corner - an ordinary button edge - scores about 0.11 and tracks perfectly, while a
   * flat wall scores 0.000 and a field of ±7-level dither scores about 0.012. That is
   * why `minTex` sits at 0.03 and not somewhere that sounds more confident: everything
   * above it is genuinely trackable, and the panel warns separately about the weak end
   * of that range. This is the number the panel shows before a solve and the number a
   * refusal quotes, because "there is nothing at that point to follow" is a question that
   * can be answered the instant the tracker is dropped - long before a solve has spent a
   * seek per frame proving it the expensive way.
   */
  function textureAt(pyr, x, y, opts) {
    return trackPoints(pyr, pyr, [{ x, y }], opts)[0].tex;
  }

  /**
   * The strongest feature within `radius` of a point, or the point itself.
   *
   * What turns "click roughly on the button" into a tracker that works. A person aims at
   * the middle of a thing; the middle of a thing is usually its flattest part, and its
   * corners - a few pixels away - are what an optical flow can actually hold on to. So a
   * drop snaps to the best point nearby rather than demanding the author understand why
   * the centre of a button is the worst place to put a tracker.
   *
   * Coarse-to-fine over a small grid: exhaustive at this radius is a few hundred window
   * scores, which is under a millisecond and happens once per drop.
   */
  function bestFeatureNear(pyr, x, y, radius, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const r = Math.max(0, num(radius, 0));
    let best = { x, y, tex: textureAt(pyr, x, y, o) };
    if (!(r > 0)) return best;
    // A COARSE PASS OVER THE DISC, then refinement around the winner only. The refinement
    // must not re-scan the whole disc at a finer step - that is quadratic in the radius
    // and cost 444 ms at r=30, which is a visible stall on a click. Scanning a fixed
    // ~9x9 grid however wide the disc is, then narrowing twice, is a couple of hundred
    // window scores whatever the radius.
    const scan = (cx, cy, reach, step) => {
      for (let dy = -reach; dy <= reach; dy += step) {
        for (let dx = -reach; dx <= reach; dx += step) {
          const px = clamp(Math.round(cx + dx), 0, pyr[0].w - 1);
          const py = clamp(Math.round(cy + dy), 0, pyr[0].h - 1);
          if ((px - x) * (px - x) + (py - y) * (py - y) > r * r) continue;   // outside the disc
          const tex = textureAt(pyr, px, py, o);
          // Ties go to the point nearer where the author actually aimed.
          if (tex > best.tex + 1e-6) best = { x: px, y: py, tex };
        }
      }
    };
    let step = Math.max(1, Math.round(r / 4));
    scan(x, y, r, step);
    while (step > 1) {
      const next = Math.max(1, Math.floor(step / 2));
      scan(best.x, best.y, step, next);
      step = next;
    }
    return best;
  }

  /**
   * One step of a solve, in the coordinates the DATA uses.
   *
   * The worker holds the previous pyramid and the point it is carrying; this is the rule
   * that turns a flow answer into a sample: below `minConf` the point is HELD at its last
   * good position and the low confidence is recorded. Occlusion therefore costs a flat
   * stretch on the timeline and a visible dip, never a teleport.
   *
   * Pure and frame-size agnostic, so the suite can drive it with synthetic pyramids.
   */
  function stepPoint(prevPyr, nextPyr, held, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const r = trackPoints(prevPyr, nextPyr, [{ x: held.x, y: held.y }], o)[0];
    if (!(r.c >= o.minConf)) return { x: held.x, y: held.y, c: r.c, held: true };
    return { x: r.x, y: r.y, c: r.c, held: false };
  }

  // ------------------------------------------------------------- the data model

  let seq = 0;
  const uid = () => 'tk' + Date.now().toString(36) + (seq++).toString(36);

  /** A fresh, empty track anchored at a source time and a source-fraction point. */
  function makeTrack(t, x, y, o) {
    const opt = Object.assign({}, DEFAULTS, o || {});
    return {
      id: uid(),
      name: (o && o.name) ? String(o.name) : 'Track',
      res: Math.round(opt.res), rate: Math.round(opt.rate), win: Math.round(opt.win),
      // The anchor's texture score, as measured when it was dropped. A plain number on
      // plain JSON, so the panel can say how good the point is without decoding a frame
      // every time it rebuilds, and `solved` stays the one thing that says whether a
      // solve has happened yet.
      tex: (o && isFinite(Number(o.tex))) ? r5(o.tex) : null,
      anchor: { t: r4(t), x: r5(x), y: r5(y) },
      points: [{ t: r4(t), x: r5(x), y: r5(y), c: 1 }],
    };
  }

  const hasTracks = (clip) => !!(clip && Array.isArray(clip.tracks) && clip.tracks.length);

  /**
   * Has this track been solved, or is it still just a marker somebody dropped?
   *
   * A fresh tracker holds exactly one sample - its anchor - and that distinction drives
   * the whole flow: an unsolved tracker is dragged freely, and a solved one re-solves
   * forward when it is dragged, because then there is solved work in front of it to
   * replace. The panel reads it too, for Solve versus Re-solve.
   */
  const isSolved = (track) => !!(track && Array.isArray(track.points) && track.points.length > 1);

  function trackById(clip, id) {
    if (!hasTracks(clip)) return null;
    return clip.tracks.find((t) => t && t.id === id) || null;
  }

  /**
   * Fill a clip's tracks in and drop anything malformed. Absent stays absent, and an
   * empty array is deleted - a project that tracked nothing serialises exactly as it did
   * before this existed, which is the rule `clip.fx` and `clip.keys` already live by.
   */
  function normalizeClip(clip) {
    if (!clip || !Array.isArray(clip.tracks)) return;
    clip.tracks = clip.tracks
      .filter((t) => t && Array.isArray(t.points) && t.points.length)
      .map((t) => {
        if (!t.id) t.id = uid();
        t.name = String(t.name || 'Track');
        t.res = Math.round(num(t.res, DEFAULTS.res));
        t.rate = Math.round(num(t.rate, DEFAULTS.rate));
        t.points = t.points
          .filter((p) => p && isFinite(Number(p.t)) && isFinite(Number(p.x)) && isFinite(Number(p.y)))
          .map((p) => {
            const q = { t: r4(p.t), x: r5(p.x), y: r5(p.y), c: clamp(num(p.c, 1), 0, 1) };
            // `fix` marks a sample a PERSON is responsible for: 1 interpolated across a
            // lost span at their request, 2 placed by hand. Absent on a solved sample, so
            // an untouched track serialises exactly as it did before repair existed.
            if (p.fix === 1 || p.fix === 2) q.fix = p.fix;
            return q;
          })
          .sort((a, b) => a.t - b.t);
        const a = t.anchor || t.points[0];
        t.anchor = { t: r4(a.t), x: r5(a.x), y: r5(a.y) };
        t.tex = isFinite(Number(t.tex)) ? r5(t.tex) : null;
        return t;
      })
      .filter((t) => t.points.length);
    if (!clip.tracks.length) delete clip.tracks;
  }

  /**
   * Where a track is at a SOURCE time - linearly between its samples, held at both ends.
   *
   * Confidence takes the LOWER of the two neighbours rather than interpolating it. A
   * value halfway between a good sample and a lost one is not a half-good position; it is
   * a position one of whose ends is wrong, and the caller has to know that.
   */
  function sampleAt(track, t) {
    if (!track || !Array.isArray(track.points) || !track.points.length) return null;
    const p = track.points;
    const tt = num(t, 0);
    if (tt <= p[0].t) return { x: p[0].x, y: p[0].y, c: clamp(num(p[0].c, 1), 0, 1) };
    const last = p[p.length - 1];
    if (tt >= last.t) return { x: last.x, y: last.y, c: clamp(num(last.c, 1), 0, 1) };
    let lo = 0, hi = p.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].t <= tt) lo = m; else hi = m; }
    const a = p[lo], b = p[hi];
    const span = b.t - a.t;
    const f = span > 1e-9 ? (tt - a.t) / span : 0;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      c: Math.min(clamp(num(a.c, 1), 0, 1), clamp(num(b.c, 1), 0, 1)),
    };
  }

  /** A named track's position on a clip at a source time, or null. */
  function positionAt(clip, id, t) {
    return sampleAt(trackById(clip, id), t);
  }

  /**
   * Re-anchoring: the solved past is kept, the solved future is thrown away.
   *
   * Dragging the tracker onto the right pixel on frame 200 is a statement about frame 200
   * and everything after it. Frames 0-199 were solved either from the original anchor or
   * from a correction the author was already happy with, and re-solving them would undo
   * work that was right - which is the behaviour that makes people stop correcting tracks
   * and start re-tracking from scratch. So this truncates at `t` and hands back the track
   * for the solver to fill FORWARD of it.
   */
  function reanchorAt(track, t, x, y) {
    if (!track) return null;
    const tt = r4(t);
    track.points = (track.points || []).filter((p) => p.t < tt - 1e-6);
    track.points.push({ t: tt, x: r5(x), y: r5(y), c: 1 });
    track.points.sort((a, b) => a.t - b.t);
    track.anchor = { t: tt, x: r5(x), y: r5(y) };
    return track;
  }

  /** Merge a solved run in, replacing samples at the same times. Keeps `points` sorted. */
  function mergePoints(track, pts) {
    if (!track || !Array.isArray(pts) || !pts.length) return track;
    const by = new Map();
    for (const p of track.points || []) by.set(r4(p.t), p);
    for (const p of pts) {
      by.set(r4(p.t), { t: r4(p.t), x: r5(p.x), y: r5(p.y), c: clamp(num(p.c, 1), 0, 1) });
    }
    track.points = Array.from(by.values()).sort((a, b) => a.t - b.t);
    return track;
  }

  /** The lowest confidence anywhere in a source-time span - what the lane strip draws. */
  function worstIn(track, from, to) {
    if (!track || !track.points || !track.points.length) return 1;
    let worst = 1;
    for (const p of track.points) {
      if (p.t < from - 1e-6 || p.t > to + 1e-6) continue;
      // A REPAIRED sample is not a hole any more. The solver failed there and a person
      // answered for it, so it stops counting against the track - otherwise a fully
      // repaired track would still report itself broken and the warning would be noise.
      // The lane still draws repairs in their own colour, so "the machine failed here"
      // remains visible; it is just no longer an alarm.
      const c = p.fix ? 1 : clamp(num(p.c, 1), 0, 1);
      if (c < worst) worst = c;
    }
    return worst;
  }

  /**
   * The runs of samples the solver could not hold - the red on the lane.
   *
   * `edge` marks a run with no confident sample on one side: a track that was already
   * lost when the clip started, or never recovered before it ended. Those cannot be
   * bridged, because bridging needs something to bridge BETWEEN, and the honest repair
   * for one is to re-anchor there and solve again. Saying which kind a span is, is the
   * difference between a repair button that works and one that silently does nothing.
   */
  function lostSpans(track, minConf) {
    const lo = num(minConf, DEFAULTS.minConf);
    const pts = (track && track.points) || [];
    const bad = (p) => !p.fix && clamp(num(p.c, 1), 0, 1) < lo;
    const out = [];
    let i = 0;
    while (i < pts.length) {
      if (!bad(pts[i])) { i++; continue; }
      let j = i;
      while (j + 1 < pts.length && bad(pts[j + 1])) j++;
      const before = i > 0 ? pts[i - 1] : null;
      const after = j + 1 < pts.length ? pts[j + 1] : null;
      out.push({
        i0: i, i1: j, t0: pts[i].t, t1: pts[j].t, n: j - i + 1,
        edge: !before ? 'lead' : (!after ? 'trail' : null),
      });
      i = j + 1;
    }
    return out;
  }

  /**
   * Repair the lost spans that CAN be repaired: interpolate across them.
   *
   * The solver held the point still through a lost span, which is the right thing for it
   * to do with no information - but a held point is visibly wrong when the thing it was
   * following kept moving, and it is the jump out the far side that reads worst. A person
   * looking at the two confident ends can see that the object travelled between them, and
   * a straight line between those ends is very nearly always closer to the truth than a
   * frozen point. So this fills the run in, marks every sample it touched `fix: 1`, and
   * leaves the confidence numbers underneath alone.
   *
   * Interior spans only. An edge span has nothing to interpolate towards, and guessing
   * off the end of the data is how a repair becomes a lie. Those are reported instead.
   */
  function repairSpans(track, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const spans = lostSpans(track, o.minConf);
    const pts = track.points;
    let bridged = 0, edges = 0;
    for (const sp of spans) {
      if (sp.edge) { edges++; continue; }
      const a = pts[sp.i0 - 1], b = pts[sp.i1 + 1];
      const span = b.t - a.t;
      for (let k = sp.i0; k <= sp.i1; k++) {
        const f = span > 1e-9 ? (pts[k].t - a.t) / span : 0;
        pts[k].x = r5(a.x + (b.x - a.x) * f);
        pts[k].y = r5(a.y + (b.y - a.y) * f);
        pts[k].fix = 1;
      }
      bridged++;
    }
    return { bridged, edges, spans: spans.length };
  }

  /**
   * Put one sample where a person says it belongs, and re-bridge around it.
   *
   * The difference from `reanchorAt()` is everything that happens NEXT, and it is why
   * both exist. Re-anchoring says "the solve is wrong from here on" and throws the future
   * away to be solved again. A fix point says "the solve is wrong just here" and keeps
   * every solved sample on both sides - which is what you want in the middle of a long
   * track with one bad stretch, where re-solving the remaining minute to correct six
   * frames is a bad trade.
   */
  function fixPointAt(track, t, x, y, opts) {
    if (!track) return null;
    const o = Object.assign({}, DEFAULTS, opts || {});
    const tt = r4(t);
    const pts = track.points || (track.points = []);
    const rate = Math.max(1, num(track.rate, DEFAULTS.rate));
    // Replace the sample nearest `t` when there is one within half a sample period, so a
    // fix lands ON the grid rather than wedging an off-grid sample between two others.
    let best = -1, bestD = (0.5 / rate) + 1e-6;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].t - tt);
      if (d <= bestD) { bestD = d; best = i; }
    }
    const sample = { t: best >= 0 ? pts[best].t : tt, x: r5(x), y: r5(y), c: 1, fix: 2 };
    if (best >= 0) pts[best] = sample;
    else { pts.push(sample); pts.sort((a, b) => a.t - b.t); }
    // Only the runs this fix now bounds are repaired; the rest of the track is untouched.
    repairSpans(track, o);
    return sample;
  }

  /** Every sample a person is answerable for, which is what the panel counts. */
  function fixCount(track) {
    return ((track && track.points) || []).filter((p) => p.fix).length;
  }

  // ----------------------------------------------------------------- the binding

  /**
   * SOURCE fractions to FRAME fractions, through the clip's own pan/zoom framing.
   *
   * A track is measured against the file, so it has to go through the crop to become a
   * place on the finished 9:16 picture - exactly the conversion `Cursor.mapper()` does
   * for screen telemetry, and it reuses that crop rather than keeping a second copy of
   * the framing maths. Without `Cursor` (a bare module load) it falls back inline, so the
   * suite can check this file on its own.
   */
  function frameMap(clip, aspect) {
    const A = Math.max(0.01, num(aspect, 9 / 16));
    const C = (typeof Cursor !== 'undefined' && Cursor) ||
      (typeof self !== 'undefined' && self.Cursor) || null;
    let crop;
    if (C && C.mapper) crop = C.mapper(clip, A, 1).crop;
    else {
      const c = clip || {};
      const sw = num(c.srcW, 0) || A, sh = num(c.srcH, 0) || 1;
      const zoom = Math.max(0.01, num(c.zoom, 1));
      const cw = Math.min(sw, sh * A) / zoom, ch = Math.min(sh, sw / A) / zoom;
      crop = {
        x: (sw - cw) * clamp(num(c.panX, 0.5), 0, 1) / sw,
        y: (sh - ch) * clamp(num(c.panY, 0.5), 0, 1) / sh,
        w: cw / sw, h: ch / sh,
      };
    }
    const fn = (x, y) => ({
      x: (num(x, 0) - crop.x) / Math.max(1e-9, crop.w),
      y: (num(y, 0) - crop.y) / Math.max(1e-9, crop.h),
    });
    fn.crop = crop;
    return fn;
  }

  /**
   * A binding resolved: where the bound thing should sit, as a fraction of the FRAME.
   *
   * `bind = { track, offX, offY }` and nothing else. `tSource` is source seconds, the
   * axis the track lives on; the caller converts from clip-local time, because the clip
   * is the only thing that knows its own `in`.
   *
   * The OFFSET IS NOT APPLIED HERE. What comes back is where the tracked pixel is, and
   * nothing else. An offset means something different to each consumer - to a spotlight
   * it moves the lit shape, to a bound `transform` it moves the whole picture the other
   * way - so applying it here would have to pick one of those and be wrong for the rest.
   * `FX.DEFS[type].bind.apply()` takes the offset and knows which space it is in.
   *
   * A binding to a track this clip does not carry answers `null`, and every caller then
   * draws its static parameters instead. That is the same degradation contract the
   * telemetry effects keep: a clip whose track was deleted, or that was carried into
   * another project without one, keeps working and stops following.
   */
  /**
   * A track's position at `t`, averaged over a window of `smooth` seconds.
   *
   * Averaged over TIME rather than over samples, the same rule `Cursor`'s smoothing
   * follows and for the same reason: the samples are on a fixed grid here, but a repaired
   * or hand-fixed span is not, so weighting by sample count would smooth the repaired
   * stretches differently from the solved ones.
   */
  function smoothedAt(track, t, smooth) {
    const w = Math.max(0, num(smooth, 0));
    if (!(w > 1e-4)) return sampleAt(track, t);
    const rate = Math.max(1, num(track && track.rate, DEFAULTS.rate));
    const step = 1 / rate;
    const n = Math.max(1, Math.round(w / step));
    let sx = 0, sy = 0, sc = 1, k = 0;
    for (let i = -n; i <= n; i++) {
      const s = sampleAt(track, t + i * step);
      if (!s) continue;
      sx += s.x; sy += s.y; k++;
      if (s.c < sc) sc = s.c;
    }
    return k ? { x: sx / k, y: sy / k, c: sc } : sampleAt(track, t);
  }

  /**
   * A binding resolved: where the bound thing should sit, as a fraction of the FRAME.
   *
   *   bind = { track, clip, offX, offY, strength, smooth, keys }
   *
   * `tSource` is source seconds on the clip that OWNS the track, and `tKeys` is the bound
   * effect's own clip-local time - the axis `Anim` keys live on. They are the same number
   * for a same-clip binding and different ones when the track lives on another clip, so
   * they are separate arguments rather than one that means two things.
   *
   * STRENGTH IS WHY THIS TAKES KEYS AT ALL. A track is a measurement of the thing it was
   * put on, and a bound effect moving exactly with it is often more movement than the shot
   * wants - the tracked element crosses half the frame and the callout chasing it reads as
   * frantic. `strength` scales the movement AWAY FROM THE ANCHOR: 1 follows exactly, 0.4
   * follows at 40% of the distance travelled, 0 pins it where it started. Because it is
   * keyframable, it can be 1 through the part of the shot that needs to track and 0.3
   * through the part that only needs to drift.
   *
   * The reference is the track's own ANCHOR - the pixel the author put the tracker on -
   * so damping pulls toward a point they chose rather than toward the middle of the frame.
   */
  function bindPos(clip, bind, tSource, aspect, tKeys) {
    if (!bind || !bind.track) return null;
    const track = trackById(clip, bind.track);
    if (!track) return null;
    const tk = num(tKeys, num(tSource, 0) - num((clip || {}).in, 0));
    // `Anim` is a plain global here, exactly as it is in fx.js - but this file is also
    // loaded as a module by the suite and inside the worker, where it does not exist. A
    // bare identifier would throw rather than be undefined, so the lookup is guarded.
    const A = (typeof Anim !== 'undefined' && Anim) ||
      (typeof self !== 'undefined' && self.Anim) || null;
    const anim = (key, fallback) => {
      const v = (A && A.valueAt) ? A.valueAt(bind, key, tk, fallback) : fallback;
      return isFinite(Number(v)) ? Number(v) : fallback;
    };
    const s = smoothedAt(track, tSource, anim('smooth', num(bind.smooth, 0)));
    if (!s) return null;
    const strength = clamp(anim('strength', num(bind.strength, 1)), -4, 4);
    const a = track.anchor || s;
    const m = frameMap(clip, aspect);
    // Damped in SOURCE space, before the framing map. The map is affine, so damping either
    // side of it is the same picture - and doing it here means `strength` means "a
    // fraction of how far the tracked thing actually moved", which is what it says.
    const dx = a.x + (s.x - a.x) * strength, dy = a.y + (s.y - a.y) * strength;
    const p = m(dx, dy);
    /*
     * THE OFFSETS COME BACK RATHER THAN BEING APPLIED, and that is not fussiness.
     *
     * An offset means something different to each kind of binding: to a spotlight it
     * moves the lit shape, and to a bound `transform` - which is a camera - it moves the
     * FRAME, so adding it to the tracked point would move the picture the other way. They
     * were briefly applied here, and `smoke-track.js` caught exactly that inversion.
     * So the animated values are handed back and `DEFS[type].bind.apply()` puts them
     * wherever they belong for that type.
     */
    // The ANCHOR, mapped the same way, comes back too. A binding that MOVES something
    // needs the distance the tracked point has travelled since it was anchored, not its
    // absolute position - the author placed the thing where they wanted it and the track
    // is there to carry it, not to teleport it onto the tracked pixel.
    const ap = m(a.x, a.y);
    /*
     * THE DAMPED POINT IN SOURCE FRACTIONS COMES BACK TOO - `sx`/`sy`, with the anchor as
     * `asx`/`asy` - and it is not a duplicate of `x`/`y`.
     *
     * `x`/`y` are the point AFTER the crop, which is the only answer a consumer that
     * draws into the finished frame can use. A consumer that moves the CROP ITSELF cannot
     * use it: the crop is what the map is made of, so reading a position through it to
     * decide where to put it is circular. The transform's `crop` mode is exactly that
     * consumer, and it works in these instead - the axis the samples were measured on.
     */
    return {
      x: p.x, y: p.y, c: s.c,
      ax: ap.x, ay: ap.y,
      sx: dx, sy: dy, asx: a.x, asy: a.y,
      offX: anim('offX', num(bind.offX, 0)),
      offY: anim('offY', num(bind.offY, 0)),
    };
  }

  /**
   * What a bound effect's pixels depend on, for the render cache key.
   *
   * The samples themselves, reduced: a count, the span, and a checksum of the numbers.
   * The clip's timeline POSITION is not in it and must never be - a bound effect draws
   * the same pixels wherever the clip sits, exactly like every other effect. Same shape
   * and same reason as `mouseDigest()` in app.js.
   */
  function digest(clip, id) {
    const t = trackById(clip, id);
    if (!t || !t.points.length) return undefined;
    let sum = 0;
    for (const p of t.points) sum = (sum + p.t * 7919 + p.x * 104729 + p.y * 15485863 + p.c) % 1e9;
    return {
      n: t.points.length,
      t0: t.points[0].t, t1: t.points[t.points.length - 1].t,
      s: Math.round(sum * 1e3) / 1e3,
    };
  }

  /**
   * The disk cache key for a solve, which is why a solved clip opens already solved.
   *
   * Everything that changes the ANSWER: the range, the anchor and the solver's settings,
   * over a file the main process keys by path + size + mtime the way it keys waveforms.
   * Not the clip's id, not its position, not its name - the same file tracked from the
   * same pixel gives the same track in every project that holds it.
   */
  function cacheKey(spec) {
    const s = spec || {};
    return [
      'v1', r4(s.t0), r4(s.t1), r5(s.ax), r5(s.ay), r4(s.anchorT),
      Math.round(num(s.res, DEFAULTS.res)), Math.round(num(s.rate, DEFAULTS.rate)),
      Math.round(num(s.win, DEFAULTS.win)), Math.round(num(s.levels, DEFAULTS.levels)),
    ].join(':');
  }

  const API = {
    DEFAULTS,
    gray, buildPyramid, trackPoints, stepPoint, sample,
    makeTrack, normalizeClip, hasTracks, trackById,
    sampleAt, positionAt, reanchorAt, mergePoints, worstIn, isSolved,
    textureAt, bestFeatureNear,
    lostSpans, repairSpans, fixPointAt, fixCount, smoothedAt,
    frameMap, bindPos, digest, cacheKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.Tracker = API;
  else if (typeof self !== 'undefined') self.Tracker = API;
})();
