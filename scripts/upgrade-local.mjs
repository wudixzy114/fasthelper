import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const pluginId = 'quick-search'
const pluginFile = `${pluginId}.fhplugin`

async function fingerprint(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function validatePlugin(bytes, key) {
  const envelope = JSON.parse(bytes.toString('utf8'))
  const payload = Buffer.from(envelope.payload, 'base64')
  if (!verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('快速搜索插件签名与本次构建不匹配。')
  }
  const manifest = JSON.parse(payload.toString('utf8'))
  if (manifest.id !== pluginId) throw new Error('插件包 ID 不正确。')
  return manifest
}

async function stagePlugin(version, destination) {
  const previous = await readFile(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!previous) return null

  const { pluginKey } = JSON.parse(await readFile('build/distribution.json', 'utf8'))
  const key = createPublicKey(pluginKey)
  validatePlugin(previous, key)
  const latest = await readFile(join('release', 'plugins', pluginFile))
  if (validatePlugin(latest, key).version !== version) throw new Error('构建出的插件版本不正确。')

  const staged = `${destination}.${randomUUID()}.pending`
  await writeFile(staged, latest, { flag: 'wx', flush: true })
  return staged
}

// NSIS closes the current-user installation for an overwrite. Check the exact executable first.
const installScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$installed = $env:FASTHELPER_LOCAL_APP
$installer = $env:FASTHELPER_LOCAL_INSTALLER
$processes = @(Get-Process -Name fasthelper -ErrorAction SilentlyContinue)
if (@($processes | Where-Object { $_.Path -ne $installed }).Count) {
  throw '请先退出其他位置运行的 fasthelper 调试副本。'
}
$hadWindow = $processes.Count -gt 0
$result = Start-Process -FilePath $installer -ArgumentList '/S','/currentuser' -WindowStyle Hidden -PassThru -Wait
if ($result.ExitCode -ne 0) { throw "安装程序退出码为 $($result.ExitCode)。" }
if (!(Test-Path -LiteralPath $installed -PathType Leaf)) { throw '安装后找不到 fasthelper.exe。' }
$version = (Get-Item -LiteralPath $installed).VersionInfo.ProductVersion
[pscustomobject]@{ version = $version; restart = $hadWindow } | ConvertTo-Json -Compress
`

async function upgrade() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA || !process.env.APPDATA) {
    throw new Error('本机覆盖升级需要 Windows 用户安装环境。')
  }
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('package.json 版本号无效。')

  const release = resolve('release', 'windows', version)
  const installer = join(release, `fasthelper-${version}-win-x64.exe`)
  const appDirectory = join(process.env.LOCALAPPDATA, 'Programs', 'fasthelper')
  const executable = join(appDirectory, 'fasthelper.exe')
  const destination = join(process.env.APPDATA, 'fasthelper', 'plugins', pluginId, pluginFile)
  const expected = await fingerprint(join(release, 'win-unpacked', 'resources', 'app.asar'))
  const staged = await stagePlugin(version, destination)

  try {
    console.log(`正在覆盖安装 fasthelper ${version}…`)
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(installScript, 'utf16le').toString('base64'),
    ], {
      env: { ...process.env, FASTHELPER_LOCAL_APP: executable, FASTHELPER_LOCAL_INSTALLER: installer },
      stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', windowsHide: true, timeout: 180_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('本机覆盖安装失败。')
    const installed = JSON.parse(result.stdout.trim())
    if (installed.version !== version && installed.version !== `${version}.0`) {
      throw new Error(`已安装版本为 ${installed.version}，预期版本为 ${version}。`)
    }
    if (await fingerprint(join(appDirectory, 'resources', 'app.asar')) !== expected) {
      throw new Error('已安装的应用内容与本次构建不一致。')
    }

    if (staged) {
      await rename(staged, destination)
      console.log(`已更新本机的快速搜索插件至 ${version}。`)
    }
    if (installed.restart) {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: true })
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
    }
    console.log(`已验证本机 fasthelper ${version} 为本次构建。`)
  } finally {
    if (staged) await rm(staged, { force: true })
  }
}

await upgrade().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
