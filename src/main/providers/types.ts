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

export interface LLMProvider {
  id: string
  generate(req: GenerateRequest, apiKey: string, opts?: GenerateOptions): Promise<ProviderResult>
  generatePreview?(req: GenerateRequest, apiKey: string, opts?: GenerateOptions): Promise<ProviderResult>
}
