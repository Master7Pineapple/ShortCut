/**
 * The keyframe engine: evaluation, every easing curve, track editing, the edge cases,
 * and that pulling it out of TextModel left text cards behaving identically.
 *
 *   SHORTCUT_SMOKE=tools/smoke-anim.js node_modules/.bin/electron .
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.002 : eps);
    const K = (t, v, ease) => ({ t, v, ease: ease || Anim.cloneEasing(Anim.EASING_PRESETS.linear) });

    // ================================================================= easing

    ok('Anim is loaded before app.js', typeof Anim === 'object' && typeof Anim.ease === 'function');

    const lin = { kind: 'named', name: 'linear' };
    ok('linear easing is the identity', near(Anim.ease(lin, 0.37), 0.37));
    ok('easing clamps outside 0..1', Anim.ease(lin, -3) === 0 && Anim.ease(lin, 4) === 1);
    ok('a missing easing descriptor is linear', Anim.ease(null, 0.42) === 0.42);

    // Every preset must be a real curve: anchored at both ends, and finite throughout.
    const curveProblems = [];
    for (const [name, preset] of Object.entries(Anim.EASING_PRESETS)) {
      if (!near(Anim.ease(preset, 0), 0, 0.001)) curveProblems.push(name + ' f(0)=' + Anim.ease(preset, 0));
      if (!near(Anim.ease(preset, 1), 1, 0.001)) curveProblems.push(name + ' f(1)=' + Anim.ease(preset, 1));
      for (let i = 0; i <= 20; i++) {
        const v = Anim.ease(preset, i / 20);
        if (!isFinite(v)) { curveProblems.push(name + ' non-finite at ' + (i / 20)); break; }
      }
    }
    ok('every easing preset runs 0 -> 1 and stays finite', curveProblems.length === 0,
      curveProblems.join('; '));

    // The shapes that distinguish the curves from each other.
    ok('easeOut starts fast', Anim.ease(Anim.EASING_PRESETS.easeOut, 0.25) > 0.25);
    ok('easeIn starts slow', Anim.ease(Anim.EASING_PRESETS.easeIn, 0.25) < 0.25);
    ok('easeInOut is symmetric about the middle',
      near(Anim.ease(Anim.EASING_PRESETS.easeInOut, 0.5), 0.5, 0.01));
    ok('back overshoots backwards on the way in', Anim.NAMED.back(0.3) < 0,
      'v=' + Anim.NAMED.back(0.3).toFixed(3));
    ok('backOut overshoots past 1', Math.max(...[0.6, 0.7, 0.8].map(Anim.NAMED.backOut)) > 1);
    ok('elastic oscillates above and below 1',
      Anim.NAMED.elastic(0.35) !== Anim.NAMED.elastic(0.65) &&
      [0.2, 0.3, 0.4, 0.5, 0.6, 0.7].some((t) => Anim.NAMED.elastic(t) > 1) &&
      [0.2, 0.3, 0.4, 0.5, 0.6, 0.7].some((t) => Anim.NAMED.elastic(t) < 1));
    ok('bounce is monotone-ish and lands on 1', near(Anim.NAMED.bounce(1), 1, 0.001));
    ok('step holds 0 then snaps to 1',
      Anim.NAMED.step(0.99) === 0 && Anim.NAMED.step(1) === 1);
    ok('a bezier solver agrees with its own control points',
      near(Anim.bezier(0, 0, 1, 1)(0.5), 0.5, 0.005));

    // ============================================================ evaluation

    ok('an empty track is inert', Anim.evalTrack([], 1) === null);
    ok('a null track is inert', Anim.evalTrack(null, 1) === null);
    ok('an undefined track is inert', Anim.evalTrack(undefined, 1) === null);

    const one = [K(1.5, 0.7)];
    ok('one key holds its value everywhere',
      Anim.evalTrack(one, -10) === 0.7 && Anim.evalTrack(one, 1.5) === 0.7 &&
      Anim.evalTrack(one, 99) === 0.7);

    const two = [K(0, 0), K(2, 1)];
    ok('two keys interpolate linearly at the midpoint', near(Anim.evalTrack(two, 1), 0.5));
    ok('a track holds before its first key', Anim.evalTrack(two, -5) === 0);
    ok('a track holds after its last key', Anim.evalTrack(two, 99) === 1);
    ok('a track lands exactly on its keys',
      Anim.evalTrack(two, 0) === 0 && Anim.evalTrack(two, 2) === 1);

    // Keys OUTSIDE the clip's range: a clip 0..3 with keys at -2 and 8 still shows a
    // sensible slice of the curve rather than nothing, or a jump.
    const outside = [K(-2, 0), K(8, 1)];
    ok('keys outside the clip range still evaluate inside it',
      near(Anim.evalTrack(outside, 0), 0.2) && near(Anim.evalTrack(outside, 3), 0.5),
      't=0 ' + Anim.evalTrack(outside, 0).toFixed(3) + '  t=3 ' + Anim.evalTrack(outside, 3).toFixed(3));

    // UNSORTED input must evaluate as if sorted, and must not be reordered underneath the
    // caller - a paint pass rewriting the author's data would be a nasty surprise.
    const messy = [K(2, 1), K(0, 0), K(1, 0.25)];
    const messyOrderBefore = messy.map((k) => k.t).join(',');
    ok('an unsorted track evaluates as if sorted',
      near(Anim.evalTrack(messy, 0.5), 0.125) && near(Anim.evalTrack(messy, 1.5), 0.625),
      '0.5 -> ' + Anim.evalTrack(messy, 0.5).toFixed(3));
    ok('evaluating an unsorted track does not reorder it',
      messy.map((k) => k.t).join(',') === messyOrderBefore, messyOrderBefore);

    // Two keys at the same time is a zero-length span. It must produce a value, not NaN.
    const dup = [K(1, 0), K(1, 1)];
    ok('a zero-length span does not produce NaN', isFinite(Anim.evalTrack(dup, 1)));

    // The easing on a span belongs to the key on its LEFT.
    const eased = [K(0, 0, Anim.cloneEasing(Anim.EASING_PRESETS.easeIn)), K(1, 1)];
    ok('a span uses the LEFT key easing', Anim.evalTrack(eased, 0.25) < 0.25,
      'v=' + Anim.evalTrack(eased, 0.25).toFixed(3));
    const easedRight = [K(0, 0), K(1, 1, Anim.cloneEasing(Anim.EASING_PRESETS.easeIn))];
    ok('the last key easing is never used', near(Anim.evalTrack(easedRight, 0.25), 0.25));

    // ========================================================= track editing

    const tr = [];
    Anim.addKey(tr, 1, 0.5);
    Anim.addKey(tr, 0, 0);
    ok('addKey keeps the track sorted', tr.map((k) => k.t).join(',') === '0,1');
    ok('addKey defaults to an easeInOut curve', tr[0].ease && tr[0].ease.kind === 'bezier');

    const held = Anim.addKey(tr, 0.5);
    ok('addKey with no value pins the current value', near(held.v, 0.25),
      'v=' + held.v.toFixed(3));
    ok('pinning a key does not move the curve', near(Anim.evalTrack(tr, 0.5), 0.25) &&
      near(Anim.evalTrack(tr, 0.75), 0.375, 0.06));

    const before = tr.length;
    Anim.addKey(tr, 0.5, 0.9);
    ok('addKey at an existing time updates rather than duplicating',
      tr.length === before && near(tr.find((k) => k.t === 0.5).v, 0.9));

    ok('moveKey sets a value', Anim.moveKey(tr, 0, 0.1) && tr[0].v === 0.1);
    ok('moveKey refuses a non-finite value',
      Anim.moveKey(tr, 0, NaN) === false && tr[0].v === 0.1);
    ok('moveKey refuses a missing index', Anim.moveKey(tr, 99, 1) === false);

    // Retiming a key past its neighbour reorders the track, so the new index is returned.
    const rt = [K(0, 0), K(1, 1), K(2, 2)];
    const moved = Anim.retimeKey(rt, 0, 1.5);
    ok('retimeKey re-sorts and returns the new index',
      moved === 1 && rt.map((k) => k.t).join(',') === '1,1.5,2', 'idx=' + moved);
    ok('retimeKey moved the right key', rt[1].v === 0);

    ok('removeKey removes one key', Anim.removeKey(rt, 1) && rt.length === 2 &&
      rt.map((k) => k.v).join(',') === '1,2');
    ok('removeKey refuses an out-of-range index',
      Anim.removeKey(rt, 5) === false && Anim.removeKey(rt, -1) === false && rt.length === 2);

    // ===================================================== keys on any clip

    // `clip.keys` is OPTIONAL: a clip that has never been keyed must not grow the field,
    // or every project would serialise differently than it did before this step.
    const clip = { id: 'x1', kind: 'video', in: 0, out: 4, start: 2, panX: 0.5, panY: 0.5, zoom: 1 };
    ok('a clip starts with no keys object', clip.keys === undefined);
    ok('reading an unkeyed property does not create anything',
      Anim.valueAt(clip, 'opacity', 1, 0.42) === 0.42 && clip.keys === undefined);
    ok('trackFor without create returns null', Anim.trackFor(clip, 'opacity', false) === null &&
      clip.keys === undefined);

    const track = Anim.trackFor(clip, 'opacity', true);
    Anim.addKey(track, 0, 0);
    Anim.addKey(track, 2, 1, Anim.EASING_PRESETS.linear);
    ok('trackFor(create) makes the track', Array.isArray(clip.keys.opacity) && track.length === 2);
    ok('valueAt reads the animated value', near(Anim.valueAt(clip, 'opacity', 1, 9), 0.5),
      'v=' + Anim.valueAt(clip, 'opacity', 1, 9));
    ok('valueAt falls back for an unkeyed property',
      Anim.valueAt(clip, 'zoom', 1, 1.75) === 1.75);

    // Keys are plain JSON, because undo is JSON.stringify of the track list and the same
    // shape is the .scut file.
    const roundTrip = JSON.parse(JSON.stringify(clip));
    ok('keys survive a JSON round trip',
      near(Anim.valueAt(roundTrip, 'opacity', 1, 9), 0.5) &&
      JSON.stringify(roundTrip.keys) === JSON.stringify(clip.keys));

    Anim.trackFor(clip, 'opacity', true).length = 0;
    Anim.pruneKeys(clip);
    ok('pruning an emptied track removes `keys` entirely', clip.keys === undefined);
    ok('a pruned clip serialises like one that was never keyed',
      JSON.stringify(clip) === JSON.stringify(
        { id: 'x1', kind: 'video', in: 0, out: 4, start: 2, panX: 0.5, panY: 0.5, zoom: 1 }));

    // ------------------------------------------------ the property registry

    const specOpacity = Anim.propSpec('opacity');
    ok('a multiplying property has a base of 1',
      Anim.propSpec('opacity').base === 1 && Anim.propSpec('scale').base === 1 &&
      Anim.propSpec('glow').base === 1);
    ok('an adding property has a base of 0',
      Anim.propSpec('x').base === 0 && Anim.propSpec('rotate').base === 0);
    ok('an unknown property gets a neutral additive spec',
      Anim.propSpec('somethingNew').base === 0 && Anim.propSpec('somethingNew').label === 'somethingNew');
    ok('propSpec hands back a copy, not the shared spec',
      Anim.propSpec('opacity') !== specOpacity);

    const registeredBefore = Anim.clipProps.length;
    Anim.registerClipProp({ prop: 'testProp', min: 0, max: 5, step: 0.1, base: 1 });
    ok('registering a property offers it on a clip',
      Anim.clipPropsFor(clip).some((s) => s.prop === 'testProp'));
    Anim.registerClipProp({ prop: 'testProp', min: 0, max: 9, step: 0.1, base: 1 });
    ok('re-registering replaces rather than duplicating',
      Anim.clipProps.filter((s) => s.prop === 'testProp').length === 1 &&
      Anim.clipPropsFor(clip).find((s) => s.prop === 'testProp').max === 9);
    Anim.registerClipProp({ prop: 'audioOnly', min: 0, max: 1, step: 0.1, base: 1,
      when: (c) => c.kind === 'audio' });
    ok('a `when` filter keeps a property off the wrong clip',
      !Anim.clipPropsFor(clip).some((s) => s.prop === 'audioOnly') &&
      Anim.clipPropsFor({ kind: 'audio' }).some((s) => s.prop === 'audioOnly'));
    ok('registerClipProp ignores a spec with no property name',
      Anim.registerClipProp({ min: 0 }) === null);
    // Leave the registry as it was found - the panel reads it live.
    Anim.clipProps.length = registeredBefore;

    // The inspector panel is generic: with an empty registry it offers nothing at all,
    // which is the correct state until step 7 registers the effect stack's parameters.
    ok('the clip keyframe panel is absent while nothing is registered',
      clipKeyPanel(clip) === null);
    Anim.registerClipProp({ prop: 'testProp', min: 0, max: 5, step: 0.1, base: 1 });
    const panel = clipKeyPanel(clip);
    ok('one registration is all a property needs to get a strip',
      !!panel && panel.textContent.indexOf('testProp') >= 0);
    ok('the panel refuses a text card', clipKeyPanel({ kind: 'text', in: 0, out: 2 }) === null);
    Anim.clipProps.length = registeredBefore;

    // ============================== text cards go through the same engine

    ok('TextModel re-exports Anim easing, it does not re-implement it',
      TextModel.ease === Anim.ease && TextModel.bezier === Anim.bezier &&
      TextModel.evalTrack === Anim.evalTrack && TextModel.NAMED === Anim.NAMED &&
      TextModel.EASING_PRESETS === Anim.EASING_PRESETS);

    const card = TextModel.defaultCard('KEY');
    card.animEnabled = false;
    card.keys.opacity = [K(0, 0), K(2, 1)];
    card.keys.x = [K(0, -0.5), K(2, 0.5)];
    ok('a card still composes its keyframes',
      near(TextModel.evalCard(card, 1, 4).opacity, 0.5) &&
      near(TextModel.evalCard(card, 1, 4).dx, 0),
      'op=' + TextModel.evalCard(card, 1, 4).opacity.toFixed(3));

    // The card's own keyframe strip is the generic one, so a text card exercises the
    // exact code path the clip inspector uses.
    const textClip = addTextCard('KEY');
    textClip.start = 0; textClip.out = 3;
    textClip.card.keys.opacity = [K(0.5, 0.25)];
    setSelection([textClip.id], false);
    renderInspector();
    const strip = document.querySelector('#textPanel .tc-kf');
    ok('the text panel builds keyframe strips', !!strip);
    ok('a strip offers add and clear',
      !!strip && [...strip.querySelectorAll('button')].some((b) => b.textContent === '+ key') &&
      [...strip.querySelectorAll('button')].some((b) => b.textContent === 'Clear'));
    const opacityStrip = [...document.querySelectorAll('#textPanel .tc-kf')]
      .find((s) => (s.querySelector('b') || {}).textContent === 'opacity');
    ok('an existing key gets a row', !!opacityStrip && !!opacityStrip.querySelector('.tc-key'));
    ok('the key row shows the key time',
      !!opacityStrip && opacityStrip.querySelector('.tc-key-t').value === '0.50',
      opacityStrip ? opacityStrip.querySelector('.tc-key-t').value : '(no strip)');

    // Undo still sees keys - they are plain JSON on the clip.
    const undoDepth = undoStack.length;
    pushUndo();
    textClip.card.keys.opacity = [];
    undo();
    ok('undo restores a cleared keyframe track',
      selectedTextClip() && selectedTextClip().card.keys.opacity.length === 1,
      'depth ' + undoDepth + ' -> ' + undoStack.length);

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
