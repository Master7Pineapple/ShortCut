'use strict';
/**
 * Resolve Matte - the decode half. Main process only.
 *
 * `src/renderer/matte.js` owns the data model, the lookup and the edge operations. This
 * file owns the matte VIDEO: probing it, decoding it once with ffmpeg into 8-bit planes,
 * and caching those planes on disk. The renderer never decodes a matte itself - a hidden
 * <video> would be one more thing to keep in sync with the picture, and Chromium drops
 * the alpha channel of ProRes 4444 anyway.
 *
 * EVERY FAILURE IS A VALUE, NEVER AN EXCEPTION: `{ ok: false, error }`. A missing matte
 * is a clip that draws unmasked, not a broken app.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const Matte = require('./renderer/matte.js');

const MATTE_EXT = ['mov', 'mp4', 'mkv', 'mxf', 'avi', 'webm', 'm4v'];

// Pixel formats that carry an alpha channel. ProRes 4444 with "Export Alpha" decodes as
// yuva444p12le; a PNG-codec QuickTime as rgba; DNxHR 444 with alpha as yuva444p10le.
const ALPHA_FMT = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16|rgba64|bgra64)/;

let ffmpegPath = null;
let ffprobePath = null;
let cacheRoot = null;
const inflight = new Map();

function fileStamp(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? { size: st.size, mtime: Math.round(st.mtimeMs) } : null;
  } catch (e) { return null; }
}

function rate(s) {
  if (!s || s === '0/0') return 0;
  const [a, b] = String(s).split('/').map(Number);
  return b ? a / b : Number(a) || 0;
}

/** What the matte file is: size, frame rate, duration and whether it has alpha. */
function probe(p) {
  return new Promise((resolve) => {
    if (!fileStamp(p)) return resolve({ ok: false, error: 'file not found: ' + p });
    execFile(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: 'ffprobe could not read the file' });
        let j;
        try { j = JSON.parse(stdout); } catch (e) { return resolve({ ok: false, error: 'ffprobe output unreadable' }); }
        const v = (j.streams || []).find((s) => s.codec_type === 'video');
        if (!v) return resolve({ ok: false, error: 'the file has no video stream' });
        const fps = rate(v.r_frame_rate) || rate(v.avg_frame_rate) || 30;
        const pixFmt = String(v.pix_fmt || '');
        resolve({
          ok: true,
          width: Number(v.width) || 0,
          height: Number(v.height) || 0,
          fps: Math.round(fps * 1000) / 1000,
          duration: parseFloat(v.duration || (j.format && j.format.duration) || 0) || 0,
          codec: String(v.codec_name || ''),
          pixFmt,
          hasAlpha: ALPHA_FMT.test(pixFmt),
        });
      });
  });
}

const cacheFile = (key) => {
  fs.mkdirSync(cacheRoot, { recursive: true });
  return path.join(cacheRoot, key + '.rmatte');
};

/*
 * The cache file: a u32le header length, a JSON header, then every frame's RLE bytes back
 * to back. `lens` in the header is what splits them apart again.
 */
function cacheRead(key) {
  try {
    const buf = fs.readFileSync(cacheFile(key));
    const hl = buf.readUInt32LE(0);
    const head = JSON.parse(buf.slice(4, 4 + hl).toString('utf8'));
    let o = 4 + hl;
    const frames = head.lens.map((n) => {
      const f = new Uint8Array(buf.buffer, buf.byteOffset + o, n).slice();
      o += n;
      return f;
    });
    delete head.lens;
    return Object.assign(head, { frames });
  } catch (e) { return null; }
}

function cacheWrite(key, rec) {
  try {
    const head = Buffer.from(JSON.stringify({
      w: rec.w, h: rec.h, fps: rec.fps, channel: rec.channel, stamp: rec.stamp,
      lens: rec.frames.map((f) => f.length),
    }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(head.length, 0);
    fs.writeFileSync(cacheFile(key), Buffer.concat([len, head, ...rec.frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.length))]));
    return true;
  } catch (e) { return false; }
}

/**
 * Decode a matte file into RLE planes. `channel` 'auto' reads alpha when the file has it
 * and luma when it does not; the answer says which was used.
 *
 *   -> { ok, w, h, fps, channel, hasAlpha, stamp, cached, frames: [Uint8Array rle] }
 */
async function decode(req, onProgress) {
  const src = req && req.src;
  const stamp = fileStamp(src);
  if (!stamp) return { ok: false, error: 'matte file not found: ' + src };
  const res = Number(req.res) || Matte.DEFAULTS.res;
  const key = Matte.cacheKey(src, stamp, req.channel, res);

  const hit = cacheRead(key);
  if (hit && hit.frames.length) return Object.assign({ ok: true, cached: true, key }, hit);
  if (inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    const info = await probe(src);
    if (!info.ok) return info;
    let channel = req.channel === 'alpha' || req.channel === 'luma' ? req.channel : (info.hasAlpha ? 'alpha' : 'luma');
    if (channel === 'alpha' && !info.hasAlpha) {
      return { ok: false, error: 'this file has no alpha channel (' + info.pixFmt + '). Export with "Export Alpha" on, or set Channel to Luma.' };
    }
    const { w, h } = Matte.planeSize(info.width, info.height, res);
    const vf = channel === 'alpha'
      ? 'alphaextract,scale=' + w + ':' + h + ':flags=bilinear,format=gray'
      : 'scale=' + w + ':' + h + ':flags=bilinear:out_range=full,format=gray';
    const frames = await new Promise((resolve) => {
      const out = [];
      const size = w * h;
      let pending = Buffer.alloc(0);
      let err = '';
      const ff = spawn(ffmpegPath, ['-v', 'error', '-i', src, '-map', '0:v:0', '-an', '-sn',
        '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      { windowsHide: true });
      const expected = Math.max(1, Math.round(info.duration * info.fps));
      ff.stdout.on('data', (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let o = 0;
        while (pending.length - o >= size) {
          out.push(Matte.rleEncode(pending.subarray(o, o + size)));
          o += size;
        }
        pending = pending.subarray(o);
        if (onProgress && out.length % 15 === 0) onProgress({ src, done: out.length, total: expected });
      });
      ff.stderr.on('data', (d) => { err += d; });
      ff.on('error', (e) => resolve({ error: e.message }));
      ff.on('close', (code) => {
        if (!out.length) return resolve({ error: (err.trim().split('\n').pop() || 'ffmpeg exited ' + code) });
        resolve(out);
      });
    });
    if (!Array.isArray(frames)) return { ok: false, error: 'decode failed: ' + frames.error };
    const rec = { w, h, fps: info.fps, channel, stamp, frames };
    cacheWrite(key, rec);
    return Object.assign({ ok: true, cached: false, key, hasAlpha: info.hasAlpha }, rec);
  })();
  inflight.set(key, run);
  try { return await run; } finally { inflight.delete(key); }
}

function install(ctx) {
  const { app, ipcMain, dialog, send } = ctx;
  ffmpegPath = ctx.ffmpegPath;
  ffprobePath = ctx.ffprobePath;
  cacheRoot = path.join(app.getPath('userData'), 'cache', 'rmatte');

  ipcMain.handle('matte:pick', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Import a matte rendered from DaVinci Resolve',
      properties: ['openFile'],
      filters: [{ name: 'Matte video', extensions: MATTE_EXT }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  ipcMain.handle('matte:probe', async (_e, p) => {
    try { return await probe(p); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  ipcMain.handle('matte:decode', async (_e, req) => {
    try {
      return await decode(req, (d) => { try { send('matte:progress', d); } catch (e) { /* window gone */ } });
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
}

module.exports = { install, probe, decode, ALPHA_FMT, MATTE_EXT, _set: (o) => { ffmpegPath = o.ffmpegPath; ffprobePath = o.ffprobePath; cacheRoot = o.cacheRoot; } };
