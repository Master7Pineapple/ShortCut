/**
 * Resolve Matte: mattes rendered from DaVinci Resolve's Magic Mask, imported and cut with.
 *
 *   SHORTCUT_SMOKE=tools/smoke-mask.js node_modules/.bin/electron .
 *
 * The pure half (run-length planes, frame lookup, plane sizing, the edge operations and
 * their order, the data model, the keys) needs nothing. The decode half needs two tiny
 * fixtures in %TEMP%\scut_test\ and SKIPS without them:
 *
 *   ffmpeg -y -f lavfi -i "color=c=white:s=320x180:r=30:d=2,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,(N+1)*5),255,0)'" \
 *          -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le matte_alpha.mov
 *   ffmpeg -y -f lavfi -i "color=c=black:s=320x180:r=30:d=2,format=gray,geq=lum='if(lt(X,160),255,0)'" \
 *          -c:v libx264 -pix_fmt yuv420p matte_luma.mp4
 *
 * `matte_alpha.mov` is what Resolve delivers with Export Alpha on: ProRes 4444 whose
 * alpha on frame N keeps the leftmost (N+1)*5 pixels, so a frame's coverage SAYS which
 * frame it is - the assertion that matte frame N lands on source frame N is exact.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const ALPHA = D + 'matte_alpha.mov';
    const LUMA = D + 'matte_luma.mp4';

    // ================================================== 1. run-length planes
    {
      const n = 320 * 180;
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = (i % 320) < 100 ? 255 : ((i % 320) < 103 ? 128 : 0);
      const enc = Matte.rleEncode(a);
      const dec = Matte.rleDecode(enc, n);
      ok('a plane survives the run-length round trip byte for byte',
        dec.every((v, i) => v === a[i]));
      ok('...and a matte-shaped plane encodes far smaller than it is raw',
        enc.length < n / 20, enc.length + ' bytes for ' + n);
      const flat = new Uint8Array(200000).fill(255);
      ok('a run longer than 65535 splits rather than wrapping its count',
        Matte.rleDecode(Matte.rleEncode(flat), flat.length).every((v) => v === 255));
    }

    // ================================================== 2. frame lookup and sizing
    {
      const m = { offset: 0 };
      ok('matte frame N is source frame N: t = N/fps finds N, and just before it finds N-1',
        Matte.frameIndex(m, 30, 60, 10 / 30) === 10 && Matte.frameIndex(m, 30, 60, 10 / 30 - 0.01) === 9);
      ok('outside the matte the nearest end is HELD, never -1',
        Matte.frameIndex(m, 30, 60, -1) === 0 && Matte.frameIndex(m, 30, 60, 99) === 59);
      ok('an offset slides the matte: offset 1 s puts frame 0 at source 1 s',
        Matte.frameIndex({ offset: 1 }, 30, 60, 1) === 0 && Matte.frameIndex({ offset: 1 }, 30, 60, 1.5) === 15);
      ok('no frames is -1, so the provider draws the clip unmasked',
        Matte.frameIndex(m, 30, 0, 0) === -1);
      const s1 = Matte.planeSize(3840, 2160, 960), s2 = Matte.planeSize(320, 180, 960);
      ok('a plane is scaled to its long side and never upscaled, with even sides',
        s1.w === 960 && s1.h === 540 && s2.w === 320 && s2.h === 180, s1.w + 'x' + s1.h);
    }

    // ================================================== 3. edge operations
    {
      const W = 100, H = 100;
      const sq = new Uint8Array(W * H);
      for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) sq[y * W + x] = 255;
      const cov = (p) => p.reduce((s, v) => s + v, 0) / 255;
      const base = cov(sq);
      ok('grow makes the matte bigger and choke makes it smaller',
        cov(Matte.edge(sq, W, H, { grow: 0.05 })) > base && cov(Matte.edge(sq, W, H, { grow: -0.05 })) < base);
      const fe = Matte.edge(sq, W, H, { feather: 0.03 });
      ok('feather softens the edge without moving the middle', fe[50 * W + 50] === 255 && fe[50 * W + 30] > 0 && fe[50 * W + 30] < 255);
      const chokeSoft = Matte.edge(sq, W, H, { grow: -0.05, feather: 0.03 });
      ok('grow runs BEFORE feather, so a choked matte still has a soft edge',
        chokeSoft.some((v) => v > 0 && v < 255));
      const iv = Matte.edge(sq, W, H, { invert: true });
      ok('invert flips which side survives', iv[50 * W + 50] === 0 && iv[5 * W + 5] === 255);
      ok('the unit rule: the same feather is the same fraction at twice the plane size',
        Matte.radiusPx(0.03, 100, 100) * 2 === Matte.radiusPx(0.03, 200, 200));
      ok('an edge pass never writes into the plane it was handed',
        (() => { const c = Uint8Array.from(sq); Matte.edge(c, W, H, { grow: 0.05, feather: 0.02 }); return c.every((v, i) => v === sq[i]); })());
    }

    // ================================================== 4. the data model and keys
    {
      const m = Matte.makeMask('Hero', 'C:\\m\\hero.mov');
      ok('a new matte is plain JSON with the defaults filled in',
        m.src === 'C:\\m\\hero.mov' && m.channel === 'auto' && m.res === Matte.DEFAULTS.res && m.offset === 0 &&
        JSON.stringify(JSON.parse(JSON.stringify(m))) === JSON.stringify(m));
      const legacy = { masks: [{ id: 'old', name: 'Mask 1', res: 1024, rate: 12, strokes: [{ t: 0, sign: 1, r: 0.03, pts: [0.1, 0.1] }] }] };
      Matte.normalizeClip(legacy);
      ok('a painted mask from the old Magic Mask build has no file, so it is dropped and ' +
        'the key goes with it', !('masks' in legacy));
      const bad = { masks: [{ src: 'x.mov', channel: 'rgb', res: 777, offset: 'nope' }] };
      Matte.normalizeClip(bad);
      ok('an out-of-band channel, resolution or offset is repaired to the default',
        bad.masks[0].channel === 'auto' && bad.masks[0].res === 960 && bad.masks[0].offset === 0 && !!bad.masks[0].id);
      const st = { size: 10, mtime: 5 };
      ok('the decode key changes with the file stamp, channel and detail - and not the offset',
        Matte.cacheKey('a', st, 'auto', 960) !== Matte.cacheKey('a', { size: 10, mtime: 6 }, 'auto', 960) &&
        Matte.cacheKey('a', st, 'auto', 960) !== Matte.cacheKey('a', st, 'luma', 960) &&
        Matte.cacheKey('a', st, 'auto', 960) !== Matte.cacheKey('a', st, 'auto', 480));
      ok('the render digest changes with the offset and with a re-exported file',
        Matte.digest(m, st) !== Matte.digest(Object.assign({}, m, { offset: 0.5 }), st) &&
        Matte.digest(m, st) !== Matte.digest(m, { size: 11, mtime: 5 }));
    }

    // ================================================== 5. the matte in the picture
    {
      const AW = 192, AH = 108, W1 = 108, H1 = 192, W2 = 216, H2 = 384;
      const mask = Matte.makeMask('Cut', 'C:\\fake\\cut.mov');
      const clip = {
        id: 'rmfake', kind: 'video', src: 'C:\\fake\\demo.mp4',
        start: 0, in: 0, out: 4, mediaDuration: 4, srcW: AW, srcH: AH,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, masks: [mask],
      };
      const f = FX.create('matte');
      f.params.mask = mask.id;
      f.params.feather = 0;
      clip.fx = [f];
      const plane = new Uint8Array(AW * AH);
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW / 2; x++) plane[y * AW + x] = 255;
      RM.stores.set(rmKey(mask), { status: 'ready', w: AW, h: AH, fps: 30, channel: 'alpha', stamp: { size: 1, mtime: 1 }, frames: [Matte.rleEncode(plane)] });
      const shot = (W, H) => {
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const c2 = cv.getContext('2d');
        RM.plate = null;
        FX.render(c2, W, H, clip, 0, fxSurface, (tc) => { tc.fillStyle = '#fff'; tc.fillRect(0, 0, W, H); }, 1 / 30);
        return c2.getImageData(0, 0, W, H).data;
      };
      const alphaAt = (d, W, H, fx, fy) => d[(Math.round(fy * (H - 1)) * W + Math.round(fx * (W - 1))) * 4 + 3];
      const a = shot(W1, H1), b = shot(W2, H2);
      ok('the matte CUTS: the kept side is opaque and the cut side is gone',
        alphaAt(a, W1, H1, 0.2, 0.5) > 240 && alphaAt(a, W1, H1, 0.8, 0.5) < 12,
        alphaAt(a, W1, H1, 0.2, 0.5) + ' / ' + alphaAt(a, W1, H1, 0.8, 0.5));
      ok('...and in the same place at double the resolution (preview = render)',
        Math.abs(alphaAt(a, W1, H1, 0.2, 0.5) - alphaAt(b, W2, H2, 0.2, 0.5)) <= 8 &&
        Math.abs(alphaAt(a, W1, H1, 0.8, 0.5) - alphaAt(b, W2, H2, 0.8, 0.5)) <= 8);
      f.params.invert = 1;
      const iv = shot(W1, H1);
      f.params.invert = 0;
      ok('invert flips which half survives', alphaAt(iv, W1, H1, 0.2, 0.5) < 12 && alphaAt(iv, W1, H1, 0.8, 0.5) > 240);
      f.params.mix = 0;
      const zero = shot(W1, H1);
      f.params.mix = 1;
      ok('Amount 0 is no matte at all, not a faded-out clip',
        alphaAt(zero, W1, H1, 0.2, 0.5) > 240 && alphaAt(zero, W1, H1, 0.8, 0.5) > 240);
      RM.stores.delete(rmKey(mask));
      const unloaded = shot(W1, H1);
      ok('a matte that has not loaded draws the clip UNMASKED rather than nothing',
        alphaAt(unloaded, W1, H1, 0.8, 0.5) > 240);
      RM.stores.delete(rmKey(mask));   // the provider kicked off a load of a fake path
      RM.plate = null;
    }

    // ================================================== 6. the timeline and the render key
    {
      const vt = state.tracks.find((t) => t.type === 'video');
      const id = nextId();
      vt.clips.push({
        id, src: 'C:\\fake\\demo.mp4', name: 'demo', kind: 'video',
        start: 2, in: 0, out: 2, mediaDuration: 2, srcW: 320, srcH: 180, fps: 30,
        panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      });
      sortTracks();
      const live = () => allClips().map((x) => x.clip).find((c) => c.id === id);
      setSelection([id], false);
      renderInspector();
      ok('a video clip gets the Resolve Matte panel with an import button',
        !!document.querySelector('#inspector .mm-box') &&
        [...document.querySelectorAll('#inspector .mm-box button')].some((b) => /Import matte/.test(b.textContent)));
      ok('`matte` is offered in the stack menu but DISABLED until a matte is imported',
        (() => {
          const o = [...document.querySelectorAll('#inspector .fx-add select option')].find((x) => x.value === 'matte');
          return !!o && o.disabled && /imported matte/.test(o.textContent);
        })());

      const haveFixtures = !!(await window.api.matteProbe(ALPHA)).ok;
      if (!haveFixtures) {
        note('SKIPPED the decode half: no ' + ALPHA + ' (see the header for the ffmpeg commands)');
      } else {
        const info = await window.api.matteProbe(ALPHA);
        ok('ProRes 4444 is probed as carrying alpha', info.hasAlpha && info.fps === 30, info.pixFmt);
        const linfo = await window.api.matteProbe(LUMA);
        ok('an H.264 black-and-white matte is probed as having none', linfo.ok && !linfo.hasAlpha, linfo.pixFmt);
        const refused = await window.api.matteDecode({ src: LUMA, channel: 'alpha', res: 960 });
        ok('asking for alpha from a file without it is a refusal with a reason, not garbage',
          !refused.ok && /alpha/i.test(refused.error));
        const missing = await window.api.matteDecode({ src: D + 'nope.mov', channel: 'auto', res: 960 });
        ok('a missing file is a value, not an exception', missing && missing.ok === false);

        const undo0 = undoStack.length;
        const m = await rmAttach(live(), ALPHA);
        ok('importing a matte is ONE undo entry and puts a `matte` effect on the clip pointed at it',
          undoStack.length === undo0 + 1 && live().fx.length === 1 && live().fx[0].type === 'matte' && live().fx[0].params.mask === m.id);
        const store = rmStore(m);
        ok('the decode reads the alpha channel: 60 frames at 30 fps, 320x180',
          store && store.status === 'ready' && store.frames.length === 60 && store.fps === 30 &&
          store.channel === 'alpha' && store.w === 320 && store.h === 180,
          store && (store.status + ' ' + (store.error || (store.frames.length + ' @ ' + store.fps))));
        const coverage = (idx) => {
          const p = Matte.rleDecode(store.frames[idx], store.w * store.h);
          let k = 0;
          for (let x = 0; x < store.w; x++) if (p[90 * store.w + x] > 127) k++;
          return k;
        };
        ok('frame N of the matte is frame N of the file: frame 0 keeps 5 px, frame 30 keeps 155',
          Math.abs(coverage(0) - 5) <= 1 && Math.abs(coverage(30) - 155) <= 1, coverage(0) + ', ' + coverage(30));
        ok('the plane is transparency-shaped: 0 outside and 255 inside, not studio-range grey',
          (() => { const p = Matte.rleDecode(store.frames[59], store.w * store.h); return p[90 * store.w + 2] === 255 && p[90 * store.w + 318] === 0; })());
        ok('a matte that matches its clip raises no warnings', rmWarnings(live(), m, store).length === 0,
          rmWarnings(live(), m, store).join(' | '));
        ok('...and a frame-rate mismatch does',
          rmWarnings(Object.assign({}, live(), { fps: 25 }), m, store).some((w) => /Frame rate/.test(w)));

        const again = await window.api.matteDecode({ src: ALPHA, channel: m.channel, res: m.res });
        ok('a second decode comes back from the disk cache, identical', again.ok && again.cached &&
          again.frames.length === 60 && again.frames[30].length === store.frames[30].length);

        // Through the real provider at the source time the clip is at.
        const sampleAt = (tLocal) => {
          const W = 320, H = 180;
          const c = live();
          const saved = { zoom: c.zoom };
          const cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          const c2 = cv.getContext('2d');
          RM.plate = null;
          const plate = rmPlate(c, m, (c.in || 0) + tLocal, W, H, { feather: 0, grow: 0, invert: 0, mix: 1 });
          Object.assign(c, saved);
          if (!plate) return -1;
          c2.drawImage(plate, 0, 0);
          const d = c2.getImageData(0, 90, W, 1).data;
          let k = 0;
          for (let x = 0; x < W; x++) if (d[x * 4 + 3] > 127) k++;
          return k;
        };
        note('plate coverage is read through the clip\u2019s 9:16 crop, so it is compared between trims rather than to a pixel count');
        const before = sampleAt(1.0);
        live().in = 0.5; live().out = 2;
        const after = sampleAt(0.5);
        live().in = 0; live().out = 2;
        ok('TRIMMING keeps the matte on the picture: source 1.0 s is the same matte whether ' +
          'the clip starts at 0 or is trimmed by half a second', before >= 0 && before === after, before + ' vs ' + after);

        const digestOf = () => {
          const job = buildJob('');
          const mine = job.clips.find((x) => x.id === id);
          return JSON.stringify(mine && mine.masks !== undefined ? mine.masks : null);
        };
        const withFx = digestOf();
        ok('the `matte` effect puts the matte into the render key', withFx !== 'null');
        live().start = 5.5; sortTracks();
        const moved = digestOf();
        live().start = 2; sortTracks();
        ok('MOVING the clip does not change the key', moved === withFx);
        live().masks[0].offset = 0.25;
        const slid = digestOf();
        live().masks[0].offset = 0;
        ok('...sliding the offset does', slid !== withFx);
        live().fx[0].enabled = false;
        const bypassed = digestOf();
        live().fx[0].enabled = true;
        ok('a BYPASSED matte keys as no matte at all', bypassed === 'null');

        const lm = await rmAttach(live(), LUMA);
        const ls = rmStore(lm);
        ok('a black-and-white H.264 matte imports on Auto and is read from its luma, full range',
          ls && ls.status === 'ready' && ls.channel === 'luma' &&
          (() => { const p = Matte.rleDecode(ls.frames[10], ls.w * ls.h); return p[90 * ls.w + 20] >= 250 && p[90 * ls.w + 300] <= 5; })(),
          ls && (ls.status + ' ' + (ls.error || ls.channel)));
        ok('importing a second matte does not stack a second `matte` effect', live().fx.length === 1);

        const saved = JSON.parse(JSON.stringify(live()));
        ok('the clip saves as plain JSON: paths and settings only, no pixels',
          JSON.stringify(saved.masks).length < 600 && saved.masks.length === 2);
        undo();
        undo();
        ok('undo takes both imports back off the clip', !('masks' in live()) && !(live().fx || []).length);
      }

      vt.clips.splice(vt.clips.findIndex((x) => x.id === id), 1);
      state.selection.clear();
      renderAll();
    }

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
