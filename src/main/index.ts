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
  getComposedUrl,
  pushChunk,
  finishSlot,
  failSlot
} from './streamServer'
import type {
  Conversation,
  GenerateRequest,
  ProviderConfig,
  ProviderId,
  UsageStats
} from '../shared/types'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function mergeUsage(main?: UsageStats, preview?: UsageStats): UsageStats | undefined {
  if (!main && !preview) return undefined
  return {
    inputTokens: (main?.inputTokens ?? 0) + (preview?.inputTokens ?? 0),
    outputTokens: (main?.outputTokens ?? 0) + (preview?.outputTokens ?? 0),
    cacheReadTokens: (main?.cacheReadTokens ?? 0) + (preview?.cacheReadTokens ?? 0),
    cacheCreationTokens:
      (main?.cacheCreationTokens ?? 0) + (preview?.cacheCreationTokens ?? 0)
  }
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
    const previewId = `${id}:preview`
    const ac = new AbortController()
    activeGenerations.set(id, ac)

    const apiKey = await getKey(req.provider)
    if (!apiKey) {
      activeGenerations.delete(id)
      throw new Error(`No API key set for ${req.provider}`)
    }

    const provider = getProvider(req.provider)
    const sender = e.sender
    const hasPreview = typeof provider.generatePreview === 'function'
    console.log(
      `[rendre] llm:start id=${id} provider=${req.provider} model=${req.model} hasPreview=${hasPreview}`
    )

    let urlFired = false
    const fireUrlOnce = (which: 'main' | 'preview') => {
      if (urlFired) {
        console.log(`[rendre] slot ${which} ready (already fired)`)
        return
      }
      urlFired = true
      const url = hasPreview ? getComposedUrl(id) : getStreamUrl(id)
      console.log(`[rendre] llm:url sent (first ready=${which}) url=${url}`)
      if (!sender.isDestroyed()) sender.send('llm:url', id, url)
    }

    createSlot(id, () => fireUrlOnce('main'))
    if (hasPreview) createSlot(previewId, () => fireUrlOnce('preview'))

    ;(async () => {
      const mainPromise = provider.generate(req, apiKey, {
        signal: ac.signal,
        onChunk: (text) => pushChunk(id, text),
        onTool: (event) => {
          if (!sender.isDestroyed()) sender.send('llm:tool', id, event)
        }
      })

      const previewPromise = hasPreview
        ? provider
            .generatePreview!(req, apiKey, {
              signal: ac.signal,
              onChunk: (text) => pushChunk(previewId, text),
              onTool: (event) => {
                if (!sender.isDestroyed()) sender.send('llm:tool', id, event)
              }
            })
            .then((r) => {
              finishSlot(previewId)
              return r
            })
            .catch((err) => {
              failSlot(previewId)
              return {
                html: '',
                usage: undefined,
                _error: err instanceof Error ? err.message : String(err)
              }
            })
        : Promise.resolve({ html: '', usage: undefined })

      try {
        const [result, preview] = await Promise.all([mainPromise, previewPromise])
        finishSlot(id)
        const mergedUsage = mergeUsage(result.usage, preview.usage)
        console.log(
          `[rendre] llm:done id=${id} main=${result.html.length} chars preview=${preview.html.length} chars urlFired=${urlFired}`
        )
        if (!sender.isDestroyed()) {
          sender.send('llm:done', id, {
            html: result.html,
            previewHtml: preview.html || undefined,
            usage: mergedUsage
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[rendre] llm:error id=${id} ${msg}`)
        failSlot(id)
        if (hasPreview) failSlot(previewId)
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
