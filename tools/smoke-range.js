/**
 * Ranged rendering and the cached-render bar.
 *
 *   SHORTCUT_SMOKE=tools/smoke-range.js node_modules/.bin/electron .
 *
 * Needs %TEMP%\scut_test\clip1.mp4 and clip2.mp4 (see tools/smoke.js).
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const OUT = D + 'range_out.mp4';

    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    await new Promise((r) => setTimeout(r, 900));
    state.out.w = 720; state.out.h = 1280; state.out.fps = 30; state.out.quality = 'draft';
    const total = projectDuration();
    ok('two clips imported end to end', near(total, 6, 0.2), 'duration=' + total.toFixed(2));

    // ------------------------------------------------------------- marks
    seek(2);
    setInPoint();
    seek(4);
    setOutPoint();
    ok('in/out marks are set', state.inPoint === 2 && state.outPoint === 4,
      state.inPoint + ' -> ' + state.outPoint);
    let r = renderRange();
    ok('the render range follows the marks', r.from === 2 && r.to === 4 && r.ranged);

    // An out mark before the in mark must not produce a backwards range.
    seek(1); setOutPoint();
    ok('an out mark before the in mark drops the in mark', state.inPoint === null,
      'in=' + state.inPoint + ' out=' + state.outPoint);
    seek(2); setInPoint();
    seek(4); setOutPoint();

    clearRange();
    ok('X clears the marks', state.inPoint === null && state.outPoint === null);
    ok('with no marks the range is the whole project',
      near(renderRange().from, 0) && near(renderRange().to, total));

    // ------------------------------------------------- clips cropped to a range
    seek(2); setInPoint();
    seek(4); setOutPoint();
    r = renderRange();
    const job = buildJob(OUT, r);
    ok('the job covers only the range', near(job.duration, 2), 'duration=' + job.duration.toFixed(3));
    ok('the job records the range', job.rangeFrom === 2 && job.rangeTo === 4);
    // 2-4s straddles the cut at 3s, so BOTH clips (and both their audio halves) belong.
    ok('every clip touching the range is included', job.clips.length === 4,
      job.clips.length + ' clip entries');
    // A clip nowhere near the range must not be.
    seek(5.5);
    const far = addTextCard('FAR AWAY');
    far.start = 5.5; far.out = 6;
    sortTracks();
    const jobFar = buildJob(OUT, { from: 2, to: 4 });
    ok('a clip outside the range is dropped',
      !jobFar.clips.some((c) => c.kind === 'text'), jobFar.clips.length + ' entries');
    deleteSelected(false);
    ok('the first clip starts at zero in range time',
      job.clips.every((c) => c.start >= -1e-6 && c.start < 2.001),
      job.clips.map((c) => c.start.toFixed(2)).join(','));
    ok('a clip cut by the range start has its in-point moved',
      job.clips.some((c) => c.in > 0.5), job.clips.map((c) => c.in.toFixed(2)).join(','));
    ok('nothing runs past the end of the range',
      job.clips.every((c) => c.start + (c.out - c.in) <= 2.001),
      job.clips.map((c) => (c.start + (c.out - c.in)).toFixed(2)).join(','));

    // ------------------------------------------- a text card cut by the range
    seek(1);
    const card = addTextCard('RANGED');
    card.start = 1; card.out = 4;      // spans the in point
    card.card.style.fontSize = 90;
    sortTracks();
    const job2 = buildJob(OUT, renderRange());
    const te = job2.clips.find((c) => c.kind === 'text');
    ok('a card crossing the in point is kept', !!te);
    ok('the card is baked from the right point in its animation',
      te && near(te.tStart, 1), 'tStart=' + (te ? te.tStart : 'n/a'));
    ok('the card starts at zero in range time', te && near(te.start, 0),
      'start=' + (te ? te.start.toFixed(3) : 'n/a'));

    // ------------------------------------------------------- ranged render
    await window.api.textCacheClear();
    const t0 = Date.now();
    job2.cacheKey = jobCacheKey(job2);
    job2.useCache = true;
    const dirs = await bakeTextClips(job2);
    const res = await window.api.startRender(job2);
    const rangedMs = Date.now() - t0;
    ok('the ranged render succeeded', res.ok,
      res.ok ? rangedMs + 'ms' : String(res.error).split('\n').slice(-3).join(' | '));

    // The rendered file must be the length of the RANGE, not of the project.
    const probeLen = () => new Promise((resolve) => {
      const v = document.createElement('video');
      v.src = 'file:///' + OUT.replace(/\\/g, '/') + '?t=' + Date.now();
      v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
      v.addEventListener('error', () => resolve(-1), { once: true });
    });
    const len = await probeLen();
    ok('the output is only as long as the range', near(len, 2, 0.15), 'duration=' + len.toFixed(2) + 's');

    // A whole-project render of the same edit is a different, longer job.
    const jobAll = buildJob(OUT, { from: 0, to: total });
    ok('a whole-project job is longer', jobAll.duration > job2.duration + 1,
      jobAll.duration.toFixed(2) + 's vs ' + job2.duration.toFixed(2) + 's');
    ok('the two jobs have different cache keys', jobCacheKey(jobAll) !== jobCacheKey(job2));

    // ------------------------------------------------------- the cache bar
    // Bands come from PREVIEW renders, not exports: an export is full resolution and is
    // not what the viewer plays back, so it deliberately does not light the bar.
    await refreshCacheBands(true);
    await new Promise((rr) => setTimeout(rr, 300));
    ok('an export alone does not light the cache bar',
      !state.cacheBands.some((b) => near(b.from, 2, 0.05)),
      JSON.stringify(state.cacheBands));

    $('#renderRange').value = 'marks';   // doPreviewRender reads the range from the UI
    await doPreviewRender();
    await new Promise((rr) => setTimeout(rr, 300));
    ok('a preview render of the range shows as cached',
      state.cacheBands.some((b) => near(b.from, 2, 0.05) && near(b.to, 4, 0.05)),
      JSON.stringify(state.cacheBands));

    // Rendering it again must be served from the cache.
    const job3 = buildJob(OUT, renderRange());
    job3.cacheKey = jobCacheKey(job3);
    job3.useCache = true;
    await bakeTextClips(job3);
    const t1 = Date.now();
    const res3 = await window.api.startRender(job3);
    ok('re-rendering the same range hits the cache', res3.ok && res3.cached === true,
      (Date.now() - t1) + 'ms cached=' + res3.cached);

    // "Render full" must ignore the cache and encode again.
    const job4 = buildJob(OUT, renderRange());
    job4.cacheKey = jobCacheKey(job4);
    job4.useCache = false;
    await bakeTextClips(job4);
    const res4 = await window.api.startRender(job4);
    ok('Render full ignores the cache', res4.ok && !res4.cached, 'cached=' + res4.cached);

    // Editing inside the range must drop its band.
    card.card.style.fontSize = 130;
    await refreshCacheBands(true);
    await new Promise((rr) => setTimeout(rr, 300));
    ok('editing inside a cached range clears its band',
      !state.cacheBands.some((b) => near(b.from, 2, 0.05) && near(b.to, 4, 0.05)),
      JSON.stringify(state.cacheBands));

    // Undoing the edit brings it back - the key is content, not history.
    card.card.style.fontSize = 90;
    await refreshCacheBands(true);
    await new Promise((rr) => setTimeout(rr, 300));
    ok('putting the content back restores the band',
      state.cacheBands.some((b) => near(b.from, 2, 0.05) && near(b.to, 4, 0.05)),
      JSON.stringify(state.cacheBands));

    // ------------------------------------------------------------ project IO
    const ser = JSON.parse(JSON.stringify(serialize()));
    ok('the marks are saved with the project', ser.inPoint === 2 && ser.outPoint === 4,
      ser.inPoint + ' -> ' + ser.outPoint);

    // ------------------------------------------------------------- the ruler
    renderRuler();
    // Against the CONSTANT, not against a number typed here. The ruler grew a marker lane
    // and this assertion was the only thing in the app still claiming it was 38 pixels
    // tall - a literal here is a second source of truth for a layout that has one.
    const rulerCv = document.querySelector('#ruler');
    ok('the ruler is as tall as the layout says', rulerCv.height === RULER_H, rulerCv.height);
    ok('...and the three strips fit inside it without overlapping',
      MARK_LANE_Y > 26 && MARK_LANE_Y + MARK_BAR_H + CACHE_BAR_H === RULER_H,
      MARK_LANE_Y + ' + ' + MARK_BAR_H + ' + ' + CACHE_BAR_H + ' = ' + RULER_H);
    $('#renderRange').value = 'marks';
    renderRangeOverlay();
    const ov = document.querySelector('#rangeOverlay');
    ok('the area outside the range is shaded', !ov.classList.contains('off') &&
      parseFloat(ov.querySelector('.before').style.width) > 0,
      'before=' + ov.querySelector('.before').style.width);
    $('#renderRange').value = 'all';
    renderRangeOverlay();
    ok('the shading goes away for a whole-project render', ov.classList.contains('off'));

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
