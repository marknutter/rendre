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
  getBaseUrl,
  pushChunk,
  appendAndFinish,
  failSlot,
  sendSseEvent,
  closeSseChannel,
  cleanupSlot
} from './streamServer'
import { slotBootstrap } from './slotBootstrap'
import {
  parseSlots,
  fillSlotsInHtml,
  mergeRegionIntoHtml,
  getSlotInfo
} from './slotParser'
import type { SlotDef } from './slotParser'
import { resolveSlotModel } from './slotModelResolver'
import { DynamicPool } from './dynamicPool'
import type {
  Conversation,
  GenerateRequest,
  IterateSlotRequest,
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

    // Additive turns extend the prior turn's page instead of replacing it.
    // Requires a non-empty history; first prompts in a conversation always
    // run as fresh turns even if the flag is set.
    const additive = req.isAdditive === true && req.history.length > 0

    ;(async () => {
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
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[rendre] slot "${slot.name}" fill failed:`, msg)
          } finally {
            sendSseEvent(id, 'slot-done', { slot: slot.name })
          }
        })
      }

      try {
        const orchReq: GenerateRequest = {
          ...req,
          isAdditive: additive,
          model: ORCHESTRATOR_MODEL_BY_PROVIDER[req.provider]
        }

        if (additive) {
          // --- Additive path: orchestrator emits a <aside data-slot-region>
          // fragment that gets appended to the prior page via SSE. No HTTP
          // stream consumer (the iframe stays on its current document and
          // reuses the prior turn's bootstrap script via __rendreAttach).
          const orchResult = await provider.generate(orchReq, apiKey, {
            signal: ac.signal,
            // No onChunk wiring to streamServer — the HTTP stream isn't
            // navigated to for additive turns.
            onTool: (event) => {
              if (!sender.isDestroyed()) sender.send('llm:tool', id, event)
            }
          })
          aggUsageRef.current = addUsage(aggUsageRef.current, orchResult.usage)

          const region = orchResult.html
          const slots = parseSlots(region)

          // Tell the page to inject the new region. After this event lands the
          // [data-slot] elements inside the region exist in the DOM, so the
          // subsequent slot-chunk events can route into them.
          sendSseEvent(id, 'append-region', { html: region })

          if (slots.length > 0) {
            for (const slot of slots) {
              seenSlots.add(slot.name)
              dispatchSlot(slot, region)
            }
            await pool.close()
          }

          sendSseEvent(id, 'all-done', {})
          closeSseChannel(id)

          // Final stored HTML: prior page with the (filled) region appended.
          const filledRegion =
            slots.length > 0 ? fillSlotsInHtml(region, fills) : region
          const priorHtml = req.history[req.history.length - 1].html
          const finalHtml = mergeRegionIntoHtml(priorHtml, filledRegion)
          if (!sender.isDestroyed()) {
            sender.send('llm:done', id, {
              html: finalHtml,
              usage: aggUsageRef.current
            })
          }
          cleanupSlot(id)
          activeGenerations.delete(id)
          return
        }

        // --- Fresh-turn path: orchestrator streams a full HTML page, the
        // iframe navigates to /stream/:id, fills stream-fire as each slot
        // declaration appears in the orchestrator's output.
        const orchResult = await provider.generate(orchReq, apiKey, {
          signal: ac.signal,
          onChunk: (text) => {
            pushChunk(id, text)
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

        const skeleton = orchResult.html

        appendAndFinish(id, slotBootstrap(id, getBaseUrl()))

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

  ipcMain.handle('llm:iterate-slot', async (e, req: IterateSlotRequest) => {
    const id = uid()
    const ac = new AbortController()
    activeGenerations.set(id, ac)

    const apiKey = await getKey(req.provider)
    if (!apiKey) {
      activeGenerations.delete(id)
      throw new Error(`No API key set for ${req.provider}`)
    }

    const conversations = await loadConversations()
    const conv = conversations.find((c) => c.id === req.convId)
    const priorTurn = conv?.turns.find((t) => t.id === req.turnId)
    if (!conv || !priorTurn) {
      activeGenerations.delete(id)
      throw new Error('Prior turn not found')
    }

    const slotInfo = getSlotInfo(priorTurn.html, req.slot)
    if (!slotInfo) {
      activeGenerations.delete(id)
      throw new Error(`Slot "${req.slot}" not found in prior turn`)
    }

    const turnCfg = await loadConfig()
    const dispatchEnabled = turnCfg.useSlotDispatch === true
    const provider = getProvider(req.provider)
    const sender = e.sender

    // SSE-only slot — no HTTP stream consumer because the iframe doesn't
    // navigate for iteration (renderer calls __rendreAttach with the new id).
    createSlot(id, () => {})

    ;(async () => {
      try {
        sendSseEvent(id, 'slot-reset', { slot: req.slot })

        // Compose context for the fill model: original hint + the user's
        // iteration instruction + the slot's existing content (so the model
        // can revise rather than start from scratch).
        const composedHint =
          `${slotInfo.hint}` +
          `\n\nITERATION INSTRUCTION: ${req.instruction}` +
          `\n\nCURRENT SLOT CONTENT (for revision; preserve what works, change what the instruction asks for):\n${slotInfo.innerHtml}`

        const effectiveModel = resolveSlotModel({
          userModel: req.model,
          provider: req.provider,
          dispatchEnabled,
          slotAlias: slotInfo.modelAlias
        })

        const priorIdx = conv.turns.findIndex((t) => t.id === priorTurn.id)
        const historyBeforePrior =
          priorIdx > 0 ? conv.turns.slice(0, priorIdx) : []

        let lastSent = 0
        const fillResult = await provider.generateSlotFill(
          {
            prompt: priorTurn.prompt,
            history: historyBeforePrior,
            provider: req.provider,
            model: effectiveModel,
            skeleton: priorTurn.html,
            slotName: req.slot,
            slotHint: composedHint
          },
          apiKey,
          {
            signal: ac.signal,
            onChunk: (accumulated) => {
              const delta = accumulated.slice(lastSent)
              if (!delta) return
              lastSent = accumulated.length
              sendSseEvent(id, 'slot-chunk', {
                slot: req.slot,
                chunk: delta
              })
            }
          }
        )

        sendSseEvent(id, 'slot-done', { slot: req.slot })
        sendSseEvent(id, 'all-done', {})
        closeSseChannel(id)

        // New turn's HTML = prior turn's HTML with ONLY this slot's content
        // replaced. fillSlotsInHtml leaves unspecified slots untouched.
        const newTurnHtml = fillSlotsInHtml(
          priorTurn.html,
          new Map([[req.slot, fillResult.html]])
        )

        if (!sender.isDestroyed()) {
          sender.send('llm:done', id, {
            html: newTurnHtml,
            usage: fillResult.usage
          })
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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
