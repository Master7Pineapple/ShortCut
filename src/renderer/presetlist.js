'use strict';
/**
 * The PresetList - the B2B short-form preset rack, as named presets in the editor.
 *
 * NOT the text-card preset save/load (`window.api.listPresets` / `TextModel.applyPreset`).
 * Those store ONE card's look. A PresetList entry is a whole pass - a family of related
 * moves with its own parameters - and it produces its result through the engines the
 * app already has: captions through `Captions.phraseCard()` and `generateCaptions()`,
 * cards through `TextDraw`, pushes and split screens as ordinary `FX` entries on the
 * selected clips. Nothing here draws a pixel of its own, so preview and export agree for
 * the same reason they always do.
 *
 * Parameters live on `state.presetList.p01` (etc.) and go in the .scut. They are
 * SETTINGS, like the Captions panel's: moving one snapshots no undo entry and dirties
 * nothing. Only the buttons that touch the timeline (Generate, Add role tag, a push, a
 * split, and their Remove) take an undo entry, one each.
 *
 * Loaded before app.js (its state initialiser calls `PresetList.defaults()`), so every
 * app.js global used below is looked up at call time, never at load time.
 */
const PresetList = (() => {

  // ------------------------------------------------------------------ the list

  /** The rack, in build order. */
  const LIST = [
    { id: '01', key: 'p01', name: 'Caption engine', family: 'CAP_' },
    { id: '02', key: 'p02', name: 'Push in / out', family: 'ZM_' },
    { id: '03', key: 'p03', name: 'Split screen', family: 'SPL_' },
    { id: '04', key: 'p04', name: 'Camera move', family: 'CAM_' },
    { id: '05', key: 'p05', name: 'Shine', family: 'SHN_' },
    { id: '06', key: 'p06', name: 'Glow in / out', family: 'GLW_' },
    { id: '07', key: 'p07', name: 'Strikethrough', family: 'STR_' },
    { id: '08', key: 'p08', name: 'Emphasis', family: 'EMP_' },
    { id: '09', key: 'p09', name: 'Motion', family: 'MOT_' },
  ];

  const F = (n) => n / 30;   // the rack's frame counts are at 30 fps

  // ------------------------------------------------------- 01 Caption engine

  /**
   * Preset 01's parameters, grouped by the six presets of the family. Sizes are px
   * against a 1080x1920 frame (every text size in the app is), positions are fractions
   * of the frame height.
   */
  const P01 = {
    // CAP_word-pop - the default state of every second of dialogue
    fontFamily: 'Segoe UI',
    size: 110,                // cap height 6.5-8% of frame height at this face
    color: '#ffffff',
    accent: '#ffd166',        // the one accent: active word, blowups, markers
    tracking: -2.5,           // % of size
    leading: 1.12,
    maxWords: 3,              // 2-3 words per card
    maxWidth: 0.82,
    lineAt: 0.72,             // 68-76% of frame height: under the face, above the UI
    shadowDistance: 6,
    shadowBlur: 22,
    shadowOpacity: 0.38,      // a soft drop shadow, NOT an 8px stroke
    activeScale: 1.05,        // 100 -> 105% ...
    activeOver: F(3),         // ... over 3 frames, ease-out-back
    // CAP_blowup
    blowOn: true,
    blowWords: '',
    blowScale: 1.55,          // 1.45-1.7x the caption
    blowFrom: 1.12,           // lands at 112% ...
    blowOver: F(4),           // ... and settles to 100% over 4 frames, ease-out-expo
    blowCaps: true,
    blowColor: '#ffd166',
    // CAP_marker
    markOn: true,
    markWords: '',
    markMode: 'tint',         // tint = accent at 22% under unchanged text (the premium one)
    markOpacity: 0.22,
    markColor: '#ffd166',
    markTextColor: '#111111',
    markRadius: 8,
    markPadX: 14,
    markPadY: 4,
    markOver: F(3),
    markSoft: 0.12,
    markAngle: 0.8,           // 0.5-1.2 deg hand-made; 0 for a corporate client
    // CAP_metric-chip
    chipOn: true,
    chipWords: Captions.DEFAULTS.chipWords,
    chipFont: 'Consolas',
    chipSize: 0.6,            // 55-65% of the caption
    chipTracking: 8,
    chipHold: 1.6,
    chipReveal: F(5),
    chipRise: 16,
    chipGap: 0.075,
    // CAP_role
    roleEyebrow: 'Founder, Acme',
    roleName: 'Jane Doe',
    roleEyebrowSize: 34,
    roleEyebrowOpacity: 0.55,
    roleNameSize: 76,
    roleX: 0.08,              // left edge, fraction of frame width
    roleY: 0.2,
    roleHold: 1.6,
    roleExit: F(4),
    // CAP_guides
    guidesOn: false,
    guideTop: 0.12,
    guideBottom: 0.20,
    guideRail: 0.18,
    guideRailFrom: 0.55,
    guideOpacity: 0.25,
  };

  // --------------------------------------------------------- 02 Push in / out

  /**
   * Preset 02's parameters. Three speeds, each with its own amount, length, curve and
   * shutter; the focus point and where the move starts are shared. `amount` is how much
   * bigger the picture ends up (0.15 = 115%). Slow has no length: it runs the whole clip.
   */
  const P02 = {
    speed: 'fast',
    fastAmount: 0.18,
    fastDur: F(6),
    fastEase: 'easeOutExpo',
    fastBlur: 1.2,            // shutter strength - the whip is what sells a fast punch
    fastSamples: 12,
    medAmount: 0.12,
    medDur: F(18),
    medEase: 'easeInOut',
    medBlur: 0.6,
    medSamples: 8,
    slowAmount: 0.1,
    slowEase: 'linear',
    anchorX: 0.5,             // the point the picture grows about, fractions of the frame
    anchorY: 0.5,
    at: 'start',              // 'start' | 'playhead' | 'end' - where a fast/medium move sits
  };

  // --------------------------------------------------------- 03 Split screen

  /** Preset 03's parameters - the `split` effect's, plus an optional soft seam. */
  const P03 = {
    side: 'top',
    size: 0.5,
    focus: 0.5,
    zoom: 1,
    distance: 0,
    seam: 0,                  // feather on the band's inner edge, moves with the band
    animIn: true,             // glide from the full frame into the band ...
    animOut: false,           // ... and back out to the full frame at the end
    animDur: F(12),
    animEase: 'easeInOut',
    animAt: 'start',          // 'start' | 'playhead' - where the glide in begins
    animBlur: 0.5,            // shutter on the glide; 0 = none
    animSamples: 8,
  };

  const TABLES = { p01: P01, p02: P02, p03: P03 };

  function defaults() {
    const out = { open: '01' };
    for (const k of Object.keys(TABLES)) out[k] = Object.assign({}, TABLES[k]);
    return out;
  }

  /** A saved PresetList, filled in and trimmed to what this build knows. */
  function normalize(d) {
    const out = defaults();
    if (!d || typeof d !== 'object') return out;
    if (typeof d.open === 'string' && LIST.some((x) => x.id === d.open)) out.open = d.open;
    for (const [key, T] of Object.entries(TABLES)) {
      if (!d[key] || typeof d[key] !== 'object') continue;
      for (const k of Object.keys(T)) {
        if (d[key][k] !== undefined && typeof d[key][k] === typeof T[k]) out[key][k] = d[key][k];
      }
    }
    return out;
  }

  /**
   * Preset 01 as caption settings - the whole mapping from the rack's language to the
   * Captions engine's. Pure: it returns the settings and changes nothing.
   */
  function captionSettings(p, base) {
    const band = 0.04;
    return Object.assign({}, base, {
      preset: '',
      fontFamily: p.fontFamily,
      fontSize: p.size,
      color: p.color,
      uppercase: false,
      tracking: p.tracking,
      lineHeight: p.leading,
      maxWords: p.maxWords,
      maxWidth: p.maxWidth,
      zoneTop: Math.max(0, p.lineAt - band),
      zoneBottom: Math.min(1, p.lineAt + band),
      strokeOn: false,
      shadowDistance: p.shadowDistance,
      shadowAngle: 90,
      shadowBlur: p.shadowBlur,
      shadowOpacity: p.shadowOpacity,
      // Hard cut in on the syllable: no pop, no fade, no reveal. The spoken word is
      // the only thing that moves.
      popIn: false,
      wordReveal: false,
      wordEmphasis: true,
      emphasisColor: p.accent,
      emphasisScale: p.activeScale,
      emphasisRise: 0,
      emphasisAttack: p.activeOver,
      emphasisEase: 'backOut',
      blowWords: p.blowOn ? p.blowWords : '',
      blowScale: p.blowScale,
      blowFrom: p.blowFrom,
      blowDur: p.blowOver,
      blowColor: p.blowColor,
      blowUpper: p.blowCaps,
      markWords: p.markOn ? p.markWords : '',
      markMode: p.markMode,
      markColor: p.markColor,
      markOpacity: p.markOpacity,
      markTextColor: p.markTextColor,
      markRadius: p.markRadius,
      markPadX: p.markPadX,
      markPadY: p.markPadY,
      markDur: p.markOver,
      markSoft: p.markSoft,
      markAngle: p.markAngle,
      chipOn: p.chipOn,
      chipWords: p.chipWords,
      chipFont: p.chipFont,
      chipSize: p.chipSize,
      chipTracking: p.chipTracking,
      chipHold: p.chipHold,
      chipReveal: p.chipReveal,
      chipRise: p.chipRise,
      chipGap: p.chipGap,
    });
  }

  /** Write preset 01 into the caption settings. A setting: no undo entry. */
  function applyP01() {
    const p = state.presetList.p01;
    state.captions = captionSettings(p, state.captions);
    renderCaptionsPanel();
    renderGuides();
    log('Preset 01 (Caption engine) applied to the caption settings.');
  }

  /** Apply, then generate captions (and chips) for the selection. One undo entry. */
  async function generateP01() {
    applyP01();
    const r = generateCaptions();
    renderPanel();
    return r;
  }

  /**
   * Keyword blowups the current settings would place, against the rack's density rule of
   * one per 8-12 seconds. Measured over the selection's transcripts.
   */
  function blowDensity(p) {
    if (!p.blowOn) return null;
    const keys = String(p.blowWords || '').split(/[,\s]+/).map(Captions.normWord).filter(Boolean);
    if (!keys.length) return null;
    let n = 0, secs = 0;
    for (const u of captionUnits()) {
      if (!u.audio) continue;
      const words = transcriptFor(u.audio.src);
      if (!words) continue;
      secs += u.audio.out - u.audio.in;
      for (const w of words) {
        if (w.start >= u.audio.in && w.start < u.audio.out && keys.includes(Captions.normWord(w.w))) n++;
      }
    }
    return secs > 0 ? { n, secs } : null;
  }

  // ------------------------------------------------------------- CAP_role

  /** The role tag's card: a name in the display face under a mono eyebrow. */
  function roleCard(p) {
    const card = TextModel.defaultCard(p.roleName || 'Name');
    const st = card.style;
    st.fontFamily = p.fontFamily;
    st.fontSize = p.roleNameSize;
    st.bold = true;
    st.align = 'left';
    st.maxWidth = 1 - p.roleX;
    st.letterSpacing = p.roleNameSize * p.tracking / 100;
    st.lineHeight = 1.1;
    st.y = p.roleY;
    st.fill = Object.assign({}, st.fill, { type: 'solid', color: p.color });
    st.stroke = Object.assign({}, st.stroke, { on: false });
    st.shadow = Object.assign({}, st.shadow, {
      on: true, distance: p.shadowDistance, angle: 90, blur: p.shadowBlur, opacity: p.shadowOpacity,
    });
    card.animEnabled = true;
    card.anims = [];
    card.eyebrow = {
      text: p.roleEyebrow, fontFamily: p.chipFont || 'Consolas', fontSize: p.roleEyebrowSize,
      opacity: p.roleEyebrowOpacity, letterSpacing: p.roleEyebrowSize * 0.08, gap: 10,
    };
    // Hard in, and out on a 4-frame mask wipe down.
    card.mask = { out: { dur: Math.max(0.01, p.roleExit) } };
    return card;
  }

  /**
   * Put the block's LEFT edge at `roleX`. A card is positioned by its centre, so the
   * card is measured once at the output size and moved by the difference.
   */
  function placeLeft(clip, leftFrac) {
    const W = state.out.w, H = state.out.h;
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 4;
    const ctx = cv.getContext('2d');
    clip.card.style.x = 0.5;
    const m = TextDraw.measure(ctx, clip, W, H, clip.out - 0.001);
    const left = Math.min(m.box.x, m.block.x);
    clip.card.style.x = 0.5 + (leftFrac * W - left) / W;
  }

  /** Add a role tag at the playhead, on a TAG track of its own. One undo entry. */
  function addRoleTag() {
    const p = state.presetList.p01;
    const start = state.playhead;
    const len = Math.max(0.2, p.roleHold);
    let track = state.tracks.find((x) => x.type === 'video' && x.roleTags);
    if (track && track.clips.some((c) => c.start < start + len - 1e-6 && c.start + (c.out - c.in) > start + 1e-6)) {
      log('A role tag is already on screen there - move the playhead past it.');
      return null;
    }
    pushUndo();
    if (!track) {
      track = makeTrack('video', state.tracks.filter((x) => x.type === 'video').length + 1);
      track.name = 'TAG';
      track.roleTags = true;
      state.tracks.unshift(track);
    }
    const clip = {
      id: nextId(), src: null, name: 'Role tag', kind: 'text',
      start, in: 0, out: len, mediaDuration: 3600,
      srcW: 0, srcH: 0, fps: 0, panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
      card: roleCard(p),
    };
    placeLeft(clip, p.roleX);
    track.clips.push(clip);
    sortTracks();
    setSelection([clip.id], false);
    markDirty();
    renderAll();
    log('Added a role tag at ' + fmtTc(start) + '.');
    return clip;
  }

  // ------------------------------------------------------------- CAP_guides

  /** Lay the caption guides over the viewer. DOM only - see index.html. */
  function renderGuides() {
    const box = document.getElementById('rackGuides');
    if (!box || typeof canvas === 'undefined') return;
    const p = state.presetList && state.presetList.p01;
    if (!p || !p.guidesOn) { box.hidden = true; return; }
    box.hidden = false;
    box.style.left = canvas.offsetLeft + 'px';
    box.style.top = canvas.offsetTop + 'px';
    box.style.width = canvas.offsetWidth + 'px';
    box.style.height = canvas.offsetHeight + 'px';
    box.style.opacity = String(p.guideOpacity);
    const pc = (v) => (Math.max(0, Math.min(1, v)) * 100) + '%';
    box.querySelector('.rg-top').style.height = pc(p.guideTop);
    box.querySelector('.rg-bottom').style.height = pc(p.guideBottom);
    const rail = box.querySelector('.rg-rail');
    rail.style.width = pc(p.guideRail);
    rail.style.top = pc(p.guideRailFrom);
    rail.style.bottom = pc(p.guideBottom);
  }

  // ------------------------------------------------------ 02 / 03 on the timeline
  //
  // Both write ORDINARY effects onto the selected clips - a keyed `transform` for a push, a
  // `split` (and optionally an `edgefade`) for a split screen - so everything they make is
  // then editable in the clip's own Effects panel: the keys, the curve on each key, the
  // shutter. Each entry is tagged with `preset` so applying again REPLACES what the last
  // apply made instead of stacking a second push on top of the first.

  /** Clips a picture preset can go on: anything that paints, and adjustment layers. */
  const PICTURE_KINDS = new Set(['video', 'image', 'graphic', 'adjust', 'text']);

  function pictureTargets() {
    return selectedClips().map((x) => x.clip).filter((c) => PICTURE_KINDS.has(c.kind));
  }

  function lenOf(c) {
    try { return Math.max(0.001, clipLen(c)); } catch (e) { return Math.max(0.001, c.out - c.in); }
  }

  const easeOf = (name) => JSON.parse(JSON.stringify(
    Anim.EASING_PRESETS[name] || Anim.EASING_PRESETS.linear));

  /**
   * The push as a `transform` entry for one clip. Pure: builds the entry, touches nothing.
   * `dir` is 'in' (1 -> 1 + amount) or 'out' (1 + amount -> 1); the curve is on the first
   * key, because easing belongs to the key on the LEFT of a span.
   */
  function pushEntry(p, clip, dir, speed, playhead) {
    const len = lenOf(clip);
    const pre = speed === 'fast' ? 'fast' : speed === 'medium' ? 'med' : 'slow';
    const amount = Math.max(0, Number(p[pre + 'Amount']) || 0);
    let t0 = 0, dur = len;
    if (speed !== 'slow') {
      dur = Math.min(len, Math.max(F(1), Number(p[pre + 'Dur']) || F(6)));
      if (p.at === 'end') t0 = len - dur;
      else if (p.at === 'playhead') t0 = Math.max(0, Math.min(len - dur, playhead - clip.start));
    }
    const a = dir === 'out' ? 1 + amount : 1, b = dir === 'out' ? 1 : 1 + amount;
    const e = FX.create('transform');
    e.preset = 'push';
    e.params.anchorX = p.anchorX;
    e.params.anchorY = p.anchorY;
    e.params.scale = a;
    e.keys = { scale: [
      { t: t0, v: a, ease: easeOf(p[pre + 'Ease']) },
      { t: t0 + dur, v: b, ease: easeOf('linear') },
    ] };
    if (speed !== 'slow' && Number(p[pre + 'Blur']) > 0) {
      e.mblur = { on: true, strength: Number(p[pre + 'Blur']), samples: Math.round(p[pre + 'Samples']) || 8 };
    }
    return e;
  }

  const isTagged = (tag) => (f) => f && f.preset === tag;

  /** Push in or out on every selected picture clip. One undo entry. */
  function applyPush(dir, speed) {
    const p = state.presetList.p02;
    speed = speed || p.speed;
    const clips = pictureTargets();
    if (!clips.length) { log('Select a clip, still, text card or adjustment layer first.'); return 0; }
    pushUndo();
    for (const c of clips) {
      const fx = (c.fx || []).filter((f) => !isTagged('push')(f));
      // Before a split: the push zooms the picture, then the split places it in its band.
      let at = fx.findIndex((f) => f.type === 'split');
      if (at < 0) at = fx.length;
      fx.splice(at, 0, pushEntry(p, c, dir, speed, state.playhead));
      c.fx = fx;
      FX.normalizeClip(c);
    }
    markDirty();
    renderAll();
    log((speed === 'medium' ? 'Medium' : speed === 'slow' ? 'Slow' : 'Fast') + ' push ' + dir +
      ' on ' + clips.length + ' clip(s).');
    return clips.length;
  }

  /** Take off whatever a preset tagged `tag` put on the selection. One undo entry. */
  function removeTagged(tags, what) {
    const clips = pictureTargets().filter((c) => (c.fx || []).some((f) => tags.includes(f.preset)));
    if (!clips.length) { log('Nothing to remove - no ' + what + ' on the selection.'); return 0; }
    pushUndo();
    for (const c of clips) {
      c.fx = c.fx.filter((f) => !tags.includes(f.preset));
      FX.normalizeClip(c);
    }
    markDirty();
    renderAll();
    log('Removed the ' + what + ' from ' + clips.length + ' clip(s).');
    return clips.length;
  }

  /** The split's entries for one set of parameters: the band, and the seam if asked for. */
  function splitEntries(p, side, clip, playhead) {
    const s = FX.create('split');
    s.preset = 'split';
    Object.assign(s.params, {
      side, size: p.size, focus: p.focus, zoom: p.zoom, distance: p.distance, mix: 1, seam: p.seam,
    });
    // The glide: `mix` keyed 0 -> 1 (and 1 -> 0 at the end), the curve on the first key of
    // each span. Nothing keyed when neither end animates, so the split is simply there.
    const keys = [];
    if (clip && (p.animIn || p.animOut)) {
      const len = lenOf(clip);
      const dur = Math.min(Math.max(F(1), Number(p.animDur) || F(12)), len / ((p.animIn && p.animOut) ? 2 : 1));
      if (p.animIn) {
        const t0 = p.animAt === 'playhead'
          ? Math.max(0, Math.min(len - dur, playhead - clip.start)) : 0;
        keys.push({ t: t0, v: 0, ease: easeOf(p.animEase) }, { t: t0 + dur, v: 1, ease: easeOf(p.animEase) });
      }
      if (p.animOut) {
        const t1 = len - dur;
        if (!keys.length || t1 >= keys[keys.length - 1].t) {
          keys.push({ t: t1, v: 1, ease: easeOf(p.animEase) }, { t: len, v: 0, ease: easeOf('linear') });
        }
      }
    }
    if (keys.length) {
      s.keys = { mix: keys };
      if (Number(p.animBlur) > 0) {
        s.mblur = { on: true, strength: Number(p.animBlur), samples: Math.round(p.animSamples) || 8 };
      }
    }
    return [s];
  }

  /** Move every selected picture clip into the top or bottom half. One undo entry. */
  function applySplit(side) {
    const p = state.presetList.p03;
    side = side || p.side;
    const clips = pictureTargets();
    if (!clips.length) { log('Select a clip or still first.'); return 0; }
    pushUndo();
    for (const c of clips) {
      c.fx = (c.fx || []).filter((f) => !isTagged('split')(f)).concat(splitEntries(p, side, c, state.playhead));
      FX.normalizeClip(c);
    }
    markDirty();
    renderAll();
    log('Split screen: ' + clips.length + ' clip(s) moved to the ' + side + ' half.');
    return clips.length;
  }

  // ------------------------------------------------ 04-09: animated effects on clips
  //
  // 05-09 are one effect each, and their parameters ARE that effect's parameters plus a
  // shutter: the panel is built from `FX.DEFS[type].schema`, so a parameter added to the
  // effect turns up here with no second list to keep in step. Apply writes one tagged
  // entry per clip, replacing the last one this preset made.

  const FXP = {
    p05: { type: 'shine', tag: 'shine', blur: 0 },
    p06: { type: 'glowanim', tag: 'glow', blur: 0 },
    p07: { type: 'strike', tag: 'strike', blur: 0, textOnly: true },
    p08: { type: 'emphasis', tag: 'emphasis', blur: 0.6, geo: true },
    p09: { type: 'motion', tag: 'motion', blur: 0.6, geo: true },
  };
  for (const [key, d] of Object.entries(FXP)) {
    TABLES[key] = Object.assign({}, FX.DEFS[d.type].params, { blur: d.blur, samples: 8 });
  }
  /** 04's own settings: the curve a newly drawn rectangle's move gets, and the shutter. */
  TABLES.p04 = { ease: 'easeInOut', blur: 0.6, samples: 8, fit: 'contain' };

  /*
   * The looks inside a preset, in GROUPS. A look sets only the values it names, and the
   * looks of different groups name different values - so one look from each group can be
   * on at once (a look is lit while every value it names still holds). A look with `off`
   * is a switch: clicking it while it is lit sets those values instead.
   */
  const LOOKS = {
    p06: [
      { group: 'Glows for', items: [
        { name: 'Whole clip', v: { mode: 'whole' }, title: 'Glows from the start of the clip to the end, in and out included' },
        { name: 'Chosen span', v: { mode: 'span' }, title: 'Glows for Glow duration from Span starts at, in and out included' },
      ] },
    ],
    p07: [
      { group: 'Look', items: [
        { name: 'Rough pencil', v: { style: 'pencil', colour: '#e8203a', thickness: 0.09, opacity: 1, height: 0.52, rough: 0.5, behind: false, tilt: -1.5 } },
        { name: 'Highlighter', v: { style: 'highlighter', colour: '#ffe14d', thickness: 0.6, opacity: 0.45, height: 0.55, rough: 0.4, behind: true, tilt: -0.8 } },
        { name: 'Clean line', v: { style: 'line', colour: '#ffffff', thickness: 0.07, opacity: 1, height: 0.5, rough: 0, behind: false, tilt: 0 } },
      ] },
    ],
    p08: [
      { group: 'In / out', items: [
        { name: 'Pop', v: { inOpacity: 0, inScale: 0, outOpacity: 0.5, outScale: 0.75, inEase: 'softLand' } },
        { name: 'Soft', v: { inOpacity: 0, inScale: 0.8, outOpacity: 0.7, outScale: 0.9, inEase: 'softLand' } },
        { name: 'Overshoot', v: { inOpacity: 0, inScale: 0, outOpacity: 0.5, outScale: 0.75, inEase: 'backOut' } },
        { name: 'Size only', v: { inOpacity: 1, inScale: 0, outOpacity: 1, outScale: 0.75 } },
        { name: 'Fade only', v: { inOpacity: 0, inScale: 1, outOpacity: 0.5, outScale: 1 } },
        { name: 'In only', v: { inOpacity: 0, inScale: 0, outOpacity: 1, outScale: 1 } },
        { name: 'Vanish', v: { inOpacity: 0, inScale: 0.5, outOpacity: 0, outScale: 0 } },
      ] },
      { group: 'Across the clip', items: [
        { name: 'Slow zoom in', v: { drift: 1.1 }, title: 'Creeps 10% bigger from the first frame to the last' },
        { name: 'Slow zoom out', v: { drift: 0.9 }, title: 'Creeps 10% smaller from the first frame to the last' },
        { name: 'No drift', v: { drift: 1 } },
      ] },
    ],
    p09: [
      { group: 'Phases', items: [
        { name: 'In + out', v: { inOn: true, midOn: false, outOn: true } },
        { name: 'In + mid + out', v: { inOn: true, midOn: true, outOn: true } },
        { name: 'Mid only', v: { inOn: false, midOn: true, outOn: false } },
      ] },
      { group: 'In / out', items: [
        { name: 'Push in', v: { inScale: 0.85, inRotate: -3, outScale: 1.12, outRotate: 2 } },
        { name: 'Push out', v: { inScale: 1.2, inRotate: 3, outScale: 0.9, outRotate: -2 } },
        { name: 'Zero to 100', v: { inScale: 0, outScale: 0 }, title: 'Grows from nothing on the way in, shrinks to nothing on the way out' },
      ] },
      { group: 'Mid', items: [
        { name: 'Handheld', v: { midScale: 1.02, midRotate: 0, wiggle: 0.012, wiggleRot: 1.2, wiggleScale: 0.01, wiggleFreq: 0.9 } },
        { name: 'Slow zoom in + tilt', v: { midScale: 1.06, midRotate: 1.5, wiggle: 0, wiggleRot: 0, wiggleScale: 0 }, title: 'A slow push with a slight turn - no wiggle' },
        { name: 'Slow zoom out + tilt', v: { midScale: 0.95, midRotate: -1.5, wiggle: 0, wiggleRot: 0, wiggleScale: 0 }, title: 'A slow pull back with a slight turn - no wiggle' },
      ] },
      { group: 'Fades', items: [
        { name: 'Fade in', v: { fadeIn: true }, off: { fadeIn: false } },
        { name: 'Fade out', v: { fadeOut: true }, off: { fadeOut: false } },
      ] },
    ],
  };

  function fxTargets(d) {
    const all = pictureTargets();
    return d && d.textOnly ? all.filter((c) => c.kind === 'text') : all;
  }

  /** Put the rack's version of `key`'s effect on every target. One undo entry. */
  function applyFx(key) {
    const d = FXP[key];
    const p = state.presetList[key];
    const clips = fxTargets(d);
    if (!clips.length) {
      log(d.textOnly ? 'Select a text card first - a strikethrough follows the card\'s lines.'
        : 'Select a clip, still, graphic, text card or adjustment layer first.');
      return 0;
    }
    pushUndo();
    for (const c of clips) {
      const fx = (c.fx || []).filter((f) => f.preset !== d.tag);
      const e = FX.create(d.type);
      e.preset = d.tag;
      for (const k of Object.keys(e.params)) if (p[k] !== undefined) e.params[k] = p[k];
      if (Number(p.blur) > 0) e.mblur = { on: true, strength: Number(p.blur), samples: Math.round(p.samples) || 8 };
      // A move goes before a split, so the band is placed after it; a look goes last.
      let at = d.geo ? fx.findIndex((f) => f.type === 'split') : -1;
      if (at < 0) at = fx.length;
      fx.splice(at, 0, e);
      c.fx = fx;
      FX.normalizeClip(c);
    }
    markDirty();
    renderAll();
    log(FX.DEFS[d.type].label + ' on ' + clips.length + ' clip(s).');
    return clips.length;
  }

  // ------------------------------------------------------------ 04 Camera move

  /** Drawing mode - UI only, never saved. */
  const cam = { drawing: false, drag: null };

  function camClip() { return pictureTargets()[0] || null; }
  function camEntry(clip) { return clip && (clip.fx || []).find((f) => f.preset === 'camera') || null; }
  function camTimes(e) { return e && e.keys && e.keys.cx ? e.keys.cx.map((k) => k.t) : []; }
  const CAM_PROPS = ['cx', 'cy', 'size', 'h'];

  /** A camera rectangle with its height made explicit (a key from before free shapes has none). */
  function camRect(e, t) {
    const r = FX.paramsAt(e, t);
    return { cx: r.cx, cy: r.cy, size: r.size, h: Number(r.h) > 0 ? r.h : r.size };
  }

  /** A rectangle at the playhead: a new key, or the one already there replaced. */
  function addCamKey(clip, rect) {
    const len = lenOf(clip);
    const t = state.playhead - clip.start;
    if (t < -1e-6 || t > len + 1e-6) { log('Move the playhead over the clip to key its camera.'); return false; }
    const lt = Math.max(0, Math.min(len, t));
    const p = state.presetList.p04;
    pushUndo();
    let e = camEntry(clip);
    if (!e) {
      e = FX.create('camera');
      e.preset = 'camera';
      const fx = clip.fx || [];
      let at = fx.findIndex((f) => f.type === 'split');
      if (at < 0) at = fx.length;
      fx.splice(at, 0, e);
      clip.fx = fx;
    }
    if (Number(p.blur) > 0) e.mblur = { on: true, strength: Number(p.blur), samples: Math.round(p.samples) || 8 };
    e.params.fit = p.fit;
    e.keys = e.keys || {};
    // Keys drawn before free shapes have no height track. Give them one holding the shape
    // they always had, so a free rectangle added now does not reshape the old ones.
    if (e.keys.cx && e.keys.cx.length && !(e.keys.h && e.keys.h.length)) {
      e.keys.h = e.keys.cx.map((q) => ({ t: q.t, v: camRect(e, q.t).h, ease: q.ease }));
    }
    for (const k of CAM_PROPS) {
      const tr = e.keys[k] = e.keys[k] || [];
      const key = { t: lt, v: rect[k], ease: easeOf(p.ease) };
      const i = tr.findIndex((q) => Math.abs(q.t - lt) < 1e-3);
      if (i >= 0) { key.ease = tr[i].ease; tr[i] = key; } else tr.push(key);
      Anim.sortKeys(tr);
      e.params[k] = rect[k];
    }
    FX.normalizeClip(clip);
    markDirty();
    renderAll();
    return true;
  }

  function camEdit(fn) {
    const clip = camClip(), e = camEntry(clip);
    if (!e) return;
    pushUndo();
    fn(e, clip);
    FX.normalizeClip(clip);
    markDirty();
    renderAll();
  }

  function deleteCamKey(t) {
    camEdit((e, clip) => {
      for (const k of CAM_PROPS) if (e.keys && e.keys[k]) e.keys[k] = e.keys[k].filter((q) => Math.abs(q.t - t) >= 1e-3);
      if (!camTimes(e).length) clip.fx = clip.fx.filter((f) => f !== e);
    });
  }

  function setCamEase(t, name) {
    camEdit((e) => {
      for (const k of CAM_PROPS) {
        for (const q of (e.keys && e.keys[k]) || []) if (Math.abs(q.t - t) < 1e-3) q.ease = easeOf(name);
      }
    });
  }

  function setDrawing(on) {
    on = !!on;
    if (cam.drawing === on) return;
    cam.drawing = on;
    cam.drag = null;
    FX.setCameraEdit(on);
    syncCamOverlay();
    try { drawPreview(); } catch (e) { /* before the viewer exists */ }
  }

  /** The overlay: every key's rectangle, the one under the playhead bright. DOM only. */
  function syncCamOverlay() {
    const ov = document.getElementById('camOverlay');
    if (!ov) return;
    if (!cam.drawing || typeof canvas === 'undefined') { ov.hidden = true; return; }
    ov.hidden = false;
    const CW = canvas.offsetWidth, CH = canvas.offsetHeight;
    ov.style.left = canvas.offsetLeft + 'px';
    ov.style.top = canvas.offsetTop + 'px';
    ov.style.width = CW + 'px';
    ov.style.height = CH + 'px';
    const dpr = window.devicePixelRatio || 1;
    if (ov.width !== Math.round(CW * dpr) || ov.height !== Math.round(CH * dpr)) {
      ov.width = Math.round(CW * dpr); ov.height = Math.round(CH * dpr);
    }
    const c = ov.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, CW, CH);
    const box = (r) => {
      const w = r.size * CW, h = (Number(r.h) > 0 ? r.h : r.size) * CH;
      return [r.cx * CW - w / 2, r.cy * CH - h / 2, w, h];
    };
    const clip = camClip(), e = camEntry(clip);
    const here = clip ? state.playhead - clip.start : -1;
    if (e) {
      for (const t of camTimes(e)) {
        const r = camRect(e, t);
        const on = Math.abs(t - here) < 1e-3;
        c.setLineDash(on ? [] : [6, 4]);
        c.lineWidth = on ? 3 : 1.5;
        c.strokeStyle = on ? '#ffd400' : 'rgba(255,212,0,0.55)';
        c.strokeRect(...box(r));
        const b = box(r);
        c.fillStyle = on ? '#ffd400' : 'rgba(255,212,0,0.7)';
        c.font = '11px Segoe UI, sans-serif';
        c.fillText(t.toFixed(2) + 's', b[0] + 4, b[1] + 13);
      }
      if (here >= 0 && !camTimes(e).some((t) => Math.abs(t - here) < 1e-3)) {
        // Where the camera is between keys, so the next rectangle can be drawn against it.
        c.setLineDash([2, 3]);
        c.lineWidth = 1.5;
        c.strokeStyle = '#ffffff';
        c.strokeRect(...box(camRect(e, here)));
      }
      // Handles on the rectangle a drag would edit.
      const cur = !cam.drag && here >= 0 ? camRect(e, here) : null;
      if (cur) {
        c.setLineDash([]);
        c.fillStyle = '#ffd400';
        for (const [hx, hy] of camHandles(box(cur))) c.fillRect(hx - 4, hy - 4, 8, 8);
      }
    }
    if (cam.drag && cam.drag.rect) {
      c.setLineDash([]);
      c.lineWidth = 3;
      c.strokeStyle = '#ffd400';
      c.fillStyle = 'rgba(255,212,0,0.12)';
      const b = box(cam.drag.rect);
      c.fillRect(...b);
      c.strokeRect(...b);
    }
  }

  /** The eight handles of a box [x, y, w, h], as [x, y, sx, sy] - sx/sy say which edges move. */
  function camHandles(b) {
    const [x, y, w, h] = b;
    const out = [];
    for (const sy of [-1, 0, 1]) {
      for (const sx of [-1, 0, 1]) {
        if (sx || sy) out.push([x + w / 2 + sx * w / 2, y + h / 2 + sy * h / 2, sx, sy]);
      }
    }
    return out;
  }

  /*
   * The overlay's three gestures, all on the rectangle under the playhead (the key there,
   * or where the camera is between keys): drag a HANDLE to resize it, drag INSIDE it to
   * move it, drag anywhere else to draw a new one. Any shape; hold Shift to keep the
   * frame's shape. Letting go writes a key at the playhead - one undo entry.
   */
  function wireCamOverlay() {
    const ov = document.getElementById('camOverlay');
    if (!ov) return;
    const at = (ev) => {
      const r = ov.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height, W: r.width, H: r.height };
    };
    const norm = (x0, y0, x1, y1) => ({
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      size: Math.max(0.01, Math.abs(x1 - x0)), h: Math.max(0.01, Math.abs(y1 - y0)),
    });
    ov.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const clip = camClip();
      if (!clip) { log('Select the clip to key first.'); return; }
      ov.setPointerCapture(ev.pointerId);
      const pt = at(ev);
      const e = camEntry(clip);
      const cur = e ? camRect(e, state.playhead - clip.start) : null;
      if (cur) {
        const x0 = cur.cx - cur.size / 2, x1 = cur.cx + cur.size / 2;
        const y0 = cur.cy - cur.h / 2, y1 = cur.cy + cur.h / 2;
        const tol = 7;
        const hit = camHandles([x0 * pt.W, y0 * pt.H, cur.size * pt.W, cur.h * pt.H])
          .find(([hx, hy]) => Math.abs(hx - pt.x * pt.W) <= tol && Math.abs(hy - pt.y * pt.H) <= tol);
        if (hit) { cam.drag = { mode: 'size', sx: hit[2], sy: hit[3], box: [x0, y0, x1, y1], rect: cur }; return; }
        if (pt.x > x0 && pt.x < x1 && pt.y > y0 && pt.y < y1) {
          cam.drag = { mode: 'move', a: pt, from: cur, rect: cur };
          return;
        }
      }
      cam.drag = { mode: 'draw', a: pt, rect: null };
    });
    ov.addEventListener('pointermove', (ev) => {
      const d = cam.drag;
      if (!d) return;
      const b = at(ev);
      if (d.mode === 'move') {
        d.rect = Object.assign({}, d.from, { cx: d.from.cx + b.x - d.a.x, cy: d.from.cy + b.y - d.a.y });
      } else if (d.mode === 'size') {
        let [x0, y0, x1, y1] = d.box;
        if (d.sx < 0) x0 = b.x; else if (d.sx > 0) x1 = b.x;
        if (d.sy < 0) y0 = b.y; else if (d.sy > 0) y1 = b.y;
        d.rect = norm(x0, y0, x1, y1);
      } else {
        let x1 = b.x, y1 = b.y;
        if (ev.shiftKey) {
          // The frame's own shape: equal fractions on both axes.
          const s = Math.max(Math.abs(x1 - d.a.x), Math.abs(y1 - d.a.y));
          x1 = d.a.x + Math.sign(x1 - d.a.x || 1) * s;
          y1 = d.a.y + Math.sign(y1 - d.a.y || 1) * s;
        }
        d.rect = norm(d.a.x, d.a.y, x1, y1);
      }
      syncCamOverlay();
    });
    ov.addEventListener('pointerup', (ev) => {
      ev.stopPropagation();
      const d = cam.drag;
      cam.drag = null;
      const clip = camClip();
      const moved = d && d.rect && (d.mode !== 'move' || d.rect !== d.from);
      if (moved && d.rect.size > 0.02 && d.rect.h > 0.02 && clip && addCamKey(clip, d.rect)) {
        log('Camera key at ' + (state.playhead - clip.start).toFixed(2) + 's into the clip.');
      }
      syncCamOverlay();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireCamOverlay);
  else wireCamOverlay();

  function p04Body(box) {
    const el = TextUI.el;
    const p = state.presetList.p04;
    const clip = camClip(), e = camEntry(clip);
    const C = (spec) => TextUI.control(spec, p, TABLES.p04, settingHooks());
    const top = box.querySelector('.pl-top');
    top.appendChild(el('div', 'tc-hint cap-status', !clip ? 'Select a clip on the timeline.'
      : (e ? camTimes(e).length + ' camera key(s) on ' : 'No camera keys yet on ') + (clip.name || 'this clip') + '.'));
    const bar = el('div', 'tc-btns cap-bar');
    const drawBtn = el('button', 'mini' + (cam.drawing ? ' on' : ' primary'), cam.drawing ? 'Done drawing' : 'Draw rectangle');
    drawBtn.title = 'Drag a yellow rectangle on the viewer: that part of the picture fills the ' +
      'frame at the playhead. Move the playhead and draw another - the camera moves between them.';
    drawBtn.disabled = !clip;
    drawBtn.addEventListener('click', () => { setDrawing(!cam.drawing); renderPanel(); });
    const fullBtn = el('button', 'mini', 'Full frame here');
    fullBtn.title = 'A key at the playhead showing the whole frame - to start from, or come back to.';
    fullBtn.disabled = !clip;
    fullBtn.addEventListener('click', () => { if (clip) addCamKey(clip, { cx: 0.5, cy: 0.5, size: 1, h: 1 }); });
    const holdBtn = el('button', 'mini', 'Hold here');
    holdBtn.title = 'A key at the playhead that keeps the camera where it is right now - holds between two moves.';
    holdBtn.disabled = !e;
    holdBtn.addEventListener('click', () => { if (e) addCamKey(clip, camRect(e, state.playhead - clip.start)); });
    const rmBtn = el('button', 'mini', 'Remove camera');
    rmBtn.disabled = !e;
    rmBtn.addEventListener('click', () => removeTagged(['camera'], 'camera move'));
    for (const b of [drawBtn, fullBtn, holdBtn, rmBtn]) bar.appendChild(b);
    top.appendChild(bar);

    const body = el('div', 'pl-body');
    box.appendChild(body);
    body.appendChild(el('div', 'tc-hint', 'CAM_rect - draw a rectangle at one moment, another ' +
      'at a later one, and the camera travels from the first to the second along the curve. ' +
      'Add as many as you like on one clip: every pair is its own move, and two keys with the ' +
      'same rectangle hold. Any shape: drag inside the rectangle to move it, drag a handle to ' +
      'resize it, drag elsewhere to draw a new one (Shift keeps the frame\'s shape). While ' +
      'drawing, the viewer shows the whole frame; press Done to see the move.'));
    body.appendChild(C({ path: 'ease', label: 'Curve for new keys', type: 'select', options: Anim.EASING_MENU }));
    body.appendChild(C({ path: 'fit', label: 'Rectangle shape', type: 'buttons', options: [
      { value: 'contain', label: 'Show all of it', title: 'The whole rectangle is on screen; more picture shows around its short side' },
      { value: 'cover', label: 'Fill the frame', title: 'The rectangle fills the frame; its long side is trimmed' },
    ] }));
    body.appendChild(C({ path: 'blur', label: 'Motion blur', type: 'range', min: 0, max: 4, step: 0.05, digits: 2 }));
    body.appendChild(C({ path: 'samples', label: 'Blur samples', type: 'range', min: 2, max: 32, step: 1, digits: 0 }));
    if (!e) return;
    body.appendChild(el('div', 'tc-hint', 'Keys - the curve on a key is the move to the NEXT one.'));
    const times = camTimes(e);
    times.forEach((t, i) => {
      const row = el('div', 'tc-row');
      const r = camRect(e, t);
      row.appendChild(el('label', 'tc-label', t.toFixed(2) + 's  ·  ' + Math.round(r.size * 100) + ' x ' +
        Math.round(r.h * 100) + '% of frame'));
      const go = el('button', 'mini', 'Go');
      go.title = 'Put the playhead on this key';
      go.addEventListener('click', () => { seek(clip.start + t); renderPanel(); });
      row.appendChild(go);
      const sel = el('select');
      for (const o of Anim.EASING_MENU) {
        const op = el('option'); op.value = o.value; op.textContent = o.label; sel.appendChild(op);
      }
      const k = e.keys.cx.find((q) => Math.abs(q.t - t) < 1e-3);
      sel.value = Anim.easingName(k && k.ease) || 'linear';
      sel.disabled = i === times.length - 1;
      sel.title = sel.disabled ? 'The last key has no move after it' : 'The curve of the move to the next key';
      sel.addEventListener('change', () => setCamEase(t, sel.value));
      row.appendChild(sel);
      const del = el('button', 'mini', 'Delete');
      del.addEventListener('click', () => deleteCamKey(t));
      row.appendChild(del);
      body.appendChild(row);
    });
  }

  /** 05-09: the effect's own schema, the looks, the shutter. */
  function fxBody(box, key) {
    const el = TextUI.el;
    const d = FXP[key];
    const p = state.presetList[key];
    const n = fxTargets(d).length;
    const top = box.querySelector('.pl-top');
    top.appendChild(el('div', 'tc-hint cap-status', n ? n + ' clip(s) selected.'
      : d.textOnly ? 'Select a text card on the timeline.'
        : 'Select a clip, still, graphic, text card or adjustment layer on the timeline.'));
    const bar = el('div', 'tc-btns cap-bar');
    const apply = el('button', 'mini primary', 'Apply');
    apply.title = 'Put this on the selected clips - one undo entry. Applying again replaces it.';
    apply.disabled = !n;
    apply.addEventListener('click', () => applyFx(key));
    const rm = el('button', 'mini', 'Remove');
    rm.disabled = !n;
    rm.addEventListener('click', () => removeTagged([d.tag], FX.DEFS[d.type].label));
    bar.appendChild(apply); bar.appendChild(rm);
    top.appendChild(bar);

    if (LOOKS[key]) {
      const looks = el('div', 'pl-looks');
      for (const g of LOOKS[key]) {
        const row = el('div', 'pl-tabs');
        row.appendChild(el('span', 'tc-hint pl-group', g.group));
        for (const lk of g.items) {
          const on = Object.keys(lk.v).every((k) => p[k] === lk.v[k]);
          const b = el('button', 'mini' + (on ? ' on' : ''), lk.name);
          b.title = (lk.title ? lk.title + '. ' : '') +
            (lk.off ? 'Click to switch on or off.' : 'One per row; rows combine. Then Apply.');
          b.addEventListener('click', () => {
            Object.assign(p, on && lk.off ? lk.off : lk.v);
            renderPanel();
          });
          row.appendChild(b);
        }
        looks.appendChild(row);
      }
      box.appendChild(looks);
    }
    const body = el('div', 'pl-body');
    box.appendChild(body);
    body.appendChild(el('div', 'tc-hint', HINTS[key]));
    const hooks = settingHooks();
    for (const spec of FX.DEFS[d.type].schema) {
      const s = Object.assign({}, spec, { path: spec.path.replace(/^params\./, '') });
      body.appendChild(TextUI.control(s, p, TABLES[key], hooks));
    }
    body.appendChild(TextUI.control({ path: 'blur', label: 'Motion blur', type: 'range', min: 0, max: 4, step: 0.05, digits: 2 }, p, TABLES[key], hooks));
    body.appendChild(TextUI.control({ path: 'samples', label: 'Blur samples', type: 'range', min: 2, max: 32, step: 1, digits: 0 }, p, TABLES[key], hooks));
    body.appendChild(el('div', 'tc-hint', 'What lands on the clip is its ' + FX.DEFS[d.type].label +
      ' effect - every value stays editable, and keyframable, in the clip\'s Effects (text cards: from here).'));
  }

  const HINTS = {
    p05: 'SHN_sweep - a band of light crosses the picture, only where the picture is: it follows ' +
      'a logo\'s or a card\'s letters. Repeat it for a product-shot gleam.',
    p06: 'GLW_in-out - a glow blooms up at the start, holds (optionally breathing) and dies away at the end.',
    p07: 'STR_through - strikes the card\'s lines left to right, one after another. Text cards only.',
    p08: 'EMP_pop - opacity and size come up from the in values at the start, and settle to the ' +
      'out values at the end. The looks above only vary those four numbers and the curve.',
    p09: 'MOT_live - a push with a little rotation in, a slow drift that keeps wiggling in the ' +
      'middle, and a push out. Switch any phase off, or pick a look above.',
  };

  // ------------------------------------------------------------------ panel

  /** Which of 01's six sections is showing. UI only - not saved, not undone. */
  let p01Tab = 'pop';

  function p01Body(box) {
    const el = TextUI.el;
    const p = state.presetList.p01;
    const status = el('div', 'tc-hint cap-status');
    const hooks = {
      onEdit: () => {}, onEditEnd: () => {},
      onChanged: () => { renderGuides(); paint(); },
      rebuild: () => renderPanel(),
    };
    const C = (spec) => TextUI.control(spec, p, P01, hooks);
    const R = (path, label, min, max, step, digits, unit) =>
      C({ path, label, type: 'range', min, max, step, digits, unit });
    const hint = (body, text) => body.appendChild(el('div', 'tc-hint', text));

    const bar = el('div', 'tc-btns cap-bar');
    const applyBtn = el('button', 'mini', 'Apply to captions');
    const genBtn = el('button', 'mini primary', 'Apply + generate');
    const tagBtn = el('button', 'mini', 'Add role tag');
    applyBtn.title = 'Write these parameters into the Captions settings (no undo entry)';
    genBtn.title = 'Apply, then generate captions and metric chips for the selection - one undo entry';
    tagBtn.title = 'Add a speaker/role tag at the playhead - one undo entry';

    const paint = () => {
      const units = captionUnits().filter((u) => u.audio);
      const have = units.filter((u) => transcriptFor(u.audio.src)).length;
      const d = blowDensity(p);
      let msg = !units.length ? 'Select a clip with sound, then Apply + generate.'
        : !have ? 'No transcript yet - Transcribe or Import in the Captions panel.'
          : have + ' of ' + units.length + ' clip(s) transcribed.';
      if (d) {
        const per = d.n ? d.secs / d.n : Infinity;
        msg += ' Blowups: ' + d.n + ' in ' + d.secs.toFixed(1) + 's' +
          (d.n && per < 8 ? ' - more than one per 8s, it stops landing.' : '.');
      }
      status.textContent = msg;
      genBtn.disabled = !have;
    };

    bar.appendChild(applyBtn); bar.appendChild(genBtn); bar.appendChild(tagBtn);
    const top = box.querySelector('.pl-top');
    top.appendChild(status);
    top.appendChild(bar);

    // Six presets, six tabs: one is on screen at a time, so nothing needs scrolling to.
    const tabs = el('div', 'pl-tabs');
    const bodyHost = el('div', 'pl-body');
    box.appendChild(tabs);
    box.appendChild(bodyHost);
    const sections = [];
    const section = (key, title, build) => { sections.push({ key, title, build }); };

    section('pop', 'Word-pop', (body) => {
      hint(body, 'The default state for every second of dialogue. Weight and size carry it, ' +
        'a soft shadow keeps it legible, and only the spoken word moves.');
      const fonts = (TextUI.fonts && TextUI.fonts.length) ? TextUI.fonts : [p.fontFamily];
      body.appendChild(C({ path: 'fontFamily', label: 'Font', type: 'select', options: fonts }));
      body.appendChild(R('size', 'Size', 60, 180, 1, 0, 'px'));
      body.appendChild(C({ path: 'color', label: 'Fill', type: 'color' }));
      body.appendChild(C({ path: 'accent', label: 'Active word', type: 'color' }));
      body.appendChild(R('tracking', 'Tracking', -6, 4, 0.1, 1, '%'));
      body.appendChild(R('leading', 'Leading', 0.9, 1.4, 0.01, 2));
      body.appendChild(R('maxWords', 'Words per card', 1, 4, 1, 0));
      body.appendChild(R('maxWidth', 'Wrap width', 0.4, 1, 0.01, 2));
      body.appendChild(R('lineAt', 'Caption line at', 0.5, 0.85, 0.01, 2));
      body.appendChild(R('shadowDistance', 'Shadow drop', 0, 20, 1, 0, 'px'));
      body.appendChild(R('shadowBlur', 'Shadow blur', 0, 60, 1, 0, 'px'));
      body.appendChild(R('shadowOpacity', 'Shadow opacity', 0, 1, 0.01, 2));
      body.appendChild(R('activeScale', 'Active word scale', 1, 1.3, 0.01, 2));
      body.appendChild(R('activeOver', 'Active word over', F(1), F(12), F(1) / 2, 3, 's'));
    });

    section('blow', 'Blowup', (body) => {
      hint(body, 'One word per 8-12 s - the number, the objection, the verdict. It gets its ' +
        'own line, lands at 112% and settles in 4 frames. Pair it with a punch-in and a ' +
        'low thump: all three or none.');
      body.appendChild(C({ path: 'blowOn', label: 'Blowups on', type: 'check' }));
      body.appendChild(C({ path: 'blowWords', label: 'Blowup words', type: 'area' }));
      body.appendChild(R('blowScale', 'Size (x caption)', 1.2, 2, 0.01, 2));
      body.appendChild(R('blowFrom', 'Impact from', 1, 1.3, 0.01, 2));
      body.appendChild(R('blowOver', 'Settle over', F(1), F(12), F(1) / 2, 3, 's'));
      body.appendChild(C({ path: 'blowCaps', label: 'ALL CAPS', type: 'check' }));
      body.appendChild(C({ path: 'blowColor', label: 'Colour', type: 'color' }));
    });

    section('mark', 'Highlighter', (body) => {
      hint(body, 'Jargon being defined, or the one clause that carries the claim. Wiped in ' +
        'left to right with a soft edge.');
      body.appendChild(C({ path: 'markOn', label: 'Markers on', type: 'check' }));
      body.appendChild(C({ path: 'markWords', label: 'Marked words', type: 'area' }));
      body.appendChild(C({
        path: 'markMode', label: 'Fill', type: 'buttons', options: [
          { value: 'tint', label: 'Tint', title: 'Accent at low opacity, text unchanged' },
          { value: 'solid', label: 'Solid', title: 'Accent at 100%, text flipped to the ground colour' },
        ],
      }));
      body.appendChild(C({ path: 'markColor', label: 'Colour', type: 'color' }));
      body.appendChild(R('markOpacity', 'Tint opacity', 0.05, 1, 0.01, 2));
      body.appendChild(C({ path: 'markTextColor', label: 'Text on solid', type: 'color' }));
      body.appendChild(R('markRadius', 'Radius', 0, 24, 1, 0, 'px'));
      body.appendChild(R('markPadX', 'Padding across', 0, 40, 1, 0, 'px'));
      body.appendChild(R('markPadY', 'Padding down', 0, 30, 1, 0, 'px'));
      body.appendChild(R('markOver', 'Wipe over', F(1), F(12), F(1) / 2, 3, 's'));
      body.appendChild(R('markSoft', 'Soft edge', 0, 0.5, 0.01, 2));
      body.appendChild(R('markAngle', 'Angle', -3, 3, 0.1, 1, 'deg'));
    });

    section('chip', 'Metric chip', (body) => {
      hint(body, 'Any acronym spoken aloud gets a mono pill above the caption, with the ' +
        'figure said right after it ("NRR 118%"). Goes on its own CHIP track.');
      body.appendChild(C({ path: 'chipOn', label: 'Chips on', type: 'check' }));
      body.appendChild(C({ path: 'chipWords', label: 'Acronyms', type: 'area' }));
      const chipFonts = (TextUI.fonts && TextUI.fonts.length) ? TextUI.fonts.slice() : [];
      if (!chipFonts.includes(p.chipFont)) chipFonts.unshift(p.chipFont);
      body.appendChild(C({ path: 'chipFont', label: 'Font', type: 'select', options: chipFonts }));
      body.appendChild(R('chipSize', 'Size (x caption)', 0.4, 0.9, 0.01, 2));
      body.appendChild(R('chipTracking', 'Tracking', 0, 20, 0.5, 1, '%'));
      body.appendChild(R('chipHold', 'Hold', 0.5, 4, 0.05, 2, 's'));
      body.appendChild(R('chipReveal', 'Reveal over', F(1), F(15), F(1) / 2, 3, 's'));
      body.appendChild(R('chipRise', 'Reveal rise', 0, 60, 1, 0, 'px'));
      body.appendChild(R('chipGap', 'Above caption by', 0.02, 0.2, 0.005, 3));
    });

    section('role', 'Role tag', (body) => {
      hint(body, 'Multi-voice clips, podcast pulls, customer quotes. A mono eyebrow over a ' +
        'name, left-aligned; holds, then exits on a mask wipe down. Uses the word-pop face.');
      body.appendChild(C({ path: 'roleEyebrow', label: 'Eyebrow', type: 'text' }));
      body.appendChild(C({ path: 'roleName', label: 'Name', type: 'text' }));
      body.appendChild(R('roleEyebrowSize', 'Eyebrow size', 16, 60, 1, 0, 'px'));
      body.appendChild(R('roleEyebrowOpacity', 'Eyebrow opacity', 0.2, 1, 0.01, 2));
      body.appendChild(R('roleNameSize', 'Name size', 40, 140, 1, 0, 'px'));
      body.appendChild(R('roleX', 'Left edge', 0, 0.5, 0.01, 2));
      body.appendChild(R('roleY', 'Height', 0.05, 0.9, 0.01, 2));
      body.appendChild(R('roleHold', 'Hold', 0.5, 5, 0.05, 2, 's'));
      body.appendChild(R('roleExit', 'Exit wipe over', F(1), F(12), F(1) / 2, 3, 's'));
    });

    section('guide', 'Guides', (body) => {
      hint(body, 'Always on while editing: the platform chrome, the caption/CTA bar and the ' +
        'action rail. Drawn over the viewer only - never exported.');
      body.appendChild(C({ path: 'guidesOn', label: 'Show guides', type: 'check' }));
      body.appendChild(R('guideTop', 'Top mask', 0, 0.3, 0.005, 3));
      body.appendChild(R('guideBottom', 'Bottom mask', 0, 0.4, 0.005, 3));
      body.appendChild(R('guideRail', 'Right rail width', 0, 0.4, 0.005, 3));
      body.appendChild(R('guideRailFrom', 'Rail starts at', 0.2, 0.9, 0.005, 3));
      body.appendChild(R('guideOpacity', 'Opacity', 0.05, 0.8, 0.01, 2));
    });

    const FAMILY = { pop: 'CAP_word-pop', blow: 'CAP_blowup', mark: 'CAP_marker',
      chip: 'CAP_metric-chip', role: 'CAP_role', guide: 'CAP_guides' };
    const show = () => {
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === p01Tab));
      bodyHost.innerHTML = '';
      const sec = sections.find((x) => x.key === p01Tab) || sections[0];
      bodyHost.appendChild(el('div', 'tc-hint', FAMILY[sec.key]));
      sec.build(bodyHost);
      bodyHost.scrollTop = 0;
    };
    for (const sec of sections) {
      const b = el('button', 'mini', sec.title);
      b.dataset.k = sec.key;
      b.addEventListener('click', () => { p01Tab = sec.key; show(); });
      tabs.appendChild(b);
    }
    show();

    applyBtn.addEventListener('click', () => { applyP01(); paint(); });
    genBtn.addEventListener('click', () => { generateP01(); });
    tagBtn.addEventListener('click', () => addRoleTag());
    paint();
  }

  /** The shared head of 02 and 03: what is selected, and the action buttons. */
  function actionBar(box, buttons) {
    const el = TextUI.el;
    const status = el('div', 'tc-hint cap-status');
    const n = pictureTargets().length;
    status.textContent = n ? n + ' clip(s) selected.'
      : 'Select a clip, still, text card or adjustment layer on the timeline.';
    const bar = el('div', 'tc-btns cap-bar');
    for (const b of buttons) {
      const btn = el('button', 'mini' + (b.primary ? ' primary' : ''), b.label);
      btn.title = b.title;
      btn.disabled = !n;
      btn.addEventListener('click', b.run);
      bar.appendChild(btn);
    }
    const top = box.querySelector('.pl-top');
    top.appendChild(status);
    top.appendChild(bar);
  }

  /** Settings hooks: a preset parameter is a setting - no undo entry, nothing dirtied. */
  const settingHooks = () => ({
    onEdit: () => {}, onEditEnd: () => {}, onChanged: () => {}, rebuild: () => renderPanel(),
  });

  function p02Body(box) {
    const el = TextUI.el;
    const p = state.presetList.p02;
    const C = (spec) => TextUI.control(spec, p, P02, settingHooks());
    const R = (path, label, min, max, step, digits, unit) =>
      C({ path, label, type: 'range', min, max, step, digits, unit });
    const NAME = { fast: 'Fast', medium: 'Medium', slow: 'Slow' };
    actionBar(box, [
      { label: NAME[p.speed] + ' push in', primary: true, run: () => applyPush('in'),
        title: 'Zoom the selected clips in - one undo entry. Applying again replaces the last push.' },
      { label: NAME[p.speed] + ' push out', run: () => applyPush('out'),
        title: 'The same move reversed: starts pushed in and pulls back to the full frame.' },
      { label: 'Remove push', run: () => removeTagged(['push'], 'push'),
        title: 'Take the push off the selected clips - one undo entry.' },
    ]);

    const tabs = el('div', 'pl-tabs');
    const body = el('div', 'pl-body');
    box.appendChild(tabs);
    box.appendChild(body);
    for (const k of ['fast', 'medium', 'slow']) {
      const b = el('button', 'mini' + (p.speed === k ? ' on' : ''), NAME[k]);
      b.addEventListener('click', () => { p.speed = k; renderPanel(); });
      tabs.appendChild(b);
    }
    const curves = Anim.EASING_MENU;
    if (p.speed === 'fast') {
      body.appendChild(el('div', 'tc-hint', 'ZM_punch-fast - a whip into the subject in a ' +
        'handful of frames, smeared by the shutter. Lands on a beat, a word, a click.'));
      body.appendChild(R('fastAmount', 'Amount', 0.02, 1, 0.01, 2));
      body.appendChild(R('fastDur', 'Over', F(2), F(20), F(1) / 2, 3, 's'));
      body.appendChild(C({ path: 'fastEase', label: 'Curve', type: 'select', options: curves }));
      body.appendChild(R('fastBlur', 'Motion blur', 0, 4, 0.05, 2));
      body.appendChild(R('fastSamples', 'Blur samples', 2, 32, 1, 0));
    } else if (p.speed === 'medium') {
      body.appendChild(el('div', 'tc-hint', 'ZM_push-medium - a deliberate push over about ' +
        'half a second, with a lighter shutter. Emphasis without the jolt.'));
      body.appendChild(R('medAmount', 'Amount', 0.02, 1, 0.01, 2));
      body.appendChild(R('medDur', 'Over', F(6), F(60), F(1) / 2, 3, 's'));
      body.appendChild(C({ path: 'medEase', label: 'Curve', type: 'select', options: curves }));
      body.appendChild(R('medBlur', 'Motion blur', 0, 4, 0.05, 2));
      body.appendChild(R('medSamples', 'Blur samples', 2, 32, 1, 0));
    } else {
      body.appendChild(el('div', 'tc-hint', 'ZM_creep-slow - the picture creeps in from the ' +
        'first frame of the clip to the last. Keeps a static shot alive. No shutter: it ' +
        'moves too slowly to smear.'));
      body.appendChild(R('slowAmount', 'Amount', 0.01, 0.6, 0.01, 2));
      body.appendChild(C({ path: 'slowEase', label: 'Curve', type: 'select', options: curves }));
    }
    body.appendChild(el('div', 'tc-hint', 'Shared by all three'));
    body.appendChild(R('anchorX', 'Focus X', 0, 1, 0.01, 2));
    body.appendChild(R('anchorY', 'Focus Y', 0, 1, 0.01, 2));
    if (p.speed !== 'slow') {
      body.appendChild(C({
        path: 'at', label: 'Move sits at', type: 'buttons', options: [
          { value: 'start', label: 'Clip start' },
          { value: 'playhead', label: 'Playhead' },
          { value: 'end', label: 'Clip end' },
        ],
      }));
    }
    body.appendChild(el('div', 'tc-hint', 'What lands on each clip is an ordinary Transform ' +
      'effect with two Scale keys - open it in the clip\'s Effects to move the keys or change ' +
      'the curve per key. On a text card it is managed from here.'));
  }

  function p03Body(box) {
    const el = TextUI.el;
    const p = state.presetList.p03;
    const C = (spec) => TextUI.control(spec, p, P03, settingHooks());
    const R = (path, label, min, max, step, digits, unit) =>
      C({ path, label, type: 'range', min, max, step, digits, unit });
    actionBar(box, [
      { label: 'Move to top', primary: true, run: () => applySplit('top'),
        title: 'Put the selected clips in the top half - one undo entry.' },
      { label: 'Move to bottom', run: () => applySplit('bottom'),
        title: 'Put the selected clips in the bottom half - one undo entry.' },
      { label: 'Remove split', run: () => removeTagged(['split'], 'split screen'),
        title: 'Back to the full frame - one undo entry.' },
    ]);
    const body = el('div', 'pl-body');
    box.appendChild(body);
    body.appendChild(el('div', 'tc-hint', 'SPL_half - moves the selected clip into one half ' +
      'of the frame and leaves the other half empty (black). Fill it by putting a clip or ' +
      'still on a track BELOW this one and moving that to the other half. Applying again ' +
      'replaces the last split; every value stays editable as the clip\'s Split screen effect.'));
    body.appendChild(R('size', 'Band height', 0.1, 1, 0.005, 3));
    body.appendChild(R('focus', 'Crop centre', 0, 1, 0.005, 3));
    body.appendChild(R('zoom', 'Zoom in band', 0.5, 4, 0.01, 2));
    body.appendChild(R('distance', 'Distance from centre', -0.5, 0.5, 0.002, 3));
    body.appendChild(R('seam', 'Soft seam', 0, 0.3, 0.002, 3));
    body.appendChild(el('div', 'tc-hint', 'Soft seam feathers the inner edge, so the two ' +
      'halves blend instead of meeting on a hard line. It moves with the band as it glides.'));
    body.appendChild(el('div', 'tc-hint', 'Animation - the picture glides from the full ' +
      'frame into its half instead of cutting there. It keys the Split amount of the Split screen effect.'));
    body.appendChild(C({ path: 'animIn', label: 'Glide in', type: 'check' }));
    body.appendChild(C({ path: 'animOut', label: 'Glide back out at the end', type: 'check' }));
    body.appendChild(R('animDur', 'Over', F(2), F(60), F(1) / 2, 3, 's'));
    body.appendChild(C({ path: 'animEase', label: 'Curve', type: 'select', options: Anim.EASING_MENU }));
    body.appendChild(R('animBlur', 'Motion blur', 0, 4, 0.05, 2));
    body.appendChild(R('animSamples', 'Blur samples', 2, 32, 1, 0));
    body.appendChild(C({
      path: 'animAt', label: 'Glide in starts at', type: 'buttons', options: [
        { value: 'start', label: 'Clip start' },
        { value: 'playhead', label: 'Playhead' },
      ],
    }));
  }

  function renderPanel() {
    const host = document.getElementById('presetListPanel');
    if (!host) return;
    const meta = document.getElementById('presetListMeta');
    const cur = LIST.find((x) => x.id === state.presetList.open) || LIST[0];
    if (meta) meta.textContent = cur.id + ' ' + cur.name;
    host.innerHTML = '';
    const drawer = document.getElementById('presetDrawer');
    if (!drawer || drawer.hidden) return;
    const el = TextUI.el;

    const list = el('div', 'pl-rail');
    for (const it of LIST) {
      const b = el('button', 'mini pl-item' + (it.id === cur.id ? ' on' : ''));
      b.appendChild(el('span', 'pl-num', it.id));
      b.appendChild(el('span', null, it.name));
      if (it.family) b.appendChild(el('span', 'tc-hint', it.family));
      b.addEventListener('click', () => {
        state.presetList.open = it.id;
        if (it.id !== '04') setDrawing(false);
        renderPanel();
      });
      list.appendChild(b);
    }
    host.appendChild(list);

    const main = el('div', 'pl-main');
    const top = el('div', 'pl-top');
    top.appendChild(el('h3', null, cur.id + '  ' + cur.name));
    main.appendChild(top);
    if (cur.id === '01') p01Body(main);
    else if (cur.id === '02') p02Body(main);
    else if (cur.id === '03') p03Body(main);
    else if (cur.id === '04') p04Body(main);
    else fxBody(main, cur.key);
    host.appendChild(main);
    syncCamOverlay();
  }

  // ----------------------------------------------------------------- window

  const POS_KEY = 'shortcut.presetDrawer';

  /** Keep the window on screen - a saved position from a bigger monitor must not lose it. */
  function clampOnScreen(d) {
    const r = d.getBoundingClientRect();
    const x = Math.max(0, Math.min(window.innerWidth - Math.min(r.width, 120), r.left));
    const y = Math.max(0, Math.min(window.innerHeight - 40, r.top));
    d.style.left = x + 'px';
    d.style.top = y + 'px';
  }

  function savePos(d) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        x: d.offsetLeft, y: d.offsetTop, w: d.offsetWidth, h: d.offsetHeight,
      }));
    } catch (e) { /* storage blocked: the window just opens in its default place */ }
  }

  function toggle(show) {
    const d = document.getElementById('presetDrawer');
    const hide = show == null ? !d.hidden : !show;
    d.hidden = hide;
    if (hide) setDrawing(false);
    document.getElementById('btnPresetListCollapse').classList.toggle('on', !hide);
    if (!hide) {
      let pos = null;
      try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { pos = null; }
      if (pos) {
        d.style.width = pos.w + 'px'; d.style.height = pos.h + 'px';
        d.style.left = pos.x + 'px'; d.style.top = pos.y + 'px';
      } else if (!d.style.left) {
        // First open: over the timeline, clear of the preview on the left.
        d.style.left = Math.max(0, window.innerWidth - d.offsetWidth - 380) + 'px';
        d.style.top = '110px';
      }
      clampOnScreen(d);
    }
    renderPanel();
  }

  /** Drag by the header; remember where it was left and how big. */
  function wireWindow() {
    const d = document.getElementById('presetDrawer');
    if (!d) return;
    const head = d.querySelector('.pd-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const sx = e.clientX - d.offsetLeft, sy = e.clientY - d.offsetTop;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        d.style.left = (ev.clientX - sx) + 'px';
        d.style.top = (ev.clientY - sy) + 'px';
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        clampOnScreen(d);
        savePos(d);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    // `resize: both` has no end event; a pointerup on the window covers the corner drag.
    d.addEventListener('pointerup', () => savePos(d));
    document.getElementById('btnPresetListClose').addEventListener('click', () => toggle(false));
    // Esc closes it - but not while typing in one of its fields.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || d.hidden) return;
      if (e.target && d.contains(e.target) && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      toggle(false);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireWindow);
  else wireWindow();

  return {
    LIST, P01, P02, P03, defaults, normalize, captionSettings,
    applyP01, generateP01, roleCard, addRoleTag,
    pushEntry, applyPush, splitEntries, applySplit, removeTagged,
    applyFx, addCamKey, deleteCamKey, setDrawing, syncCamOverlay, LOOKS, FXP,
    renderPanel, renderGuides, toggle,
  };
})();
