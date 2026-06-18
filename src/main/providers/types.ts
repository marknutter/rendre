import type { GenerateRequest, ToolUseEvent, UsageStats } from '../../shared/types'

export type { ToolUseEvent } from '../../shared/types'

export interface GenerateOptions {
  signal?: AbortSignal
  onChunk?: (accumulatedText: string) => void
  onTool?: (event: ToolUseEvent) => void
  /**
   * When true, the model is offered the `search_images` tool. Default false
   * (call sites in main/index.ts opt in based on ProviderConfig.imageSearchEnabled).
   */
  imageSearchEnabled?: boolean
  /**
   * When true, the model is offered the `generate_image` tool. Requires
   * imageGenProvider to be set so the tool knows which backend to call.
   */
  imageGenEnabled?: boolean
  imageGenProvider?: 'dall-e-3' | 'flux-schnell'
  /**
   * When true, the conversation is in forced-image-gen mode: the orchestrator
   * MUST declare image slots for visual subjects, the fill MUST use
   * generate_image for any visual content (search_images is removed from its
   * tool list), and SVG/emoji portraits are banned. Set when the user clicked
   * the 🎨 toggle or used /img — the runtime treats this as an opt-in to spend
   * money on every image in the response.
   */
  imageGenForceMode?: boolean
}

export interface ProviderResult {
  html: string
  usage?: UsageStats
}

export interface SlotFillRequest {
  /** The user's original prompt (the question being answered). */
  prompt: string
  /** Prior turns in this conversation (for context). */
  history: GenerateRequest['history']
  /** Provider/model selection. */
  provider: GenerateRequest['provider']
  model: GenerateRequest['model']
  /** The complete skeleton HTML the orchestrator emitted in this turn. */
  skeleton: string
  /** The slot being filled — its data-slot name. */
  slotName: string
  /** The slot's data-slot-hint description. */
  slotHint: string
}

export interface SlotFillResult {
  /** Final concatenated inner HTML for the slot. */
  html: string
  usage?: UsageStats
}

export interface LLMProvider {
  id: string
  /** Orchestrator pass — emits the page skeleton with empty [data-slot] elements. */
  generate(req: GenerateRequest, apiKey: string, opts?: GenerateOptions): Promise<ProviderResult>
  /** Fill pass — emits the inner HTML for a single slot. */
  generateSlotFill(
    req: SlotFillRequest,
    apiKey: string,
    opts?: GenerateOptions
  ): Promise<SlotFillResult>
}
