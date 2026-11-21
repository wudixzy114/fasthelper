import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readIntent, toFileQuery } from '../src/shared/intent.ts'
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
  assert.deepEqual(toFileQuery('上周的项目周报', new Date(2026, 10, 21, 15)), {
    name: '项目周报',
    after: new Date(2026, 10, 9).toISOString(),
    before: new Date(2026, 10, 16).toISOString(),
  })
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
    await Promise.all([
      store.set('quick-search', 'enabled'),
      store.setPreferredModel('qwen35-4b'),
      store.setEverything(false),
    ])
    const reopened = new SettingsStore(filename)
    await reopened.load()
    assert.equal(reopened.firstRun, false)
    assert.deepEqual(reopened.snapshot(), { 'quick-search': 'enabled' })
    assert.equal(reopened.everythingEnabled(), false)
    assert.equal(reopened.preferredModel(), 'qwen35-4b')
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
