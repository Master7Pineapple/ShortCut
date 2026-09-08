/**
 * The metering processor: turns samples into 100 ms blocks of energy and posts them out.
 *
 * It runs on the audio thread, so it does as little as possible - a sum of squares and a
 * peak, no allocation per block beyond the message itself. All the loudness maths lives
 * in meter.js on the main thread, where it can be tested without an AudioContext.
 *
 * Two inputs, and which is which matters:
 *   input 0 - K-WEIGHTED mix, for loudness. Weighted energy is what LUFS is defined on.
 *   input 1 - the raw mix, for the peak bars. Metering peak off the weighted signal would
 *             read several dB out, because the weighting curve is not flat.
 *
 * Loading it: the AudioWorklet fetches this file by URL, so it is a module of its own and
 * cannot see anything else in the app. Nothing here may reference window or Meter.
 */
class MeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.blockSize = Math.max(1, Math.round(sampleRate * (opts.blockMs || 100) / 1000));
    this.n = 0;
    this.sumSq = [0, 0];
    this.peak = 0;
  }

  process(inputs) {
    const weighted = inputs[0];
    const raw = inputs[1] && inputs[1].length ? inputs[1] : weighted;

    // A disconnected or not-yet-started input arrives as an empty array. Returning true
    // keeps the node alive so it starts metering the moment audio does arrive - going
    // quiet must never be what kills the meter.
    if (!weighted || !weighted.length || !weighted[0]) return true;

    const frames = weighted[0].length;
    for (let c = 0; c < weighted.length && c < 2; c++) {
      const ch = weighted[c];
      let s = this.sumSq[c];
      for (let i = 0; i < frames; i++) s += ch[i] * ch[i];
      this.sumSq[c] = s;
    }
    if (raw && raw.length) {
      for (let c = 0; c < raw.length; c++) {
        const ch = raw[c];
        for (let i = 0; i < frames; i++) {
          const v = ch[i] < 0 ? -ch[i] : ch[i];
          if (v > this.peak) this.peak = v;
        }
      }
    }
    this.n += frames;

    if (this.n >= this.blockSize) {
      const chans = Math.min(2, weighted.length);
      const ms = [];
      for (let c = 0; c < chans; c++) ms.push(this.sumSq[c] / this.n);
      this.port.postMessage({ ms, peak: this.peak });
      this.sumSq[0] = this.sumSq[1] = 0;
      this.peak = 0;
      this.n = 0;
    }
    return true;
  }
}

registerProcessor('shortcut-meter', MeterProcessor);
