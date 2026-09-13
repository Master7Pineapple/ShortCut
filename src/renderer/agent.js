'use strict';
/**
 * ShortCut - the agent API.
 *
 * Everything an editor does through the UI, as JSON an AI agent (or a script) can send:
 *
 *   Agent.catalog()            the whole vocabulary - every op, effect, graphic, transition,
 *                              easing, format and trigger, with its parameters and ranges
 *   Agent.describe(opts)       the project as plain data: tracks, clips, effects, lint
 *   Agent.run(ops, opts)       a batch of edit ops, ONE undo entry, rolled back on failure
 *   Agent.expand(spec)         a B2B short spec (hook / stakes / product / proof /
 *                              mechanism / cta) compiled into an op list - inspectable
 *   Agent.build(spec, opts)    expand + run
 *
 * It is a loaded-last `<script>` global, so it calls `app.js`'s own functions - there is
 * no second implementation of an edit here, only a door to the existing ones. The rule
 * `app.js` lives by still holds: a mutation is `pushUndo()` before, `markDirty()` +
 * `renderAll()` after. A batch collapses every inner `pushUndo()` into one entry.
 *
 * The door from OUTSIDE the renderer is `src/agentserver.js`: a localhost HTTP server and
 * a headless runner, both of which call `Agent.dispatch()` over `executeJavaScript`.
 *
 * Conventions every op follows, stated once:
 *   - `start`, `at`, `from`, `to` are TIMELINE seconds.
 *   - `in`/`out` on a media clip are SOURCE seconds; `len` is timeline seconds.
 *   - a key's `t` is seconds into the CLIP (as everywhere in the app), unless the op says
 *     `timeline: true`.
 *   - positions and lengths are fractions of the frame, never pixels (the unit rule).
 *   - `as: "name"` stores an op's result; a later string argument `"$name"` or
 *     `"$name.field"` is replaced by it.
 */
const Agent = (() => {
  const VERSION = 1;
  /** Media scanned by the `media` op, by absolute path. Session state, never saved. */
  const media = new Map();
  let refs = new Map();

  const r3 = (v) => Math.round(v * 1000) / 1000;
  const num = (v, d) => (isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  class AgentError extends Error {}
  const fail = (msg) => { throw new AgentError(msg); };

  /** Deep-merge plain objects; arrays and scalars replace. */
  function merge(dst, src) {
    if (!isObj(src)) return dst;
    for (const k of Object.keys(src)) {
      if (isObj(src[k]) && isObj(dst[k])) merge(dst[k], src[k]);
      else dst[k] = clone(src[k]);
    }
    return dst;
  }

  function easing(e) {
    if (Array.isArray(e) && e.length === 4) return { kind: 'bezier', p: e.map(Number) };
    if (isObj(e) && e.kind) return clone(e);
    const p = Anim.EASING_PRESETS[e] || Anim.EASING_PRESETS.easeInOut;
    return Anim.cloneEasing(p);
  }

  // ------------------------------------------------------------------ lookups

  function clipOf(v, what) {
    if (isObj(v) && v.id) v = v.id;
    if (typeof v !== 'string') fail((what || 'clip') + ': expected a clip id, got ' + JSON.stringify(v));
    const f = findClip(v);
    if (!f) fail((what || 'clip') + ': no clip with id "' + v + '"');
    return f.clip;
  }
  function clipsOf(v, what) {
    if (v == null) return [];
    if (isObj(v) && Array.isArray(v.ids)) v = v.ids;
    return (Array.isArray(v) ? v : [v]).map((x) => clipOf(x, what));
  }
  function trackOfClip(clip) {
    const f = findClip(clip.id);
    return f ? f.track : null;
  }
  /** A track by id or by name ("V1", "A2"). */
  function trackOf(v, type) {
    if (isObj(v) && v.id) v = v.id;
    const t = state.tracks.find((x) => x.id === v) ||
      state.tracks.find((x) => x.name === v && (!type || x.type === type));
    if (!t) fail('no track "' + v + '"');
    if (type && t.type !== type) fail('track "' + v + '" is a ' + t.type + ' track, expected ' + type);
    return t;
  }
  /** The first unlocked, generator-free track of `type` with nothing between from and to. */
  function freeTrackFor(type, from, to, want, bottomFirst) {
    if (want != null) {
      const t = trackOf(want, type);
      if (t.locked) fail('track ' + t.name + ' is locked');
      return t;
    }
    const busy = (t) => t.clips.some((c) => from < clipEnd(c) - 1e-6 && to > c.start + 1e-6);
    let list = state.tracks.filter((x) => x.type === type && !x.locked && !x.captions && !x.sfx);
    if (bottomFirst) list = list.slice().reverse();
    return list.find((t) => !busy(t)) || addTrack(type, false);
  }
  /** Which clip of a list covers timeline time t (half-open, like layersAt). */
  function clipAtTime(clips, t) {
    return clips.find((c) => t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) ||
      clips.find((c) => Math.abs(t - clipEnd(c)) < 1e-3) || null;
  }

  // ------------------------------------------------------------------ keys

  /**
   * Write keys onto any keyframe holder - an fx entry, a graphic, a card or a clip.
   * `replace` drops the track first; otherwise keys at the same time are replaced.
   */
  function writeKeys(holder, prop, keys, opts) {
    const o = opts || {};
    if (!holder.keys) holder.keys = {};
    if (o.replace || !Array.isArray(holder.keys[prop])) holder.keys[prop] = o.replace ? [] : (holder.keys[prop] || []);
    const track = holder.keys[prop];
    for (const k of keys || []) {
      const t = r3(num(k.t, NaN) - (o.offset || 0));
      const v = num(k.v, NaN);
      if (!isFinite(t) || !isFinite(v)) fail('key needs numeric t and v: ' + JSON.stringify(k));
      const i = track.findIndex((x) => Math.abs(x.t - t) < 1e-4);
      const key = { t: Math.max(0, t), v, ease: easing(k.ease) };
      if (o.gen) key.gen = o.gen;
      if (i >= 0) track[i] = key; else track.push(key);
    }
    Anim.sortKeys(track);
    return track.length;
  }

  // ------------------------------------------------------------------ clip factories

  const baseClip = (o) => Object.assign({
    id: nextId(), src: null, name: 'Clip', kind: 'video',
    start: 0, in: 0, out: 1, mediaDuration: 3600,
    srcW: 0, srcH: 0, fps: 0, panX: 0.5, panY: 0.5, zoom: 1, volume: 1, linkId: null,
  }, o);

  async function scan(p) {
    if (media.has(p)) return media.get(p);
    const metas = await window.api.scanMedia([p]);
    const m = (metas || []).find((x) => x && x.path) || null;
    if (!m) fail('media: nothing importable at "' + p + '"');
    media.set(p, m);
    if (m.path !== p) media.set(m.path, m);
    return m;
  }
  const mediaSummary = (m) => ({
    path: m.path, name: m.name, kind: m.kind, duration: r3(m.duration),
    width: m.width || 0, height: m.height || 0, fps: m.fps || 0, hasAudio: !!m.hasAudio,
    telemetry: !!m.screen, clicks: m.screen ? (m.screen.events || []).filter((e) => e.type === 'down').length : 0,
  });

  function canvasClip(kind, def, o) {
    const start = Math.max(0, num(o.start, state.playhead));
    const len = Math.max(0.05, num(o.len, kind === 'text' ? 3 : 4));
    const track = freeTrackFor('video', start, start + len, o.track, false);
    const clip = baseClip({ kind, name: o.name || (kind === 'text' ? 'Text' : Graphics.DEFS[def.type].label), start, out: len });
    clip[kind === 'text' ? 'card' : 'graphic'] = def;
    track.clips.push(clip);
    sortTracks();
    return clip;
  }

  // ------------------------------------------------------------------ recipes

  /** The agent's own transform on a clip, created on demand and tagged so it is found again. */
  function tagTransform(clip, gen) {
    if (!Array.isArray(clip.fx)) clip.fx = [];
    let e = clip.fx.find((f) => f && f.type === 'transform' && f.gen === gen);
    if (!e) { e = FX.create('transform'); e.gen = gen; clip.fx.push(e); }
    return e;
  }

  /**
   * A punch-in: scale up about a focus point and hold, as keyframes rather than a cut.
   * Holding the focus point still under a scale `s` about the centre anchor means
   * offset = (p - 0.5) * (1 - s) - the transform draw solved for a fixed point.
   */
  function punchIn(clip, o) {
    const e = tagTransform(clip, 'agent-punch');
    const len = clipLen(clip);
    const t0 = Math.max(0, num(o.at, clip.start) - clip.start);
    const ramp = Math.max(0.02, num(o.ramp, 0.22));
    const s = num(o.scale, 1.12);
    const fx0 = num(o.x, 0.5), fy0 = num(o.y, 0.45);
    const ox = (fx0 - 0.5) * (1 - s), oy = (fy0 - 0.5) * (1 - s);
    const ez = o.ease || 'softLand';
    const keysAt = (t, sv, xv, yv) => ({ scale: { t, v: sv, ease: ez }, x: { t, v: xv, ease: ez }, y: { t, v: yv, ease: ez } });
    const rows = [keysAt(Math.max(0, t0 - 0.001), num(o.from, 1), 0, 0), keysAt(Math.min(len, t0 + ramp), s, ox, oy)];
    if (o.hold != null) {
      const out = Math.min(len, t0 + ramp + Math.max(0, num(o.hold, 0)));
      rows.push(keysAt(out, s, ox, oy), keysAt(Math.min(len, out + ramp), 1, 0, 0));
    }
    for (const prop of ['scale', 'x', 'y']) writeKeys(e, prop, rows.map((r) => r[prop]), { gen: 'agent-punch' });
    FX.normalizeClip(clip);
    return { fx: e.id, at: r3(clip.start + t0) };
  }

  /** A slow push across the clip so a talking head is never static. */
  function drift(clip, o) {
    const e = tagTransform(clip, 'agent-drift');
    const len = clipLen(clip);
    writeKeys(e, 'scale', [{ t: 0, v: 1, ease: 'linear' }, { t: len, v: num(o && o.scale, 1.05), ease: 'linear' }],
      { gen: 'agent-drift', replace: true });
    FX.normalizeClip(clip);
    return { fx: e.id };
  }

  /**
   * Cut a long clip into pieces every `every` seconds and give each its own framing, so a
   * recording is REFRAMED rather than held. Zoom alternates through `zooms`, and a clip with
   * telemetry pans each piece towards where the cursor spent it.
   */
  function reframe(clip, o) {
    const every = Math.max(0.5, num(o.every, 2.5));
    const zooms = Array.isArray(o.zooms) && o.zooms.length ? o.zooms.map(Number) : [1, 1.18, 1.08];
    const pieces = [clip];
    while (clipLen(pieces[pieces.length - 1]) > every * 1.5) {
      const c = pieces[pieces.length - 1];
      const cut = c.start + every;
      const group = linkGroup(c);
      let right = null;
      for (const g of group) {
        const tr = trackOfClip(g);
        const srcCut = srcAt(g, cut - g.start);
        const r = Object.assign(clone(g), { id: nextId(), start: cut, in: srcCut });
        g.out = srcCut;
        tr.clips.push(r);
        if (g === c) right = r;
      }
      const linkIds = new Set(group.map((g) => g.linkId).filter(Boolean));
      if (linkIds.size) {
        const fresh = nextId();
        for (const tr of state.tracks) for (const x of tr.clips) {
          if (x.start === cut && linkIds.has(x.linkId) && !group.includes(x)) x.linkId = fresh;
        }
      }
      pieces.push(right);
    }
    sortTracks();
    pieces.forEach((p, i) => {
      p.zoom = zooms[i % zooms.length];
      const tel = ScreenTel.hasTelemetry(p) ? p.screen : null;
      if (tel && p.zoom > 1.001) {
        let sx = 0, sy = 0, n = 0;
        for (let k = 0; k <= 8; k++) {
          const q = ScreenTel.cursorAt(tel, p.in + (p.out - p.in) * k / 8);
          if (q && isFinite(q.x) && isFinite(q.y)) { sx += q.x; sy += q.y; n++; }
        }
        if (n) { p.panX = clamp(sx / n, 0, 1); p.panY = clamp(sy / n, 0, 1); }
      }
    });
    return { ids: pieces.map((p) => p.id), count: pieces.length };
  }

  /**
   * Ripples on a recording's REAL clicks. The recording already shows its own pointer, so
   * no cursor is drawn by default - "two pointers chasing each other" is the bug the
   * README's two-recordings section exists for. The take is written in FRAME fractions,
   * mapped through the clip's framing now.
   */
  function ripplesFromTelemetry(clip, o) {
    if (!ScreenTel.hasTelemetry(clip)) return { clicks: 0, note: 'no telemetry on this clip' };
    const W = outSize().w, H = outSize().h;
    const map = Cursor.mapper(framedCopy(clip), W, H);
    const events = [];
    for (const e of clip.screen.events || []) {
      if (e.t < clip.in - 1e-6 || e.t >= clip.out) continue;
      if (e.type !== 'down' && e.type !== 'up') continue;
      const p = map(e.x, e.y);
      events.push({ t: e.t, x: clamp(p.x / W, 0, 1), y: clamp(p.y / H, 0, 1), type: e.type });
    }
    if (!events.length) return { clicks: 0 };
    clip.mouse = Cursor.makeTake(events);
    if (!Array.isArray(clip.fx)) clip.fx = [];
    const want = o && o.cursor ? ['cursor', 'ripple'] : ['ripple'];
    for (const type of want) if (!clip.fx.some((f) => f && f.type === type)) clip.fx.unshift(FX.create(type));
    const rip = clip.fx.find((f) => f.type === 'ripple');
    if (o && isObj(o.params)) Object.assign(rip.params, o.params);
    FX.normalizeClip(clip);
    return { clicks: events.filter((e) => e.type === 'down').length };
  }

  /** A timed effect whose strength fades in and out over [from, to]. */
  function timedEffect(clip, type, o, strengthProp, strength) {
    if (!Array.isArray(clip.fx)) clip.fx = [];
    const e = FX.create(type);
    if (isObj(o.params)) Object.assign(e.params, o.params);
    const len = clipLen(clip);
    const a = clamp(num(o.from, clip.start) - clip.start, 0, len);
    const b = clamp(num(o.to, clipEnd(clip)) - clip.start, a, len);
    const fade = Math.max(0.02, num(o.fade, 0.25));
    const full = num(strength, e.params[strengthProp]);
    writeKeys(e, strengthProp, [
      { t: Math.max(0, a - 0.001), v: 0, ease: 'easeOut' }, { t: Math.min(b, a + fade), v: full, ease: 'easeInOut' },
      { t: Math.max(a, b - fade), v: full, ease: 'easeIn' }, { t: b, v: 0 },
    ], { replace: true });
    clip.fx.push(e);
    FX.normalizeClip(clip);
    return e;
  }

  function resolveSound(id) {
    const s = sfxSound(id);
    if (s) return s;
    return sfxLib.items.find((i) => i.path === id || i.name === id) || null;
  }
  async function ensureSounds(paths) {
    const want = paths.filter((p) => p && !resolveSound(p));
    if (want.length) { await addSfxPaths(want); }
    const missing = paths.filter((p) => p && !resolveSound(p));
    if (missing.length) fail('sound not found / not audio: ' + missing.join(', '));
  }
  function placeSound(id, at, gainDb) {
    const snd = resolveSound(id);
    if (!snd || snd.missing) fail('sound "' + id + '" is not in the SFX library');
    const dur = Math.max(0.02, Number(snd.duration) || 0);
    const track = sfxTrack(true);
    const clip = baseClip({
      src: snd.path, name: snd.name, kind: 'audio', start: Math.max(0, num(at, state.playhead)),
      out: dur, mediaDuration: dur, afx: sfxChain(num(gainDb, sfxOpts().level), SFX.duckFor(sfxOpts())),
    });
    track.clips.push(clip);
    sortTracks();
    return clip;
  }

  /** Timeline times at which an auto-zoom starts moving IN - where a whoosh belongs. */
  function zoomStarts(clip) {
    const e = autoZoomFx(clip, false);
    const ks = (e && e.keys && e.keys.scale) || [];
    const out = [];
    for (let i = 1; i < ks.length; i++) {
      if (ks[i].v > 1.001 && ks[i - 1].v <= ks[i].v - 0.01) out.push(r3(clip.start + ks[i - 1].t));
    }
    return out.filter((t) => t >= clip.start - 1e-6 && t < clipEnd(clip));
  }

  // ------------------------------------------------------------------ the ops

  /**
   * One entry per op: `doc` is what `catalog()` publishes, `fn` does it. `fn` may be async
   * and returns plain JSON. Everything validates what it is handed and throws AgentError
   * with a sentence an agent can act on.
   */
  const OPS = {};
  const op = (name, doc, fn) => { OPS[name] = { doc, fn }; };

  // ---- project

  op('new', 'Start an empty project. {force?:bool} - refuses over unsaved work unless force.', (a) => {
    if (state.dirty && !a.force) fail('the project has unsaved changes - pass force:true to discard them');
    state.dirty = false;
    newProject();
    media.clear();
    return { ok: true };
  });
  op('open', 'Open a .scut. {path, force?}', async (a) => {
    if (typeof a.path !== 'string') fail('open: path is required');
    if (state.dirty && !a.force) fail('the project has unsaved changes - pass force:true to discard them');
    state.dirty = false;
    const r = await openProject(a.path);
    if (!r || !r.ok) fail('open failed: ' + ((r && r.error) || 'cancelled'));
    return r;
  });
  op('save', 'Save the project. {path?} - without a path it saves over the open file.', async (a) => {
    if (!a.path && !state.filePath) fail('save: this project has no file yet - pass path');
    const p = await saveProject(false, a.path);
    if (!p) fail('save failed');
    return { path: p };
  });
  op('output', 'Set the master output. {w?, h?, fps?, quality?: draft|fast|medium|high, loudness?:{enabled,lufs,tp,lra}}', (a) => {
    if (a.w) state.out.w = Math.round(num(a.w, state.out.w));
    if (a.h) state.out.h = Math.round(num(a.h, state.out.h));
    if (a.fps) state.out.fps = num(a.fps, state.out.fps);
    if (a.quality) state.out.quality = String(a.quality);
    if (isObj(a.loudness)) Object.assign(state.out.loudness, a.loudness);
    const sel = $('#preset'); if (sel) sel.value = state.out.w + 'x' + state.out.h;
    const q = $('#quality'); if (q) q.value = state.out.quality;
    const f = $('#fps'); if (f) f.value = String(state.out.fps);
    syncLoudnessControl();
    resizeCanvas();
    markDirty();
    return clone(state.out);
  });
  op('seek', 'Move the playhead. {t}', (a) => { seek(num(a.t, 0)); return { playhead: r3(state.playhead) }; });
  op('select', 'Select clips (what panels act on). {clips:[id]}', (a) => {
    setSelection(clipsOf(a.clips).map((c) => c.id), false);
    return { selected: [...state.selection] };
  });
  op('undo', 'Undo the last undo entry (a whole earlier batch is one entry).', () => { undo(); return { undo: undoStack.length }; });
  op('redo', 'Redo the last undone entry.', () => { redo(); return { undo: undoStack.length }; });

  // ---- media and timeline

  op('media', 'Probe a media file without placing it. {path} -> {path, kind, duration, width, height, hasAudio, telemetry, clicks}', async (a) => {
    if (typeof a.path !== 'string') fail('media: path is required');
    return mediaSummary(await scan(a.path));
  });
  op('clip', 'Place media on the timeline. {src:path, start, in?=0, out? | len?, track?, audio?=true, name?, panX?, panY?, zoom?, fit?, volume?} -> {id, audio}. A video with sound makes a linked audio clip.', async (a) => {
    if (typeof a.src !== 'string') fail('clip: src (a file path) is required');
    const m = await scan(a.src);
    const start = Math.max(0, num(a.start, 0));
    const isImage = m.kind === 'image';
    const dur = isImage ? 3600 : m.duration;
    const inPt = isImage ? 0 : clamp(num(a.in, 0), 0, Math.max(0, dur - 0.04));
    let outPt = a.out != null ? num(a.out, dur) : a.len != null ? inPt + num(a.len, 0) : (isImage ? 4 : dur);
    let warning;
    if (outPt > dur + 1e-6) { warning = 'out clamped to the media length ' + r3(dur); outPt = dur; }
    if (!(outPt > inPt + 0.01)) fail('clip: out must be after in (in ' + inPt + ', out ' + outPt + ')');
    const len = outPt - inPt;
    const common = {
      src: m.path, name: a.name || m.name, start, in: inPt, out: outPt,
      mediaDuration: dur, volume: num(a.volume, 1),
    };
    let v = null, au = null;
    const linkId = m.kind === 'video' && m.hasAudio && a.audio !== false ? nextId() : null;
    if (m.kind === 'video' || isImage) {
      const vt = freeTrackFor('video', start, start + len, a.track, true);
      v = baseClip(Object.assign({}, common, {
        kind: isImage ? 'image' : 'video', srcW: m.width, srcH: m.height, fps: m.fps || 0,
        panX: num(a.panX, 0.5), panY: num(a.panY, 0.5), zoom: num(a.zoom, 1), linkId,
      }, m.screen ? { screen: m.screen } : {}));
      if (a.fit === 'contain') v.fit = 'contain';
      vt.clips.push(v);
    }
    if (m.kind === 'audio' || linkId) {
      const at = freeTrackFor('audio', start, start + len, a.audioTrack, false);
      au = baseClip(Object.assign({}, common, { kind: 'audio', linkId }));
      at.clips.push(au);
    }
    sortTracks();
    return { id: (v || au).id, audio: au && v ? au.id : null, start: r3(start), end: r3(start + len), warning };
  });
  op('addTrack', 'Add a track. {type: video|audio} -> {id, name}. Video tracks go on top.', (a) => {
    const t = addTrack(a.type === 'audio' ? 'audio' : 'video', false);
    return { id: t.id, name: t.name };
  });
  op('set', 'Change a clip. {clip, start?, in?, out?, len?, track?, name?, panX?, panY?, zoom?, fit?, volume?, text?, style?, card?, params?(graphic), highlight?, muted/hidden/locked on {track}}', (a) => {
    if (a.clip == null && a.track != null) {
      const t = trackOf(a.track);
      for (const k of ['muted', 'hidden', 'locked', 'name']) if (a[k] != null) t[k] = k === 'name' ? String(a[k]) : !!a[k];
      return { track: t.id };
    }
    const c = clipOf(a.clip);
    const group = linkGroup(c);
    if (a.start != null) {
      const d = Math.max(0, num(a.start, c.start)) - c.start;
      for (const g of group) g.start = Math.max(0, g.start + d);
    }
    if (a.in != null || a.out != null || a.len != null) {
      for (const g of group) {
        if (isCanvasClip(g)) { if (a.len != null) g.out = Math.max(0.05, num(a.len, g.out)); continue; }
        if (a.in != null) g.in = clamp(num(a.in, g.in), 0, g.out - 0.02);
        if (a.out != null) g.out = clamp(num(a.out, g.out), g.in + 0.02, g.mediaDuration);
        if (a.len != null) g.out = clamp(Speed.advance(g, g.in, num(a.len, clipLen(g))), g.in + 0.02, g.mediaDuration);
      }
    }
    if (a.track != null) {
      const to = trackOf(a.track, c.kind === 'audio' ? 'audio' : 'video');
      const from = trackOfClip(c);
      if (to !== from) { from.clips = from.clips.filter((x) => x !== c); to.clips.push(c); }
    }
    for (const k of ['panX', 'panY', 'zoom', 'volume']) if (a[k] != null) c[k] = num(a[k], c[k]);
    if (a.name != null) c.name = String(a.name);
    if (a.fit !== undefined) { if (a.fit === 'contain') c.fit = 'contain'; else delete c.fit; }
    if (c.kind === 'text') {
      if (a.text != null) c.card.text = String(a.text);
      if (isObj(a.style)) merge(c.card.style, a.style);
      if (isObj(a.card)) merge(c.card, a.card);
      if (a.highlight !== undefined) { if (a.highlight) c.card.highlight = clone(a.highlight); else delete c.card.highlight; }
    }
    if (c.kind === 'graphic' && isObj(a.params)) { Object.assign(c.graphic.params, clone(a.params)); Graphics.normalizeClip(c); }
    sortTracks();
    return { id: c.id, start: r3(c.start), end: r3(clipEnd(c)) };
  });
  op('split', 'Split clips at a time. {at, clips?:[id]} - without clips, everything under `at` on unlocked tracks.', (a) => {
    const t = num(a.at, NaN);
    if (!isFinite(t)) fail('split: at is required');
    const only = a.clips ? clipsOf(a.clips) : null;
    const before = new Set(allClips().map((x) => x.clip.id));
    const hit = allClips().some(({ clip, track }) => !track.locked && (!only || only.includes(clip)) &&
      t > clip.start + 0.02 && t < clipEnd(clip) - 0.02);
    if (!hit) return { made: [] };
    const prevSel = [...state.selection];
    state.playhead = t;
    state.selection = new Set(only ? only.map((c) => c.id) : []);
    splitAtPlayhead();
    state.selection = new Set(prevSel.filter((id) => findClip(id)));
    return { made: allClips().map((x) => x.clip.id).filter((id) => !before.has(id)) };
  });
  op('delete', 'Delete clips (with their link groups). {clips:[id], ripple?:bool}', (a) => {
    const cs = clipsOf(a.clips);
    if (!cs.length) return { deleted: 0 };
    state.selection = new Set(cs.map((c) => c.id));
    deleteSelected(!!a.ripple);
    return { deleted: cs.length };
  });
  op('closeGaps', 'Close the gaps between clips. {clips:[id]}', (a) => {
    state.selection = new Set(clipsOf(a.clips).map((c) => c.id));
    closeGaps();
    state.selection.clear();
    return { ok: true };
  });
  op('link', 'Link clips so they move and trim together. {clips:[id]}', (a) => {
    const cs = clipsOf(a.clips);
    if (cs.length < 2) fail('link: needs two or more clips');
    const id = nextId();
    for (const c of cs) c.linkId = id;
    return { linkId: id };
  });

  // ---- text and graphics

  op('text', 'Add a text card. {text, start, len?=3, track?, style?:{fontSize(px @1920 tall), fill:{color}, x, y, ...}, anims?:"none"|"pop"|"type"|[AnimLayer], keys?:{opacity|x|y|scale|rotate|glow:[{t,v,ease}]}, highlight?:{color, words:[index]}} -> {id}', (a) => {
    const card = TextModel.defaultCard(String(a.text == null ? '' : a.text));
    if (isObj(a.style)) merge(card.style, a.style);
    if (a.anims === 'none') card.anims = [];
    else if (a.anims === 'pop') {
      const z = TextModel.defaultAnim('zoom', 'in'); z.params.amount = 0.35; z.duration = 0.35; z.easing = easing('backOut');
      card.anims = [TextModel.defaultAnim('fade', 'in'), z, TextModel.defaultAnim('fade', 'out')];
    } else if (a.anims === 'type') {
      const tw = TextModel.defaultAnim('typewriter', 'in'); tw.params.unit = 'word'; tw.params.effect = 'pop'; tw.duration = 0.8;
      card.anims = [tw, TextModel.defaultAnim('fade', 'out')];
    } else if (Array.isArray(a.anims)) {
      card.anims = a.anims.map((l) => {
        const layer = TextModel.defaultAnim(l.type || 'fade', l.mode || 'in');
        const rest = Object.assign({}, l);
        delete rest.easing;
        merge(layer, rest);
        if (l.easing) layer.easing = easing(l.easing);
        return layer;
      });
    }
    if (a.highlight) card.highlight = clone(a.highlight);
    const clip = canvasClip('text', card, a);
    if (isObj(a.keys)) for (const p of Object.keys(a.keys)) {
      if (!TextModel.KEYABLE.includes(p)) fail('text: "' + p + '" is not keyable - one of ' + TextModel.KEYABLE.join(', '));
      writeKeys(card, p, a.keys[p]);
    }
    return { id: clip.id, start: r3(clip.start), end: r3(clipEnd(clip)) };
  });
  op('graphic', 'Add a graphic. {type (see catalog.graphics), start, len?=4, track?, params?, keys?:{param:[{t,v,ease}]}, name?} -> {id}. Position it with params.x/y or a transform effect.', (a) => {
    if (!Graphics.DEFS[a.type]) fail('graphic: unknown type "' + a.type + '" - one of ' + Graphics.TYPES.join(', '));
    const g = Graphics.defaultGraphic(a.type);
    if (isObj(a.params)) {
      for (const k of Object.keys(a.params)) {
        let v = a.params[k];
        // Diagram specs and series are strings in the model; accept JSON / arrays too.
        if (k === 'spec' && typeof v !== 'string') v = JSON.stringify(v);
        if ((k === 'values' || k === 'labels') && Array.isArray(v)) v = v.join(', ');
        g.params[k] = v;
      }
    }
    const clip = canvasClip('graphic', g, a);
    if (isObj(a.keys)) for (const p of Object.keys(a.keys)) writeKeys(g, p, a.keys[p]);
    Graphics.normalizeClip(clip);
    return { id: clip.id, start: r3(clip.start), end: r3(clipEnd(clip)) };
  });

  // ---- effects and keys

  op('effect', 'Add a visual effect. {clip | master:true, type (see catalog.effects), params?, keys?:{param:[{t,v,ease}]}, index?, enabled?, bind?:{track, clip?(owner), offX?, offY?, mode?}, mblur?:{on,strength,samples}} -> {fx}', (a) => {
    const d = FX.DEFS[a.type];
    if (!d) fail('effect: unknown type "' + a.type + '" - one of ' + FX.TYPES.join(', '));
    const e = FX.create(a.type);
    if (isObj(a.params)) Object.assign(e.params, clone(a.params));
    if (a.enabled === false) e.enabled = false;
    if (isObj(a.mblur)) e.mblur = clone(a.mblur);
    if (isObj(a.bind)) {
      if (!d.bind) fail('effect: ' + a.type + ' cannot follow a track - only ' + FX.TYPES.filter((t) => FX.DEFS[t].bind).join(', '));
      e.bind = { track: a.bind.track, offX: num(a.bind.offX, 0), offY: num(a.bind.offY, 0) };
      if (a.bind.clip) e.bind.clip = clipOf(a.bind.clip, 'bind.clip').id;
      if (a.bind.mode) e.bind.mode = a.bind.mode;
      for (const k of Object.keys(a.bind)) if (!(k in e.bind) && k !== 'clip') e.bind[k] = a.bind[k];
    }
    if (isObj(a.keys)) for (const p of Object.keys(a.keys)) writeKeys(e, p, a.keys[p]);
    let stack;
    if (a.master) {
      if (!FX.MASTER_TYPES.includes(a.type)) fail('effect: the master finish takes only ' + FX.MASTER_TYPES.join(', '));
      stack = state.master;
    } else {
      const c = clipOf(a.clip);
      if (c.kind === 'text' || c.kind === 'audio') fail('effect: effects go on video, image and graphic clips, not ' + c.kind);
      if (!Array.isArray(c.fx)) c.fx = [];
      stack = c.fx;
    }
    const at = a.index == null ? stack.length : clamp(Math.round(num(a.index, stack.length)), 0, stack.length);
    stack.splice(at, 0, e);
    if (a.master) state.master = FX.normalizeStack(state.master);
    else FX.normalizeClip(clipOf(a.clip));
    return { fx: e.id, index: at };
  });
  function findFx(a) {
    const stack = a.master ? state.master : (clipOf(a.clip).fx || []);
    const e = stack.find((f) => f.id === a.fx) ||
      (typeof a.fx === 'number' ? stack[a.fx] : null) ||
      stack.find((f) => f.type === a.fx);
    if (!e) fail('no effect "' + a.fx + '" on ' + (a.master ? 'the master' : 'clip ' + a.clip));
    return { e, stack };
  }
  op('effectSet', 'Change or remove an effect. {clip | master, fx:id|type|index, params?, enabled?, remove?:bool, index?(move), bind?:{...}|null}', (a) => {
    const { e, stack } = findFx(a);
    if (a.remove) { stack.splice(stack.indexOf(e), 1); }
    else {
      if (isObj(a.params)) Object.assign(e.params, clone(a.params));
      if (a.enabled != null) e.enabled = !!a.enabled;
      if (a.bind === null) delete e.bind; else if (isObj(a.bind)) e.bind = Object.assign(e.bind || {}, clone(a.bind));
      if (a.index != null) { stack.splice(stack.indexOf(e), 1); stack.splice(clamp(Math.round(a.index), 0, stack.length), 0, e); }
    }
    if (a.master) state.master = FX.normalizeStack(state.master); else FX.normalizeClip(clipOf(a.clip));
    return { ok: true };
  });
  op('keys', 'Write keyframes. {clip | master, on: "fx"|"card"|"graphic"|"speed", fx?, prop, keys:[{t,v,ease}], replace?, timeline?:bool (t is timeline seconds)} . Easing is a name from catalog.easings or a 4-number bezier.', (a) => {
    if (!Array.isArray(a.keys)) fail('keys: keys must be an array of {t, v, ease}');
    const on = a.on || (a.fx != null || a.master ? 'fx' : null);
    const c = a.master ? null : clipOf(a.clip);
    const offset = a.timeline && c ? c.start : 0;
    let holder;
    if (on === 'fx') holder = findFx(a).e;
    else if (on === 'card') { if (!c.card) fail('keys: that clip is not a text card'); holder = c.card; }
    else if (on === 'graphic') { if (!c.graphic) fail('keys: that clip is not a graphic'); holder = c.graphic; }
    else if (on === 'speed') {
      if (!Speed.canSpeed(c)) fail('keys: speed needs a video or audio clip');
      for (const g of speedGroup(c)) {
        const sp = Speed.ensure(g);
        if (a.replace) sp.keys = [];
        for (const k of a.keys) Anim.addKey(sp.keys, g.in + num(k.t, 0) - offset, Speed.clampRate(k.v), easing(k.ease));
        Speed.normalize(g); Speed.prune(g);
      }
      return { ok: true };
    } else fail('keys: on must be fx, card, graphic or speed');
    const n = writeKeys(holder, a.prop, a.keys, { replace: a.replace, offset });
    if (on === 'fx') { if (a.master) state.master = FX.normalizeStack(state.master); else FX.normalizeClip(c); }
    if (on === 'graphic') Graphics.normalizeClip(c);
    return { keys: n };
  });

  // ---- motion recipes

  op('punchIn', 'Keyframed punch-in (not a cut). {clip, at, scale?=1.12, ramp?=0.22, hold?(seconds, then eases back), x?, y?(focus 0..1), ease?}', (a) => punchIn(clipOf(a.clip), a));
  op('drift', 'A slow push across a whole clip so it never sits static. {clip | clips, scale?=1.05}', (a) =>
    ({ fx: clipsOf(a.clips || a.clip).map((c) => drift(c, a).fx) }));
  op('reframe', 'Cut a clip every N seconds and reframe each piece (zoom cycle, pans to the cursor when telemetry exists). {clip, every?=2.5, zooms?:[1,1.18,1.08]} -> {ids}', (a) => reframe(clipOf(a.clip), a));
  op('speed', 'Speed a clip (its link group too). {clip, rate?, audio?: pitch|mute, ramp?:[{t (clip seconds, unsped), v}], keepLength?:bool}', (a) => {
    const c = clipOf(a.clip);
    if (!Speed.canSpeed(c)) fail('speed: needs a video or audio clip');
    for (const g of speedGroup(c)) {
      const len = clipLen(g);
      const sp = Speed.ensure(g);
      if (a.rate != null) sp.rate = Speed.clampRate(a.rate);
      if (a.audio) sp.audio = a.audio === 'mute' ? 'mute' : 'pitch';
      if (Array.isArray(a.ramp)) {
        sp.keys = [];
        for (const k of a.ramp) Anim.addKey(sp.keys, g.in + num(k.t, 0), Speed.clampRate(k.v), easing(k.ease || 'easeInOut'));
      }
      Speed.normalize(g); Speed.prune(g);
      if (a.keepLength) g.out = clamp(Speed.advance(g, g.in, len), g.in + 0.02, g.mediaDuration);
    }
    return { len: r3(clipLen(c)), label: Speed.label(c) };
  });
  op('autoZoom', 'Generate auto-zoom keys from a recording\'s cursor telemetry (hold >= minHold). {clip | clips, settings?:{sensitivity,minHold,maxZoom,ramp,fill}, whoosh?:soundPath, gainDb?} -> {zooms, whooshes}', async (a) => {
    const cs = clipsOf(a.clips || a.clip);
    if (a.whoosh) await ensureSounds([a.whoosh]);
    let zooms = 0; const whooshes = []; const skipped = [];
    for (const c of cs) {
      if (!ScreenTel.hasTelemetry(c)) { skipped.push(c.id); continue; }
      if (isObj(a.settings)) {
        const e = autoZoomFx(c, false);
        if (e) e.autozoom = Object.assign({}, Cursor.DEFAULTS.zoom, e.autozoom || {}, a.settings);
        else Object.assign(autoZoomDefaults, a.settings);
      }
      const res = applyAutoZoom(c);
      zooms += res.segments.length;
      if (a.whoosh) for (const t of zoomStarts(c)) whooshes.push(placeSound(a.whoosh, t, a.gainDb).id);
    }
    return { zooms, whooshes: whooshes.length, skipped };
  });
  op('ripples', 'Click ripples on a recording\'s real mouse-downs (no second cursor unless cursor:true). {clip | clips, cursor?:bool, params?} -> {clicks}', (a) => {
    let clicks = 0;
    for (const c of clipsOf(a.clips || a.clip)) clicks += ripplesFromTelemetry(c, a).clicks;
    return { clicks };
  });
  op('mouseTake', 'Write a performed pointer path. {events:[{t (timeline), x, y (frame 0..1), type: move|down|up}], clips?:[id], cursor?=true, ripple?=true}', (a) => {
    if (!Array.isArray(a.events) || !a.events.length) fail('mouseTake: events are required');
    const targets = a.clips ? clipsOf(a.clips) : allClips().filter(({ clip, track }) => track.type === 'video' && isPictureClip(clip)).map((x) => x.clip);
    const takes = Cursor.splitTake(a.events, targets);
    let n = 0;
    for (const c of targets) {
      const take = takes.get(c.id);
      if (!take) continue;
      c.mouse = take; n++;
      if (!Array.isArray(c.fx)) c.fx = [];
      for (const type of ['cursor', 'ripple']) {
        if (a[type] === false) continue;
        if (!c.fx.some((f) => f && f.type === type)) c.fx.unshift(FX.create(type));
      }
      FX.normalizeClip(c);
    }
    return { clips: n };
  });
  op('mockup', 'Frame footage in a device on a gradient: chrome THEN background (the order is the picture). {clip | clips, preset?: browser|browserDark|laptop|phone, chrome?:{params}, background?:{params}|false}', (a) => {
    const out = [];
    for (const c of clipsOf(a.clips || a.clip)) {
      if (!Array.isArray(c.fx)) c.fx = [];
      const ch = FX.create('chrome');
      Object.assign(ch.params, { preset: a.preset || 'browser' }, clone(a.chrome || {}));
      // A WIDE capture in a tall frame: widen the crop past the source (zoom < 1) so the
      // layer holds the whole picture as a centred band, and give the device the picture's
      // own aspect so its screen crops exactly that band. It stays a CROP rather than
      // `fit: contain` on purpose - Cursor.mapper() and Tracker.frameMap() only speak crop,
      // so auto-zoom targets, ripples and tracks all still land on the right pixel. The
      // clip carries effects, so it is baked, and drawImage clips an oversized source rect.
      const A = outSize().w / outSize().h;
      if (a.fitWide !== false && isPictureClip(c) && c.srcW && c.srcH && c.srcW / c.srcH > A + 1e-3) {
        c.zoom = r3((Math.min(c.srcW, c.srcH * A) / c.srcW) * Math.max(1, num(c.zoom, 1)));
        c.panY = 0.5;
        delete c.fit;
        if (!(a.chrome && a.chrome.aspect)) ch.params.aspect = r3(c.srcW / c.srcH);
        ch.params.fit = 'cover';
      }
      c.fx.push(ch);
      if (a.background !== false) {
        const bg = FX.create('background');
        Object.assign(bg.params, clone(a.background || {}));
        c.fx.push(bg);
      }
      FX.normalizeClip(c);
      out.push(c.id);
    }
    return { clips: out };
  });
  op('spotlight', 'Dim everything outside a region for a span. {clip | clips (picks the one under `from`), from, to, rect:{x,y,w,h}, shape?: rect|ellipse, dim?=0.6, fade?=0.25, params?}', (a) => {
    const c = a.clips ? clipAtTime(clipsOf(a.clips), num(a.from, 0)) : clipOf(a.clip);
    if (!c) fail('spotlight: no clip under ' + a.from);
    const r = a.rect || {};
    const e = timedEffect(c, 'spotlight', { from: a.from, to: a.to, fade: a.fade,
      params: Object.assign({ shape: a.shape || 'rect' }, pick(r, ['x', 'y', 'w', 'h']), a.params || {}) }, 'dim', num(a.dim, 0.6));
    return { clip: c.id, fx: e.id };
  });
  op('cutout', 'Lift a small UI region out, scale it up and float it for a span. {clip | clips, from, to, src:{x,y,w,h}, at?:{x,y}, scale?=1.9, fade?, params?}', (a) => {
    const c = a.clips ? clipAtTime(clipsOf(a.clips), num(a.from, 0)) : clipOf(a.clip);
    if (!c) fail('cutout: no clip under ' + a.from);
    const s = a.src || {};
    const p = Object.assign({}, a.params || {});
    if (s.x != null) p.sx = s.x; if (s.y != null) p.sy = s.y; if (s.w != null) p.sw = s.w; if (s.h != null) p.sh = s.h;
    if (a.at) { if (a.at.x != null) p.x = a.at.x; if (a.at.y != null) p.y = a.at.y; }
    if (a.scale != null) p.scale = num(a.scale, 1.9);
    const e = timedEffect(c, 'cutout', { from: a.from, to: a.to, fade: a.fade, params: p }, 'opacity', 1);
    return { clip: c.id, fx: e.id };
  });
  function pick(o, ks) { const r = {}; for (const k of ks) if (o[k] != null) r[k] = num(o[k], 0); return r; }

  op('tracker', 'Place a motion tracker and solve it. {clip, at (timeline), x, y (frame 0..1), solve?=true} -> {track, samples, meanConfidence}', async (a) => {
    const c = clipOf(a.clip);
    if (!isPictureClip(c) || c.kind !== 'video') fail('tracker: needs a video clip');
    seek(clamp(num(a.at, c.start), c.start, clipEnd(c) - 0.01));
    const tk = await addTracker(c, clamp(num(a.x, 0.5), 0, 1), clamp(num(a.y, 0.5), 0, 1));
    if (a.solve === false) return { track: tk.id };
    await solveTrack(c, tk);
    const solved = (c.tracks || []).find((t) => t.id === tk.id) || tk;
    const pts = solved.points || [];
    const conf = pts.length ? pts.reduce((s, p) => s + (Number(p.c) || 0), 0) / pts.length : 0;
    if (pts.length < 2) fail('tracker: the point could not be solved (flat area?) - pick an edge, icon or text');
    return { track: tk.id, clip: c.id, samples: pts.length, meanConfidence: r3(conf) };
  });
  op('callout', 'A label/arrow that sticks to a tracked point. {owner (clip with the track), track, start, len, text?, graphic?:{type, params}, offX?, offY?} -> {id}', (a) => {
    const owner = clipOf(a.owner, 'owner');
    if (!(owner.tracks || []).some((t) => t.id === a.track)) fail('callout: clip ' + owner.id + ' has no track "' + a.track + '"');
    const start = num(a.start, owner.start), len = num(a.len, 2);
    let clip;
    if (a.text != null) {
      const card = TextModel.defaultCard(String(a.text));
      merge(card.style, { fontSize: 64, bg: { on: true, color: '#101418', opacity: 0.9, padding: 22, radius: 16 } });
      merge(card.style, a.style || {});
      clip = canvasClip('text', card, { start, len, track: a.trackId });
      // Text cards take no effect stack, so a text callout follows through its card keys
      // instead: sample the track and write x/y offsets.
      const tk = owner.tracks.find((t) => t.id === a.track);
      const map = Tracker.frameMap(framedCopy(owner), outSize().w / outSize().h);
      const base = { x: card.style.x, y: card.style.y };
      const kx = [], ky = [];
      for (let t = 0; t <= len + 1e-6; t += 1 / 10) {
        const tl = start + t - owner.start;
        if (tl < 0 || tl > clipLen(owner)) continue;
        const p = Tracker.sampleAt(tk, srcAt(owner, tl));
        if (!p) continue;
        const fp = { x: (p.x - map.crop.x) / map.crop.w, y: (p.y - map.crop.y) / map.crop.h };
        kx.push({ t, v: fp.x + num(a.offX, 0) - base.x, ease: 'linear' });
        ky.push({ t, v: fp.y + num(a.offY, -0.06) - base.y, ease: 'linear' });
      }
      if (kx.length) { writeKeys(card, 'x', kx, { replace: true }); writeKeys(card, 'y', ky, { replace: true }); }
      return { id: clip.id, followed: kx.length > 0 };
    }
    const gdef = a.graphic || { type: 'bracket' };
    if (!Graphics.DEFS[gdef.type]) fail('callout: unknown graphic type ' + gdef.type);
    const g = Graphics.defaultGraphic(gdef.type);
    Object.assign(g.params, clone(gdef.params || {}));
    clip = canvasClip('graphic', g, { start, len, track: a.trackId });
    const e = FX.create('transform');
    e.bind = { track: a.track, clip: owner.id, offX: num(a.offX, 0), offY: num(a.offY, 0), mode: 'move' };
    clip.fx = [e];
    FX.normalizeClip(clip);
    return { id: clip.id, fx: e.id };
  });
  op('transition', 'Put a transition on a cut. {at (time of the cut) | a & b (clip ids), type?=swipe (see catalog.transitions), duration?, align?: center|before|after, params?, easing?} -> {id}', (a) => {
    const cuts = allCuts();
    let best = null;
    if (a.a && a.b) best = cuts.find((c) => c.a.id === a.a && c.b.id === a.b);
    else {
      const t = num(a.at, NaN);
      if (!isFinite(t)) fail('transition: give at, or a and b');
      for (const c of cuts) if (!best || Math.abs(c.cut - t) < Math.abs(best.cut - t)) best = c;
      if (best && Math.abs(best.cut - t) > 0.25) best = null;
    }
    if (!best) fail('transition: no cut there - two clips on the same track must touch');
    if (a.type && !Trans.TYPES[a.type]) fail('transition: unknown type "' + a.type + '" - one of ' + Object.keys(Trans.TYPES).join(', '));
    const existing = (best.track.transitions || []).find((t) => t.aId === best.a.id && t.bId === best.b.id);
    if (existing) best.track.transitions = best.track.transitions.filter((t) => t !== existing);
    const tr = Trans.defaults(a.type || 'swipe');
    tr.aId = best.a.id; tr.bId = best.b.id;
    tr.duration = Math.min(num(a.duration, tr.duration), maxTransitionDuration(best.a, best.b));
    if (a.align) tr.align = a.align;
    if (a.easing) tr.easing = easing(a.easing);
    if (isObj(a.params)) Object.assign(tr.params, clone(a.params));
    if (!best.track.transitions) best.track.transitions = [];
    best.track.transitions.push(tr);
    Trans.normalize(tr);
    preloadTransitionImages();
    return { id: tr.id, at: r3(best.cut) };
  });

  // ---- sound

  op('sounds', 'Add audio files or folders to the SFX library (paths are the ids). {paths:[path]} -> {items}', async (a) => {
    const paths = Array.isArray(a.paths) ? a.paths : [a.paths];
    await addSfxPaths(paths.filter(Boolean));
    return { items: sfxLib.items.map((i) => ({ id: i.id, name: i.name, duration: r3(Number(i.duration) || 0), missing: !!i.missing })) };
  });
  op('sfx', 'Place one sound. {sound: path|library id, at, gainDb?} -> {id}. Adds the file to the library if needed.', async (a) => {
    await ensureSounds([a.sound]);
    return { id: placeSound(a.sound, a.at, a.gainDb).id };
  });
  op('sonify', 'Set the trigger sounds and run Sonify (replaces its own previous pass). {triggers?:{graphic|transition|click|counter|cut: path | {sound, gainDb, offset, enabled}}, level?, duck?:{enabled, voiceTrack}} -> {made}', async (a) => {
    const o = SFX.normalizeOpts(state.sfx);
    const paths = [];
    for (const k of Object.keys(a.triggers || {})) {
      if (!o.triggers[k]) fail('sonify: unknown trigger "' + k + '" - one of ' + SFX.TRIGGER_IDS.join(', '));
      const v = a.triggers[k];
      const cfg = typeof v === 'string' ? { sound: v } : Object.assign({}, v);
      if (cfg.sound) paths.push(cfg.sound);
      Object.assign(o.triggers[k], cfg, { enabled: cfg.enabled !== false });
    }
    await ensureSounds(paths);
    for (const k of Object.keys(o.triggers)) {
      const s = o.triggers[k].sound && resolveSound(o.triggers[k].sound);
      if (s) o.triggers[k].sound = s.id;
    }
    if (a.level != null) o.level = num(a.level, o.level);
    if (isObj(a.duck)) {
      Object.assign(o.duck, a.duck);
      if (a.duck.voiceTrack) o.duck.voiceTrack = trackOf(a.duck.voiceTrack, 'audio').id;
    }
    state.sfx = SFX.normalizeOpts(o);
    const r = sonify();
    return { made: r ? r.made : 0, replaced: r ? r.replaced : 0 };
  });
  op('audioFx', 'Add an audio effect to an audio clip (a video resolves to its linked audio). {clip, type (see catalog.audioEffects), params?} -> {fx}. For duck, params.voiceTrack may be a track name.', (a) => {
    let c = clipOf(a.clip);
    if (c.kind !== 'audio') c = audioFxTarget(c);
    if (!c || c.kind !== 'audio') fail('audioFx: that clip has no audio');
    const e = AudioFX.create(a.type);
    if (!e) fail('audioFx: unknown type "' + a.type + '" - one of ' + AudioFX.TYPES.join(', '));
    Object.assign(e.params, clone(a.params || {}));
    if (a.type === 'duck' && e.params.voiceTrack) e.params.voiceTrack = trackOf(e.params.voiceTrack, 'audio').id;
    if (!Array.isArray(c.afx)) c.afx = [];
    c.afx.push(e);
    AudioFX.normalizeClip(c);
    return { fx: e.id, clip: c.id };
  });

  // ---- captions

  op('captions', 'Word-level captions in the safe zone. {clips:[id] (speech clips), words?:[{w,start,end}] (SOURCE seconds of that file) | transcribe?:true, model?, settings?:{maxWords, fontSize, highlight, keywords, wordReveal, wordEmphasis, zoneTop, zoneBottom, ...}} -> {made}', async (a) => {
    const cs = clipsOf(a.clips || a.clip);
    if (!cs.length) fail('captions: clips are required');
    if (isObj(a.settings)) Object.assign(state.captions, a.settings);
    state.selection = new Set(cs.map((c) => c.id));
    if (Array.isArray(a.words)) {
      const srcs = new Set(captionUnits().map((u) => u.audio && u.audio.src).filter(Boolean));
      if (!srcs.size) fail('captions: none of those clips has audio');
      for (const s of srcs) setTranscript(s, a.words);
    } else if (a.transcribe) {
      const r = await transcribeSelection({ model: a.model });
      if (r.failed && !r.done) fail('captions: transcription failed (' + (r.reason || '') + '): ' + r.error);
    }
    if (state.captions.preset) await ensureCaptionPreset(state.captions.preset);
    const r = generateCaptions();
    state.selection.clear();
    if (!r) fail('captions: nothing generated - no transcript words inside those clips');
    return { made: r.made, replaced: r.replaced };
  });

  // ---- finishing and delivery

  op('master', 'Replace the project master finish. {stack:[{type: grade|lut|bloom|grain|blur|round, params?}]}', (a) => {
    if (!Array.isArray(a.stack)) fail('master: stack must be an array');
    state.master = FX.normalizeStack(a.stack.map((s) => {
      const e = FX.create(s.type);
      if (!e) fail('master: unknown type ' + s.type);
      Object.assign(e.params, clone(s.params || {}));
      return e;
    }));
    return { types: state.master.map((e) => e.type) };
  });
  op('delivery', 'Delivery settings. {formats?:["9x16","1x1","16x9"], safe?:bool, maxGap?:seconds}', (a) => {
    state.delivery = normalizeDelivery(Object.assign({}, state.delivery, pickDefined(a, ['formats', 'safe', 'maxGap'])));
    renderSafeOverlay();
    return clone(state.delivery);
  });
  function pickDefined(o, ks) { const r = {}; for (const k of ks) if (o[k] !== undefined) r[k] = o[k]; return r; }
  op('frame', 'Per-format framing override. {clip, format: 1x1|16x9|9x16, panX?, panY?, zoom?, fit?, clear?:bool}', (a) => {
    const c = clipOf(a.clip);
    if (!Delivery.formatById(a.format)) fail('frame: unknown format ' + a.format);
    if (a.clear) Delivery.clearOverride(c, a.format);
    else Delivery.setOverride(c, a.format, pickDefined(a, ['panX', 'panY', 'zoom', 'fit']));
    Delivery.normalizeClip(c);
    return { frames: clone(c.frames || null) };
  });
  op('hooks', 'Hook variants. {len?, enable?:bool, add?:"copy"|"blank", activate?:index, remove?:index} -> {variants, active}. Clips that START inside [0,len) belong to the active hook.', (a) => {
    const h = state.hooks;
    if (a.len != null) h.len = clamp(num(a.len, h.len), 0.5, 30);
    if (a.enable && !h.enabled) enableHooks();
    if (a.add) { if (!h.enabled) enableHooks(); addVariant(a.add === 'blank'); }
    if (a.remove != null) removeVariant(Math.round(a.remove));
    if (a.activate != null) activateVariant(Math.round(a.activate));
    return { enabled: h.enabled, len: h.len, active: h.active, variants: h.variants.map((v) => v.name), crossers: Delivery.crossers(hookScene(), h.len).map((c) => c.id) };
  });
  op('lint', 'The retention lint: spans longer than maxGap with no cut, zoom, graphic, caption or SFX. {maxGap?, fix?:bool (adds a punch-in in each flat span)} -> {flat:[{from,to,gap,after}], fixed}', (a) => {
    if (a.maxGap != null) state.delivery.maxGap = clamp(num(a.maxGap, 3), 0.5, 15);
    let flat = runLint();
    let fixed = 0;
    if (a.fix) {
      // Each flat stretch gets gentle push/settle keys spaced under the threshold, on the
      // topmost picture or graphic under it - a keyframe is a change the lint counts, and
      // the eye reads a slow breathe as motion rather than as an effect.
      const step = state.delivery.maxGap * 0.8;
      for (const f of flat) {
        const n = Math.max(1, Math.ceil(f.gap / step) - 1);
        for (let i = 1; i <= n; i++) {
          const at = f.from + (f.gap * i) / (n + 1);
          const under = allClips().filter(({ clip, track }) => track.type === 'video' && !track.hidden &&
            (isPictureClip(clip) || clip.kind === 'graphic') && at >= clip.start && at < clipEnd(clip)).map((x) => x.clip);
          const c = under[0];
          if (!c) continue;
          const e = tagTransform(c, 'agent-lint');
          const t = at - c.start;
          if (!(e.keys && e.keys.scale && e.keys.scale.length)) writeKeys(e, 'scale', [{ t: 0, v: 1, ease: 'easeInOut' }], { gen: 'agent-lint' });
          const lastV = e.keys.scale[e.keys.scale.length - 1].v;
          writeKeys(e, 'scale', [{ t, v: lastV > 1.02 ? 1 : 1.06, ease: 'easeInOut' }], { gen: 'agent-lint' });
          FX.normalizeClip(c);
          fixed++;
        }
      }
      if (fixed) flat = runLint();
    }
    return { flat, fixed, summary: Delivery.lintSummary(flat, projectDuration()) };
  });
  op('still', 'Write one composited frame as PNG, to LOOK at the edit. {at, dir, name?, format?} -> {path}', async (a) => {
    if (typeof a.dir !== 'string') fail('still: dir is required');
    const f = Delivery.formatById(a.format || activeFormatId()) || { w: state.out.w, h: state.out.h, id: null };
    const t = clamp(num(a.at, state.playhead), 0, Math.max(0, projectDuration() - 1 / state.out.fps));
    const url = await withFormat(f.id, async () => (await composeCover(t, f.w, f.h)).toDataURL('image/png'));
    frameCacheValid = false;
    const name = (a.name || ('still_' + Math.round(t * 1000) + 'ms')) + '.png';
    const r = await window.api.writeCover(a.dir, name, url);
    if (!r || !r.ok) fail('still: ' + ((r && r.error) || 'write failed'));
    return { path: r.path, at: r3(t) };
  });
  op('covers', 'Designed cover frames, one PNG per ticked format. {dir, at?, name?} -> {paths}', async (a) => {
    if (typeof a.dir !== 'string') fail('covers: dir is required');
    return { paths: await exportCovers({ dir: a.dir, time: a.at, name: a.name, quiet: true }) };
  });
  op('render', 'Render the master format to an MP4. {path, from?, to?, force?} -> {outPath, cached}', async (a) => {
    if (typeof a.path !== 'string') fail('render: path is required');
    const r = await doRender({ outPath: a.path, range: a.from != null || a.to != null ? { from: a.from, to: a.to } : null, force: a.force, quiet: true });
    if (!r || !r.ok) fail('render failed: ' + ((r && r.error) || 'unknown'));
    return { outPath: r.outPath, cached: !!r.cached };
  });
  op('deliver', 'Every ticked format x every hook variant, named for you. {dir, name?} -> {written}', async (a) => {
    if (typeof a.dir !== 'string') fail('deliver: dir is required');
    const r = await doDeliver({ dir: a.dir, name: a.name, quiet: true });
    if (!r || !r.ok) fail('deliver failed: ' + ((r && r.error) || 'unknown'));
    return r;
  });
  op('trimTo', 'End the edit at a time: clips running past it are trimmed, clips starting after it are deleted. {at}', (a) => {
    const t = num(a.at, NaN);
    if (!(t > 0)) fail('trimTo: at must be a positive time');
    let trimmed = 0, removed = 0;
    for (const tr of state.tracks) {
      if (tr.locked) continue;
      const keep = [];
      for (const c of tr.clips) {
        if (c.start >= t - 1e-6) { removed++; dropMedia(c.id); continue; }
        if (clipEnd(c) > t + 1e-6) {
          c.out = isCanvasClip(c) ? t - c.start : Math.max(c.in + 0.02, Speed.advance(c, c.in, t - c.start));
          trimmed++;
        }
        keep.push(c);
      }
      tr.clips = keep;
    }
    return { trimmed, removed, duration: r3(projectDuration()) };
  });
  op('describe', 'The project as data (same as Agent.describe). {full?:bool}', (a) => describe(a));
  op('eval', 'Escape hatch: run JavaScript in the renderer (every app.js function is in scope). {js} -> its value', async (a) => {
    // eslint-disable-next-line no-eval
    const v = await (0, eval)(String(a.js || ''));
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  });

  // ------------------------------------------------------------------ refs

  function resolveRefs(v) {
    if (typeof v === 'string' && /^\$[A-Za-z_][\w]*(\.[\w]+)*$/.test(v)) {
      const [name, ...path] = v.slice(1).split('.');
      if (!refs.has(name)) fail('unknown reference ' + v + ' - no earlier op had as:"' + name + '"');
      let cur = refs.get(name);
      if (!path.length && isObj(cur) && cur.id != null && !Array.isArray(cur.ids)) return cur.id;
      if (!path.length && isObj(cur) && Array.isArray(cur.ids)) return cur.ids;
      for (const p of path) { cur = cur == null ? undefined : cur[p]; }
      if (cur === undefined) fail('reference ' + v + ' has no value');
      return cur;
    }
    if (Array.isArray(v)) return v.map(resolveRefs);
    if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = resolveRefs(v[k]); return o; }
    return v;
  }

  // ------------------------------------------------------------------ run

  const NOOP = ' agent-noop';
  const settingsSnap = () => JSON.stringify({
    out: state.out, captions: state.captions, sfx: state.sfx, delivery: state.delivery,
    hooks: state.hooks, tighten: state.tighten, playhead: state.playhead,
  });

  /**
   * Run a batch. Every inner `pushUndo()` is collapsed into ONE undo entry for the batch,
   * and a failing op rolls the whole batch back (`atomic`, the default) so an agent never
   * leaves a half-applied edit behind. `atomic:false` keeps what succeeded.
   */
  async function run(ops, opts) {
    const o = opts || {};
    if (!Array.isArray(ops)) fail('ops must be an array of {op, ...}');
    if (Agent.busy) return { ok: false, error: 'the agent is already running a batch' };
    if (rendering) return { ok: false, error: 'a render is running' };
    Agent.busy = true;
    if (!o.keepRefs) refs = new Map();
    const snap = snapshot();
    const settings = settingsSnap();
    const realPush = pushUndo;
    pushUndo = function agentPushUndo() { undoStack.push(NOOP); };   // swallowed; see above
    const results = [];
    let error = null;
    const t0 = performance.now();
    try {
      for (let i = 0; i < ops.length; i++) {
        const raw = ops[i];
        if (!isObj(raw) || typeof raw.op !== 'string') { error = { index: i, error: 'each op is an object with an "op" name' }; break; }
        const spec = OPS[raw.op];
        if (!spec) { error = { index: i, op: raw.op, error: 'unknown op "' + raw.op + '" - see catalog().ops' }; break; }
        try {
          const args = resolveRefs(Object.assign({}, raw));
          const res = await spec.fn(args);
          if (raw.as) refs.set(String(raw.as), res);
          results.push({ op: raw.op, as: raw.as, result: res });
        } catch (e) {
          error = { index: i, op: raw.op, error: e instanceof AgentError ? e.message : String(e && e.stack || e) };
          break;
        }
      }
    } finally {
      pushUndo = realPush;
      undoStack = undoStack.filter((s) => s !== NOOP);
      Agent.busy = false;
    }
    const changed = snapshot() !== snap;
    if (error && o.atomic !== false) {
      restore(snap);
      const s = JSON.parse(settings);
      Object.assign(state, { out: s.out, captions: s.captions, sfx: s.sfx, delivery: s.delivery, hooks: s.hooks, tighten: s.tighten, playhead: s.playhead });
      resizeCanvas();
      renderAll();
      return { ok: false, error: error.error, failedAt: error.index, op: error.op, rolledBack: true, results };
    }
    if (changed) {
      undoStack.push(snap);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
      markDirty();
    }
    sortTracks();
    renderAll();
    renderSfxPanel(); renderCaptionsPanel(); renderDeliveryPanel();
    const out = { ok: !error, results, ms: Math.round(performance.now() - t0), duration: r3(projectDuration()) };
    if (error) Object.assign(out, { error: error.error, failedAt: error.index, op: error.op, rolledBack: false });
    if (o.describe) out.project = describe({});
    if (o.lint !== false && !error) out.lint = runLint();
    log('Agent: ' + results.length + ' op(s)' + (error ? ', failed at #' + error.index + ': ' + error.error : '') + '.');
    return out;
  }

  // ------------------------------------------------------------------ describe

  function describe(opts) {
    const full = !!(opts && opts.full);
    const clipInfo = (c, t) => {
      const o = {
        id: c.id, kind: c.kind, name: c.name, track: t.name,
        start: r3(c.start), end: r3(clipEnd(c)), len: r3(clipLen(c)),
      };
      if (c.src) Object.assign(o, { src: c.src, in: r3(c.in), out: r3(c.out), mediaDuration: r3(c.mediaDuration) });
      if (isPictureClip(c)) Object.assign(o, { panX: r3(c.panX), panY: r3(c.panY), zoom: r3(c.zoom), srcW: c.srcW, srcH: c.srcH });
      if (c.fit) o.fit = c.fit;
      if (c.kind === 'audio') o.volume = c.volume;
      if (c.linkId) o.linkId = c.linkId;
      if (Speed.has(c)) o.speed = Speed.label(c);
      if (c.fx && c.fx.length) o.fx = c.fx.map((f) => ({ id: f.id, type: f.type, enabled: f.enabled !== false, gen: f.gen, keyed: Object.keys(f.keys || {}), bind: f.bind ? clone(f.bind) : undefined, params: full ? clone(f.params) : undefined }));
      if (c.afx && c.afx.length) o.afx = c.afx.map((f) => f.type);
      if (c.card) { o.text = c.card.text; if (full) o.card = clone(c.card); }
      if (c.graphic) { o.graphic = c.graphic.type; if (full) o.params = clone(c.graphic.params); }
      if (ScreenTel.hasTelemetry(c)) o.telemetry = { clicks: clipClicks(c).length };
      if (clipHasTake(c)) o.take = { clicks: clipTakeClicks(c).length };
      if (c.tracks && c.tracks.length) o.tracks = c.tracks.map((k) => ({ id: k.id, name: k.name, solved: Tracker.isSolved ? Tracker.isSolved(k) : (k.points || []).length > 1 }));
      if (c.captions) o.caption = true;
      if (c.sfx) o.sfx = c.sfx.trigger;
      if (c.frames) o.frames = clone(c.frames);
      return o;
    };
    return {
      app: 'shortcut', agentApi: VERSION,
      file: state.filePath, dirty: state.dirty,
      out: clone(state.out), duration: r3(projectDuration()), playhead: r3(state.playhead),
      tracks: state.tracks.map((t) => ({
        id: t.id, name: t.name, type: t.type, muted: t.muted, hidden: t.hidden, locked: t.locked,
        captions: !!t.captions, sfx: !!t.sfx,
        clips: t.clips.map((c) => clipInfo(c, t)),
        transitions: (t.transitions || []).map((tr) => {
          const r = resolveTransition(tr, t);
          return { id: tr.id, type: tr.type, a: tr.aId, b: tr.bId, duration: tr.duration, at: r ? r3(r.cut) : null, live: !!r };
        }),
      })),
      master: state.master.map((e) => e.type),
      hooks: { enabled: state.hooks.enabled, len: state.hooks.len, active: state.hooks.active, variants: state.hooks.variants.map((v) => v.name) },
      delivery: clone(state.delivery),
      captions: full ? clone(state.captions) : undefined,
      sfx: { level: state.sfx.level, triggers: Object.fromEntries(Object.entries(SFX.normalizeOpts(state.sfx).triggers).map(([k, v]) => [k, v.sound || null])) },
      lint: runLint(),
      undoDepth: undoStack.length,
    };
  }

  // ------------------------------------------------------------------ catalog

  const schemaOf = (schema) => (schema || []).map((s) => {
    const o = { param: String(s.path || '').replace(/^params\./, ''), label: s.label, type: s.type };
    for (const k of ['min', 'max', 'step', 'unit']) if (s[k] != null) o[k] = s[k];
    if (Array.isArray(s.options)) o.options = s.options.map((x) => x.value);
    return o;
  });

  function catalog() {
    const effects = {};
    for (const t of FX.TYPES) {
      const d = FX.DEFS[t];
      effects[t] = { label: d.label, params: clone(d.params), schema: schemaOf(d.schema), canFollowTrack: !!d.bind, needs: d.needs || null, master: FX.MASTER_TYPES.includes(t) };
    }
    const graphics = {};
    for (const t of Graphics.TYPES) {
      const d = Graphics.DEFS[t];
      graphics[t] = { label: d.label, group: d.group, params: clone(d.params), schema: schemaOf(d.schema) };
    }
    const transitions = {};
    for (const t of Object.keys(Trans.TYPES)) {
      const d = Trans.defaults(t);
      transitions[t] = { label: Trans.TYPES[t].label, duration: d.duration, params: d.params };
    }
    const audioEffects = {};
    for (const t of AudioFX.TYPES) audioEffects[t] = { label: AudioFX.DEFS[t].label, params: clone(AudioFX.DEFS[t].params) };
    return {
      app: 'shortcut', agentApi: VERSION,
      conventions: {
        time: 'start/at/from/to are timeline seconds; in/out on media are source seconds; key t is seconds into the clip unless timeline:true',
        units: 'positions and sizes are fractions of the frame (shorter side for lengths), never pixels; text fontSize is px against a 1920-tall frame',
        refs: 'give an op as:"name"; later string args "$name" (the id) or "$name.field" resolve to its result',
        batches: 'a run() is ONE undo entry and rolls back entirely when an op fails (atomic:false keeps partial work)',
      },
      ops: Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.doc])),
      effects, graphics, transitions, audioEffects,
      text: { style: TextModel.defaultStyle(), animTypes: clone(TextModel.ANIM_TYPES), keyable: TextModel.KEYABLE },
      easings: Object.keys(Anim.EASING_PRESETS),
      chromePresets: Object.keys(FX.CHROME),
      autoZoom: clone(Cursor.DEFAULTS.zoom),
      sfxTriggers: Object.fromEntries(SFX.TRIGGER_IDS.map((k) => [k, { label: SFX.TRIGGERS[k].label, offset: SFX.TRIGGERS[k].offset, gainDb: SFX.TRIGGERS[k].gainDb }])),
      captions: clone(Captions.DEFAULTS),
      formats: Delivery.FORMATS.map((f) => ({ id: f.id, label: f.label, w: f.w, h: f.h, safe: f.safe })),
      template: TEMPLATE_DOC,
    };
  }

  // ------------------------------------------------------------------ the B2B template

  const TEMPLATE_DOC = {
    about: 'Agent.expand(spec) compiles a short into ops; Agent.build(spec) runs them. All times are timeline seconds except source.in.',
    spec: {
      output: '{w,h,fps,quality}',
      brand: '{bg, bg2, accent, ink, font}',
      sounds: '{riser, whoosh, click, impact, pop, tick} - file paths, each optional',
      music: '{src, gainDb?=-16, duck?=true}',
      transcripts: '{"<media path>": [{w,start,end}] source seconds} - or captions.transcribe:true',
      captions: 'true | {transcribe?, settings?}',
      beats: '[hook|stakes|product|proof|mechanism|cta] - see below',
      hookVariants: '[{source:{src,in}, text?}] - alternative openings over the same tail',
      lint: '{fix?:true, maxGap?:3}',
      deliver: '{dir, formats?:["9x16","1x1","16x9"], cover?: seconds, name?}',
      save: 'path of the .scut to write',
    },
    beats: {
      hook: '{from,to, source:{src,in}, punchIn?:{at,scale,x,y}, sfx?:"riser"|"impact", text?}',
      stakes: '{from,to, source:{src,in}, graphic?:{type,params,at?}, rampIn?:true}',
      product: '{from,to, source:{src,in}, reframeEvery?:2.5, mockup?:preset|false, background?:{...}, autoZoom?:true|{settings}, ripples?:true, spotlights?:[{from,to,rect}], cutouts?:[{from,to,src,at,scale}], callouts?:[{from,to,text,point:{x,y}}]}',
      proof: '{from,to, graphics:[{type,params,from?,to?}], plate?:true}',
      mechanism: '{from,to, graphic:{type: flow|funnel|nodemap, params:{spec}}, plate?:true}',
      cta: '{from,to, source?:{src,in}, text, sub?}',
    },
  };

  /**
   * Compile a short spec into ops. Pure: it reads nothing from the timeline, so the op list
   * can be inspected, edited and then run - and the same spec always compiles the same way.
   */
  function expand(spec) {
    if (!isObj(spec)) fail('spec must be an object');
    const S = spec;
    const brand = Object.assign({ bg: '#0b1020', bg2: '#1d2b5c', accent: '#4f8cff', ink: '#ffffff', font: 'Segoe UI' }, S.brand || {});
    const snd = S.sounds || {};
    const ops = [];
    const add = (o) => { ops.push(o); return o; };
    let n = 0;
    const ref = (p) => p + '_' + (n++);
    const beats = (S.beats || []).slice().sort((a, b) => num(a.from, 0) - num(b.from, 0));
    if (!beats.length) fail('spec.beats is empty');
    const end = Math.max(...beats.map((b) => num(b.to, 0)));
    const speech = [];

    add({ op: 'new', force: true });
    if (S.output) add(Object.assign({ op: 'output' }, S.output));
    add({ op: 'addTrack', type: 'video', as: 'V2' });
    add({ op: 'addTrack', type: 'video', as: 'V3' });

    const plate = (b) => {
      const id = ref('plate');
      add({ op: 'graphic', type: 'rect', start: b.from, len: b.to - b.from, track: 'V1', name: 'Plate', as: id,
        params: { w: 2, h: 2, fill: brand.bg, inDur: 0 } });
      add({ op: 'effect', clip: '$' + id, type: 'background', params: { mode: 'gradient', colourA: brand.bg, colourB: brand.bg2 } });
      return id;
    };
    const footage = (b, asName) => {
      if (!b.source || !b.source.src) fail(b.type + ' beat at ' + b.from + ' needs source.src');
      add({ op: 'clip', src: b.source.src, in: num(b.source.in, 0), start: b.from, len: b.to - b.from, track: 'V1', as: asName });
      return asName;
    };

    for (const b of beats) {
      const len = num(b.to, 0) - num(b.from, 0);
      if (!(len > 0)) fail('beat ' + b.type + ' has to > from');
      const type = b.type;
      if (type === 'hook' || type === 'stakes' || (type === 'cta' && b.source)) {
        const id = footage(b, ref(type));
        speech.push('$' + id);
        if (type === 'hook') {
          const pi = Object.assign({ at: b.from + Math.min(1.5, len / 2), scale: 1.15 }, b.punchIn || {});
          add(Object.assign({ op: 'punchIn', clip: '$' + id }, pi));
          const s = snd[b.sfx || 'riser'] || snd.impact;
          if (s) add({ op: 'sfx', sound: s, at: b.from, gainDb: -6 });
          if (b.text) add({ op: 'text', text: b.text, start: b.from, len, track: '$V3', anims: 'pop', style: { fontSize: 92, y: 0.2, fill: { color: brand.ink }, fontFamily: brand.font } });
        } else {
          add({ op: 'drift', clip: '$' + id, scale: 1.06 });
          if (type === 'stakes' && b.rampIn !== false) {
            add({ op: 'speed', clip: '$' + id, ramp: [{ t: 0, v: 1.8 }, { t: 0.45, v: 1 }], keepLength: true });
          }
        }
        if (type === 'stakes' && b.graphic) {
          const g = b.graphic;
          const at = b.from + num(g.at, 0.4);
          const gid = ref('gfx');
          add({ op: 'graphic', type: g.type || 'counter', start: at, len: b.to - at, track: '$V2', as: gid,
            params: Object.assign({ fill: brand.accent, ink: brand.ink, y: 0.3, inDur: 0.6 }, g.params || {}) });
        }
        if (type === 'cta') ctaText(b);
      } else if (type === 'product') {
        const id = footage(b, ref('product'));
        const pieces = ref('pieces');
        add({ op: 'reframe', clip: '$' + id, every: num(b.reframeEvery, 2.5), as: pieces });
        if (b.ripples !== false) add({ op: 'ripples', clips: '$' + pieces });
        if (b.autoZoom !== false) add({ op: 'autoZoom', clips: '$' + pieces, settings: isObj(b.autoZoom) ? b.autoZoom : { minHold: 0.6 }, whoosh: snd.whoosh || undefined, gainDb: -8 });
        if (b.mockup !== false) {
          add({ op: 'mockup', clips: '$' + pieces, preset: b.mockup || 'browser', chrome: Object.assign({}, b.chrome || {}),
            background: Object.assign({ mode: 'gradient', colourA: brand.bg, colourB: brand.bg2 }, b.background || {}) });
        }
        for (const s of b.spotlights || []) add(Object.assign({ op: 'spotlight', clips: '$' + pieces }, s));
        for (const c of b.cutouts || []) add(Object.assign({ op: 'cutout', clips: '$' + pieces }, c));
        for (const c of b.callouts || []) {
          add({ op: 'text', text: c.text, start: c.from, len: num(c.to, c.from + 2) - c.from, track: '$V3', anims: 'pop',
            style: { fontSize: 58, x: c.point ? c.point.x : 0.5, y: c.point ? Math.max(0.08, c.point.y - 0.07) : 0.25, fill: { color: brand.ink },
              bg: { on: true, color: brand.accent, opacity: 0.95, padding: 20, radius: 14 }, fontFamily: brand.font } });
          if (c.point && c.arrow !== false) {
            add({ op: 'graphic', type: 'arrow', start: c.from, len: num(c.to, c.from + 2) - c.from, track: '$V2',
              params: { x: c.point.x, y: Math.max(0.1, c.point.y - 0.05), x2: c.point.x, y2: c.point.y, fill: brand.accent, inDur: 0.3 } });
          }
        }
      } else if (type === 'proof') {
        if (b.plate !== false) plate(b);
        const gs = b.graphics || [];
        const slot = len / Math.max(1, gs.length);
        gs.forEach((g, i) => {
          const from = g.from != null ? g.from : b.from + i * slot * 0.5;
          const to = g.to != null ? g.to : b.to;
          const y = gs.length > 1 ? 0.28 + 0.44 * (i / (gs.length - 1)) : 0.45;
          const params = Object.assign({ fill: brand.accent, ink: brand.ink, y, inDur: 0.7 }, g.params || {});
          add({ op: 'graphic', type: g.type || 'counter', start: from, len: to - from, track: '$V2', params });
          const land = from + num(params.inDelay, 0) + num(params.inDur, 0.7);
          if (snd.impact) add({ op: 'sfx', sound: snd.impact, at: land, gainDb: -5 });
        });
      } else if (type === 'mechanism') {
        if (b.plate !== false) plate(b);
        const g = b.graphic || { type: 'flow' };
        add({ op: 'graphic', type: g.type || 'flow', start: b.from, len, track: '$V2',
          params: Object.assign({ fill: brand.accent, fill2: brand.bg2, ink: brand.ink, stagger: 0.25, inDur: 0.6 }, g.params || {}) });
        if (b.title) add({ op: 'text', text: b.title, start: b.from, len, track: '$V3', anims: 'pop', style: { fontSize: 72, y: 0.16, fill: { color: brand.ink }, fontFamily: brand.font } });
      } else if (type === 'cta') {
        if (b.plate !== false) plate(b);
        ctaText(b);
      } else fail('unknown beat type "' + type + '"');
    }

    function ctaText(b) {
      add({ op: 'text', text: b.text || 'Book a demo', start: b.from, len: b.to - b.from, track: '$V3', anims: 'type',
        style: { fontSize: 104, y: b.source ? 0.72 : 0.45, fill: { color: brand.ink }, fontFamily: brand.font,
          bg: { on: !!b.source, color: brand.accent, opacity: 0.95, padding: 28, radius: 22 } } });
      if (b.sub) add({ op: 'text', text: b.sub, start: b.from + 0.4, len: b.to - b.from - 0.4, track: '$V2', anims: 'pop', style: { fontSize: 56, y: b.source ? 0.82 : 0.56, fill: { color: brand.accent }, fontFamily: brand.font } });
    }

    // Hard cuts between beats get a transition where the spec asks for one.
    for (const t of S.transitions || []) add(Object.assign({ op: 'transition' }, t));

    if (S.captions && speech.length) {
      const words = S.transcripts || {};
      const cap = isObj(S.captions) ? S.captions : {};
      const srcs = [...new Set(beats.filter((b) => b.source && ['hook', 'stakes', 'cta'].includes(b.type)).map((b) => b.source.src))];
      const settings = Object.assign({ highlight: brand.accent, wordEmphasis: true, emphasisColor: brand.accent }, cap.settings || {});
      if (srcs.some((s) => words[s])) {
        // One caption pass per source file, over that file's speech clips.
        for (const s of srcs) {
          if (!words[s]) continue;
          add({ op: 'captions', clips: speechFor(s), words: words[s], settings });
        }
      } else if (cap.transcribe) {
        add({ op: 'captions', clips: speech, transcribe: true, settings });
      }
    }
    function speechFor(src) {
      return ops.filter((o) => o.op === 'clip' && o.src === src && /^(hook|stakes|cta)_/.test(o.as || ''))
        .map((o) => '$' + o.as);
    }

    if (S.music && S.music.src) {
      add({ op: 'clip', src: S.music.src, start: 0, len: end, track: undefined, as: 'music', audio: true });
      add({ op: 'audioFx', clip: '$music', type: 'gain', params: { db: num(S.music.gainDb, -16) } });
      if (S.music.duck !== false) add({ op: 'audioFx', clip: '$music', type: 'duck', params: { voiceTrack: 'A1' } });
    }

    const trig = {};
    if (snd.click) trig.click = snd.click;
    if (snd.pop) trig.graphic = snd.pop;
    if (snd.tick) trig.counter = snd.tick;
    if (snd.whoosh) trig.transition = snd.whoosh;
    if (Object.keys(trig).length) add({ op: 'sonify', triggers: trig });

    if (Array.isArray(S.hookVariants) && S.hookVariants.length) {
      const hook = beats.find((b) => b.type === 'hook');
      if (!hook) fail('hookVariants need a hook beat');
      add({ op: 'hooks', len: hook.to, enable: true });
      S.hookVariants.slice(0, Delivery.MAX_VARIANTS - 1).forEach((v) => {
        add({ op: 'hooks', add: 'blank' });
        const vb = Object.assign({}, hook, v, { type: 'hook', from: hook.from, to: hook.to });
        const id = ref('hookalt');
        add({ op: 'clip', src: vb.source.src, in: num(vb.source.in, 0), start: vb.from, len: vb.to - vb.from, track: 'V1', as: id });
        add(Object.assign({ op: 'punchIn', clip: '$' + id }, Object.assign({ at: vb.from + Math.min(1.5, (vb.to - vb.from) / 2), scale: 1.15 }, vb.punchIn || {})));
        const s = snd[vb.sfx || 'riser'] || snd.impact;
        if (s) add({ op: 'sfx', sound: s, at: vb.from, gainDb: -6 });
        if (vb.text) add({ op: 'text', text: vb.text, start: vb.from, len: vb.to - vb.from, track: '$V3', anims: 'pop', style: { fontSize: 92, y: 0.2, fill: { color: brand.ink }, fontFamily: brand.font } });
        if (S.transcripts && S.transcripts[vb.source.src]) {
          add({ op: 'captions', clips: ['$' + id], words: S.transcripts[vb.source.src], settings: { highlight: brand.accent } });
        }
      });
      add({ op: 'hooks', activate: 0 });
    }

    // Sounds and a music bed run past the last beat; the edit ends where the beats do.
    add({ op: 'trimTo', at: end });
    const lint = Object.assign({ fix: true }, S.lint || {});
    add({ op: 'lint', fix: lint.fix !== false, maxGap: num(lint.maxGap, 3) });
    if (S.save) add({ op: 'save', path: S.save });
    if (S.deliver && S.deliver.dir) {
      add({ op: 'delivery', formats: S.deliver.formats || ['9x16', '1x1', '16x9'] });
      if (S.deliver.cover != null) add({ op: 'covers', dir: S.deliver.dir, at: num(S.deliver.cover, 0), name: S.deliver.name });
      add({ op: 'deliver', dir: S.deliver.dir, name: S.deliver.name });
    }
    return ops;
  }

  async function build(spec, opts) {
    let ops;
    try { ops = expand(spec); } catch (e) { return { ok: false, error: e.message, stage: 'expand' }; }
    const r = await run(ops, opts);
    r.ops = ops.length;
    return r;
  }

  /** The one entry point the main process calls. Never throws: errors come back as data. */
  async function dispatch(method, payload) {
    try {
      const p = payload || {};
      switch (method) {
        case 'run': return await run(Array.isArray(p) ? p : p.ops, Array.isArray(p) ? {} : p);
        case 'build': return await build(p.spec || p, p.spec ? p : {});
        case 'expand': return { ok: true, ops: expand(p.spec || p) };
        case 'describe': return describe(p);
        case 'catalog': return catalog();
        default: return { ok: false, error: 'unknown method "' + method + '" - run, build, expand, describe, catalog' };
      }
    } catch (e) {
      return { ok: false, error: e instanceof AgentError ? e.message : String((e && e.stack) || e) };
    }
  }

  return { VERSION, busy: false, OPS, run, build, expand, describe, catalog, dispatch };
})();
window.Agent = Agent;
