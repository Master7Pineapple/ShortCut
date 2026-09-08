/**
 * Smoke test for window (marquee) selection and Close gaps. Runs inside the live renderer:
 *
 *   set SHORTCUT_SMOKE=tools\smoke-select.js && npx electron .        (cmd)
 *   SHORTCUT_SMOKE=tools/smoke-select.js node_modules/.bin/electron . (bash)
 *
 * Uses clip1.mp4 / clip2.mp4 in %TEMP%\scut_test - the same fixtures smoke.js uses.
 *
 * The marquee is driven with dispatched MouseEvents rather than `sendInput`. That is
 * legitimate here and NOT the untrusted-input trap smoke-input.js exists for: the box
 * needs no default action from the browser - no focus, no text entry - only that its own
 * mousedown/mousemove/mouseup listeners run. Anything that needs a real click still has
 * to go through sendInput.
 */
(async () => {
  const results = [];
  const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
  const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    markClean();   // else newProject()'s unsaved-changes confirm() hangs the run
    newProject();
    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    const vT = state.tracks.find((t) => t.type === 'video');
    const aT = state.tracks.find((t) => t.type === 'audio');
    ok('two A/V pairs on the timeline',
      vT.clips.length === 2 && aT.clips.length === 2,
      vT.clips.length + ' video, ' + aT.clips.length + ' audio');

    // ------------------------------------------------ marquee geometry
    const rect = () => document.querySelector('#tracks').getBoundingClientRect();
    const laneOf = (i) => document.querySelector('#tracks').children[i];
    const at = (t, trackIndex) => {
      const r = rect();
      return {
        x: r.left + t * state.pxPerSec,
        y: r.top + trackIndex * TRACK_H + TRACK_H / 2,
      };
    };
    const drag = async (t0, i0, t1, i1, opts) => {
      const a = at(t0, i0), b = at(t1, i1);
      const o = opts || {};
      laneOf(i0).dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, clientX: a.x, clientY: a.y, shiftKey: !!o.shift,
      }));
      // Two moves: the first crosses the 3px threshold, the second sets the real box.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: a.x + 8, clientY: a.y + 8 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: b.x, clientY: b.y }));
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: b.x, clientY: b.y }));
      await sleep(20);
    };

    const vi = state.tracks.indexOf(vT);
    const ai = state.tracks.indexOf(aT);
    const first = vT.clips[0], second = vT.clips[1];

    // A box over the first clip's middle, on the video lane only.
    setSelection([], false);
    await drag(first.start + 0.2, vi, first.start + 0.5, vi);
    ok('a box over one clip selects it', state.selection.has(first.id));
    ok('and takes its linked audio with it',
      state.selection.has(aT.clips[0].id), [...state.selection].join(','));
    ok('without catching the next clip', !state.selection.has(second.id));

    // A box across both clips.
    setSelection([], false);
    await drag(first.start + 0.1, vi, clipEnd(second) - 0.1, vi);
    ok('a wider box catches both pairs', state.selection.size === 4,
      String(state.selection.size));

    // Overlap, not containment: a box wholly inside one long clip still selects it.
    setSelection([], false);
    const mid = (first.start + clipEnd(first)) / 2;
    await drag(mid - 0.05, vi, mid + 0.05, vi);
    ok('a box inside a clip still selects it (overlap, not containment)',
      state.selection.has(first.id));

    // A box on the audio lane only, well clear of the video lane.
    setSelection([], false);
    await drag(first.start + 0.2, ai, first.start + 0.5, ai);
    ok('a box on the audio lane alone still selects the pair',
      state.selection.has(first.id) && state.selection.has(aT.clips[0].id),
      [...state.selection].join(','));

    // Shift is additive.
    setSelection([first.id], false);
    await drag(second.start + 0.1, vi, clipEnd(second) - 0.1, vi, { shift: true });
    ok('shift+box adds to the selection',
      state.selection.has(first.id) && state.selection.has(second.id));

    // A press that never moves is still a click on empty timeline.
    setSelection([first.id], false);
    const empty = at(clipEnd(second) + 2, vi);
    laneOf(vi).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: empty.x, clientY: empty.y }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: empty.x, clientY: empty.y }));
    await sleep(20);
    ok('a click on empty timeline still clears the selection', state.selection.size === 0);

    ok('no marquee element is left behind', !document.querySelector('#marquee'));

    // A locked track is not selectable by box, exactly as it is not by click.
    vT.locked = true;
    setSelection([], false);
    await drag(first.start + 0.2, vi, first.start + 0.5, vi);
    ok('a box over a locked track selects nothing there',
      !state.selection.has(first.id), [...state.selection].join(','));
    vT.locked = false;

    // ------------------------------------------------ close gaps
    markClean();   // else newProject()'s unsaved-changes confirm() hangs the run
    newProject();
    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    const v = state.tracks.find((t) => t.type === 'video');
    const a2 = state.tracks.find((t) => t.type === 'audio');
    const A = v.clips[0], B = v.clips[1];
    const Aa = a2.clips[0], Ba = a2.clips[1];

    // Push the second pair out to leave a 2s gap.
    const gapTo = clipEnd(A) + 2;
    const shift = gapTo - B.start;
    B.start += shift; Ba.start += shift;
    sortTracks();
    const lenB = B.out - B.in;

    setSelection([A.id, Aa.id, B.id, Ba.id], false);
    const undo0 = undoStack.length;
    const r = closeGaps();
    ok('close gaps reports what it moved', !!r && r.moved === 1 && near(r.closed, 2, 0.01),
      JSON.stringify(r));
    ok('the second pair butts against the first',
      near(B.start, clipEnd(A), 0.002), B.start + ' vs ' + clipEnd(A));
    ok('picture and sound moved together',
      near(B.start, Ba.start, 0.002) && near(clipEnd(B), clipEnd(Ba), 0.002),
      B.start + ' / ' + Ba.start);
    ok('nothing was trimmed - only moved', near(B.out - B.in, lenB, 1e-9));
    ok('the whole thing is ONE undo entry', undoStack.length === undo0 + 1,
      undo0 + ' -> ' + undoStack.length);

    undo();
    ok('one undo puts the gap back',
      near(state.tracks.find((t) => t.type === 'video').clips[1].start, gapTo, 0.002));
    redo();

    // Running it again has nothing to do, and must not push a dead undo entry.
    const undo1 = undoStack.length;
    ok('a second run finds no gaps', closeGaps() === null);
    ok('and pushes no undo entry', undoStack.length === undo1,
      undo1 + ' -> ' + undoStack.length);

    // One clip is not a gap.
    setSelection([v.clips[0].id], false);
    ok('one selected clip is refused', closeGaps() === null);
    setSelection([], false);
    ok('an empty selection is refused', closeGaps() === null);

    // Nothing outside the selection moves: this is local, not a ripple.
    markClean();   // else newProject()'s unsaved-changes confirm() hangs the run
    newProject();
    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    const v3 = state.tracks.find((t) => t.type === 'video');
    const a3 = state.tracks.find((t) => t.type === 'audio');
    const P = v3.clips[0], Q = v3.clips[1];
    Q.start = clipEnd(P) + 2;
    a3.clips[1].start = Q.start;
    addTrack('audio');
    const music = state.tracks.filter((t) => t.type === 'audio').find((t) => !t.clips.length);
    const bystander = Object.assign({}, a3.clips[0], { id: nextId(), start: 20, linkId: null });
    music.clips.push(bystander);
    sortTracks();

    setSelection([P.id, a3.clips[0].id, Q.id, a3.clips[1].id], false);
    closeGaps();
    ok('a clip outside the selection does not move', near(bystander.start, 20, 1e-9),
      String(bystander.start));

    // Groups that already overlap have no gap to close, so they stay where they are.
    // A fresh project rather than an undo: restore() replaces every clip object, so a
    // reference taken before an undo points at a clip the timeline no longer holds.
    markClean();   // else newProject()'s unsaved-changes confirm() hangs the run
    newProject();
    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    const v5 = state.tracks.find((t) => t.type === 'video');
    const a5 = state.tracks.find((t) => t.type === 'audio');
    const P2 = v5.clips[0], Q2 = v5.clips[1];
    Q2.start = P2.start + 0.2;
    a5.clips[1].start = Q2.start;
    sortTracks();
    setSelection([P2.id, a5.clips[0].id, Q2.id, a5.clips[1].id], false);
    const overlapAt = Q2.start;
    ok('overlapping groups are left alone',
      closeGaps() === null && near(Q2.start, overlapAt, 1e-9), String(Q2.start));

    // ------------------------------------------------ Tighten over many clips
    markClean();   // else newProject()'s unsaved-changes confirm() hangs the run
    newProject();
    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    const v4 = state.tracks.find((t) => t.type === 'video');
    const a4 = state.tracks.find((t) => t.type === 'audio');
    setSelection([v4.clips[0].id, a4.clips[0].id, v4.clips[1].id, a4.clips[1].id], false);
    renderInspector();
    const insp = document.querySelector('#inspector');
    ok('a real multi-selection still says how many are selected',
      /clips selected/.test(insp.textContent), insp.textContent.slice(0, 40));
    ok('and offers Tighten over all of them',
      !!insp.querySelector('.tighten-box'));
    ok('Tighten sees both link groups', tightenUnits().length === 2,
      String(tightenUnits().length));

    // Injected spans, so the count is exact without decoding anything.
    for (const c of a4.clips) silenceCache.set(c.src + '|-30', { spans: [[0.5, 1.5]], duration: 3 });
    state.tighten = { threshold: 0.35, pad: 0.05, noise: -30 };
    const plan = tightenPlan();
    ok('a multi-selection plans a cut per group', plan.count === 2 && plan.pending === 0,
      JSON.stringify(plan.spans));
    const u0 = undoStack.length;
    tighten();
    ok('and cuts both in ONE undo entry', undoStack.length === u0 + 1,
      u0 + ' -> ' + undoStack.length);
    ok('leaving picture and sound in sync',
      JSON.stringify(v4.clips.map((c) => [c.start.toFixed(3), (c.out - c.in).toFixed(3)])) ===
      JSON.stringify(a4.clips.map((c) => [c.start.toFixed(3), (c.out - c.in).toFixed(3)])),
      v4.clips.length + ' video, ' + a4.clips.length + ' audio');

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return results.join('\n') + '\n\nERR ' + (e && e.stack ? e.stack : e);
  }
})()
