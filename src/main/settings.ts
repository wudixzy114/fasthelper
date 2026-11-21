import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { modelOptions, type FeatureId, type FeatureStates, type FeatureStatus, type ModelId, type SavedApplication } from '../shared/contracts.ts'
import { searchTerms } from '../shared/search-plan.ts'
import { speechOptions, type SpeechModelId } from '../shared/speech.ts'

const defaults: FeatureStates = { 'quick-search': 'available' }
const schemaVersion = 1
type Preferences = {
  features: FeatureStates
  preferredModel: ModelId | null
  speechModel: SpeechModelId | null
  everythingEnabled: boolean
  pluginToggles: Partial<Record<FeatureId, Record<string, boolean>>>
  savedApplications: SavedApplication[]
}

export function isFeatureStatus(value: unknown): value is FeatureStatus {
  return value === 'available' || value === 'enabled' || value === 'disabled'
}

export class SettingsStore {
  private preferences: Preferences = {
    features: { ...defaults }, preferredModel: null, speechModel: null, everythingEnabled: true, pluginToggles: {}, savedApplications: [],
  }
  private pending: Promise<void> = Promise.resolve()
  firstRun = false

  constructor(private readonly filename: string) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.firstRun = true
      await this.save(this.preferences)
      return
    }

    try {
      const parsed = JSON.parse(raw)
      if (parsed?.version !== schemaVersion) return
      for (const id of Object.keys(defaults) as FeatureId[]) {
        const value: unknown = parsed.features?.[id]
        if (isFeatureStatus(value)) this.preferences.features[id] = value
        const toggles = parsed.pluginToggles?.[id]
        if (toggles && typeof toggles === 'object') {
          this.preferences.pluginToggles[id] = Object.fromEntries(Object.entries(toggles).filter(([key, enabled]) =>
            /^[a-z][a-z0-9-]{0,31}$/u.test(key) && typeof enabled === 'boolean')) as Record<string, boolean>
        }
      }
      this.preferences.preferredModel = modelOptions.find((model) => model.id === parsed.preferredModel)?.id ?? null
      this.preferences.speechModel = speechOptions.find((model) => model.id === parsed.speechModel)?.id ?? null
      this.preferences.everythingEnabled = parsed.everythingEnabled !== false
      if (Array.isArray(parsed.savedApplications)) {
        this.preferences.savedApplications = (parsed.savedApplications as unknown[]).filter((entry): entry is SavedApplication => {
          const item = entry as Partial<SavedApplication> | null
          return !!item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string'
        }).map(({ id, name, path, aliases }) => ({
          id, name, path, aliases: sanitizeAliases(aliases) ?? [],
        }))
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      await rename(this.filename, `${this.filename}.damaged-${randomUUID()}`)
      this.firstRun = true
      await this.save(this.preferences)
    }
  }

  snapshot(): FeatureStates {
    return { ...this.preferences.features }
  }

  preferredModel(): ModelId | null {
    return this.preferences.preferredModel
  }

  speechModel(): SpeechModelId | null { return this.preferences.speechModel }

  setSpeechModel(id: SpeechModelId | null): Promise<void> {
    return this.update((preferences) => ({ ...preferences, speechModel: id }))
  }

  set(id: FeatureId, status: FeatureStatus): Promise<void> {
    return this.update((preferences) => ({ ...preferences, features: { ...preferences.features, [id]: status } }))
  }

  setPreferredModel(id: ModelId | null): Promise<void> {
    return this.update((preferences) => ({ ...preferences, preferredModel: id }))
  }

  everythingEnabled(): boolean { return this.preferences.everythingEnabled }

  setEverything(enabled: boolean): Promise<void> {
    return this.update((preferences) => ({ ...preferences, everythingEnabled: enabled }))
  }

  pluginToggle(id: FeatureId, key: string, defaultValue: boolean): boolean {
    return this.preferences.pluginToggles[id]?.[key] ?? defaultValue
  }

  setPluginToggle(id: FeatureId, key: string, enabled: boolean): Promise<void> {
    return this.update((preferences) => ({
      ...preferences,
      pluginToggles: { ...preferences.pluginToggles, [id]: { ...preferences.pluginToggles[id], [key]: enabled } },
    }))
  }

  savedApplications(): SavedApplication[] { return this.preferences.savedApplications.slice() }

  saveApplication(app: SavedApplication): Promise<void> {
    return this.update((preferences) => ({
      ...preferences,
      savedApplications: [...preferences.savedApplications.filter(({ id }) => id !== app.id), app],
    }))
  }

  removeApplication(id: string): Promise<void> {
    return this.update((preferences) => ({
      ...preferences, savedApplications: preferences.savedApplications.filter((app) => app.id !== id),
    }))
  }

  updateApplication(id: string, changes: Pick<SavedApplication, 'aliases'> | Pick<SavedApplication, 'path'>): Promise<void> {
    return this.update((preferences) => ({
      ...preferences, savedApplications: preferences.savedApplications.map((app) => app.id === id ? { ...app, ...changes } : app),
    }))
  }

  private update(change: (preferences: Preferences) => Preferences): Promise<void> {
    const update = this.pending.then(async () => {
      const next = change(this.preferences)
      await this.save(next)
      this.preferences = next
    })
    this.pending = update.catch(() => undefined)
    return update
  }

  private async save(preferences: Preferences): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: schemaVersion, ...preferences }), { flush: true })
      await rename(temporary, this.filename)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

export function sanitizeAliases(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10
    || !value.every((alias) => typeof alias === 'string' && alias.length <= 80 && !/[\u0000-\u001f]/u.test(alias))) return null
  return searchTerms(value, 10)
}
