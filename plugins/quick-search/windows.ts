import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localPath } from '../../src/shared/file-results'
import type { FileSearch } from '../../src/shared/search-plan'

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
$scope = 'file:'
if ($request.directory) {
  $scope += $request.directory.Replace('\\', '/').Replace("'", "''")
}
$where = "SCOPE='$scope' AND System.Kind <> 'folder'"
function Escape-Like([string]$value) {
  $value.Replace("'", "''").Replace('[', '[[]').Replace('%', '[%]').Replace('_', '[_]')
}
if ($request.terms) {
  $names = foreach ($term in $request.terms) {
    $name = (($term -split '\\s+' | ForEach-Object { Escape-Like $_ }) -join '%')
    "System.FileName LIKE '%$name%'"
  }
  $where += " AND (" + ($names -join ' OR ') + ")"
}
$ext = if ($request.extension) { @($request.extension) }
  elseif ($request.applicationsOnly) { @('exe', 'lnk', 'msi', 'msix', 'appx', 'msp', 'appxbundle', 'msixbundle') }
if ($ext) {
  $extensions = ($ext | ForEach-Object { "System.FileExtension = '." + (Escape-Like $_) + "'" }) -join ' OR '
  $where += " AND ($extensions)"
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
  $command.CommandText = "SELECT TOP 15 System.FileName, System.ItemUrl, System.DateModified FROM SystemIndex WHERE $where ORDER BY System.DateModified DESC"
  $reader = $command.ExecuteReader()
  $items = @(
    while ($reader.Read()) {
      if ($reader.IsDBNull(0) -or $reader.IsDBNull(1)) { continue }
      $date = $null
      if (!$reader.IsDBNull(2)) { $date = ([datetime]$reader.GetValue(2)).ToString('o') }
      @{ name = $reader.GetString(0); url = $reader.GetString(1); date = $date }
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

export async function findFiles(query: FileSearch, signal: AbortSignal): Promise<{ files: WindowsFile[]; complete: boolean }> {
  const entries = await runScript(filesScript, query, signal)
  if (!Array.isArray(entries)) throw new Error('文件搜索结果格式不正确。')
  const files = entries.flatMap((entry): WindowsFile[] => {
    if (typeof entry?.name !== 'string' || typeof entry.url !== 'string') return []
    try {
      const path = fileURLToPath(entry.url)
      return localPath(path) ? [{ path, name: entry.name, date: entry.date ?? undefined }] : []
    } catch { return [] }
  })
  return { files, complete: entries.length < 15 }
}
