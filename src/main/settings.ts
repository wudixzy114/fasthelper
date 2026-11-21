import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { modelOptions, type FeatureId, type FeatureStates, type FeatureStatus, type ModelId, type SavedApplication } from '../shared/contracts.ts'

const defaults: FeatureStates = { 'quick-search': 'available' }
const schemaVersion = 1
type Preferences = {
  features: FeatureStates
  preferredModel: ModelId | null
  everythingEnabled: boolean
  savedApplications: SavedApplication[]
}

export function isFeatureStatus(value: unknown): value is FeatureStatus {
  return value === 'available' || value === 'enabled' || value === 'disabled'
}

export class SettingsStore {
  private preferences: Preferences = { features: { ...defaults }, preferredModel: null, everythingEnabled: true, savedApplications: [] }
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
      }
      this.preferences.preferredModel = modelOptions.find((model) => model.id === parsed.preferredModel)?.id ?? null
      this.preferences.everythingEnabled = parsed.everythingEnabled !== false
      if (Array.isArray(parsed.savedApplications)) {
        this.preferences.savedApplications = parsed.savedApplications.filter((entry: unknown): entry is SavedApplication => {
          const item = entry as Partial<SavedApplication> | null
          return !!item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string'
        })
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
