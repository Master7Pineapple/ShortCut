/**
 * Smoke test for the per-clip audio chain, the sidechain ducking wiring and the
 * project loudness target. Runs inside the live renderer:
 *
 *   set SHORTCUT_SMOKE=tools\smoke-audiofx.js && npx electron .        (cmd)
 *   SHORTCUT_SMOKE=tools/smoke-audiofx.js node_modules/.bin/electron . (bash)
 *
 * Expects clip1.mp4 / clip2.mp4 in %TEMP%\scut_test - the same fixtures smoke.js uses;
 * its header comment gives the ffmpeg command that makes them.
 *
 * The filter assertions go through `window.api.buildArgs`, a test-only bridge to the REAL
 * buildArgs() in main.js. A test that re-implemented the filter builder would pass
 * happily while the render emitted something else entirely.
 *
 * The load-bearing assertion in here is the last one in section 1: a project with no
 * effects and no loudness target must produce a byte-identical argument list to the one
 * buildArgs() emitted before any of this existed. Everything in this step is opt-in, and
 * that is how it stays provable.
 */
(async () => {
  const results = [];
  const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';

  try {
    const argsFor = async (job, opts) => {
      const r = await window.api.buildArgs(JSON.parse(JSON.stringify(job)), opts);
      if (!r) return { ok: false, error: 'no debug bridge (is SHORTCUT_SMOKE set?)' };
      return r;
    };
    /** The filter_complex string out of an argument list. */
    const fcOf = (args) => {
      const i = args.indexOf('-filter_complex');
      return i === -1 ? '' : args[i + 1];
    };

    await importPaths([D + 'clip1.mp4', D + 'clip2.mp4']);
    const vTrack = state.tracks.find((t) => t.type === 'video');
    const aTrack = state.tracks.find((t) => t.type === 'audio');
    ok('fixtures imported', vTrack.clips.length === 2 && aTrack.clips.length === 2);

    // ============================================ 1. the no-effects baseline
    const baseJob = buildJob('C:\\out.mp4');
    const base = await argsFor(baseJob);
    ok('buildArgs runs over a plain project', base.ok, base.error || '');
    const baseFc = fcOf(base.args);

    ok('a clip with no fx emits the untouched audio chain',
      /\[\d+:a\]atrim=start=[\d.]+:duration=[\d.]+,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=[\d.]+,adelay=\d+\|\d+\[a0\]/.test(baseFc),
      baseFc.split(';').find((s) => s.indexOf('atrim') !== -1) || '(no atrim chain)');
    ok('the mix still ends amix -> atrim -> alimiter',
      baseFc.indexOf('amix=inputs=2:normalize=0:dropout_transition=0,atrim=duration=') !== -1 &&
      baseFc.indexOf(',alimiter=limit=0.98[aout]') !== -1);
    ok('no loudnorm when the target is off', baseFc.indexOf('loudnorm') === -1);
    ok('no sidechain when nothing ducks', baseFc.indexOf('sidechaincompress') === -1);
    ok('no asplit when nothing ducks', baseFc.indexOf('asplit') === -1);

    // The reference: what buildArgs() emitted for this timeline BEFORE the audio chain
    // existed, rebuilt here from the shape the README documents. If a future change adds
    // anything to the default path, this is the assertion that catches it.
    const audioChains = baseFc.split(';').filter((s) => s.indexOf('atrim=start=') !== -1);
    const r3 = (n) => Math.round(n * 1e6) / 1e6;
    // Input indices come from the job's own clip order (audio tracks sit below video, so
    // buildJob's bottom-up walk emits them first) rather than being assumed here.
    const jobInputs = baseJob.clips.filter((c) => c.visible || c.audible);
    const expectedLegacy = baseJob.clips.filter((c) => c.audible).map((c, i) => {
      const delay = Math.max(0, Math.round(c.start * 1000));
      return '[' + jobInputs.indexOf(c) + ':a]atrim=start=' + r3(c.in) + ':duration=' + r3(c.out - c.in) +
        ',asetpts=PTS-STARTPTS' +
        ',aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo' +
        ',volume=' + r3(c.volume) + ',adelay=' + delay + '|' + delay + '[a' + i + ']';
    });
    ok('the no-fx audio chain is byte-identical to the pre-effects one',
      audioChains.join('\n') === expectedLegacy.join('\n'),
      audioChains.join('\n') + '  !=  ' + expectedLegacy.join('\n'));

    // The video half must not have been touched at all by an audio-only step.
    ok('the video chain is untouched',
      baseFc.indexOf('overlay=0:0:eof_action=repeat') !== -1 &&
      baseFc.indexOf('format=yuv420p[vout]') !== -1);

    // ============================================ 2. each effect's filter string
    const music = aTrack.clips[0];
    const voice = aTrack.clips[1];

    const withFx = async (fx) => {
      music.afx = fx;
      const r = await argsFor(buildJob('C:\\out.mp4'));
      const chain = fcOf(r.args).split(';').find((s) => s.indexOf('[a0]') !== -1) || '';
      music.afx = [];
      return chain;
    };

    const mk = (type, params) => {
      const f = AudioFX.create(type);
      if (params) Object.assign(f.params, params);
      return f;
    };

    ok('denoise emits afftdn',
      (await withFx([mk('denoise', { nr: 20, nf: -30 })])).indexOf('afftdn=nr=20:nf=-30') !== -1);

    const eqChain = await withFx([mk('eq', { lowG: -3, midG: 2, highG: 4 })]);
    ok('eq emits three equalizer bands in low/mid/high order',
      eqChain.indexOf('equalizer=f=120:t=q:w=0.7:g=-3,equalizer=f=1000:t=q:w=1:g=2,equalizer=f=8000:t=q:w=0.7:g=4') !== -1,
      eqChain);

    ok('de-esser emits deesser',
      (await withFx([mk('deesser', { i: 0.6, m: 0.4, f: 0.7 })])).indexOf('deesser=i=0.6:m=0.4:f=0.7') !== -1);

    // -18 dB is 0.126 linear and 6 dB of makeup is 1.995 - the UI is in dB, acompressor
    // is not, and this is the assertion that the conversion did not get dropped.
    const comp = await withFx([mk('compressor', { thresholdDb: -18, ratio: 4, attack: 10, release: 200, makeupDb: 6 })]);
    ok('compressor converts dB to acompressor linear',
      comp.indexOf('acompressor=threshold=0.126:ratio=4:attack=10:release=200:makeup=1.995') !== -1, comp);

    ok('gain emits volume in dB',
      (await withFx([mk('gain', { db: -4.5 })])).indexOf('volume=-4.5dB') !== -1);

    // ---- order, bypass ---------------------------------------------------
    const ordered = await withFx([mk('gain', { db: 3 }), mk('denoise')]);
    ok('effects are emitted in chain order',
      ordered.indexOf('volume=3dB') < ordered.indexOf('afftdn') && ordered.indexOf('afftdn') !== -1, ordered);

    const reversed = await withFx([mk('denoise'), mk('gain', { db: 3 })]);
    ok('reordering the chain reorders the filters',
      reversed.indexOf('afftdn') < reversed.indexOf('volume=3dB'), reversed);

    const bypassed = mk('denoise');
    bypassed.enabled = false;
    ok('a bypassed effect emits nothing',
      (await withFx([bypassed])).indexOf('afftdn') === -1);

    ok('the effect chain sits before clip volume and adelay',
      (await withFx([mk('denoise')])).indexOf('afftdn') <
      (await withFx([mk('denoise')])).indexOf('adelay'));

    // ============================================ 3. ducking / sidechain
    const duck = mk('duck', { voiceTrack: aTrack.id, thresholdDb: -24, ratio: 8 });
    music.afx = [duck];
    let r = await argsFor(buildJob('C:\\out.mp4'));
    let fc = fcOf(r.args);
    // Ducking to your own track would compress the clip against its track-mates, which
    // is not what the effect means - both the graph and the inspector refuse it.
    ok('a duck pointed at its own track is dropped, not wired to itself',
      fc.indexOf('sidechaincompress') === -1 && fc.indexOf('asplit') === -1,
      fc.split(';').filter((x) => /asplit|duckbus|sidechain/.test(x)).join(';'));

    // A second audio track, so voice and music are genuinely separate. Ducking names a
    // TRACK, not a clip, so this is the arrangement the effect is built for.
    addTrack('audio', false);
    const vt = state.tracks.filter((t) => t.type === 'audio')[1];
    aTrack.clips = aTrack.clips.filter((c) => c !== voice);
    vt.clips.push(voice);
    voice.linkId = null;

    duck.params.voiceTrack = vt.id;
    r = await argsFor(buildJob('C:\\out.mp4'));
    fc = fcOf(r.args);
    const duckPart = (x) => x.split(';').filter((s2) =>
      /asplit|duckbus|sidechain/.test(s2)).join(';');
    ok('ducking emits sidechaincompress with the dB threshold converted',
      fc.indexOf('sidechaincompress=threshold=0.063:ratio=8:attack=20:release=300') !== -1, duckPart(fc));
    ok('the voice stream is split so it reaches both the mix and the sidechain',
      /\[a\d+\]asplit=2\[a\d+m\]\[a\d+s\]/.test(fc), duckPart(fc));
    ok('the sidechain feed is built into a named bus',
      fc.indexOf('[duckbus0]') !== -1, duckPart(fc));
    // Order matters and is not symmetric: sidechaincompress compresses its FIRST input
    // by the level of its second. Swapped, the music would gate the voice.
    ok('the ducked clip is the FIRST input to sidechaincompress, the voice bus the second',
      /\[a\d+\]\[duckbus0x0\]sidechaincompress/.test(fc) &&
      fc.indexOf('[duckbus0x0][a') === -1, fc.split(';').find((x) => x.indexOf('sidechain') !== -1));
    ok('the split half, not the original label, goes into the mix',
      /\[a\d+m\]/.test(fc.slice(fc.lastIndexOf('amix'))) || /\[a\d+m\]\[a\d+d\]amix|\[a\d+d\]\[a\d+m\]amix/.test(fc),
      fc.slice(fc.lastIndexOf('amix=inputs=2')));
    ok('the final mix still takes exactly one input per audible clip',
      fc.indexOf('amix=inputs=2:normalize=0:dropout_transition=0,atrim') !== -1,
      fc.slice(fc.lastIndexOf(';') + 1));

    // Every filter output pad must be consumed exactly once, or ffmpeg refuses the graph.
    const pads = {};
    for (const m of fc.match(/\[[a-z0-9]+\]/g) || []) pads[m] = (pads[m] || 0) + 1;
    const reused = Object.keys(pads).filter((k) =>
      pads[k] > 2 && k !== '[base0]' && !/^\[\d+:/.test(k));
    ok('no filter label is used more than twice (one producer, one consumer)',
      reused.length === 0, reused.join(' '));

    // A duck pointed at a track that has gone silent must degrade, not break the render.
    vt.muted = true;
    r = await argsFor(buildJob('C:\\out.mp4'));
    ok('ducking to a muted track drops the effect instead of emitting a dangling pad',
      r.ok && fcOf(r.args).indexOf('sidechaincompress') === -1);
    vt.muted = false;

    // ============================================ 4. loudness
    state.out.loudness = { enabled: true, lufs: -14, tp: -1, lra: 11 };
    r = await argsFor(buildJob('C:\\out.mp4'));
    fc = fcOf(r.args);
    ok('a loudness target adds loudnorm to the final mix',
      fc.indexOf('loudnorm=I=-14:TP=-1:LRA=11') !== -1, fc.slice(fc.lastIndexOf('amix')));
    ok('loudnorm sits after the mix and before the limiter',
      fc.indexOf('loudnorm') > fc.lastIndexOf('amix=inputs') &&
      fc.indexOf('loudnorm') < fc.indexOf('alimiter'));
    ok('the rate is put back to 48k after loudnorm',
      fc.indexOf('loudnorm=I=-14:TP=-1:LRA=11,aresample=48000') !== -1);
    ok('pass one is not what a plain render emits',
      fc.indexOf('print_format=json') === -1);

    // ---- pass one --------------------------------------------------------
    const measJob = buildJob('C:\\out.mp4');
    const meas = await argsFor(measJob, { measureLoudness: true });
    const measFc = fcOf(meas.args);
    ok('the measurement pass asks loudnorm to print JSON',
      measFc.indexOf('print_format=json') !== -1, measFc.slice(measFc.lastIndexOf(';') + 1));
    ok('the measurement pass decodes no video',
      measFc.indexOf('overlay') === -1 && measFc.indexOf('color=c=black') === -1);
    ok('the measurement pass writes nothing',
      meas.args.indexOf('-f') !== -1 && meas.args[meas.args.length - 1] === '-' &&
      meas.args[meas.args.length - 2] === 'null');
    ok('the measurement pass measures the SAME mix the render normalises',
      measFc.split(';').filter((s) => s.indexOf('atrim=start=') !== -1).join('\n') ===
      fc.split(';').filter((s) => s.indexOf('atrim=start=') !== -1).join('\n'));

    // ---- pass two --------------------------------------------------------
    const twoPass = buildJob('C:\\out.mp4');
    twoPass.loudness = Object.assign({}, twoPass.loudness, {
      measured: { input_i: -19.5, input_tp: -3.2, input_lra: 6.1, input_thresh: -30.1, target_offset: 0.4 },
    });
    const two = fcOf((await argsFor(twoPass)).args);
    ok('pass two feeds the measurements back in and goes linear',
      two.indexOf('measured_I=-19.5:measured_TP=-3.2:measured_LRA=6.1:measured_thresh=-30.1:offset=0.4:linear=true') !== -1,
      two.slice(two.indexOf('loudnorm')));

    state.out.loudness = { enabled: false, lufs: -14, tp: -1, lra: 11 };
    music.afx = [];

    // ============================================ 5. the model stays JSON
    const round = JSON.parse(JSON.stringify(serialize()));
    music.afx = [mk('denoise'), mk('compressor')];
    const ser = JSON.parse(JSON.stringify(serialize()));
    const serClip = ser.tracks.reduce((acc, t) => acc.concat(t.clips), [])
      .find((c) => c.id === music.id);
    ok('the chain serialises with the project', !!serClip && serClip.afx.length === 2,
      serClip ? String(serClip.afx && serClip.afx.length) : 'clip missing');
    ok('the chain survives a JSON round trip intact',
      JSON.stringify(serClip.afx) === JSON.stringify(music.afx));
    ok('nothing non-serialisable lands on the clip',
      Object.keys(music).every((k) => typeof music[k] !== 'function') &&
      music.afx.every((f) => typeof f.params === 'object' && !(f.params instanceof Map)));
    ok('the loudness target serialises with the project',
      !!ser.out.loudness && ser.out.loudness.enabled === false);
    ok('serialize() is otherwise unchanged by an empty chain',
      JSON.stringify(round.out.w) === JSON.stringify(ser.out.w));

    // ---- normalize fills a project saved before a parameter existed -------
    const old = { id: 'x', type: 'compressor', params: { ratio: 5 } };
    AudioFX.normalize(old);
    ok('normalize fills missing params from the defaults',
      old.params.attack === 20 && old.params.ratio === 5 && old.enabled === true);
    const stale = { afx: [{ type: 'compressor' }, { type: 'not-a-real-effect' }] };
    AudioFX.normalizeClip(stale);
    ok('normalizeClip drops effect types this build does not know',
      stale.afx.length === 1 && stale.afx[0].type === 'compressor');

    // ============================================ 6. undo
    music.afx = [];
    markDirty();
    const before = JSON.stringify(state.tracks);
    pushUndo();
    music.afx = [mk('denoise'), mk('eq'), mk('gain')];
    markDirty();
    ok('the chain is on the clip before undo', music.afx.length === 3);
    undo();
    const after = state.tracks.reduce((acc, t) => acc.concat(t.clips), [])
      .find((c) => c.id === music.id);
    ok('one undo removes the whole chain', !after.afx || after.afx.length === 0,
      JSON.stringify(after.afx));
    ok('undo restores the timeline exactly', JSON.stringify(state.tracks) === before);

    // undo() replaces state.tracks with freshly parsed objects, so every clip reference
    // taken before it is now detached. Re-bind before touching the timeline again.
    const liveMusic = allClips().find((x) => x.clip.id === music.id).clip;

    // ============================================ 7. the preview mix
    const pc = { volume: 1, afx: [] };
    ok('preview gain of a plain clip is its volume', AudioFX.previewGain(pc) === 1);
    pc.volume = 0.5;
    ok('preview gain follows clip volume', Math.abs(AudioFX.previewGain(pc) - 0.5) < 1e-9);
    pc.afx = [mk('gain', { db: 6 })];
    ok('a +6 dB gain effect doubles the preview level',
      Math.abs(AudioFX.previewGain(pc) - 0.5 * 1.9953) < 0.001, String(AudioFX.previewGain(pc)));
    pc.afx[0].enabled = false;
    ok('a bypassed gain effect is not heard', Math.abs(AudioFX.previewGain(pc) - 0.5) < 1e-9);
    pc.afx = [mk('denoise'), mk('compressor'), mk('duck', { voiceTrack: 'anything' })];
    ok('the preview mirrors level only - DSP effects do not change it',
      Math.abs(AudioFX.previewGain(pc) - 0.5) < 1e-9);
    pc.volume = 2;
    pc.afx = [mk('gain', { db: 24 })];
    ok('preview gain is clamped so a boost cannot blow up the mix',
      AudioFX.previewGain(pc) === 4, String(AudioFX.previewGain(pc)));

    // The inspector has to actually offer the controls for a selected audio clip.
    setSelection([liveMusic.id], false);
    renderInspector();
    const panel = document.querySelector('#inspector .afx-box');
    ok('an audio clip gets the effects panel', !!panel);
    ok('the panel says the preview is not the render',
      !!panel && /applied on render/i.test(panel.textContent));
    ok('every effect type can be added from the panel',
      !!panel && panel.querySelectorAll('.afx-add option').length === AudioFX.TYPES.length + 1);

    // The duck row must not offer the clip's own track - see buildArgs().
    pushUndo();
    liveMusic.afx = [mk('duck')];
    renderInspector();
    const duckSel = document.querySelector('#inspector .afx-fx-body select');
    const offered = [...(duckSel ? duckSel.options : [])].map((o) => o.value).filter(Boolean);
    const own = allClips().find((x) => x.clip === liveMusic).track.id;
    ok('the duck row offers every audio track but the clip own one',
      !!duckSel && offered.indexOf(own) === -1 &&
      offered.length === state.tracks.filter((t) => t.type === 'audio').length - 1,
      offered.join(',') + ' own=' + own);
    undo();
    setSelection([vTrack.clips[0].id], false);
    renderInspector();
    ok('a video clip gets no audio effects panel',
      !document.querySelector('#inspector .afx-box'));

    const failed = results.filter((x) => x.startsWith('FAIL')).length;
    return results.join('\n') + '\n\n' + (results.length - failed) + '/' + results.length + ' passed';
  } catch (e) {
    return results.join('\n') + '\n\nERR ' + (e && e.stack ? e.stack : e);
  }
})()
