import type { SearchResponse } from './contracts'

export const maxCommandLength = 250

export type PluginCapability = {
  description: string
  examples: string[]
  preview: boolean
}

export type ConversationChoice = { token: string; title: string; description: string }
export type ConversationResponse =
  | { kind: 'empty' }
  | { kind: 'notice'; message: string }
  | { kind: 'choices'; message: string; choices: ConversationChoice[] }
  | { kind: 'search'; title: string; preview: boolean; response: SearchResponse }
