/**
 * Preview/playback smoke test - the half that tools/smoke.js cannot cover, because it
 * depends on real decoding happening over time.
 *
 *   SHORTCUT_SMOKE=tools/smoke-preview.js node_modules/.bin/electron .
 *
 * Needs %TEMP%\scut_test\real1.mp4 and real2.mp4: clips whose VIDEO stream is shorter
 * than their container duration (2.5 s of picture in a 2.9 s file), which is what used to
 * produce black frames at every cut. Generate them with:
 *   ffmpeg -f lavfi -i testsrc=size=1920x1080:rate=30:duration=2.5 \
 *          -f lavfi -i sine=duration=2.9 -c:v libx264 -pix_fmt yuv420p -c:a aac real1.mp4
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Mean brightness of the preview canvas, 0-255. */
    const brightness = () => {
      const c = document.querySelector('#preview');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 997) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
      return sum / n;
    };
    /** Seek and give the decoder time to land a frame. */
    const goto = async (t, ms) => { seek(t); await sleep(ms || 700); drawPreview(); await sleep(60); };

    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    await importPaths([D + 'real1.mp4', D + 'real2.mp4']);
    await sleep(1200);

    const v = state.tracks.find((t) => t.type === 'video');
    ok('two clips imported', v.clips.length === 2);
    ok('clips are contiguous', Math.abs(v.clips[0].out - v.clips[1].start) < 0.001,
      'end=' + v.clips[0].out.toFixed(3) + ' next=' + v.clips[1].start.toFixed(3));

    await goto(0.5, 1200);
    ok('start of clip 1 is not black', brightness() > 20, 'Y=' + brightness().toFixed(1));

    // The old bug: past the video stream's end but still inside the clip.
    await goto(2.7);
    ok('clip 1 tail (past video stream end) is not black', brightness() > 20, 'Y=' + brightness().toFixed(1));

    // The cut itself.
    await goto(2.88);
    ok('last frame before the cut is not black', brightness() > 20, 'Y=' + brightness().toFixed(1));
    await goto(2.95, 1400);
    ok('first frame after the cut is not black', brightness() > 20, 'Y=' + brightness().toFixed(1));

    await goto(4.0);
    ok('middle of clip 2 is not black', brightness() > 20, 'Y=' + brightness().toFixed(1));

    await goto(projectDuration());
    ok('end of timeline holds the last frame', brightness() > 20, 'Y=' + brightness().toFixed(1));

    // Scrubbing repeatedly used to leave the canvas stuck black (stacked seeks).
    for (const t of [1.0, 3.5, 0.2, 4.2, 2.6]) { seek(t); await sleep(90); }
    await sleep(900); drawPreview(); await sleep(60);
    ok('canvas survives rapid scrubbing', brightness() > 20, 'Y=' + brightness().toFixed(1));

    // A real gap must still be black.
    v.clips[1].start += 2;
    await goto(v.clips[0].out + 1);
    ok('a real gap is black', brightness() < 5, 'Y=' + brightness().toFixed(1));
    v.clips[1].start -= 2;

    // Playback: sample brightness across a play pass covering the cut.
    seek(1.8); await sleep(600);
    play();
    const samples = [];
    for (let i = 0; i < 26; i++) { await sleep(100); samples.push(brightness()); }
    pause();
    const dark = samples.filter((s) => s < 20).length;
    // Guard against a false pass/fail when the rAF clock is throttled and never advanced.
    ok('playhead advances during playback', state.playhead > 2.9,
      'playhead=' + state.playhead.toFixed(2));
    ok('no black frames while playing across the cut', dark === 0,
      dark + '/' + samples.length + ' dark; playhead=' + state.playhead.toFixed(2));

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
