/**
 * The finishing pass - LUTs, bloom, grain, and the project master finish.
 *
 *   SHORTCUT_SMOKE=tools/smoke-finish.js node_modules/.bin/electron .
 *
 * Four things this exists to prove, and they are the four the step asked for:
 *
 *   - the .cube parser and the trilinear sampler agree with values computed BY HAND. A
 *     LUT is the one effect here whose correctness is not visible: a cube with red and
 *     blue transposed looks like a grade, not like a bug, so the maths is asserted
 *     against arithmetic rather than against a screenshot;
 *   - GRAIN IS REPRODUCIBLE - the same seed gives the same texture twice in a row and the
 *     same texture at two resolutions. This is the trap the step named, and the one the
 *     film burn's streaks already learned: the preview and the export build the texture
 *     independently, so `Math.random()` would put grain in the file that was never on
 *     screen and no comparison would ever catch it;
 *   - a neutral LUT with no grain is a PIXEL-EXACT no-op. Not "close" - exact. That is
 *     what makes the finishing pass safe to leave on a stack;
 *   - the master finish reaches the picture the same way in the viewer and in the baker,
 *     which is the preview/render agreement rule applied to a pass that has no clip.
 *
 * Nothing here needs media: `FX.render()` and `FX.renderMaster()` are pure canvas
 * functions. The last block builds a two-clip timeline in memory to check the fast-path
 * disqualifier and the render key, and decodes nothing either.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    const pool = new Map();
    const surface = (name, w, h) => {
      let cv = pool.get(name);
      if (!cv) { cv = document.createElement('canvas'); pool.set(name, cv); }
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      return cv;
    };
    const fx = (type, params) => {
      const e = FX.create(type);
      Object.assign(e.params, params || {});
      return e;
    };
    /** Paint `paint` through a stack at W x H and hand back a pixel reader. */
    function run(stack, W, H, paint, t) {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.clearRect(0, 0, W, H);
      FX.render(c, W, H, { id: 'k', fx: stack }, t || 0, surface, paint);
      const px = (x, y) => {
        const d = c.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      return { cv, ctx: c, px, data: () => c.getImageData(0, 0, W, H).data };
    }
    const flat = (colour) => (c, W, H) => { c.fillStyle = colour; c.fillRect(0, 0, W, H); };

    // ================================================== 1. the .cube parser
    //
    // A 2-point cube is the smallest legal one and the most useful to assert against:
    // every entry is a corner, so a sample anywhere inside it is pure trilinear
    // interpolation with nothing else going on.

    const idCube = [
      '# a comment', '', 'TITLE "identity"', 'LUT_3D_SIZE 2',
      '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
      '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0',
    ].join('\n');
    const idp = FX.parseCube(idCube);
    ok('a .cube parses', idp.ok && idp.lut.n === 2, idp.error || '');
    ok('the title comes with it', idp.ok && idp.lut.title === 'identity', idp.ok ? idp.lut.title : '');
    ok('an identity cube is recognised as one', FX.isIdentityLUT(idp.lut));

    // RED IS THE FASTEST AXIS. This is the classic .cube mistake and it does not look
    // like an error - it looks like a grade with two channels swapped. The second row of
    // the file is therefore r=1,g=0,b=0, and asserting that is asserting the indexing.
    const swap = [
      'LUT_3D_SIZE 2',
      '0 0 0', '0 0 1', '0 0 0', '0 0 1',
      '0 0 0', '0 0 1', '0 0 0', '0 0 1',
    ].join('\n');
    const sw = FX.parseCube(swap);
    ok('the second row is the RED axis - red fastest, not blue',
      sw.ok && FX.sampleLUT(sw.lut, 1, 0, 0)[2] === 1 && FX.sampleLUT(sw.lut, 0, 0, 1)[2] === 0,
      sw.ok ? 'r=1 -> ' + FX.sampleLUT(sw.lut, 1, 0, 0).join(',') : sw.error);

    ok('a 1D LUT is refused rather than half-applied',
      !FX.parseCube('LUT_1D_SIZE 4\n0 0 0\n0.3 0.3 0.3\n0.6 0.6 0.6\n1 1 1').ok);
    ok('a cube short of rows is refused with a reason',
      !FX.parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1').ok,
      FX.parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1').error || '');
    ok('a file with no LUT_3D_SIZE is refused', !FX.parseCube('hello\nworld').ok);

    // ================================================== 2. trilinear, by hand
    //
    // A 2-point cube that maps red to (1 - r) and leaves green and blue alone. Every
    // sample inside it is then a straight line, so the expected value is arithmetic.

    const invR = [
      'LUT_3D_SIZE 2',
      '1 0 0', '0 0 0', '1 1 0', '0 1 0',
      '1 0 1', '0 0 1', '1 1 1', '0 1 1',
    ].join('\n');
    const ir = FX.parseCube(invR).lut;
    ok('trilinear at a grid point is the grid value',
      FX.sampleLUT(ir, 0, 0, 0)[0] === 1 && FX.sampleLUT(ir, 1, 0, 0)[0] === 0);
    const mid = FX.sampleLUT(ir, 0.25, 0.5, 0.75);
    ok('trilinear halfway along red is halfway between the corners',
      near(mid[0], 0.75, 1e-6), 'got ' + mid[0].toFixed(6) + ' want 0.75');
    ok('the untouched axes come back untouched',
      near(mid[1], 0.5, 1e-6) && near(mid[2], 0.75, 1e-6), mid.join(','));

    // A 3-point cube with a curve on it: the 0.25 sample sits between grid 0 (0.0) and
    // grid 1 (0.8), so 0.25 of the way to 0.8 is 0.2 - hand-computed, not measured.
    const curve = (() => {
      const rows = ['LUT_3D_SIZE 3'];
      const v = [0, 0.8, 1];
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        rows.push(v[i] + ' ' + v[j] + ' ' + v[k]);
      }
      return FX.parseCube(rows.join('\n')).lut;
    })();
    ok('trilinear against a hand-computed curve: 0.25 -> 0.4',
      near(FX.sampleLUT(curve, 0.25, 0, 0)[0], 0.4, 1e-6),
      'got ' + FX.sampleLUT(curve, 0.25, 0, 0)[0].toFixed(6));
    ok('and 0.75 -> 0.9',
      near(FX.sampleLUT(curve, 0.75, 0, 0)[0], 0.9, 1e-6),
      'got ' + FX.sampleLUT(curve, 0.75, 0, 0)[0].toFixed(6));

    // DOMAIN_MIN/MAX. A half-domain cube reads 0.5 as its top, so everything above it
    // clamps - which is the only thing a domain can mean.
    const halfDom = FX.parseCube([
      'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 0.5 0.5 0.5',
      '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1',
    ].join('\n')).lut;
    ok('DOMAIN_MAX rescales the input axis',
      near(FX.sampleLUT(halfDom, 0.25, 0, 0)[0], 0.5, 1e-6) &&
      near(FX.sampleLUT(halfDom, 0.9, 0, 0)[0], 1, 1e-6),
      FX.sampleLUT(halfDom, 0.25, 0, 0)[0].toFixed(3));

    // ================================================== 3. the pixel-exact no-op
    //
    // Every byte, not a sample: a LUT that shifts one channel by one level on some
    // colours and not others would pass a spot check and fail this.

    FX.putLut('TEST://identity', idCube, { size: idCube.length, mtime: 1 });
    FX.putLut('TEST://invert-red', invR, { size: invR.length, mtime: 2 });
    FX.putLut('TEST://curve', 'LUT_3D_SIZE 2\n0 0 0\n0.5 0 0\n0 1 0\n0.5 1 0\n0 0 1\n0.5 0 1\n0 1 1\n0.5 1 1', { size: 1, mtime: 3 });

    const ramp = (c, W, H) => {
      // Every level appears, so the no-op assertion covers the whole range rather than
      // one colour: 256 vertical bands of a grey-to-colour ramp.
      for (let x = 0; x < W; x++) {
        const v = Math.round(x / Math.max(1, W - 1) * 255);
        c.fillStyle = 'rgb(' + v + ',' + (255 - v) + ',' + ((v * 3) % 256) + ')';
        c.fillRect(x, 0, 1, H);
      }
    };
    const bare = run([], 256, 32, ramp).data();
    const noop = run([fx('lut', { lut: 'TEST://identity', amount: 1 }), fx('grain', { amount: 0 })],
      256, 32, ramp).data();
    let diffs = 0, worst = 0;
    for (let i = 0; i < bare.length; i++) {
      const d = Math.abs(bare[i] - noop[i]);
      if (d) { diffs++; worst = Math.max(worst, d); }
    }
    ok('THE HEADLINE: an identity LUT with zero grain is a pixel-exact no-op',
      diffs === 0, diffs + ' bytes differ, worst ' + worst);

    const off = run([fx('lut', { lut: 'TEST://invert-red', amount: 0 })], 256, 32, ramp).data();
    let d0 = 0;
    for (let i = 0; i < bare.length; i++) if (bare[i] !== off[i]) d0++;
    ok('a LUT at amount 0 is a no-op too', d0 === 0, d0 + ' bytes differ');

    const applied = run([fx('lut', { lut: 'TEST://invert-red', amount: 1 })], 8, 8, flat('#40c0ff'));
    ok('a LUT that inverts red inverts red', applied.px(4, 4)[0] === 255 - 0x40,
      applied.px(4, 4).join(','));
    ok('at amount 0.5 it lands halfway',
      near(applied.px(4, 4)[0], 255 - 0x40, 1) &&
      near(run([fx('lut', { lut: 'TEST://invert-red', amount: 0.5 })], 8, 8, flat('#40c0ff')).px(4, 4)[0],
        (0x40 + (255 - 0x40)) / 2, 1),
      run([fx('lut', { lut: 'TEST://invert-red', amount: 0.5 })], 8, 8, flat('#40c0ff')).px(4, 4).join(','));
    ok('a path that never loaded draws the clip untouched, not black',
      run([fx('lut', { lut: 'TEST://not-a-file', amount: 1 })], 8, 8, flat('#40c0ff')).px(4, 4)[0] === 0x40);
    ok('a LUT leaves alpha alone',
      run([fx('lut', { lut: 'TEST://invert-red' })], 8, 8, (c, W, H) => {
        c.globalAlpha = 0.5; c.fillStyle = '#40c0ff'; c.fillRect(0, 0, W, H);
      }).px(4, 4)[3] === 128);

    // ================================================== 4. grain, reproducibly
    //
    // The trap the step named. Two runs and two resolutions, sampled at the same
    // NORMALISED positions - the map is built at a fixed 256 px and scaled, so the same
    // fraction of the frame is the same speck at both sizes.

    const g1 = FX.grainMap(7), g2 = FX.grainMap(7), g3 = FX.grainMap(8);
    const mapPx = (cv) => {
      const c = cv.getContext('2d');
      return c.getImageData(0, 0, cv.width, cv.height).data;
    };
    ok('the same seed hands back the same map object', g1 === g2);
    const m7 = mapPx(g1), m8 = mapPx(g3);
    let same = true;
    for (let i = 0; i < 4096; i += 4) if (m7[i] !== m8[i]) { same = false; break; }
    ok('a different seed is a different map', !same);
    ok('the map is a fixed 256 px at every resolution',
      g1.width === FX.GRAIN_SIZE && g1.height === FX.GRAIN_SIZE, g1.width + 'x' + g1.height);
    ok('mulberry32 is a pure function of its seed',
      FX.mulberry32(42)() === FX.mulberry32(42)() && FX.mulberry32(42)() !== FX.mulberry32(43)());

    const grainStack = () => [fx('grain', { amount: 0.6, scale: 1, seed: 5 })];
    const sampleAt = (r, W, H, u, v) => r.px(Math.round(u * (W - 1)), Math.round(v * (H - 1)));
    const gA = run(grainStack(), 135, 240, flat('#808080'));
    const gB = run(grainStack(), 135, 240, flat('#808080'));
    let runDiff = 0;
    const dA = gA.data(), dB = gB.data();
    for (let i = 0; i < dA.length; i++) if (dA[i] !== dB[i]) runDiff++;
    ok('THE OTHER HEADLINE: two runs of the same seed are byte-identical',
      runDiff === 0, runDiff + ' bytes differ');

    // ACROSS TWO RESOLUTIONS, and what that can honestly mean.
    //
    // Not byte-identical: the map is 256 px, so a 256-wide frame samples one speck per
    // pixel and a 768-wide frame interpolates three pixels out of each one. Comparing
    // those pixel for pixel would be comparing an average against an interpolation and
    // would fail for a texture that is provably the same.
    //
    // What IS the same is the texture and where it sits, so both frames are reduced to a
    // common 128 px grid - which averages the sampling difference away - and compared
    // there. `Math.random()` would not survive this: two independent noise fields have
    // uncorrelated local means, and the block below measures those means.
    const shrink = (cv, W, H) => {
      const s = document.createElement('canvas');
      s.width = W; s.height = H;
      const c = s.getContext('2d');
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      c.drawImage(cv, 0, 0, W, H);
      return c.getImageData(0, 0, W, H).data;
    };
    const gLo = run(grainStack(), 256, 448, flat('#808080'));
    const gHi = run(grainStack(), 768, 1344, flat('#808080'));
    const sLo = shrink(gLo.cv, 128, 224), sHi = shrink(gHi.cv, 128, 224);
    let sum = 0, mx = 0, n = 0;
    for (let i = 0; i < sLo.length; i += 4) {
      const d = Math.abs(sLo[i] - sHi[i]);
      sum += d; mx = Math.max(mx, d); n++;
    }
    ok('the same seed is the same texture at 256x448 and at 768x1344',
      sum / n <= 4 && mx <= 24,
      'mean ' + (sum / n).toFixed(2) + ' worst ' + mx + ' levels over ' + n + ' cells');

    // And the control: a different seed is a different texture at the same test, so the
    // assertion above is measuring something rather than measuring nothing.
    const gSeed = run([fx('grain', { amount: 0.6, scale: 1, seed: 6 })], 768, 1344, flat('#808080'));
    const sSeed = shrink(gSeed.cv, 128, 224);
    let sum2 = 0;
    for (let i = 0; i < sLo.length; i += 4) sum2 += Math.abs(sLo[i] - sSeed[i]);
    ok('a different seed fails that same test - so it is measuring the texture',
      sum2 / n > 4 * 1.5, 'mean ' + (sum2 / n).toFixed(2) + ' levels apart');

    const noGrain = run([fx('grain', { amount: 0 })], 32, 32, flat('#808080'));
    ok('zero grain changes nothing', noGrain.px(16, 16)[0] === 0x80, noGrain.px(16, 16).join(','));
    const someGrain = run([fx('grain', { amount: 0.8, seed: 3 })], 64, 64, flat('#808080'));
    let varied = false;
    for (let x = 0; x < 64 && !varied; x += 3) if (someGrain.px(x, 32)[0] !== 0x80) varied = true;
    ok('grain at 0.8 actually disturbs a flat grey', varied);
    ok('grain does not fill the transparency around a clip with grey',
      run([fx('grain', { amount: 0.9, seed: 3 })], 64, 64,
        (c, W, H) => { c.fillStyle = '#808080'; c.fillRect(0, 0, W / 2, H); }).px(56, 32)[3] === 0,
      'alpha ' + run([fx('grain', { amount: 0.9 })], 64, 64,
        (c, W, H) => { c.fillStyle = '#808080'; c.fillRect(0, 0, W / 2, H); }).px(56, 32)[3]);

    // ================================================== 5. bloom
    const dot = (c, W, H) => {
      c.fillStyle = '#101010';
      c.fillRect(0, 0, W, H);
      c.fillStyle = '#ffffff';
      c.fillRect(W / 2 - W / 16, H / 2 - H / 16, W / 8, H / 8);
    };
    const noBloom = run([], 128, 128, dot);
    const bloomed = run([fx('bloom', { threshold: 0.6, intensity: 1.2, radius: 0.08 })], 128, 128, dot);
    const away = [40, 64];
    ok('bloom lifts the dark ground near a highlight',
      bloomed.px(away[0], away[1])[0] > noBloom.px(away[0], away[1])[0] + 3,
      noBloom.px(away[0], away[1])[0] + ' -> ' + bloomed.px(away[0], away[1])[0]);
    const far = run([fx('bloom', { threshold: 0.6, intensity: 1.2, radius: 0.02 })], 128, 128, dot);
    ok('a smaller radius reaches less far',
      far.px(away[0], away[1])[0] <= bloomed.px(away[0], away[1])[0],
      far.px(away[0], away[1])[0] + ' <= ' + bloomed.px(away[0], away[1])[0]);
    ok('bloom below the threshold does nothing',
      run([fx('bloom', { threshold: 0.99, intensity: 1 })], 64, 64, flat('#303030')).px(32, 32)[0] === 0x30);
    ok('zero intensity is a no-op',
      run([fx('bloom', { intensity: 0 })], 64, 64, flat('#c0c0c0')).px(32, 32)[0] === 0xc0);
    ok('bloom does not spill onto the transparency around a clip',
      run([fx('bloom', { threshold: 0.3, intensity: 2, radius: 0.15 })], 64, 64,
        (c, W, H) => { c.fillStyle = '#ffffff'; c.fillRect(0, 0, W / 4, H); }).px(60, 32)[3] === 0);

    // Scale invariance: the same bloom at two resolutions must be the same picture, which
    // is what the fixed-size plate buys. Sampled at matching normalised positions.
    const bl1 = run([fx('bloom', { threshold: 0.6, intensity: 1, radius: 0.06 })], 128, 128, dot);
    const bl2 = run([fx('bloom', { threshold: 0.6, intensity: 1, radius: 0.06 })], 512, 512, dot);
    let bMax = 0;
    for (let i = 1; i < 8; i++) {
      const a = sampleAt(bl1, 128, 128, i / 8, 0.5)[0];
      const b = sampleAt(bl2, 512, 512, i / 8, 0.5)[0];
      bMax = Math.max(bMax, Math.abs(a - b));
    }
    ok('bloom is the same shape at 128 px and at 512 px', bMax <= 10, 'worst ' + bMax + ' levels');

    // ================================================== 6. order, keys, bypass
    // A LUT that LIFTS red rather than scaling it: a cube that multiplies would commute
    // with a gain and the assertion would pass by arithmetic accident rather than by the
    // stack being honoured. The first version of this test did exactly that - both orders
    // measured 67 - which is worth leaving a note about, because a test that cannot fail
    // is worse than no test.
    FX.putLut('TEST://lift-red',
      'LUT_3D_SIZE 2\n0.3 0 0\n1 0 0\n0.3 1 0\n1 1 0\n0.3 0 1\n1 0 1\n0.3 1 1\n1 1 1', { size: 2, mtime: 4 });
    const gradeThenLut = run([fx('grade', { gain: 1.4 }), fx('lut', { lut: 'TEST://lift-red' })], 8, 8, flat('#606060'));
    const lutThenGrade = run([fx('lut', { lut: 'TEST://lift-red' }), fx('grade', { gain: 1.4 })], 8, 8, flat('#606060'));
    ok('stack order matters here too - a LUT before a grade is not a LUT after one',
      gradeThenLut.px(4, 4)[0] !== lutThenGrade.px(4, 4)[0],
      gradeThenLut.px(4, 4)[0] + ' vs ' + lutThenGrade.px(4, 4)[0]);

    const keyed = FX.create('lut');
    keyed.params.lut = 'TEST://invert-red';
    keyed.params.amount = 0;
    keyed.keys = { amount: [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 1, ease: 'linear' }] };
    const kA = run([keyed], 8, 8, flat('#40c0ff'), 0).px(4, 4)[0];
    const kB = run([keyed], 8, 8, flat('#40c0ff'), 1).px(4, 4)[0];
    ok('every parameter keyframes through Anim, LUT amount included',
      kA === 0x40 && kB === 255 - 0x40, kA + ' -> ' + kB);

    const bypassed = Object.assign(fx('grain', { amount: 0.9 }), { enabled: false });
    ok('a bypassed finishing effect is no effect',
      run([bypassed], 32, 32, flat('#808080')).px(16, 16)[0] === 0x80);

    // ================================================== 7. matching two clips
    //
    // Pure arithmetic, so it is asserted as arithmetic: the solved grade, pushed back
    // through the same curve `gradeLUT()` applies, must land the three points on the
    // reference's three points.

    const src = { black: 0.12, mid: 0.38, white: 0.74 };
    const ref = { black: 0.02, mid: 0.5, white: 0.96 };
    const g = FX.matchGrade(src, ref);
    const through = (v) => {
      const lut = FX.gradeLUT(Object.assign({}, FX.GRADE_NEUTRAL, g));
      return lut[1][Math.max(0, Math.min(255, Math.round(v * 255)))] / 255;
    };
    ok('match carries the black point onto the reference black', near(through(src.black), ref.black, 0.01),
      through(src.black).toFixed(3) + ' want ' + ref.black);
    ok('match carries the white point onto the reference white', near(through(src.white), ref.white, 0.01),
      through(src.white).toFixed(3) + ' want ' + ref.white);
    ok('and spends gamma on mid-grey', near(through(src.mid), ref.mid, 0.02),
      through(src.mid).toFixed(3) + ' want ' + ref.mid);
    ok('matching a clip to itself is the neutral grade',
      FX.isNeutralGrade(FX.matchGrade(src, src)) ||
      (near(FX.matchGrade(src, src).gain, 1, 0.005) && near(FX.matchGrade(src, src).lift, 0, 0.005) &&
        near(FX.matchGrade(src, src).gamma, 1, 0.01)),
      JSON.stringify(FX.matchGrade(src, src)));
    ok('a flat frame answers neutral rather than an infinity',
      FX.isNeutralGrade(FX.matchGrade({ black: 0.5, mid: 0.5, white: 0.5 }, ref)));

    const statData = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < 100; i++) {
      const v = i < 50 ? 0 : 255;
      statData[i * 4] = statData[i * 4 + 1] = statData[i * 4 + 2] = v;
      statData[i * 4 + 3] = 255;
    }
    const st = FX.lumaStats(statData);
    ok('lumaStats reads a half-black half-white frame as 0 and 1',
      st && st.black === 0 && st.white === 1, st ? st.black + '/' + st.white : 'null');
    ok('transparent pixels are not measured',
      FX.lumaStats(new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255])).black === 1);

    // ================================================== 8. the master finish
    //
    // `renderMaster()` is the master grade in full: FX.render() over a copy of the
    // finished frame. So the assertion that matters is that it is the SAME function - a
    // stack applied to a clip and the same stack applied as the master must agree.

    const asClip = run([fx('lut', { lut: 'TEST://invert-red' }), fx('grade', { gain: 1.2 })],
      64, 64, flat('#4080c0'));
    const masterCv = document.createElement('canvas');
    masterCv.width = masterCv.height = 64;
    const mctx = masterCv.getContext('2d');
    mctx.fillStyle = '#4080c0';
    mctx.fillRect(0, 0, 64, 64);
    const drew = FX.renderMaster(mctx, 64, 64,
      [fx('lut', { lut: 'TEST://invert-red' }), fx('grade', { gain: 1.2 })], 0, surface, 1 / 30);
    const mpx = Array.from(mctx.getImageData(32, 32, 1, 1).data);
    ok('the master finish draws', drew);
    ok('THE THIRD HEADLINE: the same stack as a clip effect and as the master finish agree',
      mpx.join(',') === asClip.px(32, 32).join(','), mpx.join(',') + ' vs ' + asClip.px(32, 32).join(','));
    ok('an empty master stack draws nothing and says so',
      FX.renderMaster(mctx, 64, 64, [], 0, surface) === false);
    ok('a stack of bypassed effects is also nothing',
      FX.renderMaster(mctx, 64, 64, [Object.assign(fx('grain'), { enabled: false })], 0, surface) === false);

    ok('the master stack refuses a type that needs a clip',
      FX.normalizeStack([{ type: 'matte' }, { type: 'cursor' }, { type: 'grade' }]).length === 1);
    ok('masterActive() sees a real entry and ignores a bypassed one',
      FX.masterActive([fx('grain')]) &&
      !FX.masterActive([Object.assign(fx('grain'), { enabled: false })]) &&
      !FX.masterActive([]));
    // The mutation rule: this is asked on every frame by needsCompositeAt(), so it must
    // not be the function that fills a project's defaults in.
    const probe = { type: 'grain' };
    FX.masterActive([probe]);
    ok('masterActive() does not write defaults into the project', !probe.params);

    // ================================================== 9. the fast path and the key
    //
    // A master finish has no ffmpeg half, so a span ffmpeg built would export ungraded
    // while the viewer showed it graded. Every covered span must therefore bake.

    if (typeof state !== 'undefined' && typeof buildJob === 'function') {
      const snapshot = JSON.stringify(state.tracks);
      const snapMaster = JSON.stringify(state.master);
      newProject();
      const vt = state.tracks.find((t) => t.type === 'video');
      vt.clips.push({
        id: 'finishA', kind: 'video', src: 'C:\\nope\\a.mp4', start: 0, in: 0, out: 2,
        mediaDuration: 8, panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
      });
      vt.clips.push({
        id: 'finishB', kind: 'video', src: 'C:\\nope\\b.mp4', start: 2, in: 0, out: 2,
        mediaDuration: 8, panX: 0.5, panY: 0.5, zoom: 1, volume: 1,
      });
      state.master = [];
      ok('two plain cuts and no master finish: nothing to bake',
        compositeSpans(buildJob('C:\nope\out.mp4', { from: 0, to: 4 })).length === 0);
      const keyPlain = jobCacheKey(buildJob('C:\\nope\\out.mp4', { from: 0, to: 4 }));

      state.master = [fx('grain', { amount: 0.3, seed: 2 })];
      const spans = compositeSpans(buildJob('C:\nope\out.mp4', { from: 0, to: 4 }));
      const covered = spans.reduce((n, s) => n + (s.to - s.from), 0);
      ok('THE FOURTH HEADLINE: a master finish takes every covered span off the fast path',
        near(covered, 4, 0.01), covered.toFixed(2) + 's of 4s baked in ' + spans.length + ' span(s)');

      const keyGrain = jobCacheKey(buildJob('C:\\nope\\out.mp4', { from: 0, to: 4 }));
      ok('the master finish is in the render key', keyGrain !== keyPlain, keyPlain + ' -> ' + keyGrain);
      state.master = [fx('grain', { amount: 0.3, seed: 3 })];
      ok('changing the grain seed changes the key',
        jobCacheKey(buildJob('C:\\nope\\out.mp4', { from: 0, to: 4 })) !== keyGrain);

      state.master = [fx('lut', { lut: 'TEST://identity' })];
      const keyId = jobCacheKey(buildJob('C:\\nope\\out.mp4', { from: 0, to: 4 }));
      // The SAME PATH holding a different table: the cache would hand back the old grade
      // if only the path were in the key, which is what lutDigest() exists to stop.
      FX.putLut('TEST://identity', invR, { size: invR.length, mtime: 99 });
      ok('a different cube AT THE SAME PATH changes the key',
        jobCacheKey(buildJob('C:\\nope\\out.mp4', { from: 0, to: 4 })) !== keyId);
      FX.putLut('TEST://identity', idCube, { size: idCube.length, mtime: 1 });

      // NEITHER NEW KEY CONTRIBUTOR CARRIES A TIMELINE POSITION - the rule the whole bake
      // cache is built on. It is asserted on the FIELDS rather than on the whole key,
      // because `rangeFrom`/`rangeTo` have always been in a job and a ranged render keys
      // by its range; what must not move is what the finishing pass contributes.
      state.master = [fx('lut', { lut: 'TEST://invert-red' }), fx('grain', { amount: 0.2 })];
      const finishBits = (j) => JSON.stringify({
        master: (j.master || []).map((f) => Object.assign({}, f, { id: undefined })),
        masterLuts: j.masterLuts,
        luts: (j.clips || []).map((c) => c.luts || null),
      });
      const atZero = finishBits(buildJob('C:\\nope\\out.mp4', { from: 0, to: 2 }));
      vt.clips[0].start = 6; vt.clips[1].start = 8;
      const atSix = finishBits(buildJob('C:\\nope\\out.mp4', { from: 6, to: 8 }));
      ok('moving the clips does not change what the finishing pass puts in the key',
        atSix === atZero, atZero === atSix ? '' : atZero + ' vs ' + atSix);

      // One undo entry for a master edit, and the project comes back exactly.
      vt.clips[0].start = 0; vt.clips[1].start = 2;
      const before = JSON.stringify(state.master);
      pushUndo();
      state.master = FX.normalizeStack(state.master.concat([fx('bloom')]));
      const added = state.master.length;
      undo();
      ok('one undo restores the master finish exactly',
        JSON.stringify(state.master) === before && added === 3,
        added + ' after add, ' + state.master.length + ' after undo');

      state.master = JSON.parse(snapMaster);
      state.tracks = JSON.parse(snapshot);
      renderAll();
      note('timeline restored');
    } else {
      note('no live renderer - skipped the fast-path and render-key block');
    }

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
