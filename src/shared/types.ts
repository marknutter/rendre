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
  /**
   * Sticky preference: when true, subsequent prompts in this conversation
   * extend the current page (append a new region) instead of replacing it.
   * The `/add` prefix overrides this per-prompt without flipping state.
   */
  additiveMode?: boolean
  /**
   * Sticky preference: when true, the model may call the `generate_image` tool
   * during fills for this conversation. Per-prompt `/img` prefix overrides
   * without flipping the sticky state. Image gen is OFF by default — it's
   * expensive (~$0.04 DALL-E 3, ~$0.003 Flux Schnell) and slow (5-20s).
   */
  imageGenMode?: boolean
  /** Running total of generate_image costs (USD) across this conversation. */
  imageGenCostUsd?: number
}

export type ImageGenProvider = 'dall-e-3' | 'flux-schnell'
export const IMAGE_GEN_PROVIDERS: readonly ImageGenProvider[] = [
  'dall-e-3',
  'flux-schnell'
]

export interface ProviderConfig {
  provider: ProviderId
  model: string
  theme: Theme
  /** Allow the orchestrator to promote individual slots to a smarter model. */
  useSlotDispatch: boolean
  /**
   * When true, the model may call the `search_images` tool to inline web images
   * (Wikimedia Commons, optionally Brave when a key is configured). Default on —
   * Wikimedia works with no API key, so the feature is usable out of the box.
   */
  imageSearchEnabled: boolean
  /**
   * Which backend `generate_image` calls when offered to the model. DALL-E 3
   * reuses the existing OpenAI key; Flux Schnell needs a Replicate token.
   * Whether the tool is OFFERED is a per-conversation decision
   * (Conversation.imageGenMode), not a top-level config — image gen is opt-in.
   */
  imageGenProvider: ImageGenProvider
}

export interface GenerateRequest {
  prompt: string
  history: Turn[]
  provider: ProviderId
  model: string
  /**
   * When true, the orchestrator emits only a new region to append to the prior
   * turn's page (rather than designing a fresh page). Requires a non-empty
   * history; falls back to a fresh turn on the first prompt of a conversation.
   */
  isAdditive?: boolean
  /**
   * When true, slot fills may call the `generate_image` tool. Resolved at the
   * App layer from sticky `conversation.imageGenMode` OR a `/img` prefix on
   * this specific prompt.
   */
  isImageGen?: boolean
}

/**
 * Request to refill ONE slot in a prior turn with a new instruction. Triggered
 * by a click on a `[data-rendre-iterate]` button inside the rendered page; the
 * new content streams into the same DOM slot. A new conversation turn is
 * created from the refilled result so history stays immutable.
 */
export interface IterateSlotRequest {
  convId: string
  turnId: string
  slot: string
  instruction: string
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
  useSlotDispatch: false,
  imageSearchEnabled: true,
  imageGenProvider: 'dall-e-3'
}
