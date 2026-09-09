'use strict';
/**
 * The QuickBin - a media library that outlives the project.
 *
 * It lives in userData (`quickbin.json`), not in the .scut file, so the clips, music and
 * stills a user works with are in front of them in every project they open. Nothing is
 * copied: an entry is a path plus the probe result. That keeps the bin tiny and leaves
 * the media where the user put it, at the cost of an entry going stale if the file is
 * moved - which `bin:read` reports as `missing` so the row can be greyed out instead of
 * failing when someone drops it on the timeline.
 *
 * Folders are the bin's own, not the disk's. Importing a folder mirrors its shape once;
 * renaming or deleting a bin folder afterwards never touches anything on disk.
 *
 * Like `TextUI`, this file is a plain `<script>` global and touches no `app.js` global -
 * everything it needs comes through the hooks object passed to `init()`.
 */
const QuickBin = (() => {

  /** { version, folders: [{id,name,parent}], items: [{id,folder,path,name,kind,...}] } */
  let bin = { version: 1, folders: [], items: [] };
  let hooks = {};
  let host = null;
  const open = new Set();          // ids of expanded folders
  const selection = new Set();     // ids of selected rows (items and folders)
  let renaming = null;             // id of the folder being renamed
  let saveTimer = null;
  let ready = false;

  const uid = (p) => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const byId = (list, id) => list.find((x) => x.id === id) || null;
  const folderOf = (id) => byId(bin.folders, id);
  const itemOf = (id) => byId(bin.items, id);

  // ------------------------------------------------------------------ storage

  async function init(h) {
    hooks = h || {};
    host = document.querySelector('#quickBin');
    try {
      const data = await window.api.binRead();
      if (data) bin = data;
    } catch (e) { /* first run, or an unreadable bin - start empty */ }
    if (!Array.isArray(bin.folders)) bin.folders = [];
    if (!Array.isArray(bin.items)) bin.items = [];
    ready = true;
    render();
  }

  /** Debounced: a burst of edits (importing a folder tree) writes the file once. */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { window.api.binWrite(bin); }, 200);
  }

  /** Write immediately - for the smoke suites, which do not wait around. */
  function flush() { clearTimeout(saveTimer); return window.api.binWrite(bin); }

  // -------------------------------------------------------------- bin edits

  function addFolder(name, parent) {
    const f = { id: uid('f'), name: name || 'New folder', parent: parent || null };
    bin.folders.push(f);
    // Expand it, and the folder it went into: a new folder the user cannot see the
    // inside of looks like nothing happened when media is imported straight into it.
    open.add(f.id);
    if (f.parent) open.add(f.parent);
    save();
    return f;
  }

  /** Add scanned media, skipping anything already in that folder. */
  function addItems(metas, folder) {
    const added = [];
    for (const m of metas || []) {
      if (!m || !m.path) continue;
      if (bin.items.some((i) => i.path === m.path && (i.folder || null) === (folder || null))) continue;
      const it = {
        id: uid('i'), folder: folder || null, path: m.path, name: m.name,
        kind: m.kind, duration: m.duration || 0,
        width: m.width || 0, height: m.height || 0, fps: m.fps || 0,
        hasAudio: !!m.hasAudio, added: Date.now(),
      };
      bin.items.push(it);
      added.push(it);
    }
    if (added.length) save();
    return added;
  }

  /** Every folder inside `id`, including itself. */
  function subtree(id) {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of bin.folders) {
        if (f.parent && ids.has(f.parent) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
      }
    }
    return ids;
  }

  /** Delete folders (with everything inside them) and items. Files on disk are untouched. */
  function remove(ids) {
    const folders = new Set();
    for (const id of ids) if (folderOf(id)) for (const f of subtree(id)) folders.add(f);
    bin.folders = bin.folders.filter((f) => !folders.has(f.id));
    bin.items = bin.items.filter((i) => !ids.has(i.id) && !folders.has(i.folder));
    for (const id of ids) selection.delete(id);
    save();
  }

  function move(ids, folder) {
    for (const id of ids) {
      const it = itemOf(id);
      if (it) { it.folder = folder || null; continue; }
      const f = folderOf(id);
      // A folder cannot be dropped inside itself, or the tree stops being a tree.
      if (f && !(folder && subtree(f.id).has(folder))) f.parent = folder || null;
    }
    if (folder) open.add(folder);
    save();
  }

  // ------------------------------------------------------------------ import

  /**
   * Import paths into `folder`. Folders on disk become bin folders of the same name, one
   * level at a time, so the shape the user sees in Explorer survives the import.
   */
  async function importPaths(paths, folder, depth) {
    if (!paths || !paths.length) return 0;
    const files = [];
    const dirs = [];
    for (const p of paths) {
      const listed = await window.api.binListDir(p);
      if (listed && listed.isDir) dirs.push({ path: p, listed });
      else files.push(p);
    }
    let n = 0;
    if (files.length) {
      const metas = await window.api.binScan(files);
      n += addItems(metas, folder).length;
    }
    for (const d of dirs) {
      const name = d.path.split(/[\\/]/).filter(Boolean).pop() || 'Folder';
      const f = addFolder(name, folder || null);
      if (d.listed.files.length) {
        const metas = await window.api.binScan(d.listed.files);
        n += addItems(metas, f.id).length;
      }
      if ((depth || 0) < 5 && d.listed.dirs.length) {
        n += await importPaths(d.listed.dirs.map((x) => x.path), f.id, (depth || 0) + 1);
      }
    }
    render();
    return n;
  }

  /** Where a new item or folder should land: the selected folder, else the root. */
  function targetFolder() {
    for (const id of selection) if (folderOf(id)) return id;
    for (const id of selection) { const it = itemOf(id); if (it) return it.folder || null; }
    return null;
  }

  // ------------------------------------------------------------------ the UI

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const fmtDur = (s) => {
    if (!(s > 0)) return '';
    const m = Math.floor(s / 60);
    return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  };

  const KIND_ICON = { video: '▶', audio: '♪', image: '▣' };

  function render() {
    if (!host) return;
    host.innerHTML = '';
    const tree = el('div', 'qb-tree');
    renderLevel(tree, null, 0);
    if (!bin.folders.length && !bin.items.length) {
      tree.appendChild(el('div', 'qb-empty',
        'Empty. Add files or a folder, or drop them here - the bin is kept for every project.'));
    }
    host.appendChild(tree);
    const count = bin.items.length;
    const meta = document.querySelector('#binMeta');
    if (meta) meta.textContent = count ? count + ' item' + (count === 1 ? '' : 's') : '';
    // Dropping onto empty space in the panel puts things at the root.
    dropTarget(host, null);
  }

  function renderLevel(parentEl, folderId, depth) {
    for (const f of bin.folders.filter((x) => (x.parent || null) === folderId)) {
      parentEl.appendChild(folderRow(f, depth));
      if (open.has(f.id)) renderLevel(parentEl, f.id, depth + 1);
    }
    for (const it of bin.items.filter((x) => (x.folder || null) === folderId)) {
      parentEl.appendChild(itemRow(it, depth));
    }
  }

  function folderRow(f, depth) {
    const row = el('div', 'qb-row qb-folder' + (selection.has(f.id) ? ' sel' : ''));
    row.style.paddingLeft = (4 + depth * 12) + 'px';
    row.dataset.id = f.id;
    const twisty = el('span', 'qb-twisty', open.has(f.id) ? '▾' : '▸');
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open.has(f.id)) open.delete(f.id); else open.add(f.id);
      render();
    });
    row.appendChild(twisty);
    row.appendChild(el('span', 'qb-icon', '\u{1F4C1}'));

    if (renaming === f.id) {
      const input = el('input', 'qb-rename');
      input.value = f.name;
      // Typing here must not reach the editor's single-key shortcuts.
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { renaming = null; render(); }
      });
      input.addEventListener('blur', () => {
        f.name = input.value.trim() || f.name;
        renaming = null;
        save();
        render();
      });
      row.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      const name = el('span', 'qb-name', f.name);
      name.addEventListener('dblclick', (e) => { e.stopPropagation(); renaming = f.id; render(); });
      row.appendChild(name);
    }

    rowCommon(row, f.id);
    dropTarget(row, f.id);
    return row;
  }

  function itemRow(it, depth) {
    const row = el('div', 'qb-row qb-item' + (selection.has(it.id) ? ' sel' : '') +
      (it.missing ? ' missing' : '') + ' k-' + it.kind);
    row.style.paddingLeft = (16 + depth * 12) + 'px';
    row.dataset.id = it.id;
    row.title = (it.missing ? 'MISSING - ' : '') + it.path;
    row.appendChild(el('span', 'qb-icon', KIND_ICON[it.kind] || '●'));
    row.appendChild(el('span', 'qb-name', it.name));
    row.appendChild(el('span', 'qb-dur', fmtDur(it.duration)));
    row.addEventListener('dblclick', () => use([it.id]));
    rowCommon(row, it.id);
    return row;
  }

  function rowCommon(row, id) {
    row.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('qb-twisty') || e.target.tagName === 'INPUT') return;
      if (e.ctrlKey || e.shiftKey) {
        if (selection.has(id)) selection.delete(id); else selection.add(id);
      } else {
        selection.clear();
        selection.add(id);
      }
      render();
    });
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (!selection.has(id)) { selection.clear(); selection.add(id); render(); }
      e.dataTransfer.setData('application/x-shortcut-bin', JSON.stringify([...selection]));
      e.dataTransfer.effectAllowed = 'move';
    });
  }

  /** Let rows and the panel accept both bin rows (a move) and files from Explorer. */
  function dropTarget(node, folderId) {
    node.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.add('qb-over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('qb-over'));
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('qb-over');
      const moved = e.dataTransfer.getData('application/x-shortcut-bin');
      if (moved) {
        try { move(new Set(JSON.parse(moved)), folderId); } catch (err) { /* ignore */ }
        render();
        return;
      }
      const paths = [];
      for (const file of e.dataTransfer.files) {
        const p = window.api.pathForFile(file);
        if (p) paths.push(p);
      }
      if (!paths.length) return;
      const n = await importPaths(paths, folderId);
      if (hooks.log) hooks.log('QuickBin: added ' + n + ' item(s).');
    });
  }

  // ------------------------------------------------------- using what is in it

  /**
   * Put the selected entries to work.
   *
   * Everything goes onto the timeline at the playhead now that stills are timeline media
   * too - except when an object transition is selected, which still wants a PNG handed
   * to it. `useImage` owns that choice; the bin only says which entries are stills.
   */
  async function use(ids) {
    const items = [...(ids || selection)].map(itemOf).filter(Boolean);
    if (!items.length) return;
    const media = items.filter((i) => i.kind !== 'image' && !i.missing);
    const images = items.filter((i) => i.kind === 'image' && !i.missing);
    const gone = items.filter((i) => i.missing);
    if (gone.length && hooks.log) {
      hooks.log('QuickBin: ' + gone.length + ' entry(ies) point at files that are no longer there.');
    }
    if (media.length && hooks.insert) await hooks.insert(media.map((i) => i.path));
    if (images.length && hooks.useImage) await hooks.useImage(images.map((i) => i.path));
  }

  /** Fold a folder's contents into the same call, so "add" on a folder adds its media. */
  function itemsIn(folderId) {
    const ids = subtree(folderId);
    return bin.items.filter((i) => ids.has(i.folder));
  }

  function useSelection() {
    const ids = new Set();
    for (const id of selection) {
      if (folderOf(id)) for (const it of itemsIn(id)) ids.add(it.id);
      else ids.add(id);
    }
    return use(ids);
  }

  function removeSelection() {
    if (!selection.size) return;
    const n = selection.size;
    remove(new Set(selection));
    selection.clear();
    render();
    if (hooks.log) hooks.log('QuickBin: removed ' + n + ' entry(ies). Nothing was deleted from disk.');
  }

  return {
    init, render, save, flush,
    addFolder, addItems, importPaths, remove, move, use, useSelection, removeSelection,
    targetFolder, itemsIn,
    get data() { return bin; },
    get selection() { return selection; },
    get ready() { return ready; },
  };
})();
