import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readIntent } from '../src/shared/intent.ts'
import { confirmedOpenName, literalSearch, toFileSearch, validateSearchPlan } from '../src/shared/search-plan.ts'
import { classifyFile } from '../src/shared/file-results.ts'
import { SettingsStore } from '../src/main/settings.ts'
import { ConversationService, routeDecision } from '../src/main/conversation.ts'

test('routing competes with abstention even with a single installed plugin', () => {
  assert.deepEqual(routeDecision({ scores: [0.83], abstentionScore: 0.17 }, 1), { direct: 0, candidates: [] })
  assert.deepEqual(routeDecision({ scores: [0.65], abstentionScore: 0.35 }, 1), { candidates: [0] })
  assert.deepEqual(routeDecision({ scores: [0.4], abstentionScore: 0.6 }, 1), { candidates: [] })
  assert.deepEqual(routeDecision({ scores: [0.2, 0.37, 0.24, 0.08], abstentionScore: 0.11 }, 4), { candidates: [1, 2, 0] })
})

test('routing choices are scoped, consumed once, and rechecked before dispatch', async () => {
  let ids = ['search', 'notes', 'calc']
  const executed: string[] = []
  const router = new ConversationService(() => ids.map((id) => ({
    id, title: id, capability: { description: id, examples: [], preview: false },
    run: async (_session, text, stage) => {
      executed.push(id + ':' + stage + ':' + text)
      return { kind: 'empty' }
    },
  })), async () => ({ scores: [0.34, 0.28, 0.20], abstentionScore: 0.18 }), () => undefined)
  assert.equal((await router.input(1, '这次请求', 'preview')).kind, 'empty')
  assert.deepEqual(executed, [])
  const result = await router.input(1, '   这次请求   ', 'submit')
  assert.equal(result.kind, 'choices')
  assert.equal(result.choices.length, 3)
  assert.equal((await router.choose(2, result.choices[0].token)).kind, 'notice')
  await router.choose(1, result.choices[0].token)
  assert.equal((await router.choose(1, result.choices[0].token)).kind, 'notice')
  assert.deepEqual(executed, ['search:submit:这次请求'])
  const next = await router.input(1, '新请求', 'submit')
  assert.equal(next.kind, 'choices')
  ids = ids.filter((id) => id !== 'search')
  assert.equal((await router.choose(1, next.choices[0].token)).kind, 'notice')
  assert.equal(executed.length, 1)
})

test('obsolete routing requests cannot dispatch after input changes', async () => {
  const calls: string[] = []
  let complete!: (value: { scores: number[]; abstentionScore: number }) => void
  const router = new ConversationService(() => [{
    id: 'search', title: '搜索', capability: { description: '搜索', examples: [], preview: true },
    run: async (_session, text, stage) => { calls.push(stage + ':' + text); return { kind: 'empty' } },
  }], () => new Promise((resolve) => { complete = resolve }), () => undefined)
  const outdated = router.input(1, '第一条', 'submit')
  await router.input(1, '第二条', 'preview')
  complete({ scores: [0.99], abstentionScore: 0.01 })
  assert.equal((await outdated).kind, 'empty')
  assert.deepEqual(calls, ['preview:第二条'])
})

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
