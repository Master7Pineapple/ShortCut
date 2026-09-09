'use strict';
/**
 * The per-clip visual effect stack.
 *
 * A clip's stack lives on `clip.fx` - an ordered array of
 *   { id, type, enabled, params: {...}, keys: {...} }
 * and nothing else. Plain JSON, because undo is `JSON.stringify` of the track list and
 * the same shape is the `.scut` file.
 *
 * WHY THIS FILE IS SHORT, AND WHY IT HAS NO ffmpeg IN IT
 *
 * Before step 6 every visual feature had to be written twice - a canvas draw for the
 * preview and a matching ffmpeg filter for the export - and the two drifted. Step 6 made
 * `compositeLayers()` the single draw path for the picture: the viewer calls it, and the
 * baker calls it at output resolution and streams the result into `frames.raw`. So an
 * effect here is ONE function. There is no filter half, and adding one would be a bug.
 *
 * THE UNIT RULE, which is the whole of preview/render agreement in this file.
 *
 * Every geometric parameter is a FRACTION OF THE FRAME, never a pixel count. The preview
 * paints at 540x960 or smaller and the export at 1080x1920, so a "12 px" corner radius
 * would be twice as round in the viewer as in the file, and a "20 px" blur twice as soft.
 * `pxMin()` converts at draw time against whatever W/H the caller is painting at, so the
 * two resolutions produce the same picture scaled. Anything added here that takes a
 * length must go through it.
 *
 * THE LAYER RULE, carried over from the text cards.
 *
 * Every effect runs inside the clip's OWN offscreen layer, cleared to transparent, and
 * only the finished layer is drawn onto the frame. That is not tidiness: a shadow, a
 * blur or any additive pass composited straight onto the target would pick up whatever
 * is underneath it, so the same effect would behave one way over video and another way
 * over transparency. `render()` below is the only way in, and it enforces this.
 *
 * KEYFRAMES ARE FREE, and they live on the effect.
 *
 * `Anim.trackFor()` / `Anim.valueAt()` only ever touch a `.keys` object, so they work on
 * an effect entry exactly as they work on a clip. Every numeric parameter in `DEFS` is
 * therefore keyframable with no extra work: `paramAt()` reads the animated value and
 * falls back to the static one. Keys are times in SECONDS INTO THE CLIP, the same axis a
 * text card's keys use, so moving a clip moves its animation with it.
 */
(function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, isFinite(Number(v)) ? Number(v) : lo));

  /** A fraction of the frame's shorter side, in pixels at the size being painted. */
  const pxMin = (f, W, H) => (Number(f) || 0) * Math.min(W, H);

  /** Round-rect path built by hand, so it does not depend on a Canvas2D extension. */
  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    if (rr <= 0) { c.rect(x, y, w, h); return; }
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#000000'));
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + clamp(a, 0, 1) + ')';
  }

  // ------------------------------------------------------------------ the layer

  /**
   * A pooled canvas with a known-clean context: no transform, no filter, full alpha,
   * source-over, no shadow. The same contract `Anim.temporalAverage()` uses, for the same
   * reason - a context left with a filter or a shadow on it is the hardest kind of bug to
   * find, because it shows up in the NEXT effect.
   */
  function reset(c) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.shadowColor = 'rgba(0,0,0,0)';
    c.shadowBlur = 0;
    c.shadowOffsetX = 0;
    c.shadowOffsetY = 0;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
  }

  function clean(surface, name, w, h) {
    const cv = surface(name, w, h);
    const c = cv.getContext('2d');
    reset(c);
    c.clearRect(0, 0, w, h);
    return { cv, c };
  }

  /** Copy the layer into a scratch and clear the layer, ready to be repainted from it. */
  function take(L, name) {
    const s = clean(L.surface, name, L.W, L.H);
    s.c.drawImage(L.cv, 0, 0);
    reset(L.c);
    L.c.clearRect(0, 0, L.W, L.H);
    return s.cv;
  }

  // ----------------------------------------------------------------- effect types

  /**
   * Every effect: its label, its defaults, the inspector schema, and its draw.
   * Adding a type is one entry here and nothing else - the panel, the keyframe strips
   * and the serialisation all build themselves from it.
   *
   * `draw(L, p)` mutates the clip's own layer in place. `p` is already the ANIMATED
   * parameter set at time `t`; nothing in here reads `entry.params` directly.
   */
  const DEFS = {
    transform: {
      label: 'Transform',
      params: { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, anchorX: 0.5, anchorY: 0.5 },
      schema: [
        { path: 'params.x', label: 'Offset X', type: 'range', min: -1, max: 1, step: 0.002, digits: 3 },
        { path: 'params.y', label: 'Offset Y', type: 'range', min: -1, max: 1, step: 0.002, digits: 3 },
        { path: 'params.scale', label: 'Scale', type: 'range', min: 0.05, max: 4, step: 0.01, digits: 2 },
        { path: 'params.rotate', label: 'Rotation', type: 'range', min: -180, max: 180, step: 0.5, unit: '°', digits: 1 },
        { path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.anchorX', label: 'Anchor X', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.anchorY', label: 'Anchor Y', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      ],
      // Offsets are fractions of the FRAME, so a move reads the same at every resolution.
      // The anchor is the point scale and rotation turn about - the difference between a
      // card growing out of the middle and one growing out of its own corner.
      draw(L, p) {
        const src = take(L, 'fxA');
        const W = L.W, H = L.H;
        const ax = clamp(p.anchorX, -4, 5) * W, ay = clamp(p.anchorY, -4, 5) * H;
        L.c.save();
        L.c.globalAlpha = clamp(p.opacity, 0, 1);
        L.c.translate(ax + (Number(p.x) || 0) * W, ay + (Number(p.y) || 0) * H);
        L.c.rotate((Number(p.rotate) || 0) * Math.PI / 180);
        const s = clamp(p.scale, 0.001, 64);
        L.c.scale(s, s);
        L.c.translate(-ax, -ay);
        L.c.drawImage(src, 0, 0);
        L.c.restore();
      },
    },

    round: {
      label: 'Corners + shadow',
      params: { radius: 0.04, colour: '#000000', shadow: 0.5, blur: 0.03, offsetX: 0, offsetY: 0.012 },
      schema: [
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.5, step: 0.002, digits: 3 },
        { path: 'params.colour', label: 'Shadow colour', type: 'color' },
        { path: 'params.shadow', label: 'Shadow', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.blur', label: 'Shadow blur', type: 'range', min: 0, max: 0.25, step: 0.002, digits: 3 },
        { path: 'params.offsetX', label: 'Shadow X', type: 'range', min: -0.2, max: 0.2, step: 0.002, digits: 3 },
        { path: 'params.offsetY', label: 'Shadow Y', type: 'range', min: -0.2, max: 0.2, step: 0.002, digits: 3 },
      ],
      // One drawImage does both halves: the canvas shadow is cast from the alpha of the
      // thing being drawn, so rounding first and drawing once gives a shadow that follows
      // the corners exactly. Two passes would have to keep two paths in agreement, which
      // is the mistake this whole architecture exists to stop making.
      draw(L, p) {
        const src = take(L, 'fxA');
        const W = L.W, H = L.H;
        const rounded = clean(L.surface, 'fxB', W, H);
        rounded.c.save();
        roundRectPath(rounded.c, 0, 0, W, H, pxMin(p.radius, W, H));
        rounded.c.clip();
        rounded.c.drawImage(src, 0, 0);
        rounded.c.restore();

        L.c.save();
        L.c.shadowColor = rgba(p.colour, p.shadow);
        L.c.shadowBlur = pxMin(p.blur, W, H);
        L.c.shadowOffsetX = pxMin(p.offsetX, W, H);
        L.c.shadowOffsetY = pxMin(p.offsetY, W, H);
        L.c.drawImage(rounded.cv, 0, 0);
        L.c.restore();
      },
    },

    inset: {
      label: 'Crop / inset',
      params: { left: 0, right: 0, top: 0, bottom: 0 },
      schema: [
        { path: 'params.left', label: 'Left', type: 'range', min: 0, max: 0.5, step: 0.002, digits: 3 },
        { path: 'params.right', label: 'Right', type: 'range', min: 0, max: 0.5, step: 0.002, digits: 3 },
        { path: 'params.top', label: 'Top', type: 'range', min: 0, max: 0.5, step: 0.002, digits: 3 },
        { path: 'params.bottom', label: 'Bottom', type: 'range', min: 0, max: 0.5, step: 0.002, digits: 3 },
      ],
      // Cropping CLEARS to transparent rather than filling black: the layers underneath
      // have to come through, which is the whole reason step 5 exists.
      draw(L, p) {
        const src = take(L, 'fxA');
        const W = L.W, H = L.H;
        const x0 = clamp(p.left, 0, 1) * W, x1 = W - clamp(p.right, 0, 1) * W;
        const y0 = clamp(p.top, 0, 1) * H, y1 = H - clamp(p.bottom, 0, 1) * H;
        if (x1 <= x0 || y1 <= y0) return;      // cropped away to nothing
        L.c.save();
        L.c.beginPath();
        L.c.rect(x0, y0, x1 - x0, y1 - y0);
        L.c.clip();
        L.c.drawImage(src, 0, 0);
        L.c.restore();
      },
    },

    blur: {
      label: 'Blur',
      params: { radius: 0.01 },
      schema: [
        { path: 'params.radius', label: 'Radius', type: 'range', min: 0, max: 0.2, step: 0.001, digits: 3 },
      ],
      /**
       * A blur MUST NOT MAGNIFY, and it must not darken its own edges.
       *
       * The obvious implementation blurs the layer in place, which pulls the transparent
       * surround inwards and leaves a soft dark rim all the way round the frame. The
       * other obvious fix - draw it oversized so the rim falls outside - silently zooms
       * the picture, and the zoom grows with the radius. So: pad the plate by extending
       * its edge pixels outward, blur at 1:1, crop back. The rim is then built out of the
       * picture's own edge, which is what it would have been if the frame continued.
       */
      draw(L, p) {
        const W = L.W, H = L.H;
        const r = pxMin(p.radius, W, H);
        if (!(r > 0.05)) return;
        const src = take(L, 'fxA');
        const pad = Math.ceil(r * 3) + 2;
        const PW = W + pad * 2, PH = H + pad * 2;
        const plate = clean(L.surface, 'fxPad', PW, PH);
        const c = plate.c;
        c.drawImage(src, pad, pad);
        c.drawImage(src, 0, 0, 1, H, 0, pad, pad, H);              // left
        c.drawImage(src, W - 1, 0, 1, H, W + pad, pad, pad, H);    // right
        c.drawImage(src, 0, 0, W, 1, pad, 0, W, pad);              // top
        c.drawImage(src, 0, H - 1, W, 1, pad, H + pad, W, pad);    // bottom
        c.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
        c.drawImage(src, W - 1, 0, 1, 1, W + pad, 0, pad, pad);
        c.drawImage(src, 0, H - 1, 1, 1, 0, H + pad, pad, pad);
        c.drawImage(src, W - 1, H - 1, 1, 1, W + pad, H + pad, pad, pad);

        // Blurred padded -> padded, THEN cropped. Drawing the crop with the filter still
        // on would blur the crop rather than the plate, and the rim would come straight
        // back - the padding would have bought nothing.
        const soft = clean(L.surface, 'fxPad2', PW, PH);
        soft.c.filter = 'blur(' + (Math.round(r * 100) / 100) + 'px)';
        soft.c.drawImage(plate.cv, 0, 0);
        soft.c.filter = 'none';
        L.c.drawImage(soft.cv, pad, pad, W, H, 0, 0, W, H);
      },
    },

    grade: {
      label: 'Grade',
      params: { lift: 0, gamma: 1, gain: 1, saturation: 1, contrast: 1, temperature: 0 },
      schema: [
        { path: 'params.lift', label: 'Lift', type: 'range', min: -0.5, max: 0.5, step: 0.005, digits: 3 },
        { path: 'params.gamma', label: 'Gamma', type: 'range', min: 0.2, max: 3, step: 0.01, digits: 2 },
        { path: 'params.gain', label: 'Gain', type: 'range', min: 0, max: 3, step: 0.01, digits: 2 },
        { path: 'params.saturation', label: 'Saturation', type: 'range', min: 0, max: 3, step: 0.01, digits: 2 },
        { path: 'params.contrast', label: 'Contrast', type: 'range', min: 0, max: 3, step: 0.01, digits: 2 },
        { path: 'params.temperature', label: 'Temperature', type: 'range', min: -1, max: 1, step: 0.01, digits: 2 },
      ],
      /**
       * The one pixel pass in this file, so it is also the expensive one - about 8 M
       * pixels a frame at 1080x1920. Neutral values short-circuit out entirely, which is
       * what makes an unconfigured grade free AND makes it a pixel-exact no-op.
       *
       * Alpha is left alone. `ImageData` is UNpremultiplied, so grading the colour of a
       * half-transparent pixel is meaningful and needs no undoing of a premultiply.
       */
      draw(L, p) {
        if (isNeutralGrade(p)) return;
        const W = L.W, H = L.H;
        const img = L.c.getImageData(0, 0, W, H);
        const d = img.data;
        const lut = gradeLUT(p);
        const lr = lut[0], lg = lut[1], lb = lut[2];
        const sat = clamp(p.saturation, 0, 8);
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          let r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
          if (sat !== 1) {
            // Rec.709 luma - the same weights the rest of the pipeline calls brightness.
            const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat;
          }
          d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
          d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
          d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        }
        L.c.putImageData(img, 0, 0);
      },
    },
  };

  const TYPES = Object.keys(DEFS);

  // -------------------------------------------------------------------- the grade

  const GRADE_NEUTRAL = { lift: 0, gamma: 1, gain: 1, saturation: 1, contrast: 1, temperature: 0 };

  /** True when a grade cannot change a single pixel, so the whole pass can be skipped. */
  function isNeutralGrade(p) {
    for (const k of Object.keys(GRADE_NEUTRAL)) {
      if ((Number(p[k]) || 0) !== GRADE_NEUTRAL[k]) return false;
    }
    return true;
  }

  /**
   * Three 256-entry lookup tables, one per channel: gain, lift, gamma, contrast and
   * temperature are all per-channel curves, so they cost 768 evaluations a frame instead
   * of eight million. Saturation is the one that needs the other two channels, so it
   * stays in the pixel loop.
   *
   * Order matters and is the usual one: gain scales, lift raises the floor, gamma bends
   * the middle, contrast pivots about mid-grey. Temperature is a warm/cool trim applied
   * last - red up and blue down together - so a neutral 0 leaves the curve untouched and
   * `isNeutralGrade()` is telling the truth.
   */
  function gradeLUT(p) {
    const lift = Number(p.lift) || 0;
    const gamma = clamp(p.gamma, 0.05, 10);
    const gain = clamp(p.gain, 0, 8);
    const contrast = clamp(p.contrast, 0, 8);
    const temp = clamp(p.temperature, -1, 1);
    const trim = [1 + temp * 0.3, 1, 1 - temp * 0.3];
    const out = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < 256; i++) {
        let v = i / 255;
        v = v * gain + lift;
        if (v < 0) v = 0; else if (v > 1) v = 1;
        if (gamma !== 1) v = Math.pow(v, 1 / gamma);
        if (contrast !== 1) v = (v - 0.5) * contrast + 0.5;
        v *= trim[ch];
        out[ch][i] = v * 255;
      }
    }
    return out;
  }

  // --------------------------------------------------------------------- the stack

  let seq = 0;
  const uid = () => 'fx' + Date.now().toString(36) + (seq++).toString(36);

  /** A fresh effect of `type`, with its defaults and no keys. */
  function create(type) {
    const d = DEFS[type];
    if (!d) return null;
    return { id: uid(), type, enabled: true, params: JSON.parse(JSON.stringify(d.params)) };
  }

  /**
   * Fill an entry in against its defaults, dropping anything that is not a number where a
   * number belongs. A project saved by an older build gains new parameters for free, the
   * way `Trans.normalize()` and `AudioFX.normalize()` already do.
   */
  function normalize(fx) {
    const d = DEFS[fx.type];
    if (!d) return null;
    if (!fx.id) fx.id = uid();
    fx.enabled = fx.enabled !== false;
    const params = Object.assign({}, d.params);
    for (const k of Object.keys(params)) {
      const v = (fx.params || {})[k];
      if (typeof params[k] === 'number') { if (isFinite(Number(v))) params[k] = Number(v); }
      else if (v != null) params[k] = v;
    }
    fx.params = params;
    // A track for a parameter that no longer exists would evaluate into nothing. Dropping
    // it keeps `keys` honest and keeps the saved file free of dead weight - and `keys`
    // itself goes when the last track does, so an unkeyed effect serialises without it.
    if (fx.keys && typeof fx.keys === 'object') {
      for (const k of Object.keys(fx.keys)) {
        if (!Array.isArray(fx.keys[k]) || !fx.keys[k].length || !(k in params)) delete fx.keys[k];
        else Anim.sortKeys(fx.keys[k]);
      }
      if (!Object.keys(fx.keys).length) delete fx.keys;
    } else if (fx.keys) {
      delete fx.keys;
    }
    return fx;
  }

  /** Normalise a clip's whole stack, dropping unknown types. Absent stays absent. */
  function normalizeClip(clip) {
    if (!clip || !Array.isArray(clip.fx)) return;
    clip.fx = clip.fx.filter((f) => f && DEFS[f.type]).map(normalize).filter(Boolean);
    if (!clip.fx.length) delete clip.fx;
  }

  /** The effects that will actually draw: known type, not bypassed. */
  function active(clip) {
    if (!clip || !Array.isArray(clip.fx)) return [];
    return clip.fx.filter((f) => f && DEFS[f.type] && f.enabled !== false);
  }

  /** One parameter's value at clip-local time `t` - keyed if it has keys, static if not. */
  function paramAt(entry, key, t) {
    const stat = (entry.params || {})[key];
    if (typeof stat !== 'number') return stat;      // a colour has no track
    return Anim.valueAt(entry, key, t, stat);
  }

  /** The whole animated parameter set for one effect at `t`. */
  function paramsAt(entry, t) {
    const d = DEFS[entry.type];
    const out = {};
    for (const k of Object.keys(d.params)) out[k] = paramAt(entry, k, t);
    return out;
  }

  /**
   * Paint one clip through its effect stack onto `target`. Returns true if the stack ran.
   *
   * `paint(ctx, W, H)` draws the clip as it would have been drawn with no effects at all,
   * into a transparent layer of its own - the layer rule at the top of this file. Nothing
   * outside this function may run an effect, because nothing outside it can guarantee
   * that isolation.
   *
   * `surface(name, w, h)` is the caller's canvas pool, so no frame allocates a canvas.
   * One bad effect must not take the render down: a throwing draw is logged and skipped
   * and the layer carries on with whatever it had - `loop()` re-arms in a `finally` for
   * exactly the same reason.
   *
   * Stack ORDER is the array's order and it matters: blur after grade is not blur before
   * grade, because a grade lifts what a blur has already averaged.
   */
  function render(target, W, H, clip, t, surface, paint) {
    const entries = active(clip);
    if (!entries.length) { paint(target, W, H); return false; }
    const layer = clean(surface, 'fxLayer', W, H);
    const L = { cv: layer.cv, c: layer.c, W, H, surface };
    paint(L.c, W, H);
    for (const e of entries) {
      try {
        DEFS[e.type].draw(L, paramsAt(e, t), t, e);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('FX ' + e.type + ' failed:', err);
      }
      // An effect that leaves the context dirty would poison every effect after it.
      reset(L.c);
    }
    target.drawImage(L.cv, 0, 0);
    return true;
  }

  const API = {
    DEFS, TYPES,
    create, normalize, normalizeClip, active,
    paramAt, paramsAt, render,
    gradeLUT, isNeutralGrade, GRADE_NEUTRAL,
    roundRectPath, pxMin, rgba,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.FX = API;
})();
