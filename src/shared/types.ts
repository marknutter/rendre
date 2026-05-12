export type ProviderId = 'anthropic' | 'openai'

export interface Turn {
  id: string
  createdAt: number
  prompt: string
  html: string
  provider: ProviderId
  model: string
}

export interface Conversation {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  turns: Turn[]
}

export interface ProviderConfig {
  provider: ProviderId
  model: string
}

export interface GenerateRequest {
  prompt: string
  history: Turn[]
  provider: ProviderId
  model: string
}

export interface GenerateResponse {
  html: string
}

export const ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
] as const

export const OPENAI_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-4o'] as const

export const DEFAULT_CONFIG: ProviderConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6'
}
