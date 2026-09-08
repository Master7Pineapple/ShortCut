/**
 * Smoke test for the QuickBin, the audio waveforms, snapping, and the swipe's deform.
 *
 *   SHORTCUT_SMOKE=tools/smoke-bin.js node_modules/.bin/electron .   (bash)
 *
 * Expects clip1.mp4 / clip2.mp4 in %TEMP%\scut_test (see tools/smoke.js).
 *
 * The bin lives in userData and belongs to the USER, not to this suite, so the real one
 * is read at the start and written back at the end - a test run must not eat someone's
 * library.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const savedBin = await window.api.binRead();

    // =================================================== snapping
    //
    // The bug: `snapTime` returned the raw time when nothing was near, so a caller
    // comparing two candidate edges by distance saw the MISS (distance 0) beat the real
    // snap. Dragging therefore never snapped unless both edges happened to land at once.

    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    await sleep(300);
    const V = state.tracks.find((t) => t.type === 'video');
    const A = state.tracks.find((t) => t.type === 'audio');
    ok('fixture: two video and two audio clips', V.clips.length === 2 && A.clips.length === 2);

    state.snap = true;
    state.playhead = 0;
    const cut = V.clips[1].start;
    ok('snapDetail reports a real hit', snapDetail(cut + 0.02, new Set()).hit === true);
    ok('snapDetail reports a miss as a miss',
      snapDetail(cut + 5, new Set()).hit === false, 'at ' + (cut + 5).toFixed(2));
    ok('a miss leaves the time alone',
      Math.abs(snapDetail(cut + 5, new Set()).t - (cut + 5)) < 1e-9);
    ok('audio clip edges are snap candidates',
      snapDetail(A.clips[1].start + 0.02, new Set([V.clips[0].id, V.clips[1].id])).hit === true);

    /** Drag `clip` so its start lands near `toRaw`, through the real move handlers. */
    const dragTo = (clip, toRaw) => {
      setSelection([clip.id], false);
      const x0 = 400;
      startMove({ clientX: x0, clientY: 0 }, clip);
      const dx = (toRaw - clip.start) * state.pxPerSec;
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: x0 + dx, clientY: 0 }));
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: x0 + dx, clientY: 0 }));
    };

    // A standalone audio clip, well away from anything, dragged to just past the video
    // cut. Its own linked partner is excluded from the candidates; the video cut is not.
    unlinkSelected();
    selectAll();
    unlinkSelected();
    const music = A.clips[1];
    music.start = 12;
    sortTracks();
    dragTo(music, cut + 0.03);
    ok('an audio clip snaps to a video cut',
      Math.abs(music.start - cut) < 1e-6, 'start=' + music.start.toFixed(4) + ' cut=' + cut.toFixed(4));

    // The tail edge snaps too: dragged so its END is just past the cut, it lands with the
    // end exactly on it.
    const len = music.out - music.in;
    dragTo(music, cut - len + 0.03);
    ok('an audio clip snaps by its tail as well',
      Math.abs((music.start + len) - cut) < 1e-6, 'end=' + (music.start + len).toFixed(4));

    // And with snapping off it goes where it is dragged - to the pixel, since that is all
    // a mouse position carries.
    state.snap = false;
    dragTo(music, 7.03);
    ok('snapping off means no snapping', Math.abs(music.start - 7.03) < 1.01 / state.pxPerSec,
      'start=' + music.start.toFixed(4));
    state.snap = true;

    // =================================================== waveforms
    const src = D + 'clip1.mp4';
    Wave.clear();
    ok('peaks are not ready on the first ask', Wave.peaksFor(src) === null);
    let entry = null;
    for (let i = 0; i < 60 && !entry; i++) { await sleep(250); entry = Wave.peaksFor(src); }
    ok('the audio decodes into peaks', !!entry && entry.peaks.length === Wave.BUCKETS,
      entry ? entry.peaks.length + ' buckets' : 'never decoded');
    ok('the peaks are not silent', !!entry && Array.from(entry.peaks).some((v) => v > 4),
      entry ? 'max=' + Math.max(...entry.peaks) : '');

    const cv = document.createElement('canvas');
    cv.width = 200; cv.height = 40;
    const drew = Wave.draw(cv, src, 0, 3, 3, '#fff');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted++;
    ok('the waveform draws something', drew === true && painted > 200, painted + ' px');

    // Trimming a clip draws a DIFFERENT slice of the same peaks - nothing is decoded again.
    const cv2 = document.createElement('canvas');
    cv2.width = 200; cv2.height = 40;
    Wave.draw(cv2, src, 1.5, 3, 3, '#fff');
    const px2 = cv2.getContext('2d').getImageData(0, 0, cv2.width, cv2.height).data;
    let diff = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== px2[i]) diff++;
    ok('a trimmed clip shows a different slice', diff > 20, diff + ' px differ');

    // The reducer itself, on a signal with a known shape: a half-amplitude sine.
    const fake = {
      length: 4096, numberOfChannels: 1,
      getChannelData: () => {
        const a = new Float32Array(4096);
        for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin(i / 8);
        return a;
      },
    };
    const red = Wave._reduce(fake);
    const peak = Math.max(...red);
    ok('the reducer scales peaks to 0..255', peak > 120 && peak <= 130, 'peak=' + peak);

    // The lanes actually carry a waveform canvas on audio clips, and none on video ones.
    renderLanes();
    const audioLane = document.querySelectorAll('.track-lane.audio .clip.audio canvas.wave');
    const videoWave = document.querySelectorAll('.clip.video canvas.wave');
    ok('audio clips draw a waveform on the timeline', audioLane.length > 0, audioLane.length + ' canvas(es)');
    ok('video clips draw none', videoWave.length === 0);

    // =================================================== the QuickBin
    const bin = QuickBin;
    // Start from a clean bin for the test, then hand the user's own back at the end.
    bin.data.folders.length = 0;
    bin.data.items.length = 0;

    const music1 = bin.addFolder('Music');
    const sub = bin.addFolder('Stings', music1.id);
    ok('folders nest', sub.parent === music1.id && bin.data.folders.length === 2);

    const n = await bin.importPaths([D + 'clip1.mp4', D + 'clip2.mp4'], sub.id);
    ok('files import into a folder', n === 2 && bin.data.items.length === 2, n + ' added');
    ok('the items land in the folder asked for', bin.data.items.every((i) => i.folder === sub.id));
    ok('the probe result comes with them',
      bin.data.items.every((i) => i.kind === 'video' && i.duration > 0 && i.path));

    const again = await bin.importPaths([D + 'clip1.mp4'], sub.id);
    ok('importing the same file twice adds nothing', again === 0 && bin.data.items.length === 2);

    // Importing a folder mirrors the folder itself.
    const before = bin.data.folders.length;
    await bin.importPaths([D.slice(0, -1)], null);
    ok('importing a folder makes a folder for it', bin.data.folders.length === before + 1);
    ok('importing a folder brings its media', bin.data.items.length > 2, bin.data.items.length + ' items');

    // Moving.
    const moved = bin.data.items.find((i) => i.folder === sub.id);
    bin.move(new Set([moved.id]), music1.id);
    ok('an item can be moved between folders', moved.folder === music1.id);
    bin.move(new Set([music1.id]), sub.id);
    ok('a folder cannot be moved inside itself', music1.parent === null, 'parent=' + music1.parent);

    // Deleting a folder takes what is inside it, and nothing else.
    const outside = bin.data.items.filter((i) => i.folder !== sub.id && i.folder !== music1.id).length;
    bin.remove(new Set([music1.id]));
    ok('deleting a folder deletes its subfolders',
      !bin.data.folders.some((f) => f.id === music1.id || f.id === sub.id));
    ok('deleting a folder deletes only its own items',
      bin.data.items.length === outside && !bin.data.items.some((i) => i.folder === sub.id),
      bin.data.items.length + ' left of ' + outside);

    // Persistence: the whole point of the bin is that it is there in the NEXT project.
    const keptItems = bin.data.items.length;
    const keptFolders = bin.data.folders.length;
    await bin.flush();
    const readBack = await window.api.binRead();
    ok('the bin persists outside the project',
      readBack.items.length === keptItems && readBack.folders.length === keptFolders,
      readBack.items.length + ' items, ' + readBack.folders.length + ' folders');
    ok('a missing file is reported, not hidden',
      readBack.items.every((i) => typeof i.missing === 'boolean'));
    state.dirty = false;
    newProject();
    ok('a new project does not empty the bin', QuickBin.data.items.length === keptItems);

    // Putting something on the timeline is an ordinary import at the playhead. (The
    // playhead cannot be past the end of the project, so there has to be something there
    // for it to sit in the middle of.)
    await importPaths([D + 'clip2.mp4']);
    await sleep(200);
    seek(2);
    const anyItem = bin.data.items.find((i) => i.kind === 'video' && i.path.endsWith('clip1.mp4'));
    await bin.use([anyItem.id]);
    await sleep(200);
    const placed = allClips().map((x) => x.clip).filter((c) => c.src === anyItem.path);
    ok('using a bin item puts it on the timeline', placed.length > 0, placed.length + ' clip(s)');
    ok('it lands at the playhead', placed.length && placed.every((c) => Math.abs(c.start - 2) < 1e-6),
      placed.length ? 'start=' + placed[0].start.toFixed(2) : '');
    ok('it goes on a track that is free there',
      placed.length && placed.every((c) => {
        const t = findClip(c.id).track;
        return !t.clips.some((o) => o !== c && c.start < clipEnd(o) - 1e-6 && clipEnd(c) > o.start + 1e-6);
      }));

    // =================================================== the swipe deform
    const W = 240, H = 320;
    const plate = (paint) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      paint(c.getContext('2d'));
      return c;
    };
    const white = plate((c) => { c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); });
    const bar = plate((c) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#fff'; c.fillRect(W / 2 - 6, H / 2 - 6, 12, 12);
    });
    const target = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      return c;
    };
    const swipe = (params) => {
      const tr = Trans.defaults('swipe');
      Object.assign(tr.params, { blur: 0, softness: 0.2 }, params);
      return tr;
    };
    /** How far the white block spreads along each axis, in pixels above a threshold. */
    const spread = (canvas) => {
      const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
      let xs = 0, ys = 0;
      for (let x = 0; x < W; x++) {
        const i = ((H / 2 | 0) * W + x) * 4;
        if (d[i] > 40) xs++;
      }
      for (let y = 0; y < H; y++) {
        const i = (y * W + (W / 2 | 0)) * 4;
        if (d[i] > 40) ys++;
      }
      return { xs, ys };
    };

    ok('the deform axis follows the wipe direction',
      Trans.deformAxisOf({ direction: 'left' }) === 'x' &&
      Trans.deformAxisOf({ direction: 'up' }) === 'y' &&
      Trans.deformAxisOf({ direction: 'zoomIn' }) === 'radial' &&
      Trans.deformAxisOf({ direction: 'left', deformAxis: 'y' }) === 'y');

    const flat = target();
    Trans.draw(flat.getContext('2d'), W, H, swipe({ deform: 0, stretch: 0 }), 0.5, bar, bar, 1 / 30);
    const sFlat = spread(flat);

    const smearX = target();
    Trans.draw(smearX.getContext('2d'), W, H, swipe({ deform: 1, stretch: 0, deformAxis: 'x' }), 0.5, bar, bar, 1 / 30);
    const sX = spread(smearX);
    ok('a horizontal smear widens the picture along x', sX.xs > sFlat.xs + 8,
      sFlat.xs + ' -> ' + sX.xs + ' px');
    ok('a horizontal smear leaves the height alone', Math.abs(sX.ys - sFlat.ys) <= 2,
      sFlat.ys + ' -> ' + sX.ys + ' px');

    const smearY = target();
    Trans.draw(smearY.getContext('2d'), W, H, swipe({ deform: 1, stretch: 0, deformAxis: 'y' }), 0.5, bar, bar, 1 / 30);
    const sY = spread(smearY);
    ok('a vertical smear stretches the other way', sY.ys > sFlat.ys + 8 && Math.abs(sY.xs - sFlat.xs) <= 2,
      sFlat.ys + ' -> ' + sY.ys + ' px (x ' + sY.xs + ')');

    // Stretch scales about the centre of the frame, so it shows on something that is NOT
    // at the centre: an off-centre block is pulled outwards and smeared as it goes.
    const offBar = plate((c) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#fff'; c.fillRect(W * 0.75 - 6, H / 2 - 6, 12, 12);
    });
    const offRow = (canvas) => {
      const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
      let xs = 0;
      for (let x = 0; x < W; x++) if (d[(((H / 2) | 0) * W + x) * 4] > 40) xs++;
      return xs;
    };
    const offFlat = target();
    Trans.draw(offFlat.getContext('2d'), W, H, swipe({ deform: 0, stretch: 0 }), 0.5, offBar, offBar, 1 / 30);
    const stretched = target();
    Trans.draw(stretched.getContext('2d'), W, H, swipe({ deform: 0, stretch: 0.4, deformAxis: 'x' }), 0.5, offBar, offBar, 1 / 30);
    ok('stretch alone deforms too', offRow(stretched) > offRow(offFlat) + 6,
      offRow(offFlat) + ' -> ' + offRow(stretched) + ' px');

    // The averaging must be additive. Compositing the samples source-over at 1/n
    // converges to ~63% and would visibly wash the picture out.
    const wash = target();
    Trans.draw(wash.getContext('2d'), W, H, swipe({ deform: 1, stretch: 0.3 }), 0.5, white, white, 1 / 30);
    const wd = wash.getContext('2d').getImageData(W / 2 | 0, H / 2 | 0, 1, 1).data;
    ok('a flat plate keeps its brightness through the smear', wd[0] > 246 && wd[3] > 250,
      'rgba=' + [...wd].join(','));

    // And at the very ends of the window the deform is gone: peak is sin(pi*e).
    const ends = target();
    Trans.draw(ends.getContext('2d'), W, H, swipe({ deform: 1.5, stretch: 0.5 }), 0, bar, bar, 1 / 30);
    ok('nothing is deformed at the start of the window',
      Math.abs(spread(ends).xs - sFlat.xs) <= 1, spread(ends).xs + ' vs ' + sFlat.xs);

    ok('the deform survives a preset round trip', (() => {
      const tr = swipe({ deform: 0.9, stretch: 0.33, deformAxis: 'both', deformSamples: 7 });
      const p = Trans.extractPreset(tr);
      const fresh = Trans.defaults('swipe');
      Trans.applyPreset(fresh, p);
      return fresh.params.deform === 0.9 && fresh.params.deformAxis === 'both' &&
        fresh.params.deformSamples === 7;
    })());

    ok('normalize fills the deform in on an old project', (() => {
      const tr = { id: 'x', type: 'swipe', params: { direction: 'left', softness: 0.2, blur: 26 } };
      Trans.normalize(tr);
      return typeof tr.params.deform === 'number' && typeof tr.params.stretch === 'number' &&
        tr.params.deformAxis === 'auto';
    })());

    // Hand the user their own bin back.
    await window.api.binWrite(savedBin);

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'THREW: ' + (e && e.stack ? e.stack : String(e));
  }
})()
