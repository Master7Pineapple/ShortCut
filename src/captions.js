'use strict';
/**
 * Transcription and captions - the pure half.
 *
 * Loaded twice, exactly like `audiofx.js`: as a plain <script> global `Captions` in
 * index.html (next to TextModel and Trans) and as a CommonJS module by main.js. The
 * transcript parser has to exist in both places - main runs whisper and caches what it
 * parses, the renderer reads imported transcripts and groups them into phrases - and one
 * copy is the only way those two can never disagree about what a word is.
 *
 * Nothing here touches the DOM, canvas, ffmpeg or the filesystem. What it produces is
 * plain JSON:
 *
 *   Word   = { w, start, end, conf }        // SOURCE time, seconds
 *   Phrase = { start, end, text, words: [Word], hi: [wordIndex] }
 *
 * A caption is an ordinary text card (kind:'text'), so `phraseCard()` returns a normal
 * `TextCard` and the existing TextDraw path carries preview/render parity for free.
 */
(function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

  /**
   * Caption settings. These live on `state.captions` in the renderer and go in the
   * .scut, so a project keeps the look it was captioned with.
   *
   * The SAFE ZONE is the band a caption may sit in, as fractions of the frame height.
   * Its bottom is above the platform UI bar (the like/comment rail and the caption text
   * every one of TikTok, Reels and Shorts paints over the bottom fifth of the frame) and
   * its top is clear of the top edge, so nothing lands where a phone will cover it.
   */
  const DEFAULTS = {
    // engine
    model: 'base.en',     // a whisper.cpp ggml model name, downloaded on first use
    // grouping
    maxWords: 3,          // words per phrase - "2-3 word phrases"
    maxDur: 2.2,          // seconds a phrase may stay up
    maxGap: 0.45,         // a pause longer than this always breaks the phrase
    minDur: 0.30,         // a phrase is held at least this long, so a fast word is readable
    // placement
    zoneTop: 0.60,        // safe zone, fractions of frame height
    zoneBottom: 0.86,
    maxWidth: 0.82,       // wrap width, fraction of frame width
    // look
    fontFamily: 'Segoe UI',
    fontSize: 96,         // px against a 1080x1920 frame, like every other style size
    color: '#ffffff',
    highlight: '#ffd166',
    keywords: '',         // comma or space separated; matched per word, case-insensitive
    uppercase: false,
    popIn: true,          // per-word pop, built on the existing typewriter layer
    popDur: 0.28,
    // A saved `full` text preset to build every caption from. '' = the built-in look.
    // The preset supplies style and animation; the words, the timings and the highlight
    // are the caption's own, because those are content and a preset is a look.
    preset: '',
    presetPlacement: false,   // keep the preset's x/y instead of the safe zone
    // Word timing: each word appears as it is spoken, rather than the phrase arriving
    // whole. Emphasis lights the word being said right now and lets it settle back.
    wordReveal: false,
    wordEmphasis: false,
    emphasisColor: '#ffd166',
    emphasisScale: 1.12,
    emphasisRise: 0,
    emphasisAttack: 0.08,
    // How long a word stays lit, and how early it happens. A word's recorded `end` is
    // the moment the NEXT word starts, so it swallows the pause after it - these three
    // turn that record into a window that tracks the voice. See TextDraw.wordState.
    wordLead: 0.06,       // start this much early, so the highlight lands on the beat
    wordHold: 0.60,       // longest a word stays lit; past this it is a pause, not a word
    wordMinHold: 0.14,    // shortest, so a 40ms DTW blip still reads as a highlight
    // Type details. The defaults are the look captions always had (an 8px black stroke,
    // a 6/22 shadow at 75%), so a project captioned before these existed is unchanged.
    tracking: 0,          // letter spacing, % of the font size
    lineHeight: 1.15,
    strokeOn: true,
    strokeWidth: 8,
    shadowDistance: 6,
    shadowAngle: 135,
    shadowBlur: 22,
    shadowOpacity: 0.75,
    emphasisEase: '',     // '' = smoothstep, 'backOut' = overshoot and settle
    // Keyword blowup: these words get a line of their own, bigger, in caps, with an impact.
    blowWords: '',
    blowScale: 1.55,
    blowFrom: 1.12,
    blowDur: 4 / 30,
    blowColor: '#ffd166',
    blowUpper: true,
    // Highlighter block: a marker stroke wiped in behind these words.
    markWords: '',
    markMode: 'tint',     // tint | solid
    markColor: '#ffd166',
    markOpacity: 0.22,
    markTextColor: '#111111',
    markRadius: 8,
    markPadX: 14,
    markPadY: 4,
    markDur: 3 / 30,
    markSoft: 0.12,
    markAngle: 0,
    // Metric chips: a spoken acronym (and the figure said with it) gets a mono pill above
    // the caption. Off by default; they go on their own track.
    chipOn: false,
    chipWords: 'ARR, MRR, NRR, GRR, CAC, LTV, ACV, ARPU, PLG, ICP, ROI, KPI, GTM, SaaS, B2B, CRM, SLA, MQL, SQL',
    chipFont: 'Consolas',
    chipSize: 0.6,        // fraction of the caption size
    chipTracking: 8,      // % of the chip's size
    chipHold: 1.6,
    chipReveal: 5 / 30,
    chipRise: 16,
    chipGap: 0.075,       // how far above the caption, fraction of frame height
    // filler words fed back into Tighten
    cutFillers: false,
    fillers: 'um, uh, erm, ah, like, you know, i mean, sort of, kind of, basically',
  };

  /** The filler list as an array of lowercase phrases, longest first so "you know" wins. */
  function fillerList(opts) {
    const src = (opts && opts.fillers != null) ? opts.fillers : DEFAULTS.fillers;
    return String(src).split(/[,\n]+/).map((s) => s.trim().toLowerCase())
      .filter(Boolean).sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  }

  /** A word stripped of punctuation and case, which is what every match here compares. */
  function normWord(w) {
    return String(w == null ? '' : w).toLowerCase()
      .replace(/[^\p{L}\p{N}']+/gu, '');
  }

  const wordsList = (v) => String(v || '').split(/[,\s]+/).map(normWord).filter(Boolean);
  const keywordList = (opts) => wordsList(opts && opts.keywords);

  // ------------------------------------------------------------- parsing

  /**
   * Whisper's special tokens, which carry no text and must never reach a caption.
   *
   * They come in TWO shapes and both have been seen in the same file: `[_BEG_]`,
   * `[_TT_170]`, `[_EOT_]` and `<|endoftext|>`, `<|0.00|>`. Note that only some of the
   * bracketed ones end in an underscore, so the closing `_` must not be in the pattern.
   * Miss either shape and it rides along on the end of the last real word of a segment -
   * `AI.<|endoftext|>` was a real caption.
   */
  function isSpecial(text) {
    const t = String(text == null ? '' : text).trim();
    return !t || /^\[_[^\]]*\]$/.test(t) || /^<\|[^|]*\|>$/.test(t);
  }

  /** Keep only the fields a word may carry, and only if it is a usable one. */
  function cleanWords(list) {
    const out = [];
    let prevEnd = 0;
    for (const x of list || []) {
      if (!x) continue;
      const w = String(x.w == null ? x.word == null ? x.text : x.word : x.w).trim();
      let s = Number(x.start), e = Number(x.end);
      if (!w || !isFinite(s) || !isFinite(e)) continue;
      s = Math.max(0, s);
      e = Math.max(s, e);
      // Whisper occasionally hands back a token that starts before the one before it
      // ended. Left alone that makes a phrase run backwards, so clamp it forward.
      if (s < prevEnd) s = prevEnd;
      if (e < s) e = s;
      prevEnd = e;
      const conf = isFinite(Number(x.conf)) ? Number(x.conf) : 1;
      out.push({ w, start: r3(s), end: r3(e), conf: r3(clamp(conf, 0, 1)) });
    }
    return out;
  }

  /**
   * Word timings out of whisper.cpp's JSON.
   *
   * `--output-json-full` gives per-segment `tokens`, each with its own offsets in
   * MILLISECONDS - that is where word-level timing actually comes from. Tokens are
   * sub-word pieces, so a word begins at a token whose text starts with a space (or at
   * the first token of a segment) and swallows every continuation token after it.
   *
   * Special tokens ([_BEG_], [_TT_170], ...) carry no text and are dropped.
   *
   * A plain `--output-json` file has no tokens at all, only segments. Rather than refuse
   * it, the segment's words are spread across its span in proportion to their length -
   * approximate, clearly marked with a low confidence, and still far more useful than
   * one caption per sentence.
   */
  function parseWhisper(json, duration) {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    const segs = (doc && (doc.transcription || doc.segments)) || [];
    const words = [];

    for (const seg of segs) {
      const so = seg.offsets || {};
      const segStart = isFinite(Number(so.from)) ? Number(so.from) / 1000 : Number(seg.start) || 0;
      const segEnd = isFinite(Number(so.to)) ? Number(so.to) / 1000 : Number(seg.end) || segStart;
      const toks = (seg.tokens || []).filter((t) => t && !isSpecial(t.text));

      // `t_dtw` is the ONLY real per-token time in this file. Whisper's `offsets` are the
      // segment's own bounds copied onto every token - "That" got 0.13-2.83 and the other
      // six tokens all got 2.83-2.83, which is not word timing, it is one caption's worth
      // of nothing. See the DTW note in the README before trusting `offsets` here.
      const dtw = toks.some((t) => Number(t.t_dtw) >= 0);

      if (toks.length && dtw) {
        // t_dtw is in whisper's own 10ms units, and it is a single INSTANT per token, not
        // a span - so a word ends where the next one begins.
        const marks = [];
        let cur = null;
        for (const t of toks) {
          const raw = String(t.text || '');
          const ct = Number(t.t_dtw);
          const at = ct >= 0 ? ct / 100 : (cur ? cur.last : segStart);
          const p = isFinite(Number(t.p)) ? Number(t.p) : 1;
          if (!cur || /^\s/.test(raw)) {
            cur = { w: raw.trim(), start: at, last: at, conf: p };
            marks.push(cur);
          } else {
            cur.w += raw;
            cur.last = Math.max(cur.last, at);
            cur.conf = Math.min(cur.conf, p);
          }
        }
        marks.forEach((m, i) => {
          const next = marks[i + 1];
          // The last word has nothing after it to end against. Its own trailing token
          // (usually the full stop) is the best mark there is; failing that, hold it for
          // a beat rather than giving it zero length.
          const end = next ? next.start : Math.max(m.last, m.start + 0.24);
          words.push({ w: m.w, start: m.start, end: Math.max(m.start, end), conf: m.conf });
        });
      } else if (toks.length) {
        let cur = null;
        for (const t of toks) {
          const raw = String(t.text || '');
          const o = t.offsets || {};
          const ts = isFinite(Number(o.from)) ? Number(o.from) / 1000 : segStart;
          const te = isFinite(Number(o.to)) ? Number(o.to) / 1000 : ts;
          const p = isFinite(Number(t.p)) ? Number(t.p) : 1;
          // A leading space is what marks the start of a new word in whisper's vocabulary.
          if (!cur || /^\s/.test(raw)) {
            cur = { w: raw.trim(), start: ts, end: te, conf: p };
            words.push(cur);
          } else {
            cur.w += raw;
            cur.end = Math.max(cur.end, te);
            cur.conf = Math.min(cur.conf, p);
          }
        }
      } else {
        const parts = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
        const total = parts.reduce((n, p) => n + p.length, 0) || 1;
        const span = Math.max(0, segEnd - segStart);
        let acc = 0;
        for (const p of parts) {
          const s = segStart + span * (acc / total);
          acc += p.length;
          words.push({ w: p, start: s, end: segStart + span * (acc / total), conf: 0.3 });
        }
      }
    }
    // Whisper pads its input to 30 s chunks and times the tail against the PADDING, so
    // the last word of a 2.8 s clip can come back ending at 30 s. Given the real duration,
    // clip to it; without one, leave the words alone rather than guess.
    const out = cleanWords(words);
    if (duration > 0) {
      for (const w of out) {
        w.start = Math.min(w.start, duration);
        w.end = Math.min(w.end, duration);
      }
    }
    return out.filter((w) => w.end > w.start || !(duration > 0) || w.start < duration);
  }

  /** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT) to seconds. */
  function parseStamp(s) {
    const m = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})/.exec(String(s));
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
  }

  /**
   * SRT or WebVTT. Cues are usually whole lines rather than words, so - as with a
   * token-less whisper JSON - the cue's words are spread across its span by length.
   * A one-word cue is therefore exact, which is what `--max-len 1` output looks like.
   */
  function parseSrt(text) {
    const words = [];
    const lines = String(text).split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const arrow = lines[i].indexOf('-->');
      if (arrow < 0) { i++; continue; }
      const from = parseStamp(lines[i].slice(0, arrow));
      const to = parseStamp(lines[i].slice(arrow + 3));
      i++;
      const buf = [];
      while (i < lines.length && lines[i].trim() !== '') { buf.push(lines[i]); i++; }
      if (from == null || to == null) continue;
      const parts = buf.join(' ').replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean);
      const total = parts.reduce((n, p) => n + p.length, 0) || 1;
      const span = Math.max(0, to - from);
      let acc = 0;
      for (const p of parts) {
        const s = from + span * (acc / total);
        acc += p.length;
        words.push({ w: p, start: s, end: from + span * (acc / total), conf: 0.5 });
      }
    }
    return cleanWords(words);
  }

  /** Anything a user might hand us: whisper JSON, a bare word array, SRT or VTT. */
  function parseTranscript(data) {
    if (Array.isArray(data)) return cleanWords(data);
    if (data && typeof data === 'object') {
      if (Array.isArray(data.words)) return cleanWords(data.words);
      return parseWhisper(data);
    }
    const s = String(data == null ? '' : data).trim();
    if (!s) return [];
    if (s[0] === '{' || s[0] === '[') {
      try { return parseTranscript(JSON.parse(s)); } catch (e) { return []; }
    }
    return parseSrt(s);
  }

  // ------------------------------------------------------------- grouping

  /** True when a word ends a sentence, which always ends a phrase too. */
  const ENDS_SENTENCE = /[.!?:;]["')\]]?$/;

  /**
   * Group words into short phrases.
   *
   * Every boundary is a WORD boundary - a phrase is a run of whole words and nothing is
   * ever split - and a phrase breaks on whichever comes first: the word count, the
   * duration cap, a pause longer than `maxGap`, or a sentence ending.
   *
   * `start`/`end` come from the words themselves, so a caption is on screen exactly while
   * it is being said. `minDur` only ever extends the tail, and `capTo` (the next phrase's
   * start) stops that extension running into the following caption.
   */
  function groupPhrases(words, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const maxWords = Math.max(1, Math.round(o.maxWords));
    const list = cleanWords(words);
    const phrases = [];
    let cur = null;

    for (const w of list) {
      const gap = cur ? w.start - cur.words[cur.words.length - 1].end : 0;
      const wouldRun = cur ? (w.end - cur.words[0].start) > o.maxDur : false;
      if (cur && (cur.words.length >= maxWords || gap > o.maxGap || wouldRun)) cur = null;
      if (!cur) { cur = { words: [] }; phrases.push(cur); }
      cur.words.push(w);
      if (ENDS_SENTENCE.test(w.w)) cur = null;
    }

    const out = [];
    phrases.forEach((p, i) => {
      if (!p.words.length) return;
      const start = p.words[0].start;
      let end = p.words[p.words.length - 1].end;
      if (end - start < o.minDur) end = start + o.minDur;
      out.push({
        start: r3(start), end: r3(end),
        text: p.words.map((w) => w.w).join(' '),
        words: p.words,
        hi: [],
      });
    });
    // A held tail must never overlap the next caption, or two cards sit on screen at once.
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) out[i].end = r3(Math.max(out[i].start + 0.05, out[i + 1].start));
    }
    for (const p of out) markKeywords(p, o);
    return out;
  }

  /** Fill `phrase.hi` with the indices of the words that match the keyword list. */
  function markKeywords(phrase, opts) {
    const keys = keywordList(opts);
    phrase.hi = [];
    if (!keys.length) return phrase;
    phrase.words.forEach((w, i) => { if (keys.includes(normWord(w.w))) phrase.hi.push(i); });
    return phrase;
  }

  /** Indices of a phrase's words that appear in a comma/space separated list. */
  function matchWords(phrase, list) {
    const keys = wordsList(list);
    const out = [];
    if (!keys.length) return out;
    (phrase.words || []).forEach((w, i) => { if (keys.includes(normWord(w.w))) out.push(i); });
    return out;
  }

  /**
   * Metric chips out of a transcript: every spoken acronym in `chipWords`, plus the figure
   * said right after it ("NRR one eighteen" will not match, "NRR 118%" will). Source
   * time, like the words. A chip holds `chipHold` and never overlaps the next one.
   */
  function metricChips(words, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const keys = wordsList(o.chipWords);
    const list = cleanWords(words);
    const out = [];
    if (!keys.length) return out;
    const figure = /\d/;
    list.forEach((w, i) => {
      if (!keys.includes(normWord(w.w))) return;
      const label = String(w.w).replace(/[^\p{L}\p{N}]+/gu, '').toUpperCase();
      const next = list[i + 1];
      const val = next && figure.test(next.w) && next.start - w.end < 0.6
        ? ' ' + String(next.w).replace(/[.,;:!?]+$/, '') : '';
      out.push({ start: w.start, end: w.start + Math.max(0.3, Number(o.chipHold) || 1.6), text: label + val });
    });
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.2, out[i + 1].start);
    }
    return out.map((c) => ({ start: r3(c.start), end: r3(c.end), text: c.text }));
  }

  /**
   * A metric chip as an ordinary text card: mono, uppercase, tracked out, in a hairline
   * pill with a 6% fill, rising out of a mask. `base` is a pristine default card.
   */
  function chipCard(base, text, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const card = JSON.parse(JSON.stringify(base));
    const zone = safeZone(o);
    const size = Math.max(8, (Number(o.fontSize) || DEFAULTS.fontSize) * clamp(o.chipSize, 0.2, 2));
    card.text = text;
    const st = card.style;
    st.fontFamily = o.chipFont || 'Consolas';
    st.fontSize = size;
    st.bold = true;
    st.uppercase = true;
    st.letterSpacing = size * (Number(o.chipTracking) || 0) / 100;
    st.lineHeight = 1.1;
    st.align = 'center';
    st.x = 0.5;
    st.y = clamp(zone.y - (Number(o.chipGap) || 0), 0.02, 0.98);
    st.maxWidth = 1;
    st.fill = { type: 'solid', color: o.color, gradient: st.fill.gradient };
    st.stroke = Object.assign({}, st.stroke, { on: false });
    st.shadow = Object.assign({}, st.shadow, { on: true, distance: 4, angle: 90, blur: 14, opacity: 0.35 });
    st.bg = { on: true, color: '#ffffff', opacity: 0.06, padding: Math.round(size * 0.22),
      padX: Math.round(size * 0.5), radius: 100,
      border: { on: true, width: 2, color: '#ffffff', opacity: 0.45 } };
    card.animEnabled = true;
    card.anims = [];
    card.mask = { in: { dur: Math.max(0.01, Number(o.chipReveal) || 5 / 30), dy: Number(o.chipRise) || 16 } };
    return card;
  }

  // ------------------------------------------------------------- placement

  /**
   * The safe zone, as fractions of the frame height, and the y a caption sits at.
   *
   * The zone is normalised rather than trusted: a top dragged past the bottom would put
   * a caption off the frame, and the whole point of the zone is that it cannot.
   */
  function safeZone(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    let top = clamp(o.zoneTop, 0, 1);
    let bottom = clamp(o.zoneBottom, 0, 1);
    if (bottom < top) { const t = top; top = bottom; bottom = t; }
    return { top, bottom, y: (top + bottom) / 2 };
  }

  // ------------------------------------------------------------- the card

  /**
   * A caption as an ordinary text card.
   *
   * `base` is a pristine `TextModel.defaultCard()` - passed in rather than imported, so
   * this file stays free of the text model and can be required by the main process.
   * Everything after that is style and one animation layer, both plain JSON.
   *
   * The pop-in is the EXISTING typewriter layer with `unit: 'word'` and `effect: 'pop'`.
   * There is no second animation path: the card animates through TextDraw exactly as a
   * hand-made card does, which is what makes preview and render agree at no cost.
   */
  function phraseCard(base, phrase, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const card = JSON.parse(JSON.stringify(base));
    const zone = safeZone(o);
    // `fromPreset` says the base card IS the look the user picked, so the panel's own
    // font/size/colour rows must not paint over it. Placement is the one thing captions
    // still insist on by default: the safe zone exists to keep text off the platform UI,
    // and a preset authored for a title card knows nothing about that.
    const preset = !!o.fromPreset;

    // A blown-up word gets a line of its own - that is what lets it be bigger than its
    // neighbours without colliding with them - and is written in caps if asked. The word
    // ORDER is unchanged, so every per-word index below still lines up.
    const blowIdx = matchWords(phrase, o.blowWords);
    if (blowIdx.length) {
      const set = new Set(blowIdx);
      const parts = phrase.words.map((w, i) => (set.has(i) && o.blowUpper ? String(w.w).toUpperCase() : w.w));
      let text = '';
      parts.forEach((w, i) => {
        const brk = set.has(i) || set.has(i - 1);
        text += i === 0 ? w : (brk ? '\n' : ' ') + w;
      });
      card.text = text;
    } else card.text = phrase.text;
    const st = card.style;
    if (!preset) {
      st.fontFamily = o.fontFamily;
      st.fontSize = Math.max(8, Number(o.fontSize) || DEFAULTS.fontSize);
      st.uppercase = !!o.uppercase;
      st.align = 'center';
      st.x = 0.5;
      st.maxWidth = clamp(o.maxWidth, 0.1, 1);
      st.letterSpacing = st.fontSize * (Number(o.tracking) || 0) / 100;
      st.lineHeight = clamp(o.lineHeight == null ? DEFAULTS.lineHeight : o.lineHeight, 0.6, 3);
      st.fill = { type: 'solid', color: o.color, gradient: st.fill.gradient };
      st.stroke = Object.assign({}, st.stroke, {
        on: o.strokeOn !== false && Number(o.strokeWidth) > 0, color: '#000000',
        width: Number(o.strokeWidth) >= 0 ? Number(o.strokeWidth) : 8,
      });
      st.shadow = Object.assign({}, st.shadow, {
        on: true,
        opacity: clamp(o.shadowOpacity == null ? 0.75 : o.shadowOpacity, 0, 1),
        blur: Math.max(0, Number(o.shadowBlur == null ? 22 : o.shadowBlur)),
        distance: Number(o.shadowDistance == null ? 6 : o.shadowDistance),
        angle: Number(o.shadowAngle == null ? 135 : o.shadowAngle),
      });
    }
    if (!preset || !o.presetPlacement) st.y = zone.y;

    // Word reveal replaces the uniform typewriter sweep rather than stacking with it:
    // the whole point of real word times is that each word arrives when it is spoken,
    // and a fixed stagger on top of that fights it. The pop carries over as the word's
    // OWN entrance instead - see `wordFx.pop` below.
    const revealing = !!o.wordReveal;

    card.animEnabled = true;
    if (preset) {
      // The preset's own layers are the animation. Its timings were authored against
      // whatever length that card was, and a caption is usually shorter, but every layer
      // is anchored to a clip end or start - so they still land.
      if (!Array.isArray(card.anims)) card.anims = [];
    } else card.anims = (o.popIn && !revealing) ? [{
      id: 'cap' + Math.random().toString(36).slice(2, 8),
      type: 'typewriter',
      mode: 'in',
      anchor: 'start',
      start: 0,
      duration: Math.max(0.05, Number(o.popDur) || DEFAULTS.popDur),
      easing: { kind: 'named', name: 'backOut' },
      motionBlur: { on: false, strength: 0.6, samples: 8 },
      params: {
        unit: 'word', effect: 'pop', distance: 0.6, overlap: 1,
        order: 'forward', scaleFrom: 0.55,
      },
    }] : [];

    // Per-word colour override. `highlight.words` are indices into the card's own words,
    // which are the phrase's words in the same order - see TextDraw.measure().
    card.highlight = (phrase.hi && phrase.hi.length)
      ? { color: o.highlight, words: phrase.hi.slice() }
      : null;

    // The words themselves, in the CARD's time base: seconds from the start of the clip,
    // which is what every paint pass is already given. Word timing is the whole reason
    // the transcript is word-level rather than line-level, so it is carried even when
    // neither reveal nor emphasis is on - turning them on later needs no regenerate.
    card.words = (phrase.words || []).map((w) => ({
      w: w.w,
      start: r3(Math.max(0, w.start - phrase.start)),
      end: r3(Math.max(0, w.end - phrase.start)),
    }));
    card.wordFx = {
      reveal: revealing,
      emphasis: !!o.wordEmphasis,
      color: o.emphasisColor,
      scale: Number(o.emphasisScale) || 1,
      rise: Number(o.emphasisRise) || 0,
      attack: Math.max(0.001, Number(o.emphasisAttack) || DEFAULTS.emphasisAttack),
      lead: Math.max(0, Number(o.wordLead) || 0),
      hold: Math.max(0.05, Number(o.wordHold) || DEFAULTS.wordHold),
      minHold: Math.max(0.02, Number(o.wordMinHold) || DEFAULTS.wordMinHold),
      // The typewriter's `scaleFrom` becomes the word's own pop, so "Pop each word in"
      // keeps meaning what it says once the words have real times of their own.
      pop: revealing && o.popIn ? 0.55 : 1,
      ease: o.emphasisEase || '',
    };

    // Blowup and marker are per-word overrides, like the keyword highlight: they belong
    // to the words, so they apply over a preset's look as well.
    card.blowup = blowIdx.length ? {
      words: blowIdx, scale: Number(o.blowScale) || 1.55, color: o.blowColor || null,
      from: Number(o.blowFrom) || 1.12, dur: Math.max(0.001, Number(o.blowDur) || 4 / 30),
    } : null;
    const markIdx = matchWords(phrase, o.markWords);
    card.marker = markIdx.length ? {
      words: markIdx, mode: o.markMode === 'solid' ? 'solid' : 'tint', color: o.markColor,
      opacity: Number(o.markOpacity), textColor: o.markTextColor, radius: Number(o.markRadius),
      padX: Number(o.markPadX), padY: Number(o.markPadY), dur: Number(o.markDur),
      soft: Number(o.markSoft), angle: Number(o.markAngle) || 0,
    } : null;
    if (!card.blowup) delete card.blowup;
    if (!card.marker) delete card.marker;
    return card;
  }

  // ------------------------------------------------------------- fillers

  /**
   * Filler-word spans in SOURCE time, for Tighten's `registerTightenSpans()` hook.
   *
   * Multi-word fillers ("you know") are matched first and greedily, so the longer phrase
   * wins over the "know" inside it. Spans are the words' own timings and nothing else -
   * Tighten applies its own pad, and (by design) does NOT apply its silence threshold to
   * them, because a filler word is short by definition.
   */
  function fillerSpans(words, opts) {
    const list = cleanWords(words);
    const fillers = fillerList(opts);
    if (!list.length || !fillers.length) return [];
    const norm = list.map((w) => normWord(w.w));
    const phrases = fillers.map((f) => f.split(/\s+/).map(normWord).filter(Boolean)).filter((p) => p.length);
    const out = [];
    for (let i = 0; i < list.length;) {
      let hit = 0;
      for (const p of phrases) {
        if (p.length > list.length - i) continue;
        let all = true;
        for (let k = 0; k < p.length; k++) if (norm[i + k] !== p[k]) { all = false; break; }
        if (all) { hit = p.length; break; }
      }
      if (hit) {
        out.push([list[i].start, list[i + hit - 1].end]);
        i += hit;
      } else i++;
    }
    return out;
  }

  const API = {
    DEFAULTS,
    parseWhisper, parseSrt, parseTranscript, cleanWords,
    groupPhrases, markKeywords, matchWords, safeZone, phraseCard, metricChips, chipCard,
    fillerSpans, fillerList, normWord, keywordList,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else if (typeof window !== 'undefined') window.Captions = API;
})();
