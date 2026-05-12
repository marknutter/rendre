import type { LLMProvider } from './types'
import { anthropicProvider } from './anthropic'
import { openaiProvider } from './openai'
import type { ProviderId } from '../../shared/types'

const providers: Record<ProviderId, LLMProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider
}

export function getProvider(id: ProviderId): LLMProvider {
  return providers[id]
}
