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

There are eleven suites:

- `tools/smoke.js` — timeline logic, no decoding involved.
- `tools/smoke-preview.js` — playback and compositing: verifies the preview never goes
  black inside a clip, across a cut, past the end of a short video stream, or after rapid
  scrubbing, and that real gaps *do* stay black. It needs `real1.mp4`/`real2.mp4` in
  `%TEMP%\scut_test` (its header comment gives the ffmpeg command).
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
- `tools/smoke-transitions.js` — transitions: finding cuts, the fast grab, length and
  alignment, all three types drawing correctly, the render job, an end-to-end ffmpeg
  render read back from the MP4, and presets.
- `tools/smoke-previewrender.js` — preview renders: that the file lands in the app cache
  and not the user's folders, that the **viewer actually decodes it** instead of
  compositing, that the source clips fall silent underneath it, and that the span and its
  player are dropped the moment its content changes.
- `tools/smoke-bin.js` — the QuickBin (folders, importing, moving, deleting, and that it
  survives a new project), the audio waveforms (decode, slicing, the canvas on the lane),
  snapping (including the miss-beats-a-hit bug below), and the swipe's deform. It reads
  the user's real bin at the start and writes it back at the end - a run must not eat
  someone's library.

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
ShortCut.bat              launcher (installs deps on first run, then starts electron)
src/main.js               Electron main: media probing, folder scan, project IO, ffmpeg render
src/preload.js            contextBridge surface — the ONLY channel between main and renderer
src/renderer/index.html   DOM skeleton; every element the renderer touches has a stable id
                          three columns: #left (viewer only), #right (work area), #inspectorCol
src/renderer/styles.css   all styling; colors live in :root custom properties
src/renderer/app.js       the editor: state, timeline, preview, editing ops, shortcuts
src/renderer/text/model.js  text cards: defaults, easing curves, animation + keyframe maths
src/renderer/text/draw.js   text cards: all canvas painting (preview AND export)
src/renderer/text/ui.js     text cards: the editor panel
src/renderer/transitions.js transitions: every pixel of all three types (preview AND export)
src/renderer/waveform.js  audio peaks: decode once per file, draw a slice per clip
src/renderer/quickbin.js  the QuickBin: a media library kept in userData, not in the project
```

The text editor renders into `#textPanel` inside the inspector column. The three `text/`
files are plain `<script>` globals (`TextModel`, `TextDraw`, `TextUI`)
loaded before `app.js`. `TextUI` never touches `app.js` globals - it is wired up through
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
| `#inspectorCol` — the right | The QuickBin, framing, the clip inspector, and the text card editor (which appears only when exactly one text clip is selected). Resizable by dragging its left edge; the width lives in the `--insp-w` custom property. |

The left column's width is `minmax(320px, 33.333%)` and never changes with panel state.

### The data model

A project is one plain JSON object. `serialize()` in `app.js` writes it and
`openProject()` reads it back; `.scut` files are exactly this shape.

```js
{
  app: 'shortcut', version: 1,
  out: { w: 1080, h: 1920, fps: 30, quality: 'medium' },
  pxPerSec: 60,          // timeline zoom
  playhead: 0,
  tracks: [ Track, ... ] // index 0 is the TOPMOST track; video tracks sit above audio
}
```

```js
Track = {
  id, type: 'video' | 'audio', name,   // 'V1', 'A2', ...
  muted, hidden, locked,
  clips: [ Clip, ... ]                 // kept sorted by start
}

Clip = {
  id, src,               // absolute path to the media file; null for text cards
  name, kind: 'video' | 'audio' | 'text',
  start,                 // position on the timeline, seconds
  in, out,               // source in/out points, seconds; length = out - in
  mediaDuration,         // full length of the source, the ceiling for `out`
  srcW, srcH, fps,
  panX, panY,            // 0..1 crop position within the source
  zoom,                  // 1 = the largest crop that fits the output aspect
  volume,                // 0..2
  linkId,                // clips sharing a linkId move and trim together (A/V sync)
  card                   // text clips only - the whole card, see TextCard below
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
- Text clips live on **video** tracks, so track order gives them their z-order for free.
  They have no `src` and never open a decoder; `in` stays 0 and their length is `out`.
  Anything that walks video clips must skip `kind === 'text'` — `activeVideoClip()` and
  `syncMedia()` both do.

### Framing (16:9 → 9:16)

The crop is defined by `panX`/`panY`/`zoom` and computed **twice**, in two languages that
must stay in agreement:

- Preview: `drawClip()` in `app.js` — takes the largest source rect matching the output
  aspect, divides by `zoom`, offsets it by `pan * (source - crop)`.
- Render: the `crop=w='min(iw,ih*W/H)/zoom':...:x='(iw-ow)*panX'` filter built in
  `buildArgs()` in `main.js`.

**If you change one, change the other**, or the preview will lie about the output.

### Render pipeline

`buildJob()` (renderer) flattens the timeline into a list of clips with absolute
timings and `visible` / `audible` flags. `buildArgs()` (main) turns that into a single
`ffmpeg` invocation:

- a `color=black` base of the full project duration;
- each visible video clip: `trim` → `setpts=PTS-STARTPTS+start/TB` → `crop` → `scale` →
  `fps`, then `overlay` onto the running base with `enable='between(t,start,end)'` and
  **`eof_action=repeat`** (see the note below);
- each audible clip: `atrim` → `asetpts` → `volume` → `adelay`, then a single `amix`
  and a limiter;
- x264 with a preset/CRF pair chosen by the quality setting.

Every clip occurrence becomes its own ffmpeg input, so the same file can appear many
times. That is simple and correct but costs one decoder per clip — if you need to render
hundreds of clips, batching by source file is the optimisation to reach for.

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

### Text cards

A text card is a clip of `kind: 'text'` whose whole definition lives in `clip.card`:

```js
TextCard = {
  text,                  // the string; 
 makes a new line
  style: { ... },        // TextModel.defaultStyle() - font, fill, shadow, glow, blur, ...
  animEnabled,           // master switch (the A shortcut)
  anims: [ AnimLayer ],  // combinable animation layers
  keys: { opacity: [Key], x: [], y: [], scale: [], rotate: [] }
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

Key = { t, v, ease }     // t is seconds into the clip
```

Keyable properties are `opacity`, `x`, `y`, `scale`, `rotate` and `glow` (a multiplier
over the whole glow effect, so a card can bloom up and back down).

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
`samples` instants across the shutter and averaged. Two rules:

1. The averaging **must** be additive - each sample is painted into a scratch canvas, then
   composited into an accumulator with `globalCompositeOperation = 'lighter'` at
   `1/samples`. Compositing the samples straight onto the target with source-over at `1/n`
   converges to `1-(1-1/n)^n` (~63%) and visibly washes the text out; a static-card test
   guards this by requiring full opacity back.
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

  1. The averaging is **additive** - each copy is composited with `lighter` at
     `1/samples`. Source-over at `1/n` converges to `1-(1-1/n)^n` (~63%) and visibly
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

### Presets

Three flavours, split by `TextModel.extractPreset(kind, card)`: `style` (look only),
`anim` (layers + curves + keyframes), and `full` (both, plus the text). Each can be saved
to a named library under `app.getPath('userData')/presets/<kind>/` or exported/imported as
a `.json` file. `TextModel.applyPreset` merges a preset into a card and takes
`{ keepText: true }` so applying a style or animation preset does not clobber the wording.

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
(from `app.js`) to the framing and volume rows. It consumes the event so the panel does not
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
only when drift exceeds 0.3 s so playback is not constantly stuttering). The canvas draws
only the topmost visible video clip — there is no compositing or blending, so a clip on
V2 fully hides V1 beneath it.

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
- Stills can live in the bin even though the timeline has no images. Double-clicking one
  hands it to the selected **object transition**, which is the one place the app uses a
  PNG; with no object transition selected it says so rather than doing nothing.
- Drops that land on the bin panel go into the bin, not onto the timeline - the bin's
  handler calls `stopPropagation()`. The drop overlay is therefore cleared by a
  **capture-phase** listener in `app.js`, or it would stay up over an import the
  bubble-phase handler never sees.

### Adding a feature — the usual places

| Want to add | Touch |
| --- | --- |
| A text style property | `defaultStyle()` in `text/model.js`, one line in `STYLE_SCHEMA` in `text/ui.js`, and its use in `TextDraw.paint()` |
| A new animation type | `ANIM_TYPES` + a `case` in `evalAnims()` (`text/model.js`), and its params in `animEntry()` (`text/ui.js`) |
| An easing preset | one entry in `EASING_PRESETS`, or a function in `NAMED` for curves a bezier cannot express |
| A typewriter unit effect | a `case` in `unitTransform()` (`text/draw.js`) and an option in the `params.effect` select (`text/ui.js`) |
| A keyframable property | `KEYABLE` in `text/model.js`, read it out in `evalCard`, and give it a slider range in `keyframeTrack()` |
| A toolbar button | `index.html` (`#toolbar`) + one `addEventListener` in section 10 |
| A keyboard shortcut | the `SHORTCUTS` table **and** the `keydown` handler, both in section 10 |
| A clip property | the `Clip` shape in `importPaths()`, `renderInspector()`, and `buildJob()` |
| An effect (filters, speed, fades) | a per-clip filter in `buildArgs()` + the matching canvas draw in `drawClip()` |
| A transition type | `TYPES` + `defaults()` + a `draw*()` in `transitions.js`, and its controls in `renderTransitionPanel()` (`app.js`) |
| A swipe parameter | `defaults('swipe')` in `transitions.js` (normalize fills it into old projects for free) + one `C({...})` row in `renderTransitionPanel()` |
| A QuickBin column or action | `quickbin.js` (`itemRow`/`folderRow`) + a button in `#binBar` wired in section 10 |

Anything that mutates the timeline should call `pushUndo()` **before** mutating and
`markDirty()` + `renderAll()` after. Undo snapshots are `JSON.stringify` of the whole
track list — cheap and total; don't put non-serialisable values on clips or tracks.

### Known limits

- No video effects or speed changes.
- Text cards cover the still-image and shape needs; the timeline still holds no images
  (the QuickBin will keep them, and an object transition will use one, but nothing puts a
  still on a track).
- Only one text card is edited at a time (select exactly one to open the panel).
- Audio clips draw a waveform; video clips have no thumbnails.
- Preview is nearest-frame accurate, not frame-exact; the render is the source of truth.
- Video-track compositing is topmost-wins, not alpha blending.
- Deleting a track deletes its clips with it (undoable).

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
  "asarUnpack": ["**/ffmpeg-static/**", "**/ffprobe-static/**"]
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
| `T` | Drop a transition on the nearest cut |
| `Ctrl+D` | Duplicate the selected clips |
| `A` | Toggle animation on the selected text card |
| `Ctrl+S` / `Ctrl+O` | Save / open project |
| `Ctrl+R` | Render a preview of the range into the viewer |
| `Ctrl+Shift+R` | Export a file to disk |
| `P` | Play rendered spans / composite live |
| `N` | Toggle snapping |
| `B` | Show / hide the QuickBin |
| Double-click in the bin | Put that clip on the timeline at the playhead |
| `Ctrl+Wheel` | Zoom the timeline |
| `Ctrl+Drag` in timeline | Scrub |
