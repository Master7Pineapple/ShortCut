/**
 * Text card test suite: model evaluation, canvas drawing, and the render job shape.
 *
 *   SHORTCUT_SMOKE=tools/smoke-text.js node_modules/.bin/electron .
 *
 * Runs in the renderer so it can use the real canvas and the real fonts.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);

    // ------------------------------------------------------------- easing
    ok('linear easing is the identity', near(TextModel.ease({ kind: 'named', name: 'linear' }, 0.37), 0.37));
    const eo = TextModel.EASING_PRESETS.easeOut;
    ok('easeOut starts fast', TextModel.ease(eo, 0.25) > 0.25, 'v=' + TextModel.ease(eo, 0.25).toFixed(3));
    ok('easing is clamped at both ends',
      TextModel.ease(eo, -1) === 0 && TextModel.ease(eo, 2) === 1);
    ok('bounce lands on 1', near(TextModel.ease({ kind: 'named', name: 'bounce' }, 1), 1, 0.001));

    // ------------------------------------------------- animation evaluation
    const card = TextModel.defaultCard('Hello world');
    card.anims = [TextModel.defaultAnim('fade', 'in')];
    card.anims[0].start = 0; card.anims[0].duration = 1;
    const DUR = 3;
    ok('fade in starts invisible', near(TextModel.evalAnims(card, 0, DUR).opacity, 0, 0.02));
    ok('fade in finishes opaque', near(TextModel.evalAnims(card, 1, DUR).opacity, 1, 0.02));
    ok('fade in holds opaque afterwards', near(TextModel.evalAnims(card, 2.5, DUR).opacity, 1, 0.02));

    card.anims.push(TextModel.defaultAnim('fade', 'out'));
    const outA = card.anims[1];
    outA.anchor = 'end'; outA.start = 0; outA.duration = 1;
    ok('fade out is opaque before its window', near(TextModel.evalAnims(card, 1.5, DUR).opacity, 1, 0.02));
    ok('fade out ends invisible', near(TextModel.evalAnims(card, DUR, DUR).opacity, 0, 0.02));

    // Combining layers.
    card.anims = [TextModel.defaultAnim('slide', 'in'), TextModel.defaultAnim('zoom', 'in')];
    card.anims[0].duration = 1; card.anims[0].params = { from: 'left', distance: 0.4 };
    card.anims[1].duration = 1; card.anims[1].params = { amount: 0.5 };
    const at0 = TextModel.evalAnims(card, 0, DUR);
    ok('slide in starts offset left', near(at0.dx, -0.4, 0.02), 'dx=' + at0.dx.toFixed(3));
    ok('zoom in starts scaled down', at0.scale < 1, 'scale=' + at0.scale.toFixed(3));
    const at1 = TextModel.evalAnims(card, 1, DUR);
    ok('combined layers settle at rest', near(at1.dx, 0, 0.01) && near(at1.scale, 1, 0.01),
      'dx=' + at1.dx.toFixed(3) + ' scale=' + at1.scale.toFixed(3));

    // Typewriter.
    card.anims = [TextModel.defaultAnim('typewriter', 'in')];
    card.anims[0].duration = 1;
    card.anims[0].easing = { kind: 'named', name: 'linear' };
    ok('typewriter starts hidden', near(TextModel.evalAnims(card, 0, DUR).reveal, 0, 0.02));
    ok('typewriter is half way at half time', near(TextModel.evalAnims(card, 0.5, DUR).reveal, 0.5, 0.05));
    ok('typewriter reveals by character',
      TextDraw.revealText('abcdef', 0.5, 'char') === 'abc',
      '"' + TextDraw.revealText('abcdef', 0.5, 'char') + '"');
    ok('typewriter reveals by word',
      TextDraw.revealText('one two three four', 0.5, 'word').trim() === 'one two',
      '"' + TextDraw.revealText('one two three four', 0.5, 'word') + '"');

    // Flicker.
    card.anims = [TextModel.defaultAnim('flicker', 'in')];
    card.anims[0].duration = 2; card.anims[0].params = { hz: 10, duty: 0.5, min: 0 };
    let litCount = 0;
    for (let i = 0; i < 40; i++) if (TextModel.evalAnims(card, i * 0.01, DUR).opacity > 0.5) litCount++;
    ok('flicker alternates on and off', litCount > 5 && litCount < 35, 'lit ' + litCount + '/40');

    // ----------------------------------------------------------- keyframes
    const kf = [
      { t: 0, v: 0, ease: { kind: 'named', name: 'linear' } },
      { t: 2, v: 1, ease: { kind: 'named', name: 'linear' } },
    ];
    ok('keyframes interpolate', near(TextModel.evalTrack(kf, 1), 0.5, 0.01), 'v=' + TextModel.evalTrack(kf, 1));
    ok('keyframes hold before the first key', TextModel.evalTrack(kf, -5) === 0);
    ok('keyframes hold after the last key', TextModel.evalTrack(kf, 99) === 1);
    ok('an empty track is inert', TextModel.evalTrack([], 1) === null);

    const kcard = TextModel.defaultCard('k');
    kcard.animEnabled = false;
    kcard.keys.opacity = kf;
    ok('keyframes apply with animation off',
      near(TextModel.evalCard(kcard, 1, DUR).opacity, 0.5, 0.02));

    // ------------------------------------------------------ canvas drawing
    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1920;
    const cx = cv.getContext('2d');
    const bright = () => {
      const d = cx.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 37) { sum += d[i + 3]; n++; }
      return sum / n; // mean alpha - text cards draw on transparency
    };
    /** Horizontal extent of the ink, scanned exactly across a band through the text. */
    const inkWidth = () => {
      const y0 = Math.round(cv.height * 0.45), h = Math.round(cv.height * 0.1);
      const d = cx.getImageData(0, y0, cv.width, h).data;
      let lo = Infinity, hi = -Infinity;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < cv.width; x++) {
          if (d[(y * cv.width + x) * 4 + 3] > 2) { if (x < lo) lo = x; if (x > hi) hi = x; }
        }
      }
      return hi >= lo ? hi - lo : 0;
    };

    const clip = addTextCard('SMOKE TEST');
    clip.out = 3;
    clip.card.anims = [];
    clip.card.animEnabled = true;

    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1.0, 1 / 30);
    const solid = bright();
    ok('a static card paints pixels', solid > 0.5, 'meanAlpha=' + solid.toFixed(2));

    // Fade to nothing must actually clear.
    clip.card.anims = [TextModel.defaultAnim('fade', 'in')];
    clip.card.anims[0].duration = 1;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0, 1 / 30);
    ok('a faded-out card paints nothing', bright() < 0.05, 'meanAlpha=' + bright().toFixed(3));

    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1, 1 / 30);
    ok('a faded-in card paints again', bright() > 0.5, 'meanAlpha=' + bright().toFixed(2));

    // Gradient and glow must not crash and must still paint.
    clip.card.style.fill.type = 'gradient';
    clip.card.style.glow.on = true;
    clip.card.style.blur.on = true; clip.card.style.blur.amount = 3;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1, 1 / 30);
    ok('gradient + glow + blur paints', bright() > 0.5, 'meanAlpha=' + bright().toFixed(2));
    clip.card.style.fill.type = 'solid';
    clip.card.style.glow.on = false; clip.card.style.blur.on = false;

    // Motion blur is a real temporal average. Keep the card small and the slide short so
    // the whole thing stays inside the canvas - a card that slides off the edge gets
    // clipped and the measurement below would only see the trailing side move.
    clip.card.style.fontSize = 50;
    // The soft shadow's outer tail sits below any sane alpha threshold, so it hides the
    // faintest part of the smear from the measurement. Measure the glyphs alone.
    clip.card.style.shadow.on = false;
    clip.card.anims = [TextModel.defaultAnim('slide', 'in')];
    clip.card.anims[0].duration = 1;
    clip.card.anims[0].easing = { kind: 'named', name: 'linear' };
    clip.card.anims[0].params = { from: 'left', distance: 0.12 };
    clip.card.anims[0].motionBlur = { on: false, strength: 2, samples: 12 };
    const FRAME = 1 / 10; // a long frame so the shutter smear is clearly measurable
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0.5, FRAME);
    const sharp = bright();
    const coverSharp = inkWidth();
    clip.card.anims[0].motionBlur.on = true;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0.5, FRAME);
    const blurred = bright();
    const coverBlurred = inkWidth();
    // A temporal average CONSERVES ink - it spreads the same total alpha over more pixels,
    // so the test is coverage up, total alpha unchanged. (Mean alpha going *down* would
    // mean the accumulation is losing opacity, which is the bug this guards against.)
    ok('motion blur conserves ink roughly', near(blurred, sharp, sharp * 0.08),
      'sharp=' + sharp.toFixed(2) + ' blurred=' + blurred.toFixed(2));
    // The card slides 0.12 frame-widths per second and the shutter is 2/10 s, so the ink
    // should widen by roughly 0.12 * 1080 * 0.2 ~= 26px - half of it on each side of where
    // the sharp draw sits, since the shutter is centred on the frame time.
    ok('motion blur smears along the direction of travel',
      coverBlurred - coverSharp > 18 && coverBlurred - coverSharp < 40,
      'sharp=' + coverSharp + 'px blurred=' + coverBlurred + 'px (+' + (coverBlurred - coverSharp) + ')');

    // Same check at a normal display size. Accumulation is 8-bit - each sample is
    // quantised to round(alpha/n) before being added - so a couple of percent goes missing
    // on anti-aliased edges. Anything beyond that means the accumulation is losing opacity.
    clip.card.style.fontSize = 110;
    clip.card.anims[0].motionBlur.on = false;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0.5, FRAME);
    const bigSharp = bright();
    clip.card.anims[0].motionBlur.on = true;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0.5, FRAME);
    const bigBlurred = bright();
    ok('motion blur conserves ink at display sizes', near(bigBlurred, bigSharp, bigSharp * 0.08),
      'sharp=' + bigSharp.toFixed(2) + ' blurred=' + bigBlurred.toFixed(2));

    // A still card must survive motion blur untouched: every sample lands in the same
    // place, so additive accumulation has to return it to full opacity, not ~63%.
    clip.card.anims = [];
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1, 1 / 30);
    const still = bright();
    clip.card.anims = [TextModel.defaultAnim('fade', 'in')];
    clip.card.anims[0].duration = 0.001; // settled, so the transform is static
    clip.card.anims[0].motionBlur = { on: true, strength: 2, samples: 12 };
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1, FRAME);
    const stillBlurred = bright();
    ok('motion blur does not dim a static card', near(stillBlurred, still, still * 0.06),
      'still=' + still.toFixed(2) + ' blurred=' + stillBlurred.toFixed(2));

    // Bounds must shrink for a small card and cover the animation.
    clip.card.anims = [];
    clip.card.style.fontSize = 60;
    const b = TextDraw.animatedBounds(cx, clip, 1080, 1920, 1 / 10);
    ok('bounds are smaller than the frame', b.w < 1080 && b.h < 1920, b.w + 'x' + b.h);
    ok('bounds are even-sized for yuv420p', b.w % 2 === 0 && b.h % 2 === 0, b.w + 'x' + b.h);
    clip.card.anims = [TextModel.defaultAnim('slide', 'in')];
    clip.card.anims[0].params = { from: 'left', distance: 0.5 };
    const b2 = TextDraw.animatedBounds(cx, clip, 1080, 1920, 1 / 10);
    ok('bounds widen to cover a slide', b2.w > b.w, b.w + ' -> ' + b2.w);

    // ------------------------------------------------------- project/render
    const job = buildJob('C:\\nowhere.mp4');
    const te = job.clips.filter((c) => c.kind === 'text');
    ok('render job includes the text clip', te.length === 1);
    ok('text clip is visible, never audible', te[0].visible && !te[0].audible);
    ok('text clip carries its live card for baking', !!te[0].textClip);

    // Serialisation round trip.
    const ser = JSON.parse(JSON.stringify(serialize()));
    const sclip = ser.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'text');
    ok('text card survives save/load', !!sclip && sclip.card.text === 'SMOKE TEST');
    ok('animations survive save/load', sclip.card.anims.length === clip.card.anims.length);

    // Presets.
    const stylePreset = TextModel.extractPreset('style', clip.card);
    ok('style preset holds style only', !!stylePreset.style && !stylePreset.anims);
    const animPreset = TextModel.extractPreset('anim', clip.card);
    ok('animation preset holds anims only', !!animPreset.anims && !animPreset.style);
    const fullPreset = TextModel.extractPreset('full', clip.card);
    ok('full preset holds both plus text', !!fullPreset.style && !!fullPreset.anims && fullPreset.text === 'SMOKE TEST');

    const target = TextModel.defaultCard('other');
    TextModel.applyPreset(target, stylePreset, { keepText: true });
    ok('applying a style preset keeps the text', target.text === 'other');
    clip.card.style.fontSize = 123;
    const p2 = TextModel.extractPreset('style', clip.card);
    TextModel.applyPreset(target, p2, { keepText: true });
    ok('applying a style preset copies the look', target.style.fontSize === 123);

    // Fonts.
    const fonts = await window.api.listFonts();
    ok('system fonts enumerate', fonts.length > 5, fonts.length + ' families');

    // Preset library round trip through the main process.
    await window.api.savePreset('style', '__smoke__', p2);
    const listed = await window.api.listPresets();
    ok('preset saves into the library', (listed.style || []).includes('__smoke__'));
    const loaded = await window.api.loadPreset('style', '__smoke__');
    ok('preset loads back', loaded && loaded.style.fontSize === 123);
    await window.api.deletePreset('style', '__smoke__');
    const after = await window.api.listPresets();
    ok('preset deletes', !(after.style || []).includes('__smoke__'));

    // Editing operations on a text clip.
    setSelection([clip.id], false);
    const before = state.tracks.flatMap((t) => t.clips).length;
    duplicateSelected();
    ok('Ctrl+D duplicates a text card',
      state.tracks.flatMap((t) => t.clips).length === before + 1);
    undo();
    ok('duplicate is undoable', state.tracks.flatMap((t) => t.clips).length === before);

    // undo() rebuilds the track list from JSON, so re-fetch the clip by id.
    const live = () => state.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'text');
    setSelection([live().id], false);
    const wasOn = live().card.animEnabled;
    toggleCardAnimation();
    ok('A toggles card animation', live().card.animEnabled === !wasOn);

    // A text clip must never create a media element.
    seek(live().start + 0.5);
    syncMedia();
    await sleep(50);
    ok('a text clip never opens a decoder', !mediaEls.has(live().id));

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
