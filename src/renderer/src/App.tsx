import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Conversation,
  ProviderConfig,
  Theme,
  Turn,
  UsageStats
} from '../../shared/types'
import { DEFAULT_CONFIG } from '../../shared/types'
import { wrapperPageHtml } from '../../shared/wrapper'
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

function turnCanvas(turn: Turn): CanvasSrc {
  if (turn.previewHtml) {
    return { kind: 'composed', previewHtml: turn.previewHtml, mainHtml: turn.html }
  }
  return { kind: 'turn', html: turn.html }
}

type CanvasSrc =
  | { kind: 'skeleton'; html: string }
  | { kind: 'stream'; url: string }
  | { kind: 'turn'; html: string }
  | { kind: 'composed'; previewHtml: string; mainHtml: string }
  | null

function composedStaticHtml(previewHtml: string, mainHtml: string): string {
  return wrapperPageHtml({
    preview: { srcdoc: previewHtml },
    main: { srcdoc: mainHtml }
  })
}

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
          setCanvasSrc(turnCanvas(lastTurn))
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
      const html =
        canvasSrc.kind === 'composed'
          ? composedStaticHtml(canvasSrc.previewHtml, canvasSrc.mainHtml)
          : canvasSrc.html
      const blob = new Blob([html], { type: 'text/html' })
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
      console.log('[rendre] onStreamUrl', { id, url })
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
        previewHtml: result.previewHtml,
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
      // Leave canvasSrc alone if we're already showing the streamed wrapper/stream,
      // so the user keeps their scroll position. If the stream never produced HTML
      // (e.g. model returned plain text), fall back to the extracted HTML.
      // If we're currently showing the streaming canvas, keep it — the wrapper page
      // already has all the content loaded in its DOM, and swapping would cause a
      // re-navigation flicker. Future selects will use turnCanvas to render from
      // saved data via the composed kind.
      setCanvasSrc((prev) => {
        if (prev?.kind === 'stream') return prev
        return turnCanvas(turn)
      })
      setGenerating(false)
      setGenId(null)
      setToolStatus(null)
      generationRef.current = null
    })

    const offError = window.rendre.onError((id, msg) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      setError(msg)
      // Drop skeleton/in-flight stream, restore prior turn if there was one
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

    const userPrompt = prompt
    setPrompt('')
    setGenerating(true)
    setToolStatus(null)
    setCanvasSrc({ kind: 'skeleton', html: skeletonHtml(userPrompt, config.provider) })

    try {
      const id = await window.rendre.startGenerate({
        prompt: userPrompt,
        history: conv.turns,
        provider: config.provider,
        model: config.model
      })
      generationRef.current = { id, conv, prompt: userPrompt }
      setGenId(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setGenerating(false)
      setCanvasSrc(null)
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
    if (turn) setCanvasSrc(turnCanvas(turn))
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
          <textarea
            className="input"
            placeholder="Ask anything — the answer will be a webpage."
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
          {generating ? (
            <button className="send cancel" onClick={cancelGeneration}>Stop</button>
          ) : (
            <button className="send" onClick={() => void sendPrompt()} disabled={!prompt.trim()}>
              Send
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
