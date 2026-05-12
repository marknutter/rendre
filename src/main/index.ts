import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { getProvider } from './providers'
import {
  loadConversations,
  saveConversations,
  loadConfig,
  saveConfig
} from './store'
import { getKey, setKey, hasKey } from './keys'
import {
  startStreamServer,
  createSlot,
  getStreamUrl,
  pushChunk,
  finishSlot,
  failSlot
} from './streamServer'
import type {
  Conversation,
  GenerateRequest,
  ProviderConfig,
  ProviderId
} from '../shared/types'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const activeGenerations = new Map<string, AbortController>()

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  await startStreamServer()

  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_e, c: ProviderConfig) => saveConfig(c))

  ipcMain.handle('history:get', () => loadConversations())
  ipcMain.handle('history:set', (_e, c: Conversation[]) => saveConversations(c))

  ipcMain.handle('keys:has', (_e, p: ProviderId) => hasKey(p))
  ipcMain.handle('keys:set', (_e, p: ProviderId, k: string) => setKey(p, k))

  ipcMain.handle('llm:start', async (e, req: GenerateRequest) => {
    const id = uid()
    const ac = new AbortController()
    activeGenerations.set(id, ac)

    const apiKey = await getKey(req.provider)
    if (!apiKey) {
      activeGenerations.delete(id)
      throw new Error(`No API key set for ${req.provider}`)
    }

    const provider = getProvider(req.provider)
    const sender = e.sender

    createSlot(id, () => {
      if (!sender.isDestroyed()) sender.send('llm:url', id, getStreamUrl(id))
    })

    ;(async () => {
      try {
        const result = await provider.generate(req, apiKey, {
          signal: ac.signal,
          onChunk: (text) => pushChunk(id, text)
        })
        finishSlot(id)
        if (!sender.isDestroyed()) sender.send('llm:done', id, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failSlot(id)
        if (!sender.isDestroyed()) sender.send('llm:error', id, msg)
      } finally {
        activeGenerations.delete(id)
      }
    })()

    return id
  })

  ipcMain.handle('llm:cancel', (_e, id: string) => {
    const ac = activeGenerations.get(id)
    if (ac) ac.abort()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
