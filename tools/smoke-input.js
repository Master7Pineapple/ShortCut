/**
 * Can the user actually type into the controls?
 *
 *   SHORTCUT_SMOKE=tools/smoke-input.js node_modules/.bin/electron .
 *
 * This suite uses REAL input injected through Electron (`window.api.sendInput`, which is
 * only wired up while a smoke script is running). That matters: a MouseEvent dispatched
 * from a script is untrusted and never performs the default action, so it cannot focus a
 * field - a test built on those passes happily against a field nobody can click into,
 * which is exactly how a `user-select: none` inherited into the inputs went unnoticed.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';

    const centreOf = (el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    };
    const realClick = async (el, clicks) => {
      const p = centreOf(el);
      await sleep(120);
      const q = centreOf(el);   // re-read after any scrolling
      await window.api.sendInput({ type: 'mouseDown', x: q.x, y: q.y, button: 'left', clickCount: clicks || 1 });
      await window.api.sendInput({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: clicks || 1 });
      await sleep(180);
      return q;
    };
    const realType = async (text) => {
      for (const ch of String(text)) {
        await window.api.sendInput({ type: 'keyDown', keyCode: ch });
        await window.api.sendInput({ type: 'char', keyCode: ch });
        await window.api.sendInput({ type: 'keyUp', keyCode: ch });
        await sleep(45);
      }
      await sleep(200);
    };

    await importPaths([D + 'clip1.mp4']);
    await sleep(900);
    seek(0.5);

    const card = addTextCard('TYPE TEST');
    setSelection([card.id], false);
    renderInspector();
    await sleep(400);
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });
    await sleep(200);

    const rowFor = (path) => [...document.querySelectorAll('#textPanel .tc-row')]
      .find((r) => r.querySelector('.tc-label') && r.querySelector('.tc-label').title === path);

    // ---- the inputs must not inherit user-select:none from <body> -------------
    const anyNum = document.querySelector('#textPanel .tc-num');
    const cs = getComputedStyle(anyNum);
    ok('number boxes allow text selection',
      (cs.webkitUserSelect || cs.userSelect) === 'text',
      'user-select=' + (cs.webkitUserSelect || cs.userSelect));

    // ---- clicking a number box focuses it, and typing reaches the model -------
    let num = rowFor('style.fontSize').querySelector('.tc-num');
    await realClick(num, 3);              // triple click selects the existing value
    ok('a real click focuses the number box', document.activeElement === num,
      document.activeElement.tagName + '.' + document.activeElement.className);
    await realType('275');
    num = rowFor('style.fontSize').querySelector('.tc-num');
    ok('typing a number reaches the card', card.card.style.fontSize === 275,
      'fontSize=' + card.card.style.fontSize + ' box=' + num.value);
    ok('the box keeps focus while typing', document.activeElement === num);

    // ---- a fractional value, on a fine-grained control -----------------------
    const spread = rowFor('style.glow.spread').querySelector('.tc-num');
    await realClick(spread, 3);
    await realType('1.25');
    ok('a decimal value is accepted', Math.abs(card.card.style.glow.spread - 1.25) < 1e-6,
      'spread=' + card.card.style.glow.spread);

    // ---- the text area ------------------------------------------------------
    const area = document.querySelector('#textPanel textarea');
    await realClick(area, 3);
    ok('a real click focuses the text area', document.activeElement === area);
    await realType('HELLO');
    ok('typing reaches the card text', card.card.text === 'HELLO', 'text="' + card.card.text + '"');

    // ---- still typable after using other parts of the UI ---------------------
    // Sliders and the timeline both install document-level pointer handlers; a leftover
    // one would swallow the click that should focus the next field.
    const sizeRow = rowFor('style.fontSize');
    const slider = sizeRow.querySelector('input[type=range]');
    const sp = centreOf(slider);
    await window.api.sendInput({ type: 'mouseDown', x: sp.x, y: sp.y, button: 'left', clickCount: 1 });
    await window.api.sendInput({ type: 'mouseMove', x: sp.x + 20, y: sp.y, button: 'left' });
    await window.api.sendInput({ type: 'mouseUp', x: sp.x + 20, y: sp.y, button: 'left', clickCount: 1 });
    await sleep(200);

    const lh = rowFor('style.lineHeight').querySelector('.tc-num');
    await realClick(lh, 3);
    ok('a field is still focusable after dragging a slider', document.activeElement === lh,
      document.activeElement.tagName + '.' + document.activeElement.className);
    await realType('1.8');
    ok('and still typable', Math.abs(card.card.style.lineHeight - 1.8) < 1e-6,
      'lineHeight=' + card.card.style.lineHeight);

    // Click a clip on the timeline (which starts and ends a drag), then type again.
    const clipEl = document.querySelector('#tracks .clip');
    await realClick(clipEl, 1);
    await sleep(250);
    setSelection([card.id], false);
    renderInspector();
    await sleep(350);
    document.querySelectorAll('#textPanel details').forEach((d) => { d.open = true; });
    await sleep(150);
    const tracking = rowFor('style.letterSpacing').querySelector('.tc-num');
    await realClick(tracking, 3);
    ok('a field is still focusable after using the timeline',
      document.activeElement === tracking,
      document.activeElement.tagName + '.' + document.activeElement.className);
    await realType('12');
    ok('and still typable after the timeline',
      Math.abs(card.card.style.letterSpacing - 12) < 1e-6,
      'letterSpacing=' + card.card.style.letterSpacing);

    // ---- the framing boxes in the inspector ---------------------------------
    // The card sits on its own video track, so search every track for real footage.
    const vclip = allClips().map((x) => x.clip).find((c) => c.kind === 'video');
    setSelection([vclip.id], false);
    renderInspector();
    await sleep(300);
    const panN = document.querySelector('#panXv');
    ok('framing boxes are enabled with a video clip selected', !panN.disabled);
    await realClick(panN, 3);
    ok('a real click focuses a framing box', document.activeElement === panN,
      document.activeElement.tagName + '.' + document.activeElement.className);
    await realType('0.25');
    ok('typing reaches the clip framing', Math.abs(vclip.panX - 0.25) < 1e-6,
      'panX=' + vclip.panX);

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return 'ERR ' + (e && e.stack ? e.stack : e);
  }
})()
