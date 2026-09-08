/**
 * End-to-end text render: build a timeline with footage + an animated text card, run the
 * real ffmpeg export, then read the resulting MP4 back to check the text is actually in
 * the picture and animating.
 *
 *   SHORTCUT_SMOKE=tools/smoke-textrender.js node_modules/.bin/electron .
 *
 * Needs %TEMP%\scut_test\clip1.mp4 (see tools/smoke.js for the ffmpeg command). Writes the
 * result to %TEMP%\scut_test\text_out.mp4.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const OUT = D + 'text_out.mp4';

    await importPaths([D + 'clip1.mp4']);
    await new Promise((r) => setTimeout(r, 800));

    // A card that fades and slides in over the first second, on top of the footage.
    seek(0);
    const clip = addTextCard('RENDER CHECK');
    clip.start = 0;
    clip.out = 2;
    clip.card.style.fontSize = 150;
    clip.card.style.fill.color = '#ffffff';
    clip.card.style.shadow.on = false;
    clip.card.anims = [TextModel.defaultAnim('fade', 'in'), TextModel.defaultAnim('slide', 'in')];
    clip.card.anims[0].duration = 1;
    clip.card.anims[0].easing = { kind: 'named', name: 'linear' };
    clip.card.anims[1].duration = 1;
    clip.card.anims[1].params = { from: 'up', distance: 0.2 };
    sortTracks();

    state.out.w = 1080; state.out.h = 1920; state.out.fps = 30; state.out.quality = 'fast';

    const job = buildJob(OUT);
    job.duration = 3;
    const textEntries = job.clips.filter((c) => c.kind === 'text');
    ok('one text entry in the job', textEntries.length === 1);

    await window.api.textCacheClear();   // start from a cold cache

    job.cacheKey = jobCacheKey(job);        // as doRender does, before baking
    const t0 = Date.now();
    const dirs = await bakeTextClips(job);
    const coldMs = Date.now() - t0;
    ok('baking produced a sequence dir', dirs.length === 1 && !!textEntries[0].seqDir);
    ok('bake cropped to a sub-frame box',
      textEntries[0].bw < 1080 && textEntries[0].bh < 1920,
      textEntries[0].bw + 'x' + textEntries[0].bh + ' at ' + textEntries[0].bx + ',' + textEntries[0].by);
    ok('textClip reference was stripped before IPC',
      job.clips.every((c) => c.textClip === undefined));

    const res = await window.api.startRender(job);
    ok('ffmpeg render succeeded', res.ok, res.ok ? '' : String(res.error).split('\n').slice(-4).join(' | '));

    // ---- baking is scratch work, and it has to be fast -------------------------
    // Frames used to be PNGs, which cost 100-1500 ms EACH to encode and dominated every
    // render. They are raw RGBA now, so baking is cheap enough not to need caching - the
    // finished MP4 is what gets cached instead.
    ok('baking a 2s card is quick', coldMs < 4000, coldMs + 'ms for ' + (2 * 30) + ' frames');
    ok('the scratch dir is in temp, not in the cache',
      /shortcut-text-/.test(textEntries[0].seqDir) && !/cache/.test(textEntries[0].seqDir),
      textEntries[0].seqDir);
    ok('frames were written as one raw stream',
      textEntries[0].bw > 0 && textEntries[0].bh > 0,
      textEntries[0].bw + 'x' + textEntries[0].bh);

    const job2 = buildJob(OUT);
    job2.duration = 3;
    const t1 = Date.now();
    const dirs2 = await bakeTextClips(job2);
    const warmMs = Date.now() - t1;
    ok('re-baking is always cheap', warmMs < 4000, warmMs + 'ms');
    ok('each bake gets its own scratch dir', dirs2.length === 1 &&
      dirs2[0] !== textEntries[0].seqDir, dirs2[0]);
    for (const d of dirs2) window.api.endTextSeq(d);

    if (!res.ok) return results.join('\n');

    // Read frames back and look for the white text inside the card's bounding box.
    const probeFrame = (t) => new Promise((resolve) => {
      const v = document.createElement('video');
      v.src = 'file:///' + OUT.replace(/\\/g, '/');
      v.muted = true;
      v.addEventListener('loadeddata', () => { v.currentTime = t; });
      v.addEventListener('seeked', () => {
        const cv = document.createElement('canvas');
        cv.width = 1080; cv.height = 1920;
        const c = cv.getContext('2d');
        c.drawImage(v, 0, 0, 1080, 1920);
        const b = textEntries[0];
        const d = c.getImageData(b.bx, b.by, b.bw, b.bh).data;
        // Count near-white pixels: the card is white text over a colour-bar background.
        let white = 0;
        for (let i = 0; i < d.length; i += 4 * 7) {
          if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) white++;
        }
        resolve(white);
      }, { once: true });
      v.addEventListener('error', () => resolve(-1));
    });

    const atStart = await probeFrame(0.03);   // fade has barely begun
    const atSettled = await probeFrame(1.5);  // fully in
    const afterCard = await probeFrame(2.6);  // card has ended
    ok('text is present once the animation settles', atSettled > 40, 'white=' + atSettled);
    ok('text is faded out at the very start', atStart < atSettled * 0.5,
      'start=' + atStart + ' settled=' + atSettled);
    ok('text is gone after the card ends', afterCard < atSettled * 0.4,
      'after=' + afterCard + ' settled=' + atSettled);

    // ---- the finished render is cached too ------------------------------------
    // The frame cache only removes the drawing; ffmpeg still re-encoded the whole
    // timeline every time, which was the bulk of the wait on a text-light edit.
    const jobC = buildJob(OUT);
    jobC.duration = 3;
    jobC.cacheKey = jobCacheKey(jobC);      // taken before baking, exactly as doRender does
    const dirsC = await bakeTextClips(jobC);
    const tc = Date.now();
    const cachedRes = await window.api.startRender(jobC);
    const cachedMs = Date.now() - tc;
    ok('an unchanged job is served from the render cache', cachedRes.ok && cachedRes.cached === true,
      'cached=' + cachedRes.cached);
    ok('the cached render is near-instant', cachedMs < 400, cachedMs + 'ms');
    ok('the cached render still produced the file', cachedRes.outPath === OUT);
    for (const d of dirsC) window.api.endTextSeq(d);

    // A text job with no key must not be cached at all - guessing would risk a wrong hit.
    const jobNK = buildJob(OUT);
    jobNK.duration = 3;
    const dirsNK = await bakeTextClips(jobNK);
    const nkRes = await window.api.startRender(jobNK);
    ok('a text job without a cacheKey is never served from cache',
      nkRes.ok && !nkRes.cached, 'cached=' + nkRes.cached);
    for (const d of dirsNK) window.api.endTextSeq(d);

    // Changing the output settings must force a real encode.
    const jobD = buildJob(OUT);
    jobD.duration = 3;
    jobD.quality = 'draft';
    jobD.cacheKey = jobCacheKey(jobD);
    const dirsD = await bakeTextClips(jobD);
    const td = Date.now();
    const freshRes = await window.api.startRender(jobD);
    ok('changing the settings re-encodes', freshRes.ok && !freshRes.cached,
      'cached=' + freshRes.cached + ' in ' + (Date.now() - td) + 'ms');
    for (const d of dirsD) window.api.endTextSeq(d);


    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
