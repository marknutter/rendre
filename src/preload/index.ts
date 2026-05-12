import { contextBridge, ipcRenderer } from 'electron'
import type {
  Conversation,
  GenerateRequest,
  GenerateResponse,
  ProviderConfig,
  ProviderId
} from '../shared/types'

const api = {
  getConfig: (): Promise<ProviderConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (c: ProviderConfig): Promise<void> => ipcRenderer.invoke('config:set', c),

  getHistory: (): Promise<Conversation[]> => ipcRenderer.invoke('history:get'),
  setHistory: (c: Conversation[]): Promise<void> => ipcRenderer.invoke('history:set', c),

  hasKey: (p: ProviderId): Promise<boolean> => ipcRenderer.invoke('keys:has', p),
  setKey: (p: ProviderId, k: string): Promise<void> =>
    ipcRenderer.invoke('keys:set', p, k),

  generate: (req: GenerateRequest): Promise<GenerateResponse> =>
    ipcRenderer.invoke('llm:generate', req)
}

contextBridge.exposeInMainWorld('rendre', api)

export type RendreApi = typeof api
