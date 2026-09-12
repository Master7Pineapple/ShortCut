# ShortCut

**Editing B2B and SaaS niche short-form videos made easy.**

A Windows desktop editor built for short-form vertical video: drop clips in, frame the
16:9 source down to 9:16 by sliding the crop window, cut and arrange on a multi-track
timeline, add animated text cards, render out with ffmpeg.

Double-click **`ShortCut.bat`** to run it. The first launch runs `npm install` for you;
after that it starts immediately.

---

## For developers and agents modifying this app

### Running

```bash
npm install
npm start
```

A `.scut` path on the command line **opens on launch**, which saves walking the file
dialog every time the same project is being worked on or tested:

```bash
npx electron . project_test_2.scut
```

`ShortCut.bat` passes its arguments through, so `ShortCut.bat project_test_2.scut` does
the same. A smoke run ignores it — those suites all start from an empty timeline.

There is **no build step and no bundler**. `src/renderer/app.js` is plain ES2020 loaded
directly by a `<script>` tag. Edit a file, press `F5` in the app window to reload the
renderer (`Ctrl+Shift+I` opens DevTools — note `Ctrl+R` is bound to *render*, not
reload). Changes to `src/main.js` or `src/preload.js` need a full restart.

### Testing and debugging

Three environment variables hook into the main process (all in `createWindow()`):

| Variable | Effect |
| --- | --- |
| `SHORTCUT_DEBUG=1` | Mirrors the renderer console into the terminal and opens DevTools |
| `SHORTCUT_SMOKE=<file.js>` | Evaluates that file in the live renderer, prints its return value, exits |
| `SHORTCUT_SHOT=<file.png>` | Used with `SHORTCUT_SMOKE`: also captures the window to a PNG |

There are twenty-eight suites:

- `tools/smoke.js` — timeline logic, no decoding involved.
- `tools/smoke-preview.js` — playback and compositing: verifies the preview never goes
  black inside a clip, across a cut, past the end of a short video stream, or after rapid
  scrubbing, and that real gaps *do* stay black. It needs `real1.mp4`/`real2.mp4` in
  `%TEMP%\scut_test` (its header comment gives the ffmpeg command).
- `tools/smoke-anim.js` — the keyframe engine (`Anim`): every easing preset anchored at
  both ends and finite throughout, track evaluation and its edge cases (no keys, one key,
  keys outside the clip's range, an unsorted track, two keys at the same time), that
  evaluating a track never reorders it, add/remove/move/retime, that `clip.keys` stays
  **absent** until something is keyed and is pruned away again when it is cleared, the
  property registry, that the clip inspector's strip is built entirely from it, and that
  `TextModel` re-exports the engine rather than carrying a second copy of it.
- `tools/smoke-mblur.js` — the shutter and the preset bar: that a soft drop shadow and a
  glow are *widened* by motion blur rather than eaten by it, that the result does not
  depend on the sample count, that strength still drives the spread, that averaging a
  constant is a no-op to within one 8-bit level (odd sample counts included) — and, for
  the preset bar, that the panel remembers which preset is selected across the rebuild an
  applied preset causes, that **Delete** therefore actually deletes, and that "Apply to
  selected cards" reaches every follower, never copies the wording, and is one undo entry.
- `tools/smoke-text.js` — text cards: easing, animation layers, keyframes, canvas
  painting, motion blur, presets and the render job shape.
- `tools/smoke-text2.js` — the second round of text work: motion-blur shutter clamping,
  glow-over-glyphs (including its preview/export parity), glow keyframes, per-unit
  typewriter effects, the typable controls and reset buttons, and the preset panel.
- `tools/smoke-textrender.js` — end to end: bakes a card, runs ffmpeg for real, reads the
  MP4 back to check the text is present and animating, and exercises the bake cache.
- `tools/smoke-range.js` — in/out marks, jobs cropped to a range (including a text card
  cut by the in point), ranged renders, and the cached-render bar going stale and coming
  back as content changes.
- `tools/smoke-input.js` — whether the controls can actually be clicked into and typed
  in, using REAL injected input (see below).
- `tools/smoke-typewriter.js` — typing in, typing out, both at once, sweep order, exit
  direction and the pop scale.
- `tools/smoke-track.js` — motion tracking: the pyramidal Lucas-Kanade kernel against a
  painted, anti-aliased translating square (sub-pixel accuracy over 24 frames, a genuine
  half-pixel shift read back as half a pixel, and a flat interior reporting low confidence
  rather than wandering), that an occlusion drops confidence and **holds** the last good
  position with no drift, that the Blob-built worker answers bit-for-bit what the
  in-process kernel answers, the data model (interpolation, the lower confidence of two
  neighbours, holding past both ends, pruning), that re-anchoring keeps the solved past to
  the sample and drops only the future, the binding through the clip's framing for all
  three bindable effect types plus the offset, that a bind to a deleted track degrades to
  the sliders rather than throwing, the panel, the lane's confidence strip, one undo entry
  for a whole solve, that **a soft button corner is followed exactly and reported
  confident** (the regression that split texture from fit), that a straight edge is
  correctly untrackable, that a drop snaps onto a real feature fast enough to run on a
  click, that placing a tracker does not solve it and dragging an unsolved one does not
  either, that a dead point is refused with a reason, the repairs (an interior span
  bridged, an edge span refused, a hand fix that keeps the solved future, repaired spans
  no longer counting as lost, and idempotence), follow strength and its keyframes,
  smoothing, cross-clip binding through the owner's framing with the clip offset in the
  key, and — the load-bearing one — that moving the clip does not change what
  the binding contributes to the render key while changing a sample does. It needs no
  fixture: every frame is painted by the suite.
- `tools/smoke-mockup.js` — the framing four: a device's layout at four presets, five
  source aspect ratios and four output shapes with no pixel painted, the spotlight mask's
  alpha (specifically that a corner is dark while the middle is not, which is the
  assertion an opaque black-and-white mask fails), the cutout's source-to-destination
  mapping, and that `chrome` then `background` and `background` then `chrome` give
  different pictures — so "the stack order is the feature" stays true.
- `tools/smoke-mask.js` — Magic Mask: prompt encoding (a scribble resampled along its own
  length with both ends kept and the count capped, and the **sign** carried through as a
  label), that a negative stroke genuinely cuts a same-coloured neighbour back out, the
  propagation loop following a shape it was shown on one frame only, that seeds are
  re-derived from the mask that moved and are taken from **inside** it even when its
  centroid is not, that a correction cuts the range into segments and each one decodes
  from its own anchor while an anchor named by two segments is decoded **once**, the matte
  edge operations and the order they run in, the unit rule measured at two plane sizes,
  the cache key (same on a moved, trimmed or re-framed clip; different on a changed
  stroke, resolution or engine; blind to the mask's id and name and to the order the
  strokes were painted), the render key (absent until something cuts with it, unchanged by
  a move, lost on an edit, absent again when the effect is bypassed), that a matte whose
  mask was deleted draws the clip **unmasked** rather than throwing, that the plate is
  built as transparency rather than black-and-white, and — when the model happens to be
  downloaded — MobileSAM itself: that it takes the square it was pointed at and not the
  identical one three squares over, and that a second prompt on the same frame is far
  cheaper than the first. It needs no fixture and no model.
- `tools/smoke-graphics.js` — the graphics engine: that each of the nineteen types paints
  **inside the bounds the baker crops to** and that those bounds are tight enough to be
  worth having (the assertion that stops an object being chopped off in the export only,
  where the preview paints the whole frame and never notices), a rect measured against the
  unit rule to the pixel, the same picture at 1x and 3x with a chart's *labels included*,
  the stagger being a delay per mark rather than a compression of the entry, the single
  chart scale over seven awkward series — a flat one, a zero one, a negative one, a
  nanometre one — with every tick inside the plot and every gridline's label distinct, the
  bar heights measured in ink against what the scale says, a diagram spec laying out
  identically across two runs and two resolutions (cycles, dangling edges and half-typed
  JSON included), the model's normalisation and that an unknown type is **kept** rather
  than lost, that a draw which throws costs a frame and not the session, that **every schema
  row in every type renders a control you can actually use** (the general form of a real
  bug: `text` was not a case `TextUI.control()` knew, so every single-line string row drew
  its label and no input at all, silently) and that a text row is wired both ways and takes
  one undo entry per gesture rather than per keystroke, the timeline
  (one undo entry, no decoder, and that a split does not leave two halves sharing one
  definition), the render job and that a graphic's `id` is not in its key while its
  definition is, that a lone graphic does not push its span off the fast path while an
  effect on it does, and — end to end — that a real ffmpeg render of a graphic lands on the
  pixels the preview canvas painted. It needs **no fixture**: every frame is painted by the
  suite.
- `tools/smoke-transitions.js` — transitions: finding cuts, the fast grab, length and
  alignment, all three types drawing correctly, the render job, an end-to-end ffmpeg
  render read back from the MP4, and presets.
- `tools/smoke-previewrender.js` — preview renders: that the file lands in the app cache
  and not the user's folders, that the **viewer actually decodes it** instead of
  compositing, that the source clips fall silent underneath it, and that the span and its
  player are dropped the moment its content changes.
- `tools/smoke-audiofx.js` — the per-clip audio chain: the filter string each effect
  emits, the sidechain wiring for ducking (including that a duck to the clip's own track
  is refused and that a lost voice track degrades rather than dangling a filter pad), both
  loudness passes, the chain surviving a save/reload, one undo removing a whole chain, the
  preview mix, and — the load-bearing one — that a clip with **no** effects still produces
  a byte-identical argument list to the one `buildArgs()` emitted before any of it existed.
- `tools/smoke-select.js` — window (marquee) selection and Close gaps: what a box catches
  in time and in tracks, that it extends to link groups and skips locked tracks, that a
  press which never moves is still a click, and for Close gaps that whole link groups
  move, that nothing outside the selection does, that overlapping groups are left alone,
  and that the pass is one undo entry — or none at all when there is no gap. It also
  covers Tighten over a genuine multi-selection.
- `tools/smoke-tighten.js` — Tighten: the real `silencedetect` handler over a fixture
  with two known silences (and its cache, including the noise floor being part of the
  key), the threshold/pad maths, the cut list, that picture and sound come out of a
  two-span cut in sync and still linked, that a clip outside the selection shifts but is
  never sliced, that a locked track is untouched, that one undo restores the timeline
  exactly, and that the settings sliders push no undo entry of their own. It needs
  `silence1.mp4` in `%TEMP%\scut_test` (its header comment gives the ffmpeg command).
- `tools/smoke-meter.js` — the loudness meter: the K-weighting coefficients against the
  published BS.1770 table, block loudness, the momentary/short-term windows, both gates on
  the integrated reading, and an end-to-end calibration that writes a 1 kHz tone, plays it
  through the real audio graph and checks the reading against a loudness predicted from
  the filters' frequency response (it *skips*, rather than fails, on a machine with no
  audio device).
- `tools/smoke-captions.js` — transcription and captions: the whisper JSON parser
  (sub-word tokens merged into words, special tokens dropped, a token-less segment spread
  across its span) and the SRT/VTT reader, phrase grouping against the word cap, the
  duration cap, a pause and a sentence ending, that every boundary is a word boundary and
  no two captions are on screen at once, safe-zone placement, keyword highlighting all the
  way down to the item `TextDraw.measure()` paints, generating onto the timeline (source →
  timeline mapping, words outside the clip left out, one undo entry, regenerating
  replacing rather than doubling, a hand-made card surviving it, and the cards
  serialising and reloading intact), the filler-word hook joining Tighten's own plan, and
  that a missing file fails cleanly. It needs **no fixture and no whisper.cpp**: the
  transcript goes in through `setTranscript()`, the same door "Import transcript" uses.
- `tools/smoke-layers.js` — real layers, including `fit: 'contain'` rendered for real and
  checked against the preview both where the still covers the frame and where it does not;
  plus a PNG importing as a `kind:'image'` clip on a
  video track with no in-point and no source-length ceiling, that it serialises and
  reloads intact, that the job lists layers bottom-up, that a still becomes a
  `-loop 1 -t <len> -i` input and every picture chain carries `format=yuva420p`, that the
  preview composites a 50%-alpha PNG over footage to the arithmetic blend, that an
  undecodable layer is skipped **without clearing what is below it**, that hiding a track
  drops it out of the composite, that a real ffmpeg render lands on the same sampled
  pixels as the preview canvas, that double-clicking a still in the bin puts it on the
  timeline at the playhead, and that one undo restores an image clip exactly. It needs
  `flat_blue.mp4` and `half_red.png` in `%TEMP%\scut_test` (its header gives the two
  ffmpeg commands).
- `tools/smoke-bakefirst.js` — bake-first rendering: that a plain clip still takes the
  fast path and still emits the same trim/crop/scale/overlay chain with no rawvideo input
  at all, that two stacked pictures (and, from step 7, any effect stack) disqualify a
  span while a transition window does not, that the bake produces one opaque full-frame
  layer appended last, that a clip wholly inside a bake span is dropped from the picture
  chain while a straddling one keeps its own, that the key taken before the bake still
  matches a job rebuilt after it, and — the headline — that a composited frame in a real
  ffmpeg render lands on the same pixels as the preview canvas. It also times both paths;
  the numbers below come from it. It reuses `smoke-layers.js`'s two fixtures.
- `tools/smoke-fx.js` — the per-clip effect stack: each effect's output over
  **transparency and over an opaque background** (the layer rule, asserted numerically),
  the grade LUT against the curve computed by hand and a neutral grade as a pixel-exact
  no-op, that a blur neither magnifies nor darkens the frame edge, that stack order
  changes the picture, that keys live on the effect so two blurs on one clip animate
  independently, that a four-effect stack paints the same picture at 1x and 4x
  (preview = render, stated as an assertion), the model's normalisation and JSON
  round-trip, the panel's one-undo-per-structural-edit, that an effect's `id` is not in
  the render cache key while its parameters are, that **no row is a drag source** and
  neither is anything inside one, that rolling a row up is pure UI - no undo entry, no
  dirty flag, nothing on the clip - and survives a rebuild, and for the per-effect
  shutter: that it prunes itself away when untouched but keeps settings the author
  changed, that strength and samples are clamped, that a static or single-keyed effect is
  refused it while a clock-reading one gets it for free, and that a swept moving effect
  really does come out softer at its edges while the effect beneath it stays sharp — and, end to end, that a graded clip
  comes out of a real ffmpeg render matching the preview canvas. Only the last section
  needs a fixture: `flat_blue.mp4`, shared with `smoke-layers.js`.
- `tools/smoke-bin.js` — the QuickBin (folders, importing, moving, deleting, and that it
  survives a new project), the audio waveforms (decode, slicing, the canvas on the lane),
  snapping (including the miss-beats-a-hit bug below), and the swipe's deform. It reads
  the user's real bin at the start and writes it back at the end - a run must not eat
  someone's library.
- `tools/smoke-recorder.js` — the screen recorder and its cursor telemetry: the sidecar
  shape and what a foreign JSON is rejected as, first-frame alignment (the pre-roll dropped,
  the last pre-roll position kept at `t=0`, a click before frame zero discarded), coordinate
  normalisation across display scales and across a second monitor, the click watcher's output
  parser, source-time lookups surviving a move, a trim and a split, telemetry staying out of
  the render job, the sidecar surviving save and reload — and, load-bearing for steps 9 and
  14, that a clip with **no** telemetry answers "none" everywhere rather than throwing. It
  ends with a real 2.5 s capture: the file, the sidecar, that the first frame is timestamped
  after Record was pressed, and that the recording imports with its telemetry attached. It
  reuses `clip1.mp4` from `smoke.js`, copying it rather than writing a sidecar next to the
  shared fixture, and *skips* the live capture on a machine that offers no display.
- `tools/smoke-longargs.js` — the command-line length ceiling: that a filtergraph too
  long for a Windows command line still **renders** rather than failing with
  `spawn ENAMETOOLONG`, that a short one is left inline so every other suite's assertions
  about the argument list still hold, and that the temporary graph file is deleted after
  the process closes. It drives the real spawn path, because the only honest way to test
  a limit the OS enforces is to hand the OS a command line over it. No fixture: the input
  is lavfi.
- `tools/smoke-cursor.js` — the screen-recording treatment: that smoothing a straight
  path returns it *exactly* (a filter that bends a straight line is bending everything
  else too) while a jittery one comes back five times calmer, that lag is a shift of the
  sample time rather than a frame-rate-dependent blend, that the source-to-frame map lands
  on the pixel `drawClipTo()` painted a marker on, ripple and click-punch timing against
  the click events, and — for the generator — minimum hold enforced on a deliberately
  jittery input, maximum zoom respected, the zoomed window never panned off the frame's
  own edge, a clip trimmed into the middle of a dwell opening already zoomed, and the
  headline: applying the generated transform puts the dwell in the middle of the frame.
  Then the generator's contract on a real clip — tagged keys, one undo entry, regenerating
  replacing rather than doubling, a hand-added key surviving it untouched, and the
  take's digest entering and leaving the render cache key with the effect that reads it,
  while screen telemetry stays out of it entirely. It also covers the on-render half:
  cutting one timeline-time take into per-clip source-time takes across a cut, that a
  performed pointer does **not** move when the clip is reframed while telemetry still
  does, each selection style painting something different, and — the one that caught a
  real bug — that `dim` darkens outside the box and leaves the inside opaque and
  untouched. **It needs no fixture and no recording**: every path is synthetic, which is
  exactly why the answers can be asserted to the last bit instead of approximately.

`tools/smoke.js` is a 26-assertion test of the timeline logic — import ordering, A/V
linking, split, ripple delete, undo/redo, trimming, the render job, and project
serialisation. It needs two clips in `%TEMP%\scut_test`:

```bash
node_modules/ffmpeg-static/ffmpeg.exe -f lavfi -i testsrc=size=1920x1080:rate=30:duration=3 -f lavfi -i sine=duration=3 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "%TEMP%/scut_test/clip1.mp4"
```

Then run it (bash):

```bash
SHORTCUT_SMOKE=tools/smoke.js node_modules/.bin/electron .
```

Because the script runs in the renderer's global scope, every top-level function in
`app.js` (`importPaths`, `splitAtPlayhead`, `buildJob`, `state`, ...) is directly callable
from it. That is the cheapest way to test a change without clicking through the UI.

`buildArgs()` lives in the main process while the suites run in the renderer, so
`window.api.buildArgs(job, opts)` bridges to it — it builds the argument list and runs
nothing. Like `sendInput`, it only answers while `SHORTCUT_SMOKE` is set. A test that
re-implemented the filter builder in order to check it would pass happily while the render
emitted something else entirely.

**Testing anything the user clicks or types needs REAL input.** A `MouseEvent` dispatched
from a script is untrusted: it fires listeners but never performs the default action, so
it cannot focus a field or type into one. A test built on those passes against a field
nobody can actually click into - which is precisely how a `user-select: none` inherited
into the inputs survived a "typing works" test. `window.api.sendInput({type, x, y, ...})`
goes through `webContents.sendInputEvent` and is trusted; it is only wired up while a
smoke script is running. `tools/smoke-input.js` uses it.

Note the scripts run in the *page's* scope, so a syntax error in your script reports only
as "Script failed to execute" — wrap the body in `try/catch` and return `e.stack` if you
need to see what went wrong.

**Run the suites one at a time.** They share the render cache, the text bake cache and
the QuickBin, so two electron instances racing each other produce failures that belong to
neither run — `smoke-textrender.js` reporting `cached=false` on a job it just rendered is
the usual symptom.

**A smoke run must never raise a modal, and there are two of them.** The main process's
unsaved-changes guard is one; the renderer's own `confirm('Discard unsaved changes?')` in
`newProject()` and `openProject()` is the other, and it is the one that bit hardest. Nine
suites call one of those two functions, and every suite dirties the project the moment it
imports a clip - so the run would sit on a blocking `confirm()` until something killed it,
having printed nothing. That is indistinguishable from a hang, and for a long time it was
diagnosed as one: slow suites, racing instances, orphaned electrons. `confirmDiscard()`
answers itself when `window.api.smoke` is set, and `smoke.js` asserts it - in the suite
every other one is built on, because a regression here would not fail, it would hang, and
a hang says nothing about which change caused it.

**A smoke run force-closes.** Every suite dirties the project the moment it imports a clip,
and the unsaved-changes guard on `win.on('close')` would then `preventDefault()` and open a
modal with nobody there to answer it — electron sat on that dialog until something killed
it, producing runs that hung past their timeout and wrote no output at all. `createWindow()`
sets `allowClose = true` before `app.quit()` on the smoke path, which is the "Don't save"
answer taken automatically. If you add a path that can block the quit, it has to be exempt
here too, or the suites will hang instead of failing.

### Layout

```
package.json
tools/smoke.js            timeline-logic test suite (see Testing above)
tools/smoke-preview.js    playback/compositing test suite
tools/smoke-layers.js     alpha compositing + stills-on-the-timeline test suite
tools/smoke-bakefirst.js  bake-first rendering: fast path, composite bake, parity
tools/smoke-fx.js         the per-clip effect stack: each effect, order, keys, parity
tools/smoke-recorder.js   the screen recorder: telemetry shape, alignment, degradation
tools/smoke-cursor.js     pointer treatment: smoothing, ripples, selections, auto-zoom,
                          take splitting and the two coordinate spaces
tools/smoke-track.js      motion tracking: the LK kernel, occlusion, re-anchoring,
                          the binding and what it may put in the render key
tools/smoke-graphics.js   the graphics engine: painted bounds, the unit rule at two
                          resolutions, stagger timing, the one chart scale, deterministic
                          diagram layout, and a real render matching the preview
tools/smoke-longargs.js   the command-line ceiling and the filtergraph script file
ShortCut.bat              launcher (installs deps on first run, then starts electron)
src/main.js               Electron main: media probing, folder scan, project IO, ffmpeg render
src/preload.js            contextBridge surface — the ONLY channel between main and renderer
src/renderer/index.html   DOM skeleton; every element the renderer touches has a stable id
                          three columns: #left (viewer only), #right (work area), #inspectorCol
src/renderer/styles.css   all styling; colors live in :root custom properties
src/renderer/app.js       the editor: state, timeline, preview, editing ops, shortcuts
src/renderer/anim.js      the keyframe engine: easing curves, tracks, the keyable registry
src/renderer/fx.js        the visual effect stack: one draw per type, no ffmpeg half
src/renderer/graphics.js  the graphics engine: kind:'graphic', one draw per type, the
                          chart scale and the deterministic diagram layout
src/renderer/cursor.js    pointer treatment, the pure half: smoothing, ripple timing,
                          the two coordinate spaces, take splitting, the auto-zoom
                          generator
src/renderer/track.js     motion tracking, the pure half: pyramidal Lucas-Kanade, the
                          track data model, and the source->frame binding map
src/renderer/track-worker.js  its message loop; concatenated onto track.js into one Blob
                          worker, so the kernel has exactly one source
src/renderer/text/model.js  text cards: defaults, animation layers, how they compose with keys
src/renderer/text/draw.js   text cards: all canvas painting (preview AND export)
src/renderer/text/ui.js     text cards: the editor panel
src/renderer/transitions.js transitions: every pixel of all three types (preview AND export)
src/renderer/waveform.js  audio peaks: decode once per file, draw a slice per clip
src/renderer/quickbin.js  the QuickBin: a media library kept in userData, not in the project
src/screen.js             screen telemetry: the sidecar shape, alignment, normalisation
                          (loaded twice, like audiofx.js - see "The screen recorder")
src/clickwatch.ps1        the click watcher: prints mouse-button transitions, one per line
src/recorder-preload.js   contextBridge for the recorder window - video bytes and nothing else
src/renderer/recorder.html + recorder.js   the hidden capture window (MediaRecorder)
src/captions.js           transcripts and captions: parsing, phrasing, placement, fillers
                          (loaded twice, like audiofx.js - see "Transcription and captions")
src/sfx.js                sound design: the triggers and the Sonify planner
                          (loaded twice, like audiofx.js - see "Sound design")
```

The text editor renders into `#textPanel` inside the inspector column. The three `text/`
files are plain `<script>` globals (`TextModel`, `TextDraw`, `TextUI`)
loaded before `app.js`; `anim.js` (`Anim`) is loaded before all of them, then `cursor.js`
(`Cursor`), `track.js` (`Tracker`), `fx.js` (`FX`) and `graphics.js` (`Graphics`) — in that
order, because every effect parameter reads its animated value through `Anim`, the pointer
effects read their geometry through `Cursor`, a bound effect reads its position through
`Tracker`, and a graphic reads its easing presets and its keyframes through `Anim` too. `TextUI` never touches `app.js` globals - it is wired up through
the hooks object passed to `TextUI.init()` near the bottom of `app.js`.

`app.js` is organised in ten numbered sections (search for `// ===`), in this order:
state, media elements, import, timeline rendering, timeline interaction, preview and
playback, editing operations, project IO, render, wiring and shortcuts.

### Screen layout

Three columns, set by the `#app` grid in `styles.css`:

| Column | Holds |
| --- | --- |
| `#left` — the left third | **The short itself and nothing else**: the preview canvas plus the transport strip. No settings panel may be added here; anything that would squeeze the viewer belongs in the inspector. |
| `#right` — the middle | Toolbar, ruler, timeline tracks, and the render/log footer. Gives up width when the inspector is widened. |
| `#inspectorCol` — the right | The QuickBin, framing, the clip inspector (which grows the graphic editor and the effect stack as the selection calls for them), the Captions and Sound design panels (both collapsed by default, because each is a pass over the whole edit rather than a per-clip control), and the text card editor (which appears only when exactly one text clip is selected). Resizable by dragging its left edge; the width lives in the `--insp-w` custom property. |

The left column's width is `minmax(320px, 33.333%)` and never changes with panel state.

### The data model

A project is one plain JSON object. `serialize()` in `app.js` writes it and
`openProject()` reads it back; `.scut` files are exactly this shape.

```js
{
  app: 'shortcut', version: 1,
  out: { w: 1080, h: 1920, fps: 30, quality: 'medium',
         loudness: { enabled, lufs, tp, lra } },   // the project's loudness target
  pxPerSec: 60,          // timeline zoom
  playhead: 0,
  tighten: { threshold, pad, noise },        // Tighten's settings - see below
  captions: { ... },                         // caption settings - see "Captions" below
  sfx: { level, minGap, maxTicks,            // sound design settings - see "Sound design"
         duck: {...}, triggers: {...} },
  tracks: [ Track, ... ] // index 0 is the TOPMOST track; video tracks sit above audio
}
```

```js
Track = {
  id, type: 'video' | 'audio', name,   // 'V1', 'A2', ...
  muted, hidden, locked,
  captions,                            // OPTIONAL - true on the one video track the
                                       //   caption generator owns. See "Captions"
  sfx,                                 // OPTIONAL - true on the one audio track Sonify
                                       //   owns. See "Sound design"
  clips: [ Clip, ... ]                 // kept sorted by start
}

Clip = {
  id, src,               // absolute path to the media file; null for text cards
  name, kind: 'video' | 'audio' | 'text' | 'image' | 'graphic',
  start,                 // position on the timeline, seconds
  in, out,               // source in/out points, seconds; length = out - in
  mediaDuration,         // full length of the source, the ceiling for `out`
  srcW, srcH, fps,
  panX, panY,            // 0..1 crop position within the source
  zoom,                  // 1 = the largest crop that fits the output aspect
  volume,                // 0..2
  afx,                   // audio clips only - the effect chain, see the audio chain below
  fx,                    // OPTIONAL - the visual effect stack, see "The effect stack";
                         //   absent until an effect is added
  linkId,                // clips sharing a linkId move and trim together (A/V sync)
  keys,                  // OPTIONAL - keyframe tracks, see "Keyframes" below; absent until used
  card,                  // text clips only - the whole card, see TextCard below
  graphic,               // graphic clips only - the whole object, { type, params, keys }.
                         //   See "The graphics engine"; plain JSON, exactly like `card`
  captions,              // generated captions only - { gen: true, src } - see below
  sfx,                   // SONIFIED sounds only - { gen: true, trigger, key }. The tag is
                         //   what makes re-running Sonify replace its own placements
                         //   instead of doubling them; a hand-placed sound has no `sfx`
                         //   and is never swept. See "Sound design" below
  fit,                   // OPTIONAL - 'contain' draws the WHOLE picture inside the frame
                         //   and leaves the rest transparent; absent means the default,
                         //   which fills the frame and crops. See "Framing"
  screen,                // OPTIONAL - screen-recording telemetry, { events, displayW,
                         //   displayH, clicks }. Absent for anything not recorded here;
                         //   see "The screen recorder" for the degradation contract
  tracks,                // OPTIONAL - solved motion tracks, [{ id, name, points, anchor }]
                         //   in SOURCE time and SOURCE fractions; absent until one is
                         //   dropped. See "Motion tracking"
  masks                  // OPTIONAL - Magic Mask PROMPTS, [{ id, name, res, rate, strokes }]
                         //   in SOURCE time and SOURCE fractions; absent until something
                         //   is painted. The MATTES are not here - they are tens of MB and
                         //   live in the disk cache. See "Magic Mask"
}
```

Invariants worth preserving when you change things:

- `0 <= in < out <= mediaDuration`, and clip length is always `out - in`.
- Importing a video **with** audio creates **two** clips — a video clip on V1 and an
  audio clip on A1 sharing a fresh `linkId`. Video clips never carry audio in preview or
  render; all sound comes from clips on audio tracks. This keeps preview and ffmpeg
  agreeing about what is audible.
- `state.tracks` is in display order, top first. Anything that cares about z-order
  (`buildJob`) reverses it so the bottom video track is drawn first.
- Text clips and graphic clips live on **video** tracks, so track order gives them their
  z-order for free. They have no `src` and never open a decoder; `in` stays 0 and their
  length is `out`. Anything that walks video clips must skip them, and the test for "this
  one is drawn by the renderer, not decoded" is **`isCanvasClip()`** rather than a
  hand-written `kind === 'text'` — `activeVideoClip()`, `syncMedia()`, the audio-chain
  target, Tighten's cutter and the clip keyframe panel all ask it. A third such kind would
  be one entry in `CANVAS_KINDS` rather than a sweep through `app.js`.

### Framing (16:9 → 9:16)

The crop is defined by `panX`/`panY`/`zoom` and computed **twice**, in two languages that
must stay in agreement:

- Preview: `drawClip()` in `app.js`, which now **delegates to `drawClipTo()`** at preview
  size rather than keeping a second copy of the crop — takes the largest source rect
  matching the output aspect, divides by `zoom`, offsets it by `pan * (source - crop)`.
- Render: the `crop=w='min(iw,ih*W/H)/zoom':...:x='(iw-ow)*panX'` filter built in
  `buildArgs()` in `main.js`.

**If you change one, change the other**, or the preview will lie about the output.

`drawClipTo()` has a second mode, and stills are why. `fit: 'contain'` fits the **whole**
picture inside the frame and leaves the rest transparent — `zoom` becomes its size and
`panX`/`panY` its position. A wide logo cropped to 9:16 is a detail of a logo, so a still
being placed rather than filling the frame needs this, and the **Size and position** panel
on an image clip is the front end for it. A contained still has transparency around it,
which ffmpeg's crop-and-fill chain cannot express, so it leaves the fast path and
composites — `clipNeedsBake()` says so, and `smoke-layers.js` renders one for real and
checks the preview and the file agree both where the still covers the frame and where it
does not.

This is now the *only* place the same picture is still described twice, and it survives on
purpose: it is the fast path (below), and it is exercised by every suite that renders. A
span that leaves the fast path is framed once, by `drawClipTo()`, for both the viewer and
the export.

### Render pipeline

**The renderer bakes the picture; ffmpeg encodes it.** That is the architecture as of
step 6, and it is what stops every visual feature having to be written twice — once as a
canvas draw and once as a matching ffmpeg filter. `compositeLayers()` in `app.js` is the
single draw path: `drawPreview()` calls it with the viewer's held layer surfaces, and
`bakeComposite()` calls it with freshly seeked media elements at output resolution, then
streams the RGBA into `frames.raw`. ffmpeg overlays that one layer.

`buildJob()` (renderer) flattens the timeline into a list of clips with absolute
timings and `visible` / `audible` flags. `bakeOverlays()` then bakes what has to be baked
— the composite first, then the canvas-drawn clips (text cards and graphics, through one
generic loop), then transitions — and `buildArgs()` (main) turns
the result into a single `ffmpeg` invocation:

- a `color=black` base of the full project duration;
- each visible video clip: `trim` → `setpts=PTS-STARTPTS+start/TB` → `crop` → `scale` →
  `fps`, then `overlay` onto the running base with `enable='between(t,start,end)'` and
  **`eof_action=repeat`** (see the note below);
- each baked composite span: one `-f rawvideo -pixel_format rgba` input, `setpts` to its
  position, then `scale` → `format=yuva420p` → `overlay`, appended **last** so it wins
  inside its own window;
- each audible clip: `atrim` → `asetpts` → `aformat` → **its own effect chain** →
  `volume` → `adelay`, then a single `amix`, optional loudness normalisation, and a
  limiter — see "The audio chain" below;
- x264 with a preset/CRF pair chosen by the quality setting.

Every clip occurrence becomes its own ffmpeg input, so the same file can appear many
times. That is simple and correct but costs one decoder per clip — if you need to render
hundreds of clips, batching by source file is the optimisation to reach for.

#### The command line has a ceiling, and big projects hit it

Windows caps a whole command line at 32767 UTF-16 code units, and `spawn()` reports going
over it as `ENAMETOOLONG` — which surfaces as *"Preview render failed: Error: spawn
ENAMETOOLONG"* and says nothing at all about the cause.

The cause is scale rather than a bug. Measured on the project that hit it — 156 clips, 85
of them text cards, a 29 s range at 540x960:

| | |
| --- | --- |
| argv entries | 545 |
| total characters | 28579 |
| `-filter_complex` alone | 17449 (61%) |
| inputs | 86, most of them baked rawvideo scratch paths |

Two things worth knowing from those numbers. **28579 is under the documented 32767 and was
still refused** — the limit counts the executable path, the quoting and escaping Node puts
around every argument, and the environment block, so the practical ceiling is meaningfully
lower than the documented one. And the filtergraph is most of the weight, because the
bake-first architecture gives every baked card its own input and its own overlay chain.

`ffmpegSpawn()` in `main.js` moves the graph into a file — `-filter_complex_script` — when
the arguments exceed `CMDLINE_BUDGET` (24000, deliberately not near the real limit). That
project now renders, at about 11000 characters.

It is applied **above the threshold only**, and that is deliberate: `buildArgs()` is
unchanged and still emits the graph inline, because three suites read that argument to
assert what each effect emits and `smoke-audiofx.js` asserts a clip with no effects
produces a *byte-identical* argument list to the one that shipped before the audio chain
existed. An ordinary render's command line is exactly what it always was, and
`shortcut-last-ffmpeg-args.txt` still reproduces it by hand either way.

The script file is deleted when the process closes, on the failure path too — one leaked
graph is harmless, one per render forever is not.

#### The fast path, and exactly what leaves it

Baking is not free — it costs a seek and a `getImageData` per frame — so a span that
ffmpeg can build *identically* and far faster still goes down the old chain. A span stays
on the fast path when **both** of these hold:

1. at most **one** picture clip (`kind:'video'` or `kind:'image'`) is visible across it;
2. **no** clip contributing to it carries a live effect (`FX.active(clip)` is empty).

Anything else bakes. In practice that means real alpha compositing — two or more pictures
stacked — or any effect at all. `clipNeedsBake()` asks `FX.active()` rather than reading
`clip.fx` itself, so a bypassed effect, or one of a type this build does not know, leaves
the clip on the fast path — and the answer it gives can never disagree with the answer
the draw path gives, because they are the same call.

Text cards, graphics and transitions do **not** disqualify a span, and that is not a
loophole. They are already drawn by one canvas implementation and baked from it, so the
reason for the fast path — far faster, pixels identical — applies to them word for word. A
card or a graphic is baked cropped to its painted bounds, which is a fraction of a full
frame; folding it into a full-frame composite would cost 20–100× the bytes for the same
picture. A graphic carrying an **effect** does disqualify its span, exactly as any other
clip does — `clipNeedsBake()` never asks what kind of clip it is looking at. A transition
additionally *owns* its window: its baked layer sits between tracks in the overlay chain,
while a composite layer is appended last and would cover it, so transition windows are
excluded from bake spans outright.

`compositeSpans()` works this out by cutting the range at every clip and transition edge —
between two edges the visible stack is constant, so one midpoint sample decides the whole
slice — and merging adjacent slices that agree. A clip whose whole visible extent falls
inside a bake span is then dropped from the picture chain, which is what makes baking a
saving rather than a surcharge: `buildArgs()` only opens an input for a clip that is still
visible or audible, so its decoder goes with it. A clip that *straddles* a span edge stays,
and draws its own chain outside the window the baked layer wins.

What it costs, measured by `tools/smoke-bakefirst.js` at 540×960, 30 fps, quality `fast`,
over three seconds of timeline:

| Path | Bake | Encode | Total |
| --- | --- | --- | --- |
| fast path only | 0 ms | 578 ms | **578 ms** |
| one of the three seconds composited | 3296 ms | 804 ms | **4100 ms** |

That is roughly 110 ms per composited frame, nearly all of it video seeks — which is why
the fast path exists and why it is worth keeping honest.

**The baked layer states its colour conversion.** The canvas hands over full-range RGB; a
decoded video arrives as limited-range BT.709 and stays that way through `format=yuva420p`.
Letting swscale guess put a flat blend eleven 8-bit levels greener than the same blend in
the preview — the exact preview/export drift step 6 exists to end — so the baked chain
carries `in_range=full:out_range=tv:out_color_matrix=bt709` explicitly. With it, the
render and the preview agree to within two levels.

**Frames stay raw, never PNG.** PNG-encoding a large alpha-heavy frame costs 100–1500 ms
against about 4 ms for `getImageData`; that one line once turned a four second title card
into a ten minute render. The bake cache rules are unchanged too: a clip's position on the
timeline is **not** in the key (`jobCacheKey`), and the key is taken **before** baking —
after it, each layer has a randomly named scratch dir, so a key computed then could never
hit. `jobKey()` in main refuses to cache a job carrying a `text` or `baked` clip that
arrives without one, rather than filing it under a key that would collide or never match.

**Do not change `eof_action=repeat` back to `pass`.** A clip's length comes from the
container duration, which frequently outruns the actual video stream — a file can hold
2.5 s of picture in a 2.9 s container when its audio track is longer, or when the last
frame is short. With `pass`, that overrun punched straight through to the black base and
produced visible black frames at the tail of *every* clip. `repeat` holds the clip's last
decoded frame instead, and `enable` still switches the overlay off cleanly outside the
clip's window, so genuine gaps between clips stay black. `tools/smoke-preview.js` and the
timings in `r3()` (microseconds, not milliseconds — millisecond rounding was enough to
open sub-frame gaps) both exist to defend this.

Progress is scraped from ffmpeg's `time=` on stderr and pushed over `render:progress`.
The exact argument list of the last render is written to
`%TEMP%\shortcut-last-ffmpeg-args.txt` — paste it after `ffmpeg` to reproduce a failure
by hand.

Output presets are the four `<option>`s on `#preset` in `index.html`; quality presets are
the `presets` map in `buildArgs()`. Both are one-line additions.

### The effect stack

`src/renderer/fx.js` is the visual effect engine, a plain `<script>` global called `FX`
loaded after `anim.js`. A clip's stack lives on `clip.fx`:

```js
clip.fx = [ { id, type, enabled, params: {...}, keys: {...} }, ... ]   // absent until used
```

Plain JSON, ordered, and **absent by default** — `FX.normalizeClip()` deletes the array
again once the last effect goes, so a project that uses no effects serialises exactly as
it did before this existed.

Thirteen types ship so far, and each one is **one function**:

| Type | What it draws |
| --- | --- |
| `transform` | offset, scale, rotation, opacity, about a movable anchor point |
| `round` | rounded corners and a drop shadow that follows them |
| `inset` | crops the layer in from any edge, to transparency |
| `blur` | a padded, non-magnifying gaussian |
| `grade` | lift / gamma / gain, saturation, contrast, temperature |
| `cursor` | a smoothed pointer, drawn from a performed mouse take |
| `ripple` | an expanding ring at each performed mouse-down |
| `select` | an animated window-selection box: brackets, marquee, outline, dim outside |
| `chrome` | the clip drawn inside a browser, laptop or phone frame |
| `background` | a gradient, a solid or a blurred copy of the clip, drawn behind it |
| `spotlight` | darken and blur everything outside a rounded rect or an ellipse |
| `cutout` | a region lifted out, scaled up and floated with its own shadow |
| `matte` | the clip cut to a painted Magic Mask, with feather, grow/choke and invert |

Adding a type is one entry in `FX.DEFS` — its label, its default parameters, its
inspector schema and its `draw()`. The panel, the keyframe strips, the serialisation, the
normalisation and the "add an effect" menu all build themselves from that entry.

`draw(L, p, t, entry, clip)` takes the clip as its fifth argument, and exactly two effects
use it: `cursor` and `ripple` read the performed take on `clip.mouse`, which lives on the
clip and could never be a parameter — it is thousands of samples. **Nothing else may reach
for it.** An effect that read `clip.start` from there would be putting a clip's timeline
position into its own pixels, which is the one thing the render cache's key rules forbid.

The layer's `L.base()` is the only other way past an effect's own parameters, and exactly
one effect uses it: `background`'s blurred-copy mode. See "The framing four" below.

There is a third and last one, and it is an injection rather than a reach: `matte` asks
`FX.setMatteProvider()` for a plate. The pixels of a matte are a neural network's output
over a decoded frame, so they are neither synchronous nor anything `fx.js` could get to —
it would need the media element, a disk cache, the clip's framing and an IPC round trip.
So `app.js` installs a provider, hands back a canvas whose alpha is the matte, and takes on
the matching duty of putting the prompts into the render key. Exactly the arrangement
`setBinder()` already had, for exactly the same reason. See "Magic Mask".

#### Binding a position to a motion track

Three types carry a `bind` descriptor — `transform`, `spotlight` and `cutout` — and an
entry may therefore hold `bind: { track, offX, offY }`, plain JSON like everything else.
`paramsAt()` resolves it **after** the keyframes and writes the positional parameters
itself, which is why a bound position ignores its own sliders and keys while everything
else on the effect keeps animating. See "Motion tracking" for what each type does with the
point — they are deliberately three different answers, and `FX.boundParams()` derives which
parameters each one takes over by *running* its `apply()` rather than by listing them a
second time.

`DEFS[type].needs` names what a clip has to be carrying for the effect to have anything to
draw — `'mouse'` for the two pointer effects, absent for everything else. The panel greys
those entries out in the "add an effect" menu on a clip with no take **and says why**, and
an effect already on such a clip carries a warning line. Both were missing when the two
effects first shipped, and the result was an effect you could add to any clip that then
drew nothing in silence. `select` deliberately has no `needs`: a selection box is
authorable by hand on a clip nobody ever performed over.

#### One implementation, because step 6 earned it

Before step 6, every visual feature had to be written twice — a canvas draw for the
preview and a matching ffmpeg filter for the export — and the README said so in three
places because the two kept drifting. Step 6 made `compositeLayers()` the single draw path
for the picture. So there is **no ffmpeg half of an effect**, and adding one would be a
bug: `buildArgs()` never sees `clip.fx` do anything, because the baker has already drawn
it by the time main runs.

That is also why any effect at all takes a span off the fast path. There is nothing for
ffmpeg to fall back on — a clip carrying an effect must be baked, or the export simply
would not have it. See "The fast path, and exactly what leaves it".

#### The framing four, and why order is the whole feature

`chrome`, `background`, `spotlight` and `cutout` are one shape wearing four hats:
something drawn **around** the footage, **behind** it, **over** it, or **lifted out** of
it. They are ordinary `DEFS` entries, so the panel, the keyframe strips, the shutter and
the serialisation all arrived with them and none of it is written twice — which is what
step 7's container was for. Every parameter keyframes through `Anim`, which is what lets
a spotlight follow a feature down a scrolling page.

Two of the four only have anything to do once the layer has transparency in it:
`background` paints into it and `chrome` is what makes it. So **the stack order is the
feature, not a detail of it**. Chrome then background is a framed shot floating on a
gradient; background then chrome is a gradient the chrome immediately covers up. There is
deliberately **no auto-ordering** — the arrows on each row are the control, and
`smoke-mockup.js` asserts both orders give different pictures so that stays true.

The presets are **numbers and colours, never bitmaps**. `FX.CHROME` holds four — browser
light, browser dark, laptop, phone — and every length in one is expressed in *screen
widths*, so a preset is a shape rather than a size. `chromeGeom()` assembles the device at
its natural proportions and scales the whole thing by a single factor to fit whatever room
`pad` leaves, which is why the parts cannot drift out of proportion at an extreme aspect
ratio. A 1x bitmap frame would have been sharp in the 540x960 viewer and soft in the
1080x1920 file, which is the one thing this file exists to prevent.

`chromeGeom()`, `cutoutRect()` and `spotRect()` are the only things that compute geometry,
and they are exported for that reason: `smoke-mockup.js` checks a device's layout at four
presets, five aspect ratios and four output shapes without painting a pixel, so a layout
bug and a paint bug can never be mistaken for each other.

**Masks composite on the ALPHA channel.** This codebase has now hit that three times. A
mask painted as opaque black-and-white is opaque *everywhere*, so `destination-in` keeps
everything and the mask masks nothing — and the symptom is not an error, it is a spotlight
that lights the whole frame. The fill is `rgba(255,255,255,1)` and the feather is a blur of
**that alpha**, falling away to `rgba(255,255,255,0)`; a fade towards black would look
right on a white plate and mask nothing. `smoke-mockup.js` asserts specifically that a
corner is dark while the middle is not, which is the assertion an opaque mask fails.

`spotlight` and `cutout` darken with `source-atop` rather than a plain fill, so a layer
that is already partly transparent — anything downstream of `chrome` or `inset` — does not
get black painted into its empty half. Every blur goes through `padBlur()` at 1:1, so none
of them magnifies; `background`'s blurred-copy mode is the one place in the file that
magnifies **on purpose**, and even there the zoom and the softening are separate steps so
the radius still means the same thing at both resolutions.

`background`'s blurred copy is a copy of **the clip**, not of the layer, and that needed a
second way into the effect. `FX.render()` hands each effect an `L.base()` — the clip as
painted, before anything in the stack touched it, built on first ask and never otherwise.
By the time a background runs, `chrome` may have taken a device-shaped bite out of the
layer, and a blurred copy of a hole is not what the mode says on the tin. It is the clip's
own pixels and nothing else — no timeline position, no neighbours — so it stays inside the
cache key rules exactly as `paint` does. Alongside the `clip` argument and the injected matte
provider that is now **three** things an effect may reach for beyond its own parameters,
and there are no others.

#### The unit rule: fractions of the frame, never pixels

Every length in `fx.js` is a fraction of the frame; `pxMin(f, W, H)` turns it into pixels
against whatever size is being painted. The preview paints at 540x960 or smaller and the
export at 1080x1920, so a "12 px" corner radius would be twice as round in the viewer as
in the file, and a "20 px" blur twice as soft. **Anything added here that takes a length
must go through `pxMin()`.** `smoke-fx.js` paints a four-effect stack at 135x240 and at
540x960 and asserts the two agree to within 12 levels of 255 — which is preview/render
parity for this file, stated as one test. It currently measures **0**.

`pxMin()` is necessary but not sufficient, and `round` is how that was learned. A
*proportional* geometry can still break parity if it makes the engine **resample**: a
non-integer scale puts content edges at different sub-pixel phases at the two sizes, and a
later `transform` amplifies the difference into something visible. Clipping is exact;
scaling is not. Prefer a clip whenever the effect has the choice.

#### The layer rule, inherited from the text cards

Every effect runs inside the clip's **own offscreen layer**, cleared to transparent, and
only the finished layer is drawn onto the frame. `FX.render()` is the only way in, and it
enforces this. It is not tidiness: a drop shadow, a blur or any additive pass composited
straight onto the target would pick up whatever is underneath it, so the same effect would
behave one way over video and another way over transparency. `smoke-fx.js` asserts it
numerically — a shadowed, rounded layer drawn over blue must equal that same layer
composited over blue arithmetically, and it does, exactly.

A clip with **no** effects skips all of this: `FX.render()` hands the target straight to
the painter and allocates nothing, so the compositing loop stays the single `drawImage`
it has always been.

#### Keyframes live on the effect

`Anim.trackFor()` and `Anim.valueAt()` only ever touch a `.keys` object, so an `fx` entry
is a keyframe holder exactly as a clip is. Every numeric parameter is therefore keyframable
with no extra work — `FX.paramAt()` reads the animated value and falls back to the
static one — and two blurs on one clip animate independently. Keys are times in
**seconds into the clip**, the same axis a text card's keys use, so moving a clip moves its
animation with it. See "Keyframes" above for why they are not on `clip.keys`.

#### Order matters, and the arrows are how you change it

The stack draws in array order, and the order is part of the picture: blur after grade is
not blur before grade, because a grade lifts what a blur has already averaged together.
The ▲▼ buttons on each row move it.

**Nothing in the panel is an HTML5 drag source, and that is deliberate.** The rows used to
be draggable for reordering, and in Chromium a draggable ancestor starts a native drag
from a press anywhere inside it — so every attempt to drag a *slider* tore the whole row
out as a drag image and the value never moved. Exempting the body fixed the sliders and
left a drag affordance that was still easy to trigger by accident on the row's own
padding, in a panel whose entire purpose is dragging values. The arrows already did the
job, they are the only route a keyboard or a smoke suite has, and they cannot be triggered
by accident — so the drag is gone rather than defended, and `smoke-fx.js` asserts it stays
gone.

#### Rows roll up

Each row has a caret, the title toggles it too, and a stack of more than one gets
**Collapse all** / **Expand all** in the panel header. A rolled-up row still reports what
it is doing — `bypassed`, `keyed`, `blur`, or the name of the generator that made it —
because a stack of identical-looking closed rows is a worse list than an open one.

Collapse state lives in `fxCollapsed`, a module-level `Set` keyed by effect id, and
**never on the clip**. Undo is `JSON.stringify` of the track list and the same shape is
the `.scut` file: a rolled-up row is not a fact about the edit, and putting it on the
effect would mean tidying the panel dirtied the project and showed up as a change in every
undo snapshot. Rolling a row up therefore pushes no undo entry, sets no dirty flag and
does not redraw the picture — `smoke-fx.js` asserts all three.

#### Motion blur, per effect

Any effect can carry a shutter: `fx.mblur = {on, strength, samples}`, absent by default and
pruned away again when it is off and untouched, exactly like `keys`. It sweeps **that one
effect** across the shutter and averages the results through `Anim.temporalAverage()` —
the same averaging text cards, transition objects and the swipe's plate go through, and
for the same reason: the naive `lighter`-at-`1/n` accumulator quantises every faint pixel
to zero and annihilates precisely the soft things a blur exists to smear.

The layer is copied **once** before the sweep and each sample is that copy with the effect
applied at its own instant. That is what makes it the blur of the effect rather than a
blur of everything beneath it: an effect earlier in the stack has already painted into the
copy, comes through every sample identically, and averages to itself — so it stays sharp
while the one above it smears.

`FX.timeVarying()` refuses the shutter for an effect that cannot paint differently across
it — a static grade sampled eight times is the same grade eight times, and blurring it
would cost eight passes over eight million pixels to produce a pixel-identical frame. Only
two things qualify an effect: **more than one key** on some parameter, or a `draw()` that
reads the clock itself (`cursor`, `ripple`, `select` are flagged `timeVarying`). The panel
says so on the row rather than leaving a switch that quietly does nothing.

It is the most expensive control in the panel — `samples` extra passes of that effect,
every frame, in the preview and in the bake alike — so it is off by default and the hint
says what it costs.

#### Two rules the panel keeps

- A structural edit — add, remove, reorder, bypass — is **one** `pushUndo()` and a
  full `renderAll()`. Parameter edits go through the clip inspector's own once-per-gesture
  guard (`inspectorEdit` / `inspectorEditEnd` in `app.js`), which exists because
  `TextUI.control()`'s built-in guard is bound to the *text* panel's hooks: a panel that
  passes its own hooks replaces the guard along with them, and a burst of wheel-nudging
  then pushed one undo entry per notch. `clipKeyPanel()` had that bug and now shares the
  guard.
- The panel uses `fx-*` classes, **not** the audio chain's `afx-*` ones, even though the
  two look alike. `#inspector .afx-box` is how three suites find the audio chain, and a
  visual panel answering to that selector made them find the wrong one.
- **Nothing is a drag source.** See "Order matters, and the arrows are how you change it"
  below for why drag-to-reorder was removed rather than defended.

#### What does not get a stack, and where effects do not apply

Effects are offered on `kind:'video'`, `kind:'image'` and `kind:'graphic'` — everything
except a **text card**. A card already owns a transform, an opacity, a rotation, a glow and
a drop shadow in its own model, with its own keyframes and its own presets, so a second
competing `transform` beside all of that would be a coin toss for the author every time;
and `#textPanel` shares a scrolling column with `#inspector`, so a stack panel above it
pushes the card editor off the bottom of the screen the moment a card is selected.
`compositeLayers()` still runs a stack for any layer carrying one, text included.

A graphic is the opposite case to a card, which is why it is in the set. Its own model
holds **shape** — a radius, a series of values, a diagram spec — and deliberately no
transform, no rotation and no anchor, so `transform` is the one place a graphic is moved.
That is not tidiness: a `transform` effect is the thing that carries a motion-track
`bind`, so putting position in the effect rather than in the graphic is what makes "this
callout sticks to that moving button" free, instead of a second binding implementation
living in `graphics.js`.

**Effects do not apply inside a transition window.** A transition owns its frame in both
the preview (`drawTransitionFrame()`) and the render (transition windows are excluded from
bake spans outright — see the fast path), and neither path is effect-aware. The two
agree with each other, which is the invariant that matters, but the effect is simply not
there for the length of the window. The panel says so on screen.

#### The render cache

`jobCacheKey()` hashes the whole job, and `buildJob()` carries `clip.fx` onto the job entry
for one reason: a composited span's pixels depend on every effect on every clip under it,
and leaving the stack out would mean turning up a blur hit the cached render of the old
picture. The key strips each effect's `id` on the way in, for the same reason it strips a
clip's — an id is identity handed out by `FX.create()`, not pixels, and leaving it in
would mean two clips wearing the same grade never shared a cached render, and deleting an
effect and adding an identical one back missed its own cache.

### The audio chain

Every audio clip carries an ordered effect chain in `clip.afx`:

```js
afx: [ { id, type, enabled, params: { ... } }, ... ]
```

Plain JSON and nothing else, because undo is `JSON.stringify` of the track list and the
same shape is the `.scut` file. Six types, all defined in one place — `AudioFX.DEFS` in
`src/audiofx.js`:

| Type | Becomes | Notes |
| --- | --- | --- |
| `denoise` | `afftdn` | reduction and noise floor, both in dB |
| `eq` | three `equalizer` bands | low / mid / high, each frequency + gain + Q |
| `deesser` | `deesser` | intensity, max reduction, frequency |
| `compressor` | `acompressor` | **UI in dB, filter in linear** — the conversion is in `DEFS` |
| `gain` | `volume=<n>dB` | the one effect the preview honours exactly |
| `duck` | `sidechaincompress` | two inputs, so it is wired up by `buildArgs()`, not by `chain()` |

`src/audiofx.js` is loaded **twice** — as a `<script>` global in `index.html` (like
`TextModel` and `Trans`) and as a CommonJS module by `main.js`. That is deliberate: the
inspector, the preview mix and the ffmpeg filter string all read the same definition, so
there is no second place for them to drift apart. Adding an effect type is one entry in
`DEFS`, and the inspector builds its controls from that entry's `schema` through the same
`TextUI.control` rows the text panel uses.

Order in a clip's chain is order in the filter graph, and it matters — a compressor before
a gain is not a compressor after one. The chain sits after `aformat` and before the clip's
own `volume` and `adelay`, so clip volume is still the last word on level.

**Everything here is opt-in.** A clip with an empty `afx` contributes nothing to the
filter string, and `buildArgs()` emits a byte-identical argument list to the one it emitted
before any of this existed. `tools/smoke-audiofx.js` asserts exactly that, and it is the
assertion to keep working.

#### Ducking

`duck` names a **track**, not a clip: music ducks under the whole voice-over, across every
cut in it. Because an ffmpeg filter output pad may only be consumed once, the voice cannot
simply be read twice — `buildAudioGraph()` splits each contributing voice stream with
`asplit`, mixes the halves into a `duckbusN`, splits *that* again if several clips duck to
the same track, and feeds each ducked clip through `sidechaincompress`.

`sidechaincompress` is not symmetric: it compresses its **first** input by the level of its
second. Swapped, the music would gate the voice.

Three ways a duck degrades rather than breaking the render, all tested:

- a duck pointed at the clip's **own** track is dropped — otherwise it would compress the
  clip against whatever happens to sit next to it, which is not what ducking means. The
  inspector leaves the clip's own track out of the list for the same reason;
- a duck pointed at a track with nothing audible on it (muted, or emptied) is dropped
  rather than leaving a filter pad with no producer;
- an effect type this build does not know is dropped by `AudioFX.normalizeClip()` on load.

#### Loudness

`state.out.loudness` is a project-level target for the finished mix — `{ enabled, lufs,
tp, lra }`, the Loudness row in the render panel, applied as `loudnorm` to the final
`amix`. It is **off by default**, so an existing project renders exactly as it did before.

It is genuinely two-pass. Single-pass `loudnorm` is a dynamic estimator: it moves the gain
as it goes and can pump on a mix whose level changes. So `render:start` runs
`measureLoudness()` first — `buildArgs(job, { measureLoudness: true })`, which builds the
same audio graph, decodes **no video**, and writes to `-f null -` with
`print_format=json`. Those measurements go back into pass two along with `linear=true`,
turning the result into one exact gain move. A draft render skips pass one; close enough,
and it does not double the decode.

Two things to keep straight:

- pass one runs **after** the render cache key has been taken. The measurements are
  derived from the job, not part of it — the renderer computes the same key for the cache
  bar and has never seen them, so keying them would give identical content two keys.
- `loudnorm` resamples internally, so `aresample=48000` goes after it to put the rate back
  where the rest of the graph expects it.

Failure in pass one is never fatal: no measurements simply means the single pass. It must
not cost the export. Cancelling pass one, however, cancels the render.

#### One chain over several clips

A multi-selection — which is what a track head produces — has as many chains in it as it
has audio clips. The panel edits the **first** and mirrors the whole `afx` array onto the
rest, structural edits, parameter moves and applied presets alike.

The whole array is copied rather than diffed (which is what the text panel does) because a
chain carries no per-clip content: it is pure processing, so "these clips share this chain"
is the only thing editing several at once could sensibly mean. It is deep-cloned per clip,
so they do not end up sharing one array — undo could not tell them apart if they did.

#### Editing the chain from the video half

Importing a file with sound makes two clips, and the one people click is the **video**
one — it is the half with a picture on it. So `audioFxTarget()` resolves a selection to
the clip an audio chain belongs to: an audio clip is itself, a video clip with a `linkId`
is its linked audio clip, and anything else (a text card, an unlinked video clip) has no
chain to edit and gets no panel.

When the panel opens through a link it says so — *"Editing the linked audio clip on A1"*.
Quietly editing something other than the clip the user selected is the kind of thing that
gets blamed on the app three weeks later.

**A link group is ONE selection, not a multi-selection.** Clicking any clip selects its
whole link group, so an imported video with sound *always* reaches `renderInspector()` as
two clips. The old `sel.length > 1` bail-out therefore fired on the commonest selection in
the app and replaced the entire inspector — framing, volume and audio effects alike — with
"2 clips selected."; `singleUnit()` now collapses a shared-`linkId` selection to its video
half, which is the one carrying the framing, the dimensions and the name.

The lesson for tests: `setSelection([videoClip.id])` is a state the UI **cannot produce**.
The suite asserted against it and passed while the feature was unreachable by mouse.
`tools/smoke-audiofx.js` now selects through `linkGroup()` the way the lane handler does,
and asserts the inspector is not showing the multi-selection message.

#### The loudness meter

`meterLayout(H)` decides where the two bars and the dB scale go, and it derives every row
from the height it is actually given. That is not tidiness. The layout used to be
constants — rows at 16 and 42 with the scale pinned to `H - 4` — which needs about 70 px,
and the canvas is a flex child of a fixed-height panel, so its height is whatever is left
over. When the panel got tight the constants drew the loudness bar straight through the dB
scale with the "LUFS" label running underneath it. Nothing clipped and nothing errored; it
just became unreadable, which is the failure a fixed layout in a flexible box always has.

Below about 46 px two bars and a 12 px gap stop fitting, and the **gap** gives way first,
down to the 4 px the target sign needs — the bar carries its own label, so it is the thing
that has to stay legible. The left gutter is measured from the width of the widest label
rather than assumed, for the same reason: "LUFS" at 9 px is about 24 px wide and the gutter
was 26, so one font fallback wider put the label under the bar.

`smoke-meter.js` asserts the invariants at every height from 40 to 160 — bars never
overlap, never run into the scale, never get thinner than their own text. Raising the CSS
`min-height` instead was tried and rejected: it pushed the note out of the fixed-height
panel and the suite caught that too. The budget is zero-sum, so the layout bends rather
than the box.

The footer carries a live meter of the **preview mix**, next to the render panel. Two
scales, because they answer different questions and routinely disagree — a heavily
compressed mix can sit 3 dB off clipping and still be 6 LU under target:

- **PK** — sample peak in dBFS, with a 2 s hold mark that turns red at 0.
- **LUFS** — short-term loudness, with three signs on it: a ▼ at the project's loudness
  target, a green band for ±1 LU either side of it, a thin white line for momentary, and a
  gold line for **integrated** — the number the render is actually judged on.

`M`, `S`, `I` and `Peak` are printed under the bars. `Reset` restarts the integrated
reading; it is a *programme* measurement, so it means "start the programme again".

The maths is ITU-R BS.1770-4 / EBU R 128 and lives in `src/renderer/meter.js` as `Meter`.
It is deliberately pure — no `AudioContext`, no canvas, no DOM — because that is what
makes it testable without playing a sample. The split across three files is the point:

| File | Job |
| --- | --- |
| `meter.js` | the maths: K-weighting coefficients, block loudness, the windows, the gates |
| `meter-worklet.js` | on the audio thread: sum of squares and peak, per 100 ms block |
| `app.js` | the plumbing (`startMeter`) and the drawing (`drawMeter`) |

The signal path, and every part of it matters:

```
clip gains -> master -> destination            (what you hear)
                    -> K-weight IIR x2 -> worklet input 0   (loudness)
                    -> worklet input 1                      (peak)
```

Three things that are easy to get wrong here:

- **Loudness is measured K-weighted, peak is not.** The weighting curve is not flat, so a
  peak read off the weighted signal is several dB out. Hence two worklet inputs.
- **The coefficients are derived, not copied.** BS.1770 tabulates them for 48 kHz only;
  `kWeighting()` computes them from the analog prototype so any sample rate works, and
  48 kHz reproduces the published table exactly — `tools/smoke-meter.js` asserts that.
- **Integrated is doubly gated**, and the order matters: drop everything under -70 LUFS
  (absolute), take the mean of what is left, then drop everything more than 10 LU under
  *that* (relative). The result is the loudness of the mean **energy** of the survivors,
  not the mean of the loudness values, which is a different and wrong number. Skipping
  the gates is what makes a meter read several LU low on anything with a quiet passage
  in it.

Measured against ffmpeg's own `ebur128` on the same tone, this meter agrees to within
0.01 LU, and `smoke-meter.js` keeps it honest by predicting the reading from the filters'
frequency response and playing a generated tone through the real graph.

The meter is metering the **preview**, which mirrors level and mute but not the DSP — so
it tells you what the mix balance is doing, not what `loudnorm` will finally deliver. The
render's own two-pass measurement is the authority on that. Everything about it is
best-effort: an AudioWorklet that will not load costs the meter and nothing else, because
`master -> destination` is wired up before any of it runs.

#### What the preview actually does

The preview is **not** a DSP engine, and the inspector says so where the controls are.

What it mirrors is level and mute — `AudioFX.previewGain()`, which is the clip's volume
times every enabled `gain` effect. That is what you need while cutting: the balance
between voice and music. Denoise, EQ, de-ess, compression, ducking and loudness are all
applied at render time only.

The level goes through a WebAudio gain node per clip, because `el.volume` is capped at 1
and a +6 dB gain effect could not otherwise be heard at all. Two traps that shaped it:

- routing an element through a **suspended** `AudioContext` silences it outright, and a
  context created before any user gesture starts suspended. So the node is only attached
  once the context is actually running (pressing play is the gesture that starts it);
  until then the element's own clamped volume is used. Worst case is "a boost is quieter
  than it should be", never "the preview went silent";
- `createMediaElementSource` cannot be undone, so `dropMedia()` disconnects the node with
  the element.

This is the one place in the app where preview and render deliberately disagree, and it is
the reason the panel carries a line of text saying so - and the reason the loudness meter
above reads the preview mix rather than claiming to predict the export.

**Everything audible goes through the master bus**, including a rendered span's player.
Inside a rendered span the viewer plays a finished MP4 rather than compositing, and that
file's audio *is* the mix - but it used to reach the speakers directly, so the loudness
meter went dead the moment the playhead crossed into a rendered band and came back to life
on the way out. `previewBandNode()` routes each span's element through the same
`createMediaElementSource -> gain -> master` path a clip's audio takes, under the same two
rules: only while the context is running, and the node is dropped with the element,
because `createMediaElementSource` cannot be undone.

### Sound design (SFX and Sonify)

The rule is "if something appears on screen, it should make a sound". That is a rule an
editor can execute, so it is a rule the app executes: **Sonify** walks the timeline,
finds the moments, and places a sound at each one.

The load-bearing decision is that **every placement is an ordinary audio clip**. Nothing
here is a hidden effect: a sonified project is a project with more clips on an audio
track, and those clips move, trim, retime, mute, delete and render through exactly the
audio chain step 1 built. There is no second render path, so preview and export cannot
drift — a placed sound is mixed by `syncMedia()` in the viewer and by `buildArgs()` in
ffmpeg, the same way a music bed is.

`src/sfx.js` is loaded **twice**, like `audiofx.js` and `screen.js`: as a `<script>`
global `SFX` in `index.html`, and as a CommonJS module by `main.js`, so the triggers and
the planner have exactly one definition.

#### The library ships empty

Nothing is bundled and nothing is synthesised. The sounds a channel uses are its own, so
there is no download, no first-run write, and no house set to grow out of — which also
means a fresh project is **silent until sounds are imported and each trigger is pointed
at one**, and every part of the feature has to read well in that state rather than look
broken. A trigger with no sound plans nothing; the panel says which triggers are still
unset, and `SFX.armed()` is the one answer to "would this place anything".

Sounds arrive through three doors, all of which land in `addSfx()` in main:

| Door | What it takes |
| --- | --- |
| **+ Files** | One or more audio files |
| **+ Folder** | A folder, walked recursively; non-audio is ignored |
| **From bin** | Whatever audio the QuickBin has selected — a selected bin folder means everything in it |

Nothing is copied. `sfx.json` in userData holds a path, a name, a duration and a category
(the containing folder's name) per entry, exactly as a QuickBin item does. **The path is
the id**: a sound is named by a trigger and by every clip placed from it, and a path is
the one name that means the same thing in both. A file that has moved comes back
`missing`, so the row greys out and the trigger still shows what it was pointed at —
fixable, rather than silently swapped for something else. Removing an entry removes it
from that list and **deletes nothing from disk**, which is the QuickBin's contract for the
same reason: the app never owned the file.

#### The five triggers

One entry each in `SFX.TRIGGERS`, and the panel and the planner both build themselves
from that table — adding a sixth is an entry there plus the few lines in `sonifyScene()`
that find its moments.

| Trigger | Moment | Defaults (the sound is always yours to pick) |
| --- | --- | --- |
| `graphic` | A graphic clip's **entry** | -2 dB — a short pop suits it |
| `transition` | The start of a transition's window | -3 dB, offset **-0.06 s** so it leads the picture |
| `click` | Each mouse-down, from a sidecar **or** a performed take | -6 dB |
| `counter` | Each step of a counting number, capped | -12 dB |
| `cut` | A **hard** cut into a data graphic | -4 dB |

Four details that are decisions rather than accidents:

- **A graphic's moment is its entry, not its clip edge.** `inDelay` exists so an object
  can arrive late; a pop on the clip's start would then be a pop at nothing.
- **A click's moment comes through `clipAllClicks()`**, which covers **both** click
  sources — step 8's recorded `clip.screen` sidecar *and* a performed `clip.mouse` take —
  and retimes each by the clip's `in` point. Both are needed: on Windows a window capture
  writes no sidecar, so a take is often the only click data a recording has, and reading
  one source left a project full of takes completely silent. Reaching into either event
  array directly would put every sound back where the untrimmed file had it — the trap the
  note on `clipCursorAt()` exists to head off. A clip with neither contributes nothing,
  which is the normal case and not an error: step 8's degradation contract, honoured.
- **The tick count is capped** (`maxTicks`, default 12). A number counting to 1240 does
  not get 1240 ticks; the ticks are spread over the entry, which is the window the number
  is actually moving in.
- **An impact goes on a hard cut only.** A cut with a transition on it already has a
  whoosh, and stacking the two reads as a mistake rather than as emphasis.

Every trigger's default `sound` is the empty string, and that is deliberate: with an
empty library there is nothing honest to point at, and inventing a placement with no file
behind it would fail at the moment of rendering rather than at the moment of asking.

`SFX.plan(scene, opts)` is a **pure function** from a scene — five arrays of moments in
timeline seconds — to a list of placements. It touches no clip and no DOM, which is what
makes trigger timing checkable without a fixture; the renderer's `sonifyScene()` builds
the scene, because only it knows how a clip's `in` point maps telemetry into timeline
time. Two placements of the same trigger closer together than `minGap` (default 0.06 s)
**collapse into one**: four graphics entering on the same frame are one pop, not a flam.
A placement whose negative offset would push it before zero is not dropped — `start`
clamps to 0 and `trim` says how much of the sound's head to cut, so the body of it still
lands where the offset asked.

#### Re-running replaces, and one undo covers the lot

A placed clip carries `sfx: { gen: true, trigger, key }` — plain JSON, like everything
else on a clip, because undo is `JSON.stringify` of the track list. That tag is the whole
mechanism:

- **Sonify is ONE `pushUndo()`**, however many sounds it places, and it ends in
  `markDirty()` + `renderAll()` like every other timeline mutation.
- Re-running sweeps away only clips carrying `sfx.gen` and places its output again, so it
  **replaces rather than doubles**. Doubling every sound each time somebody nudges the SFX
  level is the failure mode this avoids, and it is the same tag the caption generator uses
  for the same reason.
- A sound placed by hand from the library (the `+` button) is deliberately **untagged**,
  so it survives every re-run and **Clear**. Once Sonify's output has been moved or
  retimed it is still tagged, and a re-run will replace it — the tag means "this pass put
  it here", not "nobody has touched it".

They land on one dedicated audio track flagged `sfx: true` and named `SFX`, at the bottom
of the stack. The flag is a plain boolean on the track, exactly like the caption track's
`captions`, so it serialises with everything else and a re-run finds its own previous
output without guessing from the track's name.

#### Levels, and ducking through step 1's sidechain

Each placement's gain is written onto the clip as an **`AudioFX` gain effect**, not as
`clip.volume`: it is in dB, which is what the panel talks in, and the preview already
mirrors gain effects (`AudioFX.previewGain`), so the balance while editing matches the
render. The global **SFX level** is added to each trigger's own gain, so one knob is "all
of it, quieter".

Ducking is the same ducking the audio chain offers, applied to the whole pass: turn it on,
name a voice track, and every placed clip gets a `duck` effect keyed to it, which
`buildArgs()` wires as a `sidechaincompress` exactly as it does for a music bed. The SFX
track is not offered as its own voice source — ducking a bus to itself is refused
downstream, and offering it here would make that refusal look like a bug.

#### The panel

`#sfxPanel`, in the inspector column under Captions and collapsed by default for the same
reason: sonifying is a pass over the whole edit, not a per-clip control. Rows are
`TextUI.control` like every other panel — slider **and** typable box **and** scroll-nudge
**and** reset — and, exactly as Tighten and Captions do, they pass their own hooks: these
are project **settings**, so moving one snapshots no undo entry and dirties nothing. It
shows what the next pass **would** place before committing, and the count of what is
already there stays on the panel head so a collapsed panel still reports. Only Sonify,
Clear and the library's `+` touch the timeline, and each is one undo entry.

### Tighten (silence removal)

Detect the silences in a clip's audio, throw them away, and close the gaps — the single
biggest time sink in short-form editing. Detection is the easy half; the half this code
exists for is rippling the cut through a link group so picture and sound stay together,
and doing the whole pass as **one** undo entry however many cuts come out of it.

**Three time bases meet here**, and confusing them is the bug the code is written to
avoid:

| Base | What it is |
| --- | --- |
| source | what `silencedetect` reports, and what `clip.in` / `clip.out` are in |
| clip | source minus `clip.in` |
| timeline | clip plus `clip.start` — everything removed is expressed in this one |

#### Detection

`analyze:silence` in `main.js` runs `silencedetect` over a source file and returns
`[[start, end], ...]` in source time, cached in `userData/cache/silence` by
path + size + mtime — the same rule as the waveform cache, so a re-encoded file under the
same name is measured again rather than served stale.

It is run **once per file at a permissive 0.10 s minimum**, and the whole raw list is
cached. The editor's own "silences longer than N" threshold and its pad are applied in the
renderer over that cached list, so dragging the threshold slider re-counts instantly
instead of re-decoding. The **noise floor** does change what ffmpeg reports, so it *is*
part of the cache key; the threshold and the pad are not.

A file that ends in silence never gets its closing `silence_end` line, so an unterminated
span is closed at the stream duration — otherwise trailing dead air, which is exactly what
people want gone, would be the one thing that could not be cut.

#### The plan, and the cut

`tightenPlan()` is **pure**: it reads the cache and the settings, mutates nothing, and
returns the merged timeline spans, the total, and how many clips are still unmeasured.
That is what lets the inspector show a live count of what would be removed before anything
is committed. `tighten()` is the half that mutates, and it is one `pushUndo()`.

- The **threshold** is measured on the silence as detected, before the pad eats into it.
- The **pad** is kept at each end, so a cut never lands hard against speech. A pad that
  eats a whole silence simply drops it from the plan.
- Spans are clipped to the part of the source the clip actually uses, then mapped to the
  timeline, then merged. Overlapping spans from two clips are one cut.
- Spans are removed **right to left**, so each one's coordinates are still valid when its
  turn comes.

What a span may cut is deliberately narrow — a ripple that sliced everything it crossed
would be a surprise nobody asked for:

| Clip | What happens |
| --- | --- |
| in the selection's link groups | cut, trimmed or split as the span requires |
| any other clip on an unlocked track | shifts left if it starts after the span; never cut |
| a text card | shifts only, whether or not it is selected |
| anything on a **locked** track | untouched, neither cut nor shifted (as ripple delete already leaves it) |

Text cards are exempt because their `in` is always 0 and their length is `out` (see the
data model) — cutting a card's animation in half is never the intent.

A clip that a span straddles becomes two, and **both halves keep their links**: each new
right half is given a fresh `linkId` shared with the right halves of its partners in the
same span, so the next drag moves the picture with its sound. `tools/smoke-tighten.js`
asserts piece-for-piece sync after a two-span cut, and that one undo restores the timeline
byte for byte.

#### The panel

Selecting a clip with audio — either half of a linked pair — puts a **Tighten** box under
the audio chain: silence threshold, pad, noise floor, an Analyse button and a Tighten
button, with a live line saying what would come out. A selection that has not been
measured yet measures itself when the panel opens; measuring is cheap after the first
time, since both caches answer from disk.

The three settings live on `state.tighten`, not on clips: they are settings, not timeline
state, so moving one snapshots no undo entry and does not dirty the project. They are
saved in the `.scut` and default in for a project written before Tighten existed. The rows
are `TextUI.control` like everything else, but they pass their own `onEdit`/`onChanged`
hooks — which is what that override on `control()` is for.

#### The filler-word hook

`registerTightenSpans(fn)` takes `(audioClip, opts) => [[start, end], ...]` in **source**
time and its spans join the silences in the same plan, so a filler cut and a silence cut
are one ripple and one undo entry rather than two passes over the same timeline.

**It is wired up.** Captions register a provider that returns the filler words found in
the clip's transcript (see "Transcription and captions"), gated on the `cutFillers`
setting, which is **off by default** - deciding on the user's behalf that every "like" is
a mistake is not a call an editor gets to make silently.

Filler spans are **not** subject to the silence threshold — a filler word is short by
definition — but they do get the same pad. A provider that throws costs its own spans and
nothing else.

### The screen recorder

Product footage is most of a B2B short, so ShortCut records it rather than making you
find another tool for it. **Record** in the toolbar picks a display or a window, captures
it to `userData/recordings/screen-<stamp>.webm`, and — for a display — writes a second
file next to it holding what the cursor did.

This is one of **two** recordings, and it is the one that does not draw a cursor — see
"Two recordings, and which one draws a cursor" below before wiring anything to its
telemetry.

Recording the cursor as *data* is the whole point of doing this before the cursor
effects rather than after. Recovering a pointer path and its clicks from the pixels is
possible and fragile: the cursor changes shape, disappears over video, and a click leaves
no mark at all. Sampled at capture time it is exact, free, and it is what makes step 9's
auto-zoom (see "Screen-recording treatment") and step 14's click SFX authoring work
instead of a computer-vision project.

#### Three processes, because the three signals live in three places

| Signal | Where it comes from | Why there |
| --- | --- | --- |
| The picture | a hidden renderer window, `renderer/recorder.html` | `getUserMedia` and `MediaRecorder` exist only in a renderer, and it must not be the editor's — that one is on the screen being recorded, and encoding on the timeline's thread would stutter both |
| Cursor position | `screen.getCursorScreenPoint()` in main, on a timer | it is a main-process call, and a sampler on the editor's render thread would stall exactly when the user is not looking at it |
| Clicks | `src/clickwatch.ps1`, a PowerShell child process | Electron exposes no global mouse hook; `GetAsyncKeyState` reads the physical button state without installing one, so it cannot swallow or delay a real click |

The recorder window is never shown: it would otherwise appear in its own recording. That
means the editor window is the only UI, and it is behind whatever is being demonstrated —
so **`Ctrl+Shift+F9` starts and stops a recording from any application**, and the panel's
buttons do the same thing when the editor is reachable.

It is one key rather than two on purpose. The moment you want to START recording is the
moment you have already switched to the app you are demonstrating, so a key that only
stopped meant every recording opened on a shot of ShortCut's own toolbar while the user
went back to find the Record button. `toggleRecording()` in `app.js` therefore also
resolves a source of its own when the panel has never been opened: the **primary**
display, which is the only defensible default and the one that carries telemetry.
Anything else — a second monitor, a single window — is a deliberate choice, and is made
in the panel. Main fires the hotkey whether or not a recording is running and lets the
renderer decide which half to run; main's copy of that state can only be staler than the
panel's.

#### The sidecar

`<recording>.screen.json`, plain JSON, written by `finishRecording()`:

```js
{ app: 'shortcut-screen', version: 1,
  source: { id, name, type, displayId },
  video:  { file, w, h, fps, firstFrameEpochMs, durationMs },
  region: { x, y, w, h, scaleFactor, displayW, displayH },
  clicks: true,                       // false = positions only, the watcher was unavailable
  events: [ { t, x, y, type } ] }     // type: 'move' | 'down' | 'up'
```

`src/screen.js` owns every rule about that file and is loaded twice — as a `<script>`
global `ScreenTel` and as a CommonJS module in main — exactly like `audiofx.js` and
`captions.js`. Main writes sidecars, the renderer reads them, and one copy of the rules
is the only way the two cannot drift.

Two properties of the file carry everything downstream:

**`t` is seconds from the video's FIRST FRAME.** Not from when Record was pressed, and
not wall clock. Between `MediaRecorder.start()` and the first decoded frame sit the
capture negotiation and the encoder warming up — measured on this machine, **~200 ms**,
and not a constant. Time the telemetry from the button press instead and every click
ripple lands six frames late, consistently enough to look deliberate and wrong. The
recorder window takes the timestamp in `requestVideoFrameCallback`, which fires when a
frame is actually available, and `alignEvents()` retimes everything onto it. Samples from
before that frame are dropped — with one exception: the last pre-roll *position* is kept
and retimed to `t = 0`, or a recording that opens on a motionless pointer would carry no
cursor position at all until it first moved. A *click* before the first frame is genuinely
not in the video, and is dropped outright.

**`x`/`y` are normalised to the captured region, 0..1.** Bounds are DIP and the cursor
point is DIP, so the ratio is already scale-independent: a 150% display and a 100% one
recording the same gesture produce the same numbers, and the file replays on a machine
with different hardware. They are deliberately *not* clamped — a sample taken while the
pointer was on another monitor is outside 0..1, and saying so is more useful than
pretending it sat on the edge. Draw code clamps; the file records what happened.

#### Windows record picture only

Telemetry needs the captured region's bounds to normalise a desktop point into it, and
only a *screen* source has knowable bounds — a window moves, resizes and can be partly
offscreen, and guessing at it would produce coordinates that are subtly wrong rather than
absent. So a window capture writes no sidecar. The source picker says so on the card
rather than in a footnote, because it is the choice that decides whether auto-zoom has
anything to work with.

#### The contract: telemetry is optional, and its absence is normal

**Stated here because steps 9 and 14 both depend on it.** A clip may carry `clip.screen`,
or it may not, and every consumer must degrade to "no cursor data" rather than break. A
recording from Screen Studio, OBS or a phone imports as an ordinary video clip with no
`screen` field at all, and that is a supported permanent state — not a missing feature.
There is no separate importer for it: telemetry comes in through exactly one door,
`readTelemetry()` in `media:scan`, which looks for a sidecar and simply does not find one.
A malformed or foreign JSON file is treated as no telemetry rather than as an error.

Ask `ScreenTel.hasTelemetry(clip)` first. `ScreenTel.cursorAt()` answers `null` and
`clicksIn()` answers `[]` for a clip without it, rather than throwing.

#### Reading it back: source time, always

Telemetry `t` is in **source** time — seconds from the video file's first frame — because
that is the only timebase that survives what the editor does to a clip afterwards.
Trimming moves `in`, splitting makes two clips out of one and both keep the whole event
list, and dragging changes `start`. None of that may move a click ripple off the pixel it
happened on. So use the two helpers in `app.js` rather than reaching into
`clip.screen.events`:

```js
clipCursorAt(clip, tLocal)   // seconds into the clip -> {x, y} in 0..1, or null
clipClicks(clip)             // mouse-downs from `clip.screen`, retimed to the clip's start
clipTakeClicks(clip)         // the same, from a performed `clip.mouse` take
clipAllClicks(clip)          // BOTH sources merged - what anything sounding clicks wants
```

`clipClicks()` alone is the **screen sidecar only**, and that distinction has already
cost one bug: Sonify read it and nothing else, so a project whose clicks all came from
performed takes — the normal case on Windows, where a window capture writes no sidecar —
got no click sounds at all and looked like it could not see the telemetry. Anything asking
"where were the clicks" wants `clipAllClicks()`.

Both go through `clip.in`, the same way `mediaFor()` and the framing maths do. `screen`
is plain JSON on the clip like everything else, because undo is `JSON.stringify` of the
track list.

Telemetry never reaches `buildJob()`, and — since the split described under
"Screen-recording treatment" — it is not in the render cache key at all. It decides no
pixels: the two effects that once read it now read a performed take instead, and auto-zoom
bakes its answer into ordinary keyframes on `clip.fx`, which the job already carries.
Telemetry went back to describing the source rather than the picture, so it went back out
of the key.

What *is* in the key is a digest of the **performed take**, for the reason telemetry used
to be: `mouseDigest()`, four numbers — how many events, the first and last timestamp, and
whether there are clicks. It is `undefined` unless the clip both has a take *and* carries
an enabled effect that reads it, so a bypassed pointer effect keys identically to no
pointer effect at all. Without it, two cuts of one file with different takes would share a
cached render.

#### The container has to be remuxed

`MediaRecorder` writes a *live* WebM: the stream is open-ended while it is being written,
so the header carries no duration and no cues. `ffprobe` then reports a duration of 0,
`media:scan` drops the file for having no length, and **a recording you just made silently
refuses to import** — which is what happened the first time the suite ran end to end.
`remuxRecording()` runs `ffmpeg -i rec.webm -c copy` before the file is handed back: same
streams, same bytes, seekable container, a fraction of a second even on a long capture. If
it fails the original is kept, because a recording that imports awkwardly beats one that
is gone.

#### What can go wrong, and what happens instead

| Failure | Result |
| --- | --- |
| PowerShell missing or blocked by policy | positions still recorded, sidecar written with `clicks: false` |
| Not Windows | same — the watcher is skipped |
| A window source was chosen | picture only, no sidecar |
| The capture is refused (permission, no display) | `screen:start` answers `{ok: false, error}`; nothing is left behind |
| The user stops the capture from the OS | the track's `ended` event stops the recorder like a normal Stop |
| Nothing was written | the empty file is deleted and the error is reported |

### Two recordings, and which one draws a cursor

ShortCut records two different things, and the difference is the answer to a bug rather
than a preference.

| | What it captures | What it feeds |
| --- | --- | --- |
| **Screen recording** (`Record`) | a display, to WebM, with the OS cursor sampled alongside it into `clip.screen` | **auto-zoom only** |
| **Mouse take** (`Mouse`) | the pointer *you perform* over the finished 9:16 picture, into `clip.mouse` | the drawn **cursor**, the **ripples**, the **selection** boxes |

**A screen capture already contains a real cursor, in its pixels.** Drawing a second one
over it gives two pointers chasing each other, a fraction of a second apart, and no amount
of smoothing hides it. The first version of this tried to paper over the problem with a
`conceal` parameter that smeared neighbouring pixels across the recorded pointer — a
cover, not an inpaint, right over a flat toolbar and obviously wrong over any hard edge.

So the two were separated. A screen capture keeps auto-zoom, which draws nothing and only
moves the frame. A performed take is recorded over a picture that never had a pointer in
it, so the drawn one is the only one and the conflict is gone by construction. `conceal`
is deleted rather than fixed, which is the right end for a parameter that only existed to
hide a design mistake.

The two coordinate spaces are the other half of keeping them apart:

- **Telemetry is in SOURCE fractions.** It was recorded against the video file, so it has
  to go through the clip's pan/zoom framing to become pixels — reframe the shot and the
  cursor follows the thing it was pointing at.
- **A take is in FRAME fractions.** It was performed against the composited output, so it
  is already where it belongs and must *not* be mapped — reframe the clip underneath and
  the pointer stays exactly where it was put.

`Cursor.mapperFor()` is the one function that decides, and it asks the *data* which space
it is in rather than trusting the caller. Getting this backwards puts the pointer on the
wrong pixel in a way that looks almost right, which is the worst kind of wrong.

### Performing a mouse take

`Mouse` in the toolbar records over the viewer, across the current in/out range.

**The range has to be pre-rendered first**, and `startMouseTake()` refuses rather than
limping. Compositing a stack of clips, cards and effects live *while* asking someone to
perform a pointer against it drops frames, and a take performed against a stuttering
picture is timed to a picture nobody will ever see again. A preview render of the range
makes the viewer decode one finished MP4 instead — which is what preview renders are for.

While a take is running the viewer is an input surface, not a framing control: the pointer
handlers run in the capture phase and stop the pan-drag, and the cursor turns to a
crosshair. `Esc` or `Mouse` stops; so does the playhead reaching the end of the range.

| Input | Recorded as |
| --- | --- |
| pointer movement | `move` samples |
| click | `down` / `up` — ripples and the pointer's scale punch |
| **Shift-drag** | a selection rectangle, which becomes a `select` effect |

**Time comes from the playhead, not the clock.** `state.playhead` is the authoritative
time of the frame on screen, so a sample taken during a stutter is timed by the frame it
belongs to rather than by when the pointer event happened to arrive. Step 8 needed a whole
first-frame alignment pass to achieve the same thing against a real encoder; here it is
free, and it is exact.

#### One take, several clips

A take is performed against the timeline and can cross any number of cuts, so on commit
`Cursor.splitTake()` cuts it up and each clip gets the piece that happened over it,
converted into that clip's own **source** time. That is the same axis `clip.screen` uses
and for the same reason: it is the only timebase that survives trimming, splitting and
dragging the clip afterwards.

The boundary is half-open, `[start, end)`, exactly like `layersAt()` — a click landing
precisely on a cut belongs to the clip coming in, not the one going out, and the two must
not both claim it.

The whole commit is **one** `pushUndo()` however many clips it touches. Re-performing
replaces: each clip's previous take is dropped and the `select` effects tagged
`gen:'onrender'` go with it, so a second attempt is a second attempt rather than two
pointers on top of each other. A `cursor` or `ripple` effect that is already there is left
alone — re-performing must not stack a second pair on top of the tuned first pair — and
selections the author made by hand are never touched.

#### The pointer, and swapping it for a PNG

The built-in pointer is drawn as vectors, so it stays sharp at any output resolution.
`image` swaps it for an imported PNG, drawn about a configurable hotspot so the click
lands where the artwork points rather than at its top-left corner.

What is stored on the clip is a **path**, not the bytes. `clip.fx` is plain JSON that goes
into every undo snapshot and into the `.scut` file, and an inlined image would put a
megabyte of base64 into both.

That makes decoding asynchronous, which a synchronous `draw()` cannot wait for — so
`pointerImage()` hands back `null` while a file is still decoding and the arrow is drawn
instead. That is correct for the viewer, where the next frame is 16 ms away, and **wrong
for the baker**, where the frame it missed on is in the file forever. `bakeOverlays()`
therefore awaits `FX.preloadImages()` before anything is baked. A pointer that will not
decode resolves anyway: a missing file must not hang a render.

#### The window selection

`select` is a rectangle that arrives, holds and leaves. Four styles — corner brackets, a
dashed marquee, an outline with a glow, and no outline at all — plus `dim`, which darkens
everything outside the box and composes with any of them.

It is both **recorded and authorable**: a Shift-drag during a take writes tagged keys onto
`x/y/w/h`, and a clip nobody ever performed over can carry one placed by hand. That is why
it has no `needs`, unlike the two pointer effects.

**The rubber band is the animation.** One corner is pinned where the drag began and the
other follows the pointer, exactly the way a desktop marquee behaves — so the recorded box
grows, shrinks and flips sides as it was actually dragged, instead of appearing whole at
its final size. `Cursor.selectionKeys()` replays that: `sel.samples` is the moving corner
over time, `sel.x0`/`sel.y0` the pinned one, and every sample becomes a key on all four
properties.

Three details that make the replay a replay:

- **The easing between drag samples is `linear`.** These keys are a path, not a set of
  poses: an ease on every pair would make the band accelerate and settle between each
  sample and the next, which at 20 keys a second reads as a stutter.
- **Samples are decimated to 20 Hz.** Pointer events arrive at 60–120 Hz, and four tracks
  of 240 keys is a strip nobody can edit for a path that is straight between any two
  neighbours anyway. First and last are always kept.
- **No trailing key.** After the last key a track holds, which is `evalTrack()`'s own
  rule, so the box simply stays at the size it was released at until the effect goes off
  screen — `Cursor.DEFAULTS.select.hold` seconds later. A trailing key would be a key the
  author has to delete.
- **Both corners come off the DRAWN pointer, not the recorded one.** The cursor is
  deliberately not drawn where it was recorded: `cursor` smooths the path and evaluates it
  `lag` seconds in the past so it reads as a physical object. A box built from the raw
  samples therefore tracks a point the viewer cannot see, and the corner separates from
  the pointer by exactly `lag` — it appears to chase the cursor rather than be held by it.
  `selectionKeys()` takes a `pointerAt(t)` and runs the anchor and the moving corner
  through it, using that clip's own `cursor` settings, so the two are locked by
  construction rather than by tuning a number.

The static `params` are the box **as released**, so bypassing or deleting the keys leaves
the shape that was drawn rather than a default rectangle somewhere else.

Two things it gets right on purpose:

- **The envelope is a function of `t` and nothing else** — it fades and scales in over
  `fadeIn`, holds, and leaves over `fadeOut`, all from the clip-local time. The marching
  dashes are the same: the dash offset is `t * speed`, not an incrementing counter. That
  is the only reason a scrub backwards and a baker visiting frames out of order paint the
  same picture.
- **`dim` uses an even-odd fill, not a cleared middle.** Clearing would punch a
  transparent hole through the clip's own layer and let whatever is under it come through
  — the opposite of lighting one region of *this* clip. This bit was wrong first:
  `roundRectPath()` opens with `beginPath()`, which silently threw away the outer
  rectangle and darkened the *inside* of the box. `roundRectSub()` exists so a
  hole-punching path can be built at all, and `smoke-cursor.js` asserts the inside is
  untouched and the outside is darker and still opaque.

#### `round`: the shadow falls inward by default, and that IS the vignette

**Shadow falls** picks the direction, and it is the control that decides whether the effect
appears to work at all.

**Inward** (the default) is the vignette: a soft darkening around the inside of the frame,
strongest in the corners. It needs no setup — no inset, no corner radius — so a full-frame
clip gets a vignette the moment the effect is added.

**Outward** is an ordinary drop shadow. It draws *beyond* the picture, so on a full-frame
clip it lands off the canvas and shows nothing until `Inset` opens room for it. That is
what made the effect look broken for so long: the only visible result of adding it was the
corner radius cutting the corners to transparency, and the shadow controls did nothing
that could be seen.

The inward shadow's implementation has one trick worth knowing. The obvious build — fill
the frame, punch the rounded rect out, blur what is left — produces **nothing** at the
default settings, because with no inset and no radius the rect *is* the frame and the
punch removes everything. There has to be shadow *outside* the picture for any of it to
bleed back in. So the plate is built oversized and filled solid, the rect is punched out of
the middle of it, and the blur carries the surround inward over the picture's own edges.
The corners come out darkest because a corner has solid plate on two sides of it instead
of one — more so the rounder it is.

It composites `source-atop`, which is the difference between a vignette and a grey
rectangle: filled normally the gradient would darken the layer's *transparency* too, so a
logo or a cutout would gain a dark halo and the layers underneath would be dimmed through
a clip that is not even there.

For a long time it could do neither. The rounded rectangle was hardcoded to the full
frame, which is a catch-22: on a full-frame clip the shadow is cast at the frame edge and
falls entirely outside the canvas, so the only visible result was the corners cut to
transparency with black showing through — and scaling the layer down first did **not**
help, because the rounded rect stayed the whole frame no matter what was inside it. Both
halves of "corners + shadow" were unreachable.

`margin` is the fix: the effect insets the rectangle it rounds, and the margin is the room
the shadow needs. Two decisions inside it are worth knowing.

**It CLIPS to the inset rect; it does not scale into it.** Scaling looked more useful — the
whole picture, smaller, inside a frame — and it cost preview/render parity. Resampling by
a non-integer factor puts the content's own edges at different sub-pixel phases at 135 px
and at 540 px wide, and a later `transform` lands those differences **35 levels** apart in
the viewer and the file, against a tolerance of 12. `inset`, which clips, measures exactly
**0** at the same test, which is what pointed at the resample. So `round` crops the outer
margin away the way a rounded-corner mask does, and the whole four-effect parity stack now
measures 0 rather than the 9 it used to. If you want the whole picture smaller, put a
`transform` above it.

**The shadow is a silhouette, not `ctx.shadowBlur`.** It paints the same rounded rect as a
solid shape, offsets it, blurs it through `padBlur()` — the same padded, non-magnifying
blur the `blur` effect uses — and composites it under the picture. That makes it
independent of the layer's own alpha, so a clip with transparency in it casts a clean card
shadow instead of a ragged one.

The margin is an equal number of **pixels** on all four sides, not an equal fraction of
each axis: on a 9:16 frame a uniform fraction would inset the top and bottom nearly twice
as far as the sides and the border would read as lopsided.

**There are exactly two ways to lose the OUTWARD shadow, and the panel names both.** It
lives in the room the margin opens, so you either leave no room or push it out of the room
there is — `FX.shadowProblem()` answers `no-room`, `pushed-out` or `null`, and the row says
which. An inward shadow draws over the picture itself, so it needs no room and can never be
pushed out of any; the check returns `null` for it. Neither case draws anything and neither
is an error, which is why both went undiagnosed for so long:

- **No room.** `margin` is 0, so the shadow is cast at the frame edge and falls outside it.
- **Pushed out.** `offsetX`/`offsetY` reach further than `margin`, so the shadow lands
  mostly beyond the frame. A 0.136 offset against a 0.040 inset shows nothing at all.

It reads the **animated** parameters at the playhead, not the sliders, because the
commonest way to end up with no room is a keyframe — see below.

### Auto-zoom, and cursor smoothing

The maths for both is in `src/renderer/cursor.js`, a plain `<script>` global `Cursor`
loaded between `anim.js` and `fx.js`. It touches no DOM, no canvas and no filesystem, so
`smoke-cursor.js` can check every one of its answers against a path whose value is known
exactly — which is why that suite needs no fixture and no recording at all.

Everything degrades. `Cursor` answers `null` / `[]` / "no zoom" for a clip carrying
neither a take nor telemetry, the pointer effects draw **nothing**, and the auto-zoom
panel does not appear. That is the contract stated under "The screen recorder", asserted
rather than assumed: a clip with no take paints pixel-identically with both pointer
effects switched on.

#### Auto-zoom writes real keyframes, and that is the whole design

The tempting version of this feature is an effect with a "zoom amount" slider that reads
the telemetry every frame. It is less code and it is much worse, because the moment the
third zoom of eleven goes slightly too far there is nothing to do about it but turn the
whole feature off.

So the generator produces what a patient author would have keyed by hand: `Anim` keys on a
`transform` effect, sitting on the same strip, with the same handles, draggable and
retimeable and deletable one at a time. The generator does not exist at render time — by
then there is only a transform with keys on it, indistinguishable from one somebody typed.

**Generated keys are tagged** (`gen: 'autozoom'`, plain JSON like everything else on a
clip). That is what makes Regenerate safe: `Cursor.applyGenerated()` drops the tagged keys
and puts the new generation in their place, and every untagged key survives untouched.
Without the tag, regenerating would either double the animation or silently destroy hand
work, and both of those turn the generator back into the black box it exists not to be.

Note what the rule does *not* say: dragging a generated key does not un-tag it, so the
next generation still replaces it. Retiming a machine's guess is a correction to that
guess; asking for a regeneration is asking for a new one. What survives is what the author
**added**.

The transform it writes onto is **appended to the stack**, after any cursor and ripple
effects, and that ordering is load-bearing. Telemetry is a point in the *source* frame, so
those two paint at the pixel the framing put it on; a transform drawn afterwards moves the
picture and the pointer together, which is what makes the zoom carry its own cursor with
it. The other way round, the frame dives in while the pointer sits still on top of it.

#### The minimum hold is enforced in the generator, not smoothed afterwards

`Cursor.segments()` walks the cursor at 10 Hz and keeps extending the current segment
while every sample in it still fits inside a box whose size comes from **sensitivity**.
Then it throws away every segment shorter than **minimum hold**, and merges neighbours
whose centres are within half a box.

That order matters more than it looks. A pointer flicking between two nearby targets
produces a dozen two-frame segments; smoothing the resulting zoom curve afterwards gives a
soft, *permanent* wobble, because the wobble is in the data. Rejecting the segments removes
it — the frame simply does not move for a gesture nobody held. `smoke-cursor.js` feeds it
four seconds of exactly that flicking and asserts it comes out as one zoom, not a burst.

Each surviving segment becomes a target: the scale is whatever makes the dwell fill 60% of
the zoomed frame, capped by **max zoom** and never below 1 — zooming *out* of a screen
recording is never what was asked for. The centre is then clamped so the zoomed window
stays inside the frame; without that a dwell in a corner pans past the edge and lets black
through, and the black would be baked into the export, because the baker and the viewer
run the same code.

Four keys come out per hold — neutral, in, hold, neutral — and consecutive holds whose
ramps would collide drop the two neutral keys between them, so the frame cuts straight
from one target to the next instead of pulling out and diving back in. A hold that runs
off the end of the clip resolves its collision **toward the segment**: a clip trimmed into
the middle of a dwell opens already zoomed in, because keeping the neutral instead would
leave one key at 1 and the next at the target four seconds later, turning the whole dwell
into a slow creeping push nobody asked for.

The offset the generator writes solves `screen = anchor + (p - anchor) * s + offset` with
the anchor left in the middle — where a hand edit expects to find it — so
`offset = (0.5 - p) * s`. `Cursor.offsetFor()` is the one place that lives, and the suite
asserts the round trip: generate, evaluate the tracks, apply the transform, land on 0.5.

#### Smoothing is a filter over time, not over the event array

The events are irregular — the sampler runs at 60 Hz, a click carries a position of its
own, and a motionless pointer produces nothing for a second at a time. A moving average
over the event *array* therefore weights a busy stretch and a still one differently, and
the drawn cursor speeds up wherever the sampler happened to be dense. So `Cursor` resamples
onto a fixed 60 Hz grid first, filters that, and interpolates the result with Catmull-Rom.
The grid is held in a `WeakMap` keyed by the telemetry object — it is derived data and it
is large, and anything that lands on a clip lands in every undo snapshot and in the
`.scut` file.

The averaging window **shrinks symmetrically at the ends** rather than clamping or
reflecting the index. Both of those bias the mean where the window runs out, so a pointer
travelling in a straight line would come out visibly bent for the first and last tenth of
a second. A symmetric window is exact on a straight line everywhere, and that is the first
thing `smoke-cursor.js` asserts — to the last bit, not to a tolerance.

**Lag is a shift of the sample time**, not a blend toward the previous drawn position. The
blend version is one line shorter and depends on the frame rate, and the preview and the
export do not share one — so the pointer would trail differently in the viewer and in the
file. Same for the click punch: it is a function of `(t − click)` alone, with no state and
no accumulation, so a scrub backwards and a bake that visits frames out of order paint the
same picture.

#### The ripple colour is hardcoded, on purpose, in one place

`Cursor.ACCENT` is the brand accent until step 17 hands the brand kit over. It is a single
constant with a single reader, so that step changes one line rather than hunting for a
colour literal in a draw function.

### Motion tracking

`src/renderer/track.js` is a plain `<script>` global `Tracker`, loaded between `cursor.js`
and `fx.js`, and it is the pure half: pyramidal **Lucas-Kanade** optical flow, the data
model, and the binding maths. No DOM, no canvas, no ffmpeg, no filesystem — frames arrive
as luma arrays and answers leave as numbers, which is why `smoke-track.js` can paint its
own frames and assert accuracy exactly rather than approximately.

What lands on a clip:

```js
clip.tracks = [ { id, name, res, rate, win,
                  tex,                                   // the anchor's texture score
                  anchor: { t, x, y },
                  points: [ { t, x, y, c }, ... ] } ]     // absent until one is dropped
```

A track with exactly one sample is a marker that has been placed and not yet solved —
`Tracker.isSolved()` — which is what decides `Solve` versus `Re-solve`, whether dragging
re-solves, and whether the marker on the viewer can be described as "lost" at all.

#### The flow: place, drag, THEN solve

Three steps, in this order, and the order is the whole of what makes it usable:

1. **Add tracker** drops a marker at the playhead. It does **not** solve.
2. **Drag it on the viewer** onto the thing you want to follow. Dragging an unsolved
   marker is still placing it, so it still does not solve.
3. **Solve** follows that point across the clip, both ways from the anchor.

The first build fused (1) and (3): adding a tracker placed it in the middle of the frame
and immediately solved. The middle of a frame is almost never the thing anyone wants
followed, and it is usually flat — so the result was a seek per frame spent proving it
could not follow it, several hundred samples of zero confidence, a solid red strip and no
clue that the answer was "you put it somewhere with nothing to follow". Placing and
solving are now separate actions, and the button that solves says `Solve` until there is
something to re-solve.

A drop **snaps to the strongest feature within a short reach** (`bestFeatureNear()`, about
3.5% of the frame's shorter side). This is not a convenience. People aim at the middle of
the thing they want to follow, and the middle of a button, a card or an icon is its
flattest, least trackable part — the corners a few pixels away are what optical flow can
actually hold. The snap walks the drop over to one, and the panel then says how good the
point it found is.

A point with nothing to track is **refused before the solve**, with a sentence saying what
to do instead, and `Solve` is disabled while it stays that way.

#### Texture and confidence are different questions

They were multiplied into one number once, and the result was a tracker that called
almost everything lost:

- **Texture** — the window's Shi-Tomasi score — asks *is there anything here worth
  anchoring to*. It is a property of the **point**, asked **once**, when the tracker is
  dropped. It drives the snap, the quality readout and the refusal.
- **Confidence** — the residual after the fit — asks *does this window still look like the
  one we anchored on*. It is a property of each **frame**, and it is what occlusion makes
  fail, which is what confidence is for.

Most of a real interface is soft: antialiased text, a gentle edge, a button corner with a
few levels of contrast. Those score modestly on texture and track perfectly, so folding
texture into a per-frame confidence marked every one of them lost while the point sat
exactly where it belonged.

Texture still acts as a **floor**, because a perfectly flat window matches everywhere: its
residual is tiny, its fit is excellent and its fit is meaningless. Below `minTex` the
answer is zero rather than a good-looking number.

The calibration, which is where `minTex = 0.03` comes from — all measured by
`smoke-track.js`, which prints them:

| Feature | Texture |
| --- | --- |
| a hard, high-contrast corner | 1.000 |
| an ordinary soft button corner (40 levels, 4 px transition) | 0.113 |
| a fainter one (25 levels, 3 px) | 0.055 |
| dither on a flat wall (±7 levels) | 0.012 |
| a flat wall | 0.000 |

A **straight edge scores near zero at any contrast**, and that is correct rather than a
shortcoming: one point cannot track an edge, because it slides along itself. That is the
aperture problem, and walking a drop off an edge and onto a corner is exactly what the
snap is for.

`t` is **source** seconds and `x`/`y` are fractions of the **source** frame — the same
axes `clip.screen` uses, and for the same reason: they are the only ones that survive
trimming, splitting, dragging and re-framing the clip afterwards. Re-framing in particular
is why the solve runs on the *unframed* source picture; solving through the crop would
bake today's pan and zoom into the answer. `c` is confidence, 0..1, and it is data rather
than a diagnostic — the timeline draws it.

#### The worker, and the measurement that justifies plain JS

The flow runs in a worker built from `track.js` **concatenated with** `track-worker.js`
into one Blob. A Blob because `new Worker('track-worker.js')` is refused under `file://`;
a concatenation because the kernel then has exactly one source, so the window, the worker
and the suite cannot run three different versions of it.

Plain JS, no WASM, and the measurement is in the suite's own output: **~1.3–2 ms per frame
per point** at 256x160 with three pyramid levels, on this machine. A solve is *seek-bound*
— parking a decoder on an exact frame costs far more than the flow does — so a WASM build
would speed up the part that is not the problem. What the worker buys is not throughput but
that those milliseconds are off the UI thread: the solve yields between frames, the viewer
keeps painting, and `loop()` keeps re-arming.

#### Occlusion holds, it never teleports

Confidence is two independent things multiplied: the window's Shi-Tomasi score (is there
any texture here to track at all) and the residual after the fit (does this still look like
what we anchored on). Below `minConf` the solver **keeps the last good position** and
records the low confidence. A tracker that leaps across the screen for six frames and
comes back is far worse than one that sits still and says so: the first throws a callout
across the picture, the second draws a dip on the timeline. The worker still advances its
"previous frame" through a held stretch — comparing frame 40 against the stale frame 12 we
last trusted is exactly how a tracker recovers from an occlusion by leaping.

#### The two things that make it usable rather than merely present

- **Confidence is drawn on the lane.** A strip along the bottom of the clip, quiet where
  the solve is sure and red where it is below the hold threshold, with the worst track
  winning each column. A lost track looks identical to a good one in the picture until the
  export; this is what makes it visible instead.
- **Dragging the marker on the viewer re-anchors and re-solves FORWARD ONLY.** The frames
  before the correction were either right already or corrected earlier, and re-solving them
  would destroy that work — which is what turns "fix the one bad stretch" into "track the
  whole clip again" and stops people correcting at all. The markers are drawn *over* the
  viewer, after `drawPreview()`, on the same terms as the mouse take's rubber band: an
  affordance, never a layer, never baked, never in a cache key.

#### Binding, and what each type does with the point

A solved track does nothing until something reads it. `FX` entries of three types can bind
a position to one:

| Type | What follows |
| --- | --- |
| `transform` | **two modes.** *Move* (the default) travels the clip with the point: it keeps the position you gave it and adds the distance the point has moved since it was anchored — what a logo, badge or callout wants. *Pan* is the camera: the frame pans so the tracked pixel sits at the centre, solved through the effect's own scale and anchor — for the footage the track was solved on |
| `spotlight` | the **lit shape**, centred on the point; the picture stays still |
| `cutout` | the **source region** being lifted; the magnified float stays where it was placed |

Those are different answers on purpose, which is why each type owns its `apply()` rather
than sharing one "set x and y".

**The two transform modes move in OPPOSITE directions, and that is the whole reason the
mode is a control rather than a guess.** Panning a camera up makes everything in the frame
appear to travel down, so a logo bound in *Pan* mode slides away from the thing it is
meant to be stuck to. The first version of this had camera semantics only, and a bound
image therefore followed its track in reverse. `smoke-track.js` now asserts the direction
of both modes, which is the assertion that was missing. Binding a cutout's *destination* would fling the
callout around the frame, which is the one thing a callout must not do.

#### Following a track on ANOTHER clip

`bind.clip` names the clip the track lives on, and it is absent for the ordinary same-clip
case. This is the commonest shape there is — a logo, a badge or a callout is almost never
on the same clip as the thing it points at — and it was left out of the first cut of this
step for a real reason, which is worth stating because the reason had to be answered
rather than waved away:

**it makes one clip's pixels depend on another clip's position on the timeline**, and a
clip's timeline position is the one thing the render cache's key rules keep out of the
pixels. So two things carry it:

- `fx.js` cannot resolve a cross-clip binding and does not try. The resolver is
  **injected** — `FX.setBinder()`, installed by `app.js`, which is where the timeline is
  legitimately visible. With no binder installed (a bare module load, a suite checking
  that file alone) bindings resolve against the clip's own tracks only, which is what
  `fx.js` can be responsible for by itself. An effect still cannot read `clip.start`.
- The render key takes the matching duty. `trackDigests()` puts in the owner's track
  digest **and the offset** between the two clips — the constant that turns this clip's
  local time into the owner's source time — plus the owner's framing, because the point is
  mapped through it. Slide both clips down the timeline together and the picture is
  identical and the key is unchanged; slide one, and it is neither. `smoke-track.js`
  asserts all three.

The point is mapped through the framing of the clip that **owns** the track, not of the
clip being drawn: a track is a place on its own source, and where it appears on screen is
that source's pan, zoom and crop. Mapping it through the logo's framing would put the logo
wherever the logo's own crop happened to point, which is nowhere in particular.

Deleting the clip that owns the track degrades like every other binding — the effect draws
its static parameters and the panel says why.

#### Follow strength, and taming a track that moves too much

A track is a measurement, and following it exactly is often more movement than the shot
wants: the tracked element crosses half the frame and the callout chasing it reads as
frantic. `bind.strength` scales the movement **away from the anchor** — the pixel the
tracker was placed on:

| strength | what it does |
| --- | --- |
| 1 | follows exactly |
| 0.4 | travels 40% as far as the tracked point did |
| 0 | pins it where the tracker was placed |

It is **keyframable**, which is the point — follow hard through the stretch that needs to
track and barely at all through the stretch that only needs to drift. So are the two
offsets. Those keys live on `bind.keys`, a **separate** holder from `fx.keys`: `Anim` only
ever touches a `.keys` object, so the binding is a keyframe holder for free, and they have
to be separate because the parameters `fx.keys` animates include the two the binding
overwrites every frame.

`bind.smooth` averages the track's path over a window of seconds, for a track that is
accurate but jittery. Zero is the track exactly, so it costs nothing when it is not asked
for.

The offsets are **returned** by `bindPos()` rather than applied by it, and each type's
`apply()` puts them where they belong. An offset moves the lit shape of a spotlight and
the whole frame of a bound `transform` — which is a camera — so applying them centrally
inverted the transform's. `smoke-track.js` caught exactly that.

#### Repairing a lost track

A lost span is not a failure to live with: the solver holds the point still through one,
which is visibly wrong when the thing it was following kept moving, and it is the jump out
the far side that reads worst. Three repairs, and which one applies depends on the shape
of the damage:

- **Repair the gaps** (a button on the track's row) interpolates across every lost span
  that has solved samples on **both** sides. A person looking at the two confident ends
  can see the object travelled between them, and a straight line between them is very
  nearly always closer to the truth than a frozen point. One undo entry, and idempotent.
- **Alt-drag the marker** fixes just the frame you are on and leaves every other sample
  alone — including the solved future, which is the difference from a plain drag. In the
  middle of a long track with one bad stretch, re-solving the remaining minute to correct
  six frames is a bad trade. The lost runs the new fixed point now bounds are re-bridged
  towards it.
- **A plain drag** still re-anchors and re-solves forward, which is the right answer for a
  track that goes wrong and stays wrong.

An **edge** span — lost at the start or the end, with nothing to interpolate towards —
cannot be bridged, and guessing off the end of the data is how a repair becomes a lie. The
panel counts the two kinds separately and says that re-anchoring is what an edge span
needs.

Repaired samples carry `fix` (1 interpolated, 2 placed by hand) and are **absent** on an
untouched track. A repaired span stops counting as lost — `worstIn()` treats it as
confident, so a repaired track stops reporting itself broken — but the confidence numbers
underneath are left alone and the lane draws repairs in **amber** rather than red. The
machine still failed there, and that is worth being able to see when the shot looks wrong
later; it is just no longer an alarm.

#### The cache key, and what a track is allowed to contribute

A track that **nothing is bound to** is not in the render key at all: a solve is analysis,
and analysis nobody reads changes no pixels. The moment an enabled effect binds to one,
`trackDigests()` puts a reduction of that track's samples into the job — count, span and a
checksum — in stack order and **without the track's id**, exactly as an effect's `id` is
stripped, so a duplicated clip still shares the original's cached render. The digest
carries no timeline position, so moving a bound clip keeps its cached render; changing a
sample it reads loses it. `smoke-track.js` asserts both.

Solves are cached on disk in `userData/cache/track`, keyed by path + size + mtime (the
waveform cache's rule) plus `Tracker.cacheKey()` — the range, the anchor and the solver's
settings. So the same file tracked from the same pixel opens already solved, in every
project that holds it.

### Magic Mask

Paint over the object, get the object.

It is the last step of Phase C and it needed **no new plumbing at all**, which is exactly
why it is here and not at the start. Step 5 gave the compositor alpha; step 6 made the
bake the single draw path, so a visual feature is written once; step 7 made an effect a
`DEFS` entry that arrives with keyframes, a shutter, a panel and serialisation. So an
extracted object is one `destination-in`, a stack order, and the machinery below.

Two files, split the way `track.js` and its worker are:

- `src/renderer/magicmask.js` — the pure half, a plain `<script>` global `MagicMask`
  loaded before `fx.js`. The data model, the prompt encoding, the propagation loop, the
  matte edge operations and the cache key. No DOM, no canvas, no onnxruntime, no
  filesystem: frames arrive as RGBA arrays and mattes leave as 8-bit alpha planes.
- `src/mask.js` — the model half, main process only. MobileSAM: downloading it, verifying
  it, loading it, running it, and the matte disk cache.

#### What lands on a clip, and what deliberately does not

```js
clip.masks = [ { id, name, res, rate,
                 strokes: [ { t, sign, r, pts: [x,y,x,y,...] }, ... ] } ]  // absent until painted
```

- `t` is **source** seconds, the axis `clip.tracks`, `clip.screen` and `clip.mouse` all
  use — the only one that survives trimming, splitting and dragging the clip afterwards.
- `x`,`y` are fractions of the **source** frame, so a stroke painted at preview resolution
  means the same thing to a 1080x1920 render, and re-framing the clip afterwards does not
  move the object out from under the prompts.
- `sign` is +1 for a positive stroke (this is the object) and -1 for a negative one.
- `r` is the brush radius, a fraction of the frame's shorter side.

The **mattes are not on the clip**, and that is the load-bearing decision in the feature.
The strokes are a few hundred bytes; a minute of mattes is tens of megabytes. Undo is
`JSON.stringify` of the track list and the same shape is the `.scut` file, so putting the
pixels there would push fifty megabytes through a stringify on every timeline mutation.
They live in `Mask.mattes` in the renderer, backed by the disk cache — **the strokes are
the document, the mattes are a cache of what the strokes mean.**

For the same reason, **solving is not an undoable edit.** Painting a stroke is
`pushUndo()`; running the propagation changes no timeline state at all, so it takes no
undo entry — the same reasoning a waveform scan and a preview render already follow.

#### Negative strokes are not optional

A click-only UI cannot say "the bright gap between the arm and the torso is background".
One positive scribble down the arm and one negative in that gap is the difference between
a cut-out and a cut-out wearing a halo, and no amount of positive painting expresses it.
So the brush carries a sign, the sign becomes the decoder's point label, and it is in the
cache key.

There are **two brushes, as two buttons** — `+ Add` and `− Subtract` — and Alt held during
a drag is a momentary **invert** of whichever is live, not a hardwired minus: in Add it
gives Subtract and in Subtract it gives Add, so someone working in Subtract still has a
momentary way to the other one. The buttons carry the same green and red the strokes are
painted in on the viewer, so *which brush am I holding* and *which strokes did it make* are
one question. A fresh mask always starts in Add, because a first stroke that painted
background would select nothing and read as the model failing.

That pair started life as Alt-drag alone, described in the panel's hint text, and it may as
well not have existed: the first person to use the feature hit exactly the problem
subtraction solves, read the paragraph describing Alt-drag, and asked for the minus brush
to be added. **A capability nobody can find is not a capability, and a line in a
four-sentence paragraph is not a control.**

`smoke-mask.js` holds that down with the case that makes it unavoidable: two squares of
**identical colour**, one of them wanted. Nothing about colour can separate them; only
"not that" can.

That test is also what found the first implementation's bug. The local engine originally
treated a negative as a *colour to stay away from*, which throws both squares away,
because they are the same colour. What the author means by scribbling on the second one is
"not that **thing**" — a region. So a negative grows its own region and that region is
subtracted. The arm-and-torso case is the same shape of problem seen from the other side:
the positive fill escapes through the gap into the background, and a negative in the gap
carves the escaped component back out.

#### Two engines, and the degradation contract

The segmenter is **injected** — `MagicMask.setEngine()` — for exactly the reason
`FX.setBinder()` is. `app.js` installs one that runs MobileSAM through the main process;
`smoke-mask.js` installs nothing and gets the built-in one. That split is what lets the
whole propagation loop be tested without a 45 MB download.

| | What it is | What it holds |
| --- | --- | --- |
| **MobileSAM** | a 28 MB encoder + a 16 MB decoder, ONNX, through `onnxruntime-node` | real objects: people, hands, windows, a card in a list |
| **built-in** | a connected colour region-grow, in `magicmask.js`, no download, no network | a logo, a coloured button, a UI panel, a solid shape |

The fall-back lives **inside** the engine rather than at the call sites, so the loop, the
live preview and the suite all get it without knowing there are two — and a model that
fails halfway through a solve falls through for **that frame** and the solve carries on.
`Mask.engine` records which one actually answered, the panel says so on screen, and the
engine is in the matte cache key: a machine that finishes its download mid-project must
not be served mattes cut by colour.

Every failure is a **value**, never an exception. No onnxruntime, no model, no network, a
corrupt download, a session that will not load: all of them answer
`{ ok: false, reason, error }`. A rejected `invoke` in the middle of a paint is the
failure mode the whole design avoids — this is step 8's contract for telemetry, kept here
for models.

#### The models

Downloaded on first use into `userData/models`, with progress in the panel:

```
mobilesam.encoder.onnx   28,195,125 bytes   sha256 4125037c…6918
mobilesam.decoder.onnx   16,514,086 bytes   sha256 b0735abf…d279
```

From `PulpCut/mobilesam-onnx` on Hugging Face; set `SHORTCUT_SAM_BASE` to a mirror, or to
a **local directory** holding the same two files, which is the only way this feature is
testable on a machine that is never allowed out. Each file downloads to a `.part`, is
checksummed, and is renamed only if it matches — a truncated 28 MB ONNX loads far enough
to throw somewhere deep inside a graph optimiser, and "your model is corrupt,
re-downloading" is a better message than that stack trace. `onnxruntime-node` is a native
module, so it needs an `asarUnpack` entry alongside the ffmpeg ones.

#### Why the encoder and the decoder are separate sessions

Because they cost two different orders of magnitude, and that asymmetry **is** the
interaction design.

| | measured here, 1024x576 | depends on |
| --- | --- | --- |
| encoder | ~2.0 s | the picture only |
| decoder | ~90 ms | the embedding plus the prompts |

So the embedding is computed once per frame and held in a four-entry LRU in main, and
every subsequent stroke re-runs the decoder alone. That is what makes "the mask previews
live as you paint" true rather than aspirational, and it is why `mask:segment` takes a
frame `key` — the key is what says *this is the same picture you encoded a moment ago*.
`smoke-mask.js` measures the two and asserts the second prompt is the cheaper one.

`MagicMask.DEFAULTS.res` is **1024**, which is SAM's own scale rather than an arbitrary
number, and `res`/`rate` are repaired to the defaults rather than clamped when a stored
value is out of band — see "The clamp that ate the mask" below. The encoder resizes whatever it is handed so its long side is 1024 and pads to a
square, so feeding it 512 buys no speed at all — the graph does the same work — and it
costs accuracy: measured on a synthetic plate whose answer is known to the pixel, a 1024
frame comes back exact and a 512 one comes back with a region a third too big. Nothing
downstream cares, because mattes are stored run-length encoded and a flat one is
kilobytes whatever its nominal size.

Prompt coordinates go into the graph scaled by that same `1024 / max(w, h)`, and
`orig_im_size` is the untouched frame size. Getting that scale wrong does not throw — it
segments confidently around the wrong pixel — which is why it is a named constant and why
the suite checks the box lands on the square.

#### The clamp that ate the mask

Worth writing down, because it shipped and because the shape of it will recur.

`clamp(v, lo, hi)` in this codebase answers `lo` for anything that is not a number. So
`clamp(undefined, 128, 2048)` is `128`, and a `|| DEFAULTS.res` written after it **never
fires**, because 128 is truthy. Four values in `magicmask.js` were written that way, and
the visible one was `res`: every mask painted by the first build was cut at 128 px instead
of 1024, where MobileSAM returns **99.9% of the frame**. The symptom was not an error — it
was a wash of tint over the whole picture on the very first stroke, which reads as "this
feature does not work" rather than as a number being wrong.

The suite missed it because every mask it built passed explicit options, and the app never
passes any: there is no control for `res` or `rate`. The fix is one helper, `fill(v, d, lo,
hi)` — default **then** clamp — and `smoke-mask.js` now pins the no-argument case
specifically, plus the end-to-end version of it, which is the one that would have caught it
alone: *the analysis frame the app actually builds for a default mask on a 1920x1080 clip is
1024 x 576.*

`res` and `rate` are **repaired to the default** when a stored value is out of band, not
clamped to the band's floor. Neither has a control, so the only value either has ever
legitimately held is the default, which means anything out of band was written by the
broken build — clamping would leave a mask cut at 512 that nobody asked for. A project
saved by that build opens repaired. When a control for these arrives, it must offer values
inside the bands (`res` 512–2048, `rate` 4–60) and this becomes an ordinary clamp.

The other three instances were quieter and would have been reported as vague quality
complaints: a stroke saved without a radius got the smallest brush allowed rather than the
default one, and the built-in colour engine's reach was **4** instead of 42 — tight enough
to refuse a faintly textured region, which is every real one.

#### Propagation drifts, and the answer is a correction

Each frame is decoded from the previous frame's matte: a box derived from it bounds the
search, its low-resolution logits seed `mask_input`, and a handful of deep-interior points
supply the prompt. Those seeds are **re-derived from the mask that moved**, never re-used
from the anchor — re-using them would pin the matte to where the object *was*. And they
are taken from inside the matte even when its centroid is not: a C-shaped matte has its
centre of mass in the hole, and one seed there sends the next frame off following the
background, which looks exactly like a tracking failure and is not one.

`mask_input` takes **logits**, not probabilities. The conversion is one line in
`src/mask.js` and it is the most load-bearing line in the loop: hand the decoder
probabilities and you get a propagation that quietly ignores its own history.

It will still drift. When it does, **scrub to that frame, paint a correction, and solve
again**: `MagicMask.plan()` treats every painted frame as an anchor, cuts the range into
segments at them, and runs each segment forward from its own anchor. The segment before a
correction is untouched — the same contract `Tracker.reanchorAt()` keeps for a dragged
tracker, and for the same reason: the solved past is work already accepted. Painting on
the **middle** of a clip means the whole clip, not the second half of it, so the first
anchor also owns everything before it and is solved backward.

An anchor named by two segments — the frame a person painted in the middle, claimed by
the backward run and the forward one — is **decoded once**. Every segment needs its own
anchor entry to have anything to seed itself with, so `plan()` emits it twice; `propagate()`
decodes it on first mention and re-uses it, which saves an inference and is the only
self-consistent answer. Two records at one instant would be two answers to one question.

Strokes painted within half a matte-step of each other are the **same** anchor: a person
scrubbing one frame and painting four strokes on it is correcting one frame, and letting a
3 ms scrub difference split that into two anchors would solve the clip twice and disagree
with itself in the overlap.

#### The matte edges, and the order they run in

`MagicMask.edge()` does grow/choke, feather and invert, **in that order**, and the order
is the feature rather than a detail of it. Growing after feathering would re-harden the
edge that was just softened, so "feather 0.02, choke 0.01" would come back hard.
Inverting first would grow the *background*, so a choke meant to pull a halo in would push
it out instead. `smoke-mask.js` asserts each of the three against the other two.

The feather is three separable box blurs — a gaussian to well within an 8-bit level — and
its edges **clamp** rather than reading zero. A feather that faded towards nothing at the
frame border would eat a matte that runs off the edge of the picture, which is what a
matte of a person standing at the side of the shot does, and the symptom is a cut-out with
a soft grey stripe down one side.

**The unit rule, inherited from `fx.js`:** every length here is a fraction of the matte
plane's **shorter side**, never a pixel count. The plane is built at the mask's resolution
and drawn scaled to whatever is being painted — 540x960 in the viewer, 1080x1920 in the
file — so a "4 px" feather would be twice as soft in one as in the other. `smoke-mask.js`
states it as a measurement: the same fraction at 64 and at 256 agrees to within 20 levels
of 255, sampled across the steepest part of the ramp.

**Masks composite on the ALPHA channel.** This codebase has now hit that four times. The
plate `fx.js` masks with is built as transparency — white at full alpha falling to white
at zero — never as black-and-white, because an opaque black-and-white plate is opaque
everywhere, `destination-in` keeps everything, and the symptom is not an error but a matte
that masks nothing.

#### The provider, and where the framing is applied

`fx.js` never sees a matte plane. `app.js` installs `FX.setMatteProvider()`, which hands
back a W x H canvas whose **alpha** is the matte, and does two things on the way:

1. **The edge operations**, on the plane, at the mask's own resolution — so the parameters
   on the effect keyframe through `Anim` like any others, and a matte can open up over two
   seconds or a choke ride in as a face turns.
2. **The framing.** The matte is in source fractions and the layer is the framed picture,
   so the plane is drawn through the same crop `drawClipTo()` uses — `Cursor.mapper()`,
   reached through `Tracker.frameMap()`, which is the single place that knows it. Pan, zoom
   or re-frame the clip and the matte moves with the picture because it is read through the
   same map, not because anything re-solved.

The provider converts clip-local time to source time, because the clip is the only thing
that knows its own `in` — the same division of labour `Tracker.bindPos()` keeps. With no
provider installed the `matte` type draws the clip **untouched**, which is the honest
answer: "there is no matte yet" must never mean "there is no clip". A matte whose mask has
been deleted takes that same path, and the suite asserts it.

Mattes are **held** between samples, never blended. Two mattes a twelfth of a second apart
are two different cut-outs of a moving object, and averaging them gives a ghost of the
object in both places — a worse picture than the object being one frame late.

#### Two caches, and the one rule they both keep

Mattes are cached in `userData/cache/matte`, keyed by path + size + mtime — the waveform
cache's rule — plus `MagicMask.cacheKey()`: the source range, the resolution, the rate,
the engine, and the strokes. **Nothing about the clip is in it.** Move it, trim it,
duplicate it, re-frame it, put it on another track: the same mattes come back in a file
read instead of a minute of inference. The mask's own `id` and `name` are out too, so a
duplicated clip shares the original's mattes, and the strokes are sorted by time so the
key does not depend on the order of the person's hand.

They are stored **run-length encoded**. A matte is mostly a flat 0 and a flat 255 with a
thin ramp between, so a 1024-side plane that costs 590 KB raw lands in a couple of
kilobytes.

The **render** cache key is separate and answers a different question. `maskDigests()` puts
a checksum of the prompts into the job for every **enabled** `matte` effect and nothing
otherwise — so a clip that merely carries a mask keys exactly as one that never had one,
and a bypassed matte keys as no matte at all. Painting is authoring; a mask nothing cuts
with changes no pixels. The mattes themselves are *not* in it: they are the deterministic
output of those prompts over that file at that resolution, so hashing them as well would
be hashing the same fact twice — and it would drag fifty megabytes through a function the
timeline calls on every repaint.

#### Test one frame, then commit to the clip

A solve runs the encoder once per matte, so it is minutes on a clip of any length — and
everything else in the panel changes what a solve would *produce*. Committing to one before
checking a single frame is committing to finding out slowly, three solves later.

So the panel has two buttons, not one:

- **Test this frame** cuts the frame at the playhead and nothing else, and reports what
  came back: *"the matte covers 9.4% of the picture, cut by MobileSAM in 2.1 s."* Free to
  repeat, so the settings below it can be dialled in against one frame.
- **Solve clip (~2 min 41 s)** prices itself *before* it runs, from what a frame actually
  took on **this** machine with **this** engine on **this** clip — the only number that
  would ever be right. Until a frame has been cut it says so: an estimate and a measurement
  must not look the same.

Coverage is the honest read, and it exists to name a specific failure. A matte over 92% of
the frame has selected the *picture*, not the object — which is exactly what the 128 px bug
produced, and it presented as an unexplained wash of tint. The panel now says it in a
sentence. Under 0.4% gets the opposite advice.

Two settings, and deliberately only the two that change the answer:

| | what it does | cost |
| --- | --- | --- |
| **Detail** | the long side the segmenter runs at — Fast 512, Standard 1024, Fine 2048 | memory, and accuracy below 1024 |
| **Mattes a second** | how often the object is re-cut, 4–30 | linear: it *is* the solve time |

Both already lived on the mask and both were already in the matte cache key, so exposing
them is genuinely only UI — turn Detail down and back up and the old mattes come straight
back out of the disk cache, because a key is content and not a timestamp. Changing either
is a real edit: one undo entry for a slider drag, and the mattes cut under the old value
are dropped because they are no longer what this mask's key names.

`Fast — 512` is offered with its cost stated rather than as a neutral choice, because it is
not one: MobileSAM is trained at 1024 and degrades sharply below it.

#### The panel and the brush

**Magic Mask** sits above the effect stack in the clip inspector, for the same reason
motion tracking does: the stack reads it, so the mask has to exist before a row pointing at
one is worth offering. Only on a video clip — an image has one frame and a text card has
none, and a row of dead buttons is worse than no row.

- **Add a mask** arms the brush. While it is armed the viewer paints strokes instead of
  dragging the framing, which is the same capture-phase arrangement the tracker's markers
  and the mouse take use.
- **Drag** paints the object; **Alt-drag** paints background. The modifier is read once, at
  the press: one that could change halfway through a drag would give one stroke two
  meanings.
- The stroke previews **live** — one decoder run on the frame under the brush — and is
  drawn back over the viewer as a tint, so the first stroke does something you can see even
  before a `matte` effect exists. Strokes on the current frame are solid and strokes on
  other frames are faint, because a mask is a stack of corrections at different times and
  knowing where the other anchors are is how you decide whether to correct one or add one.
- **Solve** propagates across the clip; **Clear this frame** removes the strokes painted at
  the playhead and nothing else; **Use as a matte** adds the effect.

`matte` carries `needs: 'mask'`, so it is offered in the "add an effect" menu but
**disabled with a reason** on a clip with nothing painted, and an effect already on such a
clip carries a warning line — including the second one, that the mask exists but has not
been solved yet. That is the gap which made the two pointer effects addable to any clip and
then silently draw nothing, closed on arrival this time.

Painting a stroke is one `pushUndo()`, one `markDirty()` and one `renderAll()`. Solving
yields the thread between frames, so the viewer keeps painting, the window keeps answering
and **Stop** keeps working — `loop()` re-arms in a `finally` for exactly the same reason.

### Transcription and captions

Captions are the highest-visibility thing in the app and they cost almost nothing here,
because **a caption is an ordinary text card**. `kind: 'text'`, a `card` on the clip, drawn
by `TextDraw` - the same path a hand-typed card takes. There is no caption renderer, no
caption overlay and no second drawing path, which is why preview and export agree about
them for free and why they bake, cache, undo and serialise like everything else.

The pipeline is four steps and each one is separately testable:

```
window.api.transcribeRun  ->  words in SOURCE time   (whisper.cpp, cached in main)
Captions.groupPhrases     ->  2-3 word phrases, always on word boundaries
Captions.phraseCard       ->  a TextCard placed in the safe zone
generateCaptions()        ->  text clips on the caption track, ONE undo entry
```

`src/captions.js` is loaded **twice** - a `<script>` global `Captions` in `index.html` and
a CommonJS module in `main.js` - for the same reason `audiofx.js` is: main parses whisper's
output and the renderer parses imported transcripts, and one definition of "a word" is the
only way those two cannot drift. It is pure: no DOM, no canvas, no ffmpeg, no filesystem.

#### Why whisper.cpp and not onnxruntime-node

The alternative was Whisper exported to ONNX under `onnxruntime-node`. Three things ruled
it out, and the third is decisive:

- it is not one model but two (encoder and decoder) plus a search loop, a tokenizer and a
  mel front-end, all of which would have to be written and maintained here in JS;
- `onnxruntime-node` is a native module, so it needs an `asarUnpack` entry and a
  per-platform rebuild — exactly the packaging cost this app has so far paid only for
  ffmpeg;
- **word-level timestamps do not fall out of the model.** Whisper produces them by aligning
  cross-attention with dynamic time warping. whisper.cpp already implements that and prints
  it in `--output-json-full`; re-deriving it in JS *is* the feature, and getting it subtly
  wrong makes every caption subtly late.

whisper.cpp is one self-contained executable that reads a WAV and writes JSON.

**The model is downloaded; the binary is not.** The model is one file over plain HTTPS,
identical on every platform, so `transcribe:run` fetches it into `userData/models` on first
use with a progress line. The binary is a per-platform archive with per-build GPU variants,
and quietly downloading and then *executing* one is not something an editor should do
behind the user's back. Put `whisper-cli.exe` in `userData/whisper`, or point
`SHORTCUT_WHISPER` at it; until then the panel says so, and **Import transcript...** still
works.

Every failure degrades to a message with a `reason` on it — `no-binary`, `no-model`,
`no-audio`, `missing` or `failed` — and never to a broken editor or a broken render. Being
offline costs you the transcript and nothing else.

#### Installing the binary

Take the CPU build from the official releases and put `whisper-cli.exe` next to the DLLs it
loads, in `%APPDATA%\shortcut-editor\whisper`:

```bash
# whisper-bin-x64.zip is the ~8 MB CPU build; the cublas ones are 270 MB-670 MB and only
# worth it on an NVIDIA machine. Take whisper-cli.exe, whisper.dll and every ggml*.dll
# out of its Release/ folder - flat, not in a subfolder, which is where whisperBin() looks.
curl -L -o w.zip https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip
```

`ggml-cpu-*.dll` is one file per instruction set (haswell, skylakex, alderlake, ...) and
the loader picks the right one at runtime — keep them all, or it falls back to the slowest
path it can find.

#### The four flags that matter

All four were learned by running it, and three of them fail *quietly* — you get a perfectly
good transcript with useless timings and nothing says so.

- **`-ojf` does not ask for a JSON file.** It means "put *more* in the JSON file", so it
  has to be passed alongside `-oj`. On its own whisper.cpp writes nothing, and the run ends
  in "wrote no JSON", which reads like a parse failure and is not one.
- **`--dtw <preset>` is what produces word timings at all.** They are not a by-product of
  decoding: whisper derives them by aligning cross-attention with dynamic time warping, and
  only when asked. Without it every token in a segment carries *the segment's own bounds* —
  which is not timing, it just looks like it. On a real 2.8 s clip that gave the first word
  0.13–2.83 s and all six after it 2.83–2.83, i.e. one caption held over the whole line.
  The preset name is not always the model name (`large-v3-turbo` → `large.v3.turbo`), so it
  lives in `WHISPER_MODELS`.
- **`-nfa` (no flash attention) is required for `--dtw` to survive.** Flash attention is on
  by default in these builds and silently turns DTW back off:
  `dtw_token_timestamps is not supported with flash_attn - disabling`, on stderr, followed
  by a normal-looking transcript. It costs some speed and buys the entire feature.
- A model file that is **present but short** loads as far as `not all tensors loaded` and
  then exits, every time, forever — nothing retries a download whose file is already there.
  So `downloadModel()` checks the byte count against `content-length` before renaming
  `.part` into place and throws a short file away, and a whisper run that fails that way is
  reported as `no-model` naming the file to delete, rather than as `exited with 1`.

Measured on this machine, `base.en` on a 2.8 s clip: **3.7 s** end to end (extract, DTW
transcribe, parse), and instant on the second call from the transcript cache.

#### The transcript cache

`userData/cache/transcript`, keyed by path + **model**, with size and mtime checked inside
the entry — the same rule the waveform and silence caches follow, so a re-encoded file
under the same name is transcribed again rather than served stale. The model is in the key
because a bigger model produces different words for the same audio.

#### Parsing

`Captions.parseWhisper(json, duration)` reads `--output-json-full`. Tokens are sub-word
pieces — a word begins at a token whose text starts with a space and swallows every
continuation token after it, taking the lowest confidence of the lot, which is how
`Ship` + `ping` becomes one word and how the full stop stays on `AI.`

**`t_dtw` is the time to read, not `offsets`.** It is in whisper's own 10 ms units and it
is a single *instant* per token, not a span — so a word ends where the next one begins, and
the last word of a segment ends on its own trailing token. `offsets` is the segment's
bounds stamped onto every token; trusting it is the bug described under the flags above.
If no token has a `t_dtw` (flash attention left on, an older build) the parser falls back to
`offsets` rather than producing nothing.

Special tokens are dropped, and they come in **two shapes**: `[_BEG_]`, `[_TT_170]`,
`[_EOT_]` *and* `<|endoftext|>`. Only some of the bracketed ones end in an underscore. Miss
either shape and it rides along on the end of the last real word — `AI.<|endoftext|>` was a
real caption before there was a test for it.

`duration` clips the tail: whisper pads its input to 30 s chunks and times the last token
against the padding, so a 2.8 s clip can come back with a word ending at 30 s.

A plain `--output-json` has no tokens at all. Rather than refuse it, the segment's words are
spread across its span in proportion to their length and marked low-confidence. SRT and VTT
come in the same way, which makes a `--max-len 1` file word-exact for free.

#### Phrasing, and the safe zone

`groupPhrases()` breaks on whichever comes first: the word cap (3), the duration cap, a
pause longer than `maxGap`, or a sentence ending. **Every boundary is a word boundary** — a
phrase is a run of whole words and nothing is ever split. `start` and `end` are the words'
own timings, so a caption is up exactly while it is being said; `minDur` only ever extends
the tail, and never past the next phrase's start, because two captions on screen at once is
the one thing that always looks broken.

The **safe zone** is a band, in fractions of the frame height, that a caption is centred in
(0.60–0.86 by default). Its bottom clears the platform UI — the rail and caption text that
TikTok, Reels and Shorts all paint over the bottom of the frame. Both edges are settings,
and a zone dragged inside out is normalised rather than obeyed.

#### Keyword highlight

`card.highlight = { color, words: [index] }` overrides the fill of individual words, by
index in reading order across the card. It is plain JSON on the card, so it saves, undoes
and can be edited by hand afterwards.

One thing to know before touching `TextDraw.measure()`: **a card with no highlight still
paints a whole line in one `fillText`**, exactly as it always did. Splitting a line into
words means placing each one at its own measured offset, which loses the kerning between
them — so only a highlighted card pays that cost. The word index is counted for *every*
unit including the invisible ones, because an out-of-window unit still occupies its place
in the word order and skipping it would shift every highlight after it by one.

The pop-in is not a new animation either: it is the **existing typewriter layer** with
`unit: 'word'` and `effect: 'pop'`. Captions animate through exactly the code a hand-made
card animates through.

#### Word timing and emphasis

The whole reason the transcript is word-level rather than line-level. `card.words` is
`[{ w, start, end }]` in **the card's own time base** — seconds from the start of the clip,
which is the same `t` every paint pass already runs on, so nothing has to convert anything.
`card.wordFx` turns it into two effects:

- **reveal** — each word appears as it is spoken, instead of the phrase arriving whole;
- **emphasis** — the word being said right now grows, lifts and changes colour, and settles
  back as the next one starts.

Both are per-unit states that **multiply into the typewriter's**, exactly as the animation
layers multiply into each other. The times are written onto every generated caption whether
or not either effect is on, so switching one on later needs no regenerate.

**What is recorded is not what is played, and that distinction is the whole section.**
`card.words` holds what the transcript said, unaltered: a word's `end` is *the moment the
next word starts*, so it swallows whatever pause follows it. Played back literally, that
produced all three of the timing complaints this feature first shipped with. Measured over
a real 173-second transcript (607 words, 218 cards):

| Symptom | Cause | Fix |
| --- | --- | --- |
| the highlight lags the voice | 11 words held **0.9–1.26 s**, lit through the pause after them | `hold` (0.6 s) — past that it is a pause, not a word, and the emphasis lets go |
| a spoken word never lights up | 5 words came back **40–60 ms** long: one frame at 30 fps, or none | `minHold` (0.14 s) — a DTW blip still reads as a highlight |
| it feels a beat late | DTW marks sit on or just after the onset | `lead` (0.06 s) — everything happens slightly early, so it lands *on* the beat |

Three more things to keep right:

- **The emphasis window must be at least `2 × attack`.** The pop and the emphasis both drive
  scale, and a window shorter than two ramps peaks while the word is still *arriving* — so
  the pop is shrinking the word at the very moment the emphasis wants it big, and the two
  cancel. That left **112 short words lit for a single frame**, which looks exactly like the
  emphasis not working. Half a window of `attack` either side puts the peak precisely where
  the entrance ends. It is a floor derived from `attack`, not another tunable.
- **Word reveal replaces the uniform typewriter sweep, it does not stack with it.** The
  point of having real times is that each word arrives when it is spoken; a fixed stagger on
  top of that fights it. So the generator adds no typewriter layer when reveal is on, and
  "Pop each word in" carries over as `wordFx.pop` — the word's *own* entrance.
- An emphasised word is bigger than the text that measured it. `animatedBounds()` samples
  the paint across the clip, but a word shorter than its sampling step could peak between
  two samples, so the extra room is **reserved in `pad`** rather than discovered by
  sampling. Miss that and the bake crops the growth off.

Colour blends from the card's own fill toward the emphasis colour, which needs a colour to
blend *from* — a gradient fill has none, so there the emphasis colour is applied outright
once it is more on than off.

After the fix, over the same transcript: no word unlit, none lit for under two frames
(minimum 3, median 6), and every peak within **47 ms** of its word's onset.

#### Building captions from a preset

`state.captions.preset` names a saved **`full` text preset** (the same library the text
panel saves to), and every generated caption is built from it. A preset is a *look* — style,
animation layers, keyframes — so it supplies those and nothing else: the wording, the word
timings and the keyword highlight stay the caption's own, which is the rule
`TextModel.applyPreset(card, p, { keepText: true })` already followed.

Placement is the one thing captions still insist on: the safe zone exists to keep text off
the platform UI, and a preset authored for a title card knows nothing about that. Tick
**Keep the preset's position** to use the preset's own `x`/`y` instead.

Presets are loaded lazily and cached, because `generateCaptions()` is synchronous — that is
what keeps the whole pass one undo entry — so the Generate button awaits
`ensureCaptionPreset()` before calling it. A preset that is named but not in the cache falls
back to the built-in look **and says so**, rather than silently generating thirty cards in
the wrong style.

#### Generating

Cards land on a video track flagged `captions: true`, kept at the top so they sit above the
footage. Word timings are in the **source** time base of the audio clip they came from —
the same base `silencedetect` reports in, and for the same reason: they belong to the file,
not to where the clip currently sits. `clip.start + (word - clip.in)` is the only place that
conversion happens, and words outside the clip's in/out are simply not captioned.

The whole pass is **one** `pushUndo()`. Regenerating **replaces this generator's own
previous output for the same sources** and nothing else: only clips carrying
`captions.gen` are swept, so a card someone typed onto the caption track by hand survives,
and nudging the font size does not double every caption in the project.

#### The panel

`#capPanel` in the inspector column, **collapsed by default** — the column already carries
the bin, framing, the clip, the transition and the text card, and captioning is an
occasional pass rather than a per-clip control. The head keeps showing the card count while
it is shut.

Its rows are `TextUI.control` like everything else (slider *and* typable box *and* wheel
nudge *and* reset), and — exactly as the Tighten panel does — they pass their own hooks:
these are project settings, not timeline state, so moving one snapshots no undo entry and
dirties nothing. Only **Generate** and **Clear** touch the timeline, and each is one undo
entry.

### Keyframes

`src/renderer/anim.js` is the keyframe engine, a plain `<script>` global called `Anim`
loaded before everything else in the renderer. All of it used to live inside
`text/model.js`, where it worked and could only ever animate a text card; the extraction
is deliberately behaviour-preserving, and `TextModel` now re-exports `ease`, `bezier`,
`NAMED`, `EASING_PRESETS`, `cloneEasing` and `evalTrack` as **aliases** rather than
keeping a second implementation. That is the whole acceptance test for the move:
`smoke-text.js`, `smoke-text2.js` and `smoke-typewriter.js` pass unedited.

`Anim` owns four things:

```js
Key   = { t, v, ease }   // t is seconds into the CLIP, not the timeline
Track = [ Key, ... ]     // kept sorted by t

Anim.ease(easing, t)              // 0..1 -> 0..1, bezier or named
Anim.evalTrack(keys, t)           // the value at t, or null when the track is empty
Anim.addKey(keys, t, v?, ease?)   // v omitted = pin the value the track already shows
Anim.removeKey(keys, i)
Anim.moveKey(keys, i, v)          // change a VALUE; order cannot change
Anim.retimeKey(keys, i, t)        // change a TIME, re-sort, return the new index
```

Four rules the tracks live by, each of which has a test:

- **A track holds at both ends.** Before the first key it is the first value, after the
  last key it is the last. Keys sitting outside the clip's own range therefore still
  produce a sensible slice of the curve inside it.
- **Easing belongs to the key on the LEFT of a span** — it is the curve travelled to
  *reach* the next key, so the final key's easing is never used.
- **An unsorted track evaluates correctly and is not reordered.** `evalTrack` sorts a
  copy; a paint pass must never rewrite the author's data underneath it. Order is written
  in exactly one place, `Anim.sortKeys()`, called by the editing functions.
- **`retimeKey` returns the key's new index**, because dragging a key past its neighbour
  reorders the track and a caller holding the old index would then edit the wrong key.

#### One key is a constant, and the slider becomes decoration

A track holds its first value before its first key and its last after its last, so a
**single keyframe pins the parameter across the whole clip**. The slider above it still
shows the old number and is simply no longer read. This is correct and it is also the
easiest thing in the panel to do by accident: one stray key on `Inset` at 0 makes a shadow
impossible while the control still reads 0.040, and nothing anywhere says so. Anything
diagnosing a parameter has to read it through `FX.paramAt()` rather than off `params`.

**A first key takes the parameter's CURRENT value.** `keyStrip()` promises that adding a
key never moves anything, and on an empty track it takes `spec.base` — which used to be
the parameter's *default*. So adding a key to a value the author had moved snapped it back
to the default and changed the picture at the exact moment they asked to animate it.
`clipFxPanel()` now overrides `base` with the live `params[k]`.

#### Keys on an ordinary clip

Any clip may carry `clip.keys = { prop: Track, ... }` — the same shape a text card has
had all along. It is **optional and absent by default**: `Anim.trackFor(clip, prop, true)`
creates it on demand and `Anim.pruneKeys(clip)` deletes it again once the last key goes,
so a project that uses no keyframes serialises byte-for-byte as it did before this
existed. Reading is one call, `Anim.valueAt(clip, prop, t, fallback)`, which never has to
know whether `keys` is there. Keys are plain JSON, because undo is `JSON.stringify` of
the track list and that is also the `.scut` file.

Which properties are **offered** on a clip is a registry, not a list:

```js
Anim.registerClipProp({ prop, label, min, max, step, base, when(clip) });
```

`base` is the value a first key takes on an empty track, and it is not cosmetic: a
property that *multiplies* (opacity, scale, glow) must start at 1 or adding a key would
black the clip out, while one that *adds* (offsets, rotation) must start at 0.
`clipKeyPanel()` in `app.js` builds a strip for everything `Anim.clipPropsFor(clip)`
returns, so one registration is all a property needs to become animatable, with the
typable boxes, wheel-nudging and per-gesture undo every other control in the app has.

**The registry is still empty in this build**, and that turned out to be the right answer
rather than a temporary one. Step 4 guessed that step 7's effects would register their
parameters through the call above. They do not, and they cannot: `registerClipProp()` is
global and keyed by property name, while an effect parameter belongs to an *instance* —
two blurs on one clip are two independent animations, and a single `clip.keys.radius`
could never express that. So an effect keyframes on the effect.

Nothing was lost in the swap. `Anim.trackFor()`, `valueAt()`, `pruneKeys()` and
`sortKeys()` only ever touch a `.keys` object, so an `fx` entry is a keyframe holder for
free, and the effect panel builds its strips with the same `TextUI.keyStrip()` the clip
inspector uses. The clip-level registry stays as it is: generic, tested by
`smoke-anim.js`, and waiting for the first property that genuinely belongs to a *clip*
rather than to something on one. Text cards are not routed through it either — their
panel keyframes the card, which is a richer thing than a clip property, and it calls the
same `TextUI.keyStrip()`.

### The graphics engine

`src/renderer/graphics.js` is a plain `<script>` global called `Graphics`, loaded after
`fx.js`. It owns one new clip kind — `kind: 'graphic'` — whose **whole definition lives on
the clip**, exactly as a text card's does:

```js
clip.graphic = { type, params: {...}, keys: {...} }   // plain JSON, nothing else
```

Nineteen types ship, in four groups, and each one is **one function**:

| Group | Types |
| --- | --- |
| Primitives | `rect` `ellipse` `line` `arrow` `path` `icon` |
| Composites | `lowerThird` `stepChip` `bracket` `underline` `highlighter` |
| Data | `counter` `ring` `bars` `linegraph` `donut` |
| Diagrams | `funnel` `flow` `nodemap` |

Adding a type is one entry in `Graphics.DEFS` — its label, its group, its default
parameters, its inspector schema, its `bounds()` and its `draw()`. The panel, the keyframe
strips, the "+ Graphic" menu, the serialisation and the normalisation all build themselves
from that entry, and `smoke-graphics.js` walks `DEFS` rather than a list, so a new type is
tested the moment it exists.

#### It is a text card in every way that matters

That is the point of the shape, not a coincidence. A graphic satisfies the **same
paint-at-time-t contract** `TextDraw` does — `draw(ctx, clip, W, H, t, frameDur)` plus
`animatedBounds()` — so it needed no new plumbing anywhere:

- `compositeLayers()` paints it, which means the viewer and the baker get it from one
  implementation and there is no ffmpeg half of a graphic. Writing one would be a bug.
- `bakeTextClips()` bakes it, cropped to its painted bounds, as raw RGBA, overlaid with
  `eof_action=pass`. That function is now generic over `CANVAS_PAINTERS`, a two-entry table
  saying which function paints a kind and which field carries its definition. It is one
  table rather than two copies of the loop because two copies of that loop is precisely the
  shape that drifts.
- `jobCacheKey()` normalises the bake away and hashes the **definition**, through the same
  table, so the baked and unbaked forms of one job still hash identically and the cache bar
  still lights up.

The places that used to ask `kind === 'text'` to mean *"there is no source clock here"* now
ask `isCanvasClip()`. A third canvas-drawn kind is one entry in `CANVAS_KINDS`.

#### The unit rule, again

Every length is a fraction of the frame's **shorter side** and every position a fraction of
W and H. Never a pixel count — `pxMin()` converts at draw time against whatever size is
being painted, exactly as `fx.js` does. **Font sizes go through it too**, and that is not a
detail: a chart authored with a 24 px axis label would put its labels in a different place
at 540×960 than at 1080×1920, so the preview would lie about the export in the one part of
a chart that is supposed to be exact. `smoke-graphics.js` paints a bar chart at 1× and 3×
and asserts the whole inked box — labels included — scales by three.

#### One scale places marks, ticks and labels

This is the whole of a chart's correctness, and it is one function, `Graphics.scale()`:

```js
const sc = Graphics.scale(values, { ticks: 4 });   // { min, max, step, ticks, at(v) }
```

Nothing in a chart may compute a position from a value any other way. The moment a label is
placed by a second calculation it starts naming a number the bar does not reach. Two
promises hold, and both are asserted over seven deliberately awkward series:

- `at(min)` is 0 and `at(max)` is 1, so a mark cannot fall outside the plot;
- every tick is inside `[min, max]`, so **every label names a value the chart reaches**.

Two traps it exists to have already hit. Ticks are built by **multiplying the index** by
the step rather than by repeated addition — 0.1 added thirty times is not 3, and a tick at
2.9999999999 formats as "3" while sitting a pixel off the gridline it labels. And the
decimal count for a label is read off the **step's own spelling** rather than from its
logarithm: a step of 0.25 needs two places and `ceil(-log10(0.25))` says one, which prints
"0 0.3 0.5 0.8 1" — two of those label nothing.

A flat series (every value equal, zero included) still gets a usable range, or `at()` would
divide by zero and every bar would be drawn at the same nonsense height.

#### Entry timing is one calculation

`Graphics.stagger(params, t, i)` answers how far into its entry the `i`th mark of an object
is, and every type calls it — a lower third staggers its plate against its type, a bar
chart staggers its bars, a node map staggers each edge behind the node it arrives at. The
stagger is a **delay per mark, not a compression**: every mark travels the same curve over
the same length of time and the group simply arrives in order. `inDur` of 0 is a hard cut
**on** — it must answer 1 at the instant it lands, or the mark would flicker on its own
arrival.

#### A diagram is one clip, laid out from a spec

`Graphics.layoutDiagram(type, spec)` is a **pure function returning normalised coordinates**
— no canvas, no W, no H. That is what makes "identical across two runs and two resolutions"
something the suite can assert rather than hope for: the layout does not know what a
resolution is, so it cannot vary with one. Every position is computed from an index, and
node columns come either from an explicit `col`/`row` or from a breadth-first walk of the
edge **array** in written order — never from an iteration order a `Map` could reshuffle.

A spec is invalid JSON for most of the time it is being typed, so an unparseable one falls
back to the type's example layout and the panel says so, rather than the object blinking
out between keystrokes. A cycle still lays out; an edge naming a node that does not exist
is dropped rather than drawn to nowhere.

#### Position is an effect, not a parameter

A graphic's own model holds **shape** and deliberately no transform, rotation or anchor.
Graphics are in `FX_KINDS`, so a graphic carries an ordinary effect stack, and a
`transform` effect is what moves, scales, rotates and fades it — and a `transform` is the
thing that carries a motion-track `bind`. So "this callout sticks to that moving button",
across clips, with the offsets, the follow strength and the smoothing step 11 built, costs
nothing here: it is the binding that already exists, tested by the suite that already tests
it. A second implementation in `graphics.js` is the thing this arrangement refuses.

#### An imported icon is path data, not a file

`icon` stores the `d` attributes of an SVG's `<path>` elements plus its viewBox, as strings
on the clip. Not a path to a file, which can move, and not the bytes, which would put a
megabyte of base64 into every undo snapshot and into the `.scut`. `svg:pick` in main hands
back the file's **text** (capped at 2 MB — an .svg that large is an embedded image, which
this cannot draw) and `Graphics.svgPaths()` pulls the paths out. Anything other than
`<path>` is out of scope, and an SVG with none is refused rather than half-drawn: the
`icon` type paints a placeholder square when it has nothing, because an object that
silently draws nothing is the failure the effect panel's `needs` warnings already exist to
stop happening twice.

#### Bounds are analytic, and generous when they are unsure

Each type computes its painted extent from its parameters rather than by painting and
measuring, because `animatedBounds()` samples it fifteen times a second across the clip and
a `getImageData` per sample would be the slowest thing in the bake. A type whose `bounds()`
throws or answers nonsense falls back to the **whole frame**: that bakes a bigger sequence
than it needs and is always correct, while the other direction silently crops the object in
a way you only notice in the exported file. `smoke-graphics.js` paints every type and
asserts both directions — every inked pixel inside the declared bounds, and the bounds no
more than about six times the ink.

### Text cards

A text card is a clip of `kind: 'text'` whose whole definition lives in `clip.card`:

```js
TextCard = {
  text,                  // the string; 
 makes a new line
  style: { ... },        // TextModel.defaultStyle() - font, fill, shadow, glow, blur, ...
  animEnabled,           // master switch (the A shortcut)
  anims: [ AnimLayer ],  // combinable animation layers
  keys: { opacity: [Key], x: [], y: [], scale: [], rotate: [], glow: [] },
  highlight,             // optional per-word colour override: { color, words: [index] }
  words,                 // optional [{ w, start, end }] - spoken times, seconds into the clip
  wordFx                 // optional { reveal, emphasis, color, scale, rise, attack }
}

AnimLayer = {
  id, type,              // slide | zoom | fade | typewriter | flicker
  mode,                  // 'in' (appear) or 'out' (disappear)
  anchor,                // 'start' or 'end' of the clip
  start, duration,       // seconds, measured from the anchor
  easing,                // { kind:'bezier', p:[x1,y1,x2,y2] } or { kind:'named', name:'bounce' }
  motionBlur: { on, strength, samples },
  params                 // per-type: direction/distance, zoom amount, typewriter unit, ...
}

Key = { t, v, ease }     // t is seconds into the clip - see "Keyframes" above
```

Keyable properties are `opacity`, `x`, `y`, `scale`, `rotate` and `glow` (a multiplier
over the whole glow effect, so a card can bloom up and back down). The keys themselves,
and the easing curves an `AnimLayer` uses, are `Anim`'s — see "Keyframes" above. Unlike
an ordinary clip, a card's `keys` object always exists with all six tracks in it, because
`defaultCard()` has always made it that way and the presets round-trip that shape.

#### Editing several cards at once

The panel itself stays **single-card**: it reads one card and writes one card, and knows
nothing about the selection. `selectedTextClip()` hands it the **lead** — the first selected
text clip in timeline order — and `syncTextPeers()` mirrors what changed onto the rest.

Only the properties that **actually changed** travel. `cardDiff()` walks the lead's card
against a snapshot taken at the start of the gesture and copies just those paths. Applying
the lead's whole card would be far simpler and quite wrong: selecting five differently
styled cards and nudging the size by one pixel would flatten four of them to the lead's
look. Arrays (`anims`, gradient stops, a keyframe track) are leaves — adding an animation
layer is one change to `anims`, not a per-index reconciliation — and each card gets its own
deep copy rather than a shared array.

`TEXT_PEER_SKIP` is what never propagates: `text`, `words` and `highlight`. All three are
**content**, not look. Copying them would give every caption the lead's wording and the
lead's word timings, which is the one thing a multi-selection of captions must not do.

The header says *"N cards - editing all"* so it is never a surprise, and a fresh selection
re-takes the baseline — otherwise the first edit would replay every difference between the
old lead and the new one across the whole selection.

#### The typewriter

`params` is `{ unit, effect, distance, overlap, order, scaleFrom }`. `unit` is `char` or
`word`; `effect` is what each unit does (`none`, `fade`, `up`, `down`, `left`, `right`,
`pop`); `overlap` is how many units are mid-animation at once; `order` is which end the
sweep starts from; `scaleFrom` is the `pop` size.

**A card can carry more than one typewriter layer** - typically one that types in and one
that types out - and they act on the same units. `typewriterStates()` returns them all and
`combineUnit()` composes them per unit (alpha and scale multiply, offsets add), so the two
never need to know about each other. It used to `.find()` the first matching layer, which
meant a type-out layer did nothing whatsoever.

Two axes of control that are easy to get backwards:

- **`order`.** `forward` means the sweep starts at the first unit. On the way in that is
  "appears left to right"; on the way *out* it is "vanishes left to right", because the
  first unit is the first to be removed. `backward` starts from the last unit.
- **Direction sign.** A named direction is where a unit *arrives from* going in, and where
  it *leaves towards* going out, so `unitTransform` flips the offset for an out layer.
  Without that flip a card typed out with "slides up" sinks back down instead of lifting
  away.

`scaleFrom` below 1 grows a unit into place (and shrinks it away on an out layer); above 1
drops it in oversized (and balloons it away).

Two more things about it are deliberate:

- The **layer easing is applied per unit, not to the sweep**. The sweep across the line is
  linear and each letter runs the chosen curve, which is what makes `bounce` or `back`
  look right. `TextDraw.typewriterState` returns the raw progress for exactly this reason.
- Line wrapping always uses the **full** text, even mid-reveal, so letters appear in place
  instead of the lines reflowing under them as they type.

`measure()` turns this into an `items` array - one drawable per line normally, one per
unit while a typewriter is running - and every paint pass iterates those items. That is
what lets motion blur cover per-letter animation for free: the per-unit transform is a
function of `t` like everything else, so temporal sampling just works.

**Composition rules** (`TextModel.evalCard`), worth knowing before adding an effect:

- Layers **combine**: opacity and scale multiply, offsets and rotation add. So slide + zoom
  + fade all applied at once behaves the way you would expect, in any order.
- Outside its window a layer holds its *end* state: an `in` layer stays finished, an `out`
  layer stays un-started. That is what lets an in and an out layer coexist on one card.
- Keyframes ride **on top of** the layers with the same rule (multiply opacity/scale, add
  position/rotation). A property with no keys is untouched, so keyframes are opt-in
  per property.

**Drawing** is entirely in `TextDraw` and it is the single source of truth: the preview
calls it, and the exporter calls it to bake frames. Do not add a second text drawing path
or the preview will stop matching the render. Painting order per frame is glow passes →
shadow pass → crisp fill + stroke + decorations, with `ctx.filter` blur wrapped around the
lot.

**Glow** paints in two places, and both matter:

- the halo *behind* the glyphs (`intensity` passes of `shadowBlur`), and
- `glow.over`, a bloom composited **on top of** the glyphs with `lighter`, so the glow
  reads as emitted light rather than a coloured drop shadow.

The bloom is composited inside the card's own offscreen layer and only then drawn onto the
target. It must stay that way: the preview draws over the video frame while the exporter
draws onto transparency, so an additive pass applied straight to `ctx` would blend
differently in the two cases and the preview would stop matching the MP4.
`tools/smoke-text2.js` checks that the glyph pixels come out identical over transparency
and over an opaque background.

**Motion blur** is real temporal sampling, not a blur filter: the card is drawn at
`samples` instants across the shutter and averaged. The averaging is
`Anim.temporalAverage()` — see "The shutter" below, which every motion-blurred thing in
the app shares. Two rules:

1. The averaging **must** be additive - each sample is painted into a scratch canvas, then
   composited into an accumulator with `globalCompositeOperation = 'lighter'`. Compositing
   the samples straight onto the target with source-over at `1/n` converges to
   `1-(1-1/n)^n` (~63%) and visibly washes the text out; a static-card test guards this by
   requiring full opacity back.
2. The shutter is **slid to stay inside the clip**, never centred past its ends. A centred
   shutter at `t=0` puts half its samples at negative time, where every animation clamps to
   its start state - those samples all stack in one place and punch a sharp, saturated copy
   through the middle of the blur. That was the "first frames are crisp, then it blurs"
   bug, and it hit shadow and glow alike. Note the taper at the *end* of a layer is not the
   same thing: there the card really is coming to rest, so a partial smear is correct.

**Fonts** come from `listFonts()` in `main.js`, which asks PowerShell for
`InstalledFontCollection` family names (real family names, which is what canvas needs),
falling back to the font registry key and then to a small built-in list.

### Rendering text into the MP4

ffmpeg's `drawtext` cannot do gradients, glow, per-letter typewriter or bezier easing, so
text is **baked**: `bakeTextClips()` in `app.js` draws each card to frames and
`buildArgs()` feeds them to ffmpeg overlaid with alpha.

**The frames are raw RGBA, not PNGs, and that is not a detail.** `canvas.toBlob(...,
'image/png')` costs 100-1500 ms for a single large frame with a lot of alpha detail - a
glowing, motion-blurred title card is the worst case. At 30 fps that made a four second
card take minutes, and it was the entire reason renders felt slow; drawing the frame was
never the problem (9 ms). `getImageData` costs about 4 ms. Measured on one heavy card:

```
                    PNG    WebP lossless   WebP q0.92   raw RGBA
per 1080x1146 frame  115ms      269ms         460ms        4ms
```

So each card writes one `frames.raw` stream and ffmpeg reads it with
`-f rawvideo -pixel_format rgba -video_size WxH`. Raw frames are bulky (w*h*4 per frame)
but they are scratch, deleted in the `finally` of the render - what gets cached is the
finished MP4. Do not "optimise" this back into an image format.

- The frames are cropped to `TextDraw.animatedBounds()` — the union of the painted bounds
  across the whole clip — so a small caption writes small PNGs instead of one full-frame
  image per frame. `overlay` then places them back at `bx,by`.
- Text overlays use `eof_action=pass`, **not** `repeat` like video clips: when a card's
  frames run out the base must show through, or the last text frame would stick.
- Text overlays are **cached on disk**, so reviewing an edit does not redraw frames that
  cannot have changed. See below.
- Cost when the cache misses: one PNG encode per frame per card. A 3 s card at 30 fps is
  90 encodes, a couple of seconds.

### The shutter

Three things in the app blur by sampling across time — text cards, the transition object,
and the swipe's plate deform. All three call **`Anim.temporalAverage()`**, and there is
exactly one implementation because the naive one is wrong in a way that is very hard to
see.

**The trap.** The obvious way to average `n` painted samples is to composite each onto one
accumulator with `lighter` at `globalAlpha = 1/n`. Canvas quantises every draw to 8 bits
*before* adding it, so a pixel of alpha `a` contributes `round(a / n)` — which is **zero**
for every pixel with `a < n/2`. At 16 samples everything below alpha 8/255 disappears; at
32 samples, everything below 16/255.

A glyph sits at alpha 255 and sails through, so the text smeared correctly and looked
fine. A **glow** and a **drop shadow** live almost entirely in that faint range, so they
were not blurred — they were deleted, and deleted harder the more samples you asked for.
The symptom was a card whose glow and shadow did not react to motion blur at all: turning
the sample count up made them *worse*, and the blurred shadow came out **narrower** than
the un-blurred one.

**The fix** is to average in two levels. The samples are split into roughly `sqrt(n)`
balanced groups; each group averages its own members at `1/groupSize`, then enters the
accumulator weighted by how many samples it holds. The weights still sum to exactly one —
this is the same mean, not a fudge — but the smallest alpha any quantisation sees is about
`1/sqrt(n)` instead of `1/n`. At 32 samples that is a 3/255 cutoff instead of 16/255.

Measured on a card with a 60px drop shadow, sliding, at 16 samples and strength 2:

| | shadow body (columns ≥ alpha 100) | glow spread (columns ≥ alpha 2) |
| --- | --- | --- |
| no motion blur | 109 | 256 |
| old, 16 samples | 68 — *narrower than unblurred* | 277 |
| old, 32 samples | 100, and falling | 259 — *collapses again* |
| now, 16 samples | 126 | 297 |
| now, 32 samples | 126 | 299 |

Two properties worth keeping, both asserted in `tools/smoke-mblur.js`:

- **Sample count is a quality knob, not a look knob.** How much shadow there is must not
  change when you ask for more samples. It used to change by 20%.
- **Strength still drives the spread.** More shutter means more smear, on the glow and the
  shadow as much as on the glyphs.

The grouping costs one thing: the average is exact to within **one 8-bit level** rather
than exactly exact, because the group weights are rounded per draw and a sample count that
does not divide evenly (31 into 6 groups) can land a single level low. One part in 255 on
a flat field is a fair price for everything below alpha 16 coming back.

`temporalAverage()` takes the caller's own canvas pool (`offscreen` in `text/draw.js`,
`surface` in `transitions.js`) and a `tag`, so nothing allocates a canvas per frame and
two callers cannot collide on one scratch surface.

### The bake cache

`bakeTextClips()` keys each sequence with a hash of everything that can change the baked
pixels - the card itself, the output size, the fps, the clip length and the crop box - and
`text:seq` in the main process hands back either a fresh empty directory or an existing
complete one (`cached: true`), in which case nothing is redrawn at all. A warm cache turns
a ~2.8 s bake into ~12 ms.

What goes in the key is the whole point: **the card's position on the timeline must not**,
because moving a card cannot change a single baked pixel - only where ffmpeg overlays them.
Adding something to the key that does not affect the pixels silently destroys the hit rate;
leaving out something that does affect them serves stale frames. There are tests for both
directions.

#### The cache bar

The strip along the bottom of the ruler shows, in green, which spans of the timeline have
a valid cached render. `refreshCacheBands()` reads the index of cached renders, rebuilds
the job for each recorded span, and keeps the band only if the hash still matches - so a
band vanishes the moment anything inside it is edited and comes back if the content is put
back. It is a live readout of what a render would actually have to re-encode.

`jobCacheKey()` (renderer) and `jobKey()` (main) must agree, so the renderer computes the
key and sends it along. Two rules keep them agreeing:

1. Take the key **before** `bakeTextClips()`. Baking swaps each card for a `seqDir` and
   drops `textClip`; a job built fresh for the cache bar still has the card and no
   `seqDir`. Hashing them raw yields different keys for identical content, and the bar
   never lights up.
2. `jobCacheKey` normalises the bake artefacts away and hashes the **card** instead, so
   the baked and unbaked forms of the same job hash identically.

Entries live under `userData/cache/text/` with a `manifest.json` marking them complete
(a half-written sequence is never reused). The cache is pruned oldest-first once it passes
~1.5 GB, and the Render panel has a **Clear cache** button plus a size readout.

### Transitions

A transition sits on a **cut** - two clips on the same video track whose edges touch. It is
stored on that track as `{ id, type, aId, bId, duration, align, easing, motionBlur,
params }`, keyed by the two clips rather than by a time, so it follows them when they move.
`resolveTransition()` returns null the moment those clips stop touching, which makes a
stranded transition inert rather than wrong; it comes back if they meet again.

#### How they render, and why

The exporter **bakes the whole transition window into one opaque full-frame layer** and
overlays it, reusing the raw-RGBA machinery built for text cards. It never asks ffmpeg to
blend the two clips.

That is the important design decision. Asking ffmpeg to do it (`xfade` and friends) would
mean overlapping the clips in the filter graph, pulling frames from outside each clip's
trimmed range, and animating a mask - and even then a real blur or a burn threshold is out
of reach, so the preview could never match. Baking sidesteps all of it: in the renderer a
`<video>` can be seeked anywhere in its source, so the handles either side of the cut come
free, and `Trans.draw()` paints exactly what the preview paints. The cost is two video
seeks per baked frame, which is nothing for a window measured in tenths of a second.

`Trans.draw(ctx, W, H, tr, p, aImg, bImg, frameDur)` is the single entry point. It takes
the outgoing and incoming frames already framed (cropped and panned) as images, so it never
needs to know where they came from - the preview hands it live video elements, the baker
hands it canvases.

#### The three types

- **Blurred swipe** - both clips blur as they swap, peaking mid-transition, revealed
  through a feathered edge. Directions are left/right/up/down plus zoom in and zoom out
  (a growing or closing disc).

  **It smears and stretches, it does not only blur.** A gaussian blur is symmetric and
  reads as "out of focus"; a whip pan does something else - it drags the picture along an
  axis and squashes it as it goes. `deform` is how far the drag travels (1 spreads it
  over a quarter of the frame) and `stretch` how much the plate is scaled along the axis
  while it does. Both peak at `sin(pi*e)` with the blur, so the frames at either end of
  the window are the untouched clips.

  It is **real directional sampling, not a filter**: the padded plate is drawn
  `deformSamples` times, each copy offset and scaled a little differently, and the copies
  are averaged. Two rules, both the same ones the text cards' motion blur lives by:

  1. The averaging is **additive**, through `Anim.temporalAverage()` like every other
     motion blur here. Source-over at `1/n` converges to `1-(1-1/n)^n` (~63%) and visibly
     washes the picture out; there is a flat-white-plate test for exactly that.
  2. The offsets run **symmetrically about zero** (`u` in -0.5..0.5), so the picture
     smears in place. Running them from 0 outwards moves the average off its own centre
     and the picture slides sideways as well as smearing.

  `deformAxis` is `auto` by default, which takes the axis from the wipe direction -
  left/right smears in x, up/down in y, a zoom smears radially (there the offset has
  nowhere to go, so it feeds the scale and the plate breathes about the centre). That is
  what makes the deform read as part of the movement rather than an effect on top of it.
  `grow` has to cover the smear as well as the blur, or the drag pulls transparency in
  from past the plate edge.

  **A blur must not magnify the picture.** `filter: blur()` samples past the edge of what
  it is drawing and pulls in transparency, which fades the border out. Covering that by
  drawing the frame oversized - `drawImage(img, -grow, -grow, W + grow*2, H + grow*2)` -
  is the obvious fix and the wrong one: it scales the picture up by `(W + 2*grow) / W`,
  about 15% at the default blur and far more further up the slider. Because the blur peaks
  mid-transition the magnification peaks with it, so every swipe zoomed in and back out
  whichever direction it was set to - loud enough that the wipe underneath was lost and all
  six directions looked like the same zoom. `drawBlurred()` instead pads the plate by
  extending its edge pixels outwards, blurs that at 1:1, and crops the middle back out.
  Crop *after* blurring, never before - cropping first just moves the transparent edge
  inwards and undoes the padding.
- **Film burn** - a warm light leak blooms across the frame, washes it out, and falls back
  through ember colour to nothing. See below.
- **Object** - a PNG that sweeps or zooms across, with the clips cutting underneath it at
  `switchAt`. `offsetX`/`offsetY` shift the whole path within the frame without changing
  how far it travels, and `fadeIn`/`fadeOut` (fractions of the window, 0 = off) fade it in
  and out. It has the full easing curve and real motion blur (the same temporal sampling
  the text cards use).

**Masks carry alpha, not luminance.** `destination-in` composites on the *alpha* channel,
so a mask painted as opaque black-and-white masks nothing at all - the incoming clip simply
covers the outgoing one for the whole window. Every mask here paints
`rgba(255,255,255,1) -> rgba(255,255,255,0)`.

#### The film burn

The burn is a **light leak, not a burn-through**: the clips hard-cut under a warm bloom
rather than one dissolving into the other through a mask. `drawBurn()` is three layers.

1. The clips, cross-faded over a short window centred on `peakAt`.
2. The leak, added over them with `lighter` - the way light hitting film actually behaves.
3. A white bloom, `flash * v^4`, which peaks exactly where the clips swap.

That ordering is the whole trick: **the cut is hidden because it happens at the brightest
frame**, not because it is feathered. It is how the effect works on real film, and it is
why the transition needs no mask at all.

**The leak is a band that travels.** It enters by one side, sweeps across, and leaves by
the far side - it never folds back the way it came. Two things drive it, and which one
drives which is the whole point:

- **Position** comes from *progress*. The band centre crosses the middle of the frame
  exactly at `peakAt` and keeps going, the two halves running at different speeds so the
  leak arrives quickly and leaves slowly. Progress only ever increases, so the band can
  only ever advance.
- **Heat** comes from `leakEnvelope(e, peakAt)` - a fast smoothstep attack to a single
  peak and a slower `(1-s)^2.2` decay, measured off real film-burn footage, which ramps to
  white in about a quarter of the effect and takes twice as long to fall back to black.
  `amp = v^0.6` curves it so the ember colours, which sit in the middle of the ramp, get
  most of the window instead of being rushed through on the way to white.

Driving the *position* from the envelope is the bug to avoid: the envelope rises and then
falls, so the leak advanced to the middle and then retreated back out the side it came
from. It has to be driven by progress. Keeping heat separate is what makes the leak walk
the whole ember ramp - deep red, then the ember colour, then gold, then the hot core -
instead of jumping straight to white the moment it appears.

**The streaks are seeded, never random.** The preview and the bake build the striation
texture independently, so `Math.random()` would make them disagree - the export would
streak differently from the preview. `streakMap()` is also built at a fixed small size
rather than the frame size, so the same seed gives the same streaks at preview resolution
and at export resolution.

#### Adding one

`T`, the **+ Transition** button, or a double-click near a cut - all three land a
transition on the nearest cut and select it. Drag either end on the timeline to change the
length; the cap in `maxTransitionDuration()` stops it running past either clip.

#### One bad frame must not brick the editor

`loop()` re-arms its animation frame in a `finally`, and that placement is load-bearing.
It used to re-arm only *after* `drawPreview()` returned:

```js
drawPreview();
requestAnimationFrame(loop);   // never reached if the draw throws
```

so a single throw anywhere in the draw path stopped the loop permanently - the playhead
froze, the viewer stopped repainting, and nothing on screen said why. It reads exactly
like a hang. A bad frame now costs a frame, the fault is logged once per distinct message
rather than at 60fps, and the loop recovers on its own when the cause clears.

**Canvas is unforgiving about numbers, and the burn is all numbers.** A non-finite
coordinate makes `createLinearGradient` throw, and a NaN that reaches a colour string
makes `addColorStop` throw on `rgba(NaN,NaN,NaN,NaN)`. Both were reachable, and both
killed the loop. Everything numeric the burn hands to canvas now goes through `num(v,
fallback)` first; nothing there may take a number on trust.

#### Keeping parameters complete

`Trans.normalize(tr)` fills in anything a transition is missing for its **current** type,
from that type's defaults, without overwriting a value that is already there. It runs when
the inspector builds a panel and when a project loads.

It exists because changing the type keeps `params` - which is what you want when flipping
back and forth, since each type's settings survive the round trip - but leaves the incoming
type's own parameters absent. The symptom is not an obviously blank panel: an
`<input type=range>` handed `undefined` silently shows its **midpoint**, and a colour input
shows **black**, so the inspector displayed plausible-looking values that were not what was
drawing (the draw path has its own `== null` fallbacks). A project saved before a parameter
existed hits the same thing. Anything reading `tr.params` for the UI must normalize first.

#### Presets

Transitions share the preset library with text cards, under a fourth kind, `trans`.
`Trans.extractPreset()` deliberately drops `id`, `aId` and `bId`: a preset is a *look*, and
carrying another transition's clip ids would attach it to the wrong cut. `applyPreset()`
starts from the type's defaults so a preset saved before a parameter existed still yields a
complete, drawable transition.

### Preview resolution

`state.previewScale` (Full / 1/2 / 1/4 in the toolbar) sets the size the viewer works at.
`previewSize()` is the single source of truth and everything that draws asks it - the
canvas, the frame cache, `drawClip`, `drawTextLayer` and `buildPreviewJob`.

It is a per-pixel saving on both halves of the work: compositing and baking. The same
heavy card measured end to end:

```
full 1080x1920   bake 25.7s   encode 1.4s
half  540x 960   bake 17.4s   encode 0.9s
quarter 270x480  bake  3.1s   encode 0.6s
```

Two things to keep right when touching this:

- The crop aspect in `drawClip` comes from the **output** size, not the preview canvas, or
  the framing would stop matching the render.
- `TextDraw` scales its sizes off the frame height, so a smaller canvas gives a
  proportionally smaller card with identical layout - nothing else needs adjusting.
- A span rendered at one scale has different pixels from the same span at another, so its
  cache key changes and its band correctly disappears when the scale changes.

### Preview renders - what the viewer plays

There are two different render actions and confusing them is the easiest mistake to make
in this codebase:

| Action | Key | Writes to | Purpose |
| --- | --- | --- | --- |
| **Render preview** | `Ctrl+R` | the app's own cache (`userData/cache/render/`) | the viewer plays it back instead of compositing |
| **Export...** | `Ctrl+Shift+R` | wherever the save dialog points | producing a deliverable file |

A preview render has **no destination of its own** - `job.preview = true` makes main render
straight into the cache entry, so reviewing never leaves stray MP4s in the user's folders.

The payoff is in the viewer, not on disk. `activePreviewBand()` finds the rendered span
under the playhead and `drawPreview()` draws a frame decoded from that file, skipping the
whole composite - no per-frame crop, text draw, glow or motion blur. `syncPreviewBand()`
drives it like any other media element and, while it is on screen, `syncMedia()` pauses
every source clip: the rendered file already contains the mixed audio, so leaving the
sources running would double it up.

`P` toggles the whole behaviour, which is also the way to compare a render against the
live composite.

#### The picture is parked under a band; the audio is not

`syncMedia()` silences the source clips while a rendered span is on screen, but the two
kinds are silenced differently, and the difference is the whole quality of the hand-off at
the far edge.

The **picture** is parked. Decoding video nobody can see is exactly what a rendered span
exists to avoid, and a cold first frame at the edge is covered by `frameCache`.

The **audio keeps running, muted**. Pausing it used to abandon its clock: an audio element
sat paused at wherever it happened to be — usually 0 — for as long as the band played, and
the moment the playhead left the band `syncMedia()` needed that element *at* the playhead.
On a 0–2 s band that meant a cold two-second seek: `readyState` fell from 4 to 1, about
300 ms of silence, and the element came back roughly 150 ms behind — under the 0.3 s
correction threshold, so nothing ever closed the gap. Cross a few edges and each cold seek
starts before the last has finished, and it degenerates into no audio at all.

Kept running and muted, leaving the band is an **unmute**: no seek, no decode hole, and
already in sync because it never stopped tracking. Measured on a real project, the same
edge goes from `rs4 → rs1` with a 300 ms hole to `rs4` throughout with the offset holding
at 0.02–0.04 s. The frame loop stops lurching too — it was lurching *because* of the seek
thrash, not independently of it.

`smoke-previewrender.js` asserts both halves: playing-and-muted under the band, unmuted
with `readyState >= 2` and still in sync on the far side.

Two rules keep this working:

- **`preview` must not be part of the cache key.** How a render was triggered has nothing
  to do with its pixels. Leaving it in gives the same frames two different keys: the cache
  bar never matches a preview render (the symptom that made it look like the cache was
  broken), and exporting a span you had already previewed encodes it a second time.
- A span's player is dropped by `prunePreviewEls()` as soon as its band stops being valid,
  or the viewer would keep showing a stale render of edited content.
- **`pause()` has to stop the span players too.** They are not in `mediaEls`, and
  `syncMedia()` - the thing that would otherwise pause them - only runs while playing. Miss
  this and Stop does nothing to a rendered span: it plays on with no way to halt it.
- **Starting a render stops playback**, and that is not a courtesy. See below.

#### A render stops playback, because the baker borrows the viewer's elements

`bakeComposite()` draws its frames from `mediaFor()` — the viewer's **own** element per
clip, the same one `syncMedia()` keeps parked under the playhead. There is one element per
clip by design; a second decoder per clip is exactly what the pool exists to avoid. So the
baker can only *borrow* it, and it cannot borrow what is still in use.

Left playing, the two fight over every element: the baker seeks one back to its bake
frame, the next turn of `loop()` seeks it forward to the playhead, and neither gets what it
asked for. **The audible half is worse than the visible half**, which is why this is worth
its own section. Baking one frame is a full-resolution composite plus an 8 MB
`getImageData`, and the loop only yields every fourth frame — so `requestAnimationFrame`
starves, `syncMedia()` stops running anywhere near frame rate, and the audio elements drift
out from under a playhead that is still advancing in real time. Each drift ends in a large
corrective seek. That is the stutter; and the render finishes with those elements parked
mid-seek, which is the silence.

`doPreviewRender()` and `doRender()` therefore both call `pause()` before baking.
`smoke-previewrender.js` asserts it by sampling `state.playing` *during* the bake, because
a regression here fails nothing else in the suite — the render is still correct, the cache
band still matches, and the only symptom is that the app sounds broken while you use it.

### Rendering a range

The in/out marks (`I`, `O`, `X` to clear) bound what a render covers. `buildJob(outPath,
range)` crops every clip to the range and shifts it so the range starts at zero:

- a clip cut at the head has its `in` point moved by the amount removed;
- a clip cut at the tail has its `out` pulled back;
- a **text card** cut at the head also gets `tStart`, because a card's animation is timed
  from the card's own start and not from a source in-point. Without it, a range beginning
  mid-card would bake the animation from the beginning and the card would restart.

`Render full` renders the same range but sets `useCache: false`, forcing a real encode.

This is the feature that actually makes review fast. The caches below only help when
nothing changed, and the whole point of reviewing is that something did - so rendering the
five seconds you are looking at, rather than the whole timeline, is what removes the wait.

### Caching a finished render

There are two caches and they cover different halves of an export:

| Cache | Removes | Key |
| --- | --- | --- |
| renders (`cache/render/`) | the ffmpeg encode | the whole job **except** `outPath` and `preview` |

(There used to be a second cache for baked frames. Raw frames made baking cheap enough
that caching hundreds of megabytes of them was the worse trade, so it was removed.)

**A text job must carry a `cacheKey` from the renderer, or it is not cached at all.**
After baking, a card has been replaced by a scratch directory with a random name: hashing
the job as-is gives a different key every render (never a hit), and stripping the name out
would let two different cards collide (a wrong hit). `jobKey()` in main returns `null` for
a keyless text job rather than guess, so the caller simply gets no caching.

The frame cache alone was not enough. Measured on a 6 s project with one card:

```
cold  bake 5748ms  ffmpeg 2770ms  total 8518ms
warm  bake   13ms  ffmpeg 2781ms  total 2794ms   <- frame cache only
warm  bake   12ms  ffmpeg   16ms  total   28ms   <- with the render cache
```

ffmpeg re-encoded the entire timeline every time, which is most of the wait on an edit
that is not text-heavy. `render:start` now hashes the job (`jobKey()` in `main.js`) and
copies a previously produced file when nothing that affects the pixels has changed.
`outPath` is deliberately excluded so re-rendering to a new filename is still instant, and
a `cached: true` comes back so the UI can say so. Finished renders are pruned oldest-first
past ~3 GB; **Clear cache** in the Render panel empties both caches.

### Quitting with unsaved work

The unsaved-changes prompt lives in `win.on('close')` in **main**, and the renderer mirrors
`state.dirty` over to it via `app:setDirty`.

This must not move back into the renderer. A `beforeunload` handler that calls
`preventDefault()` does not raise a dialog in Electron - it just silently refuses to close,
which is exactly why the window used to ignore the quit button until the project had been
saved. "Save and quit" sends `app:requestSave` to the renderer, which saves and reports
back through `app:saveResult`; a cancelled save leaves the window open.

**One dialog at a time.** The close handler is `async`, so `close` can fire again while
the dialog from the last one is still open — Alt+F4 twice, the title-bar X twice, or a
quit from the taskbar on top of either. Each of those used to open *another* dialog on top
of the first, and since answering one only closes the window when it sets `allowClose`, the
app looked like it was refusing to close and would not go away until every stacked copy had
been dismissed. An `askingClose` flag now swallows the repeats.

**A smoke instance never asks, at any point in its life.** `allowClose` is set just before
`app.quit()` on the smoke path, which covers the orderly exit and nothing else. A run that
is *killed* part-way through leaves an orphaned electron with a dirty project and no
`allowClose`, and the first time anything asks it to close it raises the unsaved-changes
dialog and sits on it — a window nobody can get rid of without answering, from a run
nobody is watching. The guard now returns immediately when `SHORTCUT_SMOKE` is set.

**A capture in flight holds the app open three ways**, and `before-quit` tears down all
three: the hidden recorder window is a `BrowserWindow`, so `window-all-closed` never fires
while it exists; the cursor sampler is a live `setInterval`; and the click watcher is a
PowerShell child. That teardown is deliberately blunt and drops the recording —
`finishRecording()` is the orderly path that writes the sidecar, and this one runs when
there is no longer time for it. A half-written `.webm` beats a process that will not exit.

### Presets

Five kinds share one library (`PRESET_KINDS` in `main.js`): three text flavours, split by
`TextModel.extractPreset(kind, card)` — `style` (look only), `anim` (layers + curves +
keyframes), and `full` (both, plus the text) — plus `trans` for transitions and `audiofx`
for a whole audio chain. Each can be saved
to a named library under `app.getPath('userData')/presets/<kind>/` or exported/imported as
a `.json` file. `TextModel.applyPreset` merges a preset into a card and takes
`{ keepText: true }` so applying a style or animation preset does not clobber the wording.

Every kind follows the same rule: a preset carries what is portable and drops what is not.
A text preset drops the wording when asked, a transition preset drops the clip ids, and an
audio preset drops a duck's `voiceTrack` — a track id means nothing in another project, so
an applied duck comes back needing a voice track chosen, and the log says so rather than
silently ducking to nothing.

**A picked preset has to be remembered across the rebuild it causes.** Applying a preset
rebuilds the whole panel, which builds a *fresh* `<select>` sitting back on "Choose a
saved preset...". Every button that acts on "the preset selected above" — Delete, in
practice — therefore saw an empty value and did nothing, which is exactly what a broken
button looks like. `lastPreset` in `text/ui.js` (and `lastAudioPreset` in `app.js`, which
had the identical bug) holds the name across rebuilds and puts the box back on it. Saving
selects what was just saved; importing clears the selection, because an imported preset is
not in the library and leaving a name selected would aim Delete at the wrong file.

**"Apply to selected cards"** sits at the bottom of each preset box. The panel's ordinary
propagation carries only what *changed* during the current gesture (see `cardDiff`), which
is what stops a multi-selection being flattened by an accidental nudge — the right default,
and the wrong thing when you actually do mean "make these all look like this one". The
button extracts that box's payload from the lead and applies it to every other selected
card, as **one** undo entry, always with `keepText: true`: the wording and the word
timings are content, and copying the lead's across a selection of captions would give
thirty cards the same sentence. It is the same rule `TEXT_PEER_SKIP` enforces. The audio
chain panel needs no such button — a chain applied there already mirrors onto every
selected clip.

**`window.prompt()` does not exist in Electron.** It returns nothing and silently does
nothing, which is why saving a preset appeared to work and then never showed up in the
list. The preset panel uses an inline name field instead - do not "simplify" it back to a
prompt. `window.alert` and `window.confirm` *are* supported.

### Controls

Every numeric parameter is both a slider and a typable number box, and carries a reset
button back to its default. That is all handled by `control()` in `text/ui.js`: pass it a
`defaults` object (a pristine `TextModel.defaultCard()` for style rows, a fresh
`TextModel.defaultAnim(type, mode)` for animation rows) and the reset button appears
automatically. The slider clamps to its declared range; the number box does not, so an
author can type a value past the end of the slider when they mean it.

Text inputs inside the panel call `stopPropagation()` on `keydown`, otherwise the editor's
single-key shortcuts (`s` to split, `a` to toggle animation, and so on) would fire while
typing.

**`user-select: none` must not reach a form field.** `body` sets it (dragging clips around
a timeline with text selecting everywhere is horrible), and Chromium lets it inherit into
`<input>`. A field that inherits it looks perfectly normal, focuses fine from script, and
still refuses to take a caret from a mouse click - so the value is simply not typable. The
`input, textarea, select { user-select: text }` rule in `styles.css` exists solely for
that, and `tools/smoke-text2.js` asserts the computed value.

**Scroll to adjust.** `TextUI.attachWheel(el, {step, min, max, get, set})` puts wheel
nudging on a control: one step per notch, `shift` for ten, `ctrl`/`alt` for a tenth. It is
attached to both halves of every numeric row, to the keyframe value and time boxes, and
(from `app.js`) to the framing and volume rows, and to every audio effect parameter. It consumes the event so the panel does not
scroll out from under the pointer, rounds to whichever is finer - the increment or the
precision already in the value - and coalesces a burst of notches into one undo entry.

**Every gesture must end.** `beginEdit()` snapshots undo once per gesture and `endEdit()`
releases it. Sliders and colour swatches have no natural commit event, so `endEdit` is also
bound to `pointerup` on the document. Without that the flag sticks on after the first
slider drag and undo quietly stops recording everything afterwards - there is a test for
exactly that.

### Preview and playback

Every clip lazily gets its own `<video>`/`<audio>` element (`mediaFor()`, cached in
`mediaEls`). The rAF `loop()` advances the playhead from a wall-clock origin, then
`syncMedia()` plays/pauses/re-seeks each element that overlaps the playhead (re-seeking
only when drift exceeds 0.3 s so playback is not constantly stuttering) and puts each audio
clip's level and mute onto it through `applyPreviewMix()` - see "The audio chain" for what
the preview does and does not honour.

The canvas **composites every visible video track, bottom-up, with alpha**.
`activeLayers()` returns the clips under the playhead in the same order `buildJob()` walks
the tracks in - bottom track first - so a clip on V2 draws over V1, a semi-transparent
still lets what is underneath through, and a text card on V1 sits *below* footage on V2
exactly as it does in the render. Hidden tracks and locked-out kinds simply never enter
the list.

Compositing needs every layer at once, which is what `layerSurfaces` is for: one scratch
canvas per picture clip, holding its last successfully decoded frame already framed to the
output size, **cleared to transparent rather than black** so alpha survives. A `<video>`
that is mid-seek has no frame to give back, and a naive loop would drop that layer to
nothing the instant it started seeking - the old black-flash bug, except now it can punch
a hole in the middle of a stack. Holding the last good frame means a not-yet-decoded
element is *skipped*, not cleared, and there is a test for exactly that. If **nothing** in
the stack has a frame yet the canvas is left alone entirely; only a genuine gap (no
visible clips at all) paints black.

Three rules in here are load-bearing for a flicker-free preview, all learned the hard way:

1. `drawPreview()` repaints **only when the element actually has a frame**
   (`readyState >= 2 && videoWidth`). Clearing the canvas first and then bailing out on a
   not-yet-decoded element is what made the preview flash — or stick — black, since
   `readyState` drops on every seek.
2. `syncMedia()` never issues a seek while `el.seeking` is true. Stacking seeks kept
   `readyState` pinned low and the canvas dark.
3. `syncMedia()` pre-creates elements for clips within `PRELOAD_AHEAD` seconds of the
   playhead. Creating them only on arrival meant every cut began on an empty element.
   Elements more than `EVICT_BEYOND` seconds away are released again, so a long timeline
   does not hold a decoder open for every clip at once.

The playback clock is wall-clock time sampled from `requestAnimationFrame`, which is why
`backgroundThrottling: false` is set in `main.js`. Without it Chromium throttles rAF for
an unfocused window, the playhead freezes while the audio elements keep playing, and
picture and sound drift apart.

`webSecurity` is disabled in `main.js` so `file:///` media loads in the renderer. That is
acceptable for a local tool with no remote content; if you ever load remote pages, move
media through a custom protocol handler instead.

### Selecting

Clicking a clip selects its whole **link group**, so an imported A/V pair is one thing to
click and one thing to drag. Dragging on empty timeline draws a **selection box**
(`startMarquee()`): it catches every clip the box overlaps — overlap, not containment, so
a box drawn across the middle of a long clip includes it — in both time and track, then
extends what it caught to full link groups for the same reason clicking does. Locked
tracks are skipped, shift adds to the selection, and a press that never moves more than
3px is still a plain click, which on empty timeline clears the selection. Ctrl+drag stays
the playhead scrub.

`Ctrl+A` selects everything. A selection of several clips that all share one `linkId` is
**not** a multi-selection — `singleUnit()` treats it as the one pair it is, which is why
the inspector shows framing and audio for a clicked A/V pair rather than "2 clips
selected". A real multi-selection shows the count, and still offers Tighten, because
Tighten works over as many link groups as are selected.

### Selecting a track

Clicking a **track head** selects every clip on that track, extended to link groups exactly
as clicking a clip is. Shift adds a second track; a locked track selects nothing, since it
is locked against editing.

A track is deliberately **not** a third kind of selection — it *is* its clips. Tighten, the
audio chain and Captions all already work over a selection, so this one handler is the
entire feature and none of them had to learn what a track is. "Clean up this whole
voice-over track" is one click instead of a marquee that has to catch every clip on one
lane and nothing on the lane below.

The controls on the head (`Shown`/`Audible`, `Lock`, `Del`) `stopPropagation()` on
`mousedown`, so muting a track does not also select it.

### Close gaps

`closeGaps()` pulls the selected clips together: the selection is taken as link groups
ordered by start, the earliest stays put, and each later group slides left until it butts
against the end of everything before it.

Two rules make it predictable rather than clever:

- **Whole groups move, never halves.** Shifting the two halves of a pair independently is
  the same sync bug that Tighten's ripple is written to avoid.
- **It is local, not a ripple.** Nothing outside the selection moves, and groups that
  already overlap are left where they are — there is no gap between them to close.

One `pushUndo()` for the whole pass, and **none at all** if there was no gap to close: an
undo entry that restores an identical timeline is worse than no button at all.

### Snapping

`snapDetail(t, movingIds)` is the single source of truth: 0, the playhead, the in/out
marks, and every clip edge on **every** track that is not part of the group being dragged
— audio and video alike, so an audio clip snaps to a video cut exactly as a video clip
does. `snapTime()` is a thin wrapper for callers that only want the time.

**A caller must look at `hit`, not just the distance.** A miss returns the raw time, so
its "distance" is zero. `startMove()` compares two candidates — the head of the dragged
clip and its tail — and picking the nearer one by `|snapped - raw|` alone let the *miss*
beat the real snap every time: unless both edges happened to land on something at once,
snapping quietly did nothing while looking like it was on. That was the "audio clips
don't snap" bug (it hit every clip; audio is just where it was noticed, since an audio
clip is usually the one being lined up against a cut). `tools/smoke-bin.js` drags a clip
through the real handlers and asserts both edges snap.

### Waveforms

Audio clips draw a waveform, and the peaks belong to the **source file**, not to the clip:
`Wave.peaksFor(src)` decodes once into 2048 buckets across the whole file, and a clip
simply draws the slice between its `in` and `out`. Splitting, trimming or duplicating a
clip therefore costs nothing.

- Decoding is asynchronous and never blocks a redraw. `peaksFor()` answers immediately
  with whatever it has - possibly nothing - and the clip draws plain until the decode
  finishes; `Wave.onReady()` then asks the lanes to redraw, coalesced, because importing
  a folder finishes a great many decodes at once.
- The peaks are cached in `userData/cache/wave/`, keyed by path + size + mtime, so a file
  seen before is ready on the first frame after a project opens.
- A file the renderer cannot decode gets **no** waveform and is not retried. Not being
  able to draw one is never a reason to break the timeline.
- `renderLanes()` runs on every mouse move while a clip is dragged, so painted canvases
  are cached by clip + slice + size and the same element is moved into the rebuilt lane.
  Repainting a couple of thousand `fillRect`s per clip per frame is what that avoids.

### The QuickBin

A media library that outlives the project: it lives in `userData/quickbin.json`, **not**
in the `.scut`, so the same clips, music and stills are in front of the user in every
project. `src/renderer/quickbin.js` is a plain `<script>` global like `TextUI`, wired up
through the hooks passed to `QuickBin.init()` in section 10 of `app.js`, and it touches no
`app.js` global.

- **Nothing is copied.** An entry is a path plus the probe result. That keeps the file
  tiny and leaves media where the user put it; the cost is an entry going stale when a
  file moves, which `bin:read` reports as `missing` so the row greys out instead of
  failing at the moment someone drops it on the timeline. `missing` is a live check and
  is stripped before writing - never persist it.
- **The bin's folders are its own, not the disk's.** Importing a folder mirrors its shape
  once; renaming or deleting a bin folder afterwards never touches anything on disk, and
  removing an entry removes the entry.
- Putting something on the timeline is an ordinary import at the playhead:
  `importPaths(paths, { at })`, which places clips on the first track that is actually
  free over that span rather than on top of what is already there, adding a track if
  every one is taken.
- Stills are ordinary timeline media now. Double-clicking one places it at the playhead
  like any other import - **unless an object transition is selected**, in which case it is
  handed to that transition instead. Selecting the transition first is what says "this one
  is for you"; that is the one place in the app that wants a PNG rather than a clip.
- Drops that land on the bin panel go into the bin, not onto the timeline - the bin's
  handler calls `stopPropagation()`. The drop overlay is therefore cleared by a
  **capture-phase** listener in `app.js`, or it would stay up over an import the
  bubble-phase handler never sees.

### Adding a feature — the usual places

| Want to add | Touch |
| --- | --- |
| A text style property | `defaultStyle()` in `text/model.js`, one line in `STYLE_SCHEMA` in `text/ui.js`, and its use in `TextDraw.paint()` |
| A new animation type | `ANIM_TYPES` + a `case` in `evalAnims()` (`text/model.js`), and its params in `animEntry()` (`text/ui.js`) |
| An easing preset | one entry in `EASING_PRESETS`, or a function in `NAMED` for curves a bezier cannot express — both in `anim.js` |
| A typewriter unit effect | a `case` in `unitTransform()` (`text/draw.js`) and an option in the `params.effect` select (`text/ui.js`) |
| A keyframable **card** property | `KEYABLE` in `text/model.js`, read it out in `evalCard`, and a spec in `Anim.PROP_SPECS` for its slider range |
| A keyframable **clip** property | one `Anim.registerClipProp({...})` call — the inspector strip builds itself; then read it back with `Anim.valueAt(clip, prop, t, fallback)` |
| A toolbar button | `index.html` (`#toolbar`) + one `addEventListener` in section 10 |
| A timeline-wide editing op | a function in `app.js` §7 + a button in `index.html` + one `addEventListener` in section 10 + a row in `SHORTCUTS` and the `keydown` handler |
| A keyboard shortcut | the `SHORTCUTS` table **and** the `keydown` handler, both in section 10 |
| A clip property | the `Clip` shape in `importPaths()`, `renderInspector()`, and `buildJob()` |
| A new clip **kind** | `importPaths()` (the shape), `mediaFor()` (its element, or none), `activeLayers()` + `drawPreview()` (how it paints), `buildJob()`'s `visible`, and `buildArgs()`'s input + chain. If it is **drawn by the renderer** rather than decoded, it is one entry in `CANVAS_KINDS` and one in `CANVAS_PAINTERS` instead — the layer walk, the bake, the cache key and the ffmpeg branch are all already generic over that table |
| A **graphic** type | one entry in `Graphics.DEFS` (`src/renderer/graphics.js`) — its `params` are the defaults, its `schema` builds the inspector rows AND the keyframe strips, its `bounds()` tells the baker what to crop to, its `draw(c, p, W, H, t)` paints. There is no ffmpeg half; lengths and **font sizes** go through `pxMin()`, and a chart places everything through `Graphics.scale()` |
| A position that can follow a motion track | a `bind: { label, hint, apply(p, pos, off) }` on that `FX.DEFS` entry — the panel row, the offsets and `FX.boundParams()` all build themselves from it; `apply()` decides what "follow" means for that type |
| A visual **effect** | one entry in `FX.DEFS` (`src/renderer/fx.js`) — its `params` are the defaults, its `schema` builds the inspector rows AND the keyframe strips, its `draw(L, p, t, entry, clip)` paints. There is no ffmpeg half; lengths go through `pxMin()` |
| A **generator** that writes keyframes | a pure function returning tracks of `{t, v, ease, gen:'<name>'}` + `Cursor.applyGenerated()` to merge them + one panel with its own Generate/Clear. Never an opaque effect — see "Screen-recording treatment" |
| A source of spans for Tighten to cut | `registerTightenSpans(fn)` in `app.js` §7 — return `[[start, end], ...]` in **source** time |
| A **sonify trigger** | one entry in `SFX.TRIGGERS` (`src/sfx.js`) - its default sound, offset and gain, and the panel block and the planner both build themselves from it - plus the few lines in `sonifyScene()` (`app.js` §7c) that find its moments |
| A way to get sounds into the library | a picker in `main.js` that answers with paths, then `sfxAdd` - `addSfx()` already walks folders, filters to audio, skips duplicates and probes durations |
| A caption setting | one entry in `Captions.DEFAULTS` (`src/captions.js`) + one `C({...})` row in `captionsPanelBody()` (`app.js` §7b) |
| A per-card property that must NOT propagate across a multi-selection | one entry in `TEXT_PEER_SKIP` (`app.js` §4) |
| A transcript format | a parser in `src/captions.js` and a branch in `parseTranscript()` — everything downstream takes `[{w, start, end, conf}]` |
| An audio effect type | one entry in `AudioFX.DEFS` (`src/audiofx.js`) — its `schema` builds the inspector rows and its `filter()` builds the ffmpeg string; nothing else to touch |
| A preset kind | one entry in `PRESET_KINDS` (`main.js`) + a preset bar built like `audioFxPresetBar()` |
| A transition type | `TYPES` + `defaults()` + a `draw*()` in `transitions.js`, and its controls in `renderTransitionPanel()` (`app.js`) |
| Anything that blurs by sampling across time | `Anim.temporalAverage()` — never a hand-rolled `lighter` at `1/samples` accumulator, see "The shutter" |
| An effect that should offer motion blur | nothing — every effect does. Flag the type `timeVarying: true` only if its `draw()` reads the clock without needing keyframes |
| A swipe parameter | `defaults('swipe')` in `transitions.js` (normalize fills it into old projects for free) + one `C({...})` row in `renderTransitionPanel()` |
| A QuickBin column or action | `quickbin.js` (`itemRow`/`folderRow`) + a button in `#binBar` wired in section 10 |

Anything that mutates the timeline should call `pushUndo()` **before** mutating and
`markDirty()` + `renderAll()` after. Undo snapshots are `JSON.stringify` of the whole
track list — cheap and total; don't put non-serialisable values on clips or tracks.

### Known limits

- Close gaps is local: clips outside the selection stay where they are, and groups that
  already overlap are not pulled further together — see "Close gaps".
- Tighten only cuts into the selection's own link groups. Other clips shift with the
  ripple but are never sliced, text cards shift but are never cut, and a locked track is
  left entirely alone — see "Tighten".
- Video clips, stills and graphics carry an ordered, keyframable effect stack: transform,
  rounded corners and shadow, crop/inset, blur, a grade, the three pointer effects, and the
  four framing treatments — device frame, background, spotlight and cutout — see "The
  effect stack". Text cards do not; they have their own richer animation model. There are
  still no speed changes.
- The graphics engine ships nineteen object types and **one object per clip** — a row of
  three stat cards is three clips, not one. It has no grouping, no shared brand palette
  (every colour is per object until step 17 wires a kit through), and its text is drawn
  plainly rather than through `TextDraw`, so a graphic's label has no gradient, glow or
  per-unit typewriter. An imported SVG icon is read for its `<path>` elements only —
  gradients, masks, embedded images and `<use>` are ignored — see "The graphics engine".
- A device frame ships four presets (browser light, browser dark, laptop, phone) drawn as
  paths, and the footage is fitted into the screen rect. It does not know what is IN the
  footage: a recording that is already 16:9 lands cleanly, and one that is not is cropped
  or letterboxed by the `Footage` control. There is no auto-detection of a window's edges.
- `background` and `chrome` only mean anything in the right stack order, and nothing
  reorders them for you — see "The framing four, and why order is the whole feature".
- An effect does not apply inside a transition window, in the preview or in the render —
  see "The effect stack".
- Magic Mask ships with a built-in colour region-grow and downloads MobileSAM on first
  use. Without the model it holds a logo, a coloured button, a UI panel or a solid shape
  well and a patterned object poorly, and the panel says which engine cut the matte — see
  "Magic Mask". Mattes are held between samples rather than interpolated, so a fast-moving
  object at a low mask rate is up to half a step late.
- Masking is per clip and per source frame. There is no tracking of a matte across a cut,
  and a mask painted on one clip is not shared with another cut of the same file — though
  both of them hit the same disk cache, so the second one is a file read.
- Any clip carrying a live effect leaves the fast path, so it renders at bake speed. The
  numbers are in "The fast path, and exactly what leaves it".
- Sonify sounds five things - a graphic's entry, a transition, a mouse-down, a counting
  number's steps and a hard cut into a stat. It does not listen to the audio: there is no
  beat detection, so nothing is placed on the music. It also has no per-placement
  variation - the same trigger uses the same file at the same gain every time, and the
  answer to "these all sound identical" is to move or swap the clips it placed, which is
  exactly what they are for.
- The SFX library ships **empty** and nothing is bundled, so Sonify does nothing until
  sounds are imported and each trigger is pointed at one - see "Sound design".
- The preview mirrors audio level and mute only; the DSP (denoise, EQ, de-ess, compression,
  ducking, loudness) is applied on render. This is the one deliberate preview/render
  disagreement in the app, and the inspector says so on screen.
- The loudness meter reads the PREVIEW mix, which has no DSP on it, so it is a guide to
  balance rather than a prediction of the export. The render's own two-pass measurement is
  the authority.
- Loudness normalisation is off by default. Turning it on adds an audio-only measurement
  pass before the render (skipped on draft quality).
- Transcription needs a whisper.cpp binary the app does not ship (the **model** downloads
  itself; the binary does not — see "Transcription and captions"). Without one, captions
  still work from an imported transcript.
- Captions are generated for the **selected** clips, from their linked audio, and land on
  one caption track. Regenerating replaces only the cards this generator made.
- Stills default to filling the frame and being cropped to 9:16, exactly as they always
  have. `fit: 'contain'` in the **Size and position** panel draws the whole image instead;
  it composites, so it renders at bake speed rather than on the fast path.
- Stills (PNG, JPG, WebP, GIF, BMP) are `kind:'image'` clips on video tracks: the same
  pan/zoom framing as footage, no decoder, and no source-length ceiling - `in` stays 0,
  `mediaDuration` is 3600 like a text card's, and the length is whatever `out` says. They
  import at 5 s by default (`IMAGE_DEFAULT_DUR` in `main.js`).
- Several text cards can be edited at once: the panel shows the first and mirrors every
  change onto the rest — see "Editing several cards at once".
- Audio clips draw a waveform; video clips have no thumbnails.
- Preview is nearest-frame accurate, not frame-exact; the render is the source of truth.
- Video-track compositing is bottom-up alpha blending, in the preview and in the render
  alike — and since step 6 it is blended **once**, in the renderer, and handed to ffmpeg
  as finished pixels. The two now agree to within a couple of 8-bit levels rather than the
  old ~4% of full scale, and what is left is the yuv420p encode itself, not two different
  blends. `tools/smoke-bakefirst.js` asserts that parity against a real render.
  `tools/smoke-layers.js` still asserts its older, looser tolerance - its render now goes
  through the bake as well and passes comfortably inside it.
- A transition still shows only its own two clips: `drawTransitionFrame()` owns the whole
  frame for the length of the window, so anything on a track above it is not composited
  over the transition in the preview. Text cards are, as before.
- Deleting a track deletes its clips with it (undoable).
- Screen recordings are captured to WebM in `userData/recordings`, and only a whole
  DISPLAY carries cursor telemetry - a single-window capture records picture only. Clicks
  need PowerShell (Windows only); without it the sidecar still holds the cursor path and
  says `clicks: false`. Nothing downstream may assume telemetry exists - see the contract
  in "The screen recorder".
- There are TWO kinds of recording and they feed different things. A SCREEN capture
  (`clip.screen`) feeds auto-zoom only. A performed MOUSE take (`clip.mouse`) feeds the
  drawn pointer, the ripples and the selection boxes. Do not cross them: telemetry is in
  source coordinates and a take is in frame coordinates.
- The drawn cursor is never used on a screen capture, because a screen capture already
  has a real one in its pixels. That was the two-pointers bug, and the split is the fix.
- Auto-zoom and the recorded selections are GENERATORS: they write tagged `Anim` keys onto
  ordinary effects and have no existence at render time. Regenerating or re-performing
  replaces their own keys and leaves hand-added ones alone.
- A mouse take needs the range PRE-RENDERED. `startMouseTake()` refuses otherwise rather
  than performing against a stuttering live composite.
- A motion track is solved on the clip's own source, but anything can bind to it,
  including an effect on another clip — see "Following a track on ANOTHER clip". Two clips
  joined that way are locked together in time: move one without the other and the binding
  follows the new alignment (and the render key notices).
- A tracker needs a **corner**, not an edge and not a flat area: one point cannot follow a
  straight edge, because it slides along itself. A drop snaps to the nearest real feature
  and the panel scores it, but footage with genuinely nothing in it cannot be tracked.
- Tracking is one point per track, on `kind:'video'` clips with a source. An image has one
  frame and a text card has none, so neither offers the panel.
- A track that loses its point HOLDS rather than guessing, and says so on the lane and in
  the panel. Correcting it is dragging the marker onto the right pixel, which re-solves
  forward of that frame only.
- A recorded clip and its telemetry are joined by the file name alone. Move or rename the
  `.webm` without its `.screen.json` and the next import of it has no cursor data.

### Packaging a standalone .exe

`electron-builder` is not installed by default. To produce an installer:

```bash
npm i -D electron-builder
npx electron-builder --win
```

Add to `package.json` so the ffmpeg binaries are not packed into the asar (`main.js`
already rewrites `app.asar` → `app.asar.unpacked` in the binary paths):

```json
"build": {
  "appId": "com.local.shortcut",
  "asarUnpack": ["**/ffmpeg-static/**", "**/ffprobe-static/**",
                 "**/onnxruntime-node/**"]
}
```

## Shortcuts

Press **Shortcuts** in the toolbar for the live list. The main ones:

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause |
| `J` / `L` | Back / forward 1 s |
| `←` / `→` | Step one frame (`Shift` = one second) |
| `S` | Split at playhead |
| `Del` / `Shift+Del` | Delete / ripple delete |
| `I` / `O` | Set the in / out mark for a ranged render |
| `X` | Clear the in / out marks |
| `Alt+I` / `Alt+O` | Trim the selected clip in / out to the playhead |
| `Ctrl+L` / `Ctrl+Shift+L` | Link / unlink A+V |
| `1` / `2` / `3` | Frame left / center / right |
| `Shift+R` | Reset framing |
| `Ctrl+T` | Add a text card at the playhead |
| `Ctrl+G` | Add another graphic of the type you added last |
| `T` | Drop a transition on the nearest cut |
| `Ctrl+D` | Duplicate the selected clips |
| `A` | Toggle animation on the selected text card |
| `Ctrl+S` / `Ctrl+O` | Save / open project |
| `Ctrl+R` | Render a preview of the range into the viewer |
| `Ctrl+Shift+R` | Export a file to disk |
| `Ctrl+Shift+F9` | Start / stop recording the screen (works while another app has focus) |
| `P` | Play rendered spans / composite live |
| `N` | Toggle snapping |
| `B` | Show / hide the QuickBin |
| Double-click in the bin | Put that clip on the timeline at the playhead |
| `Ctrl+Wheel` | Zoom the timeline |
| `Ctrl+Drag` in timeline | Scrub |
