export type IntentKind = 'open_app' | 'find_file' | 'search'
export type Intent = { kind: IntentKind; query: string; explicit: boolean }

export function normalizeName(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function readIntent(text: string): Intent {
  const clean = text.normalize('NFKC').trim().replace(/[。！？!?]+$/u, '')
  const polite = /^(?:(?:你好|请|帮我|麻烦你|我想要|我想|能不能|可以)[\s，,]*)+/u
  const command = clean.replace(polite, '')
  const app = /^(?:打开|启动|运行)\s*(.+)$/u.exec(command)
  if (app && !/[，,。；;？！?！&|]/u.test(app[1])) {
    return { kind: 'open_app', query: app[1].trim(), explicit: true }
  }
  const file = /^(?:找到|找一下|查找|搜索|找)\s*(.+)$/u.exec(command)
  if (file) {
    return { kind: 'find_file', query: file[1].trim(), explicit: true }
  }
  return { kind: 'search', query: clean, explicit: false }
}

export type FileQuery = { name: string; after?: string; before?: string }

export function toFileQuery(query: string, now = new Date()): FileQuery {
  const name = query.replace(/^上周(?:的)?\s*/u, '').trim()
  if (name === query) return { name }

  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const previousMonday = new Date(monday)
  previousMonday.setDate(monday.getDate() - 7)
  return { name, after: previousMonday.toISOString(), before: monday.toISOString() }
}
