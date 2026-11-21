import { execFile } from 'node:child_process'
import { join, win32 } from 'node:path'
import { toFileQuery } from '../../src/shared/intent'

export type WindowsApp = { name: string; appId: string; launch: 'aumid' | 'path' }
export type WindowsFile = { name: string; path: string; date?: string }

const root = process.env.SystemRoot || 'C:\\Windows'
const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const initialization = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
`

const appsScript = `
$items = @(
  Get-StartApps | Where-Object { $_.Name -and $_.AppID } | ForEach-Object {
    @{ Name = $_.Name; AppID = $_.AppID; Launch = 'aumid' }
  }
  try {
    [void][Windows.Management.Deployment.PackageManager,Windows.Management.Deployment,ContentType=WindowsRuntime]
    $manager = New-Object Windows.Management.Deployment.PackageManager
    foreach ($package in $manager.FindPackagesForUser('')) {
      try {
        foreach ($entry in $package.GetAppListEntries()) {
          if ($entry.AppUserModelId -and $entry.DisplayInfo.DisplayName) {
            @{ Name = $entry.DisplayInfo.DisplayName; AppID = $entry.AppUserModelId; Launch = 'aumid' }
          }
        }
      } catch { }
    }
  } catch { }
  foreach ($root in @(
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths'
  )) {
    foreach ($entry in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      $path = [Environment]::ExpandEnvironmentVariables([string]$entry.GetValue('')).Trim('"')
      if ($path -notmatch '^[A-Za-z]:[\\\\/]' -or $path -notmatch '\\.exe$' -or !(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
      $name = (Get-Item -LiteralPath $path -ErrorAction SilentlyContinue).VersionInfo.FileDescription
      if (!$name) { $name = [IO.Path]::GetFileNameWithoutExtension($path) }
      @{ Name = $name; AppID = $path; Launch = 'path' }
    }
  }
)
ConvertTo-Json -InputObject $items -Compress
`

const filesScript = `
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ((Get-Service WSearch).Status -ne 'Running') { throw 'Windows Search is stopped.' }
$where = "System.Kind <> 'folder'"
if ($request.name) {
  $name = ([string]$request.name).Replace("'", "''").Replace('[', '[[]').Replace('%', '[%]').Replace('_', '[_]')
  $where += " AND System.FileName LIKE '%$name%'"
}
if ($request.after) {
  $after = ([datetime]$request.after).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $before = ([datetime]$request.before).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $where += " AND System.DateModified >= '$after' AND System.DateModified < '$before'"
}
$connection = [System.Data.OleDb.OleDbConnection]::new('Provider=Search.CollatorDSO;Extended Properties="Application=Windows";')
try {
  $connection.Open()
  $command = $connection.CreateCommand()
  $command.CommandTimeout = 4
  $command.CommandText = "SELECT TOP 15 System.FileName, System.ItemPathDisplay, System.DateModified FROM SystemIndex WHERE $where ORDER BY System.DateModified DESC"
  $reader = $command.ExecuteReader()
  $items = @(
    while ($reader.Read()) {
      if ($reader.IsDBNull(0) -or $reader.IsDBNull(1)) { continue }
      $date = $null
      if (!$reader.IsDBNull(2)) { $date = ([datetime]$reader.GetValue(2)).ToString('o') }
      @{ name = $reader.GetString(0); path = $reader.GetString(1); date = $date }
    }
  )
  ConvertTo-Json -InputObject $items -Compress
} finally {
  $connection.Dispose()
}
`

export function runScript(script: string, input: object, signal?: AbortSignal): Promise<unknown> {
  const encoded = Buffer.from(initialization + script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 9_000, signal, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return reject(error)
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/u, '').trim()))
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(JSON.stringify(input))
  })
}

export function isAppId(value: unknown): value is string {
  return typeof value === 'string' && /^[^\u0000-\u001f"<>|]{1,1024}$/u.test(value)
}

export async function scanApplications(): Promise<WindowsApp[]> {
  const entries = await runScript(appsScript, {})
  if (!Array.isArray(entries)) throw new Error('应用目录格式不正确。')
  return entries.flatMap((entry) =>
    typeof entry?.Name === 'string' && isAppId(entry.AppID)
      ? [{ name: entry.Name.trim(), appId: entry.AppID, launch: entry.Launch === 'path' ? 'path' as const : 'aumid' as const }]
      : [],
  ).filter((entry) => entry.name && !entry.name.startsWith('ms-resource:'))
}

export async function findFiles(query: string, signal: AbortSignal): Promise<WindowsFile[]> {
  const entries = await runScript(filesScript, toFileQuery(query), signal)
  if (!Array.isArray(entries)) throw new Error('文件搜索结果格式不正确。')
  return entries.filter((entry) =>
    typeof entry?.name === 'string'
    && typeof entry?.path === 'string'
    && /^[a-z]:[\\/]/iu.test(entry.path)
    && win32.isAbsolute(entry.path),
  )
}
