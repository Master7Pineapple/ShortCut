/**
 * Transitions: adding them to cuts, resizing, drawing, and rendering them out.
 *
 *   SHORTCUT_SMOKE=tools/smoke-transitions.js node_modules/.bin/electron .
 *
 * Needs %TEMP%\scut_test\clip1.mp4 and clip2.mp4 (see tools/smoke.js). Makes its own PNG
 * for the object transition.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const OUT = D + 'trans_out.mp4';

    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    await sleep(1200);
    state.out.w = 720; state.out.h = 1280; state.out.fps = 30; state.out.quality = 'draft';
    state.previewScale = 1;
    resizeCanvas();

    const vtrack = state.tracks.find((t) => t.type === 'video');
    ok('two clips landed on one video track', vtrack.clips.length === 2,
      vtrack.clips.length + ' clips');

    // ------------------------------------------------------------ finding cuts
    const cuts = allCuts();
    ok('the join between them is found as a cut', cuts.length === 1, cuts.length + ' cut(s)');
    ok('the cut is where the clips meet', cuts.length === 1 && near(cuts[0].cut, 3, 0.05),
      cuts.length ? cuts[0].cut.toFixed(3) : 'n/a');

    // ------------------------------------------------------- the fast grab
    seek(2.9);
    const tr = addTransition('swipe');
    ok('one keystroke drops a transition on the nearest cut', !!tr);
    ok('it lands on that cut', vtrack.transitions.length === 1);
    ok('it selects itself so it can be tuned straight away', state.selTransition === tr.id);
    const r0 = findTransition(tr.id);
    ok('it is centred on the cut by default',
      near(r0.from, 3 - tr.duration / 2, 0.01) && near(r0.to, 3 + tr.duration / 2, 0.01),
      r0.from.toFixed(2) + ' - ' + r0.to.toFixed(2));

    // Asking again on the same cut must not stack a second one.
    const again = addTransition('swipe');
    ok('a second grab on the same cut selects rather than duplicates',
      vtrack.transitions.length === 1 && again === tr);

    // ------------------------------------------------------------- length
    tr.duration = 1.0;
    const r1 = findTransition(tr.id);
    ok('length is adjustable', near(r1.dur, 1.0) && near(r1.from, 2.5) && near(r1.to, 3.5),
      r1.from.toFixed(2) + ' - ' + r1.to.toFixed(2));
    ok('the cap stops it running past either clip',
      maxTransitionDuration(r1.a, r1.b) <= Math.min(r1.a.out - r1.a.in, r1.b.out - r1.b.in) * 1.9 + 1e-6,
      'max=' + maxTransitionDuration(r1.a, r1.b).toFixed(2));

    tr.align = 'before';
    ok('it can sit before the cut', near(findTransition(tr.id).to, 3));
    tr.align = 'after';
    ok('it can sit after the cut', near(findTransition(tr.id).from, 3));
    tr.align = 'center';
    tr.duration = 0.6;

    // ------------------------------------------- it follows (and drops with) its cut
    ok('the playhead inside the window finds it', !!transitionAt(3.0));
    ok('outside the window it does not', !transitionAt(1.0));

    const savedStart = r1.b.start;
    r1.b.start += 1;                       // pull the clips apart
    ok('a transition whose clips stop touching is ignored', !findTransition(tr.id));
    r1.b.start = savedStart;
    ok('and comes back when they touch again', !!findTransition(tr.id));

    // --------------------------------------------------------- drawing it
    const cv = document.createElement('canvas');
    cv.width = 720; cv.height = 1280;
    const cx = cv.getContext('2d');
    const aImg = document.createElement('canvas');
    aImg.width = 720; aImg.height = 1280;
    const actx = aImg.getContext('2d');
    actx.fillStyle = '#ff0000'; actx.fillRect(0, 0, 720, 1280);
    const bImg = document.createElement('canvas');
    bImg.width = 720; bImg.height = 1280;
    const bctx = bImg.getContext('2d');
    bctx.fillStyle = '#0000ff'; bctx.fillRect(0, 0, 720, 1280);

    /** How much of the frame is red (clip A) vs blue (clip B). */
    const mix = () => {
      const d = cx.getImageData(0, 0, 720, 1280).data;
      let red = 0, blue = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 53) {
        if (d[i] > d[i + 2] + 20) red++;
        else if (d[i + 2] > d[i] + 20) blue++;
        n++;
      }
      return { red: red / n, blue: blue / n };
    };
    const drawAt = (p) => {
      cx.clearRect(0, 0, 720, 1280);
      Trans.draw(cx, 720, 1280, tr, p, aImg, bImg, 1 / 30);
      return mix();
    };

    tr.type = 'swipe';
    tr.params = Trans.defaults('swipe').params;
    tr.easing = { kind: 'named', name: 'linear' };
    const s0 = drawAt(0), s5 = drawAt(0.5), s1 = drawAt(1);
    ok('a swipe starts on the outgoing clip', s0.red > 0.8, 'red=' + s0.red.toFixed(2));
    ok('a swipe ends on the incoming clip', s1.blue > 0.8, 'blue=' + s1.blue.toFixed(2));
    ok('halfway through it shows both', s5.red > 0.15 && s5.blue > 0.15,
      'red=' + s5.red.toFixed(2) + ' blue=' + s5.blue.toFixed(2));

    // Direction actually changes which side comes in first.
    tr.params.direction = 'left';
    tr.params.softness = 0.02;
    cx.clearRect(0, 0, 720, 1280);
    Trans.draw(cx, 720, 1280, tr, 0.5, aImg, bImg, 1 / 30);
    const leftHalf = cx.getImageData(20, 640, 1, 1).data;
    const rightHalf = cx.getImageData(700, 640, 1, 1).data;
    ok('a left-to-right swipe reveals the left side first',
      leftHalf[2] > leftHalf[0] && rightHalf[0] > rightHalf[2],
      'left=' + [...leftHalf].slice(0, 3).join(',') + ' right=' + [...rightHalf].slice(0, 3).join(','));

    tr.params.direction = 'zoomIn';
    cx.clearRect(0, 0, 720, 1280);
    Trans.draw(cx, 720, 1280, tr, 0.5, aImg, bImg, 1 / 30);
    const centre = cx.getImageData(360, 640, 1, 1).data;
    const corner = cx.getImageData(4, 4, 1, 1).data;
    ok('a zoom-in swipe opens from the centre',
      centre[2] > centre[0] && corner[0] > corner[2],
      'centre=' + [...centre].slice(0, 3).join(',') + ' corner=' + [...corner].slice(0, 3).join(','));

    // ------------------------------------------------------------- burn
    tr.type = 'burn';
    tr.params = Trans.defaults('burn').params;
    const b0 = drawAt(0.02), b1 = drawAt(0.98);
    ok('a burn starts on the outgoing clip', b0.red > 0.7, 'red=' + b0.red.toFixed(2));
    ok('a burn ends on the incoming clip', b1.blue > 0.7, 'blue=' + b1.blue.toFixed(2));

    // A film burn does not dissolve: the clips swap under the leak, so what has to hold
    // is that the outgoing clip still owns the frame going in and the incoming one owns
    // it coming out, with the swap itself buried in the bloom.
    const bIn = drawAt(0.2), bOut = drawAt(0.8);
    ok('the clips swap under the leak, not through it', bIn.red > 0.3 && bOut.blue > 0.3,
      'in red=' + bIn.red.toFixed(2) + '  out blue=' + bOut.blue.toFixed(2));

    // The bloom at the peak is what hides the cut - if it does not wash out, the join
    // shows. Measured as mean luma over the whole frame.
    cx.clearRect(0, 0, 720, 1280);
    Trans.draw(cx, 720, 1280, tr, tr.params.peakAt, aImg, bImg, 1 / 30);
    const dPk = cx.getImageData(0, 0, 720, 1280).data;
    let luma = 0, nPk = 0;
    for (let i = 0; i < dPk.length; i += 4 * 29) {
      luma += (dPk[i] * 0.299 + dPk[i + 1] * 0.587 + dPk[i + 2] * 0.114);
      nPk++;
    }
    luma /= nPk;
    ok('the bloom washes the frame out at the peak, hiding the cut', luma > 235,
      'mean luma=' + luma.toFixed(1));

    // Ember colour must actually be painted. The leak is ADDED to the picture, and these
    // fixture clips are fully saturated, so it is sampled against black frames instead -
    // there, every warm pixel can only have come from the leak itself.
    const blk = document.createElement('canvas');
    blk.width = 720; blk.height = 1280;
    blk.getContext('2d').fillRect(0, 0, 720, 1280);
    cx.clearRect(0, 0, 720, 1280);
    Trans.draw(cx, 720, 1280, tr, 0.62, blk, blk, 1 / 30);
    const d1 = cx.getImageData(0, 0, 720, 1280).data;
    let embers = 0;
    for (let i = 0; i < d1.length; i += 4 * 29) {
      if (d1[i] > 180 && d1[i + 1] > 40 && d1[i] > d1[i + 2] + 60) embers++;
    }
    ok('the leak lays warm ember colour over the frame', embers > 5, embers + ' ember samples');

    const snap = () => {
      cx.clearRect(0, 0, 720, 1280);
      Trans.draw(cx, 720, 1280, tr, 0.42, aImg, bImg, 1 / 30);
      return cx.getImageData(0, 0, 720, 1280).data.slice(0, 4000).join(',');
    };
    ok('the burn pattern is deterministic (preview and render must agree)', snap() === snap());
    const seedA = snap();
    tr.params.seed = tr.params.seed + 1;
    ok('a different seed gives a different burn', snap() !== seedA);

    // ------------------------------------------------------------ object
    // A small PNG made here, so the test does not depend on any asset.
    const png = document.createElement('canvas');
    png.width = 200; png.height = 200;
    const pctx = png.getContext('2d');
    pctx.fillStyle = '#00ff00';
    pctx.beginPath(); pctx.arc(100, 100, 95, 0, 7); pctx.fill();
    const blob = await new Promise((res) => png.toBlob(res, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pngPath = D + 'trans_object.png';
    await window.api.writeTestFile(pngPath, bytes);

    tr.type = 'object';
    tr.params = Trans.defaults('object').params;
    tr.params.src = pngPath;
    tr.params.scale = 0.5;
    tr.motionBlur = { on: false, strength: 1, samples: 8 };
    const loaded = await Trans.loadImage(pngPath);
    ok('the object PNG loads', !!loaded && loaded.ok);

    const greenAt = (p) => {
      cx.clearRect(0, 0, 720, 1280);
      Trans.draw(cx, 720, 1280, tr, p, aImg, bImg, 1 / 30);
      const d = cx.getImageData(0, 0, 720, 1280).data;
      let g = 0;
      for (let i = 0; i < d.length; i += 4 * 37) {
        if (d[i + 1] > 150 && d[i] < 120 && d[i + 2] < 120) g++;
      }
      return g;
    };
    ok('the object is off-frame at the start', greenAt(0) === 0, greenAt(0) + ' green');
    ok('the object covers the frame in the middle', greenAt(0.5) > 20, greenAt(0.5) + ' green');
    ok('the object is gone again by the end', greenAt(1) === 0, greenAt(1) + ' green');

    // The clips swap while the object is over them.
    tr.params.switchAt = 0.5;
    tr.params.scale = 0.05;             // tiny object, so the underlying clip is visible
    const u0 = drawAt(0.3), u1 = drawAt(0.7);
    ok('the clips swap underneath the object', u0.red > 0.7 && u1.blue > 0.7,
      'before=' + u0.red.toFixed(2) + ' red, after=' + u1.blue.toFixed(2) + ' blue');

    // Motion blur must smear the object.
    tr.params.scale = 0.5;
    tr.motionBlur = { on: false, strength: 1.5, samples: 10 };
    const sharp = greenAt(0.35);
    tr.motionBlur.on = true;
    const blurred = greenAt(0.35);
    ok('motion blur spreads the object out', blurred !== sharp,
      'sharp=' + sharp + ' blurred=' + blurred);

    // --------------------------------------------------------- the render job
    tr.type = 'swipe';
    tr.params = Trans.defaults('swipe').params;
    tr.duration = 0.4;
    const job = buildJob(OUT, { from: 0, to: projectDuration() });
    const te = job.clips.filter((c) => c.kind === 'trans');
    ok('the job carries the transition', te.length === 1, te.length + ' entries');
    ok('it covers the transition window', te.length === 1 && near(te[0].out - te[0].in, 0.4, 0.01),
      te.length ? (te[0].out - te[0].in).toFixed(3) : 'n/a');
    ok('it starts where the window does', te.length === 1 && near(te[0].start, 3 - 0.2, 0.01),
      te.length ? te[0].start.toFixed(3) : 'n/a');
    ok('it sits after its own tracks clips in the chain',
      job.clips.indexOf(te[0]) > job.clips.findIndex((c) => c.kind === 'video'));

    // Editing the transition must change the cache key; moving nothing must not.
    const k1 = jobCacheKey(buildJob(OUT, { from: 0, to: projectDuration() }));
    tr.params.blur = 60;
    const k2 = jobCacheKey(buildJob(OUT, { from: 0, to: projectDuration() }));
    ok('changing a transition invalidates the render cache', k1 !== k2);
    tr.params.blur = Trans.defaults('swipe').params.blur;
    ok('putting it back restores the key',
      jobCacheKey(buildJob(OUT, { from: 0, to: projectDuration() })) === k1);

    // ------------------------------------------------------ bake and render
    const job2 = buildJob(OUT, { from: 0, to: projectDuration() });
    job2.cacheKey = jobCacheKey(job2);
    const t0 = Date.now();
    const dirs = await bakeOverlays(job2);
    const bakeMs = Date.now() - t0;
    ok('the transition bakes', dirs.length >= 1, dirs.length + ' dir(s) in ' + bakeMs + 'ms');
    const baked = job2.clips.find((c) => c.kind === 'trans');
    ok('the baked layer covers the whole frame',
      baked && baked.bw === job2.width && baked.bh === job2.height,
      baked ? baked.bw + 'x' + baked.bh : 'none');
    ok('the clip references were stripped before IPC',
      job2.clips.every((c) => c.transRef === undefined));

    const res = await window.api.startRender(job2);
    ok('ffmpeg renders a timeline with a transition', res.ok,
      res.ok ? '' : String(res.error).split('\n').slice(-4).join(' | '));
    for (const d of dirs) window.api.endTextSeq(d);

    if (res.ok) {
      // Read the middle of the transition back: it must be neither clip on its own.
      // One element, reused for every probe. A `?t=` cache-buster on a file:// URL stops
      // Chromium decoding it at all - the element still fires loadeddata, but every frame
      // drawn from it comes back blank - so the path is passed through untouched.
      const probe = document.createElement('video');
      probe.src = 'file:///' + OUT.replace(/\\/g, '/');
      probe.muted = true;
      await new Promise((resolve) => {
        probe.addEventListener('loadeddata', resolve, { once: true });
        probe.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 4000);
      });
      // `seeked` fires when the seek completes, NOT when the new frame is presented, so
      // drawing on it can hand back the previous frame - two different timestamps then
      // come back byte-identical. requestVideoFrameCallback fires on actual presentation.
      const frameAt = (t) => new Promise((resolve) => {
        if (probe.readyState < 2) return resolve(null);
        let settled = false;
        const grab = () => {
          if (settled) return;
          settled = true;
          const c2 = document.createElement('canvas');
          c2.width = 720; c2.height = 1280;
          const g = c2.getContext('2d');
          g.drawImage(probe, 0, 0, 720, 1280);
          resolve(g.getImageData(0, 0, 720, 1280).data);
        };
        if (probe.requestVideoFrameCallback) probe.requestVideoFrameCallback(grab);
        else probe.addEventListener('seeked', () => requestAnimationFrame(grab), { once: true });
        probe.currentTime = t;
        setTimeout(grab, 2500);
      });
      // Compare the middle of the transition against plain frames of each clip. A blend
      // must differ from both; a straight cut would match one of them.
      const sig = (d) => {
        if (!d) return null;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4 * 41) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        return [r / n, g / n, b / n];
      };
      const dist = (p, q) => (p && q)
        ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : -1;

      await frameAt(1.0);          // the first seek after load can land before a frame does
      const onlyA = sig(await frameAt(1.5));
      const onlyB = sig(await frameAt(4.5));
      const mid = sig(await frameAt(3.0));
      ok('the rendered file has a frame at the cut', !!mid,
        mid ? mid.map((v) => v.toFixed(0)).join(',') : 'none');
      // NB: the two fixture clips carry the SAME testsrc video (only their audio differs),
      // so they cannot be told apart by picture. That is fine for what matters here - the
      // frame inside the window must differ from an untouched clip frame, which only
      // happens if the baked transition layer really made it into the MP4.
      ok('the plain clip frames read the same (shared fixture video)',
        dist(onlyA, onlyB) < 3,
        'A=' + onlyA.map((v) => v.toFixed(0)).join(',') + ' B=' + onlyB.map((v) => v.toFixed(0)).join(','));
      ok('the frame inside the transition differs from an untouched clip frame',
        dist(mid, onlyA) > 5 && dist(mid, onlyB) > 5,
        'mid=' + mid.map((v) => v.toFixed(0)).join(',') +
        '  dA=' + dist(mid, onlyA).toFixed(1) + ' dB=' + dist(mid, onlyB).toFixed(1));
    }

    // ------------------------------------------------------------- presets
    tr.type = 'burn';
    tr.params = Trans.defaults('burn').params;
    tr.params.glow = 1.7;
    tr.params.seed = 4242;
    tr.duration = 0.75;
    tr.motionBlur = { on: true, strength: 1.4, samples: 12 };

    const preset = Trans.extractPreset(tr);
    preset.name = '__smoke_trans__';
    ok('a preset carries the look', preset.type === 'burn' &&
      preset.params.glow === 1.7 && preset.duration === 0.75);
    ok('a preset does NOT carry which cut it sits on',
      preset.aId === undefined && preset.bId === undefined && preset.id === undefined,
      Object.keys(preset).join(','));

    await window.api.savePreset('trans', '__smoke_trans__', preset);
    const listed = await window.api.listPresets();
    ok('transitions get their own preset library',
      listed.trans && listed.trans.includes('__smoke_trans__'),
      JSON.stringify(Object.keys(listed)));

    const readBack = await window.api.loadPreset('trans', '__smoke_trans__');
    ok('the preset reads back', !!readBack && readBack.type === 'burn');

    // Apply it to a transition that currently looks nothing like it.
    tr.type = 'swipe';
    tr.params = Trans.defaults('swipe').params;
    tr.duration = 0.2;
    tr.motionBlur = { on: false, strength: 0, samples: 4 };
    const keptA = tr.aId, keptB = tr.bId, keptId = tr.id;
    Trans.applyPreset(tr, readBack);
    ok('applying a preset restores the type and parameters',
      tr.type === 'burn' && tr.params.glow === 1.7 && tr.params.seed === 4242,
      tr.type + ' glow=' + tr.params.glow);
    ok('it restores the length and motion blur',
      near(tr.duration, 0.75) && tr.motionBlur.on && tr.motionBlur.samples === 12);
    ok('it leaves the transition attached to its own cut',
      tr.aId === keptA && tr.bId === keptB && tr.id === keptId);
    ok('the preset still resolves against the timeline', !!findTransition(tr.id));

    // A preset saved before a parameter existed must still produce a drawable transition.
    const partial = { kind: 'trans', type: 'burn', params: { glow: 0.5 } };
    Trans.applyPreset(tr, partial);
    ok('a partial preset is filled in from the defaults',
      tr.params.edge != null && tr.params.color != null && tr.params.glow === 0.5,
      JSON.stringify(tr.params));

    // Keeping the length is an option, for dropping a look onto an existing timing.
    tr.duration = 0.33;
    Trans.applyPreset(tr, readBack, { keepLength: true });
    ok('a preset can be applied without changing the length', near(tr.duration, 0.33),
      tr.duration.toFixed(2));

    await window.api.deletePreset('trans', '__smoke_trans__');
    const after = await window.api.listPresets();
    ok('a preset can be deleted', !(after.trans || []).includes('__smoke_trans__'));

    tr.type = 'swipe';
    tr.params = Trans.defaults('swipe').params;
    tr.duration = 0.6;

    // ---------------------------------------------------------- persistence
    const ser = JSON.parse(JSON.stringify(serialize()));
    const serTrack = ser.tracks.find((t) => t.transitions && t.transitions.length);
    ok('transitions are saved with the project', !!serTrack && serTrack.transitions.length === 1);
    ok('the saved transition keeps its clips and settings',
      serTrack && serTrack.transitions[0].aId === tr.aId && serTrack.transitions[0].type === 'swipe');

    // ------------------------------------------------------------- removal
    deleteTransition(tr.id);
    ok('a transition can be removed', vtrack.transitions.length === 0);
    undo();
    ok('undo brings it back',
      state.tracks.find((t) => t.type === 'video').transitions.length === 1);

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
