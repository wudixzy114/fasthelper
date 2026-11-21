import type { SearchPlan } from './search-plan'
import type { PluginServiceAction, PluginServiceState, SearchResult, SearchSource } from './contracts'

export const searchPluginId = 'quick-search'
export const pluginApiVersion = 3
export const autoOpenPreference = 'auto-open-unique-app'

export type Candidate = Omit<SearchResult, 'id' | 'match' | 'missing' | 'savedId'> & {
  target: string
  launch?: 'aumid' | 'path'
  verifiedName?: boolean
}
export type PluginResult = { candidates: Candidate[]; sources: SearchSource[]; complete: boolean; fallbackReason?: string }
export type WorkerRequest =
  | { id: number; method: 'warm' | 'shutdown' }
  | { id: number; method: 'search'; plan: SearchPlan; verificationName?: string; everything: boolean }
  | { id: number; method: 'cancel'; queryId: number }
  | { id: number; method: 'service'; service: string; action: PluginServiceAction }
export type WorkerReply =
  | { event: 'service'; service: string; state: PluginServiceState }
  | { id: number; ok: true; value?: PluginResult }
  | { id: number; ok: false; message: string }
