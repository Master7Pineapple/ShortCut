/**
 * Typewriter layers: typing in, typing out, and the two composing on one card.
 *
 *   SHORTCUT_SMOKE=tools/smoke-typewriter.js node_modules/.bin/electron .
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));

    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1920;
    const cx = cv.getContext('2d');

    const clip = addTextCard('ABCDEFGH');
    clip.start = 0; clip.out = 4;
    clip.card.style.fontSize = 110;
    clip.card.style.shadow.on = false;

    const linear = { kind: 'named', name: 'linear' };
    const mkTw = (mode, opts) => {
      const a = TextModel.defaultAnim('typewriter', mode);
      a.easing = linear;
      a.anchor = mode === 'out' ? 'end' : 'start';
      a.start = 0;
      a.duration = 1;
      a.params = Object.assign(
        { unit: 'char', effect: 'up', distance: 0.6, overlap: 2, order: 'forward', scaleFrom: 0.3 },
        opts || {});
      return a;
    };

    /** Visible units at time t, in left-to-right order, with their alpha. */
    const unitsAt = (t) => TextDraw.measure(cx, clip, 1080, 1920, t).items
      .slice()
      .sort((a, b) => a.x - b.x)
      .map((i) => ({ ch: i.text, a: i.alpha, dy: i.dy, dx: i.dx, s: i.scale }));
    const visible = (t) => unitsAt(t).filter((u) => u.a > 0.5).map((u) => u.ch).join('');

    // ============================================ a lone type-in still works
    clip.card.anims = [mkTw('in', { effect: 'none' })];
    ok('nothing is showing before the type-in', visible(0) === '', '"' + visible(0) + '"');
    ok('it types in from the left', visible(0.5).length > 0 &&
      'ABCDEFGH'.startsWith(visible(0.5)), '"' + visible(0.5) + '"');
    ok('all of it is there once the layer finishes', visible(1.5) === 'ABCDEFGH',
      '"' + visible(1.5) + '"');

    // ============================================ a lone type-out must work
    // This is the bug: the layer list was searched with .find(), so only the FIRST
    // typewriter layer ever had any effect.
    clip.card.anims = [mkTw('out', { effect: 'none' })];
    ok('everything shows before the type-out starts', visible(0.5) === 'ABCDEFGH',
      '"' + visible(0.5) + '"');
    ok('a type-out actually removes units', visible(3.5).length < 8,
      't=3.5 "' + visible(3.5) + '"');
    ok('by the end nothing is left', visible(4) === '', '"' + visible(4) + '"');

    // ============================================ out sweeps left to right
    // 'forward' means the FIRST unit goes first, so what is left is a suffix.
    const mid = visible(3.5);
    ok('a forward type-out vanishes from the left', mid.length > 0 && 'ABCDEFGH'.endsWith(mid),
      'left showing "' + mid + '"');

    clip.card.anims = [mkTw('out', { effect: 'none', order: 'backward' })];
    const midB = visible(3.5);
    ok('a backward type-out vanishes from the right',
      midB.length > 0 && 'ABCDEFGH'.startsWith(midB), 'left showing "' + midB + '"');

    // ============================================ in + out on the same card
    clip.card.anims = [mkTw('in', { effect: 'none' }), mkTw('out', { effect: 'none' })];
    ok('both layers are seen', TextDraw.typewriterStates(clip.card, 0.5, 4).length === 2,
      TextDraw.typewriterStates(clip.card, 0.5, 4).length + ' layer(s)');
    ok('in + out: empty at the very start', visible(0) === '', '"' + visible(0) + '"');
    ok('in + out: typing in', 'ABCDEFGH'.startsWith(visible(0.5)) && visible(0.5).length > 0,
      '"' + visible(0.5) + '"');
    ok('in + out: fully present in the middle', visible(2) === 'ABCDEFGH', '"' + visible(2) + '"');
    ok('in + out: typing out again', visible(3.5).length < 8 && visible(3.5).length > 0,
      '"' + visible(3.5) + '"');
    ok('in + out: empty at the end', visible(4) === '', '"' + visible(4) + '"');

    // ============================================ direction on the way out
    // A named direction is where a unit ARRIVES from going in, and where it LEAVES
    // towards going out - so the offset has to flip sign between the two.
    clip.card.anims = [mkTw('in', { effect: 'up', overlap: 3 })];
    const inUnits = unitsAt(0.35).filter((u) => u.a > 0.02 && u.a < 0.98);
    ok('a unit arriving with "up" starts below the line',
      inUnits.length > 0 && inUnits.every((u) => u.dy > 0),
      inUnits.map((u) => u.ch + ':' + u.dy.toFixed(0)).join(' '));

    clip.card.anims = [mkTw('out', { effect: 'up', overlap: 3 })];
    const outUnits = unitsAt(3.4).filter((u) => u.a > 0.02 && u.a < 0.98);
    ok('a unit leaving with "up" lifts above the line',
      outUnits.length > 0 && outUnits.every((u) => u.dy < 0),
      outUnits.map((u) => u.ch + ':' + u.dy.toFixed(0)).join(' '));

    clip.card.anims = [mkTw('out', { effect: 'left', overlap: 3 })];
    const outLeft = unitsAt(3.4).filter((u) => u.a > 0.02 && u.a < 0.98);
    ok('a unit leaving with "left" moves left',
      outLeft.length > 0 && outLeft.every((u) => u.dx < 0),
      outLeft.map((u) => u.ch + ':' + u.dx.toFixed(0)).join(' '));

    // ============================================ pop: big to small, and back
    clip.card.anims = [mkTw('out', { effect: 'pop', scaleFrom: 0.2, overlap: 3 })];
    const shrink = unitsAt(3.4).filter((u) => u.a > 0.02 && u.a < 0.98);
    ok('pop-out with scaleFrom < 1 shrinks units away',
      shrink.length > 0 && shrink.every((u) => u.s < 1),
      shrink.map((u) => u.ch + ':' + u.s.toFixed(2)).join(' '));

    clip.card.anims = [mkTw('out', { effect: 'pop', scaleFrom: 2, overlap: 3 })];
    const grow = unitsAt(3.4).filter((u) => u.a > 0.02 && u.a < 0.98);
    ok('pop-out with scaleFrom > 1 balloons units away',
      grow.length > 0 && grow.every((u) => u.s > 1),
      grow.map((u) => u.ch + ':' + u.s.toFixed(2)).join(' '));

    clip.card.anims = [mkTw('in', { effect: 'pop', scaleFrom: 2.5, overlap: 3 })];
    const bigIn = unitsAt(0.35).filter((u) => u.a > 0.02 && u.a < 0.98);
    ok('pop-in with scaleFrom > 1 drops units in oversized',
      bigIn.length > 0 && bigIn.every((u) => u.s > 1),
      bigIn.map((u) => u.ch + ':' + u.s.toFixed(2)).join(' '));

    // ============================================ it all still renders
    clip.card.anims = [
      mkTw('in', { effect: 'up' }),
      mkTw('out', { effect: 'pop', scaleFrom: 0.2 }),
    ];
    const inked = (t) => {
      cx.clearRect(0, 0, 1080, 1920);
      TextDraw.draw(cx, clip, 1080, 1920, t, 1 / 30);
      const d = cx.getImageData(0, 0, 1080, 1920).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 31) if (d[i + 3] > 8) n++;
      return n;
    };
    const early = inked(0.1), middle = inked(2), late = inked(3.95);
    ok('the composed card paints in the middle', middle > 50, 'ink=' + middle);
    ok('it is nearly empty at the start', early < middle * 0.6, early + ' vs ' + middle);
    ok('it is nearly empty at the end', late < middle * 0.35, late + ' vs ' + middle);

    // Presets must carry the new parameters.
    const preset = TextModel.extractPreset('anim', clip.card);
    const fresh = TextModel.defaultCard();
    TextModel.applyPreset(fresh, preset);
    ok('an animation preset round-trips both typewriter layers',
      fresh.anims.filter((a) => a.type === 'typewriter').length === 2);
    ok('the preset keeps the out layer parameters',
      fresh.anims.some((a) => a.mode === 'out' && a.params.scaleFrom === 0.2),
      JSON.stringify(fresh.anims.map((a) => a.mode + ':' + a.params.effect)));

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
