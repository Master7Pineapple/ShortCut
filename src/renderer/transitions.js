'use strict';
/**
 * Transitions between two adjacent clips.
 *
 * Like text cards, a transition is drawn on canvas and the SAME function serves both the
 * preview and the exporter - `draw()` is handed the outgoing and incoming frames as
 * images and paints the blended result. The exporter bakes the whole transition window
 * into one opaque full-frame layer and overlays it; it never asks ffmpeg to blend, so
 * anything canvas can do (real blur, a burn threshold, a moving PNG) is available and the
 * MP4 matches the preview exactly.
 *
 * Nothing in here touches the DOM beyond creating scratch canvases and <img> elements.
 */
const Trans = (() => {

  const TYPES = {
    swipe: { label: 'Blurred swipe' },
    burn: { label: 'Film burn' },
    object: { label: 'Object (PNG)' },
  };

  /**
   * Which way the blurred swipe smears and stretches the picture.
   *
   * `auto` follows the wipe direction - a left/right swipe smears sideways, an up/down
   * one smears vertically and a zoom smears radially - which is what makes the deform
   * read as part of the movement rather than an effect laid over it.
   */
  const DEFORM_AXES = [
    { value: 'auto', label: 'Follow the direction' },
    { value: 'x', label: 'Left and right' },
    { value: 'y', label: 'Up and down' },
    { value: 'both', label: 'Both (diagonal)' },
    { value: 'radial', label: 'Radial (in and out)' },
  ];

  const DIRECTIONS = [
    { value: 'left', label: 'Left to right' },
    { value: 'right', label: 'Right to left' },
    { value: 'up', label: 'Top to bottom' },
    { value: 'down', label: 'Bottom to top' },
    { value: 'zoomIn', label: 'Zoom in (from centre)' },
    { value: 'zoomOut', label: 'Zoom out (from edges)' },
  ];

  function defaults(type) {
    const base = {
      id: 't' + Math.random().toString(36).slice(2, 9),
      type: type || 'swipe',
      duration: 0.5,
      align: 'center',                 // center | before | after (relative to the cut)
      easing: { kind: 'bezier', p: [0.42, 0, 0.58, 1] },
      motionBlur: { on: false, strength: 0.7, samples: 8 },
      params: {},
    };
    if (base.type === 'swipe') {
      base.params = {
        direction: 'left', softness: 0.22, blur: 26,
        // The swipe does not only blur: it smears and stretches the picture along an
        // axis while it swaps, the way a whip pan does. `deform` is how far the smear
        // travels, `stretch` how much the plate is squashed and pulled along the axis.
        deform: 0.5, stretch: 0.28, deformAxis: 'auto', deformSamples: 12,
      };
    } else if (base.type === 'burn') {
      base.params = {
        direction: 'left', angle: 30, edge: 0.55, color: '#ff7a1a', hot: '#fffaf0',
        glow: 1, flash: 0.85, peakAt: 0.4, seed: Math.floor(Math.random() * 10000),
      };
    } else {
      base.params = {
        src: null, direction: 'left', scale: 1, rotate: 0,
        switchAt: 0.5, travel: 1.35, spin: 0, opacity: 1,
        offsetX: 0, offsetY: 0, fadeIn: 0, fadeOut: 0,
      };
      base.motionBlur = { on: true, strength: 0.9, samples: 10 };
    }
    return base;
  }

  /**
   * Fill in anything a transition is missing for its CURRENT type.
   *
   * Changing the type in the inspector keeps `params` - which is what the user wants when
   * they flip back and forth, since each type's settings survive the round trip - but it
   * leaves the incoming type's own parameters absent. Every control then reads `undefined`
   * and renders blank, and the draw path silently falls back to a default the panel is not
   * showing. The same happens to a project saved before a parameter existed. Filling the
   * gaps from the type's defaults fixes both, and never overwrites a value that is there.
   */
  function normalize(tr) {
    if (!tr) return tr;
    const d = defaults(tr.type);
    if (!tr.params || typeof tr.params !== 'object') tr.params = {};
    for (const k of Object.keys(d.params)) {
      if (tr.params[k] === undefined) tr.params[k] = d.params[k];
    }
    if (!tr.easing) tr.easing = d.easing;
    if (!tr.motionBlur) tr.motionBlur = d.motionBlur;
    if (tr.align == null) tr.align = d.align;
    if (tr.duration == null) tr.duration = d.duration;
    return tr;
  }

  /** The timeline window a transition covers, given the cut it sits on. */
  function windowOf(tr, cut) {
    const d = Math.max(0.02, tr.duration || 0.5);
    if (tr.align === 'before') return { from: cut - d, to: cut, cut, dur: d };
    if (tr.align === 'after') return { from: cut, to: cut + d, cut, dur: d };
    return { from: cut - d / 2, to: cut + d / 2, cut, dur: d };
  }

  // ----------------------------------------------------------- scratch canvases

  const scratch = {};
  function surface(name, w, h) {
    let c = scratch[name];
    if (!c) c = scratch[name] = document.createElement('canvas');
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  // -------------------------------------------------------------- image assets

  const images = new Map();   // path -> { img, ok }

  /** Load a PNG for an object transition. Resolves even on failure, with ok:false. */
  function loadImage(src) {
    if (!src) return Promise.resolve(null);
    const hit = images.get(src);
    if (hit && hit.promise) return hit.promise;
    const img = new Image();
    const entry = { img, ok: false };
    entry.promise = new Promise((resolve) => {
      img.onload = () => { entry.ok = true; resolve(entry); };
      img.onerror = () => { entry.ok = false; resolve(entry); };
      img.src = 'file:///' + String(src).replace(/\\/g, '/').replace(/^\/+/, '');
    });
    images.set(src, entry);
    return entry.promise;
  }

  /** Synchronous lookup for the draw path; null until loadImage has resolved. */
  function imageFor(src) {
    const e = images.get(src);
    return e && e.ok ? e.img : null;
  }

  // -------------------------------------------------------- seeded randomness

  /**
   * Everything textured in here is seeded rather than random: the preview and the bake
   * generate their textures independently, and an unseeded one would make them disagree -
   * the export would burn in a different shape from the one that was previewed.
   */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------- masks

  /**
   * Paint a reveal mask into `c`: white where the incoming clip should show.
   * `soft` is the feather width as a fraction of the frame.
   */
  const OPAQUE = 'rgba(255,255,255,1)';
  const CLEAR = 'rgba(255,255,255,0)';

  function paintWipeMask(c, W, H, direction, e, soft) {
    c.clearRect(0, 0, W, H);
    const s = Math.max(0.001, soft);

    if (direction === 'zoomIn' || direction === 'zoomOut') {
      const cx = W / 2, cy = H / 2;
      const maxR = Math.hypot(cx, cy) * (1 + s * 2);
      const inward = direction === 'zoomIn';
      // Grow a disc from the centre, or close one in from the corners.
      const r = Math.max(0.01, (inward ? e : 1 - e) * maxR);
      const inner = Math.max(0, r - maxR * s);
      const g = c.createRadialGradient(cx, cy, inner, cx, cy, Math.max(inner + 1, r));
      g.addColorStop(0, inward ? OPAQUE : CLEAR);
      g.addColorStop(1, inward ? CLEAR : OPAQUE);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      return;
    }

    // A linear edge that travels far enough to clear the feather at both ends.
    const horizontal = direction === 'left' || direction === 'right';
    const span = horizontal ? W : H;
    const feather = Math.max(1, span * s);
    const pos = -feather + e * (span + feather * 2);
    const from = pos - feather, to = pos + feather;
    let g;
    if (direction === 'left') g = c.createLinearGradient(from, 0, to, 0);
    else if (direction === 'right') g = c.createLinearGradient(W - from, 0, W - to, 0);
    else if (direction === 'up') g = c.createLinearGradient(0, from, 0, to);
    else g = c.createLinearGradient(0, H - from, 0, H - to);
    g.addColorStop(0, OPAQUE);
    g.addColorStop(1, CLEAR);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }

  /** Keep only the parts of `layer` where `mask` is white, then stamp it onto ctx. */
  function stampMasked(ctx, layer, layerCtx, mask, W, H) {
    layerCtx.save();
    layerCtx.globalCompositeOperation = 'destination-in';
    layerCtx.drawImage(mask, 0, 0, W, H);
    layerCtx.restore();
    ctx.drawImage(layer, 0, 0, W, H);
  }

  // ------------------------------------------------------------ the transitions

  /** Which axis a swipe's deform runs along: `auto` takes it from the wipe direction. */
  function deformAxisOf(params) {
    const ax = params.deformAxis || 'auto';
    if (ax !== 'auto') return ax;
    const d = params.direction || 'left';
    if (d === 'zoomIn' || d === 'zoomOut') return 'radial';
    return (d === 'up' || d === 'down') ? 'y' : 'x';
  }

  function drawSwipe(ctx, W, H, tr, e) {
    const p = tr.params || {};
    const soft = p.softness == null ? 0.22 : p.softness;
    // Everything the swipe does peaks halfway through and falls back to nothing at both
    // ends, so the frames either side of the window are the untouched clips.
    const peak = Math.sin(Math.PI * Math.max(0, Math.min(1, e)));
    const blurPx = num(p.blur, 26) * peak;
    const scale = H / 1920;
    const filter = blurPx > 0.2 ? 'blur(' + (blurPx * scale).toFixed(2) + 'px)' : 'none';

    // The deform: the picture does not merely go soft, it is dragged and stretched along
    // an axis the way a whip pan smears a frame. A gaussian blur alone is symmetric and
    // reads as "out of focus"; smearing the plate across a distance and squashing it as
    // it goes is what reads as movement.
    //
    // It is real directional sampling, not a filter: the padded plate is drawn `samples`
    // times, each copy offset along the axis and scaled a little differently, and the
    // copies are averaged. The offsets run symmetrically about zero (u in -0.5..0.5) so
    // the picture smears in place instead of sliding off its own centre.
    const axis = deformAxisOf(p);
    const dfm = Math.max(0, num(p.deform, 0.5)) * peak;
    const str = Math.max(0, Math.min(0.5, num(p.stretch, 0.28))) * peak;
    const active = dfm > 0.002 || str > 0.002;
    const samples = active ? Math.max(2, Math.min(32, Math.round(num(p.deformSamples, 12)))) : 1;
    const span = Math.max(W, H);
    // A deform of 1 spreads the smear over a quarter of the frame - far enough to read
    // clearly, near enough that the padding can still cover the edges it drags in.
    const reach = dfm * span * 0.25;

    // The blur (and now the smear) needs real colour to sample past the frame edge or it
    // fades the border out into transparency. Drawing the picture OVERSIZED to cover that
    // was the original fix and it was the wrong one: growing the destination rect
    // magnifies the picture, by ~15% at the default blur and far more further up the
    // slider, and because the blur peaks mid-transition the magnification peaks with it.
    // Every swipe therefore zoomed in and back out, whichever direction it was set to -
    // loud enough to read as "it only zooms", with the wipe underneath it lost.
    //
    // So: pad the plate by extending its edge pixels outwards, smear and blur THAT at
    // 1:1, and crop the middle back out. The effect gets its colour, the picture keeps
    // its scale.
    const grow = Math.max(1, Math.min(
      Math.ceil(span * 0.5),
      Math.ceil(blurPx * scale * 3 + reach * 0.6 + span * 0.55 * str)
    ));
    const dimsOf = (im) => [
      im.videoWidth || im.naturalWidth || im.width || W,
      im.videoHeight || im.naturalHeight || im.height || H,
    ];

    /** The frame with its edge pixels extended outwards by `g` on every side. */
    const padPlate = (img, g, PW, PH) => {
      const [iw, ih] = dimsOf(img);
      if (!iw || !ih) return null;
      const pad = surface('blurPad', PW, PH);
      const pc = pad.getContext('2d');
      pc.setTransform(1, 0, 0, 1, 0, 0);
      pc.globalCompositeOperation = 'source-over';
      pc.globalAlpha = 1;
      pc.clearRect(0, 0, PW, PH);
      pc.filter = 'none';
      pc.drawImage(img, 0, 0, iw, ih, g, g, W, H);                    // the picture, 1:1
      pc.drawImage(img, 0, 0, 1, ih, 0, g, g, H);                     // left edge
      pc.drawImage(img, iw - 1, 0, 1, ih, g + W, g, g, H);            // right edge
      pc.drawImage(img, 0, 0, iw, 1, g, 0, W, g);                     // top edge
      pc.drawImage(img, 0, ih - 1, iw, 1, g, g + H, W, g);            // bottom edge
      pc.drawImage(img, 0, 0, 1, 1, 0, 0, g, g);                      // corners
      pc.drawImage(img, iw - 1, 0, 1, 1, g + W, 0, g, g);
      pc.drawImage(img, 0, ih - 1, 1, 1, 0, g + H, g, g);
      pc.drawImage(img, iw - 1, ih - 1, 1, 1, g + W, g + H, g, g);
      return pad;
    };

    /**
     * Average `samples` offset-and-stretched copies of the plate.
     *
     * The averaging is additive - each copy goes on with `lighter` at 1/samples - for the
     * same reason the text cards' motion blur is: compositing them source-over at 1/n
     * converges to ~63% opacity and visibly washes the picture out.
     */
    const smearPlate = (pad, PW, PH) => {
      if (samples < 2) return pad;
      const acc = surface('smearAcc', PW, PH);
      const ac = acc.getContext('2d');
      ac.setTransform(1, 0, 0, 1, 0, 0);
      ac.globalCompositeOperation = 'source-over';
      ac.globalAlpha = 1;
      ac.filter = 'none';
      ac.clearRect(0, 0, PW, PH);
      ac.globalCompositeOperation = 'lighter';
      ac.globalAlpha = 1 / samples;
      const cx = PW / 2, cy = PH / 2;
      for (let i = 0; i < samples; i++) {
        const u = samples === 1 ? 0 : (i / (samples - 1)) - 0.5;
        let dx = 0, dy = 0, sx = 1, sy = 1;
        if (axis === 'x') { dx = u * reach; sx = 1 + u * str * 2; }
        else if (axis === 'y') { dy = u * reach; sy = 1 + u * str * 2; }
        else if (axis === 'both') {
          dx = u * reach * 0.7071; dy = u * reach * 0.7071;
          sx = 1 + u * str * 2; sy = 1 + u * str * 2;
        } else {
          // Radial: the offset has nowhere to go, so it feeds the scale instead and the
          // plate breathes in and out about the centre.
          const s = 1 + u * (str * 2 + dfm * 0.5);
          sx = s; sy = s;
        }
        ac.setTransform(sx, 0, 0, sy, cx - cx * sx + dx, cy - cy * sy + dy);
        ac.drawImage(pad, 0, 0);
      }
      ac.setTransform(1, 0, 0, 1, 0, 0);
      ac.globalCompositeOperation = 'source-over';
      ac.globalAlpha = 1;
      return acc;
    };

    const drawBlurred = (target, img) => {
      if (blurPx <= 0.2 && !active) { target.drawImage(img, 0, 0, W, H); return; }
      const g = grow, PW = W + g * 2, PH = H + g * 2;
      const pad = padPlate(img, g, PW, PH);
      if (!pad) return;
      const smeared = smearPlate(pad, PW, PH);

      // Blur the padded plate whole, THEN crop - cropping first would just move the
      // transparent edge inwards and undo the padding.
      const blurred = surface('blurOut', PW, PH);
      const bc = blurred.getContext('2d');
      bc.setTransform(1, 0, 0, 1, 0, 0);
      bc.globalCompositeOperation = 'source-over';
      bc.globalAlpha = 1;
      bc.clearRect(0, 0, PW, PH);
      bc.save();
      bc.filter = filter;
      bc.drawImage(smeared, 0, 0);
      bc.restore();

      target.drawImage(blurred, g, g, W, H, 0, 0, W, H);
    };

    const a = ctx.__aImg, b = ctx.__bImg;
    if (a) drawBlurred(ctx, a);
    if (!b) return;

    const layer = surface('layer', W, H);
    const lctx = layer.getContext('2d');
    lctx.clearRect(0, 0, W, H);
    drawBlurred(lctx, b);

    const mask = surface('mask', W, H);
    paintWipeMask(mask.getContext('2d'), W, H, tr.params.direction || 'left', e, soft);
    stampMasked(ctx, layer, lctx, mask, W, H);
  }

  /**
   * How bright the leak is at eased progress `e`. Fast attack, a single peak, a longer
   * decay - measured off real film-burn footage, where the frame ramps to white in about
   * a quarter of the effect and takes twice as long to fall back to black.
   */
  function leakEnvelope(e, peakAt) {
    const P = Math.max(0.05, Math.min(0.95, num(peakAt, 0.4)));
    if (e <= P) {
      const s = e / P;
      return s * s * (3 - 2 * s);           // smoothstep in
    }
    const s = (e - P) / (1 - P);
    return Math.pow(Math.max(0, 1 - s), 2.2); // slower ember decay out
  }

  /**
   * The leak's colour at local level `L`. Black through deep red, the ember colour, gold,
   * and finally the hot core - the ramp a real light leak walks as it blooms.
   */
  function leakColor(L, color, hot) {
    const c = rgbOf(color, [255, 122, 26]);
    const h = rgbOf(hot, [255, 250, 240]);
    const gold = [
      Math.round(c[0] * 0.45 + h[0] * 0.55),
      Math.round(c[1] * 0.45 + h[1] * 0.55),
      Math.round(c[2] * 0.45 + h[2] * 0.55),
    ];
    const stops = [
      [0.00, [0, 0, 0], 0],
      [0.14, [30, 3, 0], 0.35],
      [0.32, [130, 11, 0], 0.85],
      [0.52, c, 1],
      [0.74, gold, 1],
      [1.00, h, 1],
    ];
    const t = Math.max(0, Math.min(1, num(L, 0)));
    for (let i = 1; i < stops.length; i++) {
      if (t > stops[i][0] && i < stops.length - 1) continue;
      const [t0, c0, a0] = stops[i - 1], [t1, c1, a1] = stops[i];
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const m = (j) => Math.round(c0[j] + (c1[j] - c0[j]) * k);
      return 'rgba(' + m(0) + ',' + m(1) + ',' + m(2) + ',' + (a0 + (a1 - a0) * k).toFixed(3) + ')';
    }
    return 'rgba(0,0,0,0)';
  }

  /**
   * A finite number, or the fallback.
   *
   * Every number the burn takes ends up in a canvas gradient, and canvas is unforgiving:
   * a non-finite coordinate makes `createLinearGradient` throw, and a NaN that reaches a
   * colour string makes `addColorStop` throw on `rgba(NaN,NaN,NaN,NaN)`. Either one used
   * to kill the frame loop outright, so nothing here may take a number on trust.
   */
  function num(v, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function rgbOf(hex, fallback) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /**
   * Seeded striations - the wavy streaks a light leak picks up crossing the film. Built
   * small at a fixed aspect and scaled up, for the same reason the burn map is: the
   * preview and the export must produce the same texture at different resolutions.
   */
  const streakMaps = new Map();
  function streakMap(seed) {
    const key = String(seed);
    const hit = streakMaps.get(key);
    if (hit) return hit;
    const w = 160, h = 90;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    const rnd = mulberry32((seed || 1) * 7 + 13);
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9; i++) {
      const y = rnd() * h;
      const thick = (0.02 + rnd() * 0.09) * h;
      const g = c.createLinearGradient(0, y - thick, 0, y + thick);
      const v = 0.25 + rnd() * 0.75;
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,' + v.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      // A slight wave, so the streaks are not dead-straight bars.
      c.save();
      c.translate(w / 2, y);
      c.rotate((rnd() - 0.5) * 0.12);
      c.translate(-w / 2, -y);
      c.fillRect(0, y - thick, w, thick * 2);
      c.restore();
    }
    streakMaps.set(key, cv);
    return cv;
  }

  /** The sweep axis, in radians, for a directional leak. */
  function leakAngle(direction, angle) {
    const base = { left: 0, right: 180, up: 90, down: 270 }[direction];
    if (base == null) return null;
    return (base + num(angle, 0)) * Math.PI / 180;
  }

  /**
   * Paint the leak itself into `c`: a broad band of heat sweeping across the frame,
   * whose whole ramp brightens with `v` until the frame washes out.
   */
  function paintLeak(c, W, H, tr, v, e, peakAt) {
    const p = tr.params;
    c.clearRect(0, 0, W, H);
    if (v <= 0.0005) return;

    // The leak is a BAND THAT TRAVELS. It enters by one side, sweeps across, and leaves
    // by the far side - it never folds back the way it came. Driving its position from
    // the envelope (which rises then falls) was what made it retreat: the band has to be
    // driven by PROGRESS, which only ever goes forwards, and the envelope left to do the
    // one job it is good for - how hot the leak is.
    const edge = Math.max(0, Math.min(1, num(p.edge, 0.55)));
    const bw = 1.6 + edge * 1.6;          // band width, in frames
    const f = 0.25 + edge * 0.6;          // its soft edges
    // The band centre crosses the middle of the frame exactly at the peak, then keeps
    // going. The two halves run at different speeds, which is what gives the leak its
    // quick arrival and slower departure.
    const P = Math.max(0.02, Math.min(0.98, num(peakAt, 0.4)));
    const cpos = e <= P
      ? -bw / 2 + (e / P) * (0.5 + bw / 2)
      : 0.5 + ((e - P) / (1 - P)) * (0.5 + bw / 2);
    const lead = cpos + bw / 2, trail = cpos - bw / 2;
    // Amplitude is curved so the ember colours, which sit in the middle of the ramp, get
    // most of the window rather than being rushed through on the way to white.
    const amp = Math.pow(Math.max(0, num(v, 0)), 0.6);
    const level = (s) => amp * Math.min(
      Math.max(0, Math.min(1, (lead - s) / f)),
      Math.max(0, Math.min(1, (s - trail) / f)));

    const dir = p.direction || 'left';
    const ang = leakAngle(dir, p.angle);
    const N = 18;
    let g;
    if (ang == null) {
      const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
      g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
      for (let i = 0; i <= N; i++) {
        const o = i / N;
        // zoomOut blooms from the edges inwards, so its ramp runs the other way.
        g.addColorStop(o, leakColor(level(dir === 'zoomOut' ? 1 - o : o), p.color, p.hot));
      }
    } else {
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const half = (Math.abs(ux) * W + Math.abs(uy) * H) / 2;
      const cx = W / 2, cy = H / 2;
      g = c.createLinearGradient(cx - ux * half, cy - uy * half, cx + ux * half, cy + uy * half);
      for (let i = 0; i <= N; i++) g.addColorStop(i / N, leakColor(level(i / N), p.color, p.hot));
    }
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    // Striations, keyed to the same axis as the sweep and kept inside the leak.
    c.save();
    c.globalCompositeOperation = 'source-atop';
    c.globalAlpha = Math.max(0, Math.min(1, 0.18 * num(v, 0)));
    c.translate(W / 2, H / 2);
    if (ang != null) c.rotate(ang);
    const span = Math.hypot(W, H);
    c.drawImage(streakMap(Math.round(num(p.seed, 1))), -span / 2, -span / 2, span, span);
    c.restore();
  }

  /**
   * A film burn: the two clips cut under a warm light leak that blooms across the frame
   * and washes it out, then falls back through ember colour to nothing. The cut itself is
   * a short cross-fade parked at the peak, where the frame is brightest and it cannot be
   * seen - which is exactly how the effect works on real film.
   */
  function drawBurn(ctx, W, H, tr, e) {
    const a = ctx.__aImg, b = ctx.__bImg;
    const p = tr.params;
    const peakAt = num(p.peakAt, num(p.switchAt, 0.4));
    const v = leakEnvelope(e, peakAt);

    // The clips swap across a short window centred on the peak.
    const fadeHalf = 0.07;
    const mixIn = Math.max(0, Math.min(1, (e - (peakAt - fadeHalf)) / (fadeHalf * 2)));
    if (a) ctx.drawImage(a, 0, 0, W, H);
    if (b && mixIn > 0) {
      ctx.save();
      ctx.globalAlpha = a ? mixIn : 1;
      ctx.drawImage(b, 0, 0, W, H);
      ctx.restore();
    }

    // The leak, added over the picture the way light hitting the film would be.
    const glow = Math.max(0, num(p.glow, 1));
    if (glow > 0 && v > 0.0005) {
      const leak = surface('leak', W, H);
      paintLeak(leak.getContext('2d'), W, H, tr, v, e, peakAt);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.max(0, Math.min(1, glow));
      ctx.drawImage(leak, 0, 0, W, H);
      // A strong leak is stamped twice rather than clipped at alpha 1.
      if (glow > 1) { ctx.globalAlpha = Math.min(1, glow - 1); ctx.drawImage(leak, 0, 0, W, H); }
      ctx.restore();
    }

    // The bloom at the peak: what actually hides the cut.
    const flash = Math.max(0, Math.min(1, num(p.flash, 0.85)));
    if (flash > 0 && v > 0.0005) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, flash * Math.pow(v, 4)));
      ctx.fillStyle = p.hot || '#fffaf0';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  /** Where the object sits at eased progress `e`, in frame coordinates. */
  function objectPlacement(tr, W, H, e) {
    const p = tr.params;
    const dir = p.direction || 'left';
    const travel = p.travel == null ? 1.35 : p.travel;
    const out = { x: W / 2, y: H / 2, scale: p.scale == null ? 1 : p.scale, rot: (p.rotate || 0) };
    const k = (e - 0.5) * 2;                       // -1 .. 1 across the transition
    if (dir === 'left') out.x = W / 2 + k * travel * W;
    else if (dir === 'right') out.x = W / 2 - k * travel * W;
    else if (dir === 'up') out.y = H / 2 + k * travel * H;
    else if (dir === 'down') out.y = H / 2 - k * travel * H;
    else if (dir === 'zoomIn') out.scale *= Math.max(0.001, 0.02 + Math.abs(k) * 0);
    else if (dir === 'zoomOut') out.scale *= 1;
    if (dir === 'zoomIn') out.scale = (p.scale == null ? 1 : p.scale) * (1 - Math.abs(k)) * 3.2 + 0.001;
    if (dir === 'zoomOut') out.scale = (p.scale == null ? 1 : p.scale) * Math.abs(k) * 3.2 + 0.001;
    out.rot += (p.spin || 0) * k;
    // Where the whole path sits in the frame, as a fraction of it. Applied after the
    // travel so it shifts the object without changing how far it moves.
    out.x += (p.offsetX || 0) * W;
    out.y += (p.offsetY || 0) * H;
    return out;
  }

  /** The object's own fade, in and out across its travel. 1 when neither is set. */
  function objectFade(p, e) {
    let a = 1;
    const fi = p.fadeIn || 0, fo = p.fadeOut || 0;
    if (fi > 0) a *= Math.max(0, Math.min(1, e / fi));
    if (fo > 0) a *= Math.max(0, Math.min(1, (1 - e) / fo));
    return a;
  }

  function paintObject(ctx, W, H, tr, e) {
    const img = imageFor(tr.params.src);
    if (!img) return;
    const pl = objectPlacement(tr, W, H, e);
    if (objectFade(tr.params, e) <= 0.001) return;
    if (pl.scale <= 0.0005) return;
    // The PNG is sized against the frame width so it behaves the same at any resolution.
    const w = img.naturalWidth * (W / img.naturalWidth) * pl.scale;
    const h = img.naturalHeight * (W / img.naturalWidth) * pl.scale;
    ctx.save();
    ctx.globalAlpha = (tr.params.opacity == null ? 1 : tr.params.opacity) *
      objectFade(tr.params, e);
    ctx.translate(pl.x, pl.y);
    if (pl.rot) ctx.rotate(pl.rot * Math.PI / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawObject(ctx, W, H, tr, e, frameDur, rawP) {
    const a = ctx.__aImg, b = ctx.__bImg;
    // The cut happens while the object covers the frame.
    const switchAt = tr.params.switchAt == null ? 0.5 : tr.params.switchAt;
    const under = (rawP < switchAt ? a : b) || a || b;
    if (under) ctx.drawImage(under, 0, 0, W, H);

    const mb = tr.motionBlur || {};
    if (!mb.on || !frameDur) { paintObject(ctx, W, H, tr, e); return; }

    // Same temporal sampling as text cards: draw the object at several instants across
    // the shutter and average them additively.
    const samples = Math.max(2, Math.min(32, Math.round(mb.samples || 8)));
    const shutter = frameDur * Math.max(0, Math.min(2, mb.strength || 0));
    const dur = Math.max(0.001, tr.duration);
    let t0 = rawP - (shutter / dur) / 2, t1 = rawP + (shutter / dur) / 2;
    if (t0 < 0) { t0 = 0; t1 = Math.min(1, shutter / dur); }
    if (t1 > 1) { t1 = 1; t0 = Math.max(0, 1 - shutter / dur); }

    const sample = surface('objSample', W, H);
    const sctx = sample.getContext('2d');
    const accum = surface('objAccum', W, H);
    const actx = accum.getContext('2d');
    actx.clearRect(0, 0, W, H);
    actx.save();
    actx.globalCompositeOperation = 'lighter';
    actx.globalAlpha = 1 / samples;
    for (let i = 0; i < samples; i++) {
      const q = t0 + (i / (samples - 1)) * (t1 - t0);
      sctx.clearRect(0, 0, W, H);
      paintObject(sctx, W, H, tr, TextModel.ease(tr.easing, q));
      actx.drawImage(sample, 0, 0);
    }
    actx.restore();
    ctx.drawImage(accum, 0, 0);
  }

  /**
   * Paint one frame of a transition.
   *
   * `aImg` and `bImg` are the already-framed outgoing and incoming frames (any canvas
   * drawable). `p` is raw progress 0..1 through the window; the easing curve is applied
   * here so callers do not have to.
   */
  function draw(ctx, W, H, tr, p, aImg, bImg, frameDur) {
    const raw = Math.max(0, Math.min(1, p));
    const e = TextModel.ease(tr.easing, raw);
    ctx.save();
    // If one side has no decodable frame, stand the other in for it. A transition with a
    // missing half must look like the clip that IS there, never like a black frame - at
    // the very edges of the window that is exactly the right picture anyway.
    ctx.__aImg = aImg || bImg || null;
    ctx.__bImg = bImg || aImg || null;
    if (tr.type === 'burn') drawBurn(ctx, W, H, tr, e);
    else if (tr.type === 'object') drawObject(ctx, W, H, tr, e, frameDur, raw);
    else drawSwipe(ctx, W, H, tr, e);
    ctx.__aImg = null;
    ctx.__bImg = null;
    ctx.restore();
  }

  /**
   * A transition preset is everything about the LOOK - never which cut it sits on.
   * `aId`/`bId`/`id` are properties of this particular join, so applying a preset must
   * not carry another transition's clip ids along with it.
   */
  function extractPreset(tr) {
    return {
      kind: 'trans',
      type: tr.type,
      duration: tr.duration,
      align: tr.align,
      easing: JSON.parse(JSON.stringify(tr.easing)),
      motionBlur: JSON.parse(JSON.stringify(tr.motionBlur)),
      params: JSON.parse(JSON.stringify(tr.params)),
    };
  }

  /** Merge a preset into a transition, in place, keeping it attached to its own cut. */
  function applyPreset(tr, preset, opts) {
    if (!preset) return tr;
    const keepLength = opts && opts.keepLength;
    if (preset.type) tr.type = preset.type;
    if (preset.align) tr.align = preset.align;
    if (preset.duration != null && !keepLength) tr.duration = preset.duration;
    if (preset.easing) tr.easing = JSON.parse(JSON.stringify(preset.easing));
    if (preset.motionBlur) tr.motionBlur = JSON.parse(JSON.stringify(preset.motionBlur));
    if (preset.params) {
      // Start from the type's defaults so a preset saved before a parameter existed still
      // produces a complete, drawable transition.
      tr.params = Object.assign(defaults(tr.type).params, JSON.parse(JSON.stringify(preset.params)));
    }
    return tr;
  }

  return {
    TYPES, DIRECTIONS, DEFORM_AXES, deformAxisOf, defaults, windowOf, extractPreset, applyPreset,
    loadImage, imageFor, draw, objectPlacement,
    paintWipeMask, leakEnvelope, streakMap, normalize, objectFade,
  };
})();
