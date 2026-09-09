/**
 * Smoke test for transcription and captions. Runs inside the live renderer:
 *
 *   set SHORTCUT_SMOKE=tools\smoke-captions.js && npx electron .        (cmd)
 *   SHORTCUT_SMOKE=tools/smoke-captions.js node_modules/.bin/electron . (bash)
 *
 * It needs NO fixture and NO whisper.cpp. The transcript is injected through
 * `setTranscript()` - the same entry point "Import transcript" uses - because what is
 * under test here is the pipeline from words to caption cards, not somebody's decoder.
 * The parser is tested against hand-written whisper JSON, which is exactly what makes it
 * testable on a machine with no model on it; section 8 checks the real IPC handler only
 * for the way it FAILS, which is the part that must work offline.
 */
(async () => {
  const results = [];
  const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.005 : tol);

  try {
    // ================================================ 1. the whisper parser
    // One segment, tokens in MILLISECONDS, with the sub-word split whisper really emits
    // ("Ship" + "ping") and the special tokens it wraps segments in.
    const doc = {
      transcription: [{
        offsets: { from: 0, to: 2000 },
        text: ' Shipping faster today.',
        tokens: [
          { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 1 },
          { text: ' Ship', offsets: { from: 200, to: 400 }, p: 0.9 },
          { text: 'ping', offsets: { from: 400, to: 560 }, p: 0.8 },
          { text: ' faster', offsets: { from: 600, to: 950 }, p: 0.95 },
          { text: ' today.', offsets: { from: 1000, to: 1400 }, p: 0.7 },
          { text: '[_TT_170]', offsets: { from: 1400, to: 1400 }, p: 1 },
        ],
      }],
    };
    const w = Captions.parseWhisper(doc);
    ok('whisper tokens become three words', w.length === 3, JSON.stringify(w.map((x) => x.w)));
    ok('a sub-word continuation joins its word', w[0] && w[0].w === 'Shipping', w[0] && w[0].w);
    ok('word timings are the tokens\' own, in seconds',
      w[0] && near(w[0].start, 0.2) && near(w[0].end, 0.56), JSON.stringify(w[0]));
    ok('a joined word keeps the LOWEST token confidence', w[0] && near(w[0].conf, 0.8, 0.001), w[0] && w[0].conf);
    // [_TT_170] has no trailing underscore, and a pattern that assumed one let it ride
    // along on the end of the last real word of every segment.
    ok('special tokens are dropped, including the ones without a trailing _',
      w.every((x) => !/\[_/.test(x.w)), JSON.stringify(w.map((x) => x.w)));

    // ---- the DTW path, which is where real word timings actually come from.
    // Whisper's per-token `offsets` are the SEGMENT's bounds copied onto every token:
    // note that below the first token gets 130-2830 and every other one 2830-2830. Only
    // `t_dtw` (in 10ms units) is a real per-token time. This is the shape a run with
    // `-nfa --dtw base.en` produces, and it is a transcript of a real clip.
    const dtwDoc = {
      transcription: [{
        offsets: { from: 0, to: 30000 },
        text: ' That restaurant is 100% AI.',
        tokens: [
          { text: ' That', offsets: { from: 130, to: 2830 }, t_dtw: 28, p: 0.51 },
          { text: ' restaurant', offsets: { from: 2830, to: 2830 }, t_dtw: 72, p: 0.97 },
          { text: ' is', offsets: { from: 2830, to: 2830 }, t_dtw: 104, p: 0.99 },
          { text: ' 100', offsets: { from: 2830, to: 2830 }, t_dtw: 136, p: 0.94 },
          { text: '%', offsets: { from: 2830, to: 2830 }, t_dtw: 194, p: 0.81 },
          { text: ' AI', offsets: { from: 2830, to: 2830 }, t_dtw: 230, p: 0.87 },
          { text: '.', offsets: { from: 2830, to: 2830 }, t_dtw: 280, p: 0.80 },
          { text: '<|endoftext|>', offsets: { from: 30000, to: 30000 }, t_dtw: -1, p: 0.77 },
        ],
      }],
    };
    const dw = Captions.parseWhisper(dtwDoc, 2.833);
    ok('t_dtw is preferred over the segment bounds every token carries',
      dw.length === 5 && near(dw[0].start, 0.28) && near(dw[1].start, 0.72),
      JSON.stringify(dw.map((x) => [x.w, x.start, x.end])));
    ok('a word ends where the next one begins - t_dtw is an instant, not a span',
      near(dw[0].end, 0.72) && near(dw[2].end, 1.36), JSON.stringify(dw.map((x) => x.end)));
    ok('the last word ends on its own trailing token, not on the segment',
      near(dw[4].end, 2.80), dw[4] && dw[4].end);
    ok('`<|endoftext|>` is dropped, like the bracketed specials',
      dw.every((x) => !/[<[]\|?_/.test(x.w)), JSON.stringify(dw.map((x) => x.w)));
    ok('and whisper pads to 30s, so the tail is clipped to the real duration',
      dw.every((x) => x.end <= 2.833 + 1e-6), JSON.stringify(dw.map((x) => x.end)));
    ok('punctuation stays attached to its word', dw[4] && dw[4].w === 'AI.', dw[4] && dw[4].w);
    // No t_dtw anywhere (flash attention left on, or an older build) - fall back rather
    // than produce nothing.
    const noDtw = Captions.parseWhisper({
      transcription: [{ offsets: { from: 0, to: 2000 }, text: ' a b',
        tokens: [{ text: ' a', offsets: { from: 100, to: 900 }, t_dtw: -1, p: 1 },
                 { text: ' b', offsets: { from: 900, to: 1800 }, t_dtw: -1, p: 1 }] }],
    });
    ok('with no DTW at all it falls back to the offsets instead of failing',
      noDtw.length === 2 && near(noDtw[0].start, 0.1), JSON.stringify(noDtw));

    // A plain --output-json has no tokens: the segment is spread across its own span.
    const flat = Captions.parseWhisper({
      transcription: [{ offsets: { from: 1000, to: 3000 }, text: 'one two', tokens: [] }],
    });
    ok('a token-less segment still yields words', flat.length === 2, JSON.stringify(flat));
    ok('and they span the segment exactly',
      near(flat[0].start, 1.0) && near(flat[1].end, 3.0), JSON.stringify(flat));
    ok('they are marked low-confidence, since the timing is inferred',
      flat.every((x) => x.conf <= 0.5));

    const srt = Captions.parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n' +
      '2\n00:00:03,500 --> 00:00:04,000\nagain\n');
    ok('SRT cues parse into words', srt.length === 3, JSON.stringify(srt.map((x) => x.w)));
    ok('and the second cue starts at 3.5s', near(srt[2].start, 3.5), srt[2] && srt[2].start);
    ok('parseTranscript sniffs SRT vs JSON',
      Captions.parseTranscript('1\n00:00:01,000 --> 00:00:02,000\nhi\n').length === 1 &&
      Captions.parseTranscript(JSON.stringify(doc)).length === 3);

    // ================================================ 2. phrase grouping
    const W = (list) => list.map((x) => ({ w: x[0], start: x[1], end: x[2] }));
    const speech = W([
      ['We', 0.00, 0.20], ['ship', 0.20, 0.50], ['faster', 0.50, 0.90],
      ['than', 0.95, 1.15], ['anyone', 1.15, 1.60],
      // a 1.2s pause here must break the phrase whatever the word count says
      ['else', 2.80, 3.10], ['today', 3.10, 3.50],
    ]);
    const ph = Captions.groupPhrases(speech, { maxWords: 3, maxGap: 0.45, maxDur: 5, minDur: 0 });
    ok('words group into 2-3 word phrases', ph.length === 3, JSON.stringify(ph.map((p) => p.text)));
    ok('no phrase exceeds the word cap', ph.every((p) => p.words.length <= 3));
    ok('a long pause forces a break',
      ph[2] && ph[2].text === 'else today', ph[2] && ph[2].text);
    ok('phrase edges are WORD edges, never mid-word',
      ph.every((p) => speech.some((x) => near(x.start, p.start)) &&
                      speech.some((x) => near(x.end, p.end))),
      JSON.stringify(ph.map((p) => [p.start, p.end])));
    ok('every word is used exactly once, in order',
      ph.map((p) => p.text).join(' ') === speech.map((x) => x.w).join(' '),
      ph.map((p) => p.text).join(' '));

    const capped = Captions.groupPhrases(W([
      ['a', 0, 0.6], ['b', 0.6, 1.2], ['c', 1.2, 1.8],
    ]), { maxWords: 3, maxDur: 1.5, maxGap: 5, minDur: 0 });
    ok('the duration cap breaks a phrase before the word cap does',
      capped.length === 2 && capped[0].words.length === 2, JSON.stringify(capped.map((p) => p.text)));

    const sentence = Captions.groupPhrases(W([
      ['Done.', 0, 0.3], ['Next', 0.3, 0.6],
    ]), { maxWords: 3, maxGap: 5, maxDur: 5, minDur: 0 });
    ok('a sentence ending always ends the phrase', sentence.length === 2,
      JSON.stringify(sentence.map((p) => p.text)));

    const held = Captions.groupPhrases(W([['hi', 0, 0.08], ['there', 1.5, 1.9]]),
      { maxWords: 1, minDur: 0.3, maxGap: 5, maxDur: 5 });
    ok('a very short phrase is held to minDur', near(held[0].end, 0.3), held[0] && held[0].end);
    const crowd = Captions.groupPhrases(W([['hi', 0, 0.08], ['there', 0.2, 0.4]]),
      { maxWords: 1, minDur: 1.0, maxGap: 5, maxDur: 5 });
    ok('but never past the next caption, so two are never up at once',
      crowd[0].end <= crowd[1].start + 1e-6, JSON.stringify(crowd.map((p) => [p.start, p.end])));

    // ================================================ 3. the safe zone
    const zone = Captions.safeZone({ zoneTop: 0.6, zoneBottom: 0.86 });
    ok('the safe zone gives a centre between its edges', near(zone.y, 0.73), zone.y);
    const flip = Captions.safeZone({ zoneTop: 0.9, zoneBottom: 0.2 });
    ok('a zone dragged inside out is normalised, not obeyed',
      flip.top === 0.2 && flip.bottom === 0.9 && near(flip.y, 0.55), JSON.stringify(flip));

    const base = TextModel.defaultCard('');
    const card = Captions.phraseCard(base, ph[0], { zoneTop: 0.6, zoneBottom: 0.86, fontSize: 90 });
    ok('a caption card sits inside the safe zone',
      card.style.y >= 0.6 && card.style.y <= 0.86, card.style.y);
    ok('and is a plain text card, not a new kind of thing',
      card.style && card.anims && typeof card.text === 'string');
    ok('the pop-in is the EXISTING typewriter layer',
      card.anims.length === 1 && card.anims[0].type === 'typewriter' &&
      card.anims[0].params.unit === 'word' && card.anims[0].params.effect === 'pop',
      JSON.stringify(card.anims[0] && card.anims[0].params));
    const noPop = Captions.phraseCard(base, ph[0], { popIn: false });
    ok('pop-in off means no animation layers at all', noPop.anims.length === 0);

    // ================================================ 4. keyword highlight
    const hiPh = Captions.groupPhrases(speech, { maxWords: 3, keywords: 'faster, TODAY' });
    ok('keywords are matched case- and punctuation-insensitively',
      hiPh[0].hi.length === 1 && hiPh[0].words[hiPh[0].hi[0]].w === 'faster',
      JSON.stringify(hiPh.map((p) => p.hi)));
    const hiCard = Captions.phraseCard(base, hiPh[0], { keywords: 'faster', highlight: '#ff0000' });
    ok('the override lands on the card as plain JSON',
      hiCard.highlight && hiCard.highlight.color === '#ff0000' &&
      JSON.stringify(hiCard.highlight.words) === '[2]', JSON.stringify(hiCard.highlight));

    // ...and TextDraw must actually paint that word differently. measure() is the single
    // geometry pass both the preview and the baker use, so testing it tests both.
    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1920;
    const cctx = cv.getContext('2d');
    const hiClip = { in: 0, out: 3, card: JSON.parse(JSON.stringify(hiCard)) };
    hiClip.card.anims = [];                       // a still frame: no typewriter running
    const m = TextDraw.measure(cctx, hiClip, 1080, 1920, 1.0);
    const painted = m.items.filter((it) => it.paint);
    ok('measure() splits a highlighted card into words', m.items.length === 3,
      JSON.stringify(m.items.map((it) => it.text)));
    ok('and marks exactly the highlighted one',
      painted.length === 1 && painted[0].text === 'faster' && painted[0].paint === '#ff0000',
      JSON.stringify(painted.map((it) => [it.text, it.paint])));
    ok('word indices run in reading order',
      m.items.map((it) => it.wordIndex).join(',') === '0,1,2',
      m.items.map((it) => it.wordIndex).join(','));

    // A card with NO highlight must still paint a line in one go - the old behaviour,
    // and the reason existing text suites are unaffected by any of this.
    const plainClip = { in: 0, out: 3, card: JSON.parse(JSON.stringify(noPop)) };
    const pm = TextDraw.measure(cctx, plainClip, 1080, 1920, 1.0);
    ok('an un-highlighted card still measures one item per line',
      pm.items.length === 1 && pm.items[0].paint == null,
      JSON.stringify(pm.items.map((it) => it.text)));

    // ============================== 4b. word timing and emphasis
    // The transcript is word-level, so a caption can land on the syllable. The times go
    // on the card in the CARD's own base (seconds from the clip's start), which is the
    // same `t` every paint pass already runs on.
    const wt = Captions.groupPhrases(W([
      ['alpha', 10.0, 10.5], ['beta', 10.5, 11.0], ['gamma', 11.0, 11.5],
    ]), { maxWords: 3, minDur: 0 })[0];
    const wtCard = Captions.phraseCard(base, wt, {
      wordReveal: true, wordEmphasis: true, emphasisColor: '#ff0000',
      emphasisScale: 1.3, emphasisRise: 10, emphasisAttack: 0.05, popIn: false,
    });
    ok('word times are stored relative to the CARD, not to the source',
      JSON.stringify(wtCard.words.map((x) => [x.start, x.end])) === '[[0,0.5],[0.5,1],[1,1.5]]',
      JSON.stringify(wtCard.words));
    ok('and they are carried even with both effects off, so turning one on needs no regenerate',
      (Captions.phraseCard(base, wt, {}).words || []).length === 3);

    const wtClip = { in: 0, out: 2, card: wtCard };
    const shown = (t) => TextDraw.measure(cctx, wtClip, 1080, 1920, t).items;
    const s1 = shown(0.25), s2 = shown(0.75), s3 = shown(1.25);
    ok('reveal: only the words already spoken are painted',
      s1.length === 1 && s2.length === 2 && s3.length === 3,
      [s1.length, s2.length, s3.length].join(','));
    ok('emphasis: the word being said is the one that grows',
      s2[1].scale > 1.2 && s2[0].scale === 1,
      s2.map((i) => i.text + '=' + i.scale.toFixed(2)).join(' '));
    ok('and it is the one that changes colour',
      /rgb\(255,\s*0,\s*0\)/.test(String(s2[1].paint)) && !s2[0].paint,
      s2.map((i) => i.text + '=' + i.paint).join(' '));
    ok('a word settles back to normal once the next one starts',
      s3[0].scale === 1 && s3[1].scale === 1 && s3[2].scale > 1.2,
      s3.map((i) => i.text + '=' + i.scale.toFixed(2)).join(' '));
    ok('emphasis lifts the word as well as growing it', s2[1].dy < 0, s2[1].dy);
    // The bake crops to the union of the painted bounds across the clip, so the room a
    // grown word needs has to be in the bounds at every t - not only while one is hot.
    // Compared with reveal OFF in both, so the same three words are painted either way -
    // otherwise the emphasised card is simply narrower for having fewer words up.
    const boundsWith = (emph) => {
      const c2 = JSON.parse(JSON.stringify(wtCard));
      c2.wordFx = Object.assign({}, c2.wordFx, { reveal: false, emphasis: emph });
      return TextDraw.measure(cctx, { in: 0, out: 2, card: c2 }, 1080, 1920, 0.75).bounds;
    };
    const bq = boundsWith(true), bc = boundsWith(false);
    ok('the painted bounds reserve room for the growth, so the bake cannot crop it',
      bq.w > bc.w && bq.h > bc.h,
      Math.round(bq.w) + 'x' + Math.round(bq.h) + ' vs ' + Math.round(bc.w) + 'x' + Math.round(bc.h));

    // Reveal and the typewriter compose rather than fight: both are per-unit states and
    // they multiply, exactly as the animation layers do.
    const both = JSON.parse(JSON.stringify(wtCard));
    both.anims = Captions.phraseCard(base, wt, { popIn: true, popDur: 0.3 }).anims;
    const bi = TextDraw.measure(cctx, { in: 0, out: 2, card: both }, 1080, 1920, 0.75).items;
    ok('word reveal and the typewriter layer compose', bi.length === 2,
      bi.map((i) => i.text).join(','));

    // ============================== 4c. building from a saved preset
    const preset = { kind: 'full', text: 'ignored', style: Object.assign(
      TextModel.defaultStyle(), { fontFamily: 'Impact', fontSize: 44, y: 0.2 }),
      animEnabled: true, anims: [], keys: {} };
    const pBase = TextModel.applyPreset(TextModel.defaultCard(''), preset, { keepText: true });
    const pCard = Captions.phraseCard(pBase, ph[0], { fromPreset: true, fontSize: 200, color: '#00ff00' });
    ok('a preset supplies the look and the caption rows stop applying',
      pCard.style.fontSize === 44 && pCard.style.fontFamily === 'Impact',
      pCard.style.fontSize + ' ' + pCard.style.fontFamily);
    ok('the wording is still the caption’s, never the preset’s',
      pCard.text === ph[0].text, pCard.text);
    ok('the safe zone still places it by default',
      near(pCard.style.y, 0.73), pCard.style.y);
    const pKeep = Captions.phraseCard(pBase, ph[0], { fromPreset: true, presetPlacement: true });
    ok('unless the preset’s own placement is kept', near(pKeep.style.y, 0.2), pKeep.style.y);

    // ================================================ 5. generating onto the timeline
    markClean(); newProject();   // markClean first: a dirty project would raise a modal
    const vT = state.tracks.find((t) => t.type === 'video');
    const aT = state.tracks.find((t) => t.type === 'audio');
    const SRC = 'C:\\__smoke_captions__\\voice.mp4';
    const link = 'lnkCAP';
    const V = {
      id: 'capV', src: SRC, name: 'voice', kind: 'video', start: 10, in: 2, out: 8,
      mediaDuration: 20, srcW: 1920, srcH: 1080, fps: 30,
      panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: link,
    };
    const A = Object.assign({}, V, { id: 'capA', kind: 'audio', srcW: 0, srcH: 0, fps: 0 });
    vT.clips.push(V); aT.clips.push(A);
    // Words in SOURCE time. The first is before the clip's in point, the last past its
    // out point - both must be left out of the captions.
    setTranscript(SRC, W([
      ['before', 0.5, 1.0],
      ['ship', 3.0, 3.3], ['it', 3.3, 3.6],
      ['now', 5.0, 5.4],
      ['after', 12.0, 12.5],
    ]));
    state.captions = Object.assign({}, Captions.DEFAULTS, { maxWords: 2, minDur: 0.2, popIn: true });
    state.selection = new Set([V.id, A.id]);
    renderAll();

    const undoBefore = undoStack.length;
    const gen = generateCaptions();
    ok('captions generate', gen && gen.made > 0, gen && JSON.stringify({ made: gen.made }));
    ok('the whole pass is ONE undo entry', undoStack.length === undoBefore + 1,
      undoBefore + ' -> ' + undoStack.length);

    const capTrack = state.tracks.find((t) => t.captions);
    ok('they land on a caption track above the footage',
      !!capTrack && state.tracks.indexOf(capTrack) === 0, capTrack && capTrack.name);
    const caps = capTrack ? capTrack.clips : [];
    ok('every generated clip is an ordinary text card',
      caps.length > 0 && caps.every((c) => c.kind === 'text' && c.card && !c.src));
    ok('words outside the clip\'s in/out are not captioned',
      caps.every((c) => !/before|after/.test(c.card.text)),
      caps.map((c) => c.card.text).join(' | '));

    // SOURCE -> TIMELINE: the word at 3.0s in a clip trimmed to in=2 and placed at 10
    // must appear at 11.0s, and nowhere else.
    const first = caps.slice().sort((a, b) => a.start - b.start)[0];
    ok('source time maps to the timeline through start - in',
      near(first.start, 10 + (3.0 - 2.0), 0.02), first && first.start);
    ok('a caption never runs past its clip',
      caps.every((c) => c.start >= V.start - 1e-6 && c.start + c.out <= clipEnd(V) + 1e-6),
      JSON.stringify(caps.map((c) => [c.start, c.start + c.out])));

    // ================================================ 6. regenerate, don't double
    const n1 = caps.length;
    state.captions.fontSize = 120;
    const again = generateCaptions();
    const caps2 = state.tracks.find((t) => t.captions).clips;
    ok('regenerating REPLACES its own cards rather than doubling them',
      caps2.length === n1 && again.replaced === n1, n1 + ' -> ' + caps2.length);
    ok('and the new settings are in the new cards',
      caps2.every((c) => c.card.style.fontSize === 120));

    // A hand-made card on the caption track is not this generator's to delete.
    const byHand = { id: 'byHand', src: null, name: 'Text', kind: 'text', start: 40, in: 0, out: 2,
      mediaDuration: 3600, srcW: 0, srcH: 0, fps: 0, panX: 0.5, panY: 0.5, zoom: 1,
      volume: 1, linkId: null, card: TextModel.defaultCard('kept') };
    state.tracks.find((t) => t.captions).clips.push(byHand);
    generateCaptions();
    ok('a hand-made card on the caption track survives a regenerate',
      state.tracks.find((t) => t.captions).clips.some((c) => c.id === 'byHand'));

    // ================================================ 7. undo, and the round trip
    const before = JSON.stringify(state.tracks);
    generateCaptions();
    ok('a further generate changed the timeline', JSON.stringify(state.tracks) !== before);
    undo();
    ok('one undo restores the timeline exactly', JSON.stringify(state.tracks) === before);

    const doc2 = JSON.parse(JSON.stringify(serialize()));
    ok('caption settings serialize', doc2.captions && doc2.captions.maxWords === 2);
    const savedCaps = doc2.tracks.find((t) => t.captions);
    ok('generated caption clips serialize whole',
      !!savedCaps && savedCaps.clips.some((c) => c.captions && c.captions.gen && c.card),
      savedCaps && savedCaps.clips.length);
    ok('and reload identical - nothing on them is unserialisable',
      JSON.stringify(JSON.parse(JSON.stringify(state.tracks))) === JSON.stringify(state.tracks));
    const reloaded = Object.assign({}, Captions.DEFAULTS, {});
    ok('a project saved before captions existed gets the defaults',
      reloaded.maxWords === 3 && reloaded.zoneBottom === 0.86);

    // ================================================ 8. the filler-word hook
    const fill = Captions.fillerSpans(W([
      ['So', 0, 0.2], ['um', 0.25, 0.40], ['we', 0.5, 0.7],
      ['you', 1.0, 1.1], ['know', 1.1, 1.3], ['ship', 1.4, 1.7],
    ]), { fillers: 'um, you know' });
    ok('filler spans are the words\' own timings',
      fill.length === 2 && near(fill[0][0], 0.25) && near(fill[0][1], 0.40), JSON.stringify(fill));
    ok('a multi-word filler is matched whole, not word by word',
      near(fill[1][0], 1.0) && near(fill[1][1], 1.3), JSON.stringify(fill[1]));

    // ...and Tighten actually picks them up, as ONE plan with the silences.
    markClean(); newProject();   // markClean first: a dirty project would raise a modal
    const vT2 = state.tracks.find((t) => t.type === 'video');
    const aT2 = state.tracks.find((t) => t.type === 'audio');
    const SRC2 = 'C:\\__smoke_captions__\\filler.mp4';
    const V2 = { id: 'fV', src: SRC2, name: 'f', kind: 'video', start: 0, in: 0, out: 10,
      mediaDuration: 10, srcW: 1920, srcH: 1080, fps: 30, panX: 0.5, panY: 0.5, zoom: 1,
      volume: 1, linkId: 'lnkF' };
    const A2 = Object.assign({}, V2, { id: 'fA', kind: 'audio', srcW: 0, srcH: 0, fps: 0 });
    vT2.clips.push(V2); aT2.clips.push(A2);
    silenceCache.set(SRC2 + '|-30', { spans: [[6.0, 7.0]], duration: 10 });
    setTranscript(SRC2, W([['um', 2.0, 2.3], ['right', 3.0, 3.4]]));
    state.selection = new Set([V2.id, A2.id]);
    state.tighten = { threshold: 0.35, pad: 0, noise: -30 };

    state.captions = Object.assign({}, Captions.DEFAULTS, { cutFillers: false });
    ok('with fillers off, only the silence is planned',
      tightenPlan().count === 1, JSON.stringify(tightenPlan().spans));

    state.captions.cutFillers = true;
    const plan = tightenPlan();
    ok('with fillers on, they join the SAME plan as the silences',
      plan.count === 2, JSON.stringify(plan.spans));
    ok('a filler is cut even though it is far under the silence threshold',
      plan.spans.some((s) => near(s[0], 2.0) && near(s[1], 2.3)), JSON.stringify(plan.spans));
    const undo0 = undoStack.length;
    tighten();
    ok('and the whole thing is still one undo entry', undoStack.length === undo0 + 1,
      undo0 + ' -> ' + undoStack.length);
    ok('picture and sound came out of it the same length',
      Math.abs(state.tracks.find((t) => t.type === 'video').clips.reduce((n, c) => n + (c.out - c.in), 0) -
               state.tracks.find((t) => t.type === 'audio').clips.reduce((n, c) => n + (c.out - c.in), 0)) < 1e-6);

    state.captions = Object.assign({}, Captions.DEFAULTS);

    // ================================================ 9. failing gracefully
    const missing = await window.api.transcribeRun({ path: 'C:\\__no_such_file__.mp4' });
    ok('a missing file fails cleanly instead of throwing',
      missing && missing.ok === false && missing.reason === 'missing', JSON.stringify(missing));
    const st = await window.api.transcribeState();
    ok('the engine reports whether whisper.cpp is present',
      st && ('bin' in st) && Array.isArray(st.models),
      'bin=' + (st && st.bin));

    // ================================================ 10. the panel
    markClean(); newProject();   // markClean first: a dirty project would raise a modal
    toggleCaptions(true);        // collapsed by default - open it the way the button does
    const panel = document.querySelector('#capPanel .cap-box');
    ok('the Captions panel builds', !!panel);
    if (panel) {
      ok('it offers Transcribe, Import, Generate and Clear',
        ['Transcribe', 'Import...', 'Generate captions', 'Clear'].every((t) =>
          [...panel.querySelectorAll('button')].some((b) => b.textContent === t)),
        [...panel.querySelectorAll('button')].map((b) => b.textContent).join(','));
      // #capPanel is a bare <div>, not a `.pad` one, so without padding of its own every
      // row sits hard against the column edge - unlike every other inspector panel.
      const host = document.querySelector('#capPanel');
      const hr = host.getBoundingClientRect(), br = panel.getBoundingClientRect();
      ok('the panel is not flush against the column edge',
        br.left - hr.left >= 6 && hr.right - br.right >= 6,
        'gaps ' + Math.round(br.left - hr.left) + ' / ' + Math.round(hr.right - br.right));

      const uN = undoStack.length, dirtyWas = state.dirty;
      const slider = panel.querySelector('input[type=range]');
      slider.value = '4';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      ok('a settings slider snapshots no undo entry', undoStack.length === uN,
        uN + ' -> ' + undoStack.length);
      ok('and does not dirty the project', state.dirty === dirtyWas);
      ok('but it does change the setting', state.captions.maxWords === 4, state.captions.maxWords);
      state.captions = Object.assign({}, Captions.DEFAULTS);
    }

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' +
      results.filter((x) => !x.startsWith('SKIP')).length + ' passed';
  } catch (e) {
    return results.join('\n') + '\n\nERR ' + (e && e.stack ? e.stack : e);
  }
})()
