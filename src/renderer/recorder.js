'use strict';
/**
 * The capture half of the screen recorder. Runs in the hidden recorder window.
 *
 * Its whole job: turn a desktopCapturer source id into a stream, encode it, hand the
 * bytes to main, and - the part that matters for everything downstream - report the wall
 * clock time of the FIRST DECODED FRAME.
 *
 * Why that timestamp is the load-bearing one
 * ------------------------------------------
 * Cursor telemetry is sampled in the main process against the wall clock. The video's
 * own clock starts at its first frame. Between `mediaRecorder.start()` and that frame
 * sit the capture negotiation and the encoder's first output - tens to hundreds of
 * milliseconds on Windows, and not a constant. Time the telemetry from "the user pressed
 * Record" and every click ripple in step 9 lands late by that amount, consistently
 * enough to look deliberate and wrong.
 *
 * `requestVideoFrameCallback` fires when a frame is actually available for presentation,
 * so `performance.timeOrigin + now` at that moment is the epoch millisecond of frame
 * zero. Chromium has had it since 83; the fallback below is only there so the recorder
 * cannot become unusable if it is ever gated off.
 */
(function () {
  let recorder = null;
  let stream = null;
  let videoEl = null;
  let firstFrameSent = false;
  let startedAt = 0;

  const fail = (e) => { try { window.rec.fail((e && e.message) || String(e)); } catch (_) {} };

  function markFirstFrame() {
    if (firstFrameSent) return;
    firstFrameSent = true;
    window.rec.firstFrame(performance.timeOrigin + performance.now());
  }

  async function start(opts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: opts.sourceId,
            maxWidth: opts.maxW || 1920,
            maxHeight: opts.maxH || 1920,
            maxFrameRate: opts.fps || 30,
          },
        },
      });
    } catch (e) { return fail(e); }

    // A <video> is the only way to observe the stream's frames. It is never displayed;
    // it exists so requestVideoFrameCallback has something to fire on.
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      videoEl.requestVideoFrameCallback(() => markFirstFrame());
    } else {
      // No rVFC: `playing` is the closest honest signal. It is later than the real first
      // frame rather than earlier, which biases telemetry EARLY - a click ripple that
      // fires a frame too soon is far less visible than one that fires a frame too late.
      videoEl.addEventListener('playing', () => markFirstFrame(), { once: true });
    }
    try { await videoEl.play(); } catch (_) { /* hidden window, autoplay is best-effort */ }

    const track = stream.getVideoTracks()[0];
    const st = (track && track.getSettings && track.getSettings()) || {};

    let mr;
    try {
      mr = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: opts.bitrate || 12000000,
      });
    } catch (_) {
      try { mr = new MediaRecorder(stream, { mimeType: 'video/webm' }); }
      catch (e) { return fail(e); }
    }
    recorder = mr;

    mr.ondataavailable = async (ev) => {
      if (!ev.data || !ev.data.size) return;
      // Belt and braces: if no frame callback ever fired, the first blob is still proof
      // that frames exist. It is late by one timeslice, and it is better than nothing.
      if (!firstFrameSent) markFirstFrame();
      try { window.rec.chunk(new Uint8Array(await ev.data.arrayBuffer())); } catch (e) { fail(e); }
    };
    mr.onerror = (ev) => fail((ev && ev.error) || 'recorder error');
    mr.onstop = () => {
      try { for (const t of stream.getTracks()) t.stop(); } catch (_) {}
      window.rec.done({ durationMs: performance.now() - startedAt });
    };

    // A short timeslice keeps chunks small enough to cross IPC without a stall, and
    // means a crashed session still leaves a playable file behind.
    startedAt = performance.now();
    mr.start(500);
    window.rec.started({ w: st.width || 0, h: st.height || 0, fps: st.frameRate || (opts.fps || 30) });

    // The user can stop the capture from the OS (unplugging a display, closing the shared
    // window). Treat it as a stop rather than leaving the editor waiting.
    if (track) track.addEventListener('ended', () => { try { mr.stop(); } catch (_) {} });
  }

  window.rec.onStart((opts) => { start(opts); });
  window.rec.onStop(() => {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); else window.rec.done({ durationMs: 0 }); }
    catch (e) { fail(e); }
  });
  window.rec.ready();
})();
