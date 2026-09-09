'use strict';
/**
 * Preload for the hidden recorder window.
 *
 * Deliberately tiny and separate from the editor's `preload.js`: the recorder window
 * needs to move megabytes of encoded video into the main process and nothing else, and
 * the editor's whole API has no business being reachable from it.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rec', {
  ready: () => ipcRenderer.send('rec:ready'),
  onStart: (cb) => ipcRenderer.on('rec:start', (_e, opts) => cb(opts)),
  onStop: (cb) => ipcRenderer.on('rec:stop', () => cb()),
  started: (info) => ipcRenderer.send('rec:started', info),
  // The first frame's wall-clock time. Everything in the sidecar is measured from it.
  firstFrame: (epochMs) => ipcRenderer.send('rec:firstFrame', epochMs),
  chunk: (buf) => ipcRenderer.send('rec:chunk', buf),
  done: (info) => ipcRenderer.send('rec:done', info),
  fail: (msg) => ipcRenderer.send('rec:error', String(msg)),
});
