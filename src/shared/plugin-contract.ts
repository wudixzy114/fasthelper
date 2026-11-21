import type { Intent } from './intent'
import type { PluginServiceAction, PluginServiceState, SearchResult, SearchSource } from './contracts'

export const searchPluginId = 'quick-search'
export const pluginApiVersion = 2

export type Candidate = Omit<SearchResult, 'id' | 'match' | 'missing' | 'savedId'> & {
  target: string
  launch?: 'aumid' | 'path'
  exact?: boolean
}
export type PluginResult = { candidates: Candidate[]; sources: SearchSource[]; fallbackReason?: string }
export type WorkerRequest =
  | { id: number; method: 'warm' | 'shutdown' }
  | { id: number; method: 'search'; intent: Intent; everything: boolean }
  | { id: number; method: 'cancel'; queryId: number }
  | { id: number; method: 'service'; service: string; action: PluginServiceAction }
export type WorkerReply =
  | { event: 'service'; service: string; state: PluginServiceState }
  | { id: number; ok: true; value?: PluginResult }
  | { id: number; ok: false; message: string }
