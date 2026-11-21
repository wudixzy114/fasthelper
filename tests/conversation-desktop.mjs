import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright-core'

const modelSource = process.env.FASTHELPER_TEST_LOCAL_MODEL
const audio = process.env.FASTHELPER_TEST_AUDIO
const stagedSpeech = process.env.FASTHELPER_TEST_SPEECH_PROFILE
const downloadSpeech = process.env.FASTHELPER_TEST_SPEECH_DOWNLOAD === '1'
assert.ok(modelSource, 'set FASTHELPER_TEST_LOCAL_MODEL to the existing Qwen and llama.cpp model directory')
assert.ok(!audio || stagedSpeech || downloadSpeech, 'audio verification requires speech weights')
const profile = await mkdtemp(join(tmpdir(), 'fasthelper-conversation-'))
let app

try {
  const plugin = join(profile, 'plugins', 'quick-search')
  await mkdir(plugin, { recursive: true })
  await Promise.all([
    copyFile(resolve('release/plugins/quick-search.fhplugin'), join(plugin, 'quick-search.fhplugin')),
    writeFile(join(profile, 'settings-v1.json'), JSON.stringify({
      version: 1, features: { 'quick-search': 'enabled' }, preferredModel: 'qwen35-0.8b',
      speechModel: stagedSpeech ? 'xasr-zh-en-480ms' : null, everythingEnabled: false,
      pluginToggles: { 'quick-search': { 'auto-open-unique-app': false } },
    })),
    ...['qwen35-0.8b', 'llama-cpp-b12606-win-x64'].map((name) =>
      cp(join(modelSource, name), join(profile, 'models', name), { recursive: true })),
    ...(stagedSpeech ? [cp(stagedSpeech, join(profile, 'speech', 'xasr-zh-en-480ms'), { recursive: true })] : []),
  ])

  app = await _electron.launch({
    args: [
      process.env.FASTHELPER_TEST_APP_ASAR ?? '.',
      ...(audio ? ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + audio + '%noloop'] : []),
    ],
    env: { ...process.env, FASTHELPER_TEST_PROFILE: profile },
  })
  const home = await app.firstWindow()
  home.setDefaultTimeout(15_000)
  await home.getByRole('heading', { name: '想做什么？' }).waitFor()
  const modelState = await home.evaluate(() => window.fasthelper.settings())
  assert.equal(modelState.speech.active, stagedSpeech ? 'xasr-zh-en-480ms' : null)
  if (downloadSpeech) {
    await home.getByRole('link', { name: '本地语音', exact: true }).click()
    const install = home.getByRole('button', { name: '下载并安装语音模型' })
    await install.click()
    await home.getByRole('button', { name: '取消下载' }).click()
    await install.waitFor()
    await install.click()
    await home.getByText('使用中', { exact: true }).waitFor({ timeout: 420_000 })
    await home.getByRole('link', { name: '对话', exact: true }).click()
    console.log('PASS optional voice model download, cancellation, integrity check and activation')
  }
  await app.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }))
  const input = home.getByRole('textbox', { name: '输入指令' })
  await input.fill('打开记事本')
  await home.getByText('· 预览', { exact: true }).waitFor()
  const preview = home.getByRole('list', { name: '搜索结果' })
  await preview.getByText(/记事本|Notepad/u).first().waitFor()
  assert.equal(await preview.getByRole('button').count(), 0)
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  assert.equal(await home.getByText('· 预览', { exact: true }).count(), 1)
  await input.dispatchEvent('compositionend')
  await input.press('Enter')
  await preview.getByRole('button', { name: /记事本|Notepad/u }).first().waitFor({ timeout: 45_000 })
  await input.fill('不要打开记事本')
  await input.press('Enter')
  await home.getByText(/没有找到适合这条指令/u).waitFor()
  assert.equal(await home.getByRole('list', { name: '搜索结果' }).count(), 0)
  console.log('PASS IME composition, read-only preview, high-confidence routing and no-match while offline')

  const dock = app.windows().find((page) => page.url().endsWith('#/launcher'))
  assert.ok(dock)
  const handle = dock.getByLabel('fasthelper 贴边入口')
  await handle.waitFor()
  assert.ok((await handle.boundingBox()).width < 25, 'the inactive surface exposes a narrow handle')
  await app.evaluate(({ BrowserWindow, screen }) => {
    const dock = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('#/launcher'))
    const rect = dock.getBounds()
    const original = screen.getCursorScreenPoint
    globalThis.restoreCursor = () => { screen.getCursorScreenPoint = original }
    screen.getCursorScreenPoint = () => ({ x: rect.x + rect.width - 3, y: rect.y + 7 })
  })
  const dockInput = dock.getByRole('textbox', { name: '输入指令' })
  await dockInput.waitFor()
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find((window) => window.webContents.getURL().endsWith('#/launcher')).isFocused()), false)
  await app.evaluate(({ screen }) => { screen.getCursorScreenPoint = () => ({ x: 0, y: 0 }) })
  await dockInput.waitFor({ state: 'hidden' })
  await app.evaluate(() => globalThis.restoreCursor())
  await home.getByRole('button', { name: '快捷面板' }).click()
  await dockInput.waitFor()
  await dockInput.fill('找项目周报')
  await dock.getByRole('button', { name: '收起' }).click()
  await dockInput.waitFor({ state: 'hidden' })
  await home.getByRole('button', { name: '快捷面板' }).click()
  assert.equal(await dockInput.inputValue(), '找项目周报')
  await dock.getByRole('button', { name: '收起' }).click()
  console.log('PASS hover, non-activating expansion, collapse and retained draft')

  if (audio) {
    await input.clear()
    await home.getByRole('button', { name: '开始语音输入' }).click()
    await home.getByText('正在聆听', { exact: true }).waitFor()
    await home.waitForFunction(() => document.querySelector('textarea')?.value?.includes('杀戮尖塔'), null, { timeout: 30_000 })
    await input.press('Enter')
    const suggestion = home.getByRole('list', { name: '插件候选' })
    const selectedPlugin = home.getByRole('region', { name: '插件结果' })
    await suggestion.or(selectedPlugin).first().waitFor({ timeout: 45_000 })
    if (await suggestion.isVisible()) await suggestion.getByRole('button', { name: /快速搜索/u }).click()
    await selectedPlugin.getByText('快速搜索', { exact: true }).waitFor()
    await home.getByRole('link', { name: '本地语音', exact: true }).click()
    await home.getByRole('button', { name: '停用', exact: true }).click()
    await home.getByRole('button', { name: '设为当前模型', exact: true }).waitFor()
    await home.getByRole('button', { name: '设为当前模型', exact: true }).click()
    await home.getByText('使用中', { exact: true }).waitFor()
    await home.getByRole('button', { name: '卸载模型', exact: true }).click()
    await home.getByRole('button', { name: '下载并安装语音模型' }).waitFor()
    console.log('PASS Chromium microphone, native ASR, editable transcript, offline plugin dispatch and model controls')
  }
} catch (error) {
  for (const page of app?.windows() ?? []) console.log(page.url(), await page.locator('body').innerText().catch(() => ''))
  throw error
} finally {
  await app?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 4 })
}
