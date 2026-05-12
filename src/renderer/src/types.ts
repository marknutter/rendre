import type {
  Conversation,
  GenerateRequest,
  GenerateResponse,
  ProviderConfig,
  ProviderId,
  ToolUseEvent
} from '../../shared/types'

export interface RendreApi {
  getConfig: () => Promise<ProviderConfig>
  setConfig: (c: ProviderConfig) => Promise<void>
  getHistory: () => Promise<Conversation[]>
  setHistory: (c: Conversation[]) => Promise<void>
  hasKey: (p: ProviderId) => Promise<boolean>
  setKey: (p: ProviderId, k: string) => Promise<void>

  startGenerate: (req: GenerateRequest) => Promise<string>
  cancelGenerate: (id: string) => Promise<void>
  onStreamUrl: (cb: (id: string, url: string) => void) => () => void
  onDone: (cb: (id: string, result: GenerateResponse) => void) => () => void
  onError: (cb: (id: string, msg: string) => void) => () => void
  onTool: (cb: (id: string, event: ToolUseEvent) => void) => () => void
}

declare global {
  interface Window {
    rendre: RendreApi
  }
}

export {}
