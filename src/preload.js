'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Electron hides File.path since v32 - webUtils is the supported way to get it.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return file.path || ''; }
  },
  scanMedia: (paths) => ipcRenderer.invoke('media:scan', paths),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  pickFolder: () => ipcRenderer.invoke('media:pickFolder'),
  pickImage: () => ipcRenderer.invoke('media:pickImage'),

  // QuickBin: a media library kept in userData, so it is there in every project.
  binRead: () => ipcRenderer.invoke('bin:read'),
  binWrite: (data) => ipcRenderer.invoke('bin:write', data),
  binScan: (paths) => ipcRenderer.invoke('bin:scan', paths),
  binPick: () => ipcRenderer.invoke('bin:pick'),
  binPickFolder: () => ipcRenderer.invoke('bin:pickFolder'),
  binListDir: (dir) => ipcRenderer.invoke('bin:listDir', dir),

  // Audio peaks for the timeline waveforms, cached on disk by path + size + mtime.
  waveRead: (p) => ipcRenderer.invoke('wave:read', p),
  waveWrite: (p, peaks, duration) => ipcRenderer.invoke('wave:write', { path: p, peaks, duration }),

  // Silence spans for Tighten, cached in main by path + size + mtime + noise floor.
  analyzeSilence: (p, noise) => ipcRenderer.invoke('analyze:silence', { path: p, noise }),

  // Speech to text with word-level timings (whisper.cpp), cached in main by
  // path + size + mtime + model. Everything degrades to `{ ok:false, reason, error }`.
  transcribeRun: (opts) => ipcRenderer.invoke('transcribe:run', opts),
  transcribeState: () => ipcRenderer.invoke('transcribe:state'),
  transcribeCancel: () => ipcRenderer.invoke('transcribe:cancel'),
  transcribeImport: () => ipcRenderer.invoke('transcribe:import'),
  onTranscribeProgress: (cb) => ipcRenderer.on('transcribe:progress', (_e, d) => cb(d)),

  // The screen recorder. `screen:start` answers once capture is actually running, so a
  // resolved promise means the encoder has frames - not merely that a window opened.
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  screenStart: (opts) => ipcRenderer.invoke('screen:start', opts),
  screenStop: () => ipcRenderer.invoke('screen:stop'),
  screenState: () => ipcRenderer.invoke('screen:state'),
  onScreenHotkeyToggle: (cb) => ipcRenderer.on('screen:hotkeyToggle', () => cb()),
  onScreenFailed: (cb) => ipcRenderer.on('screen:failed', (_e, m) => cb(m)),

  saveProject: (data, filePath) => ipcRenderer.invoke('project:save', { data, filePath }),
  openProject: (filePath) => ipcRenderer.invoke('project:open', filePath),
  onOpenOnLaunch: (cb) => ipcRenderer.on('project:openOnLaunch', (_e, p) => cb(p)),

  pickOutput: (name) => ipcRenderer.invoke('render:pickOutput', name),
  startRender: (job) => ipcRenderer.invoke('render:start', job),
  cancelRender: () => ipcRenderer.invoke('render:cancel'),
  onRenderProgress: (cb) => ipcRenderer.on('render:progress', (_e, d) => cb(d)),

  listFonts: () => ipcRenderer.invoke('fonts:list'),

  listPresets: () => ipcRenderer.invoke('preset:list'),
  savePreset: (kind, name, data) => ipcRenderer.invoke('preset:save', { kind, name, data }),
  loadPreset: (kind, name) => ipcRenderer.invoke('preset:load', { kind, name }),
  deletePreset: (kind, name) => ipcRenderer.invoke('preset:delete', { kind, name }),
  exportPreset: (kind, data) => ipcRenderer.invoke('preset:export', { kind, data }),
  importPreset: (kind) => ipcRenderer.invoke('preset:import', kind),

  // Baked text frames are cached on disk by content hash; `cached: true` means the
  // frames are already there and nothing needs redrawing.
  textSeq: () => ipcRenderer.invoke('text:seq'),
  textSeqDone: (dir, frames) => ipcRenderer.invoke('text:seqDone', { dir, frames }),
  writeTextFrames: (dir, data) => ipcRenderer.invoke('text:writeFrames', { dir, data }),
  endTextSeq: (dir) => ipcRenderer.invoke('text:endSeq', dir),
  textCacheInfo: () => ipcRenderer.invoke('text:cacheInfo'),
  renderCacheIndex: () => ipcRenderer.invoke('render:cacheIndex'),
  textCacheClear: () => ipcRenderer.invoke('text:cacheClear'),

  setDirty: (dirty) => ipcRenderer.invoke('app:setDirty', dirty),
  onRequestSave: (cb) => ipcRenderer.on('app:requestSave', () => cb()),
  saveResult: (saved) => ipcRenderer.invoke('app:saveResult', saved),

  sendInput: (ev) => ipcRenderer.invoke('debug:input', ev),   // test-only, see main.js
  // Is this a smoke run? The renderer needs to know because a blocking `confirm()` has
  // nobody to answer it - see `confirmDiscard()` in app.js.
  smoke: !!process.env.SHORTCUT_SMOKE,
  buildArgs: (job, opts) => ipcRenderer.invoke('debug:buildArgs', { job, opts }), // test-only
  ffmpegRun: (args) => ipcRenderer.invoke('debug:ffmpegRun', { args }),               // test-only
  fileExists: (file) => ipcRenderer.invoke('debug:exists', { file }),                 // test-only
  writeTestFile: (file, data) => ipcRenderer.invoke('debug:writeFile', { file, data }),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  setTitle: (t) => ipcRenderer.invoke('app:title', t),
});
