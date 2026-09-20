'use strict';
/**
 * Resolve Matte - a mask cut in DaVinci Resolve 19 (Magic Mask), imported as a matte video.
 * The pure half.
 *
 * Loaded as a plain <script> global `Matte` before `fx.js`, and as a CommonJS module by
 * `src/mask.js` in the main process and by `tools/smoke-mask.js`. Nothing in here touches
 * the DOM, a canvas, ffmpeg or the filesystem: mattes arrive as run-length-encoded 8-bit
 * planes and leave as 8-bit alpha planes.
 *
 * THE WORKFLOW
 *
 * Resolve does the hard part - Magic Mask tracks the object - and delivers a video with
 * the matte in its ALPHA channel (QuickTime, ProRes 4444 with "Export Alpha"). ShortCut
 * decodes that file ONCE with ffmpeg into planes and keeps them on disk. A black-and-white
 * matte with no alpha channel is read from its luma instead, so either export works.
 *
 * WHAT LANDS ON A CLIP
 *
 *   clip.masks = [ { id, name, src, channel, res, at, offset } ]
 *
 *   `src`      the matte video's path. A PATH, never the pixels - `clip.masks` is plain
 *              JSON in every undo snapshot and in the .scut file.
 *   `channel`  'auto' (alpha if the file has one, otherwise luma), 'alpha' or 'luma'.
 *   `res`      the long side the matte is decoded at.
 *   `at`       SOURCE seconds at which the matte's first frame sits. 0 for a matte
 *              rendered over the whole source clip; the clip's `in` for one rendered from
 *              just that cut's range, and IMPORT SETS IT - nobody types 756.75.
 *   `offset`   a hand nudge in seconds on top of `at`, for a matte that starts a few
 *              frames out. Small by design: the big number is `at`, and it is measured.
 *
 * TIME: MATTE FRAME N IS SOURCE FRAME N.
 *
 * The matte is looked up by SOURCE time (`clip.in` + clip-local time), the axis trims,
 * splits and drags all leave alone - so a matte exported over the full source clip stays
 * glued to the picture whatever is done to the clip afterwards.
 */
(() => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d) => (isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const r4 = (v) => Math.round(Number(v) * 1e4) / 1e4;

  const DEFAULTS = {
    res: 960,          // decoded long side; the 9:16 crop of a 16:9 source is ~540 wide
    channel: 'auto',
    at: 0,
    offset: 0,
  };
  const RES_CHOICES = [480, 960, 1920];
  const CHANNELS = ['auto', 'alpha', 'luma', 'black'];
  const SPACES = ['auto', 'source', 'frame'];

  let seq = 0;
  const uid = () => 'mk' + Date.now().toString(36) + (seq++).toString(36);

  function makeMask(name, src, opts) {
    const o = opts || {};
    return normalizeMask({
      id: uid(), name: name || 'Matte 1', src: String(src || ''),
      channel: o.channel, res: o.res, at: o.at, offset: o.offset, space: o.space,
    });
  }

  function hasMasks(clip) {
    return !!(clip && Array.isArray(clip.masks) && clip.masks.length);
  }

  function maskById(clip, id) {
    if (!hasMasks(clip) || !id) return null;
    return clip.masks.find((m) => m && m.id === id) || null;
  }

  /** The mask a `matte` effect reads: the one it names, or the clip's first. */
  function maskFor(clip, id) {
    return maskById(clip, id) || (hasMasks(clip) ? clip.masks[0] : null);
  }

  /**
   * Fill a mask in against the defaults and drop anything without a file. A mask painted
   * by the old Magic Mask build has strokes and no `src`, so it is dropped here - a
   * project saved by that build opens clean rather than with a matte that cannot load.
   */
  function normalizeMask(m) {
    if (!m || typeof m !== 'object' || !m.src || typeof m.src !== 'string') return null;
    if (!m.id) m.id = uid();
    m.name = String(m.name || 'Matte');
    m.channel = CHANNELS.includes(m.channel) ? m.channel : DEFAULTS.channel;
    const res = Math.round(num(m.res, DEFAULTS.res));
    m.res = RES_CHOICES.includes(res) ? res : DEFAULTS.res;
    // A project from before `at` existed carries the whole start in `offset`, which is now
    // a nudge with a +/- 10 s range. Anything past that range is where the matte STARTS,
    // so it moves to `at` rather than being clamped away - the same matte, the same frame,
    // read by a build that splits the number in two.
    let at = num(m.at, 0);
    let off = num(m.offset, 0);
    if (Math.abs(off) > 10) { at += off; off = 0; }
    m.at = r4(clamp(at, 0, 360000));
    m.offset = r4(clamp(off, -10, 10));
    m.space = SPACES.includes(m.space) ? m.space : 'auto';
    delete m.strokes; delete m.rate;
    return m;
  }

  function normalizeClip(clip) {
    if (!clip || !Array.isArray(clip.masks)) return;
    clip.masks = clip.masks.map(normalizeMask).filter(Boolean);
    if (!clip.masks.length) delete clip.masks;
  }

  /**
   * The matte frame shown at SOURCE time `t`. Held, never blended: a video element shows
   * the frame whose timestamp is at or before the clock, and so does this. Outside the
   * matte's own span the nearest end is held, so a matte a frame short of its clip does
   * not pop the object out on the last frame.
   */
  function frameIndex(mask, fps, count, t) {
    if (!(count > 0) || !(fps > 0)) return -1;
    const x = (num(t, 0) - maskStart(mask)) * fps;
    return clamp(Math.floor(x + 1e-3), 0, count - 1);
  }

  /** The SOURCE second the matte's first frame sits at: where it was rendered, plus the nudge. */
  function maskStart(mask) {
    return r4(num(mask && mask.at, 0) + num(mask && mask.offset, 0));
  }

  /**
   * Which space a matte is in. 'source': the matte is the untouched source clip, looked up
   * by SOURCE time and drawn through the clip's crop. 'frame': the matte is a finished
   * frame from a Resolve timeline - a vertical 1080x1920 export of a 16:9 clip - drawn
   * straight over the output frame and looked up by CLIP time. Auto picks by aspect: a
   * matte the shape of its source is source-space, anything else is frame-space.
   */
  function resolveSpace(mask, matteW, matteH, srcW, srcH) {
    if (mask && (mask.space === 'source' || mask.space === 'frame')) return mask.space;
    if (!(matteW > 0 && matteH > 0 && srcW > 0 && srcH > 0)) return 'source';
    const a = srcW / srcH, b = matteW / matteH;
    return Math.abs(a - b) / a <= 0.02 ? 'source' : 'frame';
  }

  /**
   * A cut-out over black as a matte: everything black CONNECTED TO THE BORDER is
   * background, everything else is kept - so a dark shirt or a pupil inside the figure is
   * not punched out the way a plain luma threshold would. This is what a DNxHR 444 export
   * with alpha gives ffmpeg, which cannot decode DNxHR's alpha and sees only the
   * premultiplied picture. `gray` is a full-range luma plane; the answer is 0 / 255.
   */
  function keyBlack(gray, w, h, thresh) {
    const th = num(thresh, 14);
    const out = new Uint8Array(w * h).fill(255);
    const stack = new Int32Array(w * h);
    let sp = 0;
    const push = (i) => { if (out[i] === 255 && gray[i] <= th) { out[i] = 0; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    return out;
  }

  /** The decoded plane size for a source of w x h at a long side of `res`. Even, >= 2. */
  function planeSize(w, h, res) {
    const W = Math.max(1, num(w, 1)), H = Math.max(1, num(h, 1));
    const s = Math.min(1, num(res, DEFAULTS.res) / Math.max(W, H));
    const even = (v) => Math.max(2, Math.round(v * s / 2) * 2);
    return { w: even(W), h: even(H) };
  }

  // ------------------------------------------------------------ run-length planes
  //
  // A matte is mostly a flat 0 and a flat 255 with a thin ramp between, so the runs are
  // enormous: a 960-side plane that is half a megabyte raw lands in a few kilobytes, and
  // a minute of them fits in memory as the encoded bytes. Decoding happens per frame, on
  // demand, into a small cache in the renderer.
  //
  // Format: [value:u8, count:u16le] triples, counts capped at 65535.

  function rleEncode(a) {
    const n = a.length;
    const out = new Uint8Array(Math.max(3, n * 3));
    let o = 0, i = 0;
    while (i < n) {
      const v = a[i];
      let k = 1;
      while (i + k < n && a[i + k] === v && k < 65535) k++;
      out[o++] = v; out[o++] = k & 255; out[o++] = k >> 8;
      i += k;
    }
    return out.slice(0, o);
  }

  function rleDecode(buf, len) {
    const out = new Uint8Array(len);
    let o = 0;
    for (let i = 0; i + 3 <= buf.length && o < len; i += 3) {
      const v = buf[i], n = buf[i + 1] | (buf[i + 2] << 8);
      const end = Math.min(len, o + n);
      out.fill(v, o, end);
      o = end;
    }
    return out;
  }

  // --------------------------------------------------------------- edge operations
  //
  // THE UNIT RULE: every radius is a fraction of the plane's shorter side, never a pixel
  // count, so the same feather is the same softness at every decode resolution.

  function radiusPx(f, w, h) {
    return Math.max(0, Math.round(clamp(f, 0, 0.5) * Math.max(1, Math.min(w, h))));
  }

  /** Separable box min/max: px > 0 dilates by that many pixels, < 0 erodes. */
  function growPlane(a, w, h, px) {
    const r = Math.abs(px | 0);
    if (!r) return a;
    const pick = px > 0 ? Math.max : Math.min;
    const tmp = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = a[y * w + x];
        for (let d = 1; d <= r; d++) {
          v = pick(v, a[y * w + Math.min(w - 1, x + d)]);
          v = pick(v, a[y * w + Math.max(0, x - d)]);
        }
        tmp[y * w + x] = v;
      }
    }
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = tmp[y * w + x];
        for (let d = 1; d <= r; d++) {
          v = pick(v, tmp[Math.min(h - 1, y + d) * w + x]);
          v = pick(v, tmp[Math.max(0, y - d) * w + x]);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  /**
   * Three box blurs, which is a gaussian to well within an 8-bit level. The edges CLAMP
   * rather than reading zero, so a matte that runs off the side of the picture is not
   * eaten by its own feather.
   */
  function blurPlane(a, w, h, px) {
    const r = px | 0;
    if (r <= 0) return a;
    let src = a;
    const n = 2 * r + 1;
    for (let pass = 0; pass < 3; pass++) {
      const tmp = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let d = -r; d <= r; d++) sum += src[y * w + clamp(d, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[y * w + x] = sum / n;
          sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
        }
      }
      const out = new Uint8ClampedArray(w * h);
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let d = -r; d <= r; d++) sum += tmp[clamp(d, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          out[y * w + x] = sum / n;
          sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
      }
      src = out;
    }
    return src;
  }

  /**
   * Grow, then feather, then invert - and the order is the feature. Growing after
   * feathering would re-harden the edge; inverting first would grow the background.
   */
  function edge(alpha, w, h, opts) {
    const o = opts || {};
    let a = alpha;
    const g = radiusPx(Math.abs(num(o.grow, 0)), w, h) * (num(o.grow, 0) < 0 ? -1 : 1);
    if (g) a = growPlane(a, w, h, g);
    const f = radiusPx(num(o.feather, 0), w, h);
    if (f) a = blurPlane(a, w, h, f);
    if (o.invert) {
      const out = new Uint8ClampedArray(w * h);
      for (let i = 0; i < out.length; i++) out[i] = 255 - a[i];
      return out;
    }
    return a === alpha ? Uint8ClampedArray.from(alpha) : a;
  }

  // ----------------------------------------------------------------- keys and digests

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /**
   * The decode cache key: the file, its stamp, the channel and the resolution. Nothing
   * about the clip and not where it starts - `at` and `offset` are applied at lookup, so
   * sliding either re-reads nothing.
   */
  function cacheKey(src, stamp, channel, res) {
    const s = stamp || {};
    return hash(['rm2', String(src), s.size | 0, Math.round(num(s.mtime, 0)),
      String(channel || 'auto'), Math.round(num(res, DEFAULTS.res))].join('|'));
  }

  /**
   * What a clip's matte contributes to the RENDER key. The same shape `Tracker.digest()`
   * answers: no timeline position, so a masked clip keeps its cached render when it moves.
   * `stamp` is the file's size and mtime, when known, so re-exporting over the same path
   * from Resolve drops the stale render.
   */
  function digest(mask, stamp) {
    if (!mask) return null;
    const s = stamp || {};
    return hash([mask.src, mask.channel, mask.res, mask.at, mask.offset, mask.space,
      s.size | 0, Math.round(num(s.mtime, 0))].join('|'));
  }

  const API = {
    DEFAULTS, RES_CHOICES, CHANNELS, SPACES, resolveSpace, keyBlack,
    makeMask, normalizeMask, normalizeClip, hasMasks, maskById, maskFor,
    frameIndex, maskStart, planeSize, rleEncode, rleDecode,
    edge, growPlane, blurPlane, radiusPx,
    hash, cacheKey, digest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.Matte = API;
  else if (typeof self !== 'undefined') self.Matte = API;
})();
