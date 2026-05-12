import type {
  Conversation,
  GenerateRequest,
  GenerateResponse,
  ProviderConfig,
  ProviderId
} from '../../shared/types'

export interface RendreApi {
  getConfig: () => Promise<ProviderConfig>
  setConfig: (c: ProviderConfig) => Promise<void>
  getHistory: () => Promise<Conversation[]>
  setHistory: (c: Conversation[]) => Promise<void>
  hasKey: (p: ProviderId) => Promise<boolean>
  setKey: (p: ProviderId, k: string) => Promise<void>
  generate: (req: GenerateRequest) => Promise<GenerateResponse>
}

declare global {
  interface Window {
    rendre: RendreApi
  }
}

export {}
