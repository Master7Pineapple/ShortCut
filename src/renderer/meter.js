'use strict';
/**
 * Loudness and peak metering maths - ITU-R BS.1770-4 / EBU R 128.
 *
 * Deliberately pure: no AudioContext, no canvas, no DOM. It takes blocks of mean-square
 * energy and gives back numbers. The audio plumbing lives in app.js and the sample
 * crunching in meter-worklet.js; keeping the maths out of both is what makes it testable
 * without playing a single sample - see tools/smoke-meter.js.
 *
 * The chain the numbers come from:
 *
 *   mix -> K-weighting (two IIR stages, coefficients from kWeighting()) -> 100 ms blocks
 *       -> Meter.Session, which forms 400 ms windows out of four blocks each
 *
 * Momentary is one 400 ms window, short-term is 3 s, and integrated is the gated mean of
 * every 400 ms window since the last reset. The gating is the part everyone gets wrong,
 * so it is spelled out at `integrated()` below.
 */
const Meter = (() => {
  /** Loudness of a mono/stereo block from its per-channel mean squares. */
  const ABS_GATE = -70;        // LUFS; silence must not drag the average down
  const REL_GATE = -10;        // LU below the ungated mean
  const BLOCK_MS = 100;        // sub-block; four of them make one 400 ms window
  const WINDOW_BLOCKS = 4;     // 400 ms
  const SHORT_BLOCKS = 30;     // 3 s

  /**
   * The two K-weighting filter stages for a given sample rate.
   *
   * BS.1770 tabulates coefficients for 48 kHz only; these come from the analog prototype
   * the table was generated from, so any sample rate works and 48 kHz reproduces the
   * published numbers exactly (tools/smoke-meter.js asserts that against the table).
   *
   * Returned in the shape createIIRFilter() wants: feedforward [b0,b1,b2] and feedback
   * [1,a1,a2].
   */
  function kWeighting(sampleRate) {
    const fs = sampleRate || 48000;

    // Stage 1: a +4 dB high shelf at ~1.68 kHz - the head-related "acoustic" stage.
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    const s1 = {
      b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
    };

    // Stage 2: a ~38 Hz high-pass - what stops rumble reading as loudness.
    const f0b = 38.13547087602444;
    const Qb = 0.5003270373238773;
    const Kb = Math.tan(Math.PI * f0b / fs);
    const den = 1 + Kb / Qb + Kb * Kb;
    const s2 = {
      b: [1, -2, 1],
      a: [1, 2 * (Kb * Kb - 1) / den, (1 - Kb / Qb + Kb * Kb) / den],
    };

    return [s1, s2];
  }

  /**
   * Loudness of one block, from the mean square of each K-weighted channel.
   *
   * The -0.691 is the BS.1770 calibration constant; the channel weights are 1.0 for left
   * and right (surround channels, which this app has none of, weigh more).
   */
  function blockLoudness(ms) {
    let sum = 0;
    for (let i = 0; i < ms.length; i++) sum += ms[i];      // G = 1.0 for L and R
    if (!(sum > 0)) return -Infinity;
    return -0.691 + 10 * Math.log10(sum);
  }

  /** Mean square -> dBFS, for the peak/RMS bars. */
  function dbfs(v) { return v > 0 ? 20 * Math.log10(v) : -Infinity; }

  /**
   * A metering session: feed it 100 ms blocks, read momentary / short-term / integrated.
   *
   * It holds only the running sums the gating needs plus a small ring for the sliding
   * windows, so a long playback does not grow memory without bound - except for the
   * gating history, which genuinely does need every window (see integrated()).
   */
  function Session() {
    this.reset();
  }

  Session.prototype.reset = function () {
    /** Per-channel mean square of each 100 ms block, newest last. Trimmed to 3 s. */
    this.blocks = [];
    /** Loudness and summed energy of every 400 ms window, for the integrated gate. */
    this.windows = [];
    this.peak = 0;           // sample peak since reset, linear
    this.channels = 2;
    this._sinceWindow = 0;
  };

  /**
   * Push one 100 ms block: `ms` is the per-channel mean square, `peak` the linear sample
   * peak over the same block.
   */
  Session.prototype.push = function (ms, peak) {
    if (!ms || !ms.length) return;
    this.channels = ms.length;
    if (peak > this.peak) this.peak = peak;
    this.blocks.push(ms);
    if (this.blocks.length > SHORT_BLOCKS) this.blocks.shift();

    // A 400 ms window every 100 ms is the 75% overlap BS.1770 asks for.
    this._sinceWindow++;
    if (this.blocks.length >= WINDOW_BLOCKS) {
      const w = this._meanOfLast(WINDOW_BLOCKS);
      const l = blockLoudness(w);
      if (l > -Infinity) this.windows.push({ l, ms: w });
    }
  };

  /** Mean square per channel over the last `n` blocks. */
  Session.prototype._meanOfLast = function (n) {
    const take = Math.min(n, this.blocks.length);
    const out = new Array(this.channels).fill(0);
    for (let i = this.blocks.length - take; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      for (let c = 0; c < out.length; c++) out[c] += (b[c] || 0);
    }
    for (let c = 0; c < out.length; c++) out[c] /= take;
    return out;
  };

  /** Loudness over the last 400 ms. */
  Session.prototype.momentary = function () {
    if (this.blocks.length < 1) return -Infinity;
    return blockLoudness(this._meanOfLast(WINDOW_BLOCKS));
  };

  /** Loudness over the last 3 s. */
  Session.prototype.shortTerm = function () {
    if (this.blocks.length < 1) return -Infinity;
    return blockLoudness(this._meanOfLast(SHORT_BLOCKS));
  };

  /**
   * Integrated loudness - the number that is compared against the -14 LUFS target.
   *
   * Two gates, in this order, and the order is the whole point:
   *
   *  1. absolute: drop every window quieter than -70 LUFS, so a silent lead-in does not
   *     drag the programme loudness down;
   *  2. relative: take the mean of what survived, and drop everything more than 10 LU
   *     below THAT, so a quiet passage does not count either.
   *
   * The integrated value is the loudness of the mean energy of the twice-gated set - not
   * the mean of the loudness values, which is a different (and wrong) number.
   */
  Session.prototype.integrated = function () {
    const first = this.windows.filter((w) => w.l > ABS_GATE);
    if (!first.length) return -Infinity;

    const meanOf = (list) => {
      const out = new Array(this.channels).fill(0);
      for (const w of list) for (let c = 0; c < out.length; c++) out[c] += (w.ms[c] || 0);
      for (let c = 0; c < out.length; c++) out[c] /= list.length;
      return out;
    };

    const relThreshold = blockLoudness(meanOf(first)) + REL_GATE;
    const second = first.filter((w) => w.l > relThreshold);
    if (!second.length) return -Infinity;
    return blockLoudness(meanOf(second));
  };

  /** Sample peak since the last reset, in dBFS. */
  Session.prototype.peakDb = function () { return dbfs(this.peak); };

  return {
    kWeighting, blockLoudness, dbfs, Session,
    BLOCK_MS, WINDOW_BLOCKS, SHORT_BLOCKS, ABS_GATE, REL_GATE,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Meter;
else if (typeof window !== 'undefined') window.Meter = Meter;
