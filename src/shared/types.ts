export type ProviderId = 'anthropic' | 'openai'
export type Theme = 'system' | 'light' | 'dark'

/** Generic capability tiers used for per-slot model dispatch. */
export type SlotModelAlias = 'haiku' | 'sonnet' | 'opus'
export const SLOT_MODEL_ALIASES: readonly SlotModelAlias[] = ['haiku', 'sonnet', 'opus']
/** Rank from cheapest/fastest to smartest. Used to enforce promote-only. */
export const SLOT_MODEL_RANK: Record<SlotModelAlias, number> = {
  haiku: 0,
  sonnet: 1,
  opus: 2
}
/** Canonical model id for each alias, per provider family. */
export const ANTHROPIC_MODEL_BY_ALIAS: Record<SlotModelAlias, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7'
}

export interface Turn {
  id: string
  createdAt: number
  prompt: string
  html: string
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
  /** Allow the orchestrator to promote individual slots to a smarter model. */
  useSlotDispatch: boolean
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
  usage?: UsageStats
}

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

/**
 * Model used for the orchestrator pass (skeleton design), independent of the
 * user's chosen default model. The orchestrator does structural layout work
 * that doesn't require deep reasoning; using the fastest model in the family
 * cuts skeleton-phase latency without meaningfully hurting layout quality.
 *
 * Fills still use the user's chosen model (and per-slot dispatch when enabled).
 */
export const ORCHESTRATOR_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5-mini'
}

export const DEFAULT_CONFIG: ProviderConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  theme: 'system',
  useSlotDispatch: false
}
