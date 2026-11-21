import assert from 'node:assert/strict'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron } from 'playwright-core'

const profile = await mkdtemp(join(tmpdir(), 'fasthelper-desktop-'))
const screenshots = resolve('release', 'verification')
const modelTest = process.env.FASTHELPER_TEST_MODEL
const localModel = process.env.FASTHELPER_TEST_LOCAL_MODEL
const everythingFixture = process.env.FASTHELPER_TEST_EVERYTHING
const testTransfer = process.env.FASTHELPER_TEST_TRANSFER === '1'
await mkdir(screenshots, { recursive: true })

let application
try {
  const legacy = join(profile, 'models', 'qwen3-0.6b-q8_0-b12606')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'model.gguf'), 'obsolete weight')
  await writeFile(join(profile, 'settings-v1.json'), JSON.stringify({
    version: 1, features: { apps: 'available', files: 'available' },
  }))
  if (localModel) {
    const models = join(profile, 'models')
    await Promise.all(['llama-cpp-b12606-win-x64', 'qwen35-0.8b'].map((name) =>
      cp(join(localModel, name), join(models, name), { recursive: true })))
  }
  const corpus = join(profile, 'search-fixture')
  const portableApp = join(corpus, 'fhsearchqa-portable.exe')
  const movedApp = join(corpus, 'fhsearchqa-renamed.exe')
  if (everythingFixture) {
    const root = join(profile, 'plugins', 'quick-search', 'everything')
    const portable = join(root, 'portable')
    const cli = join(root, 'cli')
    await Promise.all([mkdir(corpus), mkdir(portable, { recursive: true }), mkdir(cli, { recursive: true })])
    await Promise.all([
      copyFile(join(everythingFixture, 'everything.exe'), join(portable, 'everything.exe')),
      ...testTransfer ? [] : [copyFile(join(everythingFixture, 'es.exe'), join(cli, 'es.exe'))],
      writeFile(join(portable, 'Everything-fasthelper-quick-search.ini'), [
        '[Everything]', 'app_data=0', 'run_as_admin=0', 'service=0',
        'auto_include_fixed_volumes=0', 'auto_include_removable_volumes=0',
        `folders="${corpus.replaceAll('\\', '\\\\')}"`, 'folder_monitor_changes=1',
      ].join('\r\n')),
      ...['fhsearchqa-文档.txt', 'fhsearchqa-setup.exe', 'fhsearchqa-uninstall.exe',
        'fhsearchqa-helper.exe', 'fhsearchqa-portable.exe', 'SlayTheSpire.exe', 'SlayTheSpire2.exe',
        '杀戮尖塔2血量修改器.exe', 'fhsearchqa-today.pdf', 'fhsearchqa-stale.pdf'].map((name) => writeFile(join(corpus, name), 'fixture')),
    ])
    await utimes(join(corpus, 'fhsearchqa-stale.pdf'), new Date(2000, 0, 1), new Date(2000, 0, 1))
  }
  application = await _electron.launch({
    args: ['.'],
    env: { ...process.env, FASTHELPER_TEST_PROFILE: profile },
  })
  const settings = await application.firstWindow()
  const errors = []
  function watch(window) {
    window.on('pageerror', (error) => errors.push(error.message))
    window.setDefaultTimeout(12_000)
  }
  watch(settings)
  await settings.getByRole('heading', { name: '想做什么？', exact: true }).waitFor()
  await settings.getByRole('link', { name: '本地模型', exact: true }).click()
  if (!localModel) await settings.getByText('已移除旧版千问模型。请选择一档千问 3.5 权重。').waitFor()
  await assert.rejects(access(legacy), { code: 'ENOENT' })
  const light = settings.getByRole('tab', { name: /^0\.8B/u })
  const large = settings.getByRole('tab', { name: /^4B/u })
  await large.click()
  await settings.getByText('3.03 GB 权重').waitFor()
  await light.click()
  await settings.getByText('563 MB 权重').waitFor()
  if (localModel) assert.equal((await settings.evaluate(() => window.fasthelper.settings())).activeModel, 'qwen35-0.8b')
  else await settings.getByRole('button', { name: '下载并安装', exact: true }).waitFor()
  await settings.getByRole('link', { name: '功能管理', exact: true }).click()
  await settings.getByRole('button', { name: /快速搜索\s*导入插件/u }).waitFor()
  await settings.screenshot({ path: join(screenshots, 'settings.png') })
  console.log('PASS old Qwen package removal and Qwen3.5 weight selection')

  await application.evaluate(({ dialog }, packagePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [packagePath] })
  }, resolve('release', 'plugins', 'quick-search.fhplugin'))
  await settings.getByRole('button', { name: /快速搜索\s*导入插件/u }).click()
  const appToggle = settings.getByRole('switch', { name: '启用快速搜索' })
  await appToggle.waitFor()
  assert.equal(await appToggle.getAttribute('aria-checked'), 'true')
  await appToggle.click()
  await settings.locator('[aria-label="启用快速搜索"][aria-checked="false"]').waitFor()
  await appToggle.click()
  await settings.locator('[aria-label="启用快速搜索"][aria-checked="true"]').waitFor()
  await settings.getByRole('link', { name: '功能管理', exact: true }).click()
  assert.equal(await settings.locator('.feature').count(), 1)
  assert.equal(await settings.getByRole('switch', { name: /启用 Everything/u }).count(), 0)
  await settings.evaluate(() => {
    window.testEverythingStages = []
    window.fasthelper.onSettings((snapshot) => {
      const state = snapshot.plugins[0]?.services.everything
      if (state) window.testEverythingStages.push({ status: state.status, progress: state.progress })
    })
  })
  await settings.getByRole('link', { name: '打开', exact: true }).click()
  await settings.getByRole('heading', { name: '快速搜索', exact: true }).waitFor()
  const searchTab = settings.getByRole('tab', { name: '搜索', exact: true })
  const settingsTab = settings.getByRole('tab', { name: '设置', exact: true })
  await settingsTab.click()
  const engine = settings.getByRole('switch', { name: /启用 Everything/u })
  assert.equal(await engine.getAttribute('aria-checked'), 'true')
  const autoOpen = settings.getByRole('switch', { name: '自动打开唯一应用' })
  assert.equal(await autoOpen.getAttribute('aria-checked'), 'true')
  await autoOpen.click()
  await settings.locator('[aria-label="自动打开唯一应用"][aria-checked="false"]').waitFor()
  if (everythingFixture) {
    await settings.waitForFunction(() =>
      window.testEverythingStages.some(({ status }) => status === 'ready'), undefined, { timeout: 45_000 })
    await settings.screenshot({ path: join(screenshots, 'plugin-settings.png') })
    if (testTransfer) {
      const stages = await settings.evaluate(() => window.testEverythingStages)
      assert.ok(stages.some(({ status, progress }) => status === 'connecting' && progress.transferred === 0))
      assert.ok(stages.some(({ status, progress }) => status === 'downloading' && progress.total === 117393 && progress.transferred === 117393))
      assert.ok(stages.some(({ status }) => status === 'verifying'))
      console.log('PASS per-component byte progress and passive index readiness')
    }
  } else {
    await engine.click()
    await settings.getByText('已关闭', { exact: true }).waitFor()
  }
  await searchTab.click()
  console.log('PASS independent plugin install, one management row and plugin tabs')

  const mainInput = settings.getByRole('textbox', { name: '搜索或输入指令' })
  await mainInput.fill(everythingFixture ? '找fhsearchqa' : '计算器')
  if (everythingFixture) {
    await settings.getByText('fhsearchqa-文档.txt', { exact: true }).waitFor()
    await settings.getByText('本次搜索 · Everything', { exact: true }).waitFor()
  } else await settings.getByRole('list', { name: '搜索结果' }).getByText(/Calculator|计算器/iu).first().waitFor()
  await settingsTab.click()
  await searchTab.click()
  assert.equal(await mainInput.inputValue(), everythingFixture ? '找fhsearchqa' : '计算器')
  await settings.screenshot({ path: join(screenshots, 'plugin-search.png') })

  await settings.getByRole('button', { name: '快捷面板', exact: true }).click()
  const launcher = application.windows().find((window) => window.url().endsWith('#/launcher'))
  assert.ok(launcher)
  watch(launcher)
  const input = launcher.getByRole('textbox', { name: '输入指令' })
  await input.fill('计算器')
  await launcher.getByRole('list', { name: '搜索结果' }).getByText(/Calculator|计算器/iu).first().waitFor()
  await launcher.screenshot({ path: join(screenshots, 'launcher.png') })
  console.log('PASS application catalog search on Windows')

  if (localModel && everythingFixture) {
    await application.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }))
    await mainInput.fill('打开杀戮尖塔')
    await settings.getByText('杀戮尖塔2血量修改器.exe', { exact: true }).waitFor()
    assert.equal(await settings.getByText('SlayTheSpire.exe', { exact: true }).count(), 0)
    await mainInput.press('Enter')
    await settings.getByText('SlayTheSpire.exe', { exact: true }).waitFor({ timeout: 55_000 })
    await settings.getByText('SlayTheSpire2.exe', { exact: true }).waitFor()
    await settings.getByText('辅助程序', { exact: true }).waitFor()
    await settings.locator('.match-mark').first().waitFor()
    assert.equal(await settings.getByText(/^已打开 /u).count(), 0)
    await mainInput.fill('找今天修改的 fhsearchqa PDF')
    await mainInput.press('Enter')
    await settings.getByText('fhsearchqa-today.pdf', { exact: true }).waitFor()
    assert.equal(await settings.getByText('fhsearchqa-stale.pdf', { exact: true }).count(), 0)
    assert.equal(await settings.getByText('fhsearchqa-文档.txt', { exact: true }).count(), 0)
    await mainInput.fill('打开计算器')
    await mainInput.press('Enter')
    await settings.getByRole('list', { name: '搜索结果' }).getByText(/Calculator|计算器/iu).first().waitFor()
    assert.equal(await settings.getByText(/^已打开 /u).count(), 0)
    console.log('PASS offline Qwen search planning, SemIf ranking and disabled auto-open')
    await application.evaluate(({ session }) => session.defaultSession.disableNetworkEmulation())
  }

  if (everythingFixture) {
    await mainInput.fill('找fhsearchqa')
    for (const name of ['安装器', '卸载器', '辅助程序', '便携程序']) {
      await settings.getByText(name, { exact: true }).waitFor()
    }
    await settings.getByRole('button', { name: '添加为应用' }).click()
    await settings.getByText('已添加为应用。').waitFor()
    await settingsTab.click()
    const saved = settings.getByRole('region', { name: '已添加应用' })
    await saved.getByText('fhsearchqa-portable', { exact: true }).waitFor()
    await saved.getByRole('button', { name: '编辑别名' }).click()
    await saved.getByRole('textbox', { name: '应用别名（每行一个）' }).fill('测试便携应用')
    await saved.getByRole('button', { name: '保存别名' }).click()
    await saved.getByText('别名 · 测试便携应用').waitFor()
    await autoOpen.click()
    await settings.locator('[aria-label="自动打开唯一应用"][aria-checked="true"]').waitFor()
    await searchTab.click()
    if (localModel) {
      await mainInput.fill('打开杀戮尖塔2')
      await mainInput.press('Enter')
      await settings.getByText('SlayTheSpire2.exe', { exact: true }).waitFor()
      assert.equal(await settings.getByText('SlayTheSpire.exe', { exact: true }).count(), 0)
      assert.equal(await settings.getByText(/^已打开 /u).count(), 0)
      assert.equal(await settings.getByText('Windows 无法打开该目标。').count(), 0)
      console.log('PASS model-only aliases display even a unique portable app')
    }
    await rm(portableApp)
    await writeFile(movedApp, 'moved fixture')
    await mainInput.fill('测试便携应用')
    await settings.getByText(/路径已失效/u).waitFor()
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, movedApp)
    await settings.getByRole('button', { name: '重新定位' }).click()
    await settings.getByText('应用位置已更新。').waitFor()
    await settings.getByRole('button', { name: '移除', exact: true }).click()
    await settings.getByText('已移除应用条目。').waitFor()
    await access(movedApp)
    console.log('PASS independent window tokens, result provenance and moved portable app recovery')
  }

  if (process.env.FASTHELPER_TEST_LAUNCH === '1') {
    assert.ok(localModel && everythingFixture, 'launch verification requires a local model and ready file index')
    await mainInput.fill('打开计算器')
    await mainInput.press('Enter')
    await settings.getByText(/^已打开 (计算器|Calculator)/u).waitFor()
    const deadline = Date.now() + 12_000
    while (true) {
      const processes = execFileSync('tasklist.exe', ['/NH', '/FI', 'IMAGENAME eq CalculatorApp.exe'], { encoding: 'utf8' })
      if (processes.includes('CalculatorApp.exe')) break
      assert.ok(Date.now() < deadline, 'Windows should start Calculator')
      await new Promise((res) => setTimeout(res, 300))
    }
    console.log('PASS explicit unique command starts Windows Calculator')
  }
  await launcher.getByRole('button', { name: '收起' }).click()

  await settings.getByRole('link', { name: '功能管理', exact: true }).click()
  await settings.getByRole('button', { name: '移除快速搜索' }).click()
  await settings.getByRole('dialog').getByRole('button', { name: '移除', exact: true }).click()
  await settings.getByRole('button', { name: /快速搜索\s*导入插件/u }).waitFor()
  console.log('PASS feature removal')

  if (modelTest === '1' || modelTest === 'all') {
    await settings.getByRole('link', { name: '本地模型', exact: true }).click()
    const language = settings.getByRole('region', { name: 'SemIf + Qwen3.5' })
    const download = language.getByRole('button', { name: '下载并安装', exact: true })
    await download.click()
    await language.getByRole('progressbar').waitFor()
    await language.getByRole('button', { name: '取消安装' }).click()
    await download.waitFor()
    console.log('PASS download cancellation')
    await download.click()
    const current = language.getByText('当前模型', { exact: true })
    const installError = language.locator('.model-error')
    await current.or(installError).waitFor({ timeout: 240_000 })
    assert.equal(await installError.count(), 0, await installError.allTextContents())
    console.log('PASS 0.8B download and SHA-256 verification')
    async function checkOfflineScores() {
      await application.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }))
      try {
        await language.getByRole('button', { name: '测试模型' }).click()
        const testResult = language.locator('.model-success, .model-error')
        await testResult.waitFor({ timeout: 95_000 })
        assert.match(await testResult.innerText(), /测试通过/u)
      } finally {
        await application.evaluate(({ session }) => session.defaultSession.disableNetworkEmulation())
      }
    }
    await checkOfflineScores()
    console.log('PASS 0.8B local SemIf scores with app networking offline')
    await settings.screenshot({ path: join(screenshots, 'model-installed.png') })
    async function removeWeight() {
      await language.getByRole('button', { name: '移除本地模型' }).click()
      await settings.getByRole('dialog').getByRole('button', { name: '移除', exact: true }).click()
      await download.waitFor()
    }
    if (modelTest === 'all') {
      await large.click()
      await download.click()
      const activate = language.getByRole('button', { name: '设为当前模型' })
      await activate.or(installError).waitFor({ timeout: 480_000 })
      assert.equal(await installError.count(), 0, await installError.allTextContents())
      assert.equal((await settings.evaluate(() => window.fasthelper.settings())).activeModel, 'qwen35-0.8b')
      await activate.click()
      await current.waitFor()
      assert.equal(JSON.parse(await readFile(join(profile, 'settings-v1.json'), 'utf8')).preferredModel, 'qwen35-4b')
      await checkOfflineScores()
      console.log('PASS 4B installation, persisted selection and offline SemIf scores')
      await removeWeight()
      assert.equal((await settings.evaluate(() => window.fasthelper.settings())).activeModel, 'qwen35-0.8b')
      await light.click()
      await current.waitFor()
      console.log('PASS removing active 4B falls back to installed 0.8B')
    }
    await removeWeight()
    await download.waitFor()
    console.log('PASS model removal stops inference and clears the installation')
  }
  assert.deepEqual(errors, [])
} catch (error) {
  for (const page of application?.windows() ?? []) {
    console.log(await page.locator('body').innerText().catch(() => '无法读取测试窗口。'))
  }
  throw error
} finally {
  await application?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 4 })
}
