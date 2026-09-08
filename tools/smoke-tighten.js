/**
 * Smoke test for Tighten - silence detection, the cut list, the ripple through a link
 * group, and undo. Runs inside the live renderer:
 *
 *   set SHORTCUT_SMOKE=tools\smoke-tighten.js && npx electron .        (cmd)
 *   SHORTCUT_SMOKE=tools/smoke-tighten.js node_modules/.bin/electron . (bash)
 *
 * Needs `silence1.mp4` in %TEMP%\scut_test - six seconds of tone with two known silences,
 * [1.0, 2.5] and [3.5, 4.2]:
 *
 *   node_modules/ffmpeg-static/ffmpeg.exe -y -f lavfi -i "testsrc=size=320x240:rate=30:duration=6" \
 *     -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)*(between(t,0,1)+between(t,2.5,3.5)+between(t,4.2,6))':d=6:s=44100" \
 *     -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "%TEMP%/scut_test/silence1.mp4"
 *
 * Section 1 measures that file through the REAL `analyze:silence` handler, so the
 * ffmpeg parsing is under test rather than re-implemented. Everything after it injects
 * known spans into `silenceCache` instead: the cut maths, the sync and the undo are what
 * those sections are about, and they must not be able to fail because a decoder rounded
 * a boundary differently on somebody else's machine.
 */
(async () => {
  const results = [];
  const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  const skip = (name, why) => results.push('SKIP  ' + name + '   ' + why);
  const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
  const SRC = D + 'silence1.mp4';
  const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);

  try {
    // =============================================== 1. the real detector
    const first = await window.api.analyzeSilence(SRC, -30);
    if (!first || !first.ok) {
      skip('silencedetect over the fixture', 'no ' + SRC + ' (see this file\'s header)');
    } else {
      ok('the handler answers with spans and a duration',
        Array.isArray(first.spans) && first.duration > 5.9 && first.duration < 6.2,
        'duration ' + first.duration);
      ok('it finds exactly the two silences', first.spans.length === 2,
        JSON.stringify(first.spans));
      ok('the first silence is [1.0, 2.5]',
        first.spans[0] && near(first.spans[0][0], 1.0) && near(first.spans[0][1], 2.5),
        JSON.stringify(first.spans[0]));
      ok('the second is [3.5, 4.2]',
        first.spans[1] && near(first.spans[1][0], 3.5) && near(first.spans[1][1], 4.2),
        JSON.stringify(first.spans[1]));

      const second = await window.api.analyzeSilence(SRC, -30);
      ok('a second call is served from the disk cache', second.ok && second.cached === true);
      ok('and returns the same spans',
        JSON.stringify(second.spans) === JSON.stringify(first.spans));

      // The noise floor changes what ffmpeg reports, so it has to be part of the key -
      // otherwise the second reading would be the first one's answer under a new name.
      const quiet = await window.api.analyzeSilence(SRC, -55);
      ok('a different noise floor is a different cache entry', quiet.ok && quiet.cached === false,
        'cached=' + (quiet && quiet.cached));

      const missing = await window.api.analyzeSilence(D + '__no_such_file__.mp4', -30);
      ok('a missing file fails cleanly instead of throwing', missing && missing.ok === false);
    }

    // =============================================== 2. span maths
    ok('mergeSpans unions overlaps',
      JSON.stringify(mergeSpans([[0, 1], [0.5, 2], [3, 4]])) === '[[0,2],[3,4]]');
    ok('mergeSpans sorts unsorted input',
      JSON.stringify(mergeSpans([[3, 4], [0, 1]])) === '[[0,1],[3,4]]');
    ok('mergeSpans drops empty and inverted spans',
      JSON.stringify(mergeSpans([[1, 1], [2, 1], [3, 4]])) === '[[3,4]]');
    ok('the defaults are the ones state carries',
      state.tighten.threshold === TIGHTEN_DEFAULTS.threshold &&
      state.tighten.pad === TIGHTEN_DEFAULTS.pad &&
      state.tighten.noise === TIGHTEN_DEFAULTS.noise);

    // =============================================== 3. the cut list
    markClean();   // else newProject()'s unsaved-changes confirm() hangs the run
    newProject();
    await importPaths([SRC]);
    const vT = state.tracks.find((t) => t.type === 'video');
    const aT = state.tracks.find((t) => t.type === 'audio');
    ok('the fixture imports as a linked A/V pair',
      vT.clips.length === 1 && aT.clips.length === 1 &&
      vT.clips[0].linkId && vT.clips[0].linkId === aT.clips[0].linkId);
    const V = vT.clips[0], A = aT.clips[0];
    ok('the pair is six seconds long', near(V.out - V.in, 6, 0.1), String(V.out - V.in));

    // Known silences from here on, so the arithmetic below is exact.
    const inject = (spans) => silenceCache.set(SRC + '|-30', { spans, duration: 6 });
    inject([[1.0, 2.5], [3.5, 4.2]]);
    state.tighten = { threshold: 0.35, pad: 0.05, noise: -30 };
    setSelection([V.id], false);

    let plan = tightenPlan();
    ok('both silences are planned', plan.count === 2 && plan.pending === 0,
      JSON.stringify(plan.spans));
    ok('the pad is taken off each end',
      near(plan.spans[0][0], 1.05) && near(plan.spans[0][1], 2.45) &&
      near(plan.spans[1][0], 3.55) && near(plan.spans[1][1], 4.15),
      JSON.stringify(plan.spans));
    ok('the removed total is right', near(plan.removed, 2.0), String(plan.removed));

    // The threshold is measured on the silence as detected, not after the pad.
    state.tighten.threshold = 0.8;
    ok('raising the threshold drops the shorter silence', tightenPlan().count === 1);
    state.tighten.threshold = 2.0;
    ok('raising it past both leaves nothing to cut', tightenPlan().count === 0);
    state.tighten.threshold = 0.35;

    state.tighten.pad = 0.4;
    ok('a pad that eats the whole silence removes it from the plan', tightenPlan().count === 1,
      JSON.stringify(tightenPlan().spans));
    state.tighten.pad = 0.75;
    ok('and a pad wider still leaves nothing at all', tightenPlan().count === 0,
      JSON.stringify(tightenPlan().spans));
    state.tighten.pad = 0.05;

    // A silence outside the clip's used range is not the clip's to cut.
    const oldIn = A.in, oldOut = A.out, oldStart = A.start;
    A.in = 3.0; A.out = 6; A.start = 10;
    V.in = 3.0; V.out = 6; V.start = 10;
    plan = tightenPlan();
    ok('a silence before the in point is clipped away', plan.count === 1, JSON.stringify(plan.spans));
    ok('and the surviving one is mapped into timeline time',
      near(plan.spans[0][0], 10 + (3.55 - 3.0)) && near(plan.spans[0][1], 10 + (4.15 - 3.0)),
      JSON.stringify(plan.spans));
    A.in = oldIn; A.out = oldOut; A.start = oldStart;
    V.in = oldIn; V.out = oldOut; V.start = oldStart;

    // The step 3 hook: filler words, in source time, not subject to the threshold.
    const hook = registerTightenSpans((clip) => (clip.src === SRC ? [[5.0, 5.2]] : []));
    plan = tightenPlan();
    ok('the filler-word hook adds spans the threshold would have refused',
      plan.count === 3 && near(plan.spans[2][0], 5.05) && near(plan.spans[2][1], 5.15),
      JSON.stringify(plan.spans));
    tightenSpanSources.splice(tightenSpanSources.indexOf(hook), 1);
    ok('and unregistering it puts the plan back', tightenPlan().count === 2);

    // =============================================== 4. the ripple, and sync
    const before = JSON.stringify(state.tracks);
    const undoBefore = undoStack.length;
    plan = tightenPlan();
    const result = tighten();
    ok('tighten reports what it removed', !!result && result.count === 2);
    ok('the whole pass is ONE undo entry', undoStack.length === undoBefore + 1,
      undoBefore + ' -> ' + undoStack.length);

    ok('the video is cut into three pieces', vT.clips.length === 3, String(vT.clips.length));
    ok('the audio is cut into three pieces', aT.clips.length === 3, String(aT.clips.length));
    ok('the project is exactly 2s shorter', near(projectDuration(), 4.0, 0.02),
      String(projectDuration()));

    const geom = (arr) => arr.map((c) => [c.start.toFixed(3), (c.out - c.in).toFixed(3), c.in.toFixed(3)].join('/'));
    ok('picture and sound stay in sync, piece for piece',
      JSON.stringify(geom(vT.clips)) === JSON.stringify(geom(aT.clips)),
      geom(vT.clips).join(' ') + '  vs  ' + geom(aT.clips).join(' '));
    ok('the pieces are butt-joined with no gaps',
      vT.clips.every((c, i) => i === 0 || near(c.start, clipEnd(vT.clips[i - 1]), 0.002)),
      geom(vT.clips).join(' '));
    ok('the first piece keeps the silence pad',
      near(vT.clips[0].out - vT.clips[0].in, 1.05, 0.002),
      String(vT.clips[0].out - vT.clips[0].in));
    ok('the middle piece runs 2.45 -> 3.55 in the source',
      near(vT.clips[1].in, 2.45, 0.002) && near(vT.clips[1].out, 3.55, 0.002),
      vT.clips[1].in + ' - ' + vT.clips[1].out);
    ok('every piece keeps 0 <= in < out <= mediaDuration',
      [...vT.clips, ...aT.clips].every((c) => c.in >= 0 && c.in < c.out && c.out <= c.mediaDuration + 0.001));
    ok('each cut piece is linked to its opposite number',
      vT.clips.every((c, i) => c.linkId && c.linkId === aT.clips[i].linkId),
      vT.clips.map((c) => c.linkId).join(','));
    ok('and the link ids are all distinct',
      new Set(vT.clips.map((c) => c.linkId)).size === 3);

    // =============================================== 5. undo
    undo();
    ok('one undo restores the timeline exactly', JSON.stringify(state.tracks) === before);
    ok('and puts the pair back as one clip each',
      state.tracks.find((t) => t.type === 'video').clips.length === 1 &&
      state.tracks.find((t) => t.type === 'audio').clips.length === 1);
    redo();
    ok('redo cuts it again', state.tracks.find((t) => t.type === 'video').clips.length === 3);
    undo();

    // =============================================== 6. what the ripple may cut
    markClean();   // else newProject()'s unsaved-changes confirm() hangs the run
    newProject();
    await importPaths([SRC]);
    const vTrack = state.tracks.find((t) => t.type === 'video');
    const aTrack = state.tracks.find((t) => t.type === 'audio');
    inject([[1.0, 2.5], [3.5, 4.2]]);
    state.tighten = { threshold: 0.35, pad: 0.05, noise: -30 };

    // A music bed on a second audio track, straddling the first cut, and a text card too.
    addTrack('audio');
    const music = state.tracks.filter((t) => t.type === 'audio').find((t) => !t.clips.length);
    const bed = Object.assign({}, aTrack.clips[0], { id: nextId(), start: 0.5, in: 0, out: 3, linkId: null });
    music.clips.push(bed);
    state.playhead = 0.5;
    addTextCard('hello');
    const card = allClips().map((x) => x.clip).find((c) => c.kind === 'text');
    // The text card is inside the first cut span on purpose.
    card.start = 1.2; card.in = 0; card.out = 0.8;
    const after = Object.assign({}, bed, { id: nextId(), start: 5.0, in: 0, out: 0.5 });
    music.clips.push(after);
    sortTracks();

    setSelection([vTrack.clips[0].id], false);
    tighten();

    ok('a clip outside the selection is not cut', music.clips.some((c) => c.id === bed.id),
      music.clips.map((c) => c.id).join(','));
    ok('and keeps its length', near(bed.out - bed.in, 3, 0.001));
    ok('a clip that starts after a cut still shifts',
      near(after.start, 5.0 - 2.0, 0.002), String(after.start));
    ok('a text card straddling a cut is shifted, never sliced',
      near(card.out - card.in, 0.8, 0.001) && card.in === 0,
      card.in + ' - ' + card.out);

    // A locked track is left alone entirely, exactly as ripple delete leaves it.
    undo();
    music.locked = true;
    const bedStart = bed.start, afterStart = after.start;
    setSelection([vTrack.clips[0].id], false);
    tighten();
    ok('a locked track is neither cut nor shifted',
      near(bed.start, bedStart, 0.001) && near(after.start, afterStart, 0.001),
      bed.start + ' / ' + after.start);
    music.locked = false;
    undo();

    // =============================================== 7. degrading gracefully
    ok('a clip with no analysis is reported as pending, not cut',
      (() => {
        silenceCache.clear();
        setSelection([vTrack.clips[0].id], false);
        const p = tightenPlan();
        return p.pending === 1 && p.count === 0;
      })());
    const n0 = undoStack.length;
    ok('and tighten refuses rather than emptying the timeline',
      tighten() === null && undoStack.length === n0);
    inject([[1.0, 2.5], [3.5, 4.2]]);

    setSelection([], false);
    ok('an empty selection plans nothing', tightenPlan().count === 0);
    const textOnly = allClips().map((x) => x.clip).find((c) => c.kind === 'text');
    if (textOnly) {
      setSelection([textOnly.id], false);
      ok('a text card has no audio to measure', tightenPlan().pending === 0 && tightenPlan().count === 0);
    }

    // =============================================== 8. the panel
    setSelection([vTrack.clips[0].id], false);
    renderInspector();
    const box = document.querySelector('#inspector .tighten-box');
    ok('the inspector shows a Tighten panel', !!box);
    ok('it offers Analyse and Tighten',
      !!box && ['Analyse', 'Tighten'].every((t) =>
        [...box.querySelectorAll('button')].some((b) => b.textContent === t)),
      box ? [...box.querySelectorAll('button')].map((b) => b.textContent).join(',') : '');
    ok('it has threshold, pad and noise rows',
      !!box && box.querySelectorAll('.tc-body .tc-row').length === 3,
      box ? String(box.querySelectorAll('.tc-body .tc-row').length) : '');
    ok('it counts what would be removed before committing',
      !!box && /Would remove 2 span\(s\), 2\.00s/.test(box.textContent),
      box ? box.querySelector('.tighten-status').textContent : '');

    // Settings are not timeline state: moving one must not push an undo entry.
    const undoN = undoStack.length, dirtyWas = state.dirty;
    const slider = box.querySelector('.tc-body input[type=range]');
    slider.value = '1.2';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    ok('a settings slider snapshots no undo entry', undoStack.length === undoN,
      undoN + ' -> ' + undoStack.length);
    ok('and does not dirty the project', state.dirty === dirtyWas);
    ok('but it does re-count live', near(state.tighten.threshold, 1.2, 0.001) &&
      /Would remove 1 span/.test(box.querySelector('.tighten-status').textContent),
      box.querySelector('.tighten-status').textContent);
    state.tighten.threshold = 0.35;

    // =============================================== 9. it survives a save/reload
    state.tighten = { threshold: 0.5, pad: 0.08, noise: -40 };
    const doc = JSON.parse(JSON.stringify(serialize()));
    ok('the settings serialize', doc.tighten && doc.tighten.threshold === 0.5 && doc.tighten.noise === -40);
    state.tighten = Object.assign({}, TIGHTEN_DEFAULTS, doc.tighten);
    ok('and read back intact', state.tighten.pad === 0.08 && state.tighten.noise === -40);
    state.tighten = Object.assign({}, TIGHTEN_DEFAULTS, { });
    ok('a project saved before Tighten existed gets the defaults',
      state.tighten.threshold === 0.35 && state.tighten.pad === 0.05);

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' +
      results.filter((x) => !x.startsWith('SKIP')).length + ' passed';
  } catch (e) {
    return results.join('\n') + '\n\nERR ' + (e && e.stack ? e.stack : e);
  }
})()
