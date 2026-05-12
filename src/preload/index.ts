import { contextBridge, ipcRenderer } from 'electron'
import type {
  Conversation,
  GenerateRequest,
  GenerateResponse,
  ProviderConfig,
  ProviderId,
  ToolUseEvent
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

  onStreamUrl: (cb: (id: string, url: string) => void): (() => void) => {
    const handler = (_e: unknown, id: string, url: string) => cb(id, url)
    ipcRenderer.on('llm:url', handler)
    return () => ipcRenderer.off('llm:url', handler)
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
  },
  onTool: (cb: (id: string, event: ToolUseEvent) => void): (() => void) => {
    const handler = (_e: unknown, id: string, event: ToolUseEvent) => cb(id, event)
    ipcRenderer.on('llm:tool', handler)
    return () => ipcRenderer.off('llm:tool', handler)
  }
}

contextBridge.exposeInMainWorld('rendre', api)

export type RendreApi = typeof api
