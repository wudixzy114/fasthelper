import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import type { PluginServiceState } from '../../src/shared/contracts'
import type { FileSearch } from '../../src/shared/search-plan'
import { localPath } from '../../src/shared/file-results'
import { runScript, type WindowsFile } from './windows'
import { indexStatus } from './everything-status'

const execute = promisify(execFile)
const instance = 'fasthelper-quick-search'
const artifacts = {
  cli: ['ES-1.1.0.38.x64.zip', '5e0c70cbf4f694080c34aa7c6c745e606c16fe76a4b5423b93ebf9dc34274c99', 117393],
  engine: ['Everything-1.4.1.1032.x64.zip', '698df475ec44e638f66f1b6a32d28fea613cec78d3b6310e6abe53431eeb940c', 1906504],
} as const

const systemInfo = `
$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything',
           'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything',
           'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything')
$versions = @(
  foreach ($root in $roots) {
    $item = Get-ItemProperty -LiteralPath $root -ErrorAction SilentlyContinue
    if ($item.InstallLocation -and $item.DisplayVersion -match '^1\\.4\\.') {
      $exe = Join-Path $item.InstallLocation 'Everything.exe'
      if (Test-Path -LiteralPath $exe -PathType Leaf) {
        try {
          Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security') -ErrorAction Stop
          $signature = Get-AuthenticodeSignature -LiteralPath $exe
          if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(^|, )CN=voidtools PTY LTD(,|$)') { $exe }
        } catch { }
      }
    }
  }
)
$drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' } | ForEach-Object Name)
ConvertTo-Json -InputObject @{ executable = $versions | Select-Object -First 1; drives = $drives } -Compress
`

export type IndexedFile = WindowsFile & { folder?: boolean }

async function unzipVerified(
  artifact: (typeof artifacts)[keyof typeof artifacts], output: string, signal: AbortSignal,
  progress: (phase: 'connecting' | 'downloading' | 'verifying', bytes: number, total: number) => void,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'fasthelper-index-'))
  const idle = new AbortController()
  const timer = setTimeout(() => idle.abort(), 45_000)
  try {
    const [filename, expected, total] = artifact
    const downloadSignal = AbortSignal.any([signal, idle.signal])
    progress('connecting', 0, total)
    const response = await fetch(`https://www.voidtools.com/${filename}`, { signal: downloadSignal })
    if (!response.ok || !response.body) throw new Error('无法下载 Everything 组件。')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    let lastUpdate = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        timer.refresh()
        length += chunk.value.byteLength
        if (length > total) throw new Error('Everything 安装包超出预期大小。')
        chunks.push(chunk.value)
        if (Date.now() - lastUpdate > 125 || length === total) {
          lastUpdate = Date.now()
          progress('downloading', length, total)
        }
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const bytes = Buffer.concat(chunks)
    clearTimeout(timer)
    progress('verifying', length, total)
    if (length !== total || createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error('Everything 组件校验失败。')
    }
    const zip = join(temporary, filename)
    await writeFile(zip, bytes)
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    await execute(tar, ['-xf', zip, '-C', temporary], { windowsHide: true, timeout: 15_000 })
    const entries = artifact === artifacts.cli ? ['es.exe'] : ['everything.exe', 'Everything.lng']
    await mkdir(output, { recursive: true })
    signal.throwIfAborted()
    for (const entry of entries) await copyFile(join(temporary, entry), join(output, entry))
  } catch (error) {
    if (idle.signal.aborted && !signal.aborted) throw new Error('连接或下载长时间没有收到数据。请重新检测。')
    throw error
  } finally {
    clearTimeout(timer)
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

function parseEfu(data: string): IndexedFile[] {
  return data.replace(/^\uFEFF/u, '').split(/\r?\n/u).slice(1).flatMap((line) => {
    const row = /^(?:"([^"]+)"|([^,]+)),([^,]*),([^,]*),([^,]*)$/u.exec(line)
    const path = row?.[1] || row?.[2]
    if (!row || !path || !localPath(path)) return []
    const date = /^\d+$/u.test(row[4]) && Number(row[4]) > 116444736000000000
      ? new Date(Number((BigInt(row[4]) - 116444736000000000n) / 10000n)).toISOString() : undefined
    return [{ path, name: win32.basename(path), folder: (Number(row[5]) & 16) !== 0, date }]
  })
}

function localDate(iso: string): string {
  const date = new Date(iso)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-')
}

export class Everything {
  private preparing?: Promise<void>
  private executable?: string
  private owned = false
  private revision = 0
  private enabled = true
  private ownedProcess?: ChildProcess
  private setup?: AbortController
  private probe?: Promise<void>
  private probeTimer?: NodeJS.Timeout
  private paused = false
  private startupAt = 0
  private state: PluginServiceState = { enabled: true, status: 'waiting', managed: false }

  constructor(private readonly root: string, private readonly publish: (state: PluginServiceState) => void) {
    this.owned = existsSync(join(root, 'portable', 'everything.exe'))
    this.state = {
      ...this.state, managed: this.owned, installed: this.owned || undefined,
      ...(this.owned ? { version: '1.4.1.1032' } : {}),
    }
  }

  async setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return
    this.revision += 1
    this.enabled = enabled
    if (enabled) {
      this.check()
    } else {
      this.setup?.abort()
      clearTimeout(this.probeTimer)
      await this.stopOwned()
      await this.probe
      this.executable = undefined
      this.report('off', { error: undefined })
    }
  }

  async remove(): Promise<void> {
    await this.setEnabled(false)
    await this.preparing?.catch(() => undefined)
    const owned = join(this.root, 'portable')
    await rm(owned, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    this.owned = false
    this.report('off', { installed: false, version: undefined })
  }

  check(): void {
    this.paused = false
    if (!this.enabled) return
    if (this.executable) void this.refresh()
    else this.begin()
  }

  cancel(): void {
    if (!this.setup) return
    this.paused = true
    this.revision += 1
    this.setup.abort()
    this.report('waiting', { error: '已取消下载。可点击「重新检测」继续。' })
  }

  open(): void {
    if (!this.executable) throw new Error('Everything 客户端尚未启动。')
    const child = spawn(this.executable, this.owned ? ['-instance', instance] : [], {
      detached: true, windowsHide: false, stdio: 'ignore',
    })
    child.on('error', () => this.report('unavailable', { error: '无法打开 Everything。' }))
    child.unref()
  }

  private begin(): void {
    if (this.preparing || this.paused || !this.enabled) return
    const revision = this.revision
    const controller = new AbortController()
    this.setup = controller
    this.preparing = this.prepare(revision, controller.signal).catch((error: unknown) => {
      if (this.enabled && revision === this.revision && !controller.signal.aborted) {
        this.report('unavailable', {
          error: error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message)
            ? error.message : '检查或启动 Everything 失败。请重新检测。',
        })
      }
    }).finally(() => {
      this.preparing = undefined
      this.setup = undefined
      if (revision !== this.revision && this.enabled) this.begin()
    })
  }

  private refresh(): Promise<void> {
    if (this.probe) return this.probe
    const revision = this.revision
    this.probe = (async () => {
      clearTimeout(this.probeTimer)
      const status = await indexStatus(this.owned ? instance : undefined).catch(() => null)
      if (!this.executable || !this.enabled || revision !== this.revision) return
      const checkedAt = Date.now()
      if (status) {
        this.report(status.ready ? 'ready' : 'indexing', { checkedAt, version: status.version, error: undefined })
      } else if (checkedAt - this.startupAt < 10_000) {
        this.report('starting', { checkedAt })
      } else {
        this.report('unavailable', { checkedAt, error: '无法连接 Everything 客户端。请检查程序是否在运行。' })
      }
      this.probeTimer = setTimeout(() => void this.refresh(), status?.ready ? 15_000 : 3_000).unref()
    })().finally(() => { this.probe = undefined })
    return this.probe
  }

  fallbackReason(): string {
    if (!this.enabled) return 'Everything 已关闭'
    if (this.paused) return 'Everything 下载已取消'
    const reasons: Partial<Record<PluginServiceState['status'], string>> = {
      connecting: '正在连接 Everything 下载源', downloading: '正在下载 Everything 组件',
      verifying: '正在校验 Everything 组件',
      waiting: 'Everything 尚未就绪', starting: '正在连接 Everything 客户端',
      indexing: 'Everything 索引加载中', unavailable: 'Everything 暂不可用',
    }
    return reasons[this.state.status] ?? '本次 Everything 查询失败'
  }

  async find(requested: FileSearch, signal: AbortSignal): Promise<{ files: IndexedFile[]; complete: boolean } | null> {
    if (!this.enabled) return null
    if (!this.executable || this.state.status !== 'ready') {
      if (!this.executable && this.state.status === 'waiting') this.begin()
      return null
    }
    let output: string | undefined
    try {
      output = await mkdtemp(join(tmpdir(), 'fasthelper-search-'))
      const result = join(output, 'results.efu')
      const terms = new Set<string>()
      for (const term of requested.terms) {
        const words = term.match(/[\p{L}\p{N}_.-]+/gu)?.filter((word) => /[\p{L}\p{N}]/u.test(word)) ?? []
        if (!words.length) continue
        terms.add(words.join(''))
        // Match spaced titles and compact executable names with the index's literal search.
        if (words.length > 1) terms.add('<' + words.map((word) => '<' + word + '>').join('') + '>')
      }
      if (!terms.size) return { files: [], complete: true }
      const args = ['-export-efu', result, '-utf8-bom', '-n', '60']
      if (requested.directory) args.push('-path', requested.directory)
      args.push(`<${[...terms].join('|')}>`)
      if (requested.extension) args.push(`ext:${requested.extension}`)
      else if (requested.applicationsOnly) args.push('ext:exe;lnk;msi;msix;appx;msp;appxbundle;msixbundle')
      if (requested.after && requested.before) args.push(`dm:${localDate(requested.after)}..${localDate(requested.before)}`)
      await this.run(args, signal)
      const files = parseEfu(await readFile(result, 'utf8'))
      const filtered = files.filter((item) =>
        !requested.after || !!item.date && item.date >= requested.after && item.date < requested.before!)
      return { files: filtered, complete: files.length < 60 }
    } catch {
      if (!signal.aborted && this.enabled) void this.refresh()
      return null
    } finally {
      if (output) await rm(output, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async prepare(revision: number, signal: AbortSignal): Promise<void> {
    this.report('starting', { error: undefined })
    const cli = join(this.root, 'cli')
    const portable = join(this.root, 'portable')
    const managed = join(portable, 'everything.exe')
    const config = join(portable, 'Everything-fasthelper-quick-search.ini')
    const hasManaged = await access(managed).then(() => true, () => false)
    const hasConfig = await access(config).then(() => true, () => false)
    const info = hasManaged && hasConfig
      ? {} : await runScript(systemInfo, {}) as { executable?: string; drives?: string[] }
    if (!this.enabled || revision !== this.revision) return
    const existing = !hasManaged && info.executable && localPath(info.executable) ? info.executable : undefined
    const executable = existing ?? managed
    this.owned = !existing
    this.report('starting', { installed: !!existing || hasManaged })
    const notify = (component: string) => (
      status: 'connecting' | 'downloading' | 'verifying', transferred: number, total: number,
    ) => this.report(status, { progress: { component, transferred, total } })
    if (!await access(join(cli, 'es.exe')).then(() => true, () => false)) {
      await unzipVerified(artifacts.cli, cli, signal, notify('搜索连接组件'))
    }
    if (!existing && !(hasManaged && hasConfig)) {
      if (!hasManaged) await unzipVerified(artifacts.engine, portable, signal, notify('Everything 便携版'))
      const folders = (info.drives ?? []).filter((path) => /^[a-z]:\\$/iu.test(path))
      if (!folders.length) throw new Error('未找到可索引的本地磁盘。')
      const ini = [
        '[Everything]', 'app_data=0', 'run_as_admin=0', 'service=0', 'update_notification=0',
        'auto_include_fixed_volumes=0', 'auto_include_removable_volumes=0',
        `folders=${folders.map((path) => `"${path.replaceAll('\\', '\\\\')}"`).join(',')}`,
        `folder_monitor_changes=${folders.map(() => '1').join(',')}`,
      ].join('\r\n')
      await writeFile(config, ini, { flag: 'wx' })
        .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    }
    if (!this.enabled || revision !== this.revision) return
    signal.throwIfAborted()
    this.startupAt = Date.now()
    this.report('starting', { installed: true, version: this.owned ? '1.4.1.1032' : this.state.version })
    const args = this.owned ? ['-instance', instance, '-startup', '-config', config] : ['-startup']
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: win32.dirname(executable), windowsHide: true, detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => {
        if (this.owned) this.ownedProcess = child
        child.unref()
        resolve()
      })
    })
    if (!this.enabled || revision !== this.revision) return this.stopOwned(executable)
    this.executable = executable
    void this.refresh()
  }

  private run(args: string[], signal: AbortSignal) {
    return execute(join(this.root, 'cli', 'es.exe'), [
      '-ipc2', ...(this.owned ? ['-instance', instance] : []), '-timeout', '350', ...args,
    ], { windowsHide: true, signal, timeout: 2_000 })
  }

  private async stopOwned(executable = this.executable ?? join(this.root, 'portable', 'everything.exe')) {
    if (!this.owned) return
    const child = this.ownedProcess
    this.ownedProcess = undefined
    await execute(executable, ['-instance', instance, '-exit'], { windowsHide: true, timeout: 3_000 })
      .catch(() => { child?.kill() })
  }

  private report(status: PluginServiceState['status'], details: Partial<PluginServiceState> = {}) {
    this.state = {
      ...this.state, enabled: this.enabled, status, managed: this.owned,
      since: this.state.status === status ? this.state.since : Date.now(),
      canOpen: !!this.executable, progress: undefined, ...details,
    }
    this.publish(this.state)
  }
}
