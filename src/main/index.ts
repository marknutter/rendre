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
  sendSseEvent,
  closeSseChannel,
  cleanupSlot
} from './streamServer'
import { slotBootstrap } from './slotBootstrap'
import { parseSlots, fillSlotsInHtml } from './slotParser'
import type { SlotDef } from './slotParser'
import { resolveSlotModel } from './slotModelResolver'
import { DynamicPool } from './dynamicPool'
import type {
  Conversation,
  GenerateRequest,
  ProviderConfig,
  ProviderId,
  UsageStats
} from '../shared/types'
import { ORCHESTRATOR_MODEL_BY_PROVIDER } from '../shared/types'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Concurrent fills per turn. Conservative cap to stay well inside Anthropic's
// 50 RPM (paid tier) and avoid OpenAI rate-limit surprises on cheaper tiers.
const FILL_CONCURRENCY = 4

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

    const turnCfg = await loadConfig()
    const dispatchEnabled = turnCfg.useSlotDispatch === true
    const provider = getProvider(req.provider)
    const sender = e.sender

    createSlot(id, () => {
      if (!sender.isDestroyed()) sender.send('llm:url', id, getStreamUrl(id))
    })

    ;(async () => {
      // Per-turn shared state. The pool, the fills map, and the aggregate
      // usage are all populated incrementally as the orchestrator's stream
      // arrives and fills complete.
      const pool = new DynamicPool(FILL_CONCURRENCY)
      const seenSlots = new Set<string>()
      const fills = new Map<string, string>()
      const aggUsageRef: { current: UsageStats | undefined } = { current: undefined }

      const dispatchSlot = (slot: SlotDef, skeletonSnapshot: string): void => {
        pool.enqueue(async () => {
          if (ac.signal.aborted) return
          const effectiveModel = resolveSlotModel({
            userModel: req.model,
            provider: req.provider,
            dispatchEnabled,
            slotAlias: slot.modelAlias
          })
          let lastSent = 0
          try {
            const fillResult = await provider.generateSlotFill(
              {
                prompt: req.prompt,
                history: req.history,
                provider: req.provider,
                model: effectiveModel,
                skeleton: skeletonSnapshot,
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
                  sendSseEvent(id, 'slot-chunk', {
                    slot: slot.name,
                    chunk: delta
                  })
                }
              }
            )
            fills.set(slot.name, fillResult.html)
            aggUsageRef.current = addUsage(aggUsageRef.current, fillResult.usage)
          } catch (err) {
            // Isolate this slot's failure — log, leave fills entry empty so
            // the final HTML has a blank slot, do not propagate.
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[rendre] slot "${slot.name}" fill failed:`, msg)
          } finally {
            // Always emit slot-done so the page exits "filling" state even
            // when a fill errored or was aborted.
            sendSseEvent(id, 'slot-done', { slot: slot.name })
          }
        })
      }

      try {
        // --- Orchestrator pass: stream the skeleton AND dispatch fills as
        // each slot is declared. The serial orchestrator → fills boundary is
        // collapsed: fills start as soon as their <section data-slot=...> tag
        // is fully parsed, while the orchestrator keeps streaming the rest of
        // the skeleton. Each fill captures a snapshot of the partial skeleton
        // at dispatch time as its context.
        const orchReq: GenerateRequest = {
          ...req,
          model: ORCHESTRATOR_MODEL_BY_PROVIDER[req.provider]
        }
        const orchResult = await provider.generate(orchReq, apiKey, {
          signal: ac.signal,
          onChunk: (text) => {
            pushChunk(id, text)
            // Re-scan the accumulated buffer for new slot declarations. We
            // re-scan every chunk; the regex is fast, buffers are small.
            const declared = parseSlots(text)
            for (const slot of declared) {
              if (seenSlots.has(slot.name)) continue
              seenSlots.add(slot.name)
              dispatchSlot(slot, text)
            }
          },
          onTool: (event) => {
            if (!sender.isDestroyed()) sender.send('llm:tool', id, event)
          }
        })

        aggUsageRef.current = addUsage(aggUsageRef.current, orchResult.usage)

        // Canonical skeleton — used for final HTML assembly. If the model
        // wrapped its output in fences or had other noise, extractHtml cleans
        // it up; slot detection above ran on the raw stream so dispatch order
        // is preserved.
        const skeleton = orchResult.html

        // Inject the SSE bootstrap and close the HTTP stream. The browser's
        // EventSource may not be connected yet — fills' early events queue in
        // streamServer and flush on connection.
        appendAndFinish(id, slotBootstrap(id))

        // No slots → orchestrator's output is the whole answer.
        if (seenSlots.size === 0) {
          sendSseEvent(id, 'all-done', {})
          closeSseChannel(id)
          if (!sender.isDestroyed()) {
            sender.send('llm:done', id, {
              html: skeleton,
              usage: aggUsageRef.current
            })
          }
          cleanupSlot(id)
          activeGenerations.delete(id)
          return
        }

        // Wait for every dispatched fill to finish (succeed or fail).
        await pool.close()

        sendSseEvent(id, 'all-done', {})
        closeSseChannel(id)

        const finalHtml = fillSlotsInHtml(skeleton, fills)
        if (!sender.isDestroyed()) {
          sender.send('llm:done', id, {
            html: finalHtml,
            usage: aggUsageRef.current
          })
        }
        cleanupSlot(id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Drain in-flight fills before reporting the error to avoid leaking
        // workers. Their internal try/catch swallows AbortError.
        await pool.close().catch(() => undefined)
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
