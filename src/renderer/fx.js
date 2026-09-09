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

  /**
   * A rounded rectangle as a SUBPATH - it adds to whatever path is already open and
   * never calls `beginPath()`.
   *
   * That distinction is the whole reason this exists separately. A two-subpath path
   * filled `evenodd` is how you darken everything OUTSIDE a shape, and the version below
   * that opens with `beginPath()` silently threw the outer rectangle away when it was
   * used that way - so the selection's `dim` darkened the inside of the box instead of
   * the outside. Anything building a hole needs this one.
   */
  function roundRectSub(c, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (rr <= 0) { c.rect(x, y, w, h); return; }
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  /** The same shape as its own fresh path, which is what most callers want. */
  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    roundRectSub(c, x, y, w, h, r);
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

  // ------------------------------------------------------------- imported pointers

  /**
   * PNG pointers, held by path.
   *
   * `draw()` is synchronous and must never stall - `loop()` re-arms in a `finally` so a
   * bad frame costs a frame and never the session - so this hands back `null` while an
   * image is still decoding and the caller falls back to the built-in arrow. That is
   * correct for the viewer, where the next frame is 16 ms away, and NOT correct for the
   * baker, where a frame is written once and a miss would be baked in. `preloadImages()`
   * is what the baker calls first; see its comment.
   */
  const imgCache = new Map();
  function pointerImage(path) {
    const key = String(path || '');
    if (!key) return null;
    let rec = imgCache.get(key);
    if (!rec) {
      if (typeof Image === 'undefined') return null;
      rec = { el: new Image(), failed: false };
      rec.el.onerror = () => { rec.failed = true; };
      rec.el.src = 'file:///' + key.replace(/\\/g, '/').replace(/^\/+/, '');
      imgCache.set(key, rec);
    }
    if (rec.failed) return null;
    return rec.el.complete && rec.el.naturalWidth ? rec.el : null;
  }

  /**
   * Decode every imported pointer a set of clips needs, before anything is baked.
   *
   * The preview can afford to miss one and draw the arrow instead; the export cannot,
   * because the frame it missed on is in the file forever. So the baker awaits this and
   * the two then paint the same picture - which is the one invariant this whole
   * architecture exists to keep. A pointer that will not decode resolves anyway: a
   * missing file must not hang a render, and the arrow is a defensible fallback.
   */
  function preloadImages(clips) {
    const paths = new Set();
    for (const c of (clips || [])) {
      for (const f of ((c && c.fx) || [])) {
        if (f && f.type === 'cursor' && f.params && f.params.image) paths.add(f.params.image);
      }
    }
    return Promise.all([...paths].map((path) => new Promise((done) => {
      if (pointerImage(path)) return done();
      const rec = imgCache.get(String(path));
      if (!rec || rec.failed) return done();
      rec.el.addEventListener('load', () => done(), { once: true });
      rec.el.addEventListener('error', () => done(), { once: true });
      setTimeout(done, 3000);      // a slow or dead path costs three seconds, not the render
    })));
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
      // NOT a vignette, and the label says so because the confusion is a fair one: on a
      // FULL-FRAME clip the rounded rect IS the whole frame, so the shadow it casts falls
      // entirely outside the canvas and all that is left to see is the corners cut to
      // transparency with black showing through. It only reads as a shadow once the layer
      // is smaller than the frame - put a `transform` at scale 0.9 ABOVE it and the
      // shadow appears in the gap that opens. Darkening the frame's own edges is a
      // different pass entirely.
      label: 'Corners + shadow (scale the layer down first)',
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

    // ------------------------------------------------ the screen-recording pair
    //
    // Both read step 8's telemetry off the clip, and both draw NOTHING at all when there
    // is none. That is the degradation contract stated in the README under "The screen
    // recorder", and it is why these are ordinary effects rather than a mode: a clip from
    // Screen Studio or a phone can carry one, it simply has nothing to say.
    //
    // WHERE THEY BELONG IN THE STACK. Below a `transform`, always. Telemetry is a point
    // in the SOURCE frame, so these two paint at the pixel the framing put it on - and a
    // transform drawn AFTERWARDS moves the picture and the pointer together, which is
    // what makes an auto-zoom carry its own cursor. Drawn the other way round the frame
    // dives in and the pointer sits still on top of it. `autoZoomFx()` in app.js appends
    // its transform to the end of the stack for exactly this reason.

    cursor: {
      label: 'Cursor (performed)',
      needs: 'mouse',
      params: {
        size: Cursor.DEFAULTS.cursor.size,
        smooth: Cursor.DEFAULTS.cursor.smooth,
        lag: Cursor.DEFAULTS.cursor.lag,
        punch: Cursor.DEFAULTS.cursor.punch,
        punchDur: Cursor.DEFAULTS.cursor.punchDur,
        opacity: 1,
        colour: '#ffffff',
        outline: '#10161c',
        image: '',
        hotspotX: 0,
        hotspotY: 0,
      },
      schema: [
        { path: 'params.size', label: 'Pointer size', type: 'range', min: 0.01, max: 0.15, step: 0.002, digits: 3 },
        { path: 'params.smooth', label: 'Smoothing', type: 'range', min: 0, max: 0.6, step: 0.01, unit: 's', digits: 2 },
        { path: 'params.lag', label: 'Lag', type: 'range', min: 0, max: 0.3, step: 0.005, unit: 's', digits: 3 },
        { path: 'params.punch', label: 'Click punch', type: 'range', min: 1, max: 2.5, step: 0.01, digits: 2 },
        { path: 'params.punchDur', label: 'Punch length', type: 'range', min: 0.05, max: 1, step: 0.01, unit: 's', digits: 2 },
        { path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.colour', label: 'Pointer', type: 'color' },
        { path: 'params.outline', label: 'Outline', type: 'color' },
        { path: 'params.hotspotX', label: 'PNG hotspot X', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.hotspotY', label: 'PNG hotspot Y', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      ],
      /**
       * A pointer drawn on the smoothed path of an ON-RENDER take.
       *
       * THERE IS NOTHING TO CONCEAL, and that is why this reads `clip.mouse` rather than
       * `clip.screen`. A screen capture has a real cursor baked into its pixels, so
       * drawing a second one over it gave two pointers chasing each other and an earlier
       * version of this effect spent a `conceal` parameter smearing neighbouring pixels
       * over the first one - a cover, not an inpaint, and wrong over any hard edge. A
       * performed take is recorded over a picture that never had a pointer in it, so the
       * drawn one is the only one and the whole problem is gone rather than patched.
       * Screen captures keep auto-zoom, which has no cursor in it.
       *
       * The path comes from `Cursor.smoothAt()`, so it lags and eases; the scale punch
       * comes from `Cursor.punchAt()`, a function of the click times and nothing else -
       * neither can drift between the preview and the export, because neither is
       * integrating anything.
       *
       * `image` swaps the built-in arrow for an imported PNG, drawn about its own
       * hotspot. It falls back to the arrow while the file is still decoding, which the
       * viewer can afford and the baker cannot - see `preloadImages()`.
       */
      draw(L, p, t, e, clip) {
        const mouse = clip && clip.mouse;
        if (!Cursor.has(mouse)) return;
        const W = L.W, H = L.H;
        const ts = (Number(clip.in) || 0) + t;
        const pt = Cursor.smoothAt(mouse, ts, { smooth: p.smooth, lag: p.lag });
        if (!pt) return;
        const at = Cursor.mapperFor(clip, mouse, W, H)(pt.x, pt.y);
        const punch = Cursor.punchAt(mouse, ts, { punch: p.punch, punchDur: p.punchDur });
        const s = pxMin(p.size, W, H) * punch;

        L.c.save();
        L.c.globalAlpha = clamp(p.opacity, 0, 1);
        L.c.translate(at.x, at.y);
        L.c.scale(s, s);

        const img = p.image ? pointerImage(p.image) : null;
        if (img) {
          // Scaled to the pointer's own height so a tall PNG and a wide one both come out
          // the size the slider says, and offset by the hotspot so the click lands where
          // the artwork points rather than at its top-left corner.
          const ar = img.naturalWidth / Math.max(1, img.naturalHeight);
          const h = 1.4, w = h * ar;
          L.c.drawImage(img, -clamp(p.hotspotX, 0, 1) * w, -clamp(p.hotspotY, 0, 1) * h, w, h);
        } else {
          // The classic arrow, in units of the pointer's own width, hotspot at (0, 0).
          L.c.beginPath();
          L.c.moveTo(0, 0);
          L.c.lineTo(0, 1.0);
          L.c.lineTo(0.28, 0.73);
          L.c.lineTo(0.45, 1.12);
          L.c.lineTo(0.62, 1.05);
          L.c.lineTo(0.45, 0.66);
          L.c.lineTo(0.72, 0.62);
          L.c.closePath();
          L.c.fillStyle = String(p.colour || '#ffffff');
          L.c.strokeStyle = String(p.outline || '#10161c');
          L.c.lineWidth = 0.07;
          L.c.lineJoin = 'round';
          L.c.fill();
          L.c.stroke();
        }
        L.c.restore();
      },
    },

    ripple: {
      label: 'Click ripples',
      needs: 'mouse',
      params: {
        size: Cursor.DEFAULTS.ripple.size,
        dur: Cursor.DEFAULTS.ripple.dur,
        width: Cursor.DEFAULTS.ripple.width,
        opacity: 0.9,
        colour: Cursor.ACCENT,
      },
      schema: [
        { path: 'params.size', label: 'Radius', type: 'range', min: 0.01, max: 0.3, step: 0.002, digits: 3 },
        { path: 'params.dur', label: 'Length', type: 'range', min: 0.1, max: 2, step: 0.01, unit: 's', digits: 2 },
        { path: 'params.width', label: 'Ring width', type: 'range', min: 0.001, max: 0.03, step: 0.001, digits: 3 },
        { path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.colour', label: 'Colour', type: 'color' },
      ],
      /**
       * An expanding ring per mouse-down, at the pixel the click happened on.
       *
       * The radius eases out and the alpha falls faster than it, so the ring reads as
       * energy leaving rather than as a circle fading. Both are functions of
       * `(t - click)` alone: no state and no accumulation, so a scrub backwards and a
       * bake that visits frames out of order paint the same picture. The default colour
       * is the brand accent, hardcoded until step 17 hands the brand kit over -
       * `Cursor.ACCENT` is the one place it lives, so that step changes one constant.
       *
       * A take with no clicks in it carries no mouse-downs at all, so this draws
       * nothing, which is the right answer.
       */
      draw(L, p, t, e, clip) {
        const mouse = clip && clip.mouse;
        if (!Cursor.has(mouse)) return;
        const W = L.W, H = L.H;
        const ts = (Number(clip.in) || 0) + t;
        const rings = Cursor.ripplesAt(mouse, ts, { dur: p.dur });
        if (!rings.length) return;
        const map = Cursor.mapperFor(clip, mouse, W, H);
        const R = pxMin(p.size, W, H);
        const lw = pxMin(p.width, W, H);
        L.c.save();
        L.c.strokeStyle = String(p.colour || Cursor.ACCENT);
        for (const r of rings) {
          const q = map(r.x, r.y);
          const grow = 1 - Math.pow(1 - r.k, 3);          // ease-out on the radius
          const fade = Math.pow(1 - r.k, 1.6);            // alpha falls faster than it
          L.c.globalAlpha = clamp(p.opacity, 0, 1) * fade;
          L.c.lineWidth = Math.max(0.5, lw * (1 - r.k * 0.6));
          L.c.beginPath();
          L.c.arc(q.x, q.y, Math.max(0.5, R * grow), 0, Math.PI * 2);
          L.c.stroke();
        }
        L.c.restore();
      },
    },

    select: {
      label: 'Window selection',
      params: {
        x: 0.12, y: 0.32, w: 0.76, h: 0.3,
        style: 'brackets',
        colour: Cursor.ACCENT,
        width: 0.005,
        radius: 0.02,
        dim: 0,
        showFrom: 0,
        showTo: 9999,
        fadeIn: 0.28,
        fadeOut: 0.28,
        opacity: 1,
      },
      schema: [
        { path: 'params.style', label: 'Style', type: 'select',
          options: [
            { value: 'brackets', label: 'Corner brackets' },
            { value: 'dashed', label: 'Dashed marquee' },
            { value: 'solid', label: 'Outline + glow' },
            { value: 'none', label: 'No outline (dim only)' },
          ] },
        { path: 'params.x', label: 'X', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.y', label: 'Y', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.01, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.01, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.colour', label: 'Colour', type: 'color' },
        { path: 'params.width', label: 'Line width', type: 'range', min: 0.001, max: 0.03, step: 0.0005, digits: 4 },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.2, step: 0.002, digits: 3 },
        { path: 'params.dim', label: 'Dim outside', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.showFrom', label: 'On at', type: 'range', min: 0, max: 60, step: 0.05, unit: 's', digits: 2 },
        { path: 'params.showTo', label: 'Off at', type: 'range', min: 0, max: 60, step: 0.05, unit: 's', digits: 2 },
        { path: 'params.fadeIn', label: 'Fade in', type: 'range', min: 0, max: 2, step: 0.01, unit: 's', digits: 2 },
        { path: 'params.fadeOut', label: 'Fade out', type: 'range', min: 0, max: 2, step: 0.01, unit: 's', digits: 2 },
      ],
      /**
       * The animated window selection: a rectangle that arrives, holds and leaves.
       *
       * Recorded by the on-render pass as tagged keys on `x/y/w/h` - the same generator
       * pattern auto-zoom uses, so a box dragged out in a hurry can be nudged afterwards
       * instead of re-performed - and equally authorable by hand on a clip that was never
       * recorded over. That is why it carries no `needs`: unlike the pointer, a selection
       * box does not require anything to have been recorded.
       *
       * THE ENVELOPE IS A FUNCTION OF `t` AND NOTHING ELSE. It fades and scales in over
       * `fadeIn`, holds, and leaves over `fadeOut`, all computed from the clip-local time
       * alone - no state, no accumulation, so a scrub backwards and a baker visiting
       * frames out of order paint the same picture. The marching dashes are the same: the
       * dash offset is `t * speed`, not an incrementing counter, which is the only reason
       * the preview and the export agree on where the dashes are.
       *
       * `dim` darkens everything OUTSIDE the box, and it does it with an even-odd fill
       * rather than by clearing the middle. Clearing would punch a transparent hole
       * through the clip's own layer and let whatever is under it come through, which is
       * the opposite of lighting one region of this clip.
       */
      draw(L, p, t, e, clip) {
        const W = L.W, H = L.H;
        const t0 = Number(p.showFrom) || 0;
        const t1 = Number(p.showTo);
        if (t < t0 || (isFinite(t1) && t > t1)) return;

        // The entry/exit envelope, eased out so it lands softly at both ends.
        const fi = Math.max(1e-4, Number(p.fadeIn) || 0);
        const fo = Math.max(1e-4, Number(p.fadeOut) || 0);
        let k = 1;
        if (t < t0 + fi) k = (t - t0) / fi;
        if (isFinite(t1) && t > t1 - fo) k = Math.min(k, (t1 - t) / fo);
        k = clamp(k, 0, 1);
        const ease = 1 - Math.pow(1 - k, 3);
        const alpha = clamp(p.opacity, 0, 1) * ease;
        if (alpha <= 0.002) return;

        // Overshoot on the way in: the box arrives slightly large and settles.
        const grow = (1 - ease) * 0.06;
        const rw = (Number(p.w) || 0) * W, rh = (Number(p.h) || 0) * H;
        const rx = (Number(p.x) || 0) * W - grow * rw;
        const ry = (Number(p.y) || 0) * H - grow * rh;
        const bw = rw * (1 + grow * 2), bh = rh * (1 + grow * 2);
        if (!(bw > 0.5 && bh > 0.5)) return;
        const r = pxMin(p.radius, W, H);
        const lw = Math.max(0.5, pxMin(p.width, W, H));

        L.c.save();
        L.c.globalAlpha = alpha;

        if (p.dim > 0) {
          // Even-odd: the frame with the box punched out of the PATH, not out of the
          // pixels. Filling that darkens the outside and leaves the middle untouched.
          L.c.save();
          L.c.beginPath();
          L.c.rect(0, 0, W, H);
          roundRectSub(L.c, rx, ry, bw, bh, r);   // SUBPATH - see roundRectSub()
          L.c.fillStyle = 'rgba(0,0,0,' + clamp(p.dim, 0, 1) + ')';
          L.c.fill('evenodd');
          L.c.restore();
        }

        const colour = String(p.colour || Cursor.ACCENT);
        L.c.strokeStyle = colour;
        L.c.lineWidth = lw;
        L.c.lineCap = 'round';
        L.c.lineJoin = 'round';

        if (p.style === 'solid') {
          L.c.shadowColor = rgba(colour, 0.9);
          L.c.shadowBlur = lw * 4;
          roundRectPath(L.c, rx, ry, bw, bh, r);
          L.c.stroke();
        } else if (p.style === 'dashed') {
          const dash = Math.max(2, lw * 3);
          L.c.setLineDash([dash, dash]);
          // Marching, as a pure function of time: 60 px a second at the frame's scale.
          L.c.lineDashOffset = -(t * Math.min(W, H) * 0.11) % (dash * 2);
          roundRectPath(L.c, rx, ry, bw, bh, r);
          L.c.stroke();
          L.c.setLineDash([]);
        } else if (p.style === 'brackets') {
          // Four L-shaped corners, each a fixed fraction of the shorter side of the box,
          // so a wide selection and a tall one get the same-looking corners.
          const arm = Math.min(bw, bh) * 0.26;
          const x0 = rx, y0 = ry, x1 = rx + bw, y1 = ry + bh;
          const L4 = [
            [[x0, y0 + arm], [x0, y0], [x0 + arm, y0]],
            [[x1 - arm, y0], [x1, y0], [x1, y0 + arm]],
            [[x1, y1 - arm], [x1, y1], [x1 - arm, y1]],
            [[x0 + arm, y1], [x0, y1], [x0, y1 - arm]],
          ];
          L.c.beginPath();
          for (const seg of L4) {
            L.c.moveTo(seg[0][0], seg[0][1]);
            L.c.lineTo(seg[1][0], seg[1][1]);
            L.c.lineTo(seg[2][0], seg[2][1]);
          }
          L.c.stroke();
        }
        L.c.restore();
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
 *
 * `clip` reaches `draw()` as its fifth argument for one kind of effect: the ones that
 * read something recorded ALONGSIDE the picture rather than something on the stack.
 * `cursor` and `ripple` need step 8's telemetry, which lives on the clip and could never
 * be a parameter - it is thousands of samples. Nothing else may reach for it; an effect
 * that read `clip.start` from here would be putting a clip's timeline position into its
 * own pixels, which is the one thing the render cache's key rules forbid.
 */
  function render(target, W, H, clip, t, surface, paint) {
    const entries = active(clip);
    if (!entries.length) { paint(target, W, H); return false; }
    const layer = clean(surface, 'fxLayer', W, H);
    const L = { cv: layer.cv, c: layer.c, W, H, surface };
    paint(L.c, W, H);
    for (const e of entries) {
      try {
        DEFS[e.type].draw(L, paramsAt(e, t), t, e, clip);
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
    pointerImage, preloadImages,
    gradeLUT, isNeutralGrade, GRADE_NEUTRAL,
    roundRectPath, roundRectSub, pxMin, rgba,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.FX = API;
})();
