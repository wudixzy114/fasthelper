import { runScript } from './windows'

// Official Everything 1.4 IPC commands. SendMessageTimeout also supports named portable instances.
// https://www.voidtools.com/support/everything/sdk/ipc/
const probe = `
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FasthelperEverythingStatus {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  private static extern IntPtr FindWindow(string windowClass, string name);
  [DllImport("user32.dll", SetLastError=true)]
  private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr command,
    IntPtr argument, uint flags, uint timeout, out UIntPtr result);

  public static int[] Read(string windowClass) {
    var window = FindWindow(windowClass, null);
    if (window == IntPtr.Zero) return new int[0];
    var commands = new uint[] { 401, 0, 1, 2, 3 };
    var values = new int[commands.Length];
    for (int i = 0; i < commands.Length; i++) {
      UIntPtr value;
      if (SendMessageTimeout(window, 0x400, new UIntPtr(commands[i]), IntPtr.Zero, 3, 350, out value) == IntPtr.Zero)
        return new int[0];
      values[i] = (int)value.ToUInt64();
    }
    return values;
  }
}
"@
$result = [FasthelperEverythingStatus]::Read($request.windowClass)
ConvertTo-Json -InputObject @{ values=$result } -Compress
`

export async function indexStatus(instance?: string): Promise<{ ready: boolean; version: string } | null> {
  const name = 'EVERYTHING_TASKBAR_NOTIFICATION' + (instance ? `_(${instance})` : '')
  const result = await runScript(probe, { windowClass: name }) as { values?: number[] }
  if (!Array.isArray(result?.values) || result.values.length !== 5 || result.values[1] < 1) return null
  return { ready: result.values[0] !== 0, version: result.values.slice(1).join('.') }
}
