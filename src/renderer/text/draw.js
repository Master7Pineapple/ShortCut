'use strict';
/**
 * Canvas drawing for text cards.
 *
 * This is the ONLY place text pixels are produced. The preview calls it directly; the
 * exporter calls it to bake PNG frames that ffmpeg overlays. Because both paths run this
 * same code, what you see in the preview is exactly what lands in the MP4 - do not add a
 * second text drawing path.
 */
const TextDraw = (() => {

  /** Build the CSS font shorthand for a style at a given scale. */
  function fontString(style, scale) {
    const px = Math.max(1, style.fontSize * scale);
    return (style.italic ? 'italic ' : 'normal ') + (style.bold ? '700' : '400') + ' ' +
      px + 'px "' + (style.fontFamily || 'Segoe UI').replace(/"/g, '') + '", "Segoe UI", sans-serif';
  }

  /** Split text into rendered lines, honouring explicit newlines and wrap width. */
  function layoutLines(ctx, text, maxWidth) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      if (!para.length) { lines.push(''); continue; }
      const words = para.split(/(\s+)/);
      let cur = '';
      for (const w of words) {
        const next = cur + w;
        if (cur && ctx.measureText(next).width > maxWidth) {
          lines.push(cur.replace(/\s+$/, ''));
          cur = w.replace(/^\s+/, '');
        } else {
          cur = next;
        }
      }
      lines.push(cur.replace(/\s+$/, ''));
    }
    return lines;
  }

  /** Number of typewriter units (characters or words) in the text. */
  function unitCount(text, unit) {
    return unit === 'word' ? String(text).split(/\s+/).filter(Boolean).length : String(text).length;
  }

  /** Truncate text to a reveal fraction, by character or by word. */
  function revealText(text, reveal, unit) {
    if (reveal >= 1) return text;
    if (reveal <= 0) return '';
    if (unit === 'word') {
      const parts = String(text).split(/(\s+)/);
      const words = parts.filter((p) => p.trim().length);
      const want = Math.ceil(words.length * reveal);
      let seen = 0, out = '';
      for (const p of parts) {
        if (p.trim().length) { if (seen >= want) break; seen++; }
        out += p;
      }
      return out;
    }
    return String(text).slice(0, Math.ceil(String(text).length * reveal));
  }

  /**
   * The per-word colour override, or null.
   *
   * `card.highlight = { color, words: [i, ...] }` names words by their index in the
   * card's own text, counted in reading order across every line - which is the order the
   * captions generator produced them in. It is plain JSON on the card like everything
   * else, so it serialises, undoes and presets for free.
   */
  function highlightOf(card) {
    const h = card && card.highlight;
    if (!h || !h.color || !Array.isArray(h.words) || !h.words.length) return null;
    return { color: h.color, words: new Set(h.words.map(Number)) };
  }

  /**
   * Per-word timing and emphasis, from `card.words` - the real times the words were
   * spoken, in the card's OWN time base (seconds from the start of the clip), which is
   * the same `t` every paint pass already runs on.
   *
   *   card.words  = [{ w, start, end }]        one entry per word, in reading order
   *   card.wordFx = { reveal, emphasis, color, scale, rise, attack }
   *
   * This is what separates a caption from a title: a title's letters are staggered by a
   * fixed interval (the typewriter layer), while a caption's words have to land on the
   * syllable. The two compose - a card can have both - because this returns a state that
   * multiplies into the typewriter's, exactly as the animation layers do.
   */
  function wordFxOf(card) {
    const wf = card && card.wordFx;
    const words = card && card.words;
    if (!wf || !Array.isArray(words) || !words.length) return null;
    if (!wf.reveal && !wf.emphasis) return null;
    const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d);
    return {
      words,
      reveal: !!wf.reveal,
      emphasis: !!wf.emphasis,
      color: wf.color || '#ffd166',
      scale: num(wf.scale, 1.12),
      rise: num(wf.rise, 0),
      attack: Math.max(0.001, num(wf.attack, 0.08)),
      // Defaulted here, not only in the generator, so a card written before these
      // existed still behaves - the values live on the clip and old ones lack them.
      lead: Math.max(0, num(wf.lead, 0.06)),
      hold: Math.max(0.05, num(wf.hold, 0.6)),
      minHold: Math.max(0.02, num(wf.minHold, 0.14)),
      pop: num(wf.pop, 1),
    };
  }

  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  /**
   * One word's state at time `t`: is it out yet, is it being said right now, and how far
   * through its entrance it is.
   *
   * `card.words` records what the transcript said, unaltered. What it does NOT record is
   * how long a word should be LIT, and the difference is where every timing complaint
   * came from. A word's stored `end` is the moment the next word starts, so it swallows
   * whatever pause follows - measured on a real 173 s transcript, eleven words held for
   * 0.9-1.26 s, which reads as the highlight lagging the voice. At the other end five
   * words came back 40-60 ms long, which at 30 fps is one frame or none, so the word
   * appeared never to light up at all.
   *
   * So the lit window is the word's own span, clamped into [minHold, hold]:
   *
   *   minHold  a DTW blip still reads as a highlight rather than a dropped frame
   *   hold     past this it is a pause, not a word, and the emphasis lets go
   *   lead     everything happens this much early. DTW marks sit on or just after the
   *            onset, and a highlight that arrives exactly on the consonant feels late;
   *            leading it slightly is what makes it land ON the beat.
   *
   * Overlapping the next word slightly (which minHold can cause) is deliberate: two
   * words briefly warm reads as a highlight travelling along the line, whereas a word
   * that never lights reads as a bug.
   */
  function wordState(fx, i, t) {
    const w = fx.words[i];
    if (!w) return { on: 1, hot: 0, enter: 1 };
    const a = fx.attack;
    const start = w.start - fx.lead;
    const enter = smooth((t - start) / a);
    const on = fx.reveal ? enter : 1;
    if (!fx.emphasis) return { on, hot: 0, enter };
    // `2 * a` is a floor, not a preference: the emphasis peaks at the middle of its
    // window, and a window shorter than two ramps peaks before the word has finished
    // ARRIVING - so the pop is still shrinking the word at the very moment the emphasis
    // wants it big, and the two cancel. Measured on a real transcript, that left 112
    // short words visibly lit for a single frame. Half a window of `a` either side puts
    // the peak exactly where the entrance ends.
    const span = Math.min(Math.max(fx.hold, 2 * a), Math.max(fx.minHold, 2 * a, w.end - w.start));
    const end = start + span;
    const half = Math.min(a, span / 2);
    const hot = Math.min(smooth((t - start) / half), smooth((end - t) / half));
    return { on, hot: Math.max(0, hot), enter };
  }

  /** Blend two #rrggbb colours. Used to ease a word into its emphasis colour. */
  function mixHex(a, b, k) {
    const p = (h) => {
      const s2 = String(h).replace('#', '');
      return s2.length === 3
        ? s2.split('').map((c) => parseInt(c + c, 16))
        : [parseInt(s2.slice(0, 2), 16), parseInt(s2.slice(2, 4), 16), parseInt(s2.slice(4, 6), 16)];
    };
    const A = p(a), B = p(b);
    if (A.some(isNaN) || B.some(isNaN)) return b;
    const c = A.map((v, i) => Math.round(v + (B[i] - v) * Math.max(0, Math.min(1, k))));
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  /** Split a line into typewriter units, keeping whitespace so positions stay right. */
  function splitUnits(line, unit) {
    if (unit === 'word') return line.split(/(\s+)/).filter((s) => s.length);
    return Array.from(line);
  }

  /**
   * EVERY active typewriter layer's state at time `t`.
   *
   * A card usually has two - one that types in and one that types out - and both act on
   * the same units, so this returns a list. Taking only the first match (which it used to)
   * meant a "typewriter out" layer did nothing at all.
   *
   * `raw` is each layer's un-eased progress. The easing is applied per unit instead, which
   * is what makes each letter run the chosen curve while the sweep across the line stays
   * linear.
   */
  function typewriterStates(card, t, dur) {
    if (!card.animEnabled) return [];
    const out = [];
    for (const a of (card.anims || [])) {
      if (a.type !== 'typewriter' || a.disabled) continue;
      const w = TextModel.animWindow(a, dur);
      out.push({
        mode: a.mode,
        unit: a.params.unit || 'char',
        effect: a.params.effect || 'none',
        distance: a.params.distance == null ? 0.6 : a.params.distance,
        overlap: a.params.overlap == null ? 2 : a.params.overlap,
        order: a.params.order || 'forward',
        scaleFrom: a.params.scaleFrom == null ? 0.3 : a.params.scaleFrom,
        easing: a.easing,
        raw: Math.max(0, Math.min(1, (t - w.from) / w.d)),
      });
    }
    return out;
  }

  /** Back-compat single-layer view, used by callers that only want the first layer. */
  function typewriterState(card, t, dur) {
    const all = typewriterStates(card, t, dur);
    if (!all.length) return null;
    const s = all[0];
    return Object.assign({}, s, { sweep: s.mode === 'in' ? s.raw : 1 - s.raw });
  }

  /**
   * Per-unit transform for one typewriter layer.
   *
   * `e` is the eased on-screen-ness of the unit: 1 = settled in place, 0 = fully gone.
   * An "in" layer drives it 0 -> 1 and an "out" layer drives it 1 -> 0, so both share
   * this one function.
   */
  function unitTransform(tw, e, on, unitPx) {
    const d = tw.distance * unitPx;
    // A named direction means "arrives from here" on the way in, and "leaves towards
    // here" on the way out - so the offset flips sign for an out layer. Without this a
    // card typed out with "slides up" would sink back down instead of lifting away.
    const sgn = tw.mode === 'out' ? -1 : 1;
    switch (tw.effect) {
      case 'fade': return { alpha: e, dx: 0, dy: 0, scale: 1 };
      case 'up': return { alpha: e, dx: 0, dy: sgn * (1 - e) * d, scale: 1 };
      case 'down': return { alpha: e, dx: 0, dy: -sgn * (1 - e) * d, scale: 1 };
      case 'left': return { alpha: e, dx: sgn * (1 - e) * d, dy: 0, scale: 1 };
      case 'right': return { alpha: e, dx: -sgn * (1 - e) * d, dy: 0, scale: 1 };
      case 'pop': {
        // scaleFrom < 1 grows in / shrinks away; > 1 shrinks in from big / balloons away.
        const from = tw.scaleFrom == null ? 0.3 : tw.scaleFrom;
        return { alpha: e, dx: 0, dy: 0, scale: from + (1 - from) * e };
      }
      case 'none':
      default: return { alpha: on > 0 ? 1 : 0, dx: 0, dy: 0, scale: 1 };
    }
  }

  /**
   * Combine every typewriter layer for one unit: alpha and scale multiply, offsets add.
   * A type-in and a type-out therefore compose without either knowing about the other.
   */
  function combineUnit(states, k, total, unitPx) {
    let alpha = 1, dx = 0, dy = 0, scale = 1;
    for (const tw of states) {
      const overlap = tw.effect === 'none' ? 1e-4 : Math.max(0.01, tw.overlap);
      // Which unit the sweep reaches first. 'forward' starts at the first unit, so a
      // type-out with 'forward' removes the first letter first - left to right.
      const idx = tw.order === 'backward' ? (total - 1 - k) : k;
      const swept = tw.raw * (total + overlap);
      const reached = Math.max(0, Math.min(1, (swept - idx) / overlap));
      const on = tw.mode === 'in' ? reached : 1 - reached;
      const e = TextModel.ease(tw.easing, on);
      const u = unitTransform(tw, e, on, unitPx);
      alpha *= u.alpha;
      dx += u.dx;
      dy += u.dy;
      scale *= u.scale;
    }
    return { alpha, dx, dy, scale };
  }

  /**
   * Geometry for one frame: the drawable items, the block rect, and the padded rect that
   * bounds everything actually painted (glow, shadow, blur and stroke all extend past the
   * glyphs).
   *
   * Line wrapping always uses the FULL text, even mid-typewriter, so revealing letters
   * never reflows the lines underneath them.
   */
  function measure(ctx, clip, W, H, t) {
    const card = clip.card;
    const st = card.style;
    const dur = Math.max(0.001, clip.out - clip.in);
    const tr = TextModel.evalCard(card, t, dur);
    const scale = (H / 1920) * tr.scale; // style sizes are authored against a 1080x1920 frame

    ctx.save();
    ctx.font = fontString(st, scale);
    try { ctx.letterSpacing = (st.letterSpacing * scale) + 'px'; } catch (e) { /* older engines */ }

    const text = st.uppercase ? String(card.text).toUpperCase() : String(card.text);
    const maxWidth = st.maxWidth * W;
    const lines = layoutLines(ctx, text, maxWidth);
    const lineH = st.fontSize * scale * st.lineHeight;
    const widths = lines.map((l) => ctx.measureText(l).width);
    const blockW = Math.max(1, ...widths);
    const blockH = Math.max(lineH, lines.length * lineH);

    const cx = (st.x + tr.dx) * W;
    const cy = (st.y + tr.dy) * H;
    const block = { x: cx - blockW / 2, y: cy - blockH / 2, w: blockW, h: blockH };

    const lineX = (i) => {
      if (st.align === 'left') return block.x;
      if (st.align === 'right') return block.x + block.w - widths[i];
      return block.x + (block.w - widths[i]) / 2;
    };
    const lineY = (i) => block.y + lineH * i + lineH / 2;

    const tws = typewriterStates(card, t, dur);
    const hi = highlightOf(card);
    const fx = wordFxOf(card);
    // A line is one fillText unless something needs the words apart. Splitting places
    // each word at its own measured offset and loses the kerning between them, so only a
    // card that actually highlights, reveals or emphasises words pays for it.
    const perWord = !!hi || !!fx;
    const baseColor = st.fill.type === 'solid' ? st.fill.color : null;
    const items = [];

    // Word index in reading order across the whole card - what `card.highlight.words`
    // indexes into. `nextWord` is called once per unit, in order, by both paths below.
    let wordN = 0, inWord = false;
    const nextWord = (unit, isWord) => {
      if (!unit.trim().length) { inWord = false; return -1; }
      if (isWord) return wordN++;
      if (!inWord) { inWord = true; wordN++; }
      return wordN - 1;
    };
    /**
     * The look of one word: its own colour, and what the voice is doing to it.
     *
     * Precedence is emphasis over keyword over the card's fill, because emphasis is
     * momentary and the other two are not - a keyword still lights up as it is said, then
     * settles back to being a keyword.
     */
    const wordLook = (wi) => {
      const keyed = hi && wi >= 0 && hi.words.has(wi) ? hi.color : null;
      if (!fx || wi < 0) return { alpha: 1, scale: 1, dy: 0, paint: keyed };
      const ws = wordState(fx, wi, t);
      const rest = keyed || baseColor;
      let paint = keyed;
      if (fx.emphasis && ws.hot > 0.001) {
        // Blending needs a colour to blend FROM. A gradient fill has none, so there the
        // emphasis colour is applied outright once it is more on than off.
        paint = rest ? mixHex(rest, fx.color, ws.hot) : (ws.hot > 0.5 ? fx.color : keyed);
      }
      // The pop belongs to the word's own entrance, not to a uniform sweep across the
      // line - that is the whole point of having real times. It multiplies with the
      // emphasis, so a word can pop in and be lit at once.
      const pop = fx.reveal && fx.pop !== 1 ? fx.pop + (1 - fx.pop) * ws.enter : 1;
      return {
        alpha: ws.on,
        scale: pop * (1 + (fx.scale - 1) * ws.hot),
        dy: -fx.rise * ws.hot,
        paint,
      };
    };

    if (!tws.length) {
      // With no highlight a line is ONE fillText, exactly as it always was: splitting it
      // into words would place each one by its own measured offset and lose the kerning
      // between them. A highlighted card has to be per-word, so it pays that cost.
      lines.forEach((l, i) => {
        if (!l.length) return;
        if (!perWord) {
          items.push({ text: l, x: lineX(i), y: lineY(i), w: widths[i], alpha: 1, dx: 0, dy: 0, scale: 1 });
          return;
        }
        const x0 = lineX(i), y = lineY(i);
        let prefix = '';
        for (const u of splitUnits(l, 'word')) {
          const ux = x0 + ctx.measureText(prefix).width;
          prefix += u;
          const wi = nextWord(u, true);
          if (wi < 0) continue;
          const lk = wordLook(wi);
          if (lk.alpha <= 0.001) continue;      // not spoken yet
          items.push({
            text: u, x: ux, y, w: ctx.measureText(u).width,
            alpha: lk.alpha, dx: 0, dy: lk.dy, scale: lk.scale,
            wordIndex: wi, paint: lk.paint,
          });
        }
        inWord = false;
      });
    } else {
      // Layers share one set of units, so the first layer decides letters vs words.
      const perLine = lines.map((l) => splitUnits(l, tws[0].unit));
      // Count the visible units first: the stagger needs to know the total up front.
      let total = 0;
      for (const us of perLine) for (const u of us) if (u.trim().length) total++;
      total = Math.max(1, total);

      const unitPx = st.fontSize * scale;
      let k = 0;

      const byWord = tws[0].unit === 'word';
      perLine.forEach((us, i) => {
        const x0 = lineX(i);
        const y = lineY(i);
        let prefix = '';
        for (const u of us) {
          const ux = x0 + ctx.measureText(prefix).width;
          prefix += u;
          // A word index is taken for EVERY unit, including the invisible ones: an
          // out-of-window unit still occupies its place in the word order, so skipping
          // it here would shift every highlight after it by one.
          const wi = nextWord(u, byWord);
          if (wi < 0) continue;                 // whitespace: it spaces, it paints nothing
          const t2 = combineUnit(tws, k, total, unitPx);
          k++;
          // The two compose the way animation layers do: alpha and scale multiply,
          // offsets add. So a card can type in AND have the spoken word lift out of it.
          const lk = wordLook(wi);
          const alpha = t2.alpha * lk.alpha;
          if (alpha <= 0.001) continue;
          items.push({
            text: u, x: ux, y, w: ctx.measureText(u).width,
            alpha, dx: t2.dx, dy: t2.dy + lk.dy, scale: t2.scale * lk.scale,
            wordIndex: wi, paint: lk.paint,
          });
        }
        inWord = false;
      });
    }
    ctx.restore();

    // Everything that paints outside the glyph boxes.
    let pad = st.fontSize * scale * 0.4;
    if (st.stroke.on) pad += st.stroke.width * scale;
    if (st.shadow.on) pad += (st.shadow.blur + Math.abs(st.shadow.distance)) * scale;
    if (st.glow.on) pad += st.glow.size * (1 + st.glow.spread) * scale * 1.6 * Math.max(1, tr.glow);
    if (st.blur.on) pad += st.blur.amount * scale * 3;
    if (st.bg.on) pad += st.bg.padding * scale;
    if (tr.rotate) pad += Math.max(blockW, blockH) * 0.5; // rotation sweeps the corners out
    // An emphasised word grows and lifts. animatedBounds() samples this function across
    // the clip, but a word shorter than its sampling step could peak between two samples
    // - so the room is reserved here rather than discovered there.
    if (fx) pad += lineH * Math.max(0, fx.scale - 1, fx.pop - 1) + Math.abs(fx.rise);

    // Union of the item boxes, which already include per-unit offsets and scaling.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      const icx = it.x + it.w / 2 + it.dx;
      const icy = it.y + it.dy;
      const hw = (it.w / 2) * it.scale, hh = (lineH / 2) * it.scale;
      x0 = Math.min(x0, icx - hw); x1 = Math.max(x1, icx + hw);
      y0 = Math.min(y0, icy - hh); y1 = Math.max(y1, icy + hh);
    }
    if (!items.length) { x0 = block.x; y0 = block.y; x1 = block.x + block.w; y1 = block.y + block.h; }

    return {
      tr, scale, lines, widths, lineH, block, text, items,
      bounds: { x: x0 - pad, y: y0 - pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2 },
    };
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex).replace('#', '');
    const n = h.length === 3
      ? h.split('').map((c) => parseInt(c + c, 16))
      : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    return 'rgba(' + n[0] + ',' + n[1] + ',' + n[2] + ',' + alpha + ')';
  }

  /** Linear gradient across the text block, rotated by `angle` degrees. */
  function makeGradient(ctx, g, block) {
    const rad = (g.angle || 0) * Math.PI / 180;
    const cx = block.x + block.w / 2, cy = block.y + block.h / 2;
    const len = (Math.abs(Math.cos(rad)) * block.w + Math.abs(Math.sin(rad)) * block.h) / 2;
    const dx = Math.cos(rad) * len, dy = Math.sin(rad) * len;
    const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    const stops = [...(g.stops || [])].sort((a, b) => a.pos - b.pos);
    if (!stops.length) return '#ffffff';
    for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.pos)), s.color);
    return grad;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Run `fn(item)` for every drawable with its own transform and alpha applied. */
  function forEachItem(ctx, items, baseAlpha, fn) {
    for (const it of items) {
      if (it.alpha <= 0.001) continue;
      ctx.save();
      ctx.globalAlpha = baseAlpha * it.alpha;
      if (it.dx || it.dy || it.scale !== 1) {
        const icx = it.x + it.w / 2, icy = it.y;
        ctx.translate(icx + it.dx, icy + it.dy);
        ctx.scale(it.scale, it.scale);
        ctx.translate(-icx, -icy);
      }
      fn(it);
      ctx.restore();
    }
  }

  /** Underline / strikethrough for one item. */
  function decorations(ctx, st, it, scale, paint) {
    const thick = Math.max(1, st.fontSize * scale * 0.06);
    ctx.fillStyle = paint;
    if (st.underline) ctx.fillRect(it.x, it.y + st.fontSize * scale * 0.18, it.w, thick);
    if (st.strikethrough) ctx.fillRect(it.x, it.y - st.fontSize * scale * 0.28, it.w, thick);
  }

  /** Paint the card once, at `alpha`, straight onto `ctx`. */
  function paintInto(ctx, clip, W, H, m, alpha) {
    const st = clip.card.style;
    const { tr, scale, items, block } = m;
    if (alpha <= 0.001 || !items.length) return;

    ctx.save();
    if (st.blur.on && st.blur.amount > 0) ctx.filter = 'blur(' + (st.blur.amount * scale) + 'px)';

    if (tr.rotate) {
      const cx = block.x + block.w / 2, cy = block.y + block.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(tr.rotate * Math.PI / 180);
      ctx.translate(-cx, -cy);
    }

    ctx.font = fontString(st, scale);
    try { ctx.letterSpacing = (st.letterSpacing * scale) + 'px'; } catch (e) {}
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    if (st.bg.on) {
      const p = st.bg.padding * scale;
      ctx.save();
      ctx.globalAlpha = alpha * st.bg.opacity;
      ctx.fillStyle = st.bg.color;
      roundRect(ctx, block.x - p, block.y - p, block.w + p * 2, block.h + p * 2, st.bg.radius * scale);
      ctx.fill();
      ctx.restore();
    }

    const paintStyle = st.fill.type === 'gradient'
      ? makeGradient(ctx, st.fill.gradient, block)
      : st.fill.color;

    const glowAmt = st.glow.on ? Math.max(0, tr.glow) : 0;

    // Pass 1: the glow halo behind the glyphs. Repeated passes deepen it.
    if (glowAmt > 0 && st.glow.size > 0) {
      ctx.save();
      ctx.shadowColor = st.glow.color;
      ctx.shadowBlur = st.glow.size * (1 + st.glow.spread) * scale * glowAmt;
      ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
      ctx.fillStyle = paintStyle;
      const passes = Math.max(1, Math.round(st.glow.intensity * glowAmt));
      for (let p = 0; p < passes; p++) {
        forEachItem(ctx, items, alpha, (it) => {
          ctx.fillStyle = it.paint || paintStyle;
          ctx.fillText(it.text, it.x, it.y);
        });
      }
      ctx.restore();
    }

    // Pass 2: drop shadow, cast at `angle` from the text.
    if (st.shadow.on) {
      ctx.save();
      const rad = st.shadow.angle * Math.PI / 180;
      ctx.shadowColor = hexToRgba(st.shadow.color, st.shadow.opacity);
      ctx.shadowBlur = st.shadow.blur * scale;
      ctx.shadowOffsetX = Math.cos(rad) * st.shadow.distance * scale;
      ctx.shadowOffsetY = Math.sin(rad) * st.shadow.distance * scale;
      ctx.fillStyle = paintStyle;
      forEachItem(ctx, items, alpha, (it) => {
        ctx.fillStyle = it.paint || paintStyle;
        ctx.fillText(it.text, it.x, it.y);
      });
      ctx.restore();
    }

    // Pass 3: the crisp text itself, plus stroke and decorations.
    if (st.stroke.on && st.stroke.width > 0) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineWidth = st.stroke.width * scale;
      ctx.strokeStyle = st.stroke.color;
      forEachItem(ctx, items, alpha, (it) => ctx.strokeText(it.text, it.x, it.y));
      ctx.restore();
    }
    ctx.fillStyle = paintStyle;
    forEachItem(ctx, items, alpha, (it) => {
      // A highlighted word overrides the card's fill and nothing else - the stroke, the
      // shadow and the glow colour are the card's, so a keyword reads as the same text
      // in a different ink rather than as a second, differently-dressed card.
      const paint = it.paint || paintStyle;
      ctx.fillStyle = paint;
      ctx.fillText(it.text, it.x, it.y);
      if (st.underline || st.strikethrough) decorations(ctx, st, it, scale, paint);
    });

    ctx.restore();
  }

  /**
   * The bloom that puts the glow ON the glyphs instead of only behind them.
   *
   * Added with `lighter` so it reads as emitted light rather than a coloured drop shadow.
   * It MUST be composited inside the card's own layer, never straight onto `ctx`: the
   * preview draws over the video frame while the exporter draws onto transparency, and an
   * additive pass on the target would blend differently in the two cases - the preview
   * would stop matching the MP4.
   */
  function paintGlowOver(lctx, clip, W, H, m) {
    const st = clip.card.style;
    const { scale, items, tr } = m;
    const over = (st.glow.over || 0) * Math.max(0, tr.glow);
    if (over <= 0 || !items.length) return;

    lctx.save();
    lctx.globalCompositeOperation = 'lighter';
    lctx.font = fontString(st, scale);
    try { lctx.letterSpacing = (st.letterSpacing * scale) + 'px'; } catch (e) {}
    lctx.textBaseline = 'middle';
    lctx.textAlign = 'left';
    lctx.shadowColor = st.glow.color;
    lctx.shadowBlur = st.glow.size * (1 + st.glow.spread) * scale * 0.6 * Math.max(0, tr.glow);
    lctx.shadowOffsetX = lctx.shadowOffsetY = 0;
    lctx.fillStyle = st.glow.color;
    forEachItem(lctx, items, Math.min(1, over), (it) => lctx.fillText(it.text, it.x, it.y));
    lctx.restore();
  }

  // Reused between frames so drawing does not allocate canvases per call.
  const scratch = {};
  function offscreen(name, w, h) {
    let c = scratch[name];
    if (!c) c = scratch[name] = document.createElement('canvas');
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  /** Paint the card, routing through a layer when the glow has to cover the glyphs. */
  function paint(ctx, clip, W, H, m) {
    const st = clip.card.style;
    const needsLayer = st.glow.on && (st.glow.over || 0) > 0 && m.tr.glow > 0;
    if (!needsLayer) { paintInto(ctx, clip, W, H, m, m.tr.opacity); return; }

    const layer = offscreen('glowLayer', W, H);
    const lctx = layer.getContext('2d');
    lctx.clearRect(0, 0, W, H);
    paintInto(lctx, clip, W, H, m, 1);
    paintGlowOver(lctx, clip, W, H, m);

    ctx.save();
    ctx.globalAlpha = m.tr.opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  /**
   * Draw a text card at local time `t`.
   *
   * Motion blur samples the animation across the shutter interval and averages the
   * samples - genuine temporal sampling of the same transform the render uses, not a blur
   * filter, which is why it costs `samples` times as much to draw.
   */
  function draw(ctx, clip, W, H, t, frameDur) {
    const m = measure(ctx, clip, W, H, t);
    const mb = m.tr.motionBlur;
    if (!mb || !frameDur) { paint(ctx, clip, W, H, m); return m; }

    const samples = Math.max(2, Math.min(32, Math.round(m.tr.mbSamples || 8)));
    const shutter = frameDur * Math.max(0, Math.min(2, mb));
    const dur = Math.max(0.001, clip.out - clip.in);

    // Slide the shutter to stay inside the clip instead of letting it hang off the ends.
    // A centred shutter at t=0 puts half its samples at negative time, where every
    // animation clamps to its start state - those samples all stack in the same place and
    // punch a sharp, saturated copy through the middle of the blur. That is why the first
    // frames of a slide looked crisp (and the glow banded) while later frames were smooth.
    let t0 = t - shutter / 2;
    let t1 = t + shutter / 2;
    if (t0 < 0) { t0 = 0; t1 = Math.min(dur, shutter); }
    if (t1 > dur) { t1 = dur; t0 = Math.max(0, dur - shutter); }
    const span = t1 - t0;

    // Each sample is painted cleanly (source-over) into `sample`, then ADDED into `accum`
    // at 1/samples. The addition matters: compositing the samples straight onto the target
    // with source-over at 1/n converges to 1-(1-1/n)^n (~63%), which visibly washes the
    // text out. Additive accumulation of premultiplied samples is a true temporal average,
    // so fully overlapping pixels come back to full opacity.
    const sample = offscreen('mbSample', W, H);
    const sctx = sample.getContext('2d');
    const accum = offscreen('mbAccum', W, H);
    const actx = accum.getContext('2d');
    actx.clearRect(0, 0, W, H);

    actx.save();
    actx.globalCompositeOperation = 'lighter';
    actx.globalAlpha = 1 / samples;
    for (let i = 0; i < samples; i++) {
      const st = t0 + (i / (samples - 1)) * span;
      const sm = measure(sctx, clip, W, H, st);
      sctx.clearRect(0, 0, W, H);
      paint(sctx, clip, W, H, sm);
      actx.drawImage(sample, 0, 0);
    }
    actx.restore();

    ctx.drawImage(accum, 0, 0);
    return m;
  }

  /**
   * Union of the painted bounds across a clip, sampled every `step` seconds.
   * The exporter uses this to bake the smallest PNG that still holds the animation,
   * instead of a full-frame PNG per frame.
   */
  function animatedBounds(ctx, clip, W, H, step, from, to) {
    const dur = Math.max(0.001, clip.out - clip.in);
    const t0 = from == null ? 0 : Math.max(0, from);
    const t1 = to == null ? dur : Math.min(dur, to);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let t = t0; t <= t1 + 1e-6; t += (step || 1 / 15)) {
      const b = measure(ctx, clip, W, H, Math.min(t, t1)).bounds;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    const pad = 8;
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
    if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: W, h: H };
    // Even widths/heights keep yuv420p chroma subsampling happy after overlay.
    let w = x1 - x0, h = y1 - y0;
    if (w % 2) { w = Math.min(W - x0, w + 1); }
    if (h % 2) { h = Math.min(H - y0, h + 1); }
    return { x: x0, y: y0, w, h };
  }

  return {
    draw, paint, measure, animatedBounds,
    fontString, layoutLines, unitCount, revealText, splitUnits,
    typewriterState, typewriterStates, combineUnit,
  };
})();
