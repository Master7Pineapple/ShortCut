/**
 * Real layers: alpha compositing across video tracks, and stills on the timeline.
 *
 *   SHORTCUT_SMOKE=tools/smoke-layers.js node_modules/.bin/electron .
 *
 * The headline assertion is the one the step exists for: a semi-transparent PNG over a
 * video must composite to the SAME sampled pixels in the preview canvas and in a real
 * ffmpeg render. Everything else here is the plumbing that makes that possible.
 *
 * Needs two fixtures in %TEMP%\scut_test\ - a flat-colour clip and a 50%-alpha red PNG,
 * so a blend has an arithmetic answer rather than an eyeball one:
 *   ffmpeg -y -f lavfi -i color=c=0x2060C0:s=1080x1920:r=30:d=4 \
 *          -f lavfi -i sine=frequency=440:duration=4 \
 *          -c:v libx264 -pix_fmt yuv420p -c:a aac flat_blue.mp4
 *   ffmpeg -y -f lavfi -i "color=c=0xFF0000@0.5:s=1080x1920,format=rgba" \
 *          -frames:v 1 half_red.png
 * Writes the render to %TEMP%\scut_test\layers_out.mp4.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const VID = D + 'flat_blue.mp4';
    const PNG = D + 'half_red.png';
    const OUT = D + 'layers_out.mp4';

    state.out.w = 1080; state.out.h = 1920; state.out.fps = 30; state.out.quality = 'fast';
    resizeCanvas();

    // ------------------------------------------------------ a still on the timeline
    await importPaths([VID]);
    await sleep(900);
    await importPaths([PNG], { at: 0 });
    await sleep(600);

    const vTracks = state.tracks.filter((t) => t.type === 'video');
    const img = allClips().map((x) => x.clip).find((c) => c.kind === 'image');
    const vid = allClips().map((x) => x.clip).find((c) => c.kind === 'video');
    ok('a PNG imports as an image clip', !!img, img ? img.name : 'none');
    if (!img || !vid) return results.join('\n');

    const imgTrack = allClips().find((x) => x.clip === img).track;
    const vidTrack = allClips().find((x) => x.clip === vid).track;
    ok('the still lands on a video track', imgTrack.type === 'video', imgTrack.name);
    ok('the still went on a FREE track, above the footage',
      imgTrack !== vidTrack &&
      vTracks.indexOf(imgTrack) < vTracks.indexOf(vidTrack),
      'img=' + vTracks.indexOf(imgTrack) + ' vid=' + vTracks.indexOf(vidTrack));
    ok('a still has no decoder to seek: in stays 0', img.in === 0, String(img.in));
    ok('a still has source dimensions', img.srcW === 1080 && img.srcH === 1920,
      img.srcW + 'x' + img.srcH);

    // No mediaDuration ceiling: the length is freely settable, exactly like a text card.
    const wasOut = img.out;
    img.out = 40;
    ok('a still has no source-length ceiling', img.mediaDuration >= 3600 && img.out === 40,
      'mediaDuration=' + img.mediaDuration);
    img.out = wasOut;

    // Nothing non-serialisable rides on the new clip - undo is JSON.stringify.
    const round = JSON.parse(JSON.stringify(state.tracks));
    ok('an image clip serialises and reloads intact',
      JSON.stringify(round) === JSON.stringify(state.tracks) &&
      round.some((t) => t.clips.some((c) => c.kind === 'image' && c.src === PNG)));

    // ------------------------------------------------------ the job and the args
    img.start = 0; img.out = 3;
    vid.start = 0;
    sortTracks();
    setSelection([], false);

    const job = buildJob(OUT);
    job.duration = 3;
    const imgEntry = job.clips.find((c) => c.kind === 'image');
    ok('the image is a visible entry in the job', !!imgEntry && imgEntry.visible === true);
    // Bottom track first, so the last visible entry is the topmost layer.
    const vis = job.clips.filter((c) => c.visible);
    ok('the job lists layers bottom-up', vis[vis.length - 1] === imgEntry,
      vis.map((c) => c.kind).join(','));

    const built = await window.api.buildArgs(JSON.parse(JSON.stringify(job)), null);
    ok('buildArgs runs with an image on the timeline', built.ok, built.error || '');
    const args = (built.args || []).map(String);
    const argStr = args.join(' ');
    const fcx = args[args.indexOf('-filter_complex') + 1] || '';
    ok('a still becomes a looped input with an explicit length',
      / -loop 1 -t [\d.]+ -i /.test(' ' + argStr + ' '), argStr.slice(0, 160));
    const chains = fcx.split(';').filter((p) => /trim=start=/.test(p) && /crop=/.test(p));
    ok('every picture chain carries alpha (yuva420p)',
      chains.length >= 2 && chains.every((p) => /format=yuva420p/.test(p)),
      chains.length + ' chains');
    ok('the output is still delivered as yuv420p', /format=yuv420p\[vout\]/.test(fcx));

    // ------------------------------------------------------ the preview composite
    seek(1);
    await sleep(1200);
    drawPreview();
    await sleep(80);

    const P = previewSize();
    const sample = (c2d, w, h) => {
      const d = c2d.getImageData(Math.round(w * 0.5), Math.round(h * 0.5), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const prev = sample(ctx, P.w, P.h);
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    ok('the preview composited rather than showing one layer',
      prev[0] > 90 && prev[0] < 200 && prev[2] > 40 && prev[2] < 160,
      'preview=' + prev.join(','));
    // 50% red over 0x2060C0 is roughly (143, 48, 96); the encode moves it a little.
    ok('the blend is the arithmetic one',
      near(prev[0], 143, 22) && near(prev[1], 48, 22) && near(prev[2], 96, 22),
      'preview=' + prev.join(','));

    // A layer with no picture yet must be SKIPPED, not clear what is underneath it.
    // A clip pointing at a file that will never load is the permanent version of the
    // mid-seek element the compositor sees at every cut.
    const ghostTrack = addTrack('video', false);
    const ghost = {
      id: nextId(), src: D + 'no_such_file_ever.mp4', name: 'ghost', kind: 'video',
      start: 0, in: 0, out: 3, mediaDuration: 3, srcW: 1080, srcH: 1920, fps: 30,
      panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
    };
    ghostTrack.clips.push(ghost);
    sortTracks();
    drawPreview();
    await sleep(60);
    const withGhost = sample(ctx, P.w, P.h);
    ok('an undecodable layer is skipped without clearing what is below',
      near(withGhost[0], prev[0], 6) && near(withGhost[1], prev[1], 6) && near(withGhost[2], prev[2], 6),
      'ghost=' + withGhost.join(',') + ' vs ' + prev.join(','));
    ghostTrack.clips.length = 0;
    state.tracks.splice(state.tracks.indexOf(ghostTrack), 1);
    renderAll();
    await sleep(60);

    // A hidden track drops out of the composite entirely.
    imgTrack.hidden = true;
    drawPreview();
    await sleep(60);
    const hidden = sample(ctx, P.w, P.h);
    ok('hiding the still\'s track leaves the footage alone',
      hidden[2] > hidden[0] && !near(hidden[0], prev[0], 10),
      'hidden=' + hidden.join(','));
    imgTrack.hidden = false;
    drawPreview();
    await sleep(60);

    // ------------------------------------------------------ the render must agree
    const rjob = buildJob(OUT);
    rjob.duration = 3;
    rjob.cacheKey = jobCacheKey(rjob);
    await bakeTextClips(rjob);
    const res = await window.api.startRender(rjob);
    ok('ffmpeg rendered the composite', res.ok,
      res.ok ? '' : String(res.error).split('\n').slice(-4).join(' | '));

    if (res.ok) {
      const frameAt = (t) => new Promise((resolve) => {
        const v = document.createElement('video');
        v.src = 'file:///' + OUT.replace(/\\/g, '/');
        v.muted = true;
        v.addEventListener('loadeddata', () => { v.currentTime = t; });
        v.addEventListener('seeked', () => {
          const cv = document.createElement('canvas');
          cv.width = 1080; cv.height = 1920;
          const c2 = cv.getContext('2d');
          c2.drawImage(v, 0, 0, 1080, 1920);
          resolve(sample(c2, 1080, 1920));
        }, { once: true });
        v.addEventListener('error', () => resolve(null));
      });

      const rend = await frameAt(1);
      ok('the render decoded', !!rend, rend ? rend.join(',') : 'no frame');
      if (rend) {
        // The whole point of the step: one composite, two implementations, same pixels.
        ok('preview and render composite to the same pixels',
          near(rend[0], prev[0], 14) && near(rend[1], prev[1], 14) && near(rend[2], prev[2], 14),
          'render=' + rend.join(',') + ' preview=' + prev.join(','));
        ok('the still is genuinely translucent in the render',
          rend[2] > 40 && rend[0] > 90,
          'render=' + rend.join(','));
      }
    }

    // ------------------------------------------ 'contain': the whole still, placed
    //
    // A still is framed like footage by default - filled to 9:16 and cropped - which is
    // right for a photo and useless for a logo, because a wide logo cropped to 9:16 is a
    // detail of a logo. `fit: 'contain'` draws the WHOLE image, scaled by `zoom` and
    // placed by `panX`/`panY`, and leaves the rest of the frame transparent.
    //
    // The rule this has to keep is the project's oldest one: the viewer and the file must
    // agree. They share `drawClipTo()` now - `drawClip()` delegates to it rather than
    // keeping a second copy of the crop - so the check is that a real ffmpeg render of a
    // contained still matches the preview at BOTH a covered and an uncovered pixel.
    {
      const at = (c2d, w, h, fx2, fy2) => {
        const d = c2d.getImageData(Math.round(w * fx2), Math.round(h * fy2), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      img.fit = 'contain';
      img.zoom = 0.5;
      img.panX = 0.5;
      img.panY = 0.5;
      renderAll();
      seek(1);
      await sleep(900);
      drawPreview();
      await sleep(80);
      const midPrev = at(ctx, P.w, P.h, 0.5, 0.5);
      const cornerPrev = at(ctx, P.w, P.h, 0.08, 0.06);

      ok('a contained still leaves the frame\u2019s corners to the footage underneath',
        cornerPrev[2] > cornerPrev[0], 'corner=' + cornerPrev.join(','));
      ok('...and still blends where it does cover',
        midPrev[0] > cornerPrev[0] + 20, 'mid=' + midPrev.join(','));
      ok('a contained still leaves the ffmpeg fast path, because a crop chain cannot ' +
        'express transparency around it',
        clipNeedsBake(img));

      const cjob = buildJob(OUT);
      cjob.duration = 3;
      cjob.cacheKey = jobCacheKey(cjob);
      // The WHOLE bake, not just the cards: a contained still is composited, and
      // `bakeOverlays()` is the entry the app itself uses for exactly that reason.
      await bakeOverlays(cjob);
      const cres = await window.api.startRender(cjob);
      ok('ffmpeg rendered the contained still', cres.ok,
        cres.ok ? '' : String(cres.error).split('\n').slice(-4).join(' | '));
      if (cres.ok) {
        const two = await new Promise((resolve) => {
          const v = document.createElement('video');
          v.src = 'file:///' + OUT.replace(/\\/g, '/') + '?c=' + Date.now();
          v.muted = true;
          v.addEventListener('loadeddata', () => { v.currentTime = 1; });
          v.addEventListener('seeked', () => {
            const cv = document.createElement('canvas');
            cv.width = 1080; cv.height = 1920;
            const c2 = cv.getContext('2d');
            c2.drawImage(v, 0, 0, 1080, 1920);
            resolve([at(c2, 1080, 1920, 0.5, 0.5), at(c2, 1080, 1920, 0.08, 0.06)]);
          }, { once: true });
          v.addEventListener('error', () => resolve(null));
        });
        ok('the contained render decoded', !!two);
        if (two) {
          ok('preview and render agree where the still covers the frame',
            near(two[0][0], midPrev[0], 16) && near(two[0][1], midPrev[1], 16) &&
            near(two[0][2], midPrev[2], 16),
            'render=' + two[0].join(',') + ' preview=' + midPrev.join(','));
          ok('...and where it does not, so the transparency survived the round trip',
            near(two[1][0], cornerPrev[0], 16) && near(two[1][1], cornerPrev[1], 16) &&
            near(two[1][2], cornerPrev[2], 16),
            'render=' + two[1].join(',') + ' preview=' + cornerPrev.join(','));
        }
      }
      delete img.fit;
      img.zoom = 1;
      renderAll();
      await sleep(60);
    }

    // ------------------------------------------------------ the QuickBin route
    // Double-clicking a still now places it on the timeline (no object transition
    // selected), instead of saying it has nowhere to go.
    if (QuickBin.ready) {
      const before = allClips().filter((x) => x.clip.kind === 'image').length;
      await QuickBin.importPaths([PNG], null);
      const entry = QuickBin.data.items.find((i) => i.path === PNG);
      ok('the bin holds the still', !!entry);
      if (entry) {
        seek(2);
        await QuickBin.use([entry.id]);
        await sleep(500);
        const after = allClips().filter((x) => x.clip.kind === 'image');
        ok('double-clicking a still puts it on the timeline at the playhead',
          after.length === before + 1 && after.some((x) => Math.abs(x.clip.start - 2) < 0.001),
          after.map((x) => x.clip.start.toFixed(2)).join(','));
        QuickBin.remove(new Set([entry.id]));
        await QuickBin.flush();
      }
    } else {
      results.push('SKIP  QuickBin was not ready');
    }

    // ------------------------------------------------------ undo is still one entry
    const beforeUndo = JSON.stringify(state.tracks);
    pushUndo();
    const target = allClips().map((x) => x.clip).find((c) => c.kind === 'image');
    target.zoom = 1.5; target.panX = 0.2;
    undo();
    ok('one undo restores an image clip exactly', JSON.stringify(state.tracks) === beforeUndo);

    return results.join('\n');
  } catch (e) {
    return 'SMOKE THREW: ' + (e && e.stack || e);
  }
})();
