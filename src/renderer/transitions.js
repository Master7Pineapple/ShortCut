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
    shape: { label: 'Shape wipe' },
    luma: { label: 'Luma / gradient wipe' },
    slide: { label: 'Slide' },
    scale: { label: 'Scale' },
    morph: { label: 'Morph (cards)' },
    punch: { label: 'Zoom punch' },
  };

  /**
   * The shapes a shape wipe can be cut with.
   *
   * Vector paths and canvas primitives, never bitmaps - for the same reason step 10's
   * chrome presets are vectors: the preview cuts at 540x960 and the export at 1080x1920,
   * and a bitmap mask would be soft in one of them. `svg` takes path data imported from a
   * file, which is also how a step 13 graphic's icon gets here: `Graphics.svgPaths()`
   * produces the same `{d, viewBox}` pair from either source, so there is one code path.
   */
  const SHAPES = [
    { value: 'circle', label: 'Circle' },
    { value: 'square', label: 'Square' },
    { value: 'roundRect', label: 'Rounded rectangle' },
    { value: 'diamond', label: 'Diamond' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'star', label: 'Star' },
    { value: 'chevron', label: 'Chevron' },
    { value: 'svg', label: 'Imported SVG' },
  ];

  /** How a luma wipe's threshold map is built. All seeded, never random. */
  const LUMA_MAPS = [
    { value: 'linear', label: 'Linear gradient' },
    { value: 'radial', label: 'Radial' },
    { value: 'bands', label: 'Bands' },
    { value: 'clouds', label: 'Clouds' },
  ];

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
    } else if (base.type === 'shape') {
      base.params = {
        shape: 'circle', d: '', viewBox: '0 0 24 24', name: '',
        x: 0.5, y: 0.5, rotate: 0, spin: 0, feather: 0.02, invert: false, cover: 1.15,
      };
    } else if (base.type === 'luma') {
      base.params = {
        map: 'linear', direction: 'left', angle: 0, softness: 0.3,
        bands: 6, seed: Math.floor(Math.random() * 10000), invert: false,
      };
    } else if (base.type === 'slide') {
      base.params = { direction: 'left', push: true, gap: 0, blur: 0 };
    } else if (base.type === 'scale') {
      base.params = { from: 0.72, to: 1.18, fade: 1, blur: 6, anchorX: 0.5, anchorY: 0.5 };
    } else if (base.type === 'morph') {
      base.params = { auto: true, blur: 10, fade: 1, rotate: 0 };
      base.easing = { kind: 'bezier', p: [0.16, 1, 0.3, 1] };
    } else if (base.type === 'punch') {
      base.params = { amount: 1.5, focusX: 0.5, focusY: 0.5, switchAt: 0.5, blur: 10, hold: 0.35 };
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
     * Through `Anim.temporalAverage`, like every other motion blur in the app: it groups
     * the samples instead of scaling each one by 1/samples, so the plate's soft padded
     * edges survive the averaging rather than being quantised away.
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
      const cx = PW / 2, cy = PH / 2;
      Anim.temporalAverage(ac, PW, PH, samples, (sc, i) => {
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
        sc.setTransform(sx, 0, 0, sy, cx - cx * sx + dx, cy - cy * sy + dy);
        sc.drawImage(pad, 0, 0);
      }, surface, 'smear');
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

    // Same temporal sampling as text cards, through the same `Anim.temporalAverage`:
    // draw the object at several instants across the shutter and average them. An
    // object PNG's soft edges and any glow baked into it are exactly the faint pixels a
    // naive 1/samples accumulation destroys.
    const samples = Math.max(2, Math.min(32, Math.round(mb.samples || 8)));
    const shutter = frameDur * Math.max(0, Math.min(2, mb.strength || 0));
    const dur = Math.max(0.001, tr.duration);
    let t0 = rawP - (shutter / dur) / 2, t1 = rawP + (shutter / dur) / 2;
    if (t0 < 0) { t0 = 0; t1 = Math.min(1, shutter / dur); }
    if (t1 > 1) { t1 = 1; t0 = Math.max(0, 1 - shutter / dur); }

    Anim.temporalAverage(ctx, W, H, samples, (sctx, i) => {
      const q = t0 + (i / (samples - 1)) * (t1 - t0);
      paintObject(sctx, W, H, tr, TextModel.ease(tr.easing, q));
    }, surface, 'obj');
  }

  /**
   * Paint one frame of a transition.
   *
   * `aImg` and `bImg` are the already-framed outgoing and incoming frames (any canvas
   * drawable). `p` is raw progress 0..1 through the window; the easing curve is applied
   * here so callers do not have to.
   */
  function draw(ctx, W, H, tr, p, aImg, bImg, frameDur, boxes) {
    const raw = Math.max(0, Math.min(1, p));
    const e = TextModel.ease(tr.easing, raw);
    ctx.save();
    // The morph's two painted boxes, in normalised frame coordinates. Optional, and
    // handed in the same way the frames are so preview and bake share one source.
    ctx.__aBox = (boxes && boxes.a) || null;
    ctx.__bBox = (boxes && boxes.b) || null;
    // If one side has no decodable frame, stand the other in for it. A transition with a
    // missing half must look like the clip that IS there, never like a black frame - at
    // the very edges of the window that is exactly the right picture anyway.
    ctx.__aImg = aImg || bImg || null;
    ctx.__bImg = bImg || aImg || null;
    if (tr.type === 'burn') drawBurn(ctx, W, H, tr, e);
    else if (tr.type === 'object') drawObject(ctx, W, H, tr, e, frameDur, raw);
    else if (tr.type === 'shape') drawShape(ctx, W, H, tr, e);
    else if (tr.type === 'luma') drawLuma(ctx, W, H, tr, e);
    else if (tr.type === 'slide') drawSlide(ctx, W, H, tr, e);
    else if (tr.type === 'scale') drawScale(ctx, W, H, tr, e);
    else if (tr.type === 'morph') drawMorph(ctx, W, H, tr, e);
    else if (tr.type === 'punch') drawPunch(ctx, W, H, tr, e, raw);
    else drawSwipe(ctx, W, H, tr, e);
    ctx.__aImg = null;
    ctx.__bImg = null;
    ctx.__aBox = null;
    ctx.__bBox = null;
    ctx.restore();
  }

  // =========================================================== the B2B vocabulary
  //
  // Six more types, all built out of the two things the first three already established:
  // a mask painted on the ALPHA channel, and a plate padded by edge extension before it
  // is blurred or moved. Both traps are load-bearing and both have been paid for once:
  //
  //   - A mask composites on alpha, so a mask painted as opaque black-and-white masks
  //     nothing. Paint rgba(255,255,255,1) -> rgba(255,255,255,0).
  //   - A blur must not magnify. Pad the plate by extending its edge pixels, blur or move
  //     THAT at 1:1, then crop the middle back out - never draw oversized to hide the
  //     transparent border, which zooms the picture by the blur radius.

  /** The frame with its edge pixels extended outwards by `g` on every side. */
  function padded(img, g, W, H, name) {
    const iw = img.videoWidth || img.naturalWidth || img.width || W;
    const ih = img.videoHeight || img.naturalHeight || img.height || H;
    if (!iw || !ih) return null;
    const PW = W + g * 2, PH = H + g * 2;
    const cv = surface(name || 'pad2', PW, PH);
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, PW, PH);
    c.drawImage(img, 0, 0, iw, ih, g, g, W, H);
    if (g > 0) {
      c.drawImage(img, 0, 0, 1, ih, 0, g, g, H);
      c.drawImage(img, iw - 1, 0, 1, ih, g + W, g, g, H);
      c.drawImage(img, 0, 0, iw, 1, g, 0, W, g);
      c.drawImage(img, 0, ih - 1, iw, 1, g, g + H, W, g);
      c.drawImage(img, 0, 0, 1, 1, 0, 0, g, g);
      c.drawImage(img, iw - 1, 0, 1, 1, g + W, 0, g, g);
      c.drawImage(img, 0, ih - 1, 1, 1, 0, g + H, g, g);
      c.drawImage(img, iw - 1, ih - 1, 1, 1, g + W, g + H, g, g);
    }
    return cv;
  }

  /**
   * One frame, blurred without being magnified and returned at exactly WxH.
   *
   * `blurPx` is quoted at 1920 tall and scaled to the frame, the way the swipe's is, so a
   * setting means the same thing in the 540-tall preview and the 1920-tall export.
   */
  function softPlate(img, W, H, blurPx, name) {
    const scale = H / 1920;
    const px = Math.max(0, num(blurPx, 0)) * scale;
    const out = surface((name || 'soft') + 'Out', W, H);
    const oc = out.getContext('2d');
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.globalCompositeOperation = 'source-over';
    oc.globalAlpha = 1;
    oc.filter = 'none';
    oc.clearRect(0, 0, W, H);
    if (px <= 0.2) { oc.drawImage(img, 0, 0, W, H); return out; }
    const g = Math.max(1, Math.ceil(px * 3));
    const pad = padded(img, g, W, H, (name || 'soft') + 'Pad');
    if (!pad) { oc.drawImage(img, 0, 0, W, H); return out; }
    const blurred = surface((name || 'soft') + 'Blur', W + g * 2, H + g * 2);
    const bc = blurred.getContext('2d');
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalCompositeOperation = 'source-over';
    bc.globalAlpha = 1;
    bc.clearRect(0, 0, W + g * 2, H + g * 2);
    bc.save();
    bc.filter = 'blur(' + px.toFixed(2) + 'px)';
    bc.drawImage(pad, 0, 0);
    bc.restore();
    oc.drawImage(blurred, g, g, W, H, 0, 0, W, H);
    return out;
  }

  /** Draw `img` scaled about a normalised anchor and offset, at alpha. Never magnifies a blur. */
  function drawPlate(ctx, img, W, H, o) {
    const s = Math.max(0.0001, o.scale == null ? 1 : o.scale);
    const ax = (o.anchorX == null ? 0.5 : o.anchorX) * W;
    const ay = (o.anchorY == null ? 0.5 : o.anchorY) * H;
    const src = o.blur ? softPlate(img, W, H, o.blur, o.name) : img;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, o.alpha == null ? 1 : o.alpha));
    ctx.translate(ax + (o.dx || 0), ay + (o.dy || 0));
    if (o.rot) ctx.rotate(o.rot * Math.PI / 180);
    ctx.scale(s, s);
    ctx.translate(-ax, -ay);
    ctx.drawImage(src, 0, 0, W, H);
    ctx.restore();
  }

  // --------------------------------------------------------------- shape wipe

  const shapePaths = new Map();
  function shapePath2D(d) {
    const key = String(d || '');
    if (!key) return null;
    if (shapePaths.has(key)) return shapePaths.get(key);
    let p = null;
    try { p = typeof Path2D === 'function' ? new Path2D(key) : null; } catch (e) { p = null; }
    shapePaths.set(key, p);
    return p;
  }

  /**
   * Paint the shape at radius `R` (pixels, half-extent) into the mask context.
   *
   * Every shape is drawn about the origin at half-extent 1 and scaled, so `cover` means
   * the same thing for all of them: how far past the frame's own half-diagonal the shape
   * has to grow before the incoming clip fully covers the outgoing one.
   */
  function paintShape(c, shape, R, params) {
    c.beginPath();
    if (shape === 'circle') { c.arc(0, 0, R, 0, Math.PI * 2); c.fill(); return; }
    if (shape === 'square') { c.fillRect(-R, -R, R * 2, R * 2); return; }
    if (shape === 'roundRect') {
      const r = Math.min(R, R * 0.28);
      c.moveTo(-R + r, -R);
      c.arcTo(R, -R, R, R, r); c.arcTo(R, R, -R, R, r);
      c.arcTo(-R, R, -R, -R, r); c.arcTo(-R, -R, R, -R, r);
      c.closePath(); c.fill(); return;
    }
    if (shape === 'diamond') {
      c.moveTo(0, -R); c.lineTo(R, 0); c.lineTo(0, R); c.lineTo(-R, 0);
      c.closePath(); c.fill(); return;
    }
    if (shape === 'triangle') {
      c.moveTo(0, -R); c.lineTo(R, R); c.lineTo(-R, R);
      c.closePath(); c.fill(); return;
    }
    if (shape === 'chevron') {
      c.moveTo(-R, -R); c.lineTo(0, 0); c.lineTo(-R, R);
      c.lineTo(0, R); c.lineTo(R, 0); c.lineTo(0, -R);
      c.closePath(); c.fill(); return;
    }
    if (shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const r = i % 2 ? R * 0.46 : R;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.closePath(); c.fill(); return;
    }
    // Imported path data, mapped through its viewBox so a 24-unit icon and a 512-unit one
    // reach the same size on the frame - the same rule `Graphics.drawPathData()` lives by.
    const p = shapePath2D(params && params.d);
    if (!p) { c.arc(0, 0, R, 0, Math.PI * 2); c.fill(); return; }
    const vb = (typeof Graphics !== 'undefined' && Graphics.parseViewBox)
      ? Graphics.parseViewBox(params.viewBox) : [0, 0, 24, 24];
    const s = (R * 2) / Math.max(1e-6, Math.max(vb[2], vb[3]));
    c.save();
    c.scale(s, s);
    c.translate(-vb[0] - vb[2] / 2, -vb[1] - vb[3] / 2);
    c.fill(p);
    c.restore();
  }

  function paintShapeMask(c, W, H, p, e) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, W, H);
    const half = Math.hypot(W, H) / 2 * Math.max(0.2, num(p.cover, 1.15));
    const R = Math.max(0.01, e * half);
    const feather = Math.max(0, num(p.feather, 0.02)) * Math.min(W, H);
    c.save();
    if (feather > 0.4) c.filter = 'blur(' + feather.toFixed(2) + 'px)';
    // White with FULL ALPHA: the mask is composited with destination-in, which reads the
    // alpha channel and ignores the colour entirely.
    c.fillStyle = OPAQUE;
    c.strokeStyle = OPAQUE;
    c.translate(num(p.x, 0.5) * W, num(p.y, 0.5) * H);
    const spin = num(p.rotate, 0) + num(p.spin, 0) * e;
    if (spin) c.rotate(spin * Math.PI / 180);
    paintShape(c, p.shape || 'circle', R, p);
    c.restore();
    if (p.invert) {
      // Invert on ALPHA too: fill the frame opaque, then punch the shape back out.
      const cut = surface('shapeCut', W, H);
      const cc = cut.getContext('2d');
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.globalCompositeOperation = 'source-over';
      cc.globalAlpha = 1;
      cc.filter = 'none';
      cc.clearRect(0, 0, W, H);
      cc.fillStyle = OPAQUE;
      cc.fillRect(0, 0, W, H);
      cc.globalCompositeOperation = 'destination-out';
      cc.drawImage(c.canvas, 0, 0);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'copy';
      c.drawImage(cut, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
  }

  function drawShape(ctx, W, H, tr, e) {
    const a = ctx.__aImg, b = ctx.__bImg;
    if (a) ctx.drawImage(a, 0, 0, W, H);
    if (!b) return;
    const layer = surface('layer', W, H);
    const lctx = layer.getContext('2d');
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.filter = 'none';
    lctx.clearRect(0, 0, W, H);
    lctx.drawImage(b, 0, 0, W, H);
    const mask = surface('mask', W, H);
    paintShapeMask(mask.getContext('2d'), W, H, tr.params || {}, e);
    stampMasked(ctx, layer, lctx, mask, W, H);
  }

  // ---------------------------------------------------------------- luma wipe

  /**
   * The luma map a gradient wipe thresholds against, built small and scaled up.
   *
   * Small and SEEDED, for the reason the burn's streaks are: the preview and the export
   * build the texture independently at different resolutions, and a map that depended on
   * either would put the wipe edge in two different places.
   */
  const lumaMaps = new Map();
  function lumaMap(kind, seed, bands, angleDeg) {
    const key = kind + '|' + seed + '|' + bands + '|' + angleDeg;
    const hit = lumaMaps.get(key);
    if (hit) return hit;
    const w = 192, h = 341;                    // a 9:16-ish plate, fixed at every output size
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    const rnd = mulberry32((seed || 1) * 31 + 7);
    if (kind === 'radial') {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    } else if (kind === 'bands') {
      const n = Math.max(1, Math.round(num(bands, 6)));
      c.save();
      c.translate(w / 2, h / 2);
      c.rotate(num(angleDeg, 0) * Math.PI / 180);
      const span = Math.hypot(w, h);
      for (let i = 0; i < n; i++) {
        // Each band ramps 0..1 across itself, so thresholding sweeps them in step.
        const g = c.createLinearGradient(-span / 2, 0, span / 2, 0);
        g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
        c.fillStyle = g;
        c.fillRect(-span / 2, -span / 2 + (i * span) / n, span, span / n);
      }
      c.restore();
    } else if (kind === 'clouds') {
      // Seeded value noise: a handful of soft blobs, averaged by overdraw.
      c.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i++) {
        const x = rnd() * w, y = rnd() * h, r = (0.12 + rnd() * 0.35) * w;
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        const v = (0.35 + rnd() * 0.65).toFixed(3);
        g.addColorStop(0, 'rgba(255,255,255,' + v + ')');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(x - r, y - r, r * 2, r * 2);
      }
      c.globalCompositeOperation = 'source-over';
    } else {
      c.save();
      c.translate(w / 2, h / 2);
      c.rotate(num(angleDeg, 0) * Math.PI / 180);
      const span = Math.hypot(w, h);
      const g = c.createLinearGradient(-span / 2, 0, span / 2, 0);
      g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
      c.fillStyle = g;
      c.fillRect(-span / 2, -span / 2, span, span);
      c.restore();
    }
    lumaMaps.set(key, cv);
    return cv;
  }

  /** Which way a luma wipe's gradient runs, in degrees, from the shared direction list. */
  function lumaAngle(direction, angle) {
    const base = { left: 0, right: 180, up: 90, down: 270 }[direction];
    return (base == null ? 0 : base) + num(angle, 0);
  }

  /**
   * Threshold the luma map into a reveal mask.
   *
   * The threshold is stepped through a soft window, so the edge is a feathered contour of
   * the map rather than a hard one. Built as ALPHA, like every other mask here: the map's
   * luminance selects, and what lands in the mask is white at varying alpha.
   */
  function paintLumaMask(c, W, H, p, e) {
    const kind = p.map || 'linear';
    const src = lumaMap(kind, Math.round(num(p.seed, 1)), num(p.bands, 6),
      kind === 'radial' || kind === 'clouds' ? 0 : lumaAngle(p.direction, p.angle));
    const soft = Math.max(0.01, Math.min(1, num(p.softness, 0.3)));
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, W, H);

    // Scale the threshold window so both ends of the transition fully clear the map.
    const lo = e * (1 + soft) - soft;
    const img = surface('lumaSrc', W, H);
    const ic = img.getContext('2d');
    ic.setTransform(1, 0, 0, 1, 0, 0);
    ic.globalCompositeOperation = 'source-over';
    ic.globalAlpha = 1;
    ic.filter = 'none';
    ic.clearRect(0, 0, W, H);
    ic.drawImage(src, 0, 0, W, H);
    const d = ic.getImageData(0, 0, W, H);
    const px = d.data;
    const inv = !!p.invert;
    for (let i = 0; i < px.length; i += 4) {
      let L = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
      if (inv) L = 1 - L;
      // Alpha ramps from 0 to 255 across the soft window ending at the threshold.
      const a = Math.max(0, Math.min(1, (lo + soft - L) / soft));
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
      px[i + 3] = Math.round(a * 255);
    }
    ic.putImageData(d, 0, 0);
    c.drawImage(img, 0, 0);
  }

  function drawLuma(ctx, W, H, tr, e) {
    const a = ctx.__aImg, b = ctx.__bImg;
    if (a) ctx.drawImage(a, 0, 0, W, H);
    if (!b) return;
    const layer = surface('layer', W, H);
    const lctx = layer.getContext('2d');
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.filter = 'none';
    lctx.clearRect(0, 0, W, H);
    lctx.drawImage(b, 0, 0, W, H);
    const mask = surface('mask', W, H);
    paintLumaMask(mask.getContext('2d'), W, H, tr.params || {}, e);
    stampMasked(ctx, layer, lctx, mask, W, H);
  }

  // ------------------------------------------------------------------- slide

  /** The unit vector a direction travels along. Zooms have none and stand still. */
  function slideVector(direction) {
    if (direction === 'right') return [-1, 0];
    if (direction === 'up') return [0, 1];
    if (direction === 'down') return [0, -1];
    if (direction === 'left') return [1, 0];
    return [0, 0];
  }

  function drawSlide(ctx, W, H, tr, e) {
    const a = ctx.__aImg, b = ctx.__bImg;
    const p = tr.params || {};
    const [ux, uy] = slideVector(p.direction || 'left');
    const gap = Math.max(0, num(p.gap, 0));
    const span = (1 + gap) * (ux ? W : H);
    const blur = num(p.blur, 0) * Math.sin(Math.PI * Math.max(0, Math.min(1, e)));
    // B travels in from off-frame; A either holds still or is pushed out ahead of it.
    if (a) {
      const off = p.push ? -e * span : 0;
      drawPlate(ctx, a, W, H, { dx: ux * off, dy: uy * off, blur, name: 'slideA' });
    }
    if (b) {
      const off = (1 - e) * span;
      drawPlate(ctx, b, W, H, { dx: ux * off, dy: uy * off, blur, name: 'slideB' });
    }
  }

  // ------------------------------------------------------------------- scale

  function drawScale(ctx, W, H, tr, e) {
    const a = ctx.__aImg, b = ctx.__bImg;
    const p = tr.params || {};
    const peak = Math.sin(Math.PI * Math.max(0, Math.min(1, e)));
    const blur = Math.max(0, num(p.blur, 6)) * peak;
    const fade = Math.max(0, Math.min(1, num(p.fade, 1)));
    const from = Math.max(0.05, num(p.from, 0.72));
    const to = Math.max(0.05, num(p.to, 1.18));
    const ax = num(p.anchorX, 0.5), ay = num(p.anchorY, 0.5);
    // A grows away from the viewer, B arrives from behind it. `fade` at 0 makes it a pure
    // scale with a hard swap at the midpoint, which is the match-cut version.
    if (a) {
      drawPlate(ctx, a, W, H, {
        scale: 1 + (to - 1) * e, anchorX: ax, anchorY: ay, blur,
        alpha: fade ? 1 : (e < 0.5 ? 1 : 0), name: 'scaleA',
      });
    }
    if (b) {
      drawPlate(ctx, b, W, H, {
        scale: from + (1 - from) * e, anchorX: ax, anchorY: ay, blur,
        alpha: fade ? Math.min(1, e / Math.max(0.001, fade)) : (e < 0.5 ? 0 : 1), name: 'scaleB',
      });
    }
  }

  // ------------------------------------------------------------------- morph

  /**
   * A morph between two cards: a cross-dissolve that also carries A's shape onto B's.
   *
   * `ctx.__aBox` / `ctx.__bBox` are the painted bounds of the two sides in NORMALISED
   * frame coordinates, handed in by the caller the same way the two frames are. Both the
   * preview and the baker get them from one helper, so the two agree by construction; a
   * side with no bounds (a video clip, an undecoded card) falls back to the whole frame,
   * and the morph degrades into the cross-dissolve it is built on.
   */
  const FULL_BOX = { x: 0, y: 0, w: 1, h: 1 };
  function boxOrFull(b) {
    if (!b || !isFinite(b.w) || !isFinite(b.h) || b.w <= 0 || b.h <= 0) return FULL_BOX;
    return b;
  }

  /** The transform that carries `from` onto `to`, at progress `e`. */
  function morphTransform(from, to, e, W, H) {
    const f = boxOrFull(from), t = boxOrFull(to);
    const sx = 1 + ((t.w / f.w) - 1) * e;
    const sy = 1 + ((t.h / f.h) - 1) * e;
    const s = (sx + sy) / 2;                       // uniform: a squashed card reads as broken
    const fcx = (f.x + f.w / 2), fcy = (f.y + f.h / 2);
    const tcx = (t.x + t.w / 2), tcy = (t.y + t.h / 2);
    return {
      scale: s,
      anchorX: fcx, anchorY: fcy,
      dx: (tcx - fcx) * W * e, dy: (tcy - fcy) * H * e,
    };
  }

  function drawMorph(ctx, W, H, tr, e) {
    const a = ctx.__aImg, b = ctx.__bImg;
    const p = tr.params || {};
    const peak = Math.sin(Math.PI * Math.max(0, Math.min(1, e)));
    const blur = Math.max(0, num(p.blur, 10)) * peak;
    const rot = num(p.rotate, 0);
    const aBox = p.auto === false ? FULL_BOX : boxOrFull(ctx.__aBox);
    const bBox = p.auto === false ? FULL_BOX : boxOrFull(ctx.__bBox);
    const fade = Math.max(0.001, Math.min(1, num(p.fade, 1)));
    if (a) {
      const m = morphTransform(aBox, bBox, e, W, H);
      drawPlate(ctx, a, W, H, Object.assign({}, m, {
        blur, rot: rot * e, alpha: Math.max(0, 1 - e / fade), name: 'morphA',
      }));
    }
    if (b) {
      // B runs the same transform backwards: it starts wearing A's shape and relaxes.
      const m = morphTransform(bBox, aBox, 1 - e, W, H);
      drawPlate(ctx, b, W, H, Object.assign({}, m, {
        blur, rot: -rot * (1 - e), alpha: Math.min(1, e / fade), name: 'morphB',
      }));
    }
  }

  // -------------------------------------------------------------- zoom punch

  /**
   * A zoom punch: both plates rush toward a focus point, the cut happens at the peak
   * where the movement hides it, and the incoming clip settles back.
   *
   * `hold` is how much of the window the punch spends at full zoom - it is what makes the
   * cut read as a deliberate accent rather than as a slow push in and out.
   */
  function punchEnvelope(e, hold) {
    const h = Math.max(0, Math.min(0.9, num(hold, 0.35)));
    const ramp = (1 - h) / 2;
    if (e <= ramp) return e / Math.max(1e-6, ramp);
    if (e >= 1 - ramp) return (1 - e) / Math.max(1e-6, ramp);
    return 1;
  }

  function drawPunch(ctx, W, H, tr, e, rawP) {
    const a = ctx.__aImg, b = ctx.__bImg;
    const p = tr.params || {};
    const v = punchEnvelope(e, p.hold);
    const amount = Math.max(1, num(p.amount, 1.5));
    const scale = 1 + (amount - 1) * v;
    const blur = Math.max(0, num(p.blur, 10)) * v;
    const switchAt = num(p.switchAt, 0.5);
    const under = (rawP < switchAt ? a : b) || a || b;
    if (!under) return;
    drawPlate(ctx, under, W, H, {
      scale, blur,
      anchorX: num(p.focusX, 0.5), anchorY: num(p.focusY, 0.5),
      name: 'punch',
    });
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
    TYPES, DIRECTIONS, DEFORM_AXES, SHAPES, LUMA_MAPS,
    deformAxisOf, defaults, windowOf, extractPreset, applyPreset,
    loadImage, imageFor, draw, objectPlacement,
    paintWipeMask, leakEnvelope, streakMap, normalize, objectFade,
    paintShapeMask, paintLumaMask, lumaMap, slideVector, morphTransform, punchEnvelope,
    padded, softPlate,
  };
})();
