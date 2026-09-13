/**
 * The agent API: the op vocabulary, batches, references, rollback, the catalog and the
 * B2B template compiler.
 *
 *   SHORTCUT_SMOKE=tools/smoke-agent.js node_modules/.bin/electron .
 *
 * What it exists to prove:
 *   - a batch is ONE undo entry however many edits it makes, and undoing it restores the
 *     timeline exactly - the rule every panel in app.js already keeps;
 *   - a failing op rolls the WHOLE batch back, names the op that failed, and leaves the
 *     undo stack and pushUndo() exactly as they were;
 *   - `as`/`$ref` resolution, including a `.field` path and a reference to nothing;
 *   - the catalog is built from the live tables (FX.DEFS, Graphics.DEFS, Trans.TYPES), so
 *     a new effect type is published the moment it exists;
 *   - the punch-in math holds its focus point still under the scale;
 *   - `expand()` is pure and deterministic, and refuses a spec it cannot build;
 *   - with a fixture: media placement, `reframe` cutting a clip into contiguous pieces, and
 *     `lint fix` turning flat stretches into none.
 *
 * The last section needs `flat_blue.mp4` in %TEMP%\scut_test (smoke-layers.js's fixture)
 * and skips without it. Everything else needs nothing.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);
    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-6);

    newProject();

    // ============================================================ the catalog
    const cat = Agent.catalog();
    ok('catalog publishes every effect type', FX.TYPES.every((t) => cat.effects[t] && cat.effects[t].params));
    ok('catalog publishes every graphic type', Graphics.TYPES.every((t) => cat.graphics[t] && cat.graphics[t].schema.length));
    ok('catalog publishes every transition type', Object.keys(Trans.TYPES).every((t) => cat.transitions[t]));
    ok('every op carries a doc string', Object.keys(Agent.OPS).every((k) => typeof cat.ops[k] === 'string' && cat.ops[k].length > 10));
    ok('catalog is plain JSON', JSON.stringify(JSON.parse(JSON.stringify(cat))).length > 1000);

    // ============================================================ a batch, refs, one undo
    const depth0 = undoStack.length;
    const pushBefore = pushUndo;
    const r1 = await Agent.run([
      { op: 'text', text: 'Hello', start: 0, len: 2, anims: 'pop', as: 'title' },
      { op: 'graphic', type: 'counter', start: 1, len: 3, params: { to: 500 }, as: 'num' },
      { op: 'effect', clip: '$num', type: 'transform', keys: { scale: [{ t: 0, v: 0.8 }, { t: 1, v: 1, ease: 'backOut' }] }, as: 'tf' },
      { op: 'set', clip: '$title', text: 'Hello agent', style: { fontSize: 80 } },
      { op: 'keys', clip: '$num', on: 'graphic', prop: 'to', keys: [{ t: 0, v: 100 }, { t: 2, v: 900 }] },
    ]);
    ok('a five-op batch succeeds', r1.ok, r1.error);
    ok('the batch is ONE undo entry', undoStack.length === depth0 + 1, 'depth ' + depth0 + ' -> ' + undoStack.length);
    ok('pushUndo is restored after a batch', pushUndo === pushBefore);
    ok('Agent.busy is cleared after a batch', Agent.busy === false && !quietUI());
    const title = findClip(r1.results[0].result.id);
    ok('$ref resolved into set: the card text changed', title && title.clip.card.text === 'Hello agent' && title.clip.card.style.fontSize === 80);
    const num = findClip(r1.results[1].result.id).clip;
    ok('fx keys landed on the effect', num.fx && num.fx[0].keys && num.fx[0].keys.scale.length === 2);
    ok('graphic keys landed on the graphic', num.graphic.keys && num.graphic.keys.to.length === 2);
    ok('easing names become easing descriptors', num.fx[0].keys.scale[1].ease && num.fx[0].keys.scale[1].ease.kind === 'named');
    undo();
    ok('one undo removes the whole batch', allClips().length === 0, allClips().length + ' clip(s) left');
    redo();
    ok('redo brings it back', allClips().length === 2);

    // ============================================================ rollback
    const snapBefore = snapshot();
    const depth1 = undoStack.length;
    const r2 = await Agent.run([
      { op: 'text', text: 'will vanish', start: 5, len: 1 },
      { op: 'graphic', type: 'no-such-type', start: 0 },
    ]);
    ok('a failing batch reports ok:false', r2.ok === false && r2.failedAt === 1 && r2.op === 'graphic', JSON.stringify(r2.error));
    ok('the error names the valid choices', /one of/.test(r2.error || ''));
    ok('the failing batch is ROLLED BACK', snapshot() === snapBefore);
    ok('and pushed no undo entry', undoStack.length === depth1);
    ok('pushUndo is restored after a failure', pushUndo === pushBefore);
    const r3 = await Agent.run([{ op: 'frobnicate' }]);
    ok('an unknown op is refused by name', r3.ok === false && /unknown op "frobnicate"/.test(r3.error));
    const r4 = await Agent.run([{ op: 'set', clip: '$nothing', name: 'x' }]);
    ok('a reference to nothing is refused', r4.ok === false && /unknown reference/.test(r4.error));
    const r5 = await Agent.run([{ op: 'text', text: 'keep', start: 9 }, { op: 'graphic', type: 'bad' }], { atomic: false });
    ok('atomic:false keeps what succeeded', r5.ok === false && r5.rolledBack === false && allClips().some((x) => x.clip.card && x.clip.card.text === 'keep'));
    const r6 = await Agent.run([{ op: 'hooks', len: 2 }, { op: 'graphic', type: 'counter', start: 0, as: 'g' }, { op: 'set', clip: '$g.id', name: 'via field' }]);
    ok('$ref.field paths resolve', r6.ok && findClip(r6.results[1].result.id).clip.name === 'via field', r6.error);

    // ============================================================ punch-in math
    newProject();
    const r7 = await Agent.run([
      { op: 'graphic', type: 'rect', start: 0, len: 4, as: 'r' },
      { op: 'punchIn', clip: '$r', at: 1, scale: 1.5, ramp: 0.2, x: 0.3, y: 0.7 },
    ]);
    ok('punchIn runs', r7.ok, r7.error);
    const rc = findClip(r7.results[0].result.id).clip;
    const tf = rc.fx.find((f) => f.gen === 'agent-punch');
    const P = FX.paramsAt(tf, 2);
    // screen = anchor + (p - anchor) * s + offset, with the anchor in the middle
    const sx = 0.5 + (0.3 - 0.5) * P.scale + P.x, sy = 0.5 + (0.7 - 0.5) * P.scale + P.y;
    ok('the punch reaches its scale after the ramp', near(P.scale, 1.5, 1e-6), 'scale ' + P.scale);
    ok('THE FOCUS POINT STAYS PUT under the punch', near(sx, 0.3, 1e-9) && near(sy, 0.7, 1e-9), sx + ',' + sy);
    ok('before the punch the clip is untouched', near(FX.paramsAt(tf, 0.5).scale, 1, 1e-9));

    // ============================================================ cuts and transitions
    newProject();
    const r8 = await Agent.run([
      { op: 'text', text: 'A', start: 0, len: 2, track: 'V1', as: 'a' },
      { op: 'text', text: 'B', start: 2, len: 2, track: 'V1', as: 'b' },
      { op: 'transition', at: 2, type: 'morph', duration: 0.4, as: 'tr' },
      { op: 'split', at: 1 },
    ]);
    ok('transition on a cut between two cards', r8.ok && r8.results[2].result.at === 2, r8.error);
    ok('split made a new clip', r8.ok && r8.results[3].result.made.length === 1);
    const r9 = await Agent.run([{ op: 'transition', at: 7 }]);
    ok('a transition where there is no cut is refused', r9.ok === false && /no cut/.test(r9.error));

    // ============================================================ lint and describe
    newProject();
    await Agent.run([{ op: 'graphic', type: 'rect', start: 0, len: 10 }]);
    const r10 = await Agent.run([{ op: 'lint', maxGap: 3 }]);
    ok('the lint finds a flat ten seconds', r10.ok && r10.results[0].result.flat.length >= 1, JSON.stringify(r10.results[0] && r10.results[0].result.flat));
    const d = Agent.describe({ full: true });
    ok('describe: tracks, clips, lint, out', Array.isArray(d.tracks) && d.tracks.some((t) => t.clips.length) && Array.isArray(d.lint) && d.out.w > 0);
    ok('describe is plain JSON', !!JSON.parse(JSON.stringify(d)));

    // ============================================================ the template
    const spec = {
      beats: [
        { type: 'hook', from: 0, to: 3, source: { src: 'C:/x/head.mp4', in: 4 }, text: 'Claim' },
        { type: 'proof', from: 3, to: 6, graphics: [{ type: 'counter', params: { to: 90 } }, { type: 'ring' }] },
        { type: 'mechanism', from: 6, to: 9, graphic: { type: 'funnel' } },
        { type: 'cta', from: 9, to: 11, text: 'Book a demo' },
      ],
      sounds: { impact: 'C:/x/hit.wav' },
      deliver: { dir: 'C:/x/out', cover: 1 },
    };
    const e1 = Agent.expand(spec), e2 = Agent.expand(JSON.parse(JSON.stringify(spec)));
    ok('expand is deterministic', JSON.stringify(e1) === JSON.stringify(e2));
    ok('expand uses only known ops', e1.every((o) => Agent.OPS[o.op]), e1.map((o) => o.op).filter((n) => !Agent.OPS[n]).join(','));
    ok('expand punches the hook and lands impacts on proof', e1.some((o) => o.op === 'punchIn') && e1.filter((o) => o.op === 'sfx').length === 3);
    ok('expand ends in lint, covers and deliver', ['lint', 'delivery', 'covers', 'deliver'].every((n) => e1.some((o) => o.op === n)));
    const refsOk = e1.every((o, i) => JSON.stringify(o).match(/"\$[A-Za-z_]\w*/g) === null ||
      JSON.stringify(o).match(/"\$([A-Za-z_]\w*)/g).every((m) => e1.slice(0, i).some((p) => p.as === m.slice(2))));
    ok('every $ref in the expansion names an EARLIER op', refsOk);
    let threw = null;
    try { Agent.expand({ beats: [{ type: 'hook', from: 0, to: 2 }] }); } catch (e) { threw = e.message; }
    ok('a hook with no source is refused', /needs source.src/.test(threw || ''), threw);
    const mech = await Agent.run(Agent.expand({ beats: [
      { type: 'mechanism', from: 0, to: 3, graphic: { type: 'flow' } },
      { type: 'cta', from: 3, to: 5, text: 'Try it' },
    ], lint: { fix: false } }));
    ok('a media-free spec builds end to end', mech.ok, mech.error);
    ok('and its plates, diagram and CTA are on the timeline', mech.ok && allClips().filter((x) => x.clip.kind === 'graphic').length === 3 && allClips().some((x) => x.clip.card && x.clip.card.text === 'Try it'));

    // ============================================================ with a fixture
    const fixture = await window.api.fileExists(D + 'flat_blue.mp4');
    if (!fixture) {
      note('SKIP fixture section: flat_blue.mp4 is not in %TEMP%\\scut_test');
    } else {
      newProject();
      const m = await Agent.run([{ op: 'media', path: D + 'flat_blue.mp4', as: 'm' }]);
      ok('media probes a file', m.ok && m.results[0].result.duration > 0, m.error);
      const dur = m.ok ? m.results[0].result.duration : 0;
      const len = Math.min(dur, 3);
      const r11 = await Agent.run([
        { op: 'clip', src: D + 'flat_blue.mp4', start: 0, len, as: 'v' },
        { op: 'reframe', clip: '$v', every: 1, as: 'pieces' },
      ]);
      ok('clip + reframe run', r11.ok, r11.error);
      if (r11.ok) {
        const ids = r11.results[1].result.ids;
        const pieces = ids.map((id) => findClip(id).clip);
        ok('reframe cut the clip into pieces', pieces.length >= 2, pieces.length + ' piece(s)');
        ok('the pieces are contiguous on the timeline',
          pieces.every((p, i) => i === 0 || near(p.start, clipEnd(pieces[i - 1]), 1e-6)));
        ok('and contiguous in the source', pieces.every((p, i) => i === 0 || near(p.in, pieces[i - 1].out, 1e-6)));
        ok('with different framings', new Set(pieces.map((p) => p.zoom)).size > 1);
      }
      if (dur >= 2.5) {
        newProject();
        const r12 = await Agent.run([{ op: 'clip', src: D + 'flat_blue.mp4', start: 0, as: 'v' }, { op: 'set', clip: '$v', len: 0 + dur }]);
        const flat0 = runLint();
        const r13 = await Agent.run([{ op: 'lint', maxGap: 1, fix: true }]);
        ok('lint fix puts something in every flat stretch',
          r12.ok && r13.ok && flat0.length > 0 && r13.results[0].result.fixed > 0 && r13.results[0].result.flat.length === 0,
          'before ' + flat0.length + ', after ' + (r13.ok ? r13.results[0].result.flat.length : r13.error));
      } else note('SKIP lint-fix: the fixture is shorter than 2.5 s');
    }

    newProject();
    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
