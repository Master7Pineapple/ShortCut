/**
 * Text card suite, part 2: the fixes and features added after the first pass.
 *
 *   SHORTCUT_SMOKE=tools/smoke-text2.js node_modules/.bin/electron .
 *
 * Covers motion-blur shutter clamping, glow-over-glyphs, glow keyframes, per-unit
 * typewriter effects, the bake cache, and the preset panel that must not use prompt().
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1920;
    const cx = cv.getContext('2d');

    /** Horizontal extent of the ink across a band through the middle of the card. */
    const inkWidth = () => {
      const y0 = Math.round(1920 * 0.35), h = Math.round(1920 * 0.3);
      const d = cx.getImageData(0, y0, 1080, h).data;
      let lo = Infinity, hi = -Infinity;
      for (let y = 0; y < h; y++) for (let x = 0; x < 1080; x++) {
        if (d[(y * 1080 + x) * 4 + 3] > 2) { if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      return hi >= lo ? hi - lo : 0;
    };
    /** Fraction of inked pixels that are fully opaque - a stacked sharp copy saturates. */
    const saturation = () => {
      const d = cx.getImageData(0, 0, 1080, 1920).data;
      let ink = 0, full = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 2) { ink++; if (d[i + 3] > 250) full++; }
      }
      return ink ? full / ink : 0;
    };
    /** Mean RGB of the glyph interiors (near-opaque pixels). */
    const coreColour = () => {
      const d = cx.getImageData(0, 0, 1080, 1920).data;
      let n = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 250) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      }
      return n ? { r: r / n, g: g / n, b: b / n, n } : { r: 0, g: 0, b: 0, n: 0 };
    };
    const coverage = () => {
      const d = cx.getImageData(0, 0, 1080, 1920).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 6) n++;
      return n;
    };

    // ============================================ motion blur shutter clamping
    // At the first frames of a clip a centred shutter used to hang off the front, where
    // every animation clamps to its start state; those samples stacked into a sharp copy,
    // so the opening frames looked crisp while later ones blurred.
    const clip = addTextCard('BALLSY');
    clip.start = 0; clip.out = 3;
    clip.card.style.fontSize = 90;
    clip.card.style.shadow.on = false;
    clip.card.style.glow.on = false;
    const slide = TextModel.defaultAnim('slide', 'in');
    slide.duration = 1;
    slide.easing = { kind: 'named', name: 'linear' };
    slide.params = { from: 'left', distance: 0.12 };
    slide.motionBlur = { on: true, strength: 2, samples: 12 };
    clip.card.anims = [slide];
    const FRAME = 1 / 10;

    const widenAt = (t) => {
      slide.motionBlur.on = false;
      cx.clearRect(0, 0, 1080, 1920);
      TextDraw.draw(cx, clip, 1080, 1920, t, FRAME);
      const w0 = inkWidth();
      slide.motionBlur.on = true;
      cx.clearRect(0, 0, 1080, 1920);
      TextDraw.draw(cx, clip, 1080, 1920, t, FRAME);
      return { widen: inkWidth() - w0, sat: saturation() };
    };

    const first = widenAt(0);
    const mid = widenAt(0.5);
    const nearEnd = widenAt(0.9);
    const atRest = widenAt(1.0);
    ok('motion blur smears on the very first frame', first.widen > 15,
      'widening=' + first.widen + 'px');
    ok('first frame blurs as much as mid-animation', near(first.widen, mid.widen, 8),
      'first=' + first.widen + ' mid=' + mid.widen);
    ok('first frame is not a stacked sharp copy', near(first.sat, mid.sat, mid.sat * 0.5 + 0.02),
      'satFirst=' + first.sat.toFixed(3) + ' satMid=' + mid.sat.toFixed(3));
    ok('the last moving frame blurs fully', near(nearEnd.widen, mid.widen, 8),
      'nearEnd=' + nearEnd.widen + ' mid=' + mid.widen);
    // At the instant the layer finishes, only the first half of the shutter had any
    // movement in it - the card is coming to rest. A tapering smear there is correct
    // deceleration, not the clamping bug, so it must stay partial.
    ok('the smear tapers as the card comes to rest',
      atRest.widen > 4 && atRest.widen < mid.widen * 0.8,
      'atRest=' + atRest.widen + ' mid=' + mid.widen);

    // The same clamp has to hold with a shadow on - the user asked whether shadow shares
    // the problem. It does: it is the same sampling, so it is the same fix.
    clip.card.style.shadow.on = true;
    const sFirst = widenAt(0), sMid = widenAt(0.5);
    ok('shadow blurs the same on the first frame', near(sFirst.widen, sMid.widen, 10),
      'first=' + sFirst.widen + ' mid=' + sMid.widen);
    clip.card.style.shadow.on = false;

    // ================================================= glow covers the glyphs
    clip.card.anims = [];
    clip.card.style.fill.type = 'solid';
    clip.card.style.fill.color = '#202020';   // dark text so added light is measurable
    clip.card.style.glow.on = true;
    clip.card.style.glow.color = '#ff2020';
    clip.card.style.glow.size = 40;
    clip.card.style.glow.intensity = 3;

    clip.card.style.glow.over = 0;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1, FRAME);
    const haloOnly = coreColour();

    clip.card.style.glow.over = 1;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1, FRAME);
    const withOver = coreColour();

    ok('glow with over=0 leaves the glyphs untinted', haloOnly.r < 70,
      'coreR=' + haloOnly.r.toFixed(1));
    ok('glow covers the text, not just sits behind it', withOver.r > haloOnly.r + 60,
      'coreR ' + haloOnly.r.toFixed(1) + ' -> ' + withOver.r.toFixed(1));
    ok('the glow tint takes the glow colour', withOver.r > withOver.b + 40,
      'r=' + withOver.r.toFixed(1) + ' b=' + withOver.b.toFixed(1));

    // Parity guard: the bloom must be composited inside the card's own layer, so drawing
    // over an opaque background gives the same glyph pixels as drawing over transparency.
    // Compare the SAME pixels - "alpha > 250" would select the whole canvas once the
    // background is opaque, which measures the background rather than the glyphs.
    const glyphPixels = [];
    {
      const d = cx.getImageData(0, 0, 1080, 1920).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 250) glyphPixels.push(i);
    }
    const meanAt = () => {
      const d = cx.getImageData(0, 0, 1080, 1920).data;
      let r = 0;
      for (const i of glyphPixels) r += d[i];
      return glyphPixels.length ? r / glyphPixels.length : 0;
    };
    const transparentR = meanAt();
    cx.clearRect(0, 0, 1080, 1920);
    cx.fillStyle = '#0040ff'; cx.fillRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 1, FRAME);
    const onBlueR = meanAt();
    ok('found glyph pixels to compare', glyphPixels.length > 500, glyphPixels.length + 'px');
    ok('glow-over does not blend with whatever is underneath',
      near(onBlueR, transparentR, 6),
      'transparent=' + transparentR.toFixed(1) + ' onBlue=' + onBlueR.toFixed(1));

    // ============================================================ glow keyframes
    ok('glow is keyframable', TextModel.KEYABLE.includes('glow'));
    clip.card.keys.glow = [
      { t: 0, v: 0, ease: { kind: 'named', name: 'linear' } },
      { t: 2, v: 1, ease: { kind: 'named', name: 'linear' } },
    ];
    ok('glow keyframe interpolates', near(TextModel.evalCard(clip.card, 1, 3).glow, 0.5, 0.02),
      'v=' + TextModel.evalCard(clip.card, 1, 3).glow.toFixed(3));

    clip.card.style.glow.over = 0;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0, FRAME);   // glow keyed to 0
    const glowOff = coverage();
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 2, FRAME);   // glow keyed to 1
    const glowOn = coverage();
    ok('a glow keyframe of 0 removes the glow', glowOn > glowOff * 1.3,
      'off=' + glowOff + 'px on=' + glowOn + 'px');
    clip.card.keys.glow = [];
    clip.card.style.glow.on = false;
    clip.card.style.fill.color = '#ffffff';

    // ===================================================== typewriter per unit
    const tw = TextModel.defaultAnim('typewriter', 'in');
    tw.duration = 1;
    tw.easing = { kind: 'named', name: 'linear' };
    tw.params = { unit: 'char', effect: 'up', distance: 0.6, overlap: 2 };
    clip.card.anims = [tw];
    clip.card.text = 'ONE TWO THREE';

    const mHalf = TextDraw.measure(cx, clip, 1080, 1920, 0.5);
    ok('typewriter draws one item per unit', mHalf.items.length > 1,
      mHalf.items.length + ' items');
    ok('units mid-animation are partly transparent',
      mHalf.items.some((i) => i.alpha > 0.01 && i.alpha < 0.99),
      'alphas=' + mHalf.items.map((i) => i.alpha.toFixed(2)).slice(0, 6).join(','));
    ok('slide-up offsets the units that are still arriving',
      mHalf.items.some((i) => Math.abs(i.dy) > 1),
      'maxDy=' + Math.max(...mHalf.items.map((i) => Math.abs(i.dy))).toFixed(1));
    ok('settled units have landed',
      mHalf.items.some((i) => i.alpha > 0.99 && Math.abs(i.dy) < 0.01));

    const early = TextDraw.measure(cx, clip, 1080, 1920, 0.05);
    const late = TextDraw.measure(cx, clip, 1080, 1920, 0.95);
    ok('revealing letters does not reflow the lines',
      JSON.stringify(early.lines) === JSON.stringify(late.lines),
      JSON.stringify(late.lines));
    ok('fewer units are drawn early than late', early.items.length < late.items.length,
      early.items.length + ' -> ' + late.items.length);

    tw.params.effect = 'pop';
    const mPop = TextDraw.measure(cx, clip, 1080, 1920, 0.5);
    ok('pop scales the arriving units', mPop.items.some((i) => i.scale > 0.01 && i.scale < 0.99),
      'scales=' + mPop.items.map((i) => i.scale.toFixed(2)).slice(0, 6).join(','));

    tw.params.effect = 'none';
    const mNone = TextDraw.measure(cx, clip, 1080, 1920, 0.5);
    ok('the plain typewriter still hard-cuts each unit',
      mNone.items.every((i) => i.alpha > 0.99 && i.dy === 0));

    // Motion blur must reach the per-unit animation too.
    tw.params.effect = 'up';
    tw.motionBlur = { on: false, strength: 2, samples: 10 };
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0.5, FRAME);
    const twSharp = saturation();
    tw.motionBlur.on = true;
    cx.clearRect(0, 0, 1080, 1920);
    TextDraw.draw(cx, clip, 1080, 1920, 0.5, FRAME);
    const twBlur = saturation();
    ok('motion blur applies to typewriter units', twBlur < twSharp * 0.9,
      'sat ' + twSharp.toFixed(3) + ' -> ' + twBlur.toFixed(3));

    // ============================================================ preset panel
    setSelection([clip.id], false);
    renderInspector();
    await new Promise((r) => setTimeout(r, 200));
    const panel = document.querySelector('#textPanel');
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });
    ok('the preset panel offers a typed name field, not a prompt()',
      panel.querySelectorAll('.tc-preset-input').length === 3,
      panel.querySelectorAll('.tc-preset-input').length + ' fields');
    ok('every preset kind lists its saved entries',
      panel.querySelectorAll('.tc-preset-sel').length === 3);

    // Save through the same path the UI uses, then confirm it shows up in the list.
    const data = TextModel.extractPreset('style', clip.card);
    data.name = '__smoke2__';
    await window.api.savePreset('style', '__smoke2__', data);
    await TextUI.reloadPresets();
    const names = [...document.querySelectorAll('#textPanel .tc-preset-sel')][0].options;
    ok('a saved preset appears in the dropdown',
      [...names].some((o) => o.value === '__smoke2__'),
      [...names].map((o) => o.value).join('|'));
    await window.api.deletePreset('style', '__smoke2__');
    await TextUI.reloadPresets();

    // ====================================================== typable + resets
    const numBoxes = panel.querySelectorAll('.tc-num');
    const sliders = panel.querySelectorAll('input[type=range]');
    ok('every slider has a number box beside it', numBoxes.length >= sliders.length,
      sliders.length + ' sliders, ' + numBoxes.length + ' number boxes');
    ok('parameters carry a reset button', panel.querySelectorAll('.tc-reset').length > 20,
      panel.querySelectorAll('.tc-reset').length + ' resets');
    ok('the framing panel is typable too',
      document.querySelectorAll('#framing .tc-num').length === 3 &&
      document.querySelectorAll('#framing .tc-reset').length === 3);

    // A reset button must actually restore the default.
    clip.card.style.fontSize = 321;
    renderInspector();
    const sizeRow = [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === 'style.fontSize');
    ok('found the font size row', !!sizeRow);
    if (sizeRow) {
      sizeRow.querySelector('.tc-reset').click();
      ok('reset restores the default value',
        clip.card.style.fontSize === TextModel.defaultStyle().fontSize,
        'now ' + clip.card.style.fontSize);
    }

    // ================================================ typing into the boxes
    // `user-select: none` on <body> inherits into form fields in Chromium, and a field
    // that inherits it will not take a caret from a mouse click - it looks editable,
    // focuses programmatically, and still cannot be typed into. Inputs must opt back in.
    const anyNum = panel.querySelector('.tc-num');
    const usel = getComputedStyle(anyNum).webkitUserSelect || getComputedStyle(anyNum).userSelect;
    ok('number boxes allow text selection (so a click can place a caret)', usel === 'text',
      'user-select=' + usel);
    const framingNum = document.querySelector('#framing .tc-num');
    ok('framing boxes allow it too',
      (getComputedStyle(framingNum).webkitUserSelect || getComputedStyle(framingNum).userSelect) === 'text');
    const areaSel = getComputedStyle(panel.querySelector('textarea'));
    ok('the text area allows it too',
      (areaSel.webkitUserSelect || areaSel.userSelect) === 'text');

    // Nothing must be sitting on top of the box, and it must not be disabled.
    const r2 = anyNum.getBoundingClientRect();
    const hit = document.elementFromPoint(r2.x + r2.width / 2, r2.y + r2.height / 2);
    ok('the number box is the top element at its own centre', hit === anyNum,
      hit ? hit.tagName + '.' + hit.className : 'null');

    // Typing must reach the model, and the editor's single-key shortcuts must not fire.
    const sizeRow2 = [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === 'style.fontSize');
    const sizeNum = sizeRow2.querySelector('.tc-num');
    sizeNum.focus();
    sizeNum.value = '';
    sizeNum.dispatchEvent(new Event('input', { bubbles: true }));
    sizeNum.value = '246';
    sizeNum.dispatchEvent(new Event('input', { bubbles: true }));
    ok('typing a value updates the card', clip.card.style.fontSize === 246,
      'fontSize=' + clip.card.style.fontSize);
    const kev = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
    sizeNum.dispatchEvent(kev);
    ok('typing does not trigger the editor shortcuts', !kev.defaultPrevented);

    // ==================================================== scroll to adjust
    const wheel = (el, opts) => el.dispatchEvent(new WheelEvent('wheel', Object.assign(
      { deltaY: -100, bubbles: true, cancelable: true }, opts || {})));

    clip.card.style.fontSize = 100;
    renderInspector();
    const row3 = [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === 'style.fontSize');
    const n3 = row3.querySelector('.tc-num');

    wheel(n3);
    ok('scrolling up adds one step', clip.card.style.fontSize === 101,
      'fontSize=' + clip.card.style.fontSize);
    wheel(n3, { deltaY: 100 });
    ok('scrolling down subtracts one step', clip.card.style.fontSize === 100,
      'fontSize=' + clip.card.style.fontSize);
    wheel(n3, { shiftKey: true });
    ok('shift+scroll moves ten steps', clip.card.style.fontSize === 110,
      'fontSize=' + clip.card.style.fontSize);

    // A fine-grained control: 0.01 steps, and ctrl for a tenth of that.
    clip.card.style.glow.spread = 0.4;
    renderInspector();
    const spreadRow = [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === 'style.glow.spread');
    const spreadNum = spreadRow.querySelector('.tc-num');
    wheel(spreadNum);
    ok('scroll steps by 0.05 on a 0.05-step control',
      near(clip.card.style.glow.spread, 0.45, 1e-6), 'spread=' + clip.card.style.glow.spread);
    wheel(spreadNum, { ctrlKey: true });
    ok('ctrl+scroll makes a finer step',
      near(clip.card.style.glow.spread, 0.455, 1e-6), 'spread=' + clip.card.style.glow.spread);

    // The slider half responds too, and the wheel is consumed so the panel stays put.
    const spreadRange = spreadRow.querySelector('input[type=range]');
    const consumed = !spreadRange.dispatchEvent(new WheelEvent('wheel',
      { deltaY: -100, bubbles: true, cancelable: true }));
    ok('scrolling the slider adjusts it as well',
      near(clip.card.style.glow.spread, 0.505, 1e-6), 'spread=' + clip.card.style.glow.spread);
    ok('the wheel event is consumed so the panel does not scroll', consumed);

    // Wheel is clamped to the control's range.
    clip.card.style.glow.spread = 2;
    renderInspector();
    const sr2 = [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === 'style.glow.spread');
    wheel(sr2.querySelector('.tc-num'));
    ok('scroll respects the maximum', clip.card.style.glow.spread === 2,
      'spread=' + clip.card.style.glow.spread);

    // A scroll burst is one undo step, not one per notch.
    clip.card.style.fontSize = 100;
    renderInspector();
    const row4 = [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === 'style.fontSize');
    const n4 = row4.querySelector('.tc-num');
    // Let the previous gesture's idle timer close before starting a fresh burst.
    await new Promise((r) => setTimeout(r, 500));
    const undoBefore = undoStack.length;
    for (let i = 0; i < 5; i++) wheel(n4);
    ok('a burst of scrolling is a single undo entry', undoStack.length === undoBefore + 1,
      'undo grew by ' + (undoStack.length - undoBefore));

    // A slider drag must CLOSE its edit gesture. If it does not, the "one snapshot per
    // gesture" flag stays stuck on and undo silently stops recording everything after it.
    await new Promise((r) => setTimeout(r, 500));
    const sliderRow = [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === 'style.fontSize');
    const sl = sliderRow.querySelector('input[type=range]');
    const u0 = undoStack.length;
    sl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    sl.value = '200';
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    ok('a slider drag records one undo entry', undoStack.length === u0 + 1,
      'undo grew by ' + (undoStack.length - u0));

    const u1 = undoStack.length;
    sl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    sl.value = '150';
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    ok('undo keeps recording after a previous drag', undoStack.length === u1 + 1,
      'undo grew by ' + (undoStack.length - u1));

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
