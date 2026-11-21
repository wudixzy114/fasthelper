import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readIntent } from '../src/shared/intent.ts'
import { confirmedOpenName, literalSearch, toFileSearch, validateSearchPlan } from '../src/shared/search-plan.ts'
import { classifyFile } from '../src/shared/file-results.ts'
import { SettingsStore } from '../src/main/settings.ts'

test('opening an application requires an explicit affirmative command', () => {
  assert.deepEqual(readIntent('我想要打开计算器！'), { kind: 'open_app', query: '计算器', explicit: true })
  for (const text of ['不要打开计算器', '文章写着打开计算器', '打开计算器，顺便打开画图']) {
    assert.equal(readIntent(text).kind, 'search')
  }
})

test('file queries extract the previous local calendar week', () => {
  assert.deepEqual(readIntent('请帮我找上周的项目周报。'), {
    kind: 'find_file', query: '上周的项目周报', explicit: true,
  })
  const search = toFileSearch(literalSearch('找上周的项目周报'), new Date(2026, 10, 21, 15))
  assert.deepEqual(search.terms, ['项目周报'])
  assert.equal(search.after, new Date(2026, 10, 9).toISOString())
  assert.equal(search.before, new Date(2026, 10, 16).toISOString())
})

test('model aliases expand retrieval while opening is verified against the original name', () => {
  const plan = validateSearchPlan({ action: 'open_app', scope: 'apps', terms: ['杀戮尖塔', 'SlayTheSpire'] }, '打开杀戮尖塔')
  assert.ok(plan)
  assert.ok(plan.terms.includes('SlayTheSpire'))
  assert.equal(confirmedOpenName('打开杀戮尖塔', plan), '杀戮尖塔')
  for (const text of ['不要打开杀戮尖塔', '杀戮尖塔', '打开杀戮尖塔，顺便启动 Steam']) {
    assert.equal(confirmedOpenName(text, plan), undefined)
  }
  assert.equal(confirmedOpenName('打开杀戮尖塔', literalSearch('打开杀戮尖塔')), undefined)
  assert.equal(classifyFile('杀戮尖塔2血量修改器.exe'), 'helper')
})

test('file constraints must be well formed and grounded in the original request', () => {
  const original = '找 C:\\QA Docs 里昨天的 report PDF'
  const plan = { action: 'search', scope: 'files', terms: ['report'], directory: 'C:\\QA Docs', extension: 'pdf', modified: 'yesterday' }
  assert.ok(validateSearchPlan(plan, original))
  for (const changes of [{ extension: 'pdf;exe' }, { extension: 'exe' }, { directory: 'C:\\' + '..\\QA Docs' },
    { directory: 'D:\\QA Docs' }, { modified: 'today' }, { terms: [] }, { action: 'open_app' }]) {
    assert.equal(validateSearchPlan({ ...plan, ...changes }, original), null)
  }
})

test('features start uninstalled and concurrent changes survive the next session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fasthelper-unit-'))
  try {
    const filename = join(dir, 'settings.json')
    const store = new SettingsStore(filename)
    await store.load()
    assert.equal(store.firstRun, true)
    assert.deepEqual(store.snapshot(), { 'quick-search': 'available' })
    assert.equal(store.preferredModel(), null)
    assert.equal(store.pluginToggle('quick-search', 'auto-open-unique-app', true), true)
    await Promise.all([
      store.set('quick-search', 'enabled'),
      store.setPreferredModel('qwen35-4b'),
      store.setEverything(false),
      store.setPluginToggle('quick-search', 'auto-open-unique-app', false),
    ])
    const reopened = new SettingsStore(filename)
    await reopened.load()
    assert.equal(reopened.firstRun, false)
    assert.deepEqual(reopened.snapshot(), { 'quick-search': 'enabled' })
    assert.equal(reopened.everythingEnabled(), false)
    assert.equal(reopened.preferredModel(), 'qwen35-4b')
    assert.equal(reopened.pluginToggle('quick-search', 'auto-open-unique-app', true), false)
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
