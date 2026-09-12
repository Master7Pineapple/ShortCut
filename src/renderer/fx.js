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

  /**
   * Blur a canvas by `r` pixels without letting the frame edge eat into it.
   *
   * The plate is padded so the blur kernel has somewhere to reach, blurred at 1:1, then
   * cropped back - never drawn oversized, which would silently magnify the picture by an
   * amount that grows with the radius. `blur`'s own draw extends the EDGE PIXELS into the
   * padding because it is blurring a full-frame picture whose surround would otherwise
   * pull a dark rim inwards; a silhouette is already surrounded by transparency and wants
   * to stay that way, so `extend` is optional.
   *
   * Shared because `ctx.shadowBlur` is NOT scale-invariant - see the `round` effect.
   */
  function padBlur(srcCv, r, W, H, surface, tag, extend) {
    const pad = Math.ceil(r * 3) + 2;
    const PW = W + pad * 2, PH = H + pad * 2;
    const plate = clean(surface, tag + 'P', PW, PH);
    const c = plate.c;
    c.drawImage(srcCv, pad, pad);
    if (extend) {
      c.drawImage(srcCv, 0, 0, 1, H, 0, pad, pad, H);
      c.drawImage(srcCv, W - 1, 0, 1, H, W + pad, pad, pad, H);
      c.drawImage(srcCv, 0, 0, W, 1, pad, 0, W, pad);
      c.drawImage(srcCv, 0, H - 1, W, 1, pad, H + pad, W, pad);
      c.drawImage(srcCv, 0, 0, 1, 1, 0, 0, pad, pad);
      c.drawImage(srcCv, W - 1, 0, 1, 1, W + pad, 0, pad, pad);
      c.drawImage(srcCv, 0, H - 1, 1, 1, 0, H + pad, pad, pad);
      c.drawImage(srcCv, W - 1, H - 1, 1, 1, W + pad, H + pad, pad, pad);
    }
    const soft = clean(surface, tag + 'S', PW, PH);
    soft.c.filter = 'blur(' + (Math.round(r * 100) / 100) + 'px)';
    soft.c.drawImage(plate.cv, 0, 0);
    soft.c.filter = 'none';
    return { cv: soft.cv, pad };
  }

  /** Copy the layer into a scratch and clear the layer, ready to be repainted from it. */
  function take(L, name) {
    const s = clean(L.surface, name, L.W, L.H);
    s.c.drawImage(L.cv, 0, 0);
    reset(L.c);
    L.c.clearRect(0, 0, L.W, L.H);
    return s.cv;
  }

  /**
   * The clip AS PAINTED, before any effect in the stack touched it - built on first ask
   * and never otherwise, so a stack that does not want it allocates nothing.
   *
   * This is the second and last thing an effect may reach for beyond its own parameters,
   * alongside the `clip` argument, and it exists for one effect: `background` in its
   * blurred-copy mode is documented as a blurred copy OF THE CLIP, and by the time it
   * runs the layer is whatever `chrome` or `inset` left of it - a hole, mostly. Reading
   * the layer there would make the background a blurred copy of a picture with a
   * device-shaped bite out of it.
   *
   * It is the clip's own pixels and nothing else - no timeline position, no neighbours -
   * so it stays inside the cache key rules exactly as `paint` itself does.
   */
  function baseOf(surface, W, H, paint) {
    let cv = null;
    return () => {
      if (!cv) {
        const b = clean(surface, 'fxBase', W, H);
        paint(b.c, W, H);
        reset(b.c);
        cv = b.cv;
      }
      return cv;
    };
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
      // Bound, this is a CAMERA: the picture is panned so that the tracked pixel sits at
      // the frame centre plus the offset, which is what makes a zoom hold a moving button
      // in the middle of the shot. The algebra is the draw below, solved for `x`:
      // the point lands at anchor + (point - anchor) * scale + offset, so pinning it to
      // `want` gives x = want - anchorX * (1 - s) - s * point. Doing it any other way -
      // a plain `x = -point` - drifts the moment `scale` is anything but 1, and scale is
      // exactly what a tracked push-in animates.
      /*
       * TWO MODES, BECAUSE "FOLLOW" MEANS TWO OPPOSITE THINGS TO A TRANSFORM.
       *
       *   'move'    (the default) the clip TRAVELS WITH the tracked point. It keeps the
       *             position the author gave it and adds the distance the point has moved
       *             since it was anchored. A logo pinned to a moving button wants this:
       *             the button goes up, the logo goes up.
       *   'camera'  the FRAME pans so the tracked point sits at its centre. The clip being
       *             transformed is the footage the track was solved on, and the effect is
       *             a camera following the action - which is the auto-zoom shape.
       *
       * They move in OPPOSITE directions, which is exactly why this is a control and not
       * a cleverness: panning the camera up makes everything in the frame appear to go
       * down, so a logo bound in 'camera' mode slides away from the thing it is meant to
       * be stuck to. That was the first version of this, and it was wrong for the
       * commonest use there is.
       */
      bind: {
        label: 'Follow a track',
        hint: 'Move: the clip travels with the tracked point. Pan: the frame moves so the ' +
          'point stays centred - for footage the track was solved on.',
        modes: [
          { value: 'move', label: 'Move this clip with the point' },
          { value: 'camera', label: 'Pan the frame to keep the point centred' },
        ],
        apply(p, pos, off, mode) {
          const ox = Number(off.x) || 0, oy = Number(off.y) || 0;
          if (mode === 'camera') {
            const s = clamp(p.scale, 0.001, 64);
            p.x = (0.5 + ox) - clamp(p.anchorX, -4, 5) * (1 - s) - s * pos.x;
            p.y = (0.5 + oy) - clamp(p.anchorY, -4, 5) * (1 - s) - s * pos.y;
            return;
          }
          // 'move': the offset the author already had, plus how far the point has gone
          // since the anchor. `pos` is already damped by `strength`, so a strength of 0
          // leaves the clip exactly where it was placed.
          const ax = isFinite(Number(pos.ax)) ? Number(pos.ax) : pos.x;
          const ay = isFinite(Number(pos.ay)) ? Number(pos.ay) : pos.y;
          p.x = (Number(p.x) || 0) + (pos.x - ax) + ox;
          p.y = (Number(p.y) || 0) + (pos.y - ay) + oy;
        },
      },
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
      // NOT a vignette. This rounds and shadows the CLIP; darkening the frame's own edges
      // is a different pass entirely, and belongs with the finishing effects.
      //
      // `margin` is what makes the effect work at all, and it was missing. The rounded
      // rect used to be hardcoded to the full frame, which is a catch-22: on a full-frame
      // clip the shadow is cast at the frame edge and falls entirely outside the canvas,
      // so all you ever saw was the corners cut to transparency with black showing
      // through - and scaling the layer down first did NOT help, because the rounded rect
      // stayed the whole frame no matter what was inside it. Corners and shadow were
      // therefore both unreachable. The effect now insets the picture by `margin` and
      // rounds THAT rectangle, so the shadow has somewhere to fall.
      label: 'Corners + shadow',
      params: {
        mode: 'inner',
        margin: 0, radius: 0, colour: '#000000',
        shadow: 0.5, blur: 0.08, offsetX: 0, offsetY: 0,
      },
      schema: [
        { path: 'params.mode', label: 'Shadow falls', type: 'select',
          options: [
            { value: 'inner', label: 'Inward (vignette)' },
            { value: 'outer', label: 'Outward (drop shadow)' },
          ] },
        { path: 'params.margin', label: 'Inset', type: 'range', min: 0, max: 0.3, step: 0.002, digits: 3 },
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
      //
      // The margin is an equal number of PIXELS on all four sides - `pxMin()` against the
      // shorter side - not an equal fraction of each axis. On a 9:16 frame a uniform
      // fraction would inset the top and bottom nearly twice as far as the sides and the
      // border would read as lopsided, which is the opposite of what a frame is for.
      draw(L, p) {
        const src = take(L, 'fxA');
        const W = L.W, H = L.H;
        const m = Math.max(0, pxMin(p.margin, W, H));
        const dw = W - 2 * m, dh = H - 2 * m;
        if (!(dw > 1 && dh > 1)) return;      // the margin ate the whole picture
        const rad = pxMin(p.radius, W, H);

        // CLIPPED to the inset rect, not SCALED into it - a 1:1 copy through a clip path.
        //
        // Scaling looked more useful (the whole picture, smaller, inside a frame) and it
        // cost preview/render parity: resampling by a non-integer factor puts the
        // content's own edges at different sub-pixel phases at 135 px and at 540 px wide,
        // and a later `transform` lands those differences 35 levels apart in the viewer
        // and the file. `inset`, which clips, measures exactly 0 at the same test - which
        // is what pointed at the resample. So this crops the outer `margin` away instead,
        // the way a rounded-corner mask does, and the margin becomes the room the shadow
        // needs. If you want the whole picture smaller, put a `transform` above this one.
        const rounded = clean(L.surface, 'fxB', W, H);
        rounded.c.save();
        roundRectPath(rounded.c, m, m, dw, dh, rad);
        rounded.c.clip();
        rounded.c.drawImage(src, 0, 0);
        rounded.c.restore();

        // The shadow is painted from a SILHOUETTE of the same rounded rect, blurred with
        // `padBlur()`, rather than through `ctx.shadowBlur`.
        //
        // `ctx.shadowBlur` is not scale-invariant: at 6.75 px and at 27 px - the same
        // fraction of a 135-wide and a 540-wide frame - it produces gradients that are
        // proportional in extent but not in shape, and the difference is large enough to
        // survive a later `transform` and land 33 levels apart in the preview and the
        // export. `smoke-fx.js` measured exactly that, and only found it once the margin
        // made shadows visible at all: before that the shadow was cast at the frame edge
        // and fell outside the canvas, so the parity assertion had never once tested a
        // shadow pixel. The padded blur is the same one the `blur` effect uses and it
        // measures scale-invariant, so the two resolutions now agree.
        const sh = clamp(p.shadow, 0, 1);
        const inner = String(p.mode || 'inner') !== 'outer';
        const r = Math.max(0, pxMin(p.blur, W, H));
        const ox = pxMin(p.offsetX, W, H), oy = pxMin(p.offsetY, W, H);

        // OUTWARD: the silhouette laid down first, so the picture covers its middle and
        // only the part that escapes past the edges is seen. It needs somewhere to escape
        // TO, which is what `margin` opens - on a full-frame clip it falls off the canvas.
        if (sh > 0.002 && !inner) {
          const sil = clean(L.surface, 'fxShA', W, H);
          sil.c.fillStyle = rgba(p.colour, 1);
          roundRectPath(sil.c, m + ox, m + oy, dw, dh, rad);
          sil.c.fill();
          L.c.save();
          L.c.globalAlpha = sh;
          if (r > 0.05) {
            const b = padBlur(sil.cv, r, W, H, L.surface, 'fxSh', false);
            L.c.drawImage(b.cv, b.pad, b.pad, W, H, 0, 0, W, H);
          } else {
            L.c.drawImage(sil.cv, 0, 0);
          }
          L.c.restore();
        }

        L.c.drawImage(rounded.cv, 0, 0);

        // INWARD: the silhouette INVERTED - solid everywhere except the rect - blurred so
        // it bleeds back over the picture's own edges, and composited `source-atop` so it
        // touches nothing but this clip. That is the darkening people mean by a vignette:
        // strongest in the corners, because a corner has the most "outside" near it, and
        // more so the rounder it is.
        //
        // This is the default, and it is the one that works with NO setup: it needs no
        // margin, so a full-frame clip gets a vignette the moment the effect is added.
        // The outward shadow needs room opened for it first, which is why it was mistaken
        // for a broken effect - it draws into space that is not on the canvas.
        if (sh > 0.002 && inner) {
          // THE PADDING IS SOLID SHADOW, and that is the whole trick.
          //
          // The obvious build - fill the frame, punch the rect out, blur - produces
          // NOTHING at the default settings, because with no inset and no corner radius
          // the rect IS the frame and the punch removes everything. There has to be
          // shadow OUTSIDE the picture for any of it to bleed back in.
          //
          // So the plate is built oversized and filled solid, and the rect is punched out
          // of the middle of it. Everything beyond the frame edge is then shadow, the
          // blur carries it inward over the picture's own edges, and the result is a dark
          // band all the way round that is strongest in the corners - because a corner
          // has solid plate on two sides of it instead of one, and more so the rounder it
          // is. That is the darkening people mean by a vignette.
          const pad = Math.ceil(Math.max(r, 1) * 3) + 2;
          const PW = W + pad * 2, PH = H + pad * 2;
          const plate = clean(L.surface, 'fxShP', PW, PH);
          plate.c.fillStyle = rgba(p.colour, 1);
          plate.c.fillRect(0, 0, PW, PH);
          plate.c.globalCompositeOperation = 'destination-out';
          roundRectPath(plate.c, pad + m + ox, pad + m + oy, dw, dh, rad);
          plate.c.fill();
          plate.c.globalCompositeOperation = 'source-over';

          let out = plate.cv;
          if (r > 0.05) {
            const soft = clean(L.surface, 'fxShS', PW, PH);
            soft.c.filter = 'blur(' + (Math.round(r * 100) / 100) + 'px)';
            soft.c.drawImage(plate.cv, 0, 0);
            soft.c.filter = 'none';
            out = soft.cv;
          }

          L.c.save();
          L.c.globalAlpha = sh;
          // Only over this clip's own pixels. Filled normally it would darken the
          // transparency around a logo or a cutout, and dim the layers underneath through
          // a clip that is not even there.
          L.c.globalCompositeOperation = 'source-atop';
          L.c.drawImage(out, pad, pad, W, H, 0, 0, W, H);
          L.c.restore();
        }
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
        // EXTENDED, unlike the shadow's silhouette: this is a full-frame picture, so the
        // transparent surround would be pulled inwards and leave a soft dark rim all the
        // way round the frame. The rim is built out of the picture's own edge instead,
        // which is what it would have been if the frame continued.
        const b = padBlur(src, r, W, H, L.surface, 'fxPad', true);
        L.c.drawImage(b.cv, b.pad, b.pad, W, H, 0, 0, W, H);
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
      timeVarying: true,
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
      timeVarying: true,
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
      timeVarying: true,
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

    // ------------------------------------------------- step 10: the framing four
    //
    // Chrome, background, spotlight and cutout are one shape wearing four hats:
    // something drawn AROUND the footage, BEHIND it, OVER it, or LIFTED OUT of it.
    // All four are ordinary DEFS entries, so the panel, the keyframe strips, the
    // serialisation and the shutter arrived with them and none of it is written here.
    //
    // Two of the four only have anything to do once the layer has transparency in it -
    // `background` paints into it, `chrome` makes it - so ORDER is the whole feature:
    // chrome then background is a framed shot on a gradient; background then chrome is a
    // gradient the chrome then covers up. The panel's arrows are how that is said, and
    // there is deliberately no auto-ordering to guess it for the author.

    chrome: {
      label: 'Device frame',
      params: {
        preset: 'browser',
        pad: 0.05,
        aspect: 0,
        x: 0, y: 0,
        radius: 0.028,
        fit: 'cover',
        tinted: 0,
        tint: '#f4f5f7',
        shadow: 0.45,
        blur: 0.035,
        offsetY: 0.012,
      },
      schema: [
        { path: 'params.preset', label: 'Frame', type: 'select',
          options: [
            { value: 'browser', label: 'Browser - light' },
            { value: 'browserDark', label: 'Browser - dark' },
            { value: 'laptop', label: 'Laptop' },
            { value: 'phone', label: 'Phone' },
          ] },
        { path: 'params.pad', label: 'Padding', type: 'range', min: 0, max: 0.45, step: 0.002, digits: 3 },
        { path: 'params.aspect', label: 'Screen aspect', type: 'range', min: 0, max: 3, step: 0.01, digits: 2 },
        { path: 'params.x', label: 'Offset X', type: 'range', min: -0.5, max: 0.5, step: 0.002, digits: 3 },
        { path: 'params.y', label: 'Offset Y', type: 'range', min: -0.5, max: 0.5, step: 0.002, digits: 3 },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.12, step: 0.001, digits: 3 },
        { path: 'params.fit', label: 'Footage', type: 'select',
          options: [
            { value: 'cover', label: 'Fill the screen (crop)' },
            { value: 'contain', label: 'Fit the screen (letterbox)' },
          ] },
        { path: 'params.tinted', label: 'Override body colour', type: 'check' },
        { path: 'params.tint', label: 'Body colour', type: 'color' },
        { path: 'params.shadow', label: 'Shadow', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.blur', label: 'Shadow blur', type: 'range', min: 0, max: 0.2, step: 0.001, digits: 3 },
        { path: 'params.offsetY', label: 'Shadow drop', type: 'range', min: -0.1, max: 0.1, step: 0.001, digits: 3 },
      ],
      /**
       * The clip drawn inside a device, with a title bar, a bezel and a drop shadow.
       *
       * THE PRESETS ARE PATHS, NEVER BITMAPS. A 1x bitmap frame would be sharp in the
       * 540x960 viewer and soft in the 1080x1920 file, which is the one thing this file
       * exists to prevent. Every preset is `roundRectPath()` plus a handful of fills, so
       * it is exact at any output size.
       *
       * `chromeGeom()` does the whole layout and nothing else does any of it: it is the
       * only place that decides where the device, its bar and its screen are, so the
       * smoke suite asserts the geometry at several aspect ratios without painting.
       */
      draw(L, p) {
        const W = L.W, H = L.H;
        const g = chromeGeom(p, W, H);
        if (!g) return;
        const pre = g.pre;
        const src = take(L, 'fxChA');

        // The shadow first, underneath everything: the device's own silhouette, blurred
        // at 1:1 and cropped back. `ctx.shadowBlur` is not scale-invariant - `round`
        // learned that the hard way - so it is not used here either.
        const sh = clamp(p.shadow, 0, 1);
        const r = Math.max(0, pxMin(p.blur, W, H));
        if (sh > 0.002 && r > 0.05) {
          const sil = clean(L.surface, 'fxChSil', W, H);
          sil.c.fillStyle = '#000';
          roundRectPath(sil.c, g.frame.x, g.frame.y, g.frame.w, g.frame.h, g.radius);
          sil.c.fill();
          if (g.base) {
            sil.c.beginPath();
            sil.c.rect(g.base.x, g.base.y, g.base.w, g.base.h);
            sil.c.fill();
          }
          // NOT edge-extended: a silhouette is already surrounded by transparency and
          // wants to stay that way. See padBlur().
          const b = padBlur(sil.cv, r, W, H, L.surface, 'fxChSh', false);
          L.c.save();
          L.c.globalAlpha = sh;
          L.c.drawImage(b.cv, b.pad, b.pad, W, H, 0, pxMin(p.offsetY, W, H), W, H);
          L.c.restore();
          reset(L.c);
        }

        // The body.
        // An explicit switch rather than an empty colour: a colour input cannot show
        // "unset" - Chromium renders an empty value as black - so a swatch reading black
        // while the frame drew grey would be the panel lying about the picture.
        const body = Number(p.tinted) ? String(p.tint || pre.body) : pre.body;
        L.c.fillStyle = body;
        roundRectPath(L.c, g.frame.x, g.frame.y, g.frame.w, g.frame.h, g.radius);
        L.c.fill();

        // The title bar, its separator and its furniture, clipped to the body's rounding.
        if (g.bar.h > 0.5) {
          L.c.save();
          roundRectPath(L.c, g.frame.x, g.frame.y, g.frame.w, g.frame.h, g.radius);
          L.c.clip();
          L.c.fillStyle = pre.barFill;
          L.c.fillRect(g.bar.x, g.bar.y, g.bar.w, g.bar.h);
          L.c.fillStyle = pre.line;
          const hair = Math.max(1, g.unit * 0.005);
          L.c.fillRect(g.bar.x, g.bar.y + g.bar.h - hair, g.bar.w, hair);
          L.c.restore();
          reset(L.c);

          const dot = g.bar.h * 0.15;
          const cy = g.bar.y + g.bar.h / 2;
          const cols = pre.dark ? ['#4a4f5a', '#4a4f5a', '#4a4f5a'] : ['#ff5f57', '#febc2e', '#28c840'];
          for (let i = 0; i < 3; i++) {
            L.c.fillStyle = cols[i];
            L.c.beginPath();
            L.c.arc(g.bar.x + g.bar.h * (0.42 + i * 0.4), cy, dot, 0, Math.PI * 2);
            L.c.fill();
          }
          // The address pill is a SHAPE, not text. Text would need a font, and a mockup
          // that renders differently because the export lacks one is exactly the drift
          // step 6 got rid of.
          const pw = g.bar.w * 0.44, ph = g.bar.h * 0.44;
          L.c.fillStyle = pre.pill;
          roundRectPath(L.c, g.bar.x + (g.bar.w - pw) / 2, cy - ph / 2, pw, ph, ph / 2);
          L.c.fill();
        }

        // The phone's notch, over the bezel and outside the screen.
        if (pre.notch) {
          const nw = g.frame.w * 0.34, nh = Math.max(1, g.unit * 0.022);
          L.c.fillStyle = '#0b0c10';
          roundRectPath(L.c, g.frame.x + (g.frame.w - nw) / 2, g.frame.y + g.bezel * 0.35,
            nw, nh, nh / 2);
          L.c.fill();
        }

        // The screen: the footage, fitted and CLIPPED to the inner rounding. A clip, not
        // a second scale - clipping is exact and scaling is not. See the unit rule.
        L.c.save();
        roundRectPath(L.c, g.screen.x, g.screen.y, g.screen.w, g.screen.h, g.innerRadius);
        L.c.clip();
        fitDraw(L.c, src, W, H, g.screen, String(p.fit || 'cover'));
        L.c.restore();
        reset(L.c);

        // The laptop base last, so it sits in front of the shadow it casts.
        if (g.base) {
          L.c.fillStyle = pre.baseFill || body;
          roundRectPath(L.c, g.base.x, g.base.y, g.base.w, g.base.h, g.base.h * 0.35);
          L.c.fill();
          L.c.fillStyle = pre.line;
          const lw = g.base.w * 0.16, lh = g.base.h * 0.3;
          roundRectPath(L.c, g.base.x + (g.base.w - lw) / 2, g.base.y, lw, lh, lh / 2);
          L.c.fill();
        }
      },
    },

    background: {
      label: 'Background',
      params: {
        mode: 'gradient',
        colourA: '#101828',
        colourB: '#2b4a8b',
        angle: 0.25,
        zoom: 1.25,
        radius: 0.06,
        dim: 0.35,
        opacity: 1,
      },
      schema: [
        { path: 'params.mode', label: 'Mode', type: 'select',
          options: [
            { value: 'gradient', label: 'Gradient' },
            { value: 'solid', label: 'Solid' },
            { value: 'blur', label: 'Blurred copy of the clip' },
          ] },
        { path: 'params.colourA', label: 'Colour', type: 'color' },
        { path: 'params.colourB', label: 'Colour 2', type: 'color' },
        { path: 'params.angle', label: 'Angle', type: 'range', min: 0, max: 1, step: 0.005, digits: 3 },
        { path: 'params.zoom', label: 'Copy zoom', type: 'range', min: 1, max: 3, step: 0.01, digits: 2 },
        { path: 'params.radius', label: 'Copy blur', type: 'range', min: 0, max: 0.2, step: 0.001, digits: 3 },
        { path: 'params.dim', label: 'Copy dim', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      ],
      /**
       * Something behind the footage, for when the footage no longer fills the frame.
       *
       * It paints the WHOLE layer and puts the picture back on top, so on a clip that
       * still covers the frame it is invisible - which is correct, and is why it belongs
       * after `chrome`, `inset` or a shrinking `transform` rather than before one.
       *
       * The blurred-copy mode is the one place in this file that magnifies on purpose:
       * `zoom` is a design decision, not a blur artefact. The BLUR still goes through
       * `padBlur()` at 1:1, so the radius means the same thing at both resolutions - the
       * magnification and the softening are separate steps and stay that way.
       */
      draw(L, p) {
        const W = L.W, H = L.H;
        const a = clamp(p.opacity, 0, 1);
        if (a <= 0.002) return;
        const src = take(L, 'fxBgA');
        const mode = String(p.mode || 'gradient');

        L.c.save();
        L.c.globalAlpha = a;
        if (mode === 'blur') {
          const z = clamp(p.zoom, 1, 8);
          // THE CLIP, not the layer: by now `chrome` or `inset` may have taken a
          // device-shaped bite out of the layer, and a blurred copy of a hole is not
          // what this mode says on the tin. See baseOf().
          const from = typeof L.base === 'function' ? L.base() : src;
          const plate = clean(L.surface, 'fxBgB', W, H);
          plate.c.drawImage(from, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
          const r = pxMin(p.radius, W, H);
          if (r > 0.05) {
            const b = padBlur(plate.cv, r, W, H, L.surface, 'fxBgP', true);
            L.c.drawImage(b.cv, b.pad, b.pad, W, H, 0, 0, W, H);
          } else {
            L.c.drawImage(plate.cv, 0, 0);
          }
          const dim = clamp(p.dim, 0, 1);
          if (dim > 0.002) {
            L.c.fillStyle = 'rgba(0,0,0,' + dim + ')';
            L.c.fillRect(0, 0, W, H);
          }
        } else if (mode === 'solid') {
          L.c.fillStyle = String(p.colourA || '#000000');
          L.c.fillRect(0, 0, W, H);
        } else {
          // The angle is a TURN, so 0 is left-to-right and 0.25 is top-to-bottom, and a
          // keyframe can take it all the way round without a discontinuity at 360.
          const th = (Number(p.angle) || 0) * Math.PI * 2;
          const cx = W / 2, cy = H / 2;
          const rr = (Math.abs(Math.cos(th)) * W + Math.abs(Math.sin(th)) * H) / 2;
          const gr = L.c.createLinearGradient(
            cx - Math.cos(th) * rr, cy - Math.sin(th) * rr,
            cx + Math.cos(th) * rr, cy + Math.sin(th) * rr);
          gr.addColorStop(0, String(p.colourA || '#000000'));
          gr.addColorStop(1, String(p.colourB || '#000000'));
          L.c.fillStyle = gr;
          L.c.fillRect(0, 0, W, H);
        }
        L.c.restore();
        reset(L.c);
        L.c.drawImage(src, 0, 0);
      },
    },

    spotlight: {
      label: 'Spotlight',
      // Bound, the LIT SHAPE follows and the picture stays still - the opposite of a
      // bound transform, and the reason each type owns its own `apply()`. `x`/`y` are
      // the shape's top-left corner, so the tracked point is centred in it rather than
      // sat in its corner; keyframing `w`/`h` still resizes the light around the point.
      bind: {
        label: 'Follow a track',
        hint: 'Centres the lit shape on the tracked point, plus the offset. ' +
          'Size, feather and dim still come from the sliders.',
        apply(p, pos, off) {
          p.x = pos.x + (Number(off.x) || 0) - (Number(p.w) || 0) / 2;
          p.y = pos.y + (Number(off.y) || 0) - (Number(p.h) || 0) / 2;
        },
      },
      params: {
        shape: 'rect',
        x: 0.2, y: 0.35, w: 0.6, h: 0.3,
        radius: 0.03,
        feather: 0.02,
        dim: 0.6,
        blur: 0.008,
        invert: 0,
      },
      schema: [
        { path: 'params.shape', label: 'Shape', type: 'select',
          options: [
            { value: 'rect', label: 'Rounded rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
          ] },
        { path: 'params.x', label: 'X', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.y', label: 'Y', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.w', label: 'Width', type: 'range', min: 0.01, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.h', label: 'Height', type: 'range', min: 0.01, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.25, step: 0.002, digits: 3 },
        { path: 'params.feather', label: 'Feather', type: 'range', min: 0, max: 0.15, step: 0.001, digits: 3 },
        { path: 'params.dim', label: 'Dim outside', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.blur', label: 'Blur outside', type: 'range', min: 0, max: 0.1, step: 0.001, digits: 3 },
        { path: 'params.invert', label: 'Invert', type: 'check' },
      ],
      /**
       * Light one feature by putting everything else in the dark.
       *
       * THE MASK IS AN ALPHA MASK, and that is the trap this codebase has now hit three
       * times. `destination-in` composites on the ALPHA CHANNEL: a mask painted as opaque
       * black-and-white is opaque everywhere, so it masks NOTHING and the "lit" region
       * comes out as the whole frame. The fill below is rgba(255,255,255,1) and the
       * feather is a blur of THAT ALPHA falling away to rgba(255,255,255,0) - never a
       * fade towards black, which would look right on a white plate and mask nothing.
       *
       * The outside is dimmed with `source-atop` rather than a plain fill, so a layer
       * that is already partly transparent - anything downstream of `chrome` or `inset` -
       * does not have black painted into its empty half.
       *
       * The blur goes through `padBlur()`, so it does not magnify and does not pull a
       * dark rim in from the frame edge.
       */
      draw(L, p) {
        const W = L.W, H = L.H;
        const dim = clamp(p.dim, 0, 1);
        const br = pxMin(p.blur, W, H);
        if (dim <= 0.002 && br <= 0.05) return;
        const box = spotRect(p, W, H);
        if (!(box.w > 0.5 && box.h > 0.5)) return;
        const src = take(L, 'fxSpA');

        // 1. everything, blurred and darkened: what the outside will be.
        const out = clean(L.surface, 'fxSpB', W, H);
        if (br > 0.05) {
          const b = padBlur(src, br, W, H, L.surface, 'fxSpP', true);
          out.c.drawImage(b.cv, b.pad, b.pad, W, H, 0, 0, W, H);
        } else {
          out.c.drawImage(src, 0, 0);
        }
        if (dim > 0.002) {
          out.c.globalCompositeOperation = 'source-atop';
          out.c.fillStyle = 'rgba(0,0,0,' + dim + ')';
          out.c.fillRect(0, 0, W, H);
          reset(out.c);
        }

        // 2. the mask: WHITE WITH ALPHA, feathered by blurring that alpha.
        const mask = clean(L.surface, 'fxSpM', W, H);
        mask.c.fillStyle = 'rgba(255,255,255,1)';
        if (String(p.shape) === 'ellipse') {
          mask.c.beginPath();
          mask.c.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
          mask.c.fill();
        } else {
          roundRectPath(mask.c, box.x, box.y, box.w, box.h, pxMin(p.radius, W, H));
          mask.c.fill();
        }
        let maskCv = mask.cv;
        const fr = pxMin(p.feather, W, H);
        if (fr > 0.05) {
          // A silhouette, so the padding is NOT edge-extended: the softness has to fall
          // away into transparency, which is the whole point of a feather.
          const b = padBlur(mask.cv, fr, W, H, L.surface, 'fxSpF', false);
          const crop = clean(L.surface, 'fxSpM2', W, H);
          crop.c.drawImage(b.cv, b.pad, b.pad, W, H, 0, 0, W, H);
          maskCv = crop.cv;
        }

        // 3. the sharp original, kept only where the mask has alpha.
        const lit = clean(L.surface, 'fxSpC', W, H);
        lit.c.drawImage(src, 0, 0);
        lit.c.globalCompositeOperation = 'destination-in';
        lit.c.drawImage(maskCv, 0, 0);
        reset(lit.c);

        if (!Number(p.invert)) {
          L.c.drawImage(out.cv, 0, 0);
          L.c.drawImage(lit.cv, 0, 0);
          return;
        }

        // Inverted: the treated copy shows THROUGH the shape and the sharp original is
        // everything else - a redaction rather than a spotlight. Same two plates, masked
        // the other way round, so nothing here re-derives the geometry.
        const hole = clean(L.surface, 'fxSpD', W, H);
        hole.c.drawImage(out.cv, 0, 0);
        hole.c.globalCompositeOperation = 'destination-in';
        hole.c.drawImage(maskCv, 0, 0);
        reset(hole.c);
        const rest = clean(L.surface, 'fxSpE', W, H);
        rest.c.drawImage(src, 0, 0);
        rest.c.globalCompositeOperation = 'destination-out';
        rest.c.drawImage(maskCv, 0, 0);
        reset(rest.c);
        L.c.drawImage(rest.cv, 0, 0);
        L.c.drawImage(hole.cv, 0, 0);
      },
    },

    cutout: {
      label: 'Cutout',
      // Bound, the SOURCE REGION follows and the float stays where it was placed. That is
      // the callout: the element being lifted moves down a scrolling page, and the
      // magnified copy sits still in the corner where the viewer is already looking.
      // Binding the destination instead would fling the float around the frame, which is
      // the one thing a callout must not do.
      bind: {
        label: 'Follow a track',
        hint: 'Centres the lifted region on the tracked point, plus the offset. Where the ' +
          'float is drawn does not move.',
        apply(p, pos, off) {
          p.sx = pos.x + (Number(off.x) || 0) - (Number(p.sw) || 0) / 2;
          p.sy = pos.y + (Number(off.y) || 0) - (Number(p.sh) || 0) / 2;
        },
      },
      params: {
        sx: 0.1, sy: 0.4, sw: 0.35, sh: 0.16,
        x: 0.5, y: 0.68,
        scale: 1.9,
        radius: 0.018,
        shadow: 0.5,
        blur: 0.03,
        offsetY: 0.01,
        outline: 0,
        colour: Cursor.ACCENT,
        dimSource: 0.35,
        opacity: 1,
      },
      schema: [
        { path: 'params.sx', label: 'From X', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.sy', label: 'From Y', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.sw', label: 'From width', type: 'range', min: 0.01, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.sh', label: 'From height', type: 'range', min: 0.01, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.x', label: 'To X', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.y', label: 'To Y', type: 'range', min: -0.5, max: 1.5, step: 0.002, digits: 3 },
        { path: 'params.scale', label: 'Scale', type: 'range', min: 0.2, max: 6, step: 0.01, digits: 2 },
        { path: 'params.radius', label: 'Corner radius', type: 'range', min: 0, max: 0.12, step: 0.001, digits: 3 },
        { path: 'params.shadow', label: 'Shadow', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.blur', label: 'Shadow blur', type: 'range', min: 0, max: 0.2, step: 0.001, digits: 3 },
        { path: 'params.offsetY', label: 'Shadow drop', type: 'range', min: -0.1, max: 0.1, step: 0.001, digits: 3 },
        { path: 'params.outline', label: 'Outline', type: 'range', min: 0, max: 0.02, step: 0.0005, digits: 4 },
        { path: 'params.colour', label: 'Outline colour', type: 'color' },
        { path: 'params.dimSource', label: 'Dim the source', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      ],
      /**
       * Lift a region out of the picture, blow it up and float it over the top.
       *
       * The mapping is `cutoutRect()` and nothing else computes it, so the smoke suite
       * asserts source-to-destination directly rather than by hunting for pixels. The
       * destination is the source region scaled ABOUT THE POINT IT IS MOVED TO, which is
       * what keeps a keyframed `scale` growing from where the reader is already looking
       * instead of sliding sideways as it grows.
       */
      draw(L, p) {
        const W = L.W, H = L.H;
        const a = clamp(p.opacity, 0, 1);
        const m = cutoutRect(p, W, H);
        if (!(m.src.w > 0.5 && m.src.h > 0.5) || !(m.dst.w > 0.5 && m.dst.h > 0.5)) return;
        const src = take(L, 'fxCoA');

        // The picture, with the region it came from optionally pushed back. `source-atop`
        // again: an already-transparent layer must not gain a grey rectangle.
        L.c.drawImage(src, 0, 0);
        const ds = clamp(p.dimSource, 0, 1);
        if (ds > 0.002) {
          L.c.save();
          L.c.globalCompositeOperation = 'source-atop';
          L.c.fillStyle = 'rgba(0,0,0,' + ds + ')';
          L.c.fillRect(m.src.x, m.src.y, m.src.w, m.src.h);
          L.c.restore();
          reset(L.c);
        }
        if (a <= 0.002) return;

        // The float, built at its DESTINATION size so the rounding and the outline are
        // exact rather than scaled up along with the pixels.
        const plate = clean(L.surface, 'fxCoB', W, H);
        const rad = pxMin(p.radius, W, H);
        plate.c.save();
        roundRectPath(plate.c, m.dst.x, m.dst.y, m.dst.w, m.dst.h, rad);
        plate.c.clip();
        plate.c.drawImage(src, m.src.x, m.src.y, m.src.w, m.src.h,
          m.dst.x, m.dst.y, m.dst.w, m.dst.h);
        plate.c.restore();
        reset(plate.c);
        const ow = pxMin(p.outline, W, H);
        if (ow > 0.2) {
          plate.c.strokeStyle = String(p.colour || Cursor.ACCENT);
          plate.c.lineWidth = ow;
          roundRectPath(plate.c, m.dst.x + ow / 2, m.dst.y + ow / 2,
            m.dst.w - ow, m.dst.h - ow, Math.max(0, rad - ow / 2));
          plate.c.stroke();
          reset(plate.c);
        }

        // Its shadow, from its own silhouette. Same rule as `chrome` and `round`.
        const sh = clamp(p.shadow, 0, 1);
        const r = Math.max(0, pxMin(p.blur, W, H));
        if (sh > 0.002 && r > 0.05) {
          const sil = clean(L.surface, 'fxCoSil', W, H);
          sil.c.fillStyle = '#000';
          roundRectPath(sil.c, m.dst.x, m.dst.y, m.dst.w, m.dst.h, rad);
          sil.c.fill();
          const b = padBlur(sil.cv, r, W, H, L.surface, 'fxCoSh', false);
          L.c.save();
          L.c.globalAlpha = sh * a;
          L.c.drawImage(b.cv, b.pad, b.pad, W, H, 0, pxMin(p.offsetY, W, H), W, H);
          L.c.restore();
          reset(L.c);
        }

        L.c.save();
        L.c.globalAlpha = a;
        L.c.drawImage(plate.cv, 0, 0);
        L.c.restore();
        reset(L.c);
      },
    },

    /**
     * MAGIC MASK. The matte cut from `clip.masks` is applied to the layer.
     *
     * By step 12 this needed no new plumbing at all, which is exactly why it sits here
     * and not at the start: step 5 gave the compositor alpha, step 6 made the bake the
     * single draw path, and step 7 made an effect one function. So an extracted object is
     * one `destination-in` and a stack order.
     *
     * THE MATTE COMES FROM A PROVIDER, for the same reason a binding does. The pixels of
     * a matte are the output of a neural network over a decoded frame, which is neither
     * synchronous nor something this file could reach: it would need the media element,
     * the disk cache, the clip's framing and an IPC round trip. So `app.js` installs
     * `FX.setMatteProvider()`, hands back a W x H plate whose ALPHA is the matte, and
     * takes on the matching duty of putting the prompts into the render key
     * (`maskDigest()`). With no provider installed - a bare module load, a suite checking
     * this file alone - the effect draws the clip untouched, which is the honest answer:
     * "there is no matte yet" must never mean "there is no clip".
     *
     * The provider applies `feather`, `grow`, `invert` and `mix` because it holds the
     * matte as a plane and those operations are plane operations; they are parameters
     * HERE so that every one of them keyframes through `Anim` for free - which is what
     * lets a matte open up over two seconds, or a choke ride in as a face turns.
     */
    matte: {
      label: 'Magic Mask',
      needs: 'mask',
      // The matte moves every frame whether or not anything is keyed, so the shutter has
      // something real to average and `timeVarying` must say so - see `drawBlurred()`.
      timeVarying: true,
      params: { mask: '', feather: 0.004, grow: 0, invert: 0, mix: 1 },
      schema: [
        {
          path: 'params.mask', label: 'Mask', type: 'select',
          // Built from the CLIP, not from a fixed list: the options are the masks painted
          // on this clip, and there is no second place that knows their names.
          optionsFor: (clip) => [{ value: '', label: 'First mask on this clip' }].concat(
            ((clip && clip.masks) || []).map((m) => ({ value: m.id, label: m.name }))),
        },
        { path: 'params.feather', label: 'Feather', type: 'range', min: 0, max: 0.08, step: 0.001, digits: 3 },
        { path: 'params.grow', label: 'Grow / choke', type: 'range', min: -0.04, max: 0.04, step: 0.001, digits: 3 },
        { path: 'params.mix', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.invert', label: 'Invert (cut the object out)', type: 'check' },
      ],
      draw(L, p, t, entry, clip) {
        const plate = MATTE ? MATTE(clip, entry, t, L.W, L.H, p) : null;
        if (!plate) return;                       // no matte yet: the clip is untouched
        const src = take(L, 'fxA');
        L.c.save();
        L.c.drawImage(src, 0, 0);
        // `destination-in` keeps the layer where the plate has ALPHA. The plate is built
        // as transparency, never as black-and-white - this codebase has now hit that four
        // times, and the symptom is never an error, it is a matte that masks nothing.
        L.c.globalCompositeOperation = 'destination-in';
        L.c.drawImage(plate, 0, 0, L.W, L.H);
        L.c.restore();
        reset(L.c);
      },
    },

    // ------------------------------------------------------- the finishing pass
    //
    // Four of the six things step 16 asked for are here; the other two are elsewhere on
    // purpose. The SOFT VIGNETTE is `round` in its inner mode - it was built as this
    // file's second effect and darkens the frame's edges exactly as a vignette does, so a
    // second type would have been the same draw under a different label. The MASTER GRADE
    // is not a type at all: it is this same stack run once over the finished composite,
    // through `renderMaster()` below.
    //
    // All four are cheap enough to run at preview resolution, which is a requirement
    // rather than a hope: the viewer repaints them on every frame of playback. `lut` and
    // `grain` are the two that touch every pixel, and both say below what they do about it.

    lut: {
      label: 'LUT (.cube)',
      // A PATH, never the table. A 33-cube is 36k triplets: putting one on a clip would
      // put it into every undo snapshot and into the .scut file, which is the rule this
      // whole architecture is built on. The table is held by path in `lutTables` and read
      // through an injected reader, exactly as an imported PNG pointer is.
      params: { lut: '', amount: 1 },
      schema: [
        { path: 'params.amount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      ],
      /**
       * Trilinear, per pixel, against the cube as loaded - NOT against a coarser table
       * baked from it.
       *
       * A 64-step dense table with a nearest lookup would be four times faster and was
       * the first build, and it is wrong for one reason that matters here: an identity
       * cube has to be a PIXEL-EXACT no-op, and a quantised table answers the value at
       * the nearest grid centre instead of the value asked for, so a neutral LUT moved
       * every channel by up to two levels. Trilinear interpolation of an identity map is
       * exact by construction - the interpolant of a linear function is that function -
       * so the no-op falls out of the maths rather than out of a special case.
       */
      draw(L, p) {
        const lut = lutFor(p.lut);
        if (!lut) return;                      // nothing loaded yet: the clip is untouched
        const amount = clamp(p.amount, 0, 1);
        if (amount <= 0.0005) return;
        const W = L.W, H = L.H;
        const img = L.c.getImageData(0, 0, W, H);
        applyLUT(img.data, lut, amount);
        L.c.putImageData(img, 0, 0);
      },
    },

    bloom: {
      label: 'Bloom',
      params: { threshold: 0.72, intensity: 0.6, radius: 0.03 },
      schema: [
        { path: 'params.threshold', label: 'Threshold', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.intensity', label: 'Intensity', type: 'range', min: 0, max: 3, step: 0.01, digits: 2 },
        { path: 'params.radius', label: 'Radius', type: 'range', min: 0.002, max: 0.2, step: 0.002, digits: 3 },
      ],
      /**
       * Highlights above `threshold`, blurred and added back.
       *
       * The extraction and the blur happen on a plate of a FIXED SIZE - 256 px on the
       * long side - and the result is scaled back up. That is not only a saving: it is
       * what makes the bloom the same shape in the 540x960 viewer and the 1080x1920 file.
       * A plate sized as a fraction of the frame would blur a different number of pixels
       * at the two resolutions, and `padBlur()`'s own comment explains what that costs.
       *
       * The plate is masked to the layer's own alpha before it is added, for the reason
       * at the top of this file: `lighter` over transparency would let a logo's glow
       * spill onto the layers underneath it, and the effect would then behave one way
       * over video and another over nothing.
       */
      draw(L, p) {
        const intensity = clamp(p.intensity, 0, 3);
        if (intensity <= 0.002) return;
        const W = L.W, H = L.H;
        const src = take(L, 'fxA');
        L.c.drawImage(src, 0, 0);

        const PL = 256;
        const PW = W >= H ? PL : Math.max(8, Math.round(PL * W / H));
        const PH = W >= H ? Math.max(8, Math.round(PL * H / W)) : PL;
        const small = clean(L.surface, 'fxBloomS', PW, PH);
        small.c.drawImage(src, 0, 0, PW, PH);
        const img = small.c.getImageData(0, 0, PW, PH);
        const d = img.data;
        const thr = clamp(p.threshold, 0, 0.999);
        const span = 1 - thr;
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          // Rec.709 luma, the same weights the grade calls brightness.
          const y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          const v = y <= thr ? 0 : (span <= 0 ? 1 : (y - thr) / span);
          // The colour is kept and the ALPHA carries how much of it blooms, so a warm
          // highlight blooms warm rather than white.
          d[i + 3] = Math.round(d[i + 3] * (v > 1 ? 1 : v));
        }
        small.c.putImageData(img, 0, 0);

        const r = pxMin(clamp(p.radius, 0, 0.5), PW, PH);
        const soft = padBlur(small.cv, r, PW, PH, L.surface, 'fxBloomB', false);
        const glow = clean(L.surface, 'fxBloomG', W, H);
        glow.c.drawImage(soft.cv, soft.pad, soft.pad, PW, PH, 0, 0, W, H);
        glow.c.globalCompositeOperation = 'destination-in';
        glow.c.drawImage(src, 0, 0);
        reset(glow.c);

        // An intensity above 1 is more passes of the same glow rather than a clamp, so
        // the slider keeps meaning something past the point where one pass saturates.
        L.c.globalCompositeOperation = 'lighter';
        for (let n = intensity; n > 0; n -= 1) {
          L.c.globalAlpha = Math.min(1, n);
          L.c.drawImage(glow.cv, 0, 0);
        }
        reset(L.c);
      },
    },

    grain: {
      label: 'Film grain',
      params: { amount: 0.14, scale: 1, seed: 1 },
      schema: [
        { path: 'params.amount', label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
        { path: 'params.scale', label: 'Speck size', type: 'range', min: 0.125, max: 1, step: 0.125, digits: 3 },
        { path: 'params.seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1 },
      ],
      /**
       * SEEDED, and built at a fixed small size then scaled - the rule the film burn's
       * streaks already live by, for the same reason.
       *
       * The preview and the baker build this texture independently, in two different
       * canvases, at two different resolutions. `Math.random()` would therefore make them
       * disagree on every single frame: the export would carry grain that was never
       * previewed, and no amount of comparing would ever find it because it would be
       * different again next time. `mulberry32(seed)` makes the map a pure function of
       * the seed, and a 256 px map scaled to the frame makes it a pure function of the
       * seed at every resolution - which is exactly what `smoke-finish.js` asserts.
       *
       * Grain that SCALES is the deliberate choice here. Real grain is a fixed physical
       * size and would be finer in a larger frame, but this app's whole contract is that
       * the viewer shows the file scaled down; grain built per output pixel would be
       * invisible in the viewer and crawling in the export.
       *
       * `overlay` is the blend, so a mid-grey map leaves the picture alone and only the
       * noise around it lifts and darkens. The map is masked to the layer's alpha first:
       * `overlay` onto transparency shows the grey plate itself, which would fill the
       * frame around a logo with flat grey.
       */
      draw(L, p) {
        const amount = clamp(p.amount, 0, 1);
        if (amount <= 0.002) return;
        const W = L.W, H = L.H;
        const src = take(L, 'fxA');
        L.c.drawImage(src, 0, 0);

        const map = grainMap(Math.round(Number(p.seed) || 1));
        if (!map) return;
        const plate = clean(L.surface, 'fxGrainP', W, H);
        // Tiles, so a smaller speck is the same map laid down more times rather than a
        // different map. `n` is an integer for the same reason the map is seeded: a
        // fractional tiling would land the seams at different sub-pixel phases in the
        // viewer and in the file.
        const n = Math.max(1, Math.min(8, Math.round(1 / clamp(p.scale, 0.125, 1))));
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            plate.c.drawImage(map, i * W / n, j * H / n, W / n, H / n);
          }
        }
        plate.c.globalCompositeOperation = 'destination-in';
        plate.c.drawImage(src, 0, 0);
        reset(plate.c);

        L.c.globalCompositeOperation = 'overlay';
        L.c.globalAlpha = amount;
        L.c.drawImage(plate.cv, 0, 0);
        reset(L.c);
      },
    },
  };

  /**
   * The matte provider, injected by `app.js`. See the `matte` type above for why.
   *
   *   provider(clip, entry, t, W, H, params) -> a W x H canvas whose ALPHA is the matte,
   *                                             or null when there is not one yet.
   */
  let MATTE = null;
  function setMatteProvider(fn) { MATTE = typeof fn === 'function' ? fn : null; }

  const TYPES = Object.keys(DEFS);

  // ------------------------------------------------------------ framing geometry
  //
  // The layout half of step 10's four effects, kept out of their `draw()`s and exported,
  // because geometry is the part worth asserting: a smoke suite can check where a device
  // frame lands at six aspect ratios without painting a single pixel, and a pixel test
  // that failed would then not be able to say whether the layout or the paint was wrong.

  /**
   * The device presets, as NUMBERS AND COLOURS - never bitmaps.
   *
   * Every length here is in SCREEN WIDTHS, so a preset is a shape rather than a size and
   * `chromeGeom()` scales the whole thing to fit whatever room `pad` leaves. That is what
   * makes a preset resolution-independent for free: there is no pixel anywhere in it.
   *
   *   aspect   the screen's own w/h, used when the author leaves `aspect` at 0
   *   bezel    the body's border around the screen
   *   bar      the title bar's height, 0 for a device that has none
   *   base     the laptop's foot: [height, width] again in screen widths
   */
  const CHROME = {
    browser: {
      aspect: 16 / 10, bezel: 0.012, bar: 0.07,
      body: '#f4f5f7', barFill: '#e8eaee', line: '#d2d6de', pill: '#ffffff', dark: false,
    },
    browserDark: {
      aspect: 16 / 10, bezel: 0.012, bar: 0.07,
      body: '#171a21', barFill: '#20242d', line: '#2f343f', pill: '#2b3039', dark: true,
    },
    laptop: {
      aspect: 16 / 10, bezel: 0.028, bar: 0,
      body: '#2a2e37', barFill: '#2a2e37', line: '#3c424e', pill: '#3c424e', dark: true,
      base: [0.035, 1.16], baseFill: '#20242c',
    },
    phone: {
      aspect: 9 / 19.5, bezel: 0.05, bar: 0,
      body: '#14161c', barFill: '#14161c', line: '#262a33', pill: '#262a33', dark: true,
      notch: true,
    },
  };

  /**
   * Where the device, its title bar and its screen land, in pixels at the size being
   * painted. `null` if there is no room left for one.
   *
   * The whole layout is built in SCREEN WIDTHS and scaled by a single factor `k` at the
   * end, which is the only reason a preset can be a handful of ratios: the device is
   * assembled at its natural proportions and then made to fit, rather than each part
   * being fitted separately and drifting out of proportion at extreme aspect ratios.
   *
   * `pad` and `radius` go through `pxMin()` like every other length in this file, so the
   * same parameters give the same picture at 135x240 and at 1080x1920.
   */
  function chromeGeom(p, W, H) {
    const pre = CHROME[String(p.preset)] || CHROME.browser;
    const padPx = Math.max(0, pxMin(clamp(p.pad, 0, 0.45), W, H));
    const availW = W - 2 * padPx, availH = H - 2 * padPx;
    if (!(availW > 2 && availH > 2)) return null;

    const ar = Number(p.aspect) > 0.01 ? clamp(p.aspect, 0.05, 20) : pre.aspect;
    // In screen widths: the screen is 1 wide by 1/ar tall, and everything else hangs off
    // that. `unit` is what one screen width turns out to be in pixels.
    const sh = 1 / ar;
    const outW = 1 + 2 * pre.bezel;
    const outH = sh + 2 * pre.bezel + pre.bar;
    const baseH = pre.base ? pre.base[0] : 0;
    const baseW = pre.base ? pre.base[1] : 0;
    const totalW = Math.max(outW, baseW);
    const totalH = outH + baseH;
    const unit = Math.min(availW / totalW, availH / totalH);
    if (!(unit > 0.5)) return null;

    const ox = W / 2 + pxMin(p.x, W, H) - (totalW * unit) / 2;
    const oy = H / 2 + pxMin(p.y, W, H) - (totalH * unit) / 2;
    const fx0 = ox + (totalW - outW) * unit / 2;

    const frame = { x: fx0, y: oy, w: outW * unit, h: outH * unit };
    const bar = { x: frame.x, y: frame.y, w: frame.w, h: pre.bar * unit };
    const screen = {
      x: frame.x + pre.bezel * unit,
      y: frame.y + pre.bar * unit + pre.bezel * unit,
      w: unit,
      h: sh * unit,
    };
    const radius = Math.min(pxMin(p.radius, W, H), frame.w / 2, frame.h / 2);
    return {
      pre, unit, frame, bar, screen, radius,
      // The screen's rounding follows the body's, inset by the bezel, so the two curves
      // stay concentric instead of the inner one looking wrong at a large radius.
      innerRadius: Math.max(0, Math.min(radius - pre.bezel * unit, screen.w / 2, screen.h / 2)),
      base: pre.base
        ? { x: ox + (totalW - baseW) * unit / 2, y: oy + outH * unit, w: baseW * unit, h: baseH * unit }
        : null,
    };
  }

  /**
   * Draw a full-frame source into a destination rect, filling it or fitting inside it.
   *
   * `cover` crops the long axis; `contain` letterboxes to TRANSPARENCY rather than to
   * black, because whatever is under the layer has to come through - the same reason
   * `inset` clears instead of filling.
   */
  function fitDraw(c, src, SW, SH, dst, mode) {
    const sa = SW / SH, da = dst.w / dst.h;
    if (mode === 'contain') {
      const w = sa > da ? dst.w : dst.h * sa;
      const h = sa > da ? dst.w / sa : dst.h;
      c.drawImage(src, dst.x + (dst.w - w) / 2, dst.y + (dst.h - h) / 2, w, h);
      return;
    }
    // cover: take the largest source rect of the destination's aspect, centred.
    const cw = sa > da ? SH * da : SW;
    const ch = sa > da ? SH : SW / da;
    c.drawImage(src, (SW - cw) / 2, (SH - ch) / 2, cw, ch, dst.x, dst.y, dst.w, dst.h);
  }

  /** The spotlight's window in pixels. Its own function so the mask and a test agree. */
  function spotRect(p, W, H) {
    return {
      x: (Number(p.x) || 0) * W,
      y: (Number(p.y) || 0) * H,
      w: Math.max(0, Number(p.w) || 0) * W,
      h: Math.max(0, Number(p.h) || 0) * H,
    };
  }

  /**
   * The cutout's source-to-destination mapping, in pixels.
   *
   * `x`/`y` are the CENTRE of the destination, not its corner, so `scale` grows the
   * float about the point the author placed it on rather than dragging it down and right
   * as it gets bigger - which matters the moment `scale` carries a keyframe.
   */
  function cutoutRect(p, W, H) {
    const s = clamp(p.scale, 0.05, 12);
    const sw = Math.max(0, Number(p.sw) || 0) * W;
    const sh = Math.max(0, Number(p.sh) || 0) * H;
    const dw = sw * s, dh = sh * s;
    return {
      src: { x: (Number(p.sx) || 0) * W, y: (Number(p.sy) || 0) * H, w: sw, h: sh },
      dst: {
        x: (Number(p.x) || 0) * W - dw / 2,
        y: (Number(p.y) || 0) * H - dh / 2,
        w: dw, h: dh,
      },
    };
  }


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


  // ---------------------------------------------------------------- the LUT loader

  /**
   * A .cube file, parsed.
   *
   *   { n, data: Float32Array(n*n*n*3), min: [r,g,b], max: [r,g,b], title }
   *
   * `data` is indexed the way the format is written: RED FASTEST, then green, then blue.
   * Getting that backwards is the classic .cube bug and it does not look like an error -
   * it looks like a grade with the red and blue channels swapped, which is easy to
   * mistake for the LUT being "a cool one".
   *
   * 1D cubes (`LUT_1D_SIZE`) are refused rather than half-supported: a 1D LUT is three
   * curves, which is what the `grade` effect already is, and silently treating one as a
   * cube would make a mess of it.
   */
  function parseCube(text) {
    const src = String(text || '');
    let n = 0, title = '';
    const min = [0, 0, 0], max = [1, 1, 1];
    const rows = [];
    let oneD = false;
    for (const raw of src.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const up = line.toUpperCase();
      if (up.startsWith('TITLE')) { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
      if (up.startsWith('LUT_3D_SIZE')) { n = parseInt(line.split(/\s+/)[1], 10) || 0; continue; }
      if (up.startsWith('LUT_1D_SIZE')) { oneD = true; continue; }
      if (up.startsWith('DOMAIN_MIN')) {
        const v = line.split(/\s+/).slice(1).map(Number);
        for (let i = 0; i < 3; i++) if (isFinite(v[i])) min[i] = v[i];
        continue;
      }
      if (up.startsWith('DOMAIN_MAX')) {
        const v = line.split(/\s+/).slice(1).map(Number);
        for (let i = 0; i < 3; i++) if (isFinite(v[i])) max[i] = v[i];
        continue;
      }
      if (/^[-+.\d]/.test(line)) {
        const v = line.split(/\s+/).map(Number);
        if (v.length >= 3 && isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2])) rows.push(v);
      }
    }
    if (oneD && !n) return { ok: false, error: 'That is a 1D LUT. Use the Grade effect instead - it is the same three curves.' };
    if (!n || n < 2 || n > 128) return { ok: false, error: 'No usable LUT_3D_SIZE in that .cube file.' };
    const need = n * n * n;
    if (rows.length < need) {
      return { ok: false, error: 'That .cube says LUT_3D_SIZE ' + n + ' - ' + need +
        ' rows - but carries ' + rows.length + '.' };
    }
    const data = new Float32Array(need * 3);
    for (let i = 0; i < need; i++) {
      data[i * 3] = rows[i][0];
      data[i * 3 + 1] = rows[i][1];
      data[i * 3 + 2] = rows[i][2];
    }
    return { ok: true, lut: { n, data, min, max, title } };
  }

  /** One cube entry, by grid index. Red is the fastest axis - see `parseCube()`. */
  function cubeAt(lut, i, j, k, out) {
    const n = lut.n;
    const o = ((k * n + j) * n + i) * 3;
    out[0] = lut.data[o]; out[1] = lut.data[o + 1]; out[2] = lut.data[o + 2];
    return out;
  }

  const lutC0 = new Float32Array(3), lutC1 = new Float32Array(3);

  /**
   * Trilinear sample. `r`,`g`,`b` are 0..1 in the LUT's own domain; the answer is 0..1.
   *
   * Written out rather than looped because it is the inner loop of a full-frame pixel
   * pass: eight corners, three lerps along red, two along green, one along blue.
   */
  function sampleLUT(lut, r, g, b) {
    const n = lut.n, m = n - 1;
    const dom = (v, i) => {
      const lo = lut.min[i], hi = lut.max[i];
      const span = hi - lo;
      const u = span > 1e-9 ? (v - lo) / span : 0;
      return u < 0 ? 0 : u > 1 ? 1 : u;
    };
    const x = dom(r, 0) * m, y = dom(g, 1) * m, z = dom(b, 2) * m;
    const i0 = Math.min(m, Math.floor(x)), j0 = Math.min(m, Math.floor(y)), k0 = Math.min(m, Math.floor(z));
    const i1 = Math.min(m, i0 + 1), j1 = Math.min(m, j0 + 1), k1 = Math.min(m, k0 + 1);
    const fx = x - i0, fy = y - j0, fz = z - k0;
    const out = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const c000 = cubeAt(lut, i0, j0, k0, lutC0)[ch], c100 = cubeAt(lut, i1, j0, k0, lutC1)[ch];
      const c00 = c000 + (c100 - c000) * fx;
      const c010 = cubeAt(lut, i0, j1, k0, lutC0)[ch], c110 = cubeAt(lut, i1, j1, k0, lutC1)[ch];
      const c01 = c010 + (c110 - c010) * fx;
      const c001 = cubeAt(lut, i0, j0, k1, lutC0)[ch], c101 = cubeAt(lut, i1, j0, k1, lutC1)[ch];
      const c10 = c001 + (c101 - c001) * fx;
      const c011 = cubeAt(lut, i0, j1, k1, lutC0)[ch], c111 = cubeAt(lut, i1, j1, k1, lutC1)[ch];
      const c11 = c011 + (c111 - c011) * fx;
      const c0 = c00 + (c01 - c00) * fy;
      const c1 = c10 + (c11 - c10) * fy;
      out[ch] = c0 + (c1 - c0) * fz;
    }
    return out;
  }

  /**
   * Apply a cube to an RGBA byte array in place, mixed `amount` of the way.
   *
   * Alpha is untouched, and a fully transparent pixel is skipped - the same two rules the
   * `grade` pass keeps. `ImageData` is unpremultiplied, so the colour of a half-
   * transparent pixel is meaningful and needs no undoing of a premultiply.
   */
  function applyLUT(d, lut, amount) {
    const a = amount == null ? 1 : clamp(amount, 0, 1);
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const o = sampleLUT(lut, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
      let r = o[0] * 255, g = o[1] * 255, b = o[2] * 255;
      if (a !== 1) {
        r = d[i] + (r - d[i]) * a;
        g = d[i + 1] + (g - d[i + 1]) * a;
        b = d[i + 2] + (b - d[i + 2]) * a;
      }
      r = Math.round(r); g = Math.round(g); b = Math.round(b);
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    return d;
  }

  /** True when a cube maps every grid point to itself, so it cannot change a pixel. */
  function isIdentityLUT(lut) {
    if (!lut) return false;
    const n = lut.n, m = n - 1;
    for (let i = 0; i < 3; i++) if (Math.abs(lut.min[i]) > 1e-6 || Math.abs(lut.max[i] - 1) > 1e-6) return false;
    const c = new Float32Array(3);
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          cubeAt(lut, i, j, k, c);
          if (Math.abs(c[0] - i / m) > 1e-5) return false;
          if (Math.abs(c[1] - j / m) > 1e-5) return false;
          if (Math.abs(c[2] - k / m) > 1e-5) return false;
        }
      }
    }
    return true;
  }

  /**
   * LUTs held by path, exactly as imported pointers are - and for exactly the same
   * reasons. `draw()` is synchronous and must never stall, so this hands back `null`
   * while a file is still being read and the effect draws the clip untouched. That is
   * right for the viewer, where the next frame is 16 ms away, and WRONG for the baker,
   * where a missed frame is in the file forever: `preloadLuts()` is the one door the
   * baker goes through first, the way `preloadImages()` already is.
   *
   * The READER is injected, because reading a file is not this file's business: the
   * renderer has no `fs`, the path comes back through IPC, and a suite running fx.js on
   * its own can hand it a reader over a string. With none installed nothing loads and
   * every `lut` effect is a no-op, which is the honest answer rather than a broken one.
   */
  const lutTables = new Map();
  let LUT_READER = null;
  function setLutReader(fn) { LUT_READER = typeof fn === 'function' ? fn : null; }

  /** Put a parsed cube in the cache directly - what a smoke suite and a preset use. */
  function putLut(path, text, info) {
    const key = String(path || '');
    if (!key) return { ok: false, error: 'no path' };
    const r = parseCube(text);
    lutTables.set(key, r.ok
      ? { lut: r.lut, info: Object.assign({ n: r.lut.n }, info || {}), pending: false }
      : { lut: null, error: r.error, info: null, pending: false });
    return r;
  }

  function lutFor(path) {
    const key = String(path || '');
    if (!key) return null;
    const rec = lutTables.get(key);
    if (rec) return rec.lut;
    if (!LUT_READER) return null;
    // Started once, never re-tried on every frame: a dead path must cost one read.
    lutTables.set(key, { lut: null, pending: true, info: null });
    Promise.resolve()
      .then(() => LUT_READER(key))
      .then((r) => {
        if (!r || !r.ok) {
          lutTables.set(key, { lut: null, pending: false, info: null, error: (r && r.error) || 'unreadable' });
          return;
        }
        putLut(key, r.text, { size: r.size, mtime: r.mtime, name: r.name });
      })
      .catch((e) => lutTables.set(key, { lut: null, pending: false, info: null, error: String(e && e.message || e) }));
    return null;
  }

  /** What the panel needs to say about a path: loaded, still reading, or why not. */
  function lutState(path) {
    const rec = lutTables.get(String(path || ''));
    if (!rec) return String(path || '') ? { pending: true } : { empty: true };
    if (rec.lut) return { ok: true, n: rec.lut.n, title: rec.lut.title, identity: isIdentityLUT(rec.lut) };
    return rec.pending ? { pending: true } : { error: rec.error || 'unreadable' };
  }

  /**
   * A digest of what a path's table actually IS, for the render key.
   *
   * A path alone would not do: swapping the file at that path for a different grade is a
   * different picture, and the cached render of the old one would come straight back.
   * Size and mtime come from the reader; `n` and a cheap sum over the table are computed
   * here so a hand-installed cube (a preset, a suite) keys honestly too.
   */
  function lutDigest(path) {
    const rec = lutTables.get(String(path || ''));
    if (!rec || !rec.lut) return null;
    const d = rec.lut.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 7) sum = (sum + d[i] * 1e6) % 4294967296;
    const info = rec.info || {};
    return rec.lut.n + ':' + Math.round(sum) + ':' + (info.size || 0) + ':' + (info.mtime || 0);
  }

  /** Every LUT path a set of stacks names - clips, and the project's master stack. */
  function lutPaths(clips, master) {
    const paths = new Set();
    const scan = (stack) => {
      for (const f of (stack || [])) {
        if (f && f.type === 'lut' && f.params && f.params.lut) paths.add(String(f.params.lut));
      }
    };
    for (const c of (clips || [])) scan(c && c.fx);
    scan(master);
    return [...paths];
  }

  /**
   * Read every cube a render needs before a single frame is baked.
   *
   * A path that will not read resolves anyway: a missing file must not hang a render, and
   * an unapplied LUT is a defensible fallback - the same contract `preloadImages()` keeps
   * for a pointer that will not decode.
   */
  function preloadLuts(clips, master) {
    return Promise.all(lutPaths(clips, master).map((path) => {
      if (lutFor(path)) return Promise.resolve();
      if (!LUT_READER) return Promise.resolve();
      return new Promise((done) => {
        const t0 = Date.now();
        const tick = () => {
          const rec = lutTables.get(path);
          if (!rec || !rec.pending || Date.now() - t0 > 3000) return done();
          setTimeout(tick, 16);
        };
        tick();
      });
    }));
  }

  // ------------------------------------------------------------------- the grain map

  /**
   * Seeded randomness, the same generator `transitions.js` uses for its burn and luma
   * maps - and here for the same reason, stated at length on the `grain` type: the
   * preview and the baker build the texture independently, so an unseeded one would put
   * grain in the file that was never on screen.
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

  /**
   * A 256x256 monochrome noise plate, mid-grey based so `overlay` leaves the picture
   * alone where the noise is neutral. Held by seed: built once per seed per session, and
   * a FIXED SIZE at every output resolution, which is the whole point of it.
   */
  const GRAIN_SIZE = 256;
  const grainMaps = new Map();
  function grainMap(seed) {
    const key = String(seed);
    const hit = grainMaps.get(key);
    if (hit) return hit;
    if (typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = GRAIN_SIZE; cv.height = GRAIN_SIZE;
    const c = cv.getContext('2d');
    const img = c.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    const d = img.data;
    const rnd = mulberry32((seed || 1) * 2654435761 + 11);
    for (let i = 0; i < d.length; i += 4) {
      // Two samples averaged: a flat uniform plate reads as static, and the triangular
      // distribution this gives clusters around neutral the way real grain does.
      const v = Math.round(((rnd() + rnd()) / 2) * 255);
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    grainMaps.set(key, cv);
    return cv;
  }

  // ------------------------------------------------------------------ matching two clips

  /**
   * The black point, mid-grey and white point of a frame, as 0..1 luma.
   *
   * PERCENTILES, not the extremes: one blown speculum or one crushed shadow pixel would
   * otherwise define the whole range, and a single hot pixel would then rewrite the
   * grade. Transparent pixels are ignored, so measuring a logo measures the logo.
   */
  function lumaStats(data, lo, hi) {
    const pLo = lo == null ? 0.01 : lo, pHi = hi == null ? 0.99 : hi;
    const hist = new Float64Array(256);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      hist[Math.max(0, Math.min(255, Math.round(y)))]++;
      n++;
    }
    if (!n) return null;
    const at = (p) => {
      let want = p * n, acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= want) return v / 255;
      }
      return 1;
    };
    return { black: at(pLo), mid: at(0.5), white: at(pHi), n };
  }

  /**
   * Gain, lift and gamma that carry `src`'s three points onto `ref`'s.
   *
   * SOLVED ALL THREE AT ONCE, and that is the whole subtlety of this function.
   *
   * `gradeLUT()` applies gain, then lift, then gamma, so the curve is
   *
   *   f(v) = (v * gain + lift) ^ (1 / gamma)
   *
   * and the obvious build - fit gain and lift to the two end points, then spend gamma on
   * mid-grey - is WRONG, because gamma is not a mid-tone control. A power moves every
   * value but 0 and 1, so the gamma that lands the mid-grey walks the black point back
   * off the reference: fitting the ends first and the middle second measured the black
   * point landing at 0.046 against a reference of 0.02, and `smoke-finish.js` caught it.
   *
   * Inverting the equations instead makes all three exact. Writing g = gain and l = lift:
   *
   *   b * g + l = ref.black ^ gamma
   *   w * g + l = ref.white ^ gamma
   *   m * g + l = ref.mid   ^ gamma
   *
   * The first two give g and l for any gamma; substituting into the third leaves one
   * equation in gamma alone, which is solved by bisection - monotone in practice, and
   * bounded to the same 0.2..3 the slider is, so a hopeless fit answers "as close as the
   * range allows" rather than an absurdity.
   *
   * A degenerate input - a flat frame, a black frame - answers the neutral grade rather
   * than an infinity. Nothing here touches saturation or temperature: matching the TONE
   * is what makes mixed footage sit together, and a hue match on two different subjects
   * is as likely to be wrong as right.
   */
  function matchGrade(src, ref) {
    const out = Object.assign({}, GRADE_NEUTRAL);
    if (!src || !ref) return out;
    const b = src.black, w = src.white, m = src.mid;
    const sSpan = w - b, rSpan = ref.white - ref.black;
    if (!(sSpan > 0.004) || !(rSpan > 0.004)) return out;

    // Where mid-grey sits between the two end points. It is the same fraction on both
    // sides of the fit, which is what the residual below measures.
    const k = clamp((m - b) / sSpan, 0, 1);
    const pw = (v, g) => Math.pow(Math.max(0, Math.min(1, v)), g);
    const resid = (g) => k * (pw(ref.white, g) - pw(ref.black, g)) + pw(ref.black, g) - pw(ref.mid, g);

    let gamma = 1;
    let lo = 0.2, hi = 3;
    const fLo = resid(lo), fHi = resid(hi);
    if (isFinite(fLo) && isFinite(fHi) && fLo * fHi < 0) {
      for (let i = 0; i < 40; i++) {
        const midG = (lo + hi) / 2;
        if (resid(lo) * resid(midG) <= 0) hi = midG; else lo = midG;
      }
      gamma = (lo + hi) / 2;
    } else if (Math.abs(fLo) < Math.abs(fHi)) {
      gamma = lo;
    } else if (isFinite(fHi) && Math.abs(fHi) < Math.abs(fLo)) {
      gamma = hi;
    }
    gamma = clamp(gamma, 0.2, 3);

    const gain = clamp((pw(ref.white, gamma) - pw(ref.black, gamma)) / sSpan, 0.05, 8);
    const lift = clamp(pw(ref.black, gamma) - b * gain, -0.5, 0.5);
    out.gain = Math.round(gain * 1000) / 1000;
    out.lift = Math.round(lift * 1000) / 1000;
    out.gamma = Math.round(gamma * 1000) / 1000;
    return out;
  }

  // ------------------------------------------------------------- the project master pass

  /**
   * The project's own stack, run ONCE over a finished frame.
   *
   * This is the whole of the master grade: there is no second implementation of a LUT or
   * of grain for it, and no ffmpeg half. The frame that has just been composited is
   * copied, handed back to `render()` as the "paint" of a clip with no clip, and the
   * finished layer is drawn over the top. A LUT applied per clip and the same LUT applied
   * here therefore cannot drift, because they are the same function.
   *
   * WHICH TYPES ARE ALLOWED, and why it is a short list. `cursor`, `ripple` and `matte`
   * read something recorded alongside a CLIP, and there is no clip here - they would draw
   * nothing, or worse, read the first clip they were handed. `MASTER_TYPES` is what the
   * panel offers and `normalizeStack()` is what enforces it, so a hand-edited project
   * cannot get a `matte` into the master pass.
   *
   * `t` is TIMELINE time, not clip-local: the master stack belongs to the project and has
   * no in-point to be timed from. Keys on it are therefore timeline seconds, which is the
   * one place in the app where that is true, and the panel says so.
   */
  const MASTER_TYPES = ['grade', 'lut', 'bloom', 'grain', 'blur', 'round'];

  function normalizeStack(stack) {
    if (!Array.isArray(stack)) return [];
    return stack
      .filter((f) => f && DEFS[f.type] && MASTER_TYPES.indexOf(f.type) >= 0)
      .map(normalize)
      .filter(Boolean);
  }

  /**
   * Does the master stack have anything that will actually draw?
   *
   * A FILTER, never `normalizeStack()`, even though that would answer the same question:
   * `normalize()` writes defaults into the entry it is given, and this is asked on every
   * frame by `needsCompositeAt()`. Filling in a project's state from inside a paint check
   * is a mutation outside `pushUndo()`, which is the one thing the editing rules forbid.
   */
  function masterActive(stack) {
    return (stack || []).some(
      (f) => f && DEFS[f.type] && MASTER_TYPES.indexOf(f.type) >= 0 && f.enabled !== false);
  }

  function renderMaster(target, W, H, stack, t, surface, frameDur) {
    const entries = (stack || []).filter(
      (f) => f && DEFS[f.type] && MASTER_TYPES.indexOf(f.type) >= 0 && f.enabled !== false);
    if (!entries.length) return false;
    const snap = clean(surface, 'fxMasterSrc', W, H);
    snap.c.drawImage(target.canvas, 0, 0);
    // A clip with an id and nothing else: `paramsAt()` wants somewhere to look for a
    // binding and finds none, which is the right answer - a master pass follows nothing.
    render(target, W, H, { id: 'master', fx: entries }, t, surface,
      (tc, w, h) => tc.drawImage(snap.cv, 0, 0, w, h), frameDur);
    return true;
  }
  // ------------------------------------------------------------ per-effect shutter

  const MBLUR = { on: false, strength: 0.5, samples: 8 };

  /**
   * Does this effect paint differently at a slightly different time?
   *
   * Only two things can make it: keyframes on its parameters, or a draw that reads the
   * clock itself - a pointer moving along a take, a ripple expanding, a selection's
   * envelope. A static grade painted eight times at eight instants is the same grade
   * eight times, so blurring it would cost eight passes over eight million pixels to
   * produce a pixel-identical frame. This is what stops that being possible to ask for
   * by accident.
   */
  function timeVarying(entry) {
    const d = DEFS[entry.type];
    if (d && d.timeVarying) return true;
    // A binding is an animation the effect did not have to be keyed to have: the tracked
    // point moves every frame, so a bound effect paints a different picture at every
    // instant and the shutter has something real to average.
    if (entry.bind && entry.bind.track && d && d.bind) return true;
    const k = entry.keys;
    if (!k) return false;
    for (const prop of Object.keys(k)) if (k[prop] && k[prop].length > 1) return true;
    return false;
  }

  /** The effect's shutter settings, filled in and clamped. */
  function mblurOf(entry) {
    const m = entry && entry.mblur;
    if (!m || !m.on) return null;
    return {
      on: true,
      strength: clamp(m.strength, 0, 4),
      samples: Math.max(2, Math.min(32, Math.round(clamp(m.samples, 2, 32)))),
    };
  }

  /**
   * Run ONE effect across the shutter and average the results.
   *
   * Motion blur is animation sampled across time and averaged, and the one correct
   * averaging in this app lives in `Anim.temporalAverage()` - text cards, transition
   * objects and the swipe's plate all go through it, because the naive
   * `lighter`-at-`1/n` accumulator quantises every faint pixel to zero and annihilates
   * exactly the soft things blur is supposed to smear. Nothing here re-implements it.
   *
   * The layer is copied ONCE before the sweep and each sample is the effect applied to
   * that same copy at its own instant - which is what makes this the blur of the effect
   * rather than a blur of everything under it. An effect earlier in the stack has
   * already painted into the copy and comes through every sample identically, so it
   * averages to itself and stays sharp.
   */
  function drawBlurred(L, entry, t, clip, frameDur, mb) {
    const W = L.W, H = L.H, surface = L.surface;
    const n = mb.samples;
    const span = mb.strength * (frameDur > 0 ? frameDur : 1 / 30);
    const before = take(L, 'fxMbSrc');
    Anim.temporalAverage(L.c, W, H, n, (sctx, i) => {
      const ti = n < 2 ? t : t + ((i / (n - 1)) - 0.5) * span;
      const sub = clean(surface, 'fxMbSub', W, H);
      sub.c.drawImage(before, 0, 0);
      const subL = { cv: sub.cv, c: sub.c, W, H, surface, base: L.base };
      DEFS[entry.type].draw(subL, paramsAt(entry, ti, clip, W, H), ti, entry, clip);
      reset(sub.c);
      sctx.drawImage(sub.cv, 0, 0);
    }, surface, 'fxMb');
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

    // The shutter is absent by default and prunes itself away again, exactly like `keys`:
    // a stack that uses no motion blur serialises as it did before this existed. It is
    // kept when it is ON, and also when it is off but carries settings the author changed
    // - toggling a blur off should not silently throw away the strength they dialled in.
    if (fx.mblur && typeof fx.mblur === 'object') {
      const m = {
        on: !!fx.mblur.on,
        strength: isFinite(Number(fx.mblur.strength)) ? clamp(fx.mblur.strength, 0, 4) : MBLUR.strength,
        samples: Math.max(2, Math.min(32, Math.round(
          isFinite(Number(fx.mblur.samples)) ? Number(fx.mblur.samples) : MBLUR.samples))),
      };
      const plain = !m.on && m.strength === MBLUR.strength && m.samples === MBLUR.samples;
      if (plain) delete fx.mblur; else fx.mblur = m;
    } else if (fx.mblur) {
      delete fx.mblur;
    }
    /*
     * The binding. Plain JSON like everything else that lands on a clip, and absent by
     * default - an effect that follows nothing serialises exactly as it did before this
     * existed. A bind on a type that cannot be bound is DROPPED rather than kept: the
     * panel offers it only where `DEFS[type].bind` exists, so one here came from an
     * older or hand-edited file and would silently do nothing.
     *
     * A bind naming a track is NOT checked against the clip here. A clip can be carried
     * into a project without its track, or the track can be deleted and tracked again,
     * and the binding must survive both - `Tracker.bindPos()` answers null and the
     * effect draws its static parameters, which is the degradation contract.
     */
    if (fx.bind && typeof fx.bind === 'object' && fx.bind.track && d.bind) {
      const b = fx.bind;
      const nb = {
        track: String(b.track),
        offX: isFinite(Number(b.offX)) ? Number(b.offX) : 0,
        offY: isFinite(Number(b.offY)) ? Number(b.offY) : 0,
        strength: isFinite(Number(b.strength)) ? clamp(b.strength, -4, 4) : 1,
        smooth: isFinite(Number(b.smooth)) ? clamp(b.smooth, 0, 4) : 0,
      };
      // Which way a follow moves, for a type that has more than one answer. Anything
      // unrecognised falls back to the type's first mode rather than to nothing, so a
      // hand-edited file cannot leave a binding that resolves and then draws nowhere.
      if (d.bind.modes) {
        const known = d.bind.modes.some((m) => m.value === b.mode);
        nb.mode = known ? b.mode : d.bind.modes[0].value;
      }
      // The clip the track lives on, when it is not this one. Absent for the ordinary
      // case, so a same-clip binding serialises exactly as it did before cross-clip
      // binding existed.
      if (b.clip) nb.clip = String(b.clip);
      /*
       * The binding keyframes ITS OWN numbers, on its own `keys` object.
       *
       * `Anim` only ever touches a `.keys` object, so `bind` is a keyframe holder for
       * free - exactly as an `fx` entry is. They have to be separate holders: `fx.keys`
       * animates the effect's parameters, and two of those parameters are the ones the
       * binding overwrites every frame. Putting `strength` in there would make it a
       * parameter that does not exist, which `normalize()` would then prune away.
       */
      if (b.keys && typeof b.keys === 'object') {
        const keys = {};
        for (const k of ['strength', 'smooth', 'offX', 'offY']) {
          if (Array.isArray(b.keys[k]) && b.keys[k].length) keys[k] = Anim.sortKeys(b.keys[k]);
        }
        if (Object.keys(keys).length) nb.keys = keys;
      }
      fx.bind = nb;
    } else if (fx.bind) {
      delete fx.bind;
    }

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

  /*
   * HOW A BINDING FINDS ITS TRACK, AND WHY THAT IS NOT THIS FILE'S BUSINESS.
   *
   * A binding may name a track on ANOTHER clip - a logo on V2 following a button in the
   * screen recording on V1 - and resolving that needs two things this file must never
   * touch: the timeline, and a clip's position on it. An effect that could read
   * `clip.start` would be putting a clip's timeline position into its own pixels, which
   * is the one thing the render cache's key rules forbid, and the rule is worth more than
   * the convenience.
   *
   * So the resolver is INJECTED. `app.js` installs one that can walk the timeline and do
   * the time conversion, and takes on the matching duty of putting that dependency into
   * the render key (`trackDigests()`). With no binder installed - a bare module load, a
   * suite checking this file alone - bindings resolve against the clip's own tracks only,
   * which is the behaviour this file can be responsible for on its own.
   */
  let BINDER = null;
  function setBinder(fn) { BINDER = typeof fn === 'function' ? fn : null; }

  function resolveBind(clip, entry, t, W, H) {
    const b = entry.bind;
    if (!b || !b.track) return null;
    if (BINDER) return BINDER(clip, b, t, W, H);
    const TK = (typeof Tracker !== 'undefined' && Tracker) ||
      (typeof window !== 'undefined' && window.Tracker) || null;
    if (!TK) return null;
    // Same-clip only: clip-local time to source time is the clip's own in-point.
    if (b.clip && b.clip !== clip.id) return null;
    return TK.bindPos(clip, b, (Number(clip.in) || 0) + t, (Number(W) || 9) / (Number(H) || 16), t);
  }

  /** One parameter's value at clip-local time `t` - keyed if it has keys, static if not. */
  function paramAt(entry, key, t) {
    const stat = (entry.params || {})[key];
    if (typeof stat !== 'number') return stat;      // a colour has no track
    return Anim.valueAt(entry, key, t, stat);
  }

  /**
   * The whole animated parameter set for one effect at `t`, with any binding applied.
   *
   * A BINDING IS THE LAST WORD, and it is applied after the keyframes on purpose. The
   * parameters a bind writes are positions, and a position that is both keyed and tracked
   * is a contradiction the panel says out loud rather than averaging: what the author
   * asked for is "follow the element", and a key from before the track existed must not
   * quietly drag the callout off it. Everything the bind does NOT write - size, feather,
   * scale, opacity - keyframes exactly as it always did, which is what lets a tracked
   * spotlight open up while it follows.
   *
   * `clip` and `W`/`H` are optional: without them nothing is bound and the static, keyed
   * values come back, which is what every caller that is not drawing a frame wants.
   */
  function paramsAt(entry, t, clip, W, H) {
    const d = DEFS[entry.type];
    const out = {};
    for (const k of Object.keys(d.params)) out[k] = paramAt(entry, k, t);
    const b = entry.bind;
    if (b && b.track && d.bind && clip) {
      // The resolver hands back the tracked point AND the animated offsets, because what
      // an offset means depends on the type: it moves the lit shape of a spotlight and the
      // whole frame of a bound transform. Only `apply()` knows which.
      const pos = resolveBind(clip, entry, t, W, H);
      if (pos) d.bind.apply(out, pos, { x: pos.offX || 0, y: pos.offY || 0 }, b.mode);
    }
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
  function render(target, W, H, clip, t, surface, paint, frameDur) {
    const entries = active(clip);
    if (!entries.length) { paint(target, W, H); return false; }
    const layer = clean(surface, 'fxLayer', W, H);
    const L = { cv: layer.cv, c: layer.c, W, H, surface, base: baseOf(surface, W, H, paint) };
    paint(L.c, W, H);
    for (const e of entries) {
      try {
        // Motion blur is per EFFECT and costs `samples` passes of that effect, so it is
        // refused outright for one that cannot paint differently across the shutter -
        // see `timeVarying()`.
        const mb = mblurOf(e);
        if (mb && timeVarying(e)) drawBlurred(L, e, t, clip, frameDur, mb);
        else DEFS[e.type].draw(L, paramsAt(e, t, clip, W, H), t, e, clip);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('FX ' + e.type + ' failed:', err);
      }
      // An effect that leaves the context dirty would poison every effect after it.
      reset(L.c);
    }
    target.drawImage(L.cv, 0, 0);
    return true;
  }

  /**
   * Why a `round` shadow cannot be seen, at one instant. `null` when it can.
   *
   * Both answers are things the panel cannot show any other way. The shadow lives in the
   * room `margin` opens, so there are exactly two ways to lose it: leave no room, or push
   * it out of the room there is. Neither draws anything, and neither is wrong enough to
   * be an error - which is precisely why they need saying out loud.
   *
   * It takes the ANIMATED parameters rather than the static ones, because the first way
   * to end up with no room is a keyframe. A single key on `margin` holds its value across
   * the whole clip and silently overrides the slider above it, so a panel reading
   * `params.margin` would cheerfully report 0.04 while the picture used 0.
   */
  function shadowProblem(p) {
    if (!(clamp(p.shadow, 0, 1) > 0.002)) return null;      // no shadow asked for
    // An INWARD shadow draws over the picture itself, so it needs no room and can never
    // be pushed out of any. Only the outward one can be aimed at space that is not there.
    if (String(p.mode || 'inner') !== 'outer') return null;
    const margin = Number(p.margin) || 0;
    if (!(margin > 0.001)) return 'no-room';
    const reach = Math.max(Math.abs(Number(p.offsetX) || 0), Math.abs(Number(p.offsetY) || 0));
    return reach > margin ? 'pushed-out' : null;
  }

  /**
   * Which parameters a binding takes over on this effect, so the panel can say so on the
   * strips it has made pointless. Derived by RUNNING the type's own `apply()` over a
   * marked parameter set rather than by listing names a second time: a list here and a
   * write there is exactly the pair that drifts, and the symptom would be a keyframe
   * strip that looks live and moves nothing.
   */
  function boundParams(type, mode) {
    const d = DEFS[type];
    if (!d || !d.bind) return [];
    const probe = Object.assign({}, d.params);
    // The probe carries an anchor as a real binding does, so a 'move' apply measures a
    // travel of 0.37 - 0.5 rather than against an undefined and writing NaN.
    d.bind.apply(probe, { x: 0.37, y: 0.61, ax: 0.5, ay: 0.5 }, { x: 0, y: 0 },
      mode || (d.bind.modes ? d.bind.modes[0].value : undefined));
    return Object.keys(d.params).filter((k) => probe[k] !== d.params[k]);
  }

  const API = {
    DEFS, TYPES, boundParams, setBinder, setMatteProvider,
    create, normalize, normalizeClip, active,
    paramAt, paramsAt, render,
    pointerImage, preloadImages,
    MBLUR, mblurOf, timeVarying, shadowProblem,
    gradeLUT, isNeutralGrade, GRADE_NEUTRAL,
    // The finishing pass. The cube parser and the sampler are exported because they are
    // the part worth asserting on their own - `smoke-finish.js` checks trilinear
    // interpolation against hand-computed values without painting a pixel.
    parseCube, sampleLUT, applyLUT, isIdentityLUT, cubeAt,
    setLutReader, putLut, lutFor, lutState, lutDigest, lutPaths, preloadLuts,
    mulberry32, grainMap, GRAIN_SIZE,
    lumaStats, matchGrade,
    MASTER_TYPES, normalizeStack, masterActive, renderMaster,
    roundRectPath, roundRectSub, pxMin, rgba, padBlur,
    CHROME, chromeGeom, spotRect, cutoutRect, fitDraw,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.FX = API;
})();
