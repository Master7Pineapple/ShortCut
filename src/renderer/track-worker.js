'use strict';
/**
 * The tracking worker's message loop.
 *
 * This file is NEVER loaded on its own. `trackWorker()` in app.js fetches `track.js` and
 * this file and concatenates them into one Blob, so the worker holds the same kernel
 * source the window and the smoke suite hold - one copy of the optical flow, and no way
 * for a worker build to drift away from the one the suite checks. A Blob is also what
 * makes a worker start at all under `file://`, where a plain `new Worker('track-worker.js')`
 * is refused.
 *
 * WHY THERE IS A WORKER AT ALL, GIVEN THE MEASUREMENT.
 *
 * The flow is single-digit milliseconds a frame (see the README), so it is not the cost -
 * the decode and the seek that produce each frame are. What the worker buys is that those
 * milliseconds are not spent on the UI thread: a solve runs while the author keeps
 * scrubbing, and `loop()` keeps re-arming. A tracker that froze the window for the length
 * of a clip would be a tracker nobody ran twice.
 *
 * THE PROTOCOL, which is stateful on purpose.
 *
 *   start  { id, opts, w, h, x, y, buf }   the anchor frame and the point, in pixels
 *   step   { id, t, buf }                  -> { id, t, x, y, c, held }
 *   end    { id }
 *
 * The worker keeps the previous frame's pyramid, so each step ships ONE frame across
 * rather than two. Frames arrive as transferred RGBA buffers and are never copied back.
 */
(function () {
  const jobs = new Map();

  self.onmessage = (e) => {
    const m = e.data || {};
    try {
      if (m.cmd === 'start') {
        const pyr = Tracker.buildPyramid(Tracker.gray(new Uint8ClampedArray(m.buf), m.w, m.h),
          m.w, m.h, (m.opts || {}).levels);
        jobs.set(m.id, { pyr, pt: { x: m.x, y: m.y, c: 1 }, opts: m.opts || {} });
        self.postMessage({ id: m.id, ok: true, started: true });
        return;
      }
      if (m.cmd === 'step') {
        const j = jobs.get(m.id);
        if (!j) { self.postMessage({ id: m.id, ok: false, error: 'no such job' }); return; }
        const pyr = Tracker.buildPyramid(Tracker.gray(new Uint8ClampedArray(m.buf), m.w, m.h),
          m.w, m.h, j.opts.levels);
        const r = Tracker.stepPoint(j.pyr, pyr, j.pt, j.opts);
        // The pyramid moves on even when the point was HELD: the next frame has to be
        // compared with the frame before it, not with the last one we trusted. Comparing
        // against a stale anchor is how a tracker recovers from an occlusion by leaping.
        j.pyr = pyr;
        j.pt = r;
        self.postMessage({ id: m.id, ok: true, t: m.t, x: r.x, y: r.y, c: r.c, held: !!r.held });
        return;
      }
      if (m.cmd === 'end') { jobs.delete(m.id); self.postMessage({ id: m.id, ok: true, ended: true }); return; }
    } catch (err) {
      // One bad frame costs a frame, never the session - the same rule `loop()` keeps.
      self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
    }
  };
})();
