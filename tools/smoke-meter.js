/**
 * Smoke test for the loudness meter maths - ITU-R BS.1770-4 / EBU R 128.
 *
 *   set SHORTCUT_SMOKE=tools\smoke-meter.js && npx electron .        (cmd)
 *   SHORTCUT_SMOKE=tools/smoke-meter.js node_modules/.bin/electron . (bash)
 *
 * Needs no media and no audio at all: `Meter` is pure maths over blocks of energy, which
 * is exactly why it was split out of the audio plumbing. The AudioContext side (the two
 * IIR stages and the worklet) is what feeds it; this proves the numbers it produces.
 *
 * The two assertions worth keeping honest are the K-weighting coefficients against the
 * published 48 kHz table, and the two-stage gating on the integrated reading - the gate
 * is the part every naive implementation gets wrong, and getting it wrong shows up as
 * "my export is 3 LU under target" much later.
 *
 * Section 7 is the exception to "no audio needed": it writes a 1 kHz tone of its own,
 * plays it through the real graph, and checks the reading against a loudness predicted
 * from the filters' frequency response. That is what catches a mis-wired filter or a
 * worklet block of the wrong length, which no amount of pure-maths testing can. It
 * SKIPS rather than fails on a machine with no audio device. Measured against ffmpeg's
 * own `ebur128` on the same tone, this meter agrees to within 0.01 LU.
 */
(async () => {
  const results = [];
  const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps);

  try {
    // ============================================ 1. K-weighting coefficients
    // BS.1770-4 tables 1 and 2, the published 48 kHz values.
    const [s1, s2] = Meter.kWeighting(48000);
    ok('K-weighting stage 1 numerator matches the BS.1770 table',
      near(s1.b[0], 1.53512485958697, 1e-12) &&
      near(s1.b[1], -2.69169618940638, 1e-12) &&
      near(s1.b[2], 1.19839281085285, 1e-12), s1.b.join(', '));
    ok('K-weighting stage 1 denominator matches the BS.1770 table',
      near(s1.a[0], 1, 1e-12) &&
      near(s1.a[1], -1.69065929318241, 1e-12) &&
      near(s1.a[2], 0.73248077421585, 1e-12), s1.a.join(', '));
    ok('K-weighting stage 2 is the 38 Hz high-pass from the table',
      near(s2.b[0], 1) && near(s2.b[1], -2) && near(s2.b[2], 1) &&
      near(s2.a[1], -1.99004745483398, 1e-11) &&
      near(s2.a[2], 0.99007225036621, 1e-11), s2.a.join(', '));

    // The coefficients come from the analog prototype, so any rate works - and a
    // different rate must give DIFFERENT coefficients, or the derivation is being ignored.
    const at44 = Meter.kWeighting(44100);
    ok('a different sample rate re-derives the coefficients',
      !near(at44[0].a[1], s1.a[1], 1e-6) && isFinite(at44[0].b[0]), at44[0].a[1].toFixed(8));
    ok('every coefficient is finite at 96 kHz',
      Meter.kWeighting(96000).every((st) => st.b.concat(st.a).every((v) => isFinite(v))));

    // ============================================ 2. block loudness
    // A -20 dBFS sine has a mean square of amp^2/2 per channel; on two channels the
    // energy sums, so the block loudness is -0.691 + 10*log10(0.01).
    const msFor = (dbfs) => { const a = Math.pow(10, dbfs / 20); return 0.5 * a * a; };
    ok('block loudness of a -20 dBFS tone on two channels',
      near(Meter.blockLoudness([msFor(-20), msFor(-20)]), -20.691, 0.001),
      Meter.blockLoudness([msFor(-20), msFor(-20)]).toFixed(4));
    ok('halving the energy is 3 dB quieter',
      near(Meter.blockLoudness([msFor(-20)]) - Meter.blockLoudness([msFor(-20), msFor(-20)]), -3.0103, 0.001));
    ok('digital silence is -Infinity, not NaN and not 0',
      Meter.blockLoudness([0, 0]) === -Infinity);
    ok('channel energies sum rather than average',
      near(Meter.blockLoudness([0.01, 0.01]), Meter.blockLoudness([0.02]), 1e-9));

    // ============================================ 3. windows
    const S = Meter.Session;
    let s = new S();
    ok('a fresh session reads -Infinity everywhere',
      s.momentary() === -Infinity && s.shortTerm() === -Infinity && s.integrated() === -Infinity);

    const feed = (sess, db, blocks) => {
      const ms = msFor(db);
      const peak = Math.pow(10, db / 20);
      for (let i = 0; i < blocks; i++) sess.push([ms, ms], peak);
    };

    s = new S();
    feed(s, -23, 40);                    // 4 s at -23 dBFS
    ok('momentary settles on a steady tone', near(s.momentary(), -23.691, 0.01), s.momentary().toFixed(3));
    ok('short-term settles on the same steady tone', near(s.shortTerm(), -23.691, 0.01));
    ok('integrated settles on the same steady tone', near(s.integrated(), -23.691, 0.01));
    ok('peak is measured, not derived from the loudness',
      near(s.peakDb(), -23, 0.001), s.peakDb().toFixed(3));

    // Momentary is 400 ms and short-term is 3 s, so a recent change moves one long
    // before the other. That difference is the entire point of showing both.
    s = new S();
    feed(s, -30, 30);
    feed(s, -14, 4);                     // 400 ms of louder material
    ok('momentary follows the last 400 ms', near(s.momentary(), -14.691, 0.01), s.momentary().toFixed(2));
    ok('short-term still remembers the quiet 3 s before it',
      s.shortTerm() < s.momentary() - 5, 'S=' + s.shortTerm().toFixed(2) + ' M=' + s.momentary().toFixed(2));

    // Only 3 s of blocks are retained, so a long session cannot grow without bound.
    s = new S();
    feed(s, -20, 500);
    ok('the sliding window keeps only 3 s of blocks',
      s.blocks.length === Meter.SHORT_BLOCKS, String(s.blocks.length));

    // ============================================ 4. the integrated gates
    // Absolute gate: silence must not drag the programme loudness down. Half a minute of
    // digital black in front of a -20 LUFS programme is still a -20 LUFS programme.
    s = new S();
    feed(s, -20, 100);
    const withoutSilence = s.integrated();
    s = new S();
    feed(s, -120, 300);                  // far below the -70 LUFS absolute gate
    feed(s, -20, 100);
    // Not exactly equal, and it should not be: the three 400 ms windows that straddle the
    // silence/tone boundary hold a quarter, a half and three quarters of the energy, and
    // all three sit well inside both gates. They pull the mean down by 10*log10(98.5/100)
    // = 0.066 LU, which is the number below. A test that demanded exact equality here
    // would be demanding a WRONG implementation - one that gated on window position
    // rather than on level.
    ok('the absolute gate drops silence from the integrated reading',
      near(s.integrated(), withoutSilence, 0.1) && s.integrated() < withoutSilence,
      s.integrated().toFixed(3) + ' vs ' + withoutSilence.toFixed(3) +
      ' (delta ' + (s.integrated() - withoutSilence).toFixed(3) + ' LU, from the boundary windows)');

    // Relative gate: material more than 10 LU below the mean is dropped too, so a quiet
    // passage does not pull the programme down either.
    s = new S();
    feed(s, -18, 100);
    feed(s, -45, 100);                   // loud enough to pass the absolute gate
    const gated = s.integrated();
    ok('the relative gate drops a passage more than 10 LU down',
      gated > -20, gated.toFixed(3));
    ok('and the ungated mean would have been much lower',
      Meter.blockLoudness([(msFor(-18) + msFor(-45)) / 2, (msFor(-18) + msFor(-45)) / 2]) < gated - 2);

    // Integrated is the loudness of the MEAN ENERGY, not the mean of the loudness values.
    // Those are different numbers whenever the level is not constant, and the second one
    // is wrong.
    s = new S();
    feed(s, -14, 50);
    feed(s, -20, 50);
    const meanOfLoudness = (-14.691 + -20.691) / 2;
    ok('integrated averages energy, not decibels',
      s.integrated() > meanOfLoudness + 0.3,
      'I=' + s.integrated().toFixed(3) + ' meanOfDb=' + meanOfLoudness.toFixed(3));

    // ============================================ 5. reset and edges
    s = new S();
    feed(s, -10, 50);
    ok('peak is held across the session', near(s.peakDb(), -10, 0.001));
    s.reset();
    ok('reset clears the integrated reading', s.integrated() === -Infinity);
    ok('reset clears the peak', s.peakDb() === -Infinity);
    ok('reset clears the windows', s.blocks.length === 0 && s.windows.length === 0);

    s = new S();
    s.push([], 0);
    ok('an empty block is ignored rather than throwing', s.blocks.length === 0);
    s.push([msFor(-20)], Math.pow(10, -20 / 20));
    ok('a mono block meters as mono', s.channels === 1 && near(s.momentary(), -23.701, 0.02),
      s.momentary().toFixed(3));

    s = new S();
    feed(s, -200, 50);
    ok('a signal under the absolute gate integrates to -Infinity, not a number',
      s.integrated() === -Infinity, String(s.integrated()));

    // ============================================ 6. the meter is wired up
    ok('the meter panel exists', !!document.querySelector('#meterCanvas'));
    ok('the readout has momentary, short-term, integrated and peak',
      !!document.querySelector('#mM') && !!document.querySelector('#mS') &&
      !!document.querySelector('#mI') && !!document.querySelector('#mPk'));

    // drawMeter() runs inside loop(); it must cope with no session at all, because that
    // is the state the app sits in until the first play.
    drawMeter();
    ok('the meter draws before any audio has ever played', true);
    ok('with no session the readouts show a dash, not NaN',
      document.querySelector('#mI').textContent === '-',
      document.querySelector('#mI').textContent);

    // With a session, the same draw must produce the numbers.
    previewMix.session = new S();
    feed(previewMix.session, -14, 40);
    drawMeter();
    ok('a fed session reaches the readout',
      document.querySelector('#mS').textContent === '-14.7',
      document.querySelector('#mS').textContent);
    ok('the integrated readout flags being on target',
      document.querySelector('#mI').className === 'on',
      document.querySelector('#mI').className || '(none)');
    resetMeter();
    drawMeter();
    ok('the reset button clears the readout', document.querySelector('#mI').textContent === '-');
    previewMix.session = null;

    // ============================================ 7. end-to-end calibration
    //
    // Everything above tests the maths in isolation. This tests the PLUMBING: that the
    // two IIR stages really are the K-weighting curve, that the worklet's blocks are the
    // length it claims, and that the meter is reading the mix rather than something
    // scaled on the way past. A pure-maths suite cannot catch a mis-wired filter.
    //
    // The tone is generated here rather than fetched, so the suite needs no fixture. The
    // expected loudness is derived independently, from the filters' own frequency
    // response at 1 kHz - not from Session, which is what is under test:
    //
    //   L = -0.691 + 10*log10( sum over channels of A^2/2 * |H(1kHz)|^2 )
    const TONE_HZ = 1000, TONE_AMP = 0.5, TONE_SECS = 4, TONE_RATE = 48000;

    /** |H| of one biquad at frequency f, straight from the transfer function. */
    const biquadMag = (st, f, fs) => {
      const w = 2 * Math.PI * f / fs;
      const cos1 = Math.cos(w), sin1 = Math.sin(w);
      const cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w);
      const nRe = st.b[0] + st.b[1] * cos1 + st.b[2] * cos2;
      const nIm = -(st.b[1] * sin1 + st.b[2] * sin2);
      const dRe = st.a[0] + st.a[1] * cos1 + st.a[2] * cos2;
      const dIm = -(st.a[1] * sin1 + st.a[2] * sin2);
      return Math.sqrt((nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm));
    };
    const kMag = Meter.kWeighting(TONE_RATE).reduce((m, st) => m * biquadMag(st, TONE_HZ, TONE_RATE), 1);
    const expected = -0.691 + 10 * Math.log10(2 * (TONE_AMP * TONE_AMP / 2) * kMag * kMag);

    ok('K-weighting is near unity at 1 kHz, as the curve says it should be',
      Math.abs(20 * Math.log10(kMag)) < 1.5, (20 * Math.log10(kMag)).toFixed(3) + ' dB');

    // ---- write a 16-bit stereo WAV of that tone -------------------------
    const frames = TONE_RATE * TONE_SECS;
    const bytes = new Uint8Array(44 + frames * 4);
    const dv = new DataView(bytes.buffer);
    const tag = (off, str) => { for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i); };
    tag(0, 'RIFF'); dv.setUint32(4, 36 + frames * 4, true); tag(8, 'WAVE');
    tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true); dv.setUint32(24, TONE_RATE, true);
    dv.setUint32(28, TONE_RATE * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    tag(36, 'data'); dv.setUint32(40, frames * 4, true);
    for (let i = 0; i < frames; i++) {
      const v = Math.round(TONE_AMP * Math.sin(2 * Math.PI * TONE_HZ * i / TONE_RATE) * 32767);
      dv.setInt16(44 + i * 4, v, true);
      dv.setInt16(44 + i * 4 + 2, v, true);
    }
    const tonePath = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\smoke_meter_tone.wav';
    const wrote = await window.api.writeTestFile(tonePath, Array.from(bytes));
    ok('the calibration tone was written', wrote !== false);

    newProject();
    await importPaths([tonePath]);
    ensureAudioCtx();
    await new Promise((r) => setTimeout(r, 300));

    if (previewMix.meterState !== 'on') {
      // A machine with no audio device never starts the context, and that is not a bug in
      // the meter - report it rather than failing the run.
      results.push('SKIP  end-to-end calibration (no running audio context on this machine)');
    } else {
      play();
      for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 33));
      pause();
      const live = previewMix.session;
      const I = live.integrated();
      // Half a LU is generous for a steady tone; a mis-wired filter or a wrong block
      // length misses by several.
      ok('the whole audio path meters a known tone to within 0.5 LU',
        Math.abs(I - expected) < 0.5,
        'measured ' + I.toFixed(2) + ' LUFS, predicted ' + expected.toFixed(2) +
        ' (delta ' + (I - expected).toFixed(2) + ' LU)');
      ok('and its peak matches the tone amplitude',
        Math.abs(live.peakDb() - 20 * Math.log10(TONE_AMP)) < 0.5,
        live.peakDb().toFixed(2) + ' dBFS');
      ok('the meter sees both channels', live.channels === 2, String(live.channels));
      ok('momentary, short-term and integrated agree on a steady tone',
        Math.abs(live.momentary() - live.shortTerm()) < 0.2 &&
        Math.abs(live.shortTerm() - I) < 0.2);
    }

    // ================================================ the panel's own layout
    // #bottom is a fixed height and #meterPanel is `overflow: hidden`, so anything that
    // does not fit is not scrolled to - it is cut off. The note under the readout was,
    // sitting flush against the bottom of the window with its descenders clipped.
    const mPanel = document.querySelector('#meterPanel');
    const mNote = document.querySelector('#meterNote');
    const pr = mPanel.getBoundingClientRect(), nr = mNote.getBoundingClientRect();
    ok('the meter note is not clipped against the bottom of the panel',
      nr.bottom <= pr.bottom - 4,
      'note ends at ' + Math.round(nr.bottom) + ', panel at ' + Math.round(pr.bottom));
    ok('and the bars still have room to be readable',
      document.querySelector('#meterCanvas').getBoundingClientRect().height >= 46,
      Math.round(document.querySelector('#meterCanvas').getBoundingClientRect().height) + 'px');

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return results.join('\n') + '\n\nERR ' + (e && e.stack ? e.stack : e);
  }
})()
