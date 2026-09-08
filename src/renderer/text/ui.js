'use strict';
/**
 * The text card editor panel.
 *
 * Most controls are generated from declarative schemas (see SECTIONS below), so adding a
 * new style property is usually one schema line plus its use in TextDraw. The hand-written
 * widgets are the ones a schema cannot express: the gradient stop editor, the easing curve
 * editor, the animation layer list, the keyframe tracks and the preset bar.
 *
 * The host wires itself in through TextUI.init({...hooks}); this module never touches
 * app.js globals directly.
 */
const TextUI = (() => {

  let host = null;          // { container, onEdit, onChanged, getClip, getLocalTime, seekLocal, log }
  let fonts = [];
  let openSections = { content: true, font: true, fill: false, effects: false, anim: true, keys: false, presets: false };
  let editing = false;      // true between pointerdown and pointerup of one gesture

  // ------------------------------------------------------------- small utils

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const set = (obj, path, v) => {
    const parts = path.split('.');
    const last = parts.pop();
    const target = parts.reduce((o, k) => o[k], obj);
    target[last] = v;
  };

  /** Decimal places implied by a step, so wheel steps do not accumulate float noise. */
  function decimalsFor(step) {
    const s = String(step);
    const dot = s.indexOf('.');
    if (dot < 0) return 0;
    return Math.min(6, s.length - dot - 1);
  }

  /**
   * Scroll over a control to nudge its value.
   *   wheel        one step   (0.01 on a 0.01-step control, 1 on a 1-step control)
   *   shift+wheel  ten steps
   *   ctrl+wheel   a tenth of a step
   *
   * The event is consumed so the panel underneath does not scroll away while adjusting.
   */
  function attachWheel(input, opts) {
    let idle = null;
    input.addEventListener('wheel', (e) => {
      if (input.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const base = Math.abs(opts.step) || 1;
      const mult = e.shiftKey ? 10 : (e.ctrlKey || e.altKey) ? 0.1 : 1;
      const inc = base * mult;
      const cur = parseFloat(opts.get());
      if (!isFinite(cur)) return;
      let v = cur + (e.deltaY < 0 ? inc : -inc);
      // Round to whichever is finer: the increment, or the precision already in the value.
      // Rounding only to the increment would throw away a value the author fine-tuned
      // with ctrl+scroll the moment they scrolled normally again.
      v = parseFloat(v.toFixed(Math.max(decimalsFor(inc), decimalsFor(cur))));
      if (opts.min != null) v = Math.max(opts.min, v);
      if (opts.max != null) v = Math.min(opts.max, v);
      if (v === cur) return;
      beginEdit();
      opts.set(v);
      // One undo entry per burst of scrolling rather than one per notch.
      clearTimeout(idle);
      idle = setTimeout(endEdit, 400);
    }, { passive: false });
  }

  /** Snapshot for undo at most once per drag/typing gesture. */
  function beginEdit() {
    if (editing) return;
    editing = true;
    host.onEdit();
  }
  function endEdit() { editing = false; }

  // Every gesture must be able to END, or `editing` stays true and beginEdit() stops
  // snapshotting - undo would quietly stop recording after the first slider drag. Sliders
  // and colour swatches have no natural "commit" event of their own, so close the gesture
  // globally on pointerup.
  document.addEventListener('pointerup', endEdit);
  document.addEventListener('pointercancel', endEdit);

  function changed() { host.onChanged(); }

  // -------------------------------------------------------- schema controls

  /**
   * Control spec:
   *   { path, label, type, min, max, step, unit, options, digits }
   *   type: range | number | color | select | check | text | area | buttons
   *
   * `defaults` is an object of the same shape as `obj`; when given, every control grows a
   * reset button that puts that property back to its default. Sliders always come with a
   * typable number box beside them - every value in the app can be entered exactly.
   */
  function control(spec, obj, defaults, opts) {
    const row = el('div', 'tc-row');
    const lab = el('label', 'tc-label', spec.label + (spec.unit ? ' (' + spec.unit.trim() + ')' : ''));
    lab.title = spec.path;
    row.appendChild(lab);

    const val = get(obj, spec.path);
    const defVal = defaults === undefined ? undefined : get(defaults, spec.path);
    let setUI = null;

    if (spec.type === 'range' || spec.type === 'number') {
      const fmt = (n) => (spec.digits != null ? Number(n).toFixed(spec.digits) : String(n));
      const range = el('input');
      range.type = spec.type === 'range' ? 'range' : 'number';
      range.min = spec.min; range.max = spec.max; range.step = spec.step;
      range.value = val;

      const num = el('input', 'tc-num');
      num.type = 'number';
      num.step = spec.step;
      num.value = fmt(val);
      num.title = 'Type an exact value';

      const push = (v, from) => {
        let n = parseFloat(v);
        if (!isFinite(n)) return;
        // The slider is clamped to its range; the number box may go past it when the
        // author really wants to (a 500px glow, say), so only the slider gets clamped.
        set(obj, spec.path, n);
        if (from !== 'range') range.value = Math.max(spec.min, Math.min(spec.max, n));
        if (from !== 'num') num.value = fmt(n);
        changed();
      };
      setUI = (v) => { range.value = v; num.value = fmt(v); };

      range.addEventListener('pointerdown', beginEdit);
      range.addEventListener('focus', beginEdit);
      range.addEventListener('input', () => push(range.value, 'range'));
      num.addEventListener('focus', beginEdit);
      num.addEventListener('blur', endEdit);
      num.addEventListener('input', () => push(num.value, 'num'));
      // Typing must not reach the editor's single-key shortcuts.
      num.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') num.blur();
      });

      const wheelOpts = {
        step: spec.step, min: spec.min, max: spec.max,
        get: () => get(obj, spec.path),
        set: (v) => { set(obj, spec.path, v); setUI(v); changed(); },
      };
      attachWheel(range, wheelOpts);
      attachWheel(num, wheelOpts);

      row.appendChild(range);
      row.appendChild(num);
      row.classList.add('has-num');
    } else if (spec.type === 'color') {
      const input = el('input');
      input.type = 'color';
      input.value = val;
      const hex = el('input', 'tc-num tc-hex');
      hex.type = 'text';
      hex.value = val;
      hex.title = 'Type a hex colour';
      const push = (v, from) => {
        if (!/^#[0-9a-f]{6}$/i.test(v)) return;
        set(obj, spec.path, v);
        if (from !== 'color') input.value = v;
        if (from !== 'hex') hex.value = v;
        changed();
      };
      setUI = (v) => { input.value = v; hex.value = v; };
      input.addEventListener('pointerdown', beginEdit);
      input.addEventListener('input', () => push(input.value, 'color'));
      hex.addEventListener('focus', beginEdit);
      hex.addEventListener('blur', endEdit);
      hex.addEventListener('input', () => push(hex.value.trim(), 'hex'));
      row.appendChild(input);
      row.appendChild(hex);
      row.classList.add('has-num');
    } else if (spec.type === 'select') {
      const input = el('select');
      for (const opt of spec.options) {
        const o = el('option');
        o.value = typeof opt === 'string' ? opt : opt.value;
        o.textContent = typeof opt === 'string' ? opt : opt.label;
        input.appendChild(o);
      }
      input.value = val;
      setUI = (v) => { input.value = v; };
      input.addEventListener('change', () => {
        beginEdit(); set(obj, spec.path, input.value); endEdit();
        // A select can change which other rows are relevant, so the owning panel rebuilds.
        if (opts && opts.rebuild) opts.rebuild(); else rebuild();
        changed();
      });
      row.appendChild(input);
    } else if (spec.type === 'check') {
      const input = el('input');
      input.type = 'checkbox';
      input.checked = !!val;
      setUI = (v) => { input.checked = !!v; };
      input.addEventListener('change', () => {
        beginEdit(); set(obj, spec.path, input.checked); endEdit(); changed();
      });
      row.insertBefore(input, lab);
      row.classList.add('tc-check');
    } else if (spec.type === 'area') {
      const input = el('textarea');
      input.rows = 3;
      input.value = val;
      setUI = (v) => { input.value = v; };
      input.addEventListener('focus', beginEdit);
      input.addEventListener('blur', endEdit);
      input.addEventListener('input', () => { set(obj, spec.path, input.value); changed(); });
      row.classList.add('tc-area');
      row.appendChild(input);
    } else if (spec.type === 'buttons') {
      const group = el('div', 'tc-btns');
      const paint = (v) => group.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.v === String(v));
      });
      for (const opt of spec.options) {
        const b = el('button', 'mini', opt.label);
        b.dataset.v = opt.value;
        b.title = opt.title || opt.label;
        b.addEventListener('click', () => {
          beginEdit(); set(obj, spec.path, opt.value); endEdit();
          paint(opt.value); changed();
        });
        group.appendChild(b);
      }
      paint(val);
      setUI = paint;
      row.appendChild(group);
    }

    // Per-parameter reset.
    if (defVal !== undefined) {
      const rb = el('button', 'tc-reset', '↺');
      rb.title = 'Reset to default (' + (typeof defVal === 'number' ? defVal : String(defVal)) + ')';
      rb.addEventListener('click', () => {
        beginEdit();
        set(obj, spec.path, typeof defVal === 'object' && defVal !== null
          ? JSON.parse(JSON.stringify(defVal)) : defVal);
        endEdit();
        if (setUI) setUI(get(obj, spec.path));
        changed();
      });
      row.appendChild(rb);
      row.classList.add('has-reset');
    }
    return row;
  }

  /** Toggle buttons for the boolean style flags (bold / italic / underline / strike). */
  function toggleBar(card) {
    const row = el('div', 'tc-row');
    row.appendChild(el('label', 'tc-label', 'Style'));
    const group = el('div', 'tc-btns');
    const defs = [
      ['bold', 'B', 'Bold', 'font-weight:700'],
      ['italic', 'I', 'Italic', 'font-style:italic'],
      ['underline', 'U', 'Underline', 'text-decoration:underline'],
      ['strikethrough', 'S', 'Strikethrough', 'text-decoration:line-through'],
      ['uppercase', 'AA', 'Uppercase', 'font-size:10px'],
    ];
    for (const [key, label, title, css] of defs) {
      const b = el('button', 'mini' + (card.style[key] ? ' on' : ''), label);
      b.title = title;
      b.setAttribute('style', css);
      b.addEventListener('click', () => {
        beginEdit(); card.style[key] = !card.style[key]; endEdit();
        b.classList.toggle('on', card.style[key]);
        changed();
      });
      group.appendChild(b);
    }
    row.appendChild(group);
    return row;
  }

  // ------------------------------------------------------- gradient editor

  function gradientEditor(card) {
    const g = card.style.fill.gradient;
    const wrap = el('div', 'tc-grad');

    const bar = el('div', 'tc-grad-bar');
    const stopsLayer = el('div', 'tc-grad-stops');
    bar.appendChild(stopsLayer);

    const paint = () => {
      const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
      bar.style.background = 'linear-gradient(90deg,' +
        sorted.map((s) => s.color + ' ' + (s.pos * 100).toFixed(1) + '%').join(',') + ')';
    };

    const renderStops = () => {
      stopsLayer.innerHTML = '';
      g.stops.forEach((s, i) => {
        const h = el('div', 'tc-stop');
        h.style.left = (s.pos * 100) + '%';
        h.style.background = s.color;
        h.title = 'Drag to move, double-click to remove';

        h.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          beginEdit();
          const rect = bar.getBoundingClientRect();
          const move = (e2) => {
            s.pos = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
            h.style.left = (s.pos * 100) + '%';
            paint();
            changed();
          };
          const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            endEdit();
          };
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
        });

        h.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          if (g.stops.length <= 2) { host.log('A gradient needs at least two stops.'); return; }
          beginEdit(); g.stops.splice(i, 1); endEdit();
          renderStops(); paint(); changed();
        });

        // A colour swatch input sits under each handle.
        const picker = el('input', 'tc-stop-color');
        picker.type = 'color';
        picker.value = s.color;
        picker.style.left = (s.pos * 100) + '%';
        picker.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); beginEdit(); });
        picker.addEventListener('input', () => {
          s.color = picker.value; h.style.background = s.color; paint(); changed();
        });
        picker.addEventListener('change', endEdit);

        stopsLayer.appendChild(h);
        stopsLayer.appendChild(picker);
      });
    };

    bar.addEventListener('dblclick', (ev) => {
      const rect = bar.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      beginEdit();
      g.stops.push({ pos, color: '#ffffff' });
      endEdit();
      renderStops(); paint(); changed();
    });

    const hint = el('div', 'tc-hint', 'Double-click the bar to add a stop, a handle to remove it.');
    wrap.appendChild(bar);
    wrap.appendChild(hint);
    wrap.appendChild(control({ path: 'style.fill.gradient.angle', label: 'Angle', type: 'range', min: 0, max: 360, step: 1 }, card, TextModel.defaultCard()));
    renderStops();
    paint();
    return wrap;
  }

  // ---------------------------------------------------------- curve editor

  /** Interactive cubic-bezier editor with named-preset fallback. */
  function curveEditor(owner, onDone) {
    const wrap = el('div', 'tc-curve');
    const cv = el('canvas', 'tc-curve-cv');
    cv.width = 150; cv.height = 150;
    const ctx = cv.getContext('2d');

    const presetSel = el('select', 'tc-curve-preset');
    for (const name of Object.keys(TextModel.EASING_PRESETS)) {
      const o = el('option'); o.value = name; o.textContent = name; presetSel.appendChild(o);
    }
    const matchPreset = () => {
      for (const [name, p] of Object.entries(TextModel.EASING_PRESETS)) {
        if (JSON.stringify(p) === JSON.stringify(owner.easing)) return name;
      }
      return '';
    };
    presetSel.value = matchPreset();
    presetSel.addEventListener('change', () => {
      beginEdit();
      owner.easing = TextModel.cloneEasing(TextModel.EASING_PRESETS[presetSel.value]);
      endEdit();
      paint(); changed(); if (onDone) onDone();
    });

    const paint = () => {
      const w = cv.width, h = cv.height, pad = 14;
      const X = (x) => pad + x * (w - pad * 2);
      const Y = (y) => h - pad - y * (h - pad * 2);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#14161b'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#2f343f'; ctx.lineWidth = 1;
      ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);

      // The curve, sampled through the same evaluator the animation uses.
      ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        const v = TextModel.ease(owner.easing, t);
        if (i === 0) ctx.moveTo(X(t), Y(v)); else ctx.lineTo(X(t), Y(v));
      }
      ctx.stroke();

      if (owner.easing.kind === 'bezier') {
        const p = owner.easing.p;
        ctx.strokeStyle = '#8b93a3'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(p[0]), Y(p[1])); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X(1), Y(1)); ctx.lineTo(X(p[2]), Y(p[3])); ctx.stroke();
        ctx.fillStyle = '#ff5c7a';
        ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 5, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(X(p[2]), Y(p[3]), 5, 0, 7); ctx.fill();
      } else {
        ctx.fillStyle = '#8b93a3'; ctx.font = '10px Consolas, monospace';
        ctx.fillText(owner.easing.name, pad + 3, pad + 11);
      }
    };

    cv.addEventListener('pointerdown', (ev) => {
      if (owner.easing.kind !== 'bezier') {
        // Dragging a named curve converts it to an editable bezier.
        beginEdit();
        owner.easing = { kind: 'bezier', p: [0.42, 0, 0.58, 1] };
        endEdit();
      }
      const rect = cv.getBoundingClientRect();
      const pad = 14;
      const toX = (cx) => (cx - rect.left - pad) / (cv.width - pad * 2);
      const toY = (cy) => 1 - (cy - rect.top - pad) / (cv.height - pad * 2);
      const p = owner.easing.p;
      const d0 = Math.hypot(toX(ev.clientX) - p[0], toY(ev.clientY) - p[1]);
      const d1 = Math.hypot(toX(ev.clientX) - p[2], toY(ev.clientY) - p[3]);
      const idx = d0 <= d1 ? 0 : 2;
      beginEdit();
      const move = (e2) => {
        p[idx] = Math.max(0, Math.min(1, toX(e2.clientX)));
        p[idx + 1] = Math.max(-1, Math.min(2, toY(e2.clientY)));
        presetSel.value = matchPreset();
        paint(); changed();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        endEdit();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      move(ev);
    });

    wrap.appendChild(presetSel);
    wrap.appendChild(cv);
    wrap.appendChild(el('div', 'tc-hint', 'Drag the two handles to shape the curve.'));
    paint();
    return wrap;
  }

  // ------------------------------------------------------- animation layers

  const SLIDE_DIRS = [
    { value: 'left', label: 'From left' }, { value: 'right', label: 'From right' },
    { value: 'up', label: 'From top' }, { value: 'down', label: 'From bottom' },
  ];

  function animEntry(card, a, clipDur) {
    const box = el('div', 'tc-anim' + (a.disabled ? ' off' : ''));
    const head = el('div', 'tc-anim-head');
    const w = TextModel.animWindow(a, clipDur);
    head.innerHTML = '<b>' + (TextModel.ANIM_TYPES[a.type] || {}).label + '</b>' +
      '<span class="tc-tag">' + a.mode + '</span>' +
      '<span class="tc-when">' + w.from.toFixed(2) + 's → ' + w.to.toFixed(2) + 's</span>';

    const btnOff = el('button', 'mini', a.disabled ? 'Off' : 'On');
    btnOff.title = 'Enable or disable this layer';
    btnOff.addEventListener('click', () => {
      beginEdit(); a.disabled = !a.disabled; endEdit(); rebuild(); changed();
    });
    const btnDel = el('button', 'mini', 'Del');
    btnDel.title = 'Remove this animation layer';
    btnDel.addEventListener('click', () => {
      beginEdit();
      card.anims = card.anims.filter((x) => x !== a);
      endEdit(); rebuild(); changed();
    });
    const btnCurve = el('button', 'mini', 'Curve');
    btnCurve.title = 'Edit the easing curve';

    const acts = el('div', 'tc-anim-acts');
    acts.appendChild(btnCurve); acts.appendChild(btnOff); acts.appendChild(btnDel);
    head.appendChild(acts);
    box.appendChild(head);

    const body = el('div', 'tc-anim-body');
    // Defaults for this layer type, so every row's reset button knows what to go back to.
    const d = TextModel.defaultAnim(a.type, a.mode);
    body.appendChild(control({
      path: 'mode', label: 'Direction', type: 'select',
      options: [{ value: 'in', label: 'In (appear)' }, { value: 'out', label: 'Out (disappear)' }],
    }, a, d));
    body.appendChild(control({
      path: 'anchor', label: 'Anchor', type: 'select',
      options: [{ value: 'start', label: 'Clip start' }, { value: 'end', label: 'Clip end' }],
    }, a, d));
    body.appendChild(control({ path: 'start', label: 'Offset', type: 'range', min: 0, max: Math.max(2, clipDur), step: 0.02, unit: 's', digits: 2 }, a, d));
    body.appendChild(control({ path: 'duration', label: 'Length', type: 'range', min: 0.05, max: Math.max(2, clipDur), step: 0.02, unit: 's', digits: 2 }, a, d));

    if (a.type === 'slide') {
      body.appendChild(control({ path: 'params.from', label: 'From', type: 'select', options: SLIDE_DIRS }, a, d));
      body.appendChild(control({ path: 'params.distance', label: 'Distance', type: 'range', min: 0.02, max: 1.5, step: 0.01, digits: 2 }, a, d));
    } else if (a.type === 'zoom') {
      body.appendChild(control({ path: 'params.amount', label: 'Amount', type: 'range', min: -1.5, max: 1.5, step: 0.01, digits: 2 }, a, d));
      body.appendChild(el('div', 'tc-hint', 'Positive grows into place (zoom in), negative shrinks into place (zoom out).'));
    } else if (a.type === 'typewriter') {
      body.appendChild(control({
        path: 'params.unit', label: 'Reveal by', type: 'select',
        options: [{ value: 'char', label: 'Letter' }, { value: 'word', label: 'Word' }],
      }, a, d));
      body.appendChild(control({
        path: 'params.effect', label: 'Each one', type: 'select',
        options: [
          { value: 'none', label: 'Just appears' },
          { value: 'fade', label: 'Fades in' },
          { value: 'up', label: 'Slides up' },
          { value: 'down', label: 'Slides down' },
          { value: 'left', label: 'Slides left' },
          { value: 'right', label: 'Slides right' },
          { value: 'pop', label: 'Pops / scales up' },
        ],
      }, a, d));
      body.appendChild(control({
        path: 'params.order', label: 'Sweep', type: 'select',
        options: [
          { value: 'forward', label: 'First unit first' },
          { value: 'backward', label: 'Last unit first' },
        ],
      }, a, d));
      if ((a.params.effect || 'none') === 'pop') {
        body.appendChild(control({ path: 'params.scaleFrom', label: 'Pop from', type: 'range', min: 0.05, max: 3, step: 0.05, digits: 2 }, a, d));
        body.appendChild(el('div', 'tc-hint',
          a.mode === 'out'
            ? 'Below 1 shrinks each unit away as it vanishes; above 1 balloons it out.'
            : 'Below 1 grows each unit into place; above 1 drops it in from oversized.'));
      }
      if ((a.params.effect || 'none') !== 'none' && (a.params.effect || 'none') !== 'pop') {
        body.appendChild(control({ path: 'params.distance', label: 'Travel', type: 'range', min: 0, max: 3, step: 0.05, digits: 2 }, a, d));
      }
      if ((a.params.effect || 'none') !== 'none') {
        body.appendChild(control({ path: 'params.overlap', label: 'Overlap', type: 'range', min: 0.1, max: 12, step: 0.1, digits: 1 }, a, d));
        body.appendChild(el('div', 'tc-hint',
          (a.mode === 'out'
            ? 'On an out layer the direction is where each unit LEAVES towards, and "first unit first" makes it vanish left to right. '
            : 'On an in layer the direction is where each unit ARRIVES from. ') +
          'Overlap is how many units are mid-animation at once - 1 is strictly one at a time, ' +
          'higher gives a softer cascade. The curve below shapes each unit, and motion blur applies to them too.'));
      }
    } else if (a.type === 'flicker') {
      body.appendChild(control({ path: 'params.hz', label: 'Rate', type: 'range', min: 1, max: 30, step: 0.5, unit: 'Hz', digits: 1 }, a, d));
      body.appendChild(control({ path: 'params.duty', label: 'On time', type: 'range', min: 0.05, max: 0.95, step: 0.01, digits: 2 }, a, d));
      body.appendChild(control({ path: 'params.min', label: 'Dim to', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 }, a, d));
    }

    body.appendChild(control({ path: 'motionBlur.on', label: 'Motion blur', type: 'check' }, a, d));
    body.appendChild(control({ path: 'motionBlur.strength', label: 'MB strength', type: 'range', min: 0, max: 2, step: 0.05, digits: 2 }, a, d));
    body.appendChild(control({ path: 'motionBlur.samples', label: 'MB samples', type: 'range', min: 2, max: 32, step: 1 }, a, d));

    const curveBox = el('div', 'tc-curve-host');
    curveBox.hidden = true;
    btnCurve.addEventListener('click', () => {
      if (curveBox.hidden) {
        curveBox.innerHTML = '';
        curveBox.appendChild(curveEditor(a));
      }
      curveBox.hidden = !curveBox.hidden;
      btnCurve.classList.toggle('on', !curveBox.hidden);
    });
    body.appendChild(curveBox);

    box.appendChild(body);
    return box;
  }

  // ---------------------------------------------------------- keyframe UI

  function keyframeTrack(card, prop, clipDur) {
    const row = el('div', 'tc-kf');
    const keys = card.keys[prop] || (card.keys[prop] = []);
    const head = el('div', 'tc-kf-head', '<b>' + prop + '</b>');

    const add = el('button', 'mini', '+ key');
    add.title = 'Add a keyframe at the playhead';
    add.addEventListener('click', () => {
      const t = Math.max(0, Math.min(clipDur, host.getLocalTime()));
      beginEdit();
      const base = (prop === 'opacity' || prop === 'scale' || prop === 'glow') ? 1 : 0;
      const existing = TextModel.evalTrack(keys, t);
      keys.push({ t, v: existing == null ? base : existing, ease: TextModel.cloneEasing(TextModel.EASING_PRESETS.easeInOut) });
      keys.sort((a, b) => a.t - b.t);
      endEdit(); rebuild(); changed();
    });
    const clear = el('button', 'mini', 'Clear');
    clear.addEventListener('click', () => {
      if (!keys.length) return;
      beginEdit(); card.keys[prop] = []; endEdit(); rebuild(); changed();
    });
    const acts = el('div', 'tc-kf-acts');
    acts.appendChild(add); acts.appendChild(clear);
    head.appendChild(acts);
    row.appendChild(head);

    if (!keys.length) {
      row.appendChild(el('div', 'tc-hint', 'No keys - this property follows the animation layers.'));
      return row;
    }

    const range = prop === 'opacity' ? [0, 1, 0.01]
      : prop === 'scale' ? [0.05, 4, 0.01]
        : prop === 'glow' ? [0, 3, 0.01]
          : prop === 'rotate' ? [-180, 180, 1]
            : [-1, 1, 0.005];

    keys.sort((a, b) => a.t - b.t);
    keys.forEach((k, i) => {
      const kr = el('div', 'tc-key');
      const t = el('input', 'tc-key-t');
      t.type = 'number'; t.step = '0.02'; t.min = '0'; t.max = String(clipDur); t.value = k.t.toFixed(2);
      t.title = 'Time within the clip';
      t.addEventListener('focus', beginEdit);
      t.addEventListener('blur', endEdit);
      t.addEventListener('keydown', (e) => e.stopPropagation());
      t.addEventListener('input', () => { k.t = parseFloat(t.value) || 0; changed(); });

      const v = el('input', 'tc-key-v');
      v.type = 'range'; v.min = range[0]; v.max = range[1]; v.step = range[2]; v.value = k.v;
      const vo = el('input', 'tc-num');
      vo.type = 'number'; vo.step = String(range[2]); vo.value = Number(k.v).toFixed(3);
      vo.title = 'Type an exact value';
      v.addEventListener('pointerdown', beginEdit);
      v.addEventListener('input', () => { k.v = parseFloat(v.value); vo.value = k.v.toFixed(3); changed(); });
      const kWheel = {
        step: range[2], min: range[0], max: range[1],
        get: () => k.v,
        set: (nv) => { k.v = nv; v.value = nv; vo.value = Number(nv).toFixed(3); changed(); },
      };
      attachWheel(v, kWheel);
      attachWheel(vo, kWheel);
      attachWheel(t, {
        step: 0.02, min: 0, max: clipDur,
        get: () => k.t,
        set: (nt) => { k.t = nt; t.value = nt.toFixed(2); changed(); },
      });
      vo.addEventListener('focus', beginEdit);
      vo.addEventListener('blur', endEdit);
      vo.addEventListener('keydown', (e) => e.stopPropagation());
      vo.addEventListener('input', () => {
        const n = parseFloat(vo.value);
        if (!isFinite(n)) return;
        k.v = n; v.value = Math.max(range[0], Math.min(range[1], n)); changed();
      });

      const goto = el('button', 'mini', '▶');
      goto.title = 'Move the playhead to this key';
      goto.addEventListener('click', () => host.seekLocal(k.t));

      const del = el('button', 'mini', '×');
      del.title = 'Delete this key';
      del.addEventListener('click', () => {
        beginEdit(); keys.splice(i, 1); endEdit(); rebuild(); changed();
      });

      kr.appendChild(t); kr.appendChild(v); kr.appendChild(vo);
      kr.appendChild(goto); kr.appendChild(del);
      row.appendChild(kr);
    });
    return row;
  }

  // -------------------------------------------------------------- presets

  function presetBar(card) {
    const wrap = el('div', 'tc-presets');
    const kinds = [
      { kind: 'style', label: 'Style' },
      { kind: 'anim', label: 'Animation' },
      { kind: 'full', label: 'Full card' },
    ];

    for (const k of kinds) {
      const box = el('div', 'tc-preset-box');
      const names = (host.presets && host.presets[k.kind]) || [];

      const head = el('div', 'tc-preset-head');
      head.appendChild(el('b', null, k.label));
      head.appendChild(el('span', 'tc-hint', names.length + ' saved'));
      box.appendChild(head);

      // Pick and apply.
      const sel = el('select', 'tc-preset-sel');
      const o0 = el('option');
      o0.value = '';
      o0.textContent = names.length ? 'Choose a saved preset...' : 'Nothing saved yet';
      sel.appendChild(o0);
      for (const name of names) {
        const o = el('option'); o.value = name; o.textContent = name; sel.appendChild(o);
      }
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        const data = await host.loadLibraryPreset(k.kind, sel.value);
        if (!data) { host.log('Could not read preset "' + sel.value + '".'); return; }
        const keep = sel.value;
        beginEdit();
        TextModel.applyPreset(card, data, { keepText: k.kind !== 'full' });
        endEdit();
        rebuild(); changed();
        host.log('Applied ' + k.label.toLowerCase() + ' preset "' + keep + '".');
      });
      box.appendChild(sel);

      // Save under a typed name. NB: window.prompt() does not exist in Electron, which is
      // why this is an inline field rather than a dialog - do not "simplify" it back.
      const saveRow = el('div', 'tc-preset-save');
      const nameInput = el('input', 'tc-preset-input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Save as...';
      nameInput.value = '';
      const doSave = async () => {
        const name = nameInput.value.trim() || (k.label + ' ' + (names.length + 1));
        const data = TextModel.extractPreset(k.kind, card);
        data.name = name;
        nameInput.value = '';
        await host.saveLibraryPreset(k.kind, name, data);
      };
      nameInput.addEventListener('keydown', (e) => {
        e.stopPropagation();               // the app's shortcuts must not eat typing
        if (e.key === 'Enter') doSave();
      });
      const save = el('button', 'mini', 'Save');
      save.title = 'Save this ' + k.label.toLowerCase() + ' to your preset library';
      save.addEventListener('click', doSave);
      saveRow.appendChild(nameInput);
      saveRow.appendChild(save);
      box.appendChild(saveRow);

      const acts = el('div', 'tc-preset-acts');

      const del = el('button', 'mini', 'Delete');
      del.title = 'Delete the preset selected above';
      del.addEventListener('click', async () => {
        if (!sel.value) { host.log('Pick a saved preset above first.'); return; }
        await host.deleteLibraryPreset(k.kind, sel.value);
      });

      const exp = el('button', 'mini', 'Export');
      exp.title = 'Write this ' + k.label.toLowerCase() + ' to a .json file';
      exp.addEventListener('click', async () => {
        const data = TextModel.extractPreset(k.kind, card);
        data.name = nameInput.value.trim() || (k.label + ' preset');
        await host.exportPreset(k.kind, data);
      });

      const imp = el('button', 'mini', 'Import');
      imp.title = 'Load a preset from a .json file';
      imp.addEventListener('click', async () => {
        const data = await host.importPreset(k.kind);
        if (!data) return;
        beginEdit();
        TextModel.applyPreset(card, data, { keepText: k.kind !== 'full' });
        endEdit();
        rebuild(); changed();
      });

      acts.appendChild(del); acts.appendChild(exp); acts.appendChild(imp);
      box.appendChild(acts);
      wrap.appendChild(box);
    }

    wrap.appendChild(el('div', 'tc-hint',
      'Style presets carry look only, animation presets carry layers/curves/keys, full cards carry both plus the text.'));
    return wrap;
  }

  // --------------------------------------------------------------- sections

  function section(key, title, buildBody) {
    const d = el('details', 'tc-section');
    d.open = !!openSections[key];
    d.addEventListener('toggle', () => { openSections[key] = d.open; });
    const s = el('summary', null, title);
    d.appendChild(s);
    const body = el('div', 'tc-body');
    buildBody(body);
    d.appendChild(body);
    return d;
  }

  const STYLE_SCHEMA = {
    content: [
      { path: 'text', label: 'Text', type: 'area' },
      {
        path: 'style.align', label: 'Align', type: 'buttons',
        options: [{ value: 'left', label: 'L' }, { value: 'center', label: 'C' }, { value: 'right', label: 'R' }],
      },
      { path: 'style.x', label: 'Pos X', type: 'range', min: 0, max: 1, step: 0.005, digits: 3 },
      { path: 'style.y', label: 'Pos Y', type: 'range', min: 0, max: 1, step: 0.005, digits: 3 },
      { path: 'style.maxWidth', label: 'Wrap at', type: 'range', min: 0.1, max: 1, step: 0.01, digits: 2 },
      { path: 'style.rotate', label: 'Rotation', type: 'range', min: -180, max: 180, step: 1, unit: '°' },
      { path: 'style.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
    ],
    font: [
      { path: 'style.fontSize', label: 'Size', type: 'range', min: 10, max: 400, step: 1, unit: 'px' },
      { path: 'style.letterSpacing', label: 'Tracking', type: 'range', min: -40, max: 80, step: 0.5, unit: 'px', digits: 1 },
      { path: 'style.lineHeight', label: 'Line height', type: 'range', min: 0.6, max: 3, step: 0.01, digits: 2 },
    ],
    effects: [
      { path: 'style.stroke.on', label: 'Outline', type: 'check' },
      { path: 'style.stroke.color', label: 'Outline colour', type: 'color' },
      { path: 'style.stroke.width', label: 'Outline width', type: 'range', min: 0, max: 40, step: 0.5, unit: 'px', digits: 1 },
      { path: 'style.shadow.on', label: 'Shadow', type: 'check' },
      { path: 'style.shadow.color', label: 'Shadow colour', type: 'color' },
      { path: 'style.shadow.distance', label: 'Distance', type: 'range', min: 0, max: 120, step: 1, unit: 'px' },
      { path: 'style.shadow.angle', label: 'Angle', type: 'range', min: 0, max: 360, step: 1, unit: '°' },
      { path: 'style.shadow.blur', label: 'Blur radius', type: 'range', min: 0, max: 120, step: 1, unit: 'px' },
      { path: 'style.shadow.opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      { path: 'style.glow.on', label: 'Glow', type: 'check' },
      { path: 'style.glow.color', label: 'Glow colour', type: 'color' },
      { path: 'style.glow.intensity', label: 'Intensity', type: 'range', min: 1, max: 10, step: 1 },
      { path: 'style.glow.size', label: 'Size', type: 'range', min: 0, max: 150, step: 1, unit: 'px' },
      { path: 'style.glow.spread', label: 'Spread', type: 'range', min: 0, max: 2, step: 0.05, digits: 2 },
      { path: 'style.glow.over', label: 'Covers text', type: 'range', min: 0, max: 1.5, step: 0.01, digits: 2 },
      { path: 'style.blur.on', label: 'Blur', type: 'check' },
      { path: 'style.blur.amount', label: 'Blur strength', type: 'range', min: 0, max: 60, step: 0.5, unit: 'px', digits: 1 },
      { path: 'style.bg.on', label: 'Backing box', type: 'check' },
      { path: 'style.bg.color', label: 'Box colour', type: 'color' },
      { path: 'style.bg.opacity', label: 'Box opacity', type: 'range', min: 0, max: 1, step: 0.01, digits: 2 },
      { path: 'style.bg.padding', label: 'Box padding', type: 'range', min: 0, max: 150, step: 1, unit: 'px' },
      { path: 'style.bg.radius', label: 'Box radius', type: 'range', min: 0, max: 120, step: 1, unit: 'px' },
    ],
  };

  // ----------------------------------------------------------------- build

  function rebuild() {
    const container = host.container;
    // Rebuilds happen on every structural edit; without this the panel jumps to the top.
    const scroller = container.closest('#inspectorCol') || container.parentElement;
    const scrollTop = scroller ? scroller.scrollTop : 0;
    container.innerHTML = '';
    const clip = host.getClip();
    if (!clip) { container.hidden = true; return; }
    container.hidden = false;
    const card = clip.card;
    const clipDur = Math.max(0.05, clip.out - clip.in);
    // A pristine card supplies every reset button's target value.
    const D = TextModel.defaultCard();

    container.appendChild(section('content', 'Content & placement', (b) => {
      for (const s of STYLE_SCHEMA.content) b.appendChild(control(s, card, D));
    }));

    container.appendChild(section('font', 'Font', (b) => {
      // Font family gets a filter box because there can be hundreds installed.
      const row = el('div', 'tc-row');
      row.appendChild(el('label', 'tc-label', 'Family'));
      const sel = el('select');
      const fill = (filter) => {
        sel.innerHTML = '';
        const list = fonts.filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()));
        if (!list.includes(card.style.fontFamily)) list.unshift(card.style.fontFamily);
        for (const f of list.slice(0, 800)) {
          const o = el('option'); o.value = f; o.textContent = f;
          o.style.fontFamily = '"' + f + '"';
          sel.appendChild(o);
        }
        sel.value = card.style.fontFamily;
      };
      fill('');
      sel.addEventListener('change', () => {
        beginEdit(); card.style.fontFamily = sel.value; endEdit(); changed();
      });
      row.appendChild(sel);
      b.appendChild(row);

      const frow = el('div', 'tc-row');
      frow.appendChild(el('label', 'tc-label', 'Filter'));
      const filt = el('input');
      filt.type = 'text';
      filt.placeholder = 'type to narrow the list';
      filt.addEventListener('keydown', (e) => e.stopPropagation());
      filt.addEventListener('input', () => fill(filt.value));
      frow.appendChild(filt);
      b.appendChild(frow);

      b.appendChild(toggleBar(card));
      for (const s of STYLE_SCHEMA.font) b.appendChild(control(s, card, D));
    }));

    container.appendChild(section('fill', 'Colour', (b) => {
      b.appendChild(control({
        path: 'style.fill.type', label: 'Fill', type: 'select',
        options: [{ value: 'solid', label: 'Solid colour' }, { value: 'gradient', label: 'Gradient' }],
      }, card, D));
      if (card.style.fill.type === 'solid') {
        b.appendChild(control({ path: 'style.fill.color', label: 'Colour', type: 'color' }, card, D));
      } else {
        b.appendChild(gradientEditor(card));
      }
    }));

    container.appendChild(section('effects', 'Outline, shadow, glow & blur', (b) => {
      for (const s of STYLE_SCHEMA.effects) b.appendChild(control(s, card, D));
    }));

    container.appendChild(section('anim', 'Animation', (b) => {
      const top = el('div', 'tc-row tc-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = card.animEnabled;
      cb.addEventListener('change', () => {
        beginEdit(); card.animEnabled = cb.checked; endEdit(); changed();
      });
      top.appendChild(cb);
      top.appendChild(el('label', 'tc-label', 'Animation enabled (A)'));
      b.appendChild(top);

      const addRow = el('div', 'tc-row');
      addRow.appendChild(el('label', 'tc-label', 'Add layer'));
      const addSel = el('select');
      const o0 = el('option'); o0.value = ''; o0.textContent = 'Choose an effect...';
      addSel.appendChild(o0);
      for (const [type, def] of Object.entries(TextModel.ANIM_TYPES)) {
        for (const mode of ['in', 'out']) {
          const o = el('option');
          o.value = type + ':' + mode;
          o.textContent = def.label + ' ' + mode;
          addSel.appendChild(o);
        }
      }
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        const [type, mode] = addSel.value.split(':');
        beginEdit();
        card.anims.push(TextModel.defaultAnim(type, mode));
        endEdit();
        addSel.value = '';
        rebuild(); changed();
      });
      addRow.appendChild(addSel);
      b.appendChild(addRow);

      if (!card.anims.length) b.appendChild(el('div', 'tc-hint', 'No animation layers. Add one above.'));
      for (const a of card.anims) b.appendChild(animEntry(card, a, clipDur));
    }));

    container.appendChild(section('keys', 'Keyframes', (b) => {
      b.appendChild(el('div', 'tc-hint',
        'Keyframes ride on top of the animation layers: opacity and scale multiply, position and rotation add.'));
      for (const p of TextModel.KEYABLE) b.appendChild(keyframeTrack(card, p, clipDur));
    }));

    container.appendChild(section('presets', 'Presets', (b) => {
      b.appendChild(presetBar(card));
    }));

    if (scroller) scroller.scrollTop = scrollTop;
  }

  // ------------------------------------------------------------------- api

  async function init(hooks) {
    // Set these up front: the panel can be asked to render before the async loads finish
    // (adding a card immediately on startup does exactly that).
    host = hooks;
    host.presets = { style: [], anim: [], full: [] };
    fonts = ['Segoe UI', 'Arial'];
    fonts = await hooks.getFonts();
    host.presets = await hooks.listPresets();
  }

  function refresh() { if (host) rebuild(); }
  async function reloadPresets() {
    host.presets = await host.listPresets();
    rebuild();
  }

  return {
    init, refresh, reloadPresets, attachWheel,
    // Shared so the transition inspector gets the same typable + scrollable + resettable
    // rows without duplicating any of it.
    control, section, el, curveEditor,
    get fonts() { return fonts; },
  };
})();
