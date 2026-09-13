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
 *   clip.masks = [ { id, name, src, channel, res, offset } ]
 *
 *   `src`      the matte video's path. A PATH, never the pixels - `clip.masks` is plain
 *              JSON in every undo snapshot and in the .scut file.
 *   `channel`  'auto' (alpha if the file has one, otherwise luma), 'alpha' or 'luma'.
 *   `res`      the long side the matte is decoded at.
 *   `offset`   SOURCE seconds at which the matte's first frame sits. 0 when the matte was
 *              rendered over the whole source clip, which is the export this is built for.
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
    offset: 0,
  };
  const RES_CHOICES = [480, 960, 1920];
  const CHANNELS = ['auto', 'alpha', 'luma'];

  let seq = 0;
  const uid = () => 'mk' + Date.now().toString(36) + (seq++).toString(36);

  function makeMask(name, src, opts) {
    const o = opts || {};
    return normalizeMask({
      id: uid(), name: name || 'Matte 1', src: String(src || ''),
      channel: o.channel, res: o.res, offset: o.offset,
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
    m.offset = r4(clamp(num(m.offset, 0), -3600, 3600));
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
    const x = (num(t, 0) - num(mask && mask.offset, 0)) * fps;
    return clamp(Math.floor(x + 1e-3), 0, count - 1);
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
   * about the clip and not the offset - the offset is applied at lookup, so sliding it
   * re-reads nothing.
   */
  function cacheKey(src, stamp, channel, res) {
    const s = stamp || {};
    return hash(['rm1', String(src), s.size | 0, Math.round(num(s.mtime, 0)),
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
    return hash([mask.src, mask.channel, mask.res, mask.offset, s.size | 0, Math.round(num(s.mtime, 0))].join('|'));
  }

  const API = {
    DEFAULTS, RES_CHOICES, CHANNELS,
    makeMask, normalizeMask, normalizeClip, hasMasks, maskById, maskFor,
    frameIndex, planeSize, rleEncode, rleDecode,
    edge, growPlane, blurPlane, radiusPx,
    hash, cacheKey, digest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.Matte = API;
  else if (typeof self !== 'undefined') self.Matte = API;
})();
