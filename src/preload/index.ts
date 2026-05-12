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

  startGenerate: (req: GenerateRequest): Promise<string> =>
    ipcRenderer.invoke('llm:start', req),
  cancelGenerate: (id: string): Promise<void> =>
    ipcRenderer.invoke('llm:cancel', id),

  onChunk: (cb: (id: string, text: string) => void): (() => void) => {
    const handler = (_e: unknown, id: string, text: string) => cb(id, text)
    ipcRenderer.on('llm:chunk', handler)
    return () => ipcRenderer.off('llm:chunk', handler)
  },
  onDone: (cb: (id: string, result: GenerateResponse) => void): (() => void) => {
    const handler = (_e: unknown, id: string, result: GenerateResponse) =>
      cb(id, result)
    ipcRenderer.on('llm:done', handler)
    return () => ipcRenderer.off('llm:done', handler)
  },
  onError: (cb: (id: string, msg: string) => void): (() => void) => {
    const handler = (_e: unknown, id: string, msg: string) => cb(id, msg)
    ipcRenderer.on('llm:error', handler)
    return () => ipcRenderer.off('llm:error', handler)
  }
}

contextBridge.exposeInMainWorld('rendre', api)

export type RendreApi = typeof api
