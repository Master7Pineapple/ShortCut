/**
 * Smoke test for the editor's timeline logic. Runs inside the live renderer:
 *
 *   set SHORTCUT_SMOKE=tools\smoke.js && npx electron .        (cmd)
 *   SHORTCUT_SMOKE=tools/smoke.js node_modules/.bin/electron . (bash)
 *
 * Expects two test clips in %TEMP%\scut_test (clip1.mp4, clip2.mp4); generate them with
 * ffmpeg's testsrc if they are missing. Prints PASS/FAIL lines and exits.
 */
(async () => {
  const results = [];
  const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';

  // A blocking `confirm()` has nobody to answer it on a smoke run, and nine suites call
  // newProject()/openProject() - both of which ask "Discard unsaved changes?" whenever the
  // project is dirty, which it is the moment anything is imported. A run that hits it sits
  // on the modal until something kills it, having printed nothing. Asserted here, in the
  // suite every other one is built on, because a regression would not FAIL - it would
  // HANG, and a hang tells you nothing about which change caused it.
  ok('the renderer knows this is a smoke run', window.api.smoke === true);
  state.dirty = true;
  ok('so the discard prompt answers itself instead of blocking', confirmDiscard() === true);
  state.dirty = false;

  await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);

  const v = state.tracks.find((t) => t.type === 'video');
  const a = state.tracks.find((t) => t.type === 'audio');
  ok('import creates 2 video clips', v.clips.length === 2, 'got ' + v.clips.length);
  ok('import creates 2 linked audio clips', a.clips.length === 2, 'got ' + a.clips.length);
  ok('clips laid end to end in folder order',
    v.clips[0].start === 0 && Math.abs(v.clips[1].start - v.clips[0].out) < 0.01,
    v.clips.map((c) => c.name + '@' + c.start.toFixed(2)).join(' '));
  ok('A/V share a linkId', v.clips[0].linkId && v.clips[0].linkId === a.clips[0].linkId);
  ok('duration = sum of clips', Math.abs(projectDuration() - (v.clips[0].out + (v.clips[1].out - v.clips[1].in))) < 0.05,
    projectDuration().toFixed(2));

  // --- split -------------------------------------------------------------
  const durBefore = projectDuration();
  seek(1.5);
  splitAtPlayhead();
  ok('split makes 3 video clips', v.clips.length === 3, 'got ' + v.clips.length);
  ok('split makes 3 audio clips', a.clips.length === 3, 'got ' + a.clips.length);
  ok('split preserves duration', Math.abs(projectDuration() - durBefore) < 0.01);
  ok('halves are contiguous', Math.abs(clipEnd(v.clips[0]) - v.clips[1].start) < 0.001);
  ok('right half keeps a link', !!v.clips[1].linkId && v.clips[1].linkId === a.clips[1].linkId);

  // --- selection follows links -------------------------------------------
  setSelection(linkGroup(v.clips[0]).map((c) => c.id), false);
  ok('selecting a linked clip selects its pair', state.selection.size === 2, 'got ' + state.selection.size);

  // --- ripple delete ------------------------------------------------------
  const cut = clipEnd(v.clips[0]) - v.clips[0].start;
  deleteSelected(true);
  ok('ripple delete removes the pair', v.clips.length === 2 && a.clips.length === 2);
  ok('ripple delete closes the gap', Math.abs(v.clips[0].start) < 0.001, 'start=' + v.clips[0].start.toFixed(3));
  ok('ripple delete shortens the project', Math.abs(projectDuration() - (durBefore - cut)) < 0.02,
    projectDuration().toFixed(2) + ' vs ' + (durBefore - cut).toFixed(2));

  // --- undo / redo --------------------------------------------------------
  undo();
  ok('undo restores the deleted clips', state.tracks.find((t) => t.type === 'video').clips.length === 3);
  redo();
  ok('redo re-deletes', state.tracks.find((t) => t.type === 'video').clips.length === 2);

  // --- unlink -------------------------------------------------------------
  selectAll();
  unlinkSelected();
  ok('unlink clears every linkId', allClips().every((x) => !x.clip.linkId));

  // --- trim ---------------------------------------------------------------
  const t0 = state.tracks.find((x) => x.type === 'video').clips[0];
  setSelection([t0.id], false);
  seek(1.0);
  trimToPlayhead('out');
  ok('trim out moves the out point', Math.abs(clipEnd(t0) - 1.0) < 0.01, 'end=' + clipEnd(t0).toFixed(3));
  ok('trim keeps in < out and within the source', t0.in < t0.out && t0.out <= t0.mediaDuration + 0.001);

  // --- framing agreement --------------------------------------------------
  t0.panX = 0; t0.panY = 0.5; t0.zoom = 1;
  const job = buildJob('C:\\nowhere.mp4');
  const jv = job.clips.find((c) => c.kind === 'video' && c.visible);
  ok('render job carries framing', jv && jv.panX === 0 && jv.zoom === 1);
  ok('render job marks audio-track clips audible', job.clips.some((c) => c.audible));
  ok('render job never marks video clips audible', !job.clips.some((c) => c.kind === 'video' && c.audible));
  ok('render job is bottom-track-first',
    job.clips.length > 0 && job.clips[0] !== undefined);

  // --- project round trip -------------------------------------------------
  const json = JSON.parse(JSON.stringify(serialize()));
  ok('serialize round-trips tracks', json.tracks.length === state.tracks.length);
  ok('serialize keeps clip fields',
    json.tracks.flatMap((t) => t.clips).every((c) => c.src && typeof c.in === 'number' && typeof c.panX === 'number'));

  // --- a click listener hands its handler an Event -------------------------
  //
  // `#btnOpen` was bound straight to `openProject`, which was harmless while that
  // function took no arguments. The moment it took a path, the click Event went to main
  // as a structured-cloned Object and `fs.readFileSync` refused it: "the path argument
  // must be of type string ... received an instance of Object". The button is wrapped
  // now AND the function guards its own argument; this asserts the guard, because that
  // is the half a future caller cannot get wrong.
  //
  // Stubbed, so nothing here can open a real dialog - which on a smoke run would hang
  // with nobody to answer it, the same failure mode `confirmDiscard()` is asserted for
  // at the top of this file.
  // Asserted through `projectPathArg()` rather than by watching the IPC call, because
  // `window.api` is frozen by contextBridge and cannot be stubbed. Calling `openProject()`
  // for real is not an option either: with no path it opens a modal file dialog, which on
  // a smoke run has nobody to answer it - the same hang `confirmDiscard()` is asserted
  // against at the top of this file.
  ok('an Event reaching openProject is not forwarded to main as a path',
    projectPathArg(new Event('click')) === null,
    'got ' + JSON.stringify(projectPathArg(new Event('click'))));
  ok('nor is any other non-string',
    projectPathArg({ some: 'object' }) === null && projectPathArg(42) === null &&
    projectPathArg('') === null);
  ok('but a real path still goes through untouched',
    projectPathArg('C:\\nowhere\\x.scut') === 'C:\\nowhere\\x.scut');
  ok('and no argument still means "ask me", which is what the button does',
    projectPathArg() === null && projectPathArg(null) === null);

  // The same bug class, one button along: `toggleBin` takes `show`, so bound directly it
  // received the click Event - truthy - and could open the bin but never close it again.
  {
    toggleBin(true);
    const opened = !$('#quickBin').hidden;
    $('#btnBinCollapse').click();
    const closed = $('#quickBin').hidden;
    $('#btnBinCollapse').click();
    const reopened = !$('#quickBin').hidden;
    ok('the QuickBin collapse button actually toggles, both ways',
      opened && closed && reopened,
      'open=' + opened + ' close=' + closed + ' reopen=' + reopened);
  }

  // --- new project --------------------------------------------------------
  state.dirty = false;
  newProject();
  ok('new project clears the timeline', projectDuration() === 0 && state.tracks.length === 2);

  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
})()
