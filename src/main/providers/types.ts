import type { GenerateRequest, UsageStats } from '../../shared/types'

export interface GenerateOptions {
  signal?: AbortSignal
  onChunk?: (accumulatedText: string) => void
}

export interface ProviderResult {
  html: string
  usage?: UsageStats
}

export interface LLMProvider {
  id: string
  generate(req: GenerateRequest, apiKey: string, opts?: GenerateOptions): Promise<ProviderResult>
}
