/* Inspector tabs: the right column shows ONE group of panels at a time, picked from a tab
   strip at its top, instead of one long stack to scroll through.

   Purely a view layer over the existing panels. Nothing here owns state or changes which
   panels app.js thinks are open: a group is hidden with a class, never the `hidden`
   attribute app.js toggles. And whenever app.js opens a panel itself (a shortcut, selecting
   a text card or a transition, a smoke suite clicking a collapse button), the strip follows
   it to that panel's tab, so nothing can open out of sight. */
(function () {
  const col = document.getElementById('inspectorCol');
  if (!col) return;

  const TABS = [
    { id: 'clip',     label: 'Clip',     heads: ['#framingHead', '#clipHead', '#transPanelHead', '#textPanelHead'] },
    { id: 'media',    label: 'Media',    heads: ['#binHead'], open: ['#btnBinCollapse', '#quickBin'] },
    { id: 'captions', label: 'Captions', heads: ['#capPanelHead'], open: ['#btnCapCollapse', '#capPanel'] },
    { id: 'sound',    label: 'Sound',    heads: ['#sfxPanelHead'], open: ['#btnSfxCollapse', '#sfxPanel'] },
    { id: 'finish',   label: 'Finish',   heads: ['#masterPanelHead'], open: ['#btnMasterCollapse', '#masterPanel'] },
    { id: 'deliver',  label: 'Deliver',  heads: ['#delPanelHead'], open: ['#btnDelCollapse', '#delPanel'] },
  ];

  // Tag every child of the column with its tab: a head claims itself and every following
  // sibling up to the next panel head.
  const headTab = new Map();
  for (const t of TABS) for (const sel of t.heads) {
    const el = col.querySelector(sel);
    if (el) headTab.set(el, t.id);
  }
  let cur = null;
  for (const el of Array.from(col.children)) {
    if (el.id === 'inspectorResize') continue;
    if (el.classList.contains('panel-head')) cur = headTab.get(el) || cur;
    if (cur) el.dataset.itab = cur;
  }

  const strip = document.createElement('nav');
  strip.id = 'inspectorTabs';
  for (const t of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tab = t.id;
    b.textContent = t.label;
    b.addEventListener('click', () => show(t.id, true));
    strip.appendChild(b);
  }
  col.insertBefore(strip, col.querySelector('#inspectorResize').nextSibling);

  function show(id, fromUser) {
    col.dataset.tab = id;
    for (const b of strip.children) b.classList.toggle('on', b.dataset.tab === id);
    const t = TABS.find(x => x.id === id);
    // A collapsible panel's tab exists to show that panel, so opening the tab opens it.
    if (fromUser && t.open) {
      const [btn, body] = t.open.map(s => document.querySelector(s));
      if (btn && body && body.hidden) btn.click();
    }
    col.scrollTop = 0;
    try { localStorage.setItem('scut.inspectorTab', id); } catch (e) {}
  }

  let saved = 'clip';
  try { saved = localStorage.getItem('scut.inspectorTab') || 'clip'; } catch (e) {}
  show(TABS.some(t => t.id === saved) ? saved : 'clip', false);

  // Follow app.js: when a panel (or a head) in another tab is un-hidden, go to that tab.
  const mo = new MutationObserver(recs => {
    for (const r of recs) {
      const el = r.target;
      if (el.parentElement !== col || el.hidden || !el.dataset.itab) continue;
      if (el.dataset.itab !== col.dataset.tab) show(el.dataset.itab, false);
    }
  });
  setTimeout(() => {
    for (const el of col.children) mo.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }, 500);

  // The toggles are global function declarations, so app.js's own calls go through these
  // wrappers too. Switching BEFORE the panel opens keeps it measurable the moment it is
  // shown - the observer above only catches up after the current task.
  for (const [fn, tab] of [['toggleBin', 'media'], ['toggleCaptions', 'captions'], ['toggleSfx', 'sound'],
                           ['toggleMaster', 'finish'], ['toggleDelivery', 'deliver']]) {
    const orig = window[fn];
    if (typeof orig !== 'function') continue;
    window[fn] = function (show) {
      const r = orig.apply(this, arguments);
      const body = document.querySelector(TABS.find(t => t.id === tab).open[1]);
      if (body && !body.hidden && col.dataset.tab !== tab) show_(tab);
      return r;
    };
  }
  function show_(id) { show(id, false); }

  window.InspectorTabs = { show: id => show(id, true), tabs: TABS.map(t => t.id) };
})();
