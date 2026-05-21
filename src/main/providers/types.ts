import type { GenerateRequest, ToolUseEvent, UsageStats } from '../../shared/types'

export type { ToolUseEvent } from '../../shared/types'

export interface GenerateOptions {
  signal?: AbortSignal
  onChunk?: (accumulatedText: string) => void
  onTool?: (event: ToolUseEvent) => void
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
