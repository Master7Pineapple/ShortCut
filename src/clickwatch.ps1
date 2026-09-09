# The click watcher for ShortCut's screen recorder.
#
# Electron can tell us where the cursor IS (screen.getCursorScreenPoint) but not when a
# button goes down: there is no global mouse hook in the Electron API, and pulling in a
# native module for one boolean is not worth the build chain. Windows already exposes the
# state, so this polls it and prints transitions.
#
# One line per transition, on stdout, flushed immediately:
#
#     D <button> <epochMs>        # 1 = left, 2 = right
#     U <button> <epochMs>
#
# main.js parses it through ScreenTel.parseClickLine(). If PowerShell is missing, blocked
# by policy, or dies, the recording still gets cursor POSITIONS - the sidecar is written
# with `clicks: false` and everything downstream degrades to "no click data". That
# fallback is the reason this is a separate process rather than something the recorder
# depends on.
#
# GetAsyncKeyState reports the physical button state regardless of which window has
# focus, which is exactly what a screen recorder needs, and it reads state rather than
# installing a hook - so it cannot swallow or delay the user's clicks.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ScutMouse {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
'@

# VK_LBUTTON = 1, VK_RBUTTON = 2. Swapped buttons are a display concern, not ours.
$buttons = @(1, 2)
$down = @{ 1 = $false; 2 = $false }

while ($true) {
  foreach ($b in $buttons) {
    $isDown = ([ScutMouse]::GetAsyncKeyState($b) -band 0x8000) -ne 0
    if ($isDown -ne $down[$b]) {
      $down[$b] = $isDown
      $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $kind = if ($isDown) { 'D' } else { 'U' }
      [Console]::Out.WriteLine('{0} {1} {2}' -f $kind, $b, $ms)
      [Console]::Out.Flush()
    }
  }
  # 8 ms: fast enough that a click lands within a frame at 60 fps, cheap enough that the
  # poll does not show up next to the encoder in Task Manager.
  Start-Sleep -Milliseconds 8
}
