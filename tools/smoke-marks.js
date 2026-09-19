/**
 * Timeline markers, the tracked CROP, the animate effect's zoom direction, and the one
 * regression that made a tracker marker impossible to drag:
 *
 *   SHORTCUT_SMOKE=tools/smoke-marks.js node_modules/.bin/electron .
 *   set SHORTCUT_SMOKE=tools\smoke-marks.js && npx electron .          (cmd)
 *
 * NO FIXTURE. Every clip here is synthetic and every frame is painted by the suite, so
 * it runs on any machine - the four things it covers are all decided before a decoder
 * gets involved.
 *
 * The four:
 *
 *   1. MARKERS. The data model, that they are kept sorted, that a duplicate is refused,
 *      that a clip edge SNAPS to one (which is most of what they are for), that a marker
 *      being dragged cannot snap to itself, that each gesture is exactly one undo entry
 *      and that a press which never moved is none at all, that they survive a save and
 *      reload, that a marker with a nonsense time is dropped rather than repaired, and
 *      that the lane actually paints one where it says it does.
 *   2. THE TRACKED CROP. `crop` mode centres the tracked SOURCE pixel in the crop window
 *      and clamps the pan to the source - so the headline assertion is a pixel one: a
 *      16:9 clip framed to 9:16 and bound in `crop` mode paints an opaque frame, while
 *      the same clip in `camera` mode paints a transparent band, which is the black edge
 *      this mode exists to make unreachable.
 *   3. THE ZOOM DIRECTION. 'settle' is what the effect always did and is asserted to be
 *      byte-for-byte unchanged, including for a project saved before the control existed.
 *      'push' starts at exactly the full frame and HOLDS what it reached.
 *   4. THE TRACKER MARKER DRAG. Pressing on a marker must not also start a framing drag -
 *      the pointer handlers and the framing handler are different event types, so
 *      `stopPropagation()` never could have stopped it - and the marker must move BY the
 *      distance the pointer moved rather than jumping to it.
 */
(async () => {
  const results = [];
  const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  const note = (s) => results.push('....  ' + s);
  const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    markClean();
    newProject();

    // ================================================== 1. the marker data model

    ok('a new project has no markers', markers().length === 0);

    state.playhead = 2;
    const m1 = addMarker();
    ok('M drops one at the playhead, named', m1 && near(m1.t, 2) && m1.name === 'Mark 1',
      m1 && m1.name + ' @ ' + m1.t);

    state.playhead = 5;
    const m2 = addMarker();
    state.playhead = 3.5;
    const m3 = addMarker();
    ok('the numbering follows the count, not the order they land in',
      m3.name === 'Mark 3', m3.name);
    ok('the array is kept SORTED, which is what the lane and the walk both read in order',
      markers().map((m) => m.t).join(',') === '2,3.5,5', markers().map((m) => m.t).join(','));

    const before = markers().length;
    state.playhead = 2;
    addMarker();
    ok('a second marker on a moment that already has one is refused, not duplicated',
      markers().length === before, markers().length + ' markers');

    ok('the walk goes forward', markerStep(2, 1) === m3, markerStep(2, 1).name);
    ok('...and back', markerStep(3.5, -1) === m1, markerStep(3.5, -1).name);
    ok('...and answers null at the ends rather than wrapping round',
      markerStep(5, 1) === null && markerStep(2, -1) === null);

    // ------------------------------------------------------------ normalisation
    const dirty = normalizeMarkers([
      { t: 3, name: 'ok' },
      { t: 'nonsense', name: 'bad' },
      { t: -1, name: 'negative' },
      { t: 1, name: 'first' },
      null,
      'not an object',
    ]);
    ok('a marker with a time that is not a finite second is DROPPED, not repaired',
      dirty.length === 2 && dirty.every((m) => isFinite(m.t) && m.t >= 0),
      JSON.stringify(dirty.map((m) => m.name)));
    ok('...and what survives comes back sorted and with an id',
      dirty[0].name === 'first' && !!dirty[0].id && !!dirty[1].id);
    // The reason the one above matters, stated as its own claim: NaN wins no comparison,
    // so a marker at NaN does not lose the snap - it makes every OTHER candidate lose.
    ok('a NaN marker would have broken snapping silently, which is why it never gets in',
      !(Math.abs(NaN - 1) < 8) && !(Math.abs(NaN - 1) >= 8));

    // ==================================================== 2. snapping to a marker

    {
      const vt = state.tracks.find((t) => t.type === 'video');
      const idA = nextId();
      vt.clips.push({
        id: idA, src: 'C:\\fake\\a.mp4', name: 'a', kind: 'video',
        start: 0, in: 0, out: 4, mediaDuration: 4, srcW: 1920, srcH: 1080, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      sortTracks();
      state.snap = true;
      state.pxPerSec = 60;   // 8px of tolerance is 0.1333 s

      const d = snapDetail(3.46, null);
      ok('a time near a marker snaps ONTO it, and reports that it did',
        d.hit && near(d.t, 3.5), d.t + ' hit=' + d.hit);
      ok('...and a time nowhere near one comes back untouched and says so',
        !snapDetail(4.2, null).hit);

      // The one that makes markers worth having: an edge dragged near one lands on it.
      const clip = vt.clips.find((c) => c.id === idA);
      clip.start = 3.47;
      const snapped = snapTime(clip.start, new Set([clip.id]));
      ok('a clip edge dragged near a marker lands exactly on it', near(snapped, 3.5),
        String(snapped));
      clip.start = 0;

      // And the one that stops a marker being un-draggable.
      const self = new Set([m3.id]);
      ok('a marker being dragged does not snap to ITSELF, or it could never move again',
        !near(snapTime(3.52, self), 3.5) && near(snapTime(3.52, self), 3.52),
        String(snapTime(3.52, self)));
      ok('...but it still snaps to a clip edge, which is the point of dragging it',
        near(snapTime(0.04, self), 0), String(snapTime(0.04, self)));
    }

    // ======================================================== 3. undo, and saving

    {
      const depth = undoStack.length;
      state.playhead = 7;
      addMarker();
      ok('dropping a marker is exactly ONE undo entry', undoStack.length === depth + 1,
        (undoStack.length - depth) + ' entries');
      const n = markers().length;
      undo();
      ok('...and undo takes it back off', markers().length === n - 1,
        markers().length + ' left');
      redo();
      ok('...and redo puts it back', markers().length === n);

      const m = markers().find((x) => near(x.t, 7));
      removeMarker(m.id);
      ok('removing one is one entry too', markers().every((x) => !near(x.t, 7)));
      undo();
      ok('...and undo restores it, name and all',
        !!markers().find((x) => near(x.t, 7) && x.name === m.name));
      removeMarker(markers().find((x) => near(x.t, 7)).id);

      state.playhead = 3.5;
      ok('Shift-delete-at-the-playhead finds the one under it', removeMarkerAtPlayhead());
      ok('...and says so rather than throwing when there is none',
        (() => { state.playhead = 9.9; return removeMarkerAtPlayhead() === false; })());
      undo(); undo();
    }

    {
      const ser = JSON.parse(JSON.stringify(serialize()));
      ok('markers are written into the .scut', Array.isArray(ser.markers) && ser.markers.length >= 3,
        JSON.stringify(ser.markers.map((m) => m.name)));
      ok('...as plain JSON: an id, a time and a name, and nothing else',
        ser.markers.every((m) => Object.keys(m).sort().join(',') === 'id,name,t'),
        Object.keys(ser.markers[0]).sort().join(','));
      // A project saved before markers existed has no field at all, and must open.
      const old = Object.assign({}, ser);
      delete old.markers;
      ok('a project saved before markers existed reads as none rather than as undefined',
        normalizeMarkers(old.markers).length === 0);
    }

    // ============================================================ 4. the lane draws

    {
      state.pxPerSec = 60;
      renderRuler();
      const cv = document.querySelector('#ruler');
      ok('the ruler canvas is as tall as the layout constant says', cv.height === RULER_H,
        cv.height + ' vs ' + RULER_H);
      const g = cv.getContext('2d');
      const px = (x, y) => {
        const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return { r: d[0], g: d[1], b: d[2] };
      };
      const mk = markers()[0];
      const at = mk.t * state.pxPerSec;
      const flag = px(at + 3, MARK_LANE_Y + MARK_BAR_H / 2);
      // #7fd1ff: blue-dominant and bright. The lane's own background is #1d212a.
      ok('a pennant is painted in the lane at the marker\u2019s own column',
        flag.b > 180 && flag.b > flag.r + 40, JSON.stringify(flag));
      const empty = px(at + 120, MARK_LANE_Y + MARK_BAR_H / 2);
      ok('...and the lane is empty where there is no marker',
        !(empty.b > 180 && empty.b > empty.r + 40), JSON.stringify(empty));
      ok('the cache bar still has its strip underneath',
        MARK_LANE_Y + MARK_BAR_H + CACHE_BAR_H === RULER_H);
    }

    // ================================================= 5. the tracked CROP mode

    {
      markClean();
      newProject();
      const vt = state.tracks.find((t) => t.type === 'video');
      const id = nextId();
      // 16:9 source, framed to the project's 9:16 - the shape this whole mode is about.
      vt.clips.push({
        id, src: 'C:\\fake\\rec.mp4', name: 'rec', kind: 'video',
        start: 0, in: 0, out: 4, mediaDuration: 4, srcW: 1920, srcH: 1080, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      sortTracks();
      const clip = allClips().map((x) => x.clip).find((c) => c.id === id);

      const tk = Tracker.makeTrack(0, 0.5, 0.5, {});
      tk.id = 'tkC';
      Tracker.mergePoints(tk, [
        { t: 0, x: 0.5, y: 0.5, c: 1 },
        { t: 2, x: 0.8, y: 0.5, c: 1 },
        { t: 4, x: 0.98, y: 0.5, c: 1 },
      ]);
      clip.tracks = [tk];
      const mkFx = (mode) => [Object.assign(FX.create('transform'),
        { bind: { track: 'tkC', clip: undefined, offX: 0, offY: 0, strength: 1, smooth: 0, mode } })];

      // ---- the arithmetic, in source fractions
      clip.fx = mkFx('crop');
      const A = state.out.w / state.out.h;
      const cw = Math.min(1920, 1080 * A) / 1920;   // 0.3164 of the source's width
      const want = (p) => (p - 0.5 * cw) / (1 - cw);

      const p0 = trackCropPan(clip, 0);
      ok('a tracked point in the middle of the source leaves the pan in the middle',
        near(p0.panX, 0.5, 1e-6), p0.panX.toFixed(4));
      const p2 = trackCropPan(clip, 2);
      ok('...and a point three tenths to the right slides the crop exactly far enough to ' +
        'put it back in the centre', near(p2.panX, want(0.8), 1e-6),
        p2.panX.toFixed(4) + ' want ' + want(0.8).toFixed(4));
      ok('THE CLAMP: a point near the edge of the source stops the crop at the source\u2019s ' +
        'own edge rather than dragging it off - which is what makes a black edge unreachable',
        near(trackCropPan(clip, 4).panX, 1, 1e-9) && want(0.98) > 1,
        trackCropPan(clip, 4).panX + ' (unclamped would be ' + want(0.98).toFixed(3) + ')');
      ok('a 16:9 source in a 9:16 frame has no VERTICAL room, so the pan stays put there',
        near(p2.panY, 0.5, 1e-9), String(p2.panY));

      ok('the crop is what `trackFramed()` hands the draw, and it is a COPY - the clip on ' +
        'the timeline is never written',
        near(trackFramed(clip, 2).panX, p2.panX) && near(clip.panX, 0.5),
        trackFramed(clip, 2).panX.toFixed(4) + ' / clip still ' + clip.panX);

      // ---- what the mode does NOT do
      ok('the panel is told both position sliders are taken over by the binding',
        FX.boundParams('transform', 'crop').join() === 'x,y',
        FX.boundParams('transform', 'crop').join());
      const pc = FX.paramsAt(clip.fx[0], 2, clip, state.out.w, state.out.h);
      ok('...and the effect itself translates NOTHING, because the crop already moved',
        pc.x === 0 && pc.y === 0, pc.x + ',' + pc.y);
      ok('scale, rotation and opacity are still the author\u2019s',
        pc.scale === 1 && pc.rotate === 0 && pc.opacity === 1);

      // ---- and the two modes that are not it
      clip.fx = mkFx('camera');
      const pcam = FX.paramsAt(clip.fx[0], 2, clip, state.out.w, state.out.h);
      ok('camera mode still pushes the picture, which is what it is for',
        Math.abs(pcam.x) > 1e-3, pcam.x.toFixed(4));
      ok('...and in camera mode the crop does not move, or the two would fight',
        trackCropPan(clip, 2) === null);
      clip.fx = mkFx('move');
      ok('move mode leaves the crop alone too', trackCropPan(clip, 2) === null);

      // ---- a cross-clip crop binding has nothing to slide towards, and says so
      clip.fx = mkFx('crop');
      clip.fx[0].bind.clip = 'someOtherClip';
      ok('a crop binding to a track on ANOTHER clip degrades to the sliders: a point on ' +
        'another source is not a place on this one',
        trackCropPan(clip, 2) === null);
      clip.fx[0].bind.clip = undefined;

      // ---- THE HEADLINE, in pixels
      const W = 108, H = 192;
      const src = document.createElement('canvas');
      src.width = 1920; src.height = 1080;
      const sc = src.getContext('2d');
      sc.fillStyle = '#808080';
      sc.fillRect(0, 0, 1920, 1080);   // not one black or transparent pixel anywhere
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const oc = out.getContext('2d');

      const paintWith = (mode) => {
        clip.fx = mkFx(mode);
        oc.clearRect(0, 0, W, H);
        FX.render(oc, W, H, clip, 2, fxSurface,
          (tc, w, h) => drawClipTo(trackFramed(clip, 2), src, tc, w || W, h || H), 1 / 30);
        const d = oc.getImageData(0, 0, W, H).data;
        let clear = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) clear++;
        return clear;
      };

      const cropClear = paintWith('crop');
      const cropPan = trackCropPan(clip, 2).panX;   // read while `crop` is still the mode
      const camClear = paintWith('camera');
      ok('THE HEADLINE: a 16:9 clip framed to 9:16 and bound in CROP mode paints an ' +
        'opaque frame - there is no edge to let black in behind',
        cropClear === 0, cropClear + ' transparent pixels of ' + (W * H));
      ok('...while the same clip in CAMERA mode pushes its own edge into the frame and ' +
        'leaves the band that was the bug',
        camClear > W * H * 0.05, camClear + ' transparent pixels of ' + (W * H));
      note('the crop answered ' + cropPan.toFixed(3) +
        ' where the sliders say 0.5, so it did move - it just had somewhere to move to');
    }

    // ============================================== 6. the animate zoom direction

    {
      const clip = { id: 'cz', kind: 'video', in: 0, out: 2, start: 0,
        srcW: 1920, srcH: 1080, panX: 0.5, panY: 0.5, zoom: 1 };
      const W = 40, H = 40;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c2 = cv.getContext('2d');
      const plate = document.createElement('canvas');
      plate.width = W; plate.height = H;
      const pc2 = plate.getContext('2d');
      pc2.fillStyle = '#ffffff';
      pc2.fillRect(0, 0, W, H);

      // How much of the frame the picture covers at `t`, as a fraction. A scale below 1
      // leaves transparency; a scale above 1 covers everything.
      const coverAt = (fx, t) => {
        c2.clearRect(0, 0, W, H);
        FX.render(c2, W, H, Object.assign({}, clip, { fx: [fx] }), t, fxSurface,
          (tc, w, h) => tc.drawImage(plate, 0, 0, w || W, h || H), 1 / 30);
        const d = c2.getImageData(0, 0, W, H).data;
        let solid = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 250) solid++;
        return solid / (W * H);
      };

      const mk = (mode) => {
        const f = FX.create('animate');
        f.params.inType = 'zoom';
        f.params.inDur = 1;
        f.params.inEase = 'linear';
        f.params.inZoom = 0.5;
        f.params.inZoomMode = mode;
        f.params.outType = 'none';
        return f;
      };

      ok('the mode defaults to what the effect always did, so no saved project changes',
        FX.create('animate').params.inZoomMode === 'settle' &&
        FX.create('animate').params.outZoomMode === 'settle');

      const settle = mk('settle');
      ok('SETTLE is unchanged: the picture starts smaller than the frame, which is the ' +
        'background showing through and is right for a card',
        coverAt(settle, 0) < 0.4, coverAt(settle, 0).toFixed(3) + ' covered at t=0');
      ok('...and arrives at the full frame at the end of the phase',
        coverAt(settle, 1) > 0.999, coverAt(settle, 1).toFixed(3));

      const push = mk('push');
      ok('PUSH starts at the FULL FRAME - the thing that could not be asked for before, ' +
        'because the scale always ended at 1 whatever the amount was',
        coverAt(push, 0) > 0.999, coverAt(push, 0).toFixed(3) + ' covered at t=0');
      ok('...and covers it all the way through the phase',
        coverAt(push, 0.5) > 0.999 && coverAt(push, 1) > 0.999);
      // Covered is not the same as zoomed: the scale has to actually be growing.
      const sAt = (f, t) => FX.paramsAt(f, t, null, 1080, 1920) && (() => {
        // The scale is not a parameter of `animate` - it is computed in its draw - so it
        // is measured instead, by how far a known pixel has travelled from the centre.
        const probe = document.createElement('canvas');
        probe.width = 41; probe.height = 41;
        const q = probe.getContext('2d');
        q.clearRect(0, 0, 41, 41);
        FX.render(q, 41, 41, Object.assign({}, clip, { fx: [f] }), t, fxSurface,
          (tc) => { tc.fillStyle = '#fff'; tc.fillRect(20, 20, 1, 1); }, 1 / 30);
        const d = q.getImageData(0, 0, 41, 41).data;
        let minX = 99, maxX = -1;
        for (let y = 0; y < 41; y++) {
          for (let x = 0; x < 41; x++) {
            if (d[(y * 41 + x) * 4 + 3] > 20) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
          }
        }
        return maxX < 0 ? 0 : (maxX - minX + 1);
      })();
      ok('...and it is genuinely growing while it does: one source pixel covers more of ' +
        'the frame at the end of the push than at the start',
        sAt(push, 1) > sAt(push, 0), sAt(push, 0) + 'px -> ' + sAt(push, 1) + 'px');
      ok('THE HOLD: past the end of the phase it stays where it got to rather than ' +
        'snapping back, which falls out of the eased progress being pinned at 1',
        sAt(push, 1.9) === sAt(push, 1), sAt(push, 1) + ' -> ' + sAt(push, 1.9));

      // A project saved before the control existed.
      const old = { type: 'animate', params: { inType: 'zoom', inDur: 1, inEase: 'linear', inZoom: 0.5 } };
      FX.normalize(old);
      ok('an effect saved before the control existed fills in as SETTLE and paints what ' +
        'it always painted', old.params.inZoomMode === 'settle' &&
        Math.abs(coverAt(old, 0) - coverAt(settle, 0)) < 1e-9,
        old.params.inZoomMode);
    }

    // ============================================ 7. dragging a tracker marker

    {
      markClean();
      newProject();
      const vt = state.tracks.find((t) => t.type === 'video');
      const id = nextId();
      vt.clips.push({
        id, src: 'C:\\fake\\rec.mp4', name: 'rec', kind: 'video',
        start: 0, in: 0, out: 4, mediaDuration: 4, srcW: 1920, srcH: 1080, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      sortTracks();
      const clip = allClips().map((x) => x.clip).find((c) => c.id === id);
      // ONE sample: placed, not solved, so a drag re-anchors and starts no solve - which
      // is what lets this run with no decoder at all.
      const tk = Tracker.makeTrack(0, 0.5, 0.5, {});
      tk.id = 'tkD';
      clip.tracks = [tk];
      setSelection([id], false);
      state.playhead = 0;
      await sleep(30);

      const marks = trackMarkers();
      ok('the marker is on the viewer to be grabbed', marks.length === 1,
        marks.length + ' markers');

      const cv = document.querySelector('#preview');
      const r = cv.getBoundingClientRect();
      const toClient = (fx, fy) => ({ x: r.left + fx * r.width, y: r.top + fy * r.height });
      // Grabbed OFF-CENTRE, deliberately: the marker is catchable from several pixels
      // away and the whole question is what happens to those pixels.
      const offPx = 5;
      const grabAt = toClient(marks[0].x, marks[0].y);
      grabAt.x += offPx;

      const pd = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true,
      }));
      const md = (type, x, y) => cv.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      }));

      const panBefore = clip.panX;
      const undoBefore = undoStack.length;
      pd('pointerdown', grabAt.x, grabAt.y);
      // The browser fires the compatibility mouse event for a MOUSE pointer whatever the
      // pointer event did with it. That is the whole regression, so it is dispatched here
      // exactly as it arrives in the app.
      md('mousedown', grabAt.x, grabAt.y);
      ok('the press grabbed the marker', !!Trk.drag);
      ok('THE REGRESSION: it did NOT also start a framing drag',
        framingDrag === null, String(framingDrag));

      const dx = 40;
      pd('pointermove', grabAt.x + dx, grabAt.y);
      md('mousemove', grabAt.x + dx, grabAt.y);
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: grabAt.x + dx, clientY: grabAt.y,
      }));
      ok('...so moving the pointer does not slide the picture underneath it',
        clip.panX === panBefore, clip.panX + ' vs ' + panBefore);
      ok('...and takes no undo entry of its own on the way in',
        undoStack.length === undoBefore, (undoStack.length - undoBefore) + ' entries');

      // The grab offset: the marker travels BY the pointer's distance, not TO it.
      const wantX = marks[0].x + dx / r.width;
      ok('THE GRAB OFFSET IS KEPT: the marker moves by the distance the pointer moved ' +
        'rather than snatching itself under it',
        near(Trk.drag.x, wantX, 1e-3),
        Trk.drag.x.toFixed(4) + ' want ' + wantX.toFixed(4));
      ok('...and it remembers where it started, which is what the ghost ring is drawn at',
        near(Trk.drag.x0, marks[0].x, 1e-6) && Trk.drag.moved === true);

      // And the marker that is drawn is the one under the pointer.
      drawTrackOverlay(document.querySelector('#preview').getContext('2d'),
        previewSize().w, previewSize().h);
      ok('the overlay draws without throwing while a marker is held', true);

      pd('pointerup', grabAt.x + dx, grabAt.y);
      md('mouseup', grabAt.x + dx, grabAt.y);
      document.dispatchEvent(new MouseEvent('mouseup', {}));
      // The commit scores the dropped pixel first, and this clip's media is a fake path -
      // so it waits out `seekMedia()`'s 1.5 s "take whatever frame is there" timeout and
      // then places the drop unscored, which is the contract a dead decoder has to keep.
      await sleep(1900);
      ok('dropping it commits the move', Trk.drag === null && tk.anchor.x > 0.5,
        'anchor now ' + tk.anchor.x.toFixed(4));
      ok('...and the clip\u2019s framing came through the whole gesture untouched',
        clip.panX === panBefore, String(clip.panX));

      // A press that never moves is a press, not an edit.
      const depth = undoStack.length;
      const anchorWas = tk.anchor.x;
      const marks2 = trackMarkers();
      const at2 = toClient(marks2[0].x, marks2[0].y);
      pd('pointerdown', at2.x, at2.y);
      md('mousedown', at2.x, at2.y);
      pd('pointerup', at2.x, at2.y);
      md('mouseup', at2.x, at2.y);
      await sleep(30);
      ok('a click on a marker that never moved commits nothing and starts no solve',
        undoStack.length === depth && tk.anchor.x === anchorWas,
        (undoStack.length - depth) + ' entries');
    }

    note('no fixture: every clip here is synthetic and every frame is painted by the suite');

    // Notes are not assertions, so they count in neither half of the tally.
    const asserts = results.filter((x) => !x.startsWith('....'));
    const failed = asserts.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (asserts.length - failed) + '/' + asserts.length + ' passed';
  } catch (e) {
    return results.join('\n') + '\n\nERR ' + (e && e.stack ? e.stack : e);
  }
})()
