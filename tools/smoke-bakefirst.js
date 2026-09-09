/**
 * Bake-first rendering: the renderer composites, ffmpeg encodes.
 *
 *   SHORTCUT_SMOKE=tools/smoke-bakefirst.js node_modules/.bin/electron .
 *
 * Three things this exists to prove:
 *   - a composited span comes out of a real ffmpeg render pixel-identical to what the
 *     preview canvas paints for the same frame;
 *   - the fast path still triggers for a plain single clip, and its argument list is the
 *     same trim/crop/scale/overlay chain it has always been;
 *   - both paths are timed, so the README can carry real numbers rather than adjectives.
 *
 * Reuses smoke-layers.js's two fixtures in %TEMP%\scut_test\ - a flat blue clip and a
 * 50%-alpha red PNG, so a blend has an arithmetic answer rather than an eyeball one:
 *   ffmpeg -y -f lavfi -i color=c=0x2060C0:s=1080x1920:r=30:d=4 \
 *          -f lavfi -i sine=frequency=440:duration=4 \
 *          -c:v libx264 -pix_fmt yuv420p -c:a aac flat_blue.mp4
 *   ffmpeg -y -f lavfi -i "color=c=0xFF0000@0.5:s=1080x1920,format=rgba" \
 *          -frames:v 1 half_red.png
 * Writes to %TEMP%\scut_test\bakefirst_*.mp4.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const VID = D + 'flat_blue.mp4';
    const PNG = D + 'half_red.png';

    state.out.w = 540; state.out.h = 960; state.out.fps = 30; state.out.quality = 'fast';
    state.previewScale = 1;
    resizeCanvas();

    await importPaths([VID]);
    await sleep(1000);
    const vid = allClips().map((x) => x.clip).find((c) => c.kind === 'video');
    if (!vid) return 'FAIL  the fixture clip did not import - is flat_blue.mp4 there?';
    vid.start = 0; vid.out = Math.min(vid.mediaDuration, 3); vid.in = 0;
    const aud = allClips().map((x) => x.clip).find((c) => c.kind === 'audio');
    if (aud) { aud.start = 0; aud.in = 0; aud.out = Math.min(aud.mediaDuration, 3); }
    renderAll();

    // ================================================== the fast path, alone
    let job = buildJob(D + 'bakefirst_fast.mp4', { from: 0, to: 3 });
    let spans = compositeSpans(job);
    ok('a single plain clip needs no composite bake', spans.length === 0,
      JSON.stringify(spans));

    const fastArgs = (await window.api.buildArgs(job, null)).args || [];
    const fastFc = fastArgs[fastArgs.indexOf('-filter_complex') + 1];
    ok('the fast path is still the trim/crop/scale/overlay chain',
      /trim=start=/.test(fastFc) && /crop=w=/.test(fastFc) && /scale=540:960/.test(fastFc) &&
      /overlay=0:0:eof_action=repeat/.test(fastFc));
    ok('the fast path feeds ffmpeg no rawvideo input',
      fastArgs.indexOf('rawvideo') === -1);

    // Baking a fast job must be a no-op: nothing dropped, nothing added.
    const beforeBake = job.clips.length;
    let dirs = await bakeOverlays(job);
    ok('baking a fast-path job produces no layers and drops nothing',
      dirs.length === 0 && job.clips.length === beforeBake &&
      job.clips.filter((c) => c.visible).length === 1);
    for (const d of dirs) window.api.endTextSeq(d);

    // ================================================== add a second picture layer
    await importPaths([PNG], { at: 0 });
    await sleep(800);
    const img = allClips().map((x) => x.clip).find((c) => c.kind === 'image');
    if (!img) return results.join('\n') + '\nFAIL  half_red.png did not import';
    img.start = 1; img.in = 0; img.out = 1;      // length 1: covers 1.0 - 2.0 s, over the footage
    renderAll();
    await sleep(400);

    job = buildJob(D + 'bakefirst_comp.mp4', { from: 0, to: 3 });
    spans = compositeSpans(job);
    ok('two stacked pictures disqualify the span from the fast path',
      spans.length === 1 && Math.abs(spans[0].from - 1) < 1e-3 && Math.abs(spans[0].to - 2) < 1e-3,
      JSON.stringify(spans));

    // The rest of the timeline is untouched: only the overlap bakes.
    ok('the spans either side stay on the fast path',
      !needsCompositeAt(0.5, []) && !needsCompositeAt(2.5, []));

    // An effect stack disqualifies a lone clip too - the step 7 hook.
    vid.fx = [{ id: 'x', type: 'blur', enabled: true, params: {} }];
    ok('a clip carrying an effect stack disqualifies its span', needsCompositeAt(0.5, []));
    vid.fx = [{ id: 'x', type: 'blur', enabled: false, params: {} }];
    ok('a disabled effect does not', !needsCompositeAt(0.5, []));
    delete vid.fx;

    // A transition window keeps the existing chain - a composite layer would cover it.
    ok('a transition window is excluded from bake spans',
      !needsCompositeAt(1.5, [{ from: 1.4, to: 1.6 }]));

    // ================================================== what the preview paints
    state.playhead = 1.5;
    syncMedia();
    await sleep(900);
    drawPreview();
    await sleep(120);
    drawPreview();
    const P = previewSize();
    const px = (x, y) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const previewPx = px(P.w / 2, P.h / 2);
    // 50% red over 0x2060C0: r = 255*.5 + 0x20*.5, g = 0x60*.5, b = 0xC0*.5.
    const want = [Math.round((255 + 0x20) / 2), Math.round(0x60 / 2), Math.round(0xC0 / 2)];
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    ok('the preview composites the 50% PNG over the footage arithmetically',
      near(previewPx[0], want[0], 12) && near(previewPx[1], want[1], 12) && near(previewPx[2], want[2], 12),
      'preview=' + previewPx.join(',') + ' want=' + want.join(','));

    // ================================================== bake + render for real
    job = buildJob(D + 'bakefirst_comp.mp4', { from: 0, to: 3 });
    job.cacheKey = jobCacheKey(job);
    job.useCache = false;
    const tBake = Date.now();
    dirs = await bakeOverlays(job);
    const bakeMs = Date.now() - tBake;

    ok('the composited span baked one raw layer', dirs.length === 1, 'dirs=' + dirs.length);
    const baked = job.clips.filter((c) => c.kind === 'baked');
    ok('the bake became one opaque full-frame clip on the job',
      baked.length === 1 && baked[0].bw === job.width && baked[0].bh === job.height &&
      Math.abs(baked[0].start - 1) < 1e-3 && Math.abs(baked[0].out - 1) < 1e-3,
      JSON.stringify(baked.map((b) => [b.start, b.out, b.bw, b.bh])));
    ok('the baked layer is appended LAST, so it wins inside its window',
      job.clips[job.clips.length - 1].kind === 'baked');
    ok('a clip wholly inside a bake span is dropped from the picture chain',
      job.clips.some((c) => c.kind === 'image' && !c.visible),
      'image visible=' + job.clips.filter((c) => c.kind === 'image').map((c) => c.visible));
    ok('a clip STRADDLING the span keeps its own chain outside it',
      job.clips.some((c) => c.kind === 'video' && c.visible));

    const compArgs = (await window.api.buildArgs(job, null)).args || [];
    ok('the baked layer arrives as a rawvideo rgba input at output size',
      compArgs.join(' ').indexOf('-f rawvideo -pixel_format rgba -video_size 540x960') !== -1,
      compArgs.filter((a) => /rawvideo|540x960/.test(a)).join(' '));

    const tEnc = Date.now();
    const res = await window.api.startRender(job);
    const encMs = Date.now() - tEnc;
    for (const d of dirs) window.api.endTextSeq(d);
    ok('the bake-first render completes', res.ok, res.error || '');
    if (!res.ok) return results.join('\n');

    // ================================================== the pixels must agree
    const probe = document.createElement('video');
    probe.src = 'file:///' + res.outPath.replace(/\\/g, '/');
    probe.muted = true;
    await new Promise((r) => { probe.onloadeddata = r; probe.onerror = r; probe.load(); setTimeout(r, 6000); });
    probe.currentTime = 1.5;
    await new Promise((r) => { probe.onseeked = r; setTimeout(r, 4000); });
    const cv = document.createElement('canvas');
    cv.width = job.width; cv.height = job.height;
    const c2 = cv.getContext('2d');
    c2.drawImage(probe, 0, 0, job.width, job.height);
    const rd = c2.getImageData(job.width / 2 | 0, job.height / 2 | 0, 1, 1).data;
    const renderPx = [rd[0], rd[1], rd[2]];
    // yuv420p round-trips through 8-bit chroma, so the tolerance is the codec's, not ours.
    ok('THE HEADLINE: the rendered composite matches the preview canvas',
      near(renderPx[0], previewPx[0], 8) && near(renderPx[1], previewPx[1], 8) &&
      near(renderPx[2], previewPx[2], 8),
      'render=' + renderPx.join(',') + ' preview=' + previewPx.join(','));

    // A frame OUTSIDE the bake span came down the fast path - it must be the plain clip.
    probe.currentTime = 0.5;
    await new Promise((r) => { probe.onseeked = r; setTimeout(r, 4000); });
    c2.drawImage(probe, 0, 0, job.width, job.height);
    const fd = c2.getImageData(job.width / 2 | 0, job.height / 2 | 0, 1, 1).data;
    ok('a fast-path frame in the same render is the untouched footage',
      near(fd[0], 0x20, 10) && near(fd[1], 0x60, 10) && near(fd[2], 0xC0, 10),
      [fd[0], fd[1], fd[2]].join(','));

    // ================================================== both paths, timed
    // The same three seconds with the overlay moved out of the way, so the comparison is
    // fast-path-only against fast-path-plus-one-composited-second, not against itself.
    const parked = img.start;
    img.start = 20;
    const fastJob = buildJob(D + 'bakefirst_fast.mp4', { from: 0, to: 3 });
    ok('the timing baseline really is all fast path', compositeSpans(fastJob).length === 0);
    fastJob.cacheKey = jobCacheKey(fastJob);
    fastJob.useCache = false;
    const t0 = Date.now();
    const fdirs = await bakeOverlays(fastJob);
    const fBake = Date.now() - t0;
    const t1 = Date.now();
    const fres = await window.api.startRender(fastJob);
    const fEnc = Date.now() - t1;
    for (const d of fdirs) window.api.endTextSeq(d);
    img.start = parked;
    ok('the fast-path render completes', fres.ok, fres.error || '');
    note('TIMINGS at ' + job.width + 'x' + job.height + ', 3.00 s, quality=fast');
    note('  fast path  : bake ' + fBake + ' ms + encode ' + fEnc + ' ms = ' + (fBake + fEnc) + ' ms');
    note('  bake-first : bake ' + bakeMs + ' ms + encode ' + encMs + ' ms = ' + (bakeMs + encMs) +
      ' ms  (1.00 s of it composited)');
    ok('the fast path is genuinely the cheaper of the two', fBake + fEnc < bakeMs + encMs,
      (fBake + fEnc) + ' ms vs ' + (bakeMs + encMs) + ' ms');

    // ================================================== the cache key rules still hold
    // The key is taken BEFORE baking, and a bake must leave the timeline exactly as it
    // found it - otherwise rebuilding the job to ask "is this span still cached?" would
    // hash something different from what the render was filed under, and no span would
    // ever light up on the bar.
    const k1 = jobCacheKey(buildJob(D + 'somewhere.mp4', { from: 0, to: 3 }));
    ok('the key survives the bake that has already run', k1 === job.cacheKey,
      k1 + ' / ' + job.cacheKey);
    ok('the destination filename is not in the key',
      k1 === jobCacheKey(buildJob(D + 'elsewhere.mp4', { from: 0, to: 3 })));

    // The scratch dir a bake allocates is random, so a key taken AFTER one could never
    // hit. That is why main refuses to cache a baked job that arrives without a key.
    ok('a baked job carries a key computed before the scratch dirs existed',
      job.clips.some((c) => c.kind === 'baked' && c.seqDir) &&
      k1.indexOf('shortcut-text-') === -1);

    img.zoom = 1.7;
    const k4 = jobCacheKey(buildJob('', { from: 0, to: 3 }));
    img.zoom = 1;
    ok('but reframing a composited layer changes it', k1 !== k4);

    // ================================================== nothing leaked onto the clips
    const round = JSON.parse(JSON.stringify(state.tracks));
    ok('the baker leaves nothing non-serialisable on a clip',
      JSON.stringify(round) === JSON.stringify(state.tracks));

    return results.join('\n');
  } catch (e) {
    return 'SMOKE THREW: ' + (e && e.stack || e);
  }
})();
