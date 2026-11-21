import { win32 } from 'node:path'
import { normalizeName, readIntent } from './intent.ts'

const periods = ['today', 'yesterday', 'this_week', 'last_week'] as const
type Period = (typeof periods)[number]
export type SearchStage = 'preview' | 'submit'
export type SearchPlan = {
  action: 'search' | 'open_app' | 'clarify'
  scope: 'apps' | 'files' | 'all'
  terms: string[]
  extension?: string
  directory?: string
  modified?: Period
}
export type FileSearch = {
  terms: string[]
  extension?: string
  directory?: string
  after?: string
  before?: string
  applicationsOnly: boolean
}

export function searchTerms(values: readonly string[], limit = 3): string[] {
  const distinct = new Map<string, string>()
  for (const value of values) {
    const term = value.trim()
    const key = normalizeName(term)
    if (key && !distinct.has(key)) distinct.set(key, term)
  }
  return [...distinct.values()].slice(0, limit)
}

export function validateSearchPlan(value: unknown, original: string): SearchPlan | null {
  if (!value || typeof value !== 'object') return null
  const { action, scope, terms, extension, directory, modified } = value as Record<string, unknown>
  if (!['search', 'open_app', 'clarify'].some((item) => item === action)
    || !['apps', 'files', 'all'].some((item) => item === scope)
    || !Array.isArray(terms) || terms.length > 3
    || !terms.every((term) => typeof term === 'string' && term.length <= 120 && !/[\u0000-\u001f]/u.test(term))
    || (action === 'open_app' && scope !== 'apps')) return null

  const plan: SearchPlan = { action: action as SearchPlan['action'], scope: scope as SearchPlan['scope'], terms: searchTerms(terms) }
  if (action === 'clarify') return { action, scope: plan.scope, terms: [] }
  if (!plan.terms.length) return null
  const raw = normalizeName(original)
  if (extension != null) {
    if (typeof extension !== 'string' || !/^\.?[a-z0-9]{1,10}$/iu.test(extension)) return null
    const ext = extension.replace(/^\./u, '').toLowerCase()
    if (!raw.split(/[^a-z0-9]+/u).includes(ext)) return null
    plan.extension = ext
  }
  if (directory != null) {
    if (typeof directory !== 'string' || directory.length > 240 || !/^[a-z]:[\\/][^:\u0000-\u001f"*?<>|]*$/iu.test(directory)
      || directory.split(/[\\/]/u).some((part) => part === '..' || part === '.')
      || !raw.replaceAll('/', '\\').includes(normalizeName(directory).replaceAll('/', '\\'))) return null
    plan.directory = win32.normalize(directory)
  }
  if (modified != null) {
    const mentions: Record<Period, RegExp> = {
      today: /今天|\btoday\b/iu, yesterday: /昨天|\byesterday\b/iu,
      this_week: /本周|这周|\bthis week\b/iu, last_week: /上周|\blast week\b/iu,
    }
    const period = periods.find((item) => item === modified)
    if (!period || !mentions[period].test(original)) return null
    plan.modified = period
  }
  return plan
}

export function literalSearch(text: string): SearchPlan {
  const intent = readIntent(text)
  const modified = intent.kind === 'find_file' && /^上周(?:的)?\s*/u.test(intent.query) ? 'last_week' : undefined
  const term = modified ? intent.query.replace(/^上周(?:的)?\s*/u, '') : intent.query
  return {
    action: 'search',
    scope: intent.kind === 'open_app' ? 'apps' : intent.kind === 'find_file' ? 'files' : 'all',
    terms: searchTerms([term]),
    modified,
  }
}

export function toFileSearch(plan: SearchPlan, now = new Date()): FileSearch {
  const query: FileSearch = {
    terms: plan.terms, extension: plan.extension, directory: plan.directory, applicationsOnly: plan.scope === 'apps',
  }
  if (!plan.modified) return query
  const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const week = plan.modified === 'this_week' || plan.modified === 'last_week'
  if (week) begin.setDate(begin.getDate() - ((begin.getDay() + 6) % 7))
  if (plan.modified === 'last_week') begin.setDate(begin.getDate() - 7)
  if (plan.modified === 'yesterday') begin.setDate(begin.getDate() - 1)
  const end = new Date(begin)
  end.setDate(end.getDate() + (week ? 7 : 1))
  return { ...query, after: begin.toISOString(), before: end.toISOString() }
}

export function confirmedOpenName(text: string, plan: SearchPlan): string | undefined {
  if (plan.action !== 'open_app' || plan.scope !== 'apps' || plan.extension || plan.modified || plan.directory) return
  const intent = readIntent(text)
  if (intent.kind === 'open_app' && intent.explicit && normalizeName(intent.query)) return intent.query
}
