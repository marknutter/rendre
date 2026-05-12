export type ProviderId = 'anthropic' | 'openai'
export type Theme = 'system' | 'light' | 'dark'

export interface Turn {
  id: string
  createdAt: number
  prompt: string
  html: string
  previewHtml?: string
  provider: ProviderId
  model: string
  usage?: UsageStats
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
  theme: Theme
}

export interface GenerateRequest {
  prompt: string
  history: Turn[]
  provider: ProviderId
  model: string
}

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface GenerateResponse {
  html: string
  previewHtml?: string
  usage?: UsageStats
}

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export interface ToolUseEvent {
  type: 'start' | 'done' | 'error'
  tool: string
  input?: unknown
  error?: string
}

export const ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
] as const

export const OPENAI_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-4o'] as const

export const DEFAULT_CONFIG: ProviderConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  theme: 'system'
}
