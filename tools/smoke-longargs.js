/**
 * The command-line length ceiling, and the filtergraph script that lifts it.
 *
 *   SHORTCUT_SMOKE=tools/smoke-longargs.js node_modules/.bin/electron .
 *
 * WHAT THIS REPRODUCES. A real project - 85 text cards inside the render range - failed
 * with "Preview render failed: Error: spawn ENAMETOOLONG". Windows caps a whole command
 * line at 32767 UTF-16 code units, and the render was over it: roughly 15 KB of baked
 * rawvideo inputs (ten arguments and a ~110-character scratch path per card) and roughly
 * 17 KB of filtergraph (an overlay chain per layer). Neither half is wrong on its own.
 *
 * The only honest way to test that is to actually hand the OS a command line over its
 * limit, because it is the OS that refuses it - so this drives the REAL spawn path
 * through `debug:ffmpegRun` rather than inspecting arguments and hoping.
 *
 * The graph is made huge with a chain of `null` filters, which is a genuinely valid
 * filtergraph of any length: if the mechanism works the render must SUCCEED, not merely
 * fail differently. A test that only asserted "no ENAMETOOLONG" would pass just as
 * happily on a broken script file.
 *
 * Needs no fixture: the input is lavfi.
 */
(async () => {
  try {
    const results = [];
    const ok = (name, cond, extra) => results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
    const note = (s) => results.push('....  ' + s);

    const D = 'C:\\Users\\BlasePC\\AppData\\Local\\Temp\\scut_test\\';
    const OUT = D + 'longargs_out.mp4';

    /** A valid filtergraph of about `chars` characters: one long chain of no-ops. */
    const graph = (chars) => {
      const links = [];
      const per = 'null,';
      const n = Math.max(1, Math.round(chars / per.length));
      for (let i = 0; i < n; i++) links.push('null');
      return '[0:v]' + links.join(',') + '[vout]';
    };

    const run = (fc) => window.api.ffmpegRun([
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'color=c=0x3060A0:s=320x240:r=15:d=1',
      '-filter_complex', fc,
      '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1', OUT,
    ]);

    // ---------------------------------------------------- 1. the short case is untouched
    const small = await run(graph(200));
    ok('a short graph runs, and stays on the command line',
      small && small.ok && small.scripted === false,
      JSON.stringify({ total: small && small.total, scripted: small && small.scripted }));

    // ---------------------------------------------------- 2. over the Windows limit
    //
    // 40 KB of graph on its own is already past 32767, so this is the failing shape.
    const bigGraph = graph(40000);
    ok('the fixture really is over the limit a command line has',
      bigGraph.length > 32767, bigGraph.length + ' chars of filtergraph');

    const big = await run(bigGraph);
    ok('...and it is recognised as needing a script file',
      big && big.scripted === true, JSON.stringify({ total: big && big.total }));
    ok('THE HEADLINE: a graph too long for a command line still RENDERS',
      big && big.ok,
      big ? ('code=' + big.code + ' ' + (big.error || '') + ' ' + (big.log || '').slice(-300)) : 'no answer');
    // `spawn` reports this in the MESSAGE, not in `err.code` - checking the code alone
    // passed just as happily with the fix disabled, which made the assertion worthless.
    ok('...and specifically not with ENAMETOOLONG, which is what it used to do',
      !/ENAMETOOLONG/.test(String((big && big.error) || '')),
      String((big && big.error) || 'no error'));

    // ---------------------------------------------------- 3. the scratch is cleaned up
    //
    // One graph per render left behind would accumulate forever.
    ok('the render actually wrote its output, so the graph reached ffmpeg intact',
      (await window.api.fileExists(OUT)) === true);
    ok('the temporary filtergraph is named and then deleted',
      !!big.script && (await window.api.fileExists(big.script)) === false,
      String(big.script || 'none'));

    // ---------------------------------------------------- 4. the boundary is honoured
    //
    // Just under the budget must NOT be rewritten - buildArgs stays byte-identical for an
    // ordinary render, which is what three other suites assert against.
    const justUnder = await run(graph(20000));
    ok('a graph under the budget is left on the command line',
      justUnder && justUnder.scripted === false && justUnder.ok,
      JSON.stringify({ total: justUnder && justUnder.total, scripted: justUnder && justUnder.scripted }));

    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    const total = results.filter((r) => !r.startsWith('....')).length;
    return results.join('\n') + '\n\n' + (total - failed) + '/' + total + ' passed';
  } catch (e) {
    return 'THREW  ' + (e && e.stack ? e.stack : e);
  }
})();
