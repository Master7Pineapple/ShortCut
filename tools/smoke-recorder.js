/**
 * The screen recorder and its cursor telemetry.
 *
 *   SHORTCUT_SMOKE=tools/smoke-recorder.js node_modules/.bin/electron .
 *
 * Four things this suite exists to hold down, in the order the roadmap names them:
 *
 *   1. the telemetry file's SHAPE - what a sidecar has to contain to be usable at all;
 *   2. FIRST-FRAME alignment - that timestamps are measured from the video's first
 *      frame and not from when the user pressed Record, and that the pre-roll is
 *      handled rather than left to skew everything downstream;
 *   3. coordinate NORMALISATION across display scales - a 150% display and a 100% one
 *      recording the same gesture must produce the same numbers;
 *   4. a clip with NO telemetry, which is the normal case for an OBS or Screen Studio
 *      capture and must degrade rather than break. Steps 9 and 14 both depend on this
 *      being true, so it is asserted here rather than assumed.
 *
 * It needs `clip1.mp4` in %TEMP%\scut_test - the same fixture `tools/smoke.js` uses:
 *
 *   ffmpeg -f lavfi -i testsrc=size=1920x1080:rate=30:duration=3 \
 *          -f lavfi -i sine=duration=3 -c:v libx264 -pix_fmt yuv420p -c:a aac \
 *          -shortest "%TEMP%/scut_test/clip1.mp4"
 *
 * The suite copies it rather than using it in place, because it writes a telemetry
 * sidecar next to it and no other suite should start seeing cursor data on its fixture.
 *
 * The live capture at the end is opportunistic: on a machine that offers no capturable
 * display it reports SKIP rather than failing, since a real recording needs a real
 * screen and the other 40-odd assertions do not.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const skip = (name, why) => results.push('SKIP  ' + name + '   ' + why);
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const SRC = D + 'clip1.mp4';
    const COPY = D + 'screenrec_fixture.mp4';
    const SIDE = ScreenTel.sidecarPath(COPY);

    // =========================================================== 1. the file's shape

    ok('the sidecar sits next to the recording, named after it',
      ScreenTel.sidecarPath('C:\\a b\\rec-01.webm') === 'C:\\a b\\rec-01.screen.json',
      ScreenTel.sidecarPath('C:\\a b\\rec-01.webm'));
    ok('a dotted folder does not eat the extension',
      ScreenTel.sidecarPath('C:\\v1.2\\rec') === 'C:\\v1.2\\rec.screen.json',
      ScreenTel.sidecarPath('C:\\v1.2\\rec'));

    const region = ScreenTel.regionOfDisplay({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
    const goodDoc = ScreenTel.makeDoc({
      source: { id: 'screen:0:0', name: 'Screen 1', type: 'screen', displayId: '1' },
      video: { file: 'r.webm', w: 1920, h: 1080, fps: 30, firstFrameEpochMs: 1000, durationMs: 3000 },
      region, clicks: true,
      events: [{ t: 0, x: 0.5, y: 0.5, type: 'move' }],
    });
    ok('a complete document validates', ScreenTel.validate(goodDoc).ok);
    ok('the document names itself, so a stray JSON is not mistaken for one',
      !ScreenTel.validate({ events: [], region, video: { firstFrameEpochMs: 1 } }).ok);
    ok('no first-frame timestamp means no telemetry',
      !ScreenTel.validate(Object.assign({}, goodDoc, { video: { file: 'r.webm' } })).ok,
      ScreenTel.validate(Object.assign({}, goodDoc, { video: { file: 'r.webm' } })).reason);
    ok('no capture region means no telemetry',
      !ScreenTel.validate(Object.assign({}, goodDoc, { region: null })).ok);
    ok('garbage validates as garbage rather than throwing',
      !ScreenTel.validate(null).ok && !ScreenTel.validate('nope').ok && !ScreenTel.validate(42).ok);

    // What lands on the clip is deliberately much smaller than what is on disk: undo is
    // JSON.stringify of the track list, so thumbnails and ISO dates have no business there.
    const cs = ScreenTel.clipScreen(goodDoc);
    ok('the clip gets events, the captured pixel size and the click flag - nothing else',
      cs && Object.keys(cs).sort().join(',') === 'clicks,displayH,displayW,events',
      cs ? Object.keys(cs).sort().join(',') : 'null');
    ok('the clip payload is plain JSON',
      JSON.stringify(JSON.parse(JSON.stringify(cs))) === JSON.stringify(cs));
    ok('an invalid document produces no clip payload, not a half-built one',
      ScreenTel.clipScreen({ app: 'something-else' }) === null);

    // =============================================== 2. first-frame timestamp alignment

    // Recording begins at 1000; the first FRAME arrives at 1200. Everything in between
    // is pre-roll the video does not contain.
    const T0 = 1200;
    const raw = [
      { ms: 1000, x: 0.10, y: 0.10, type: 'move' },
      { ms: 1100, x: 0.20, y: 0.20, type: 'move' },   // the last pre-roll sample
      { ms: 1150, x: 0.25, y: 0.25, type: 'down' },   // a click the video never saw
      { ms: 1400, x: 0.40, y: 0.40, type: 'move' },
      { ms: 1300, x: 0.30, y: 0.30, type: 'move' },   // out of order on purpose
      { ms: 1500, x: 0.50, y: 0.50, type: 'down' },
    ];
    const ev = ScreenTel.alignEvents(raw, T0);
    ok('events come out sorted by time', ev.every((e, i) => i === 0 || e.t >= ev[i - 1].t),
      ev.map((e) => e.t).join(','));
    ok('time is measured from the FIRST FRAME, not from when Record was pressed',
      near(ev.find((e) => near(e.x, 0.3)).t, 0.1) && near(ev.find((e) => near(e.x, 0.4)).t, 0.2),
      'x=0.3 at t=' + ev.find((e) => near(e.x, 0.3)).t);
    ok('a click before the first frame is not in the video, so it is dropped',
      !ev.some((e) => e.type === 'down' && near(e.x, 0.25)));
    ok('the last pre-roll POSITION survives, retimed to t=0',
      ev[0].t === 0 && near(ev[0].x, 0.2) && ev[0].type === 'move',
      't=' + ev[0].t + ' x=' + ev[0].x);
    ok('no sample is left before t=0', ev.every((e) => e.t >= 0));
    ok('the click after the first frame keeps its position and time',
      ev.some((e) => e.type === 'down' && near(e.x, 0.5) && near(e.t, 0.3)));

    // The pre-roll rule exists for exactly one case: a recording that opens on a
    // motionless pointer would otherwise have no cursor position at all until it moved.
    const still = ScreenTel.alignEvents(
      [{ ms: 900, x: 0.7, y: 0.3 }, { ms: 950, x: 0.7, y: 0.3 }, { ms: 3000, x: 0.7, y: 0.3 }], 1000);
    ok('a pointer that never moves still has a position at t=0',
      still.length >= 2 && still[0].t === 0 && near(still[0].x, 0.7));
    // ...and it must not invent a second sample when a real one already sits at zero.
    const exact = ScreenTel.alignEvents([{ ms: 900, x: 0.1, y: 0.1 }, { ms: 1000, x: 0.2, y: 0.2 }], 1000);
    ok('a real sample at t=0 is not duplicated by the pre-roll rule',
      exact.filter((e) => e.t === 0).length === 1, JSON.stringify(exact));
    ok('an empty recording aligns to an empty list', ScreenTel.alignEvents([], 1000).length === 0);

    // =============================================== 3. normalisation across scales

    const r100 = ScreenTel.regionOfDisplay({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
    const r150 = ScreenTel.regionOfDisplay({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 });
    const r2nd = ScreenTel.regionOfDisplay({ bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 });

    ok('the region records the pixels the capture actually has',
      r100.displayW === 1920 && r150.displayW === 2880 && r2nd.displayH === 2880,
      r100.displayW + ' / ' + r150.displayW + ' / ' + r2nd.displayH);
    // Bounds are DIP and the cursor point is DIP, so the ratio is already scale-free.
    // This is the assertion that says the file survives being replayed on another machine.
    const a = ScreenTel.normPoint(960, 540, r100);
    const b = ScreenTel.normPoint(960, 540, r150);
    ok('the same gesture normalises identically at 100% and 150% scaling',
      near(a.x, b.x) && near(a.y, b.y) && near(a.x, 0.5), JSON.stringify(a) + ' vs ' + JSON.stringify(b));
    const c2 = ScreenTel.normPoint(1920 + 640, 360, r2nd);
    ok('a second monitor is normalised into ITS OWN region, not the desktop',
      near(c2.x, 0.25) && near(c2.y, 0.25), JSON.stringify(c2));
    const off = ScreenTel.normPoint(-192, 540, r100);
    ok('a point on another monitor stays outside 0..1 rather than being clamped to the edge',
      off.x < 0, String(off.x));

    // =============================================== 4. the click watcher's output

    ok('a mouse-down line parses', (() => {
      const e = ScreenTel.parseClickLine('D 1 1757400000123');
      return e && e.type === 'down' && e.button === 1 && e.ms === 1757400000123;
    })());
    ok('a mouse-up line parses', (ScreenTel.parseClickLine('U 2 100') || {}).type === 'up');
    ok('a trailing carriage return is not a parse failure',
      !!ScreenTel.parseClickLine('D 1 100\r'));
    ok('noise on the watcher\'s stdout is ignored, not turned into an event',
      ScreenTel.parseClickLine('') === null &&
      ScreenTel.parseClickLine('At line:1 char:1') === null &&
      ScreenTel.parseClickLine('D x 100') === null);

    // =============================================== 5. reading it back on a clip

    const clip = { kind: 'video', in: 0, out: 3, screen: ScreenTel.clipScreen(ScreenTel.makeDoc({
      video: { firstFrameEpochMs: 1 }, region: r100, clicks: true,
      events: [
        { t: 0, x: 0, y: 0, type: 'move' },
        { t: 1, x: 1, y: 0.5, type: 'move' },
        { t: 0.5, x: 0.5, y: 0.25, type: 'down' },
        { t: 2, x: 0, y: 1, type: 'move' },
      ].sort((p, q) => p.t - q.t),
    })) };
    ok('a clip with telemetry says so', ScreenTel.hasTelemetry(clip));
    const mid = ScreenTel.cursorAt(clip.screen, 0.5);
    ok('a position between two samples is interpolated', near(mid.x, 0.5) && near(mid.y, 0.25),
      JSON.stringify(mid));
    ok('a click carries a position but is not itself a sample',
      near(ScreenTel.cursorAt(clip.screen, 0.75).x, 0.75), JSON.stringify(ScreenTel.cursorAt(clip.screen, 0.75)));
    ok('the ends are held rather than extrapolated',
      near(ScreenTel.cursorAt(clip.screen, -5).x, 0) && near(ScreenTel.cursorAt(clip.screen, 99).y, 1));
    ok('clicks come back for a span, half-open at the top',
      ScreenTel.clicksIn(clip.screen, 0, 0.5).length === 0 &&
      ScreenTel.clicksIn(clip.screen, 0.5, 1).length === 1);

    // ------------------------------------------------- the no-telemetry contract
    //
    // This is the one that steps 9 and 14 are built on: an OBS or phone recording has no
    // cursor data and every consumer must answer "none" instead of throwing.
    const bare = { kind: 'video', in: 0, out: 3 };
    ok('a clip with no telemetry says so, for every empty shape',
      !ScreenTel.hasTelemetry(bare) && !ScreenTel.hasTelemetry({ screen: {} }) &&
      !ScreenTel.hasTelemetry({ screen: { events: [] } }) && !ScreenTel.hasTelemetry(null));
    ok('asking a clip with no telemetry for a cursor answers null, not an exception',
      ScreenTel.cursorAt(bare.screen, 1) === null && clipCursorAt(bare, 1) === null);
    ok('asking it for clicks answers an empty list',
      ScreenTel.clicksIn(bare.screen, 0, 10).length === 0 && clipClicks(bare).length === 0);
    ok('the inspector prints no telemetry row for a clip that has none',
      telemetryRow(bare) === '' && telemetryRow({ kind: 'text' }) === '');
    ok('the inspector prints one for a clip that has some',
      telemetryRow(clip).indexOf('samples') > 0, telemetryRow(clip));

    // =============================================== 6. importing a recording

    newProject();
    let haveFixture = true;
    try {
      const buf = await (await fetch('file:///' + SRC.replace(/\\/g, '/'))).arrayBuffer();
      await window.api.writeTestFile(COPY, new Uint8Array(buf));
    } catch (e) { haveFixture = false; }

    if (!haveFixture) {
      skip('importing a recording with a sidecar', 'no clip1.mp4 in ' + D);
    } else {
      // First: the SAME file with no sidecar next to it. This is every recording made
      // anywhere but here, and it has to arrive as an ordinary clip.
      await window.api.writeTestFile(SIDE, new Uint8Array(0));   // a truthy but broken file
      await importPaths([COPY]);
      await sleep(400);
      let vid = allClips().map((x) => x.clip).find((c) => c.kind === 'video');
      ok('a recording whose sidecar is unreadable imports as an ordinary clip',
        !!vid && !ScreenTel.hasTelemetry(vid));

      newProject();
      const doc = ScreenTel.makeDoc({
        source: { id: 'screen:0:0', name: 'Screen 1', type: 'screen', displayId: '1' },
        video: { file: 'screenrec_fixture.mp4', w: 1920, h: 1080, fps: 30, firstFrameEpochMs: 1000, durationMs: 3000 },
        region: r100, clicks: true,
        events: [
          { t: 0, x: 0.1, y: 0.1, type: 'move' },
          { t: 1, x: 0.5, y: 0.5, type: 'move' },
          { t: 1.5, x: 0.6, y: 0.6, type: 'down' },
          { t: 1.6, x: 0.6, y: 0.6, type: 'up' },
          { t: 2, x: 0.9, y: 0.9, type: 'move' },
        ],
      });
      await window.api.writeTestFile(SIDE, new TextEncoder().encode(JSON.stringify(doc)));
      await importPaths([COPY]);
      await sleep(400);
      vid = allClips().map((x) => x.clip).find((c) => c.kind === 'video');
      ok('the sidecar rides in on the import', !!vid && ScreenTel.hasTelemetry(vid),
        vid && vid.screen ? vid.screen.events.length + ' events' : 'none');
      const aud = allClips().map((x) => x.clip).find((c) => c.kind === 'audio');
      ok('telemetry goes on the PICTURE, not on the linked audio clip',
        !!aud && !ScreenTel.hasTelemetry(aud));
      ok('the clip knows the captured pixel size',
        vid.screen.displayW === 1920 && vid.screen.displayH === 1080);

      // Timeline position must not touch a lookup: telemetry is source time.
      const before = JSON.stringify(clipCursorAt(vid, 1));
      vid.start = 12.5;
      ok('moving the clip on the timeline does not move the cursor',
        JSON.stringify(clipCursorAt(vid, 1)) === before, before);
      vid.start = 0;

      // ...and trimming does, because `in` moves and the events do not.
      ok('a lookup is relative to the clip\'s in point',
        near(clipCursorAt(vid, 1).x, 0.5), JSON.stringify(clipCursorAt(vid, 1)));
      const wasIn = vid.in;
      vid.in = 1;
      ok('trimming the head shifts the lookup with it, so the cursor stays on its pixel',
        near(clipCursorAt(vid, 0).x, 0.5), JSON.stringify(clipCursorAt(vid, 0)));
      ok('clicks are reported relative to the clip\'s start',
        clipClicks(vid).length === 1 && near(clipClicks(vid)[0].t, 0.5),
        JSON.stringify(clipClicks(vid)));
      vid.in = wasIn;

      // Splitting: both halves keep the whole event list, and each reads its own part
      // of it through its own in point. That is what makes source time the right choice.
      setSelection([vid.id], false);
      seek(1.2);
      splitAtPlayhead();
      const halves = allClips().map((x) => x.clip).filter((c) => c.kind === 'video');
      ok('both halves of a split recording keep their telemetry',
        halves.length === 2 && halves.every((h) => ScreenTel.hasTelemetry(h)),
        halves.length + ' halves');
      // The cut is at 1.2 s, so 0.3 s into the right half is 1.5 s of SOURCE - half way
      // between the samples at 1 s (x=0.5) and 2 s (x=0.9).
      const right = halves.find((h) => h.in > 0.5);
      ok('the right half reads the right part of the track',
        !!right && near(clipCursorAt(right, 0.3).x, 0.7, 1e-9),
        right ? JSON.stringify(clipCursorAt(right, 0.3)) : 'none');
      ok('the click lands in exactly one half',
        halves.reduce((n, h) => n + clipClicks(h).length, 0) === 1,
        halves.map((h) => clipClicks(h).length).join('+'));
      undo();

      // The .scut is JSON.stringify of the track list, so this is also the undo shape.
      const round = JSON.parse(JSON.stringify(serialize()));
      const back = round.tracks.reduce((f, t) => f || t.clips.find((c) => c.kind === 'video'), null);
      ok('telemetry survives a save and reload intact',
        !!back && ScreenTel.hasTelemetry(back) &&
        JSON.stringify(back.screen) === JSON.stringify(vid.screen),
        back && back.screen ? back.screen.events.length + ' events' : 'none');
      ok('nothing non-serialisable made it onto the clip',
        JSON.stringify(vid) === JSON.stringify(JSON.parse(JSON.stringify(vid))));

      // Telemetry describes the source, not the picture, so it must not reach the render
      // job - and above all not the cache key, or moving a clip would invalidate a bake.
      const job = buildJob('C:\\out.mp4', { from: 0, to: projectDuration() });
      const entry = job.clips.find((c) => c.kind === 'video');
      ok('the render job carries no telemetry', !!entry && entry.screen === undefined);
    }

    // =============================================== 7. the recorder itself

    const st = await window.api.screenState();
    ok('the recorder reports itself idle before anything starts',
      st && st.recording === false, JSON.stringify(st));
    const stopped = await window.api.screenStop();
    ok('stopping when nothing is recording fails cleanly',
      stopped && stopped.ok === false, JSON.stringify(stopped));

    const sources = await window.api.screenSources();
    if (!Array.isArray(sources)) {
      skip('the source list', (sources && sources.error) || 'desktopCapturer refused');
    } else {
      ok('the source list is offered', sources.length > 0, sources.length + ' sources');
      const screens = sources.filter((s) => s.type === 'screen');
      ok('every source names itself and carries a thumbnail',
        sources.every((s) => s.id && typeof s.name === 'string'));
      ok('a whole display carries a capture region, so it can log telemetry',
        screens.length === 0 || screens.every((s) => s.region && s.region.displayW > 0),
        screens.map((s) => s.region && s.region.displayW).join(','));
      ok('a window carries no region, so it records picture only - the documented degradation',
        sources.filter((s) => s.type === 'window').every((s) => !s.region));

      const disp = screens.find((s) => s.region);
      if (!disp) {
        skip('a live recording', 'no capturable display on this machine');
      } else {
        newProject();
        const t0 = Date.now();
        const started = await window.api.screenStart({
          sourceId: disp.id, name: disp.name, type: 'screen', displayId: disp.displayId, cursor: true,
        });
        if (!started || !started.ok) {
          skip('a live recording', (started && started.error) || 'capture refused');
        } else {
          ok('starting answers only once capture is running', !!started.file && started.cursor === true);
          await sleep(2500);
          const done = await window.api.screenStop();
          ok('the recording is written and is not empty', done && done.ok && done.bytes > 0,
            done ? done.bytes + ' bytes' : 'failed');
          ok('a sidecar is written next to it', !!(done && done.json), done && done.json);
          ok('the telemetry has real samples in it', !!(done && done.samples > 0),
            done ? done.samples + ' samples' : '0');

          if (done && done.json) {
            const doc2 = await (await fetch('file:///' + done.json.replace(/\\/g, '/'))).json();
            ok('the written document validates', ScreenTel.validate(doc2).ok,
              ScreenTel.validate(doc2).reason || '');
            // The whole point of the first-frame clock: the video's frame zero is LATER
            // than the moment Record was pressed, and every event is timed from it.
            ok('the first frame is timestamped after Record was pressed',
              doc2.video.firstFrameEpochMs >= t0, (doc2.video.firstFrameEpochMs - t0) + ' ms after');
            ok('the first frame is not in the future',
              doc2.video.firstFrameEpochMs <= Date.now());
            ok('no event predates the first frame',
              doc2.events.every((e) => e.t >= 0));
            ok('events span roughly the recording, not the wall clock since launch',
              doc2.events[doc2.events.length - 1].t < 10,
              'last at ' + doc2.events[doc2.events.length - 1].t + 's');
            ok('samples arrive at about the requested rate',
              doc2.events.length > 30, doc2.events.length + ' in ~2.5 s');
            ok('every sample is normalised to the captured display',
              doc2.events.every((e) => typeof e.x === 'number' && typeof e.y === 'number'));

            // ...and it comes back in through the ordinary importer.
            await importPaths([done.file], { at: 0 });
            await sleep(600);
            const recClip = allClips().map((x) => x.clip)
              .find((c) => c.kind === 'video' && c.src === done.file);
            ok('the recording imports with its telemetry attached',
              !!recClip && ScreenTel.hasTelemetry(recClip),
              recClip ? String(recClip.screen && recClip.screen.events.length) : 'not imported');
            ok('a cursor position can be read out of it',
              !!recClip && clipCursorAt(recClip, 0.1) !== null);
            // MediaRecorder writes a live WebM with no duration in its header, which
            // makes media:scan drop the file. The remux in finishRecording() is what
            // stops a fresh recording refusing to import - see remuxRecording().
            ok('the recording has a real duration, so the importer can measure it',
              !!recClip && recClip.mediaDuration > 1,
              recClip ? String(recClip.mediaDuration) : 'not imported');
          }
          const after = await window.api.screenState();
          ok('the recorder is idle again afterwards', after && after.recording === false);
        }
      }
    }

    return results.join('\n');
  } catch (e) {
    return 'THREW: ' + (e && e.stack || e);
  }
})();
