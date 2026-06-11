import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Conversation,
  ProviderConfig,
  Theme,
  Turn,
  UsageStats
} from '../../shared/types'
import { DEFAULT_CONFIG } from '../../shared/types'
import { Settings } from './Settings'
import { skeletonHtml } from './skeleton'
import './types'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function freshConversation(): Conversation {
  const now = Date.now()
  return { id: uid(), createdAt: now, updatedAt: now, title: 'New chat', turns: [] }
}

type CanvasSrc =
  | { kind: 'skeleton'; html: string }
  | { kind: 'stream'; url: string }
  | { kind: 'turn'; html: string }
  | null

export function App() {
  const [config, setConfig] = useState<ProviderConfig>(DEFAULT_CONFIG)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genId, setGenId] = useState<string | null>(null)
  const [canvasSrc, setCanvasSrc] = useState<CanvasSrc>(null)
  const [lastUsage, setLastUsage] = useState<UsageStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editing, setEditing] = useState(false)

  const webviewRef = useRef<(HTMLElement & { src: string }) | null>(null)
  const lastBlobUrlRef = useRef<string | null>(null)
  const webviewReadyRef = useRef(false)
  const toolStatusRef = useRef<string | null>(null)
  const [toolStatus, setToolStatus] = useState<string | null>(null)

  // Carries the in-flight generation's metadata for the event handlers to use
  const generationRef = useRef<{
    id: string
    conv: Conversation
    prompt: string
    isAdditive: boolean
    isIterate: boolean
  } | null>(null)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved =
        config.theme === 'system' ? (mq.matches ? 'dark' : 'light') : config.theme
      document.documentElement.dataset.theme = resolved
    }
    apply()
    if (config.theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [config.theme])

  useEffect(() => {
    void (async () => {
      const [cfg, history] = await Promise.all([
        window.rendre.getConfig(),
        window.rendre.getHistory()
      ])
      setConfig(cfg)
      setConversations(history)
      if (history.length > 0) {
        setActiveConvId(history[0].id)
        const lastTurn = history[0].turns[history[0].turns.length - 1]
        if (lastTurn) {
          setActiveTurnId(lastTurn.id)
          setCanvasSrc({ kind: 'turn', html: lastTurn.html })
        }
      }
      const hasKey = await window.rendre.hasKey(cfg.provider)
      if (!hasKey) setSettingsOpen(true)
    })()
  }, [])

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeConvId) ?? null,
    [conversations, activeConvId]
  )

  // Single source-of-truth effect: webview src follows canvasSrc identity, never updates per-chunk
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    webviewReadyRef.current = false
    const onReady = () => {
      webviewReadyRef.current = true
      applyToolStatus()
    }
    wv.addEventListener('dom-ready', onReady)
    if (!canvasSrc) {
      wv.src = 'about:blank'
    } else if (canvasSrc.kind === 'stream') {
      wv.src = canvasSrc.url
    } else {
      const blob = new Blob([canvasSrc.html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      wv.src = url
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current)
      lastBlobUrlRef.current = url
    }
    return () => wv.removeEventListener('dom-ready', onReady)
  }, [canvasSrc])

  useEffect(() => {
    toolStatusRef.current = toolStatus
    if (canvasSrc?.kind === 'skeleton') applyToolStatus()
  }, [toolStatus, canvasSrc?.kind])

  function applyToolStatus() {
    const wv = webviewRef.current as unknown as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    if (!wv || !webviewReadyRef.current) return
    const text = toolStatusRef.current
    if (!text) return
    void wv.executeJavaScript?.(
      `window.__rendreSetStatus && window.__rendreSetStatus(${JSON.stringify(text)})`
    )
  }

  // Subscribe to streaming events
  useEffect(() => {
    const offUrl = window.rendre.onStreamUrl((id, url) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      setCanvasSrc({ kind: 'stream', url })
    })

    const offDone = window.rendre.onDone((id, result) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      const { conv, prompt: userPrompt } = generationRef.current
      const turn: Turn = {
        id: uid(),
        createdAt: Date.now(),
        prompt: userPrompt,
        html: result.html,
        provider: config.provider,
        model: config.model,
        usage: result.usage
      }
      setConversations((prev) => {
        const existingIdx = prev.findIndex((c) => c.id === conv.id)
        const updated: Conversation = {
          ...conv,
          updatedAt: Date.now(),
          title: conv.turns.length === 0 ? userPrompt.slice(0, 60) : conv.title,
          turns: [...conv.turns, turn]
        }
        let next: Conversation[]
        if (existingIdx >= 0) {
          next = [...prev]
          next[existingIdx] = updated
        } else {
          next = [updated, ...prev]
        }
        void window.rendre.setHistory(next)
        return next
      })
      setActiveTurnId(turn.id)
      if (result.usage) setLastUsage(result.usage)
      // For additive AND iterate turns the iframe is already showing the
      // updated page (region appended or slot refilled, live via SSE);
      // reload it from the canonical merged HTML so the canvas state matches
      // what's persisted. Brief flash but the state stays consistent across
      // theme changes / navigation. For fresh-stream turns: keep the stream
      // URL to preserve scroll position.
      const wasInPlace =
        generationRef.current?.isAdditive === true ||
        generationRef.current?.isIterate === true
      setCanvasSrc((prev) => {
        if (wasInPlace) return { kind: 'turn', html: result.html }
        if (prev?.kind === 'stream') return prev
        return { kind: 'turn', html: result.html }
      })
      setGenerating(false)
      setGenId(null)
      setToolStatus(null)
      generationRef.current = null
    })

    const offError = window.rendre.onError((id, msg) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      setError(msg)
      // Drop skeleton, restore prior turn if there was one
      setCanvasSrc((prev) => {
        if (prev?.kind === 'skeleton' || prev?.kind === 'stream') return null
        return prev
      })
      setGenerating(false)
      setGenId(null)
      setToolStatus(null)
      generationRef.current = null
    })

    const offTool = window.rendre.onTool((id, event) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      const url = (event.input as { url?: string } | undefined)?.url
      const label = url ?? event.tool
      if (event.type === 'start') {
        setToolStatus(`Fetching ${label}…`)
      } else if (event.type === 'done') {
        setToolStatus(`Read ${label}. Composing webpage…`)
      } else if (event.type === 'error') {
        setToolStatus(`Tool error: ${event.error ?? label}`)
      }
    })

    return () => {
      offUrl()
      offDone()
      offError()
      offTool()
    }
  }, [config.provider, config.model])

  // Webview console-message listener: the bootstrap script inside the iframe
  // dispatches iterate-button clicks by emitting a magic-prefixed console.log
  // (no preload needed). We parse it and route to the iterate handler.
  useEffect(() => {
    const wv = webviewRef.current as unknown as {
      addEventListener?: (
        event: string,
        cb: (e: { message: string }) => void
      ) => void
      removeEventListener?: (
        event: string,
        cb: (e: { message: string }) => void
      ) => void
    } | null
    if (!wv?.addEventListener) return
    const handler = (e: { message: string }) => {
      if (typeof e.message !== 'string') return
      if (!e.message.startsWith('__rendre_iterate__:')) return
      let payload: { slot?: string; instruction?: string; shiftKey?: boolean }
      try {
        payload = JSON.parse(e.message.slice('__rendre_iterate__:'.length))
      } catch {
        return
      }
      if (!payload.slot || !payload.instruction) return
      void handleIterateClick(
        payload.slot,
        payload.instruction,
        payload.shiftKey === true
      )
    }
    wv.addEventListener('console-message', handler)
    return () => wv.removeEventListener?.('console-message', handler)
    // canvasSrc?.kind is in deps so the listener re-attaches when the webview
    // mounts after being unmounted (showEmpty path). State captured in the
    // handler closure stays fresh through these deps.
  }, [
    canvasSrc?.kind,
    activeConvId,
    activeTurnId,
    config.provider,
    config.model,
    generating,
    conversations
  ])

  async function persistConversations(next: Conversation[]) {
    setConversations(next)
    await window.rendre.setHistory(next)
  }

  async function sendPrompt() {
    if (!prompt.trim() || generating) return
    setError(null)

    let conv = activeConv
    if (!conv) {
      conv = freshConversation()
      conv.title = prompt.slice(0, 60)
      setActiveConvId(conv.id)
      await persistConversations([conv, ...conversations])
    }

    // Parse `/add ` prefix as a one-shot additive override (doesn't flip the
    // sticky toggle). Sticky `conv.additiveMode` also counts. Either way, an
    // additive turn requires at least one prior turn to extend.
    let userPrompt = prompt
    let oneShotAdditive = false
    if (/^\/add\s+/.test(userPrompt)) {
      oneShotAdditive = true
      userPrompt = userPrompt.replace(/^\/add\s+/, '')
    }
    const isAdditive =
      (conv.additiveMode === true || oneShotAdditive) && conv.turns.length > 0

    setPrompt('')
    setGenerating(true)
    setToolStatus(null)
    // Additive turns keep the existing iframe content in place — the new
    // region is appended into it live via SSE. Don't show the skeleton.
    if (!isAdditive) {
      setCanvasSrc({ kind: 'skeleton', html: skeletonHtml(userPrompt, config.provider) })
    }

    try {
      const id = await window.rendre.startGenerate({
        prompt: userPrompt,
        history: conv.turns,
        provider: config.provider,
        model: config.model,
        isAdditive
      })
      generationRef.current = { id, conv, prompt: userPrompt, isAdditive, isIterate: false }
      setGenId(id)

      if (isAdditive) {
        // Tell the iframe (which is still showing the prior turn's page,
        // bootstrap script intact) to open an EventSource on the new stream
        // so it receives the append-region + slot-chunk events.
        const wv = webviewRef.current as unknown as {
          executeJavaScript?: (code: string) => Promise<unknown>
        } | null
        void wv?.executeJavaScript?.(
          `window.__rendreAttach && window.__rendreAttach(${JSON.stringify(id)})`
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setGenerating(false)
      if (!isAdditive) setCanvasSrc(null)
    }
  }

  function toggleAdditiveMode() {
    if (!activeConv) return
    const next = activeConv.additiveMode === true ? false : true
    const updatedConv: Conversation = { ...activeConv, additiveMode: next }
    const updated = conversations.map((c) =>
      c.id === activeConv.id ? updatedConv : c
    )
    void persistConversations(updated)
  }

  function enterEditMode() {
    if (editing || generating || !canvasSrc || canvasSrc.kind !== 'turn') return
    const wv = webviewRef.current as unknown as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    void wv?.executeJavaScript?.(`window.__rendreEnterEdit && window.__rendreEnterEdit()`)
    setEditing(true)
  }

  async function saveEdits() {
    if (!editing) return
    const wv = webviewRef.current as unknown as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    if (!wv?.executeJavaScript) {
      setEditing(false)
      return
    }
    let editedHtml: string
    try {
      const result = await wv.executeJavaScript(
        `window.__rendreGetEditedHtml ? window.__rendreGetEditedHtml() : null`
      )
      if (typeof result !== 'string' || !result) {
        setEditing(false)
        return
      }
      editedHtml = result
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setEditing(false)
      return
    }

    // Exit edit mode in the iframe BEFORE the canvasSrc reload so the
    // contenteditable state doesn't carry into the new render.
    void wv.executeJavaScript?.(`window.__rendreExitEdit && window.__rendreExitEdit(false)`)

    let conv = activeConv
    if (!conv) {
      conv = freshConversation()
      conv.title = 'Edited page'
      setActiveConvId(conv.id)
      await persistConversations([conv, ...conversations])
    }

    const turn: Turn = {
      id: uid(),
      createdAt: Date.now(),
      prompt: '✏️ Edited',
      html: editedHtml,
      provider: config.provider,
      model: config.model
    }
    setConversations((prev) => {
      const existingIdx = prev.findIndex((c) => c.id === conv!.id)
      const updated: Conversation = {
        ...conv!,
        updatedAt: Date.now(),
        title: conv!.turns.length === 0 ? '✏️ Edited page' : conv!.title,
        turns: [...conv!.turns, turn]
      }
      let next: Conversation[]
      if (existingIdx >= 0) {
        next = [...prev]
        next[existingIdx] = updated
      } else {
        next = [updated, ...prev]
      }
      void window.rendre.setHistory(next)
      return next
    })
    setActiveTurnId(turn.id)
    setCanvasSrc({ kind: 'turn', html: editedHtml })
    setEditing(false)
  }

  function cancelEdits() {
    if (!editing) return
    const wv = webviewRef.current as unknown as {
      executeJavaScript?: (code: string) => Promise<unknown>
    } | null
    void wv?.executeJavaScript?.(
      `window.__rendreExitEdit && window.__rendreExitEdit(true)`
    )
    setEditing(false)
  }

  async function handleIterateClick(
    slot: string,
    instruction: string,
    shiftKey: boolean
  ) {
    if (generating) return
    if (shiftKey) {
      setPrompt(instruction)
      return
    }
    if (!activeConvId || !activeTurnId) return
    const conv = conversations.find((c) => c.id === activeConvId)
    if (!conv) return

    setError(null)
    setGenerating(true)
    setToolStatus(null)
    try {
      const id = await window.rendre.iterateSlot({
        convId: activeConvId,
        turnId: activeTurnId,
        slot,
        instruction,
        provider: config.provider,
        model: config.model
      })
      generationRef.current = {
        id,
        conv,
        prompt: instruction,
        isAdditive: false,
        isIterate: true
      }
      setGenId(id)

      // Tell the iframe to attach to the new stream — iteration doesn't
      // navigate the iframe (the rest of the page stays put while the one
      // slot refills in place).
      const wv = webviewRef.current as unknown as {
        executeJavaScript?: (code: string) => Promise<unknown>
      } | null
      void wv?.executeJavaScript?.(
        `window.__rendreAttach && window.__rendreAttach(${JSON.stringify(id)})`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setGenerating(false)
    }
  }

  function cancelGeneration() {
    if (genId) void window.rendre.cancelGenerate(genId)
  }

  function selectTurn(convId: string, turnId: string | null) {
    setActiveConvId(convId)
    setActiveTurnId(turnId)
    const conv = conversations.find((c) => c.id === convId)
    const turn = turnId ? conv?.turns.find((t) => t.id === turnId) : conv?.turns.at(-1)
    if (turn) setCanvasSrc({ kind: 'turn', html: turn.html })
    else setCanvasSrc(null)
  }

  function cycleTheme() {
    const order: Theme[] = ['system', 'light', 'dark']
    const next = order[(order.indexOf(config.theme) + 1) % order.length]
    const updated = { ...config, theme: next }
    setConfig(updated)
    void window.rendre.setConfig(updated)
  }

  function newChat() {
    const conv = freshConversation()
    void persistConversations([conv, ...conversations])
    setActiveConvId(conv.id)
    setActiveTurnId(null)
    setCanvasSrc(null)
  }

  const turnsForSidebar = activeConv?.turns ?? []
  const showEmpty = canvasSrc === null
  const additiveMode = activeConv?.additiveMode === true
  const canExtend = (activeConv?.turns.length ?? 0) > 0
  const extendActive = additiveMode || /^\/add\s+/.test(prompt)
  const canEdit = canvasSrc?.kind === 'turn' && !generating && !editing

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">rendre</span>
          <div className="sidebar-actions">
            <button
              className="icon-btn"
              onClick={cycleTheme}
              title={`Theme: ${config.theme} (click to cycle)`}
            >
              {config.theme === 'system' ? '◐' : config.theme === 'light' ? '○' : '●'}
            </button>
            <button className="icon-btn" onClick={newChat} title="New chat">+</button>
            <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
          </div>
        </div>
        <div className="turn-list">
          {conversations.map((c) => (
            <div key={c.id} style={{ marginBottom: 8 }}>
              <button
                className={`turn-item ${c.id === activeConvId ? 'active' : ''}`}
                onClick={() => selectTurn(c.id, c.turns.at(-1)?.id ?? null)}
                style={{ fontWeight: 500 }}
              >
                {c.title || 'Untitled'}
              </button>
              {c.id === activeConvId && turnsForSidebar.map((t, i) => (
                <button
                  key={t.id}
                  className={`turn-item ${t.id === activeTurnId ? 'active' : ''}`}
                  onClick={() => selectTurn(c.id, t.id)}
                  style={{ paddingLeft: 22, fontSize: 12 }}
                >
                  {i + 1}. {t.prompt.slice(0, 40)}
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="canvas">
          {showEmpty ? (
            <div className="empty">
              <h1>rendre</h1>
              <p>
                A chatbot that responds in HTML, not text. Every reply is a complete webpage
                — layouts, charts, mini-apps, whatever fits your prompt.
              </p>
              <p style={{ marginTop: 16 }}>
                Try: <em>"Compare TypeScript and Rust for systems programming."</em>
              </p>
            </div>
          ) : (
            // @ts-expect-error webview is an Electron-only element
            <webview ref={webviewRef as never} allowpopups="true" />
          )}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="input-bar">
          {editing ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px',
                color: '#a78bfa',
                fontSize: 13,
                background: 'rgba(124,92,255,0.08)',
                border: '1px dashed rgba(124,92,255,0.5)',
                borderRadius: 8
              }}
            >
              ✏️ Edit mode — click anywhere in the page to edit. Save creates a new turn.
            </div>
          ) : (
            <textarea
              className="input"
              placeholder={
                extendActive && canExtend
                  ? 'Extend the page — your response will be appended.'
                  : 'Ask anything — the answer will be a webpage.'
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void sendPrompt()
                }
              }}
              rows={2}
            />
          )}
          {!editing && (
            <button
              className="icon-btn"
              onClick={toggleAdditiveMode}
              disabled={!canExtend || generating}
              title={
                !canExtend
                  ? 'Send a first prompt before you can extend the page'
                  : additiveMode
                    ? 'Extend mode is ON — your next prompts append to the page (click to turn off)'
                    : 'Extend mode is OFF — click to make follow-ups append to the page'
              }
              style={{
                padding: '0 12px',
                alignSelf: 'stretch',
                opacity: !canExtend ? 0.4 : 1,
                background: extendActive && canExtend ? 'var(--accent, #7c5cff)' : undefined,
                color: extendActive && canExtend ? '#fff' : undefined,
                borderColor: extendActive && canExtend ? 'transparent' : undefined,
                fontSize: 12,
                whiteSpace: 'nowrap'
              }}
            >
              {extendActive && canExtend ? '＋ Extend' : '＋'}
            </button>
          )}
          {!editing && (
            <button
              className="icon-btn"
              onClick={enterEditMode}
              disabled={!canEdit}
              title={
                !canEdit
                  ? 'No page to edit yet'
                  : 'Edit the current page directly (creates a new turn on save)'
              }
              style={{
                padding: '0 12px',
                alignSelf: 'stretch',
                opacity: !canEdit ? 0.4 : 1,
                fontSize: 12,
                whiteSpace: 'nowrap'
              }}
            >
              ✏️ Edit
            </button>
          )}
          {editing ? (
            <>
              <button
                className="icon-btn"
                onClick={cancelEdits}
                style={{
                  padding: '0 14px',
                  alignSelf: 'stretch',
                  fontSize: 12,
                  whiteSpace: 'nowrap'
                }}
              >
                Cancel
              </button>
              <button
                className="send"
                onClick={() => void saveEdits()}
                title="Save edits as a new turn"
              >
                Save
              </button>
            </>
          ) : generating ? (
            <button className="send cancel" onClick={cancelGeneration}>Stop</button>
          ) : (
            <button className="send" onClick={() => void sendPrompt()} disabled={!prompt.trim()}>
              {extendActive && canExtend ? 'Extend' : 'Send'}
            </button>
          )}
        </div>
        <StatusBar
          config={config}
          usage={lastUsage}
          generating={generating}
          streamPhase={canvasSrc?.kind === 'stream'}
        />
      </main>

      {settingsOpen && (
        <Settings
          config={config}
          onClose={() => setSettingsOpen(false)}
          onSaved={(c) => {
            setConfig(c)
            setSettingsOpen(false)
          }}
        />
      )}
    </div>
  )
}

function StatusBar({
  config,
  usage,
  generating,
  streamPhase
}: {
  config: ProviderConfig
  usage: UsageStats | null
  generating: boolean
  streamPhase: boolean
}) {
  const cacheLabel =
    usage && (usage.cacheReadTokens || usage.cacheCreationTokens)
      ? ` · cache ${usage.cacheReadTokens ?? 0}r/${usage.cacheCreationTokens ?? 0}w`
      : ''
  const usageLabel = usage
    ? ` · ${usage.inputTokens}in/${usage.outputTokens}out${cacheLabel}`
    : ''
  let stateLabel = ' · ⌘↵ to send'
  if (generating) stateLabel = streamPhase ? ' · streaming…' : ' · thinking…'
  return (
    <div className="status">
      {config.provider} · {config.model}
      {usageLabel}
      {stateLabel}
    </div>
  )
}
