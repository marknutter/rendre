import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
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
  appendAndFinish,
  failSlot,
  getBuffer,
  sendSseEvent,
  closeSseChannel,
  waitForSse,
  cleanupSlot
} from './streamServer'
import { slotBootstrap } from './slotBootstrap'
import { parseSlots, fillSlotsInHtml } from './slotParser'
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

function addUsage(a: UsageStats | undefined, b: UsageStats | undefined): UsageStats {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cacheReadTokens: (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
    cacheCreationTokens:
      (a?.cacheCreationTokens ?? 0) + (b?.cacheCreationTokens ?? 0)
  }
}

app.whenReady().then(async () => {
  await startStreamServer()

  const bootCfg = await loadConfig()
  nativeTheme.themeSource = bootCfg.theme

  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', async (_e, c: ProviderConfig) => {
    await saveConfig(c)
    nativeTheme.themeSource = c.theme
  })

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
        // --- Orchestrator pass: stream the skeleton ---
        const orchResult = await provider.generate(req, apiKey, {
          signal: ac.signal,
          onChunk: (text) => pushChunk(id, text),
          onTool: (event) => {
            if (!sender.isDestroyed()) sender.send('llm:tool', id, event)
          }
        })

        // Use the canonical (extracted) skeleton for parsing and as the basis
        // for the final HTML; getBuffer holds the raw model output which may
        // include code fences or trailing text.
        const skeleton = orchResult.html
        const slots = parseSlots(skeleton)

        // Inject the SSE bootstrap and close the HTTP stream. Append after the
        // last seen </html> if present (browsers tolerate trailing content
        // either way, but in-document is cleaner).
        appendAndFinish(id, slotBootstrap(id))

        // No slots → nothing to fill, we're done.
        if (slots.length === 0) {
          // No SSE channel needed, but ensure cleanup
          sendSseEvent(id, 'all-done', {})
          closeSseChannel(id)
          if (!sender.isDestroyed()) {
            sender.send('llm:done', id, {
              html: skeleton,
              usage: orchResult.usage
            })
          }
          cleanupSlot(id)
          activeGenerations.delete(id)
          return
        }

        // Give the page a chance to connect its EventSource. Queued events
        // would still be delivered, but live delivery feels better.
        await waitForSse(id)

        // --- Fill pass: one call per slot, sequential ---
        let aggUsage: UsageStats | undefined = orchResult.usage
        const fills = new Map<string, string>()
        for (const slot of slots) {
          if (ac.signal.aborted) break
          let lastSent = 0
          const fillResult = await provider.generateSlotFill(
            {
              prompt: req.prompt,
              history: req.history,
              provider: req.provider,
              model: req.model,
              skeleton,
              slotName: slot.name,
              slotHint: slot.hint
            },
            apiKey,
            {
              signal: ac.signal,
              onChunk: (accumulated) => {
                const delta = accumulated.slice(lastSent)
                if (!delta) return
                lastSent = accumulated.length
                sendSseEvent(id, 'slot-chunk', { slot: slot.name, chunk: delta })
              }
            }
          )
          fills.set(slot.name, fillResult.html)
          sendSseEvent(id, 'slot-done', { slot: slot.name })
          aggUsage = addUsage(aggUsage, fillResult.usage)
        }

        sendSseEvent(id, 'all-done', {})
        closeSseChannel(id)

        const finalHtml = fillSlotsInHtml(skeleton, fills)
        if (!sender.isDestroyed()) {
          sender.send('llm:done', id, { html: finalHtml, usage: aggUsage })
        }
        cleanupSlot(id)
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
