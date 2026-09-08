'use strict';
/**
 * Waveforms for audio clips on the timeline.
 *
 * Peaks are decoded once per source file and then belong to the file, not to the clip:
 * splitting, trimming or duplicating a clip only changes which slice of the same peak
 * array is drawn. That is what makes a waveform affordable on a timeline that redraws
 * every lane on every mouse move while a clip is being dragged.
 *
 * Decoding is asynchronous and never blocks a redraw. `peaksFor()` answers immediately
 * with whatever it has - possibly nothing - and kicks off a decode whose completion asks
 * the timeline to redraw. A clip with no peaks yet simply draws without a waveform.
 *
 * The peaks are cached on disk in userData (keyed by path, size and mtime), so a file
 * that has been seen before is ready on the first frame after a project opens.
 */
const Wave = (() => {

  /** Buckets across the WHOLE source file. 2048 is ~8 KB of JSON and plenty of detail:
   *  a clip is only ever a slice of it, and the timeline never draws more than a few
   *  hundred pixels of any one clip. */
  const BUCKETS = 2048;

  /** src -> { peaks: Uint8Array, duration } once decoded. */
  const cache = new Map();
  /** Sources currently being decoded or known to be undecodable. */
  const busy = new Set();
  const failed = new Set();

  let audioCtx = null;
  let notify = () => {};

  /** Called after any decode finishes, so the caller can redraw the lanes. */
  function onReady(fn) { notify = typeof fn === 'function' ? fn : () => {}; }

  function fileUrl(src) {
    return 'file:///' + String(src).replace(/\\/g, '/').replace(/^\/+/, '');
  }

  /** Peaks for a source, or null if they are not ready yet (a decode is started). */
  function peaksFor(src) {
    if (!src) return null;
    const hit = cache.get(src);
    if (hit) return hit;
    if (!busy.has(src) && !failed.has(src)) load(src);
    return null;
  }

  async function load(src) {
    busy.add(src);
    try {
      // The disk cache first: decoding a few minutes of audio costs seconds, and this
      // path costs a file read.
      const stored = await window.api.waveRead(src);
      if (stored && stored.peaks && stored.peaks.length) {
        cache.set(src, { peaks: Uint8Array.from(stored.peaks), duration: stored.duration || 0 });
        return;
      }
      const buf = await fetch(fileUrl(src)).then((r) => r.arrayBuffer());
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await audioCtx.decodeAudioData(buf);
      const peaks = reduce(audio);
      cache.set(src, { peaks, duration: audio.duration });
      window.api.waveWrite(src, Array.from(peaks), audio.duration);
    } catch (e) {
      // A file the browser cannot decode (some containers, or a video whose audio codec
      // the renderer lacks) simply gets no waveform. Not being able to draw one is never
      // a reason to break the timeline, so it is remembered and not retried.
      failed.add(src);
    } finally {
      busy.delete(src);
      notify();
    }
  }

  /** Peak amplitude per bucket, 0..255, mixed down across channels. */
  function reduce(audio) {
    const out = new Uint8Array(BUCKETS);
    const n = audio.length;
    if (!n) return out;
    const chans = [];
    for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
    const per = n / BUCKETS;
    for (let b = 0; b < BUCKETS; b++) {
      const from = Math.floor(b * per);
      const to = Math.min(n, Math.max(from + 1, Math.floor((b + 1) * per)));
      // Stride large buckets: a peak is a peak, and reading every sample of an hour-long
      // file here would cost more than the decode did.
      const step = Math.max(1, Math.floor((to - from) / 512));
      let peak = 0;
      for (const data of chans) {
        for (let i = from; i < to; i += step) {
          const v = data[i] < 0 ? -data[i] : data[i];
          if (v > peak) peak = v;
        }
      }
      out[b] = Math.min(255, Math.round(peak * 255));
    }
    return out;
  }

  /**
   * Draw the slice of `src` between `inT` and `outT` into `canvas`.
   *
   * Returns false when there is nothing to draw yet, so the caller can leave the clip
   * plain rather than painting an empty box.
   */
  function draw(canvas, src, inT, outT, duration, color) {
    const entry = peaksFor(src);
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return false;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!entry) return false;

    const total = duration || entry.duration || 0;
    if (!(total > 0)) return false;
    const peaks = entry.peaks;
    const a = Math.max(0, Math.min(1, inT / total));
    const b = Math.max(a, Math.min(1, outT / total));
    const from = a * peaks.length, to = b * peaks.length;
    const per = (to - from) / w;

    const mid = h / 2;
    ctx.fillStyle = color || 'rgba(255,255,255,.55)';
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(from + x * per);
      const i1 = Math.max(i0 + 1, Math.floor(from + (x + 1) * per));
      let peak = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
      const half = Math.max(0.5, (peak / 255) * (mid - 1));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
    return true;
  }

  /** Forget everything decoded - used by the smoke suites. */
  function clear() { cache.clear(); busy.clear(); failed.clear(); }

  return { peaksFor, draw, onReady, clear, BUCKETS, _cache: cache, _reduce: reduce };
})();
