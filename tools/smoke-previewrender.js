/**
 * Preview renders: rendering into the app's own cache, and the VIEWER PLAYING IT BACK.
 *
 *   SHORTCUT_SMOKE=tools/smoke-previewrender.js node_modules/.bin/electron .
 *
 * The point of these assertions is the last mile: it is not enough that the render cache
 * has a file, the left-hand viewer has to actually decode it instead of compositing.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';

    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    await sleep(900);
    state.out.w = 720; state.out.h = 1280; state.out.fps = 30; state.out.quality = 'draft';
    resizeCanvas();

    // A card with a distinctive flat colour, so a rendered frame is recognisable.
    seek(1);
    const card = addTextCard('PREVIEW');
    card.start = 1; card.out = 4;
    card.card.style.fontSize = 150;
    card.card.style.anims = [];
    card.card.anims = [];
    sortTracks();
    setSelection([], false);

    await window.api.textCacheClear();
    await refreshCacheBands(true);
    await sleep(200);
    ok('no rendered spans to begin with', state.cacheBands.length === 0,
      JSON.stringify(state.cacheBands));

    // ------------------------------------------------- render a preview span
    $('#renderRange').value = 'marks';
    seek(1.5); setInPoint();
    seek(3.5); setOutPoint();

    await doPreviewRender();
    await sleep(400);

    ok('the span is now marked as rendered',
      state.cacheBands.some((b) => near(b.from, 1.5, 0.05) && near(b.to, 3.5, 0.05)),
      JSON.stringify(state.cacheBands.map((b) => [b.from, b.to])));
    const band = state.cacheBands.find((b) => near(b.from, 1.5, 0.05));
    if (!band) {
      const idx = await window.api.renderCacheIndex();
      results.push('ABORTED: no rendered span was registered.');
      results.push('cacheBands=' + JSON.stringify(state.cacheBands));
      results.push('index=' + JSON.stringify(idx));
      return results.join('\n');
    }
    ok('the span knows which file to play', !!(band && band.file), band ? band.file : 'none');

    // The whole point: nothing lands in the user's folders.
    ok('the rendered file lives in the app cache, not the project folder',
      !!band && /cache[\\/\\\\]render/.test(band.file), band ? band.file : 'none');

    // ------------------------------------------------- the viewer plays it
    seek(2.5);
    ok('the playhead is inside a rendered span', !!activePreviewBand());

    // Give the player a moment to load and seek, then confirm it is what got drawn.
    for (let i = 0; i < 40 && !(previewEls.get(band.key) || {}).videoWidth; i++) {
      syncMedia(); drawPreview(); await sleep(100);
    }
    const pel = previewEls.get(band.key);
    ok('a player was created for the rendered span', !!pel);
    ok('the rendered file decodes', !!pel && pel.videoWidth > 0,
      pel ? pel.videoWidth + 'x' + pel.videoHeight : 'no element');
    ok('the player is at the right time', !!pel && near(pel.currentTime, 1.0, 0.35),
      pel ? 'currentTime=' + pel.currentTime.toFixed(2) + ' (want ~1.0)' : 'n/a');

    // Prove the CANVAS shows the rendered frame, not a live composite. With the render
    // switched off the same instant is composited; both must be non-black and agree.
    const snapshot = () => {
      const c = document.querySelector('#preview');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
      return sum / n;
    };

    state.usePreviewRender = true;
    syncMedia(); drawPreview(); await sleep(120); drawPreview();
    const fromRender = snapshot();
    ok('the viewer paints something while a render is up', fromRender > 8,
      'meanRGB=' + fromRender.toFixed(1));

    state.usePreviewRender = false;
    syncMedia();
    await sleep(900);
    drawPreview(); await sleep(120); drawPreview();
    const fromLive = snapshot();
    ok('compositing live at the same instant looks the same',
      Math.abs(fromRender - fromLive) < Math.max(12, fromLive * 0.25),
      'render=' + fromRender.toFixed(1) + ' live=' + fromLive.toFixed(1));
    state.usePreviewRender = true;

    // Source clips must be silent and idle while a rendered span is on screen.
    seek(2.5);
    syncMedia();
    await sleep(150);
    const playingSources = [...mediaEls.values()].filter((el) => !el.paused).length;
    ok('source clips are paused under a rendered span', playingSources === 0,
      playingSources + ' still playing');

    // Outside the span the viewer goes back to compositing.
    seek(5.0);
    ok('outside the span there is no rendered playback', !activePreviewBand());
    syncMedia();
    await sleep(150);
    ok('the span player is paused once the playhead leaves it',
      !!pel && pel.paused, pel ? 'paused=' + pel.paused : 'n/a');

    // ------------------------------------------------------- invalidation
    card.card.style.fontSize = 90;          // edit inside the rendered span
    await refreshCacheBands(true);
    await sleep(300);
    ok('editing inside the span drops it', !state.cacheBands.some((b) => near(b.from, 1.5, 0.05)),
      JSON.stringify(state.cacheBands.map((b) => [b.from, b.to])));
    ok('its player is thrown away too', !previewEls.has(band.key),
      previewEls.size + ' players left');
    seek(2.5);
    ok('the viewer falls back to compositing', !activePreviewBand());

    // ------------------------------------------------------- re-render path
    card.card.style.fontSize = 150;         // put it back
    await refreshCacheBands(true);
    await sleep(300);
    ok('restoring the content brings the span back',
      state.cacheBands.some((b) => near(b.from, 1.5, 0.05)));

    const t0 = Date.now();
    await doPreviewRender();
    ok('re-rendering an unchanged span is instant (served from cache)',
      Date.now() - t0 < 1200, (Date.now() - t0) + 'ms');

    // ================================================== stop during playback
    // pause() used to only walk the source-clip elements, and syncMedia() - which is what
    // stops a span's player - only runs WHILE playing. So stop left the rendered span
    // playing with nothing able to halt it.
    await refreshCacheBands(true);
    await sleep(200);
    const band2 = state.cacheBands.find((b) => near(b.from, 1.5, 0.05));
    ok('a rendered span is available for the stop test', !!band2);
    if (band2) {
      seek(2.0);
      state.usePreviewRender = true;
      play();
      for (let i = 0; i < 12; i++) { syncMedia(); await sleep(50); }
      const el2 = previewEls.get(band2.key);
      ok('the span player runs while playing', !!el2 && !el2.paused,
        el2 ? 'paused=' + el2.paused : 'no element');
      pause();
      await sleep(120);
      ok('stop actually stops the rendered span', !!el2 && el2.paused,
        el2 ? 'paused=' + el2.paused : 'no element');
      ok('stop clears the playing flag', !state.playing);

      // A rendered span's audio IS the mix, so it has to arrive at the master bus like
      // everything else - the meter hangs off master, and a span wired straight to the
      // speakers is what made the meter go dead inside a rendered band and come back on
      // the way out.
      if (previewMix.ctx && previewMix.ctx.state === 'running') {
        ok('the rendered span is routed through the preview mix',
          previewMix.bandNodes.has(band2.key),
          [...previewMix.bandNodes.keys()].length + ' band node(s)');
        ok('and it lands on the master bus, not the speakers',
          !!previewMix.master &&
          (previewMix.bandNodes.get(band2.key) || {}).gain !== undefined);
        ok('its element runs at unity, with the node carrying the level',
          !!el2 && el2.volume === 1 && !el2.muted, el2 ? String(el2.volume) : '');
      } else {
        results.push('SKIP  the rendered span is routed through the preview mix   ' +
          'no running AudioContext (headless machine with no audio device)');
      }

      // Dropping the span must drop its node too: createMediaElementSource cannot be
      // undone, so a leaked node would keep a dead element connected to the bus.
      dropPreviewEl(band2.key);
      ok('dropping the span drops its mix node', !previewMix.bandNodes.has(band2.key));
    }

    // ===================================================== preview resolution
    state.previewScale = 1;
    resizeCanvas();
    const full = previewSize();
    ok('full scale matches the output size',
      full.w === state.out.w && full.h === state.out.h, full.w + 'x' + full.h);

    state.previewScale = 0.25;
    resizeCanvas();
    const quarter = previewSize();
    ok('quarter scale quarters each side',
      quarter.w === Math.round(state.out.w / 4 / 2) * 2, quarter.w + 'x' + quarter.h);
    ok('the canvas follows the preview scale',
      document.querySelector('#preview').width === quarter.w,
      document.querySelector('#preview').width + ' vs ' + quarter.w);
    ok('the aspect ratio is preserved',
      Math.abs((quarter.w / quarter.h) - (state.out.w / state.out.h)) < 0.02,
      (quarter.w / quarter.h).toFixed(4) + ' vs ' + (state.out.w / state.out.h).toFixed(4));
    ok('dimensions stay even for yuv420p', quarter.w % 2 === 0 && quarter.h % 2 === 0);

    // A preview job renders at the viewer's resolution, not the output's.
    const pj = buildPreviewJob({ from: 1.5, to: 3.5 });
    ok('a preview job renders at the viewer resolution',
      pj.width === quarter.w && pj.height === quarter.h,
      pj.width + 'x' + pj.height);
    ok('a preview job still knows the real output aspect',
      Math.abs((pj.width / pj.height) - (state.out.w / state.out.h)) < 0.02);

    // Changing scale changes the pixels, so previously rendered spans stop matching.
    await refreshCacheBands(true);
    await sleep(250);
    ok('spans rendered at another scale no longer match',
      !state.cacheBands.some((b) => near(b.from, 1.5, 0.05)),
      JSON.stringify(state.cacheBands.map((b) => [b.from, b.to])));

    state.previewScale = 0.5;
    resizeCanvas();

    // The badge names the OUTPUT aspect, which the preview scale must not change.
    state.out.w = 1080; state.out.h = 1920; resizeCanvas();
    ok('a vertical project reads 9:16',
      document.querySelector('#aspectBadge').textContent === '9:16',
      document.querySelector('#aspectBadge').textContent);
    state.out.w = 1920; state.out.h = 1080; resizeCanvas();
    ok('a horizontal project reads 16:9',
      document.querySelector('#aspectBadge').textContent === '16:9',
      document.querySelector('#aspectBadge').textContent);
    state.out.w = 720; state.out.h = 1280; resizeCanvas();

    // ================================================ a render stops playback
    //
    // The baker drives `mediaFor()` - the viewer's OWN element per clip - and parks it on
    // each bake frame in turn. Left playing, `syncMedia()` is seeking those same elements
    // back under the playhead every frame, and the two fight: the picture stutters and
    // the audio drifts, gets corrected by a large seek, drifts again, and ends the render
    // parked mid-seek. There is one element per clip by design, so the baker can only
    // borrow it - and it cannot borrow what is still in use.
    //
    // Asserted here because the symptom is audible rather than visible, so a regression
    // would not fail anything else in this suite: it would just sound broken.
    {
      state.out.w = 480; state.out.h = 854; state.out.quality = 'draft';
      resizeCanvas();
      seek(0);
      play();
      await sleep(200);
      ok('playing, so the render has something to stop', state.playing === true);

      let playingDuringBake = null;
      const pending = doPreviewRender({ force: true });
      // Sampled WHILE the bake is running, which is the only moment the fight exists.
      await sleep(250);
      playingDuringBake = state.playing;
      await pending;

      ok('A RENDER STOPS PLAYBACK - the baker gets the media elements to itself',
        playingDuringBake === false, 'state.playing during the bake was ' + playingDuringBake);
      ok('  and every source element is parked, not still being driven',
        [...mediaEls.values()].every((el) => el.paused),
        [...mediaEls.values()].map((el) => el.paused).join(','));
      ok('  and playback still works afterwards',
        (() => { seek(0.2); play(); const on = state.playing; pause(); return on; })());
    }

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
