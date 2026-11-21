import { execFile } from 'node:child_process'
import { join } from 'node:path'

const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const lookup = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$shell = New-Object -ComObject Shell.Application
$entry = $shell.Namespace('shell:AppsFolder').ParseName([Console]::In.ReadToEnd())
if ($entry) { [Console]::Write($entry.Name) }
`
const encodedLookup = Buffer.from(lookup, 'utf16le').toString('base64')

export function registeredApplicationName(appId: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedLookup],
      { windowsHide: true, signal, timeout: 4_000, encoding: 'utf8' },
      (error, name) => error ? reject(error) : resolve(name))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(appId)
  })
}

export async function launchApplication(appId: string): Promise<void> {
  if (!/^[^\u0000-\u001f"<>|]{1,1024}$/u.test(appId)) throw new Error('应用标识无效。')
  await new Promise<void>((resolve, reject) => {
    const child = execFile(join(systemRoot, 'explorer.exe'), [`shell:AppsFolder\\${appId}`], {
      windowsHide: true,
    })
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}
