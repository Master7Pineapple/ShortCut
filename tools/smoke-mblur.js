/**
 * Motion blur over soft pixels, and the preset bar's Delete / Apply-to-selection.
 *
 * The motion blur half is the load-bearing one. A straight `lighter` accumulation at
 * globalAlpha = 1/samples quantises every pixel below alpha `samples/2` to ZERO, so a
 * card's glow and drop shadow - which live almost entirely in that range - were destroyed
 * by motion blur instead of being smeared by it, and destroyed HARDER the more samples
 * you asked for. These tests pin the three properties that were wrong:
 *
 *   1. the soft parts must survive at all,
 *   2. what comes out must not depend on the sample count, and
 *   3. more strength must mean more smear.
 *
 *   SHORTCUT_SMOKE=tools/smoke-mblur.js node_modules/.bin/electron .
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));

    const W = 1080, H = 1920;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');

    const clip = addTextCard('O');
    clip.start = 0; clip.out = 4;
    const st = clip.card.style;
    st.fontSize = 160;
    st.x = 0.7;                 // clear of both edges, so nothing is measured against a clip
    st.fill.color = '#ffffff';
    st.glow.on = false;
    st.shadow.on = false;

    // One fast linear slide, so the card genuinely moves across the shutter.
    const layer = TextModel.defaultAnim('slide', 'in');
    layer.easing = { kind: 'named', name: 'linear' };
    layer.duration = 2; layer.start = 0;
    layer.params = { from: 'left', distance: 0.8 };
    clip.card.anims = [layer];
    clip.card.animEnabled = true;

    /** Alpha along one scanline through the middle of the card. */
    const scan = (samples, strength) => {
      layer.motionBlur = { on: samples > 0, strength, samples: samples || 8 };
      cx.clearRect(0, 0, W, H);
      TextDraw.draw(cx, clip, W, H, 1, samples > 0 ? 1 / 30 : 0);
      const d = cx.getImageData(0, Math.round(H / 2), W, 1).data;
      const a = [];
      for (let x = 0; x < W; x++) a.push(d[x * 4 + 3]);
      return a;
    };
    /** How many columns reach at least `thr` alpha - the width at a given brightness. */
    const width = (row, thr) => row.filter((v) => v >= thr).length;
    const total = (row) => row.reduce((s, v) => s + v, 0);

    // ================================================== a soft drop shadow

    st.shadow.on = true;
    st.shadow.blur = 60; st.shadow.distance = 0;
    st.shadow.opacity = 1; st.shadow.color = '#ffffff';

    const shSharp = scan(0, 0);
    const sh8 = scan(8, 2);
    const sh16 = scan(16, 2);
    const sh32 = scan(32, 2);

    // The bug in one assertion: the shadow's BODY used to come out NARROWER than the
    // un-blurred card (109 columns -> 68), because most of it was quantised away.
    ok('motion blur widens a soft shadow instead of eating it',
      width(sh16, 100) > width(shSharp, 100),
      width(shSharp, 100) + ' -> ' + width(sh16, 100) + ' columns at alpha>=100');

    // Sample count is a quality knob. It must not change how much shadow there is.
    const shSpread = [total(sh8), total(sh16), total(sh32)];
    ok('the shadow does not depend on the sample count',
      Math.max(...shSpread) - Math.min(...shSpread) < Math.max(...shSpread) * 0.03,
      shSpread.join(' / '));
    ok('more samples never means less shadow',
      total(sh32) > total(sh8) * 0.97, total(sh8) + ' -> ' + total(sh32));

    // The whole point of motion blur: the crisp core smears out as the shutter opens.
    ok('the shadow core smears away as strength rises',
      width(scan(16, 0.5), 250) > width(scan(16, 2), 250),
      width(scan(16, 0.5), 250) + ' -> ' + width(scan(16, 2), 250) + ' columns at alpha>=250');

    // ============================================================== a glow

    st.shadow.on = false;
    st.glow.on = true; st.glow.over = 0;
    st.glow.size = 50; st.glow.intensity = 3; st.glow.color = '#ffffff';

    const glSharp = scan(0, 0);
    const glHalf = scan(16, 0.5);
    const glFull = scan(16, 2);
    const gl32 = scan(32, 2);

    ok('a glow spreads under motion blur', width(glFull, 2) > width(glSharp, 2),
      width(glSharp, 2) + ' -> ' + width(glFull, 2) + ' columns at alpha>=2');
    ok('the spread grows with strength - strength still drives it',
      width(glFull, 2) > width(glHalf, 2),
      'str 0.5: ' + width(glHalf, 2) + '  str 2: ' + width(glFull, 2));
    ok('the glow spread does not shrink at high sample counts',
      width(gl32, 2) >= width(glFull, 2) * 0.98,
      '16 samples: ' + width(glFull, 2) + '  32: ' + width(gl32, 2));
    ok('the glow body is not dimmed by blurring it',
      total(glFull) > total(glSharp) * 0.9,
      total(glSharp) + ' -> ' + total(glFull));

    // The glow-over-glyphs path routes through an extra offscreen layer, which is exactly
    // the kind of place a shared scratch canvas gets clobbered by the sampler.
    st.glow.over = 0.6;
    const overSharp = scan(0, 0), overBlur = scan(16, 2);
    ok('glow-over-glyphs blurs too, and does not vanish',
      width(overBlur, 2) > width(overSharp, 2) && total(overBlur) > total(overSharp) * 0.9,
      width(overSharp, 2) + ' -> ' + width(overBlur, 2));
    st.glow.over = 0;

    // ============================================== the averaging itself

    // A flat, constant image must come back unchanged whatever the sample count: this is
    // an AVERAGE, and averaging a constant is that constant. It is also the assertion that
    // catches a weighting mistake, which a moving picture would hide inside the smear.
    const flatOut = (samples, alpha) => {
      const dest = document.createElement('canvas');
      dest.width = 64; dest.height = 64;
      const dctx = dest.getContext('2d');
      const pool = {};
      const surface = (name, w, h) => {
        let c = pool[name];
        if (!c) c = pool[name] = document.createElement('canvas');
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        return c;
      };
      Anim.temporalAverage(dctx, 64, 64, samples, (sctx) => {
        sctx.fillStyle = 'rgba(255,255,255,' + (alpha / 255) + ')';
        sctx.fillRect(0, 0, 64, 64);
      }, surface, 'flat');
      return dctx.getImageData(32, 32, 1, 1).data[3];
    };
    // Within one 8-bit step, not exact: the group weights are rounded per draw, so a
    // sample count that does not divide evenly (31 into 6 groups) can land a single
    // level low. One part in 255 on a flat field is the price of the grouping, and it
    // buys back everything below alpha 16 that the old accumulator threw away.
    ok('averaging a constant opaque image is a no-op at every sample count',
      [2, 5, 8, 16, 31, 32].every((n) => flatOut(n, 255) >= 254),
      [2, 5, 8, 16, 31, 32].map((n) => n + ':' + flatOut(n, 255)).join(' '));

    // The regression itself, isolated: alpha 6 out of 255 used to become 0 at 16 samples
    // (round(6/16) = 0) and 0 at 32. It must survive.
    const faint = [2, 5, 8, 16, 31, 32].map((n) => flatOut(n, 6));
    ok('a faint constant survives averaging at every sample count', faint.every((v) => v > 0),
      [2, 5, 8, 16, 31, 32].map((n, i) => n + ':' + faint[i]).join(' '));
    ok('a faint constant stays near its true value', faint.every((v) => Math.abs(v - 6) <= 2),
      faint.join(' '));
    ok('an odd sample count is not mishandled',
      flatOut(31, 255) >= 254 && flatOut(5, 255) >= 254 && Math.abs(flatOut(7, 128) - 128) <= 2,
      '31:' + flatOut(31, 255) + ' 5:' + flatOut(5, 255) + ' 7@128:' + flatOut(7, 128));
    ok('one sample is passed straight through', flatOut(1, 77) === 77, String(flatOut(1, 77)));

    // ==================================== transitions use the same averaging
    ok('there is one shared shutter, on Anim', typeof Anim.temporalAverage === 'function');

    // ============================================ preset bar: Delete works

    setSelection([clip.id], false);
    renderInspector();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });

    const NAME = '__smoke_mblur__';
    const payload = TextModel.extractPreset('style', clip.card);
    payload.name = NAME;
    await window.api.savePreset('style', NAME, payload);
    await TextUI.reloadPresets();
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });

    const styleBox = document.querySelectorAll('#textPanel .tc-preset-box')[0];
    const styleSel = styleBox.querySelector('.tc-preset-sel');
    ok('the saved preset is listed', [...styleSel.options].some((o) => o.value === NAME));

    // Pick it the way a person does - a real 'change' event - then force the rebuild that
    // applying one causes. This is the exact sequence that used to blank the selection.
    styleSel.value = NAME;
    styleSel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 250));
    renderInspector();
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });

    const box2 = document.querySelectorAll('#textPanel .tc-preset-box')[0];
    ok('the panel remembers which preset is selected after it rebuilds',
      box2.querySelector('.tc-preset-sel').value === NAME,
      '"' + box2.querySelector('.tc-preset-sel').value + '"');

    const delBtn = [...box2.querySelectorAll('.tc-preset-acts button')]
      .find((b) => b.textContent === 'Delete');
    ok('the style box has a Delete button', !!delBtn);
    delBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    const after = await window.api.listPresets();
    ok('Delete actually removes the preset from the library',
      !(after.style || []).includes(NAME),
      (after.style || []).join('|') || '(none)');

    // ================================== preset bar: apply to selected cards

    renderInspector();
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });
    let spread = document.querySelector('#textPanel .tc-preset-spread');
    ok('there is an "Apply to selected cards" button', !!spread,
      spread ? spread.textContent : '(missing)');
    ok('it is disabled with only one card selected', !!spread && spread.disabled);

    // Two more cards, each deliberately different from the lead and from each other.
    const c2 = addTextCard('SECOND');
    c2.start = 6; c2.card.style.fontSize = 40; c2.card.style.fill.color = '#ff0000';
    const c3 = addTextCard('THIRD');
    c3.start = 10; c3.card.style.fontSize = 55; c3.card.style.fill.color = '#00ff00';
    setSelection([clip.id, c2.id, c3.id], false);
    renderInspector();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });

    // The lead is whichever card the panel decided to show - it is chosen in DISPLAY
    // order (top track first, then by start), not by which card was made first, so the
    // test asks rather than assumes.
    const lead = selectedTextClip();
    const followers = selectedTextClips().filter((c) => c !== lead);
    ok('a three-card selection has one lead and two followers',
      !!lead && followers.length === 2,
      lead ? lead.card.text + ' leads' : 'no lead');
    lead.card.style.fontSize = 123;
    lead.card.style.fill.color = '#0000ff';
    const wording = followers.map((c) => c.card.text);
    const sizesBefore = followers.map((c) => c.card.style.fontSize);
    spread = document.querySelector('#textPanel .tc-preset-spread');
    ok('the button enables and counts the selection with several cards selected',
      !!spread && !spread.disabled && spread.textContent.indexOf('(3)') > 0,
      spread ? spread.textContent : '(missing)');

    const undoBefore = undoStack.length;
    spread.click();
    ok('the style reaches every other selected card',
      followers.every((c) => c.card.style.fontSize === 123 &&
        c.card.style.fill.color === '#0000ff'),
      followers.map((c) => c.card.style.fontSize + ' ' + c.card.style.fill.color).join(' / '));
    ok('the WORDING of each card is left alone',
      followers.every((c, i) => c.card.text === wording[i]),
      followers.map((c) => c.card.text).join(' / '));
    ok('spreading a style is ONE undo entry', undoStack.length === undoBefore + 1,
      undoBefore + ' -> ' + undoStack.length);
    undo();
    const live = allClips().map((x) => x.clip).filter((c) => c.kind === 'text');
    const restored = wording.map((w) => live.find((c) => c.card.text === w));
    ok('one undo puts every card back',
      restored.every((c, i) => c && c.card.style.fontSize === sizesBefore[i]),
      restored.map((c, i) => (c ? c.card.style.fontSize : '?') + ' was ' + sizesBefore[i]).join(' / '));

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
