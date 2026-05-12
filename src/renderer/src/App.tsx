import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Conversation,
  ProviderConfig,
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

function partialAsHtml(text: string): string | null {
  const stripped = text.replace(/^\s*```(?:html)?\s*\n?/i, '').trim()
  if (!/<!doctype|<html|<body/i.test(stripped)) return null
  return stripped
}

const RENDER_THROTTLE_MS = 120

export function App() {
  const [config, setConfig] = useState<ProviderConfig>(DEFAULT_CONFIG)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genId, setGenId] = useState<string | null>(null)
  const [pendingHtml, setPendingHtml] = useState<string | null>(null)
  const [lastUsage, setLastUsage] = useState<UsageStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const webviewRef = useRef<(HTMLElement & { src: string }) | null>(null)
  const lastBlobUrlRef = useRef<string | null>(null)
  const lastRenderAtRef = useRef(0)
  const pendingRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Refs for stream callbacks to avoid stale closures
  const generationRef = useRef<{
    id: string
    conv: Conversation
    prompt: string
    isNewConv: boolean
  } | null>(null)

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
        if (lastTurn) setActiveTurnId(lastTurn.id)
      }
      const hasKey = await window.rendre.hasKey(cfg.provider)
      if (!hasKey) setSettingsOpen(true)
    })()
  }, [])

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeConvId) ?? null,
    [conversations, activeConvId]
  )
  const activeTurn = useMemo(
    () => activeConv?.turns.find((t) => t.id === activeTurnId) ?? null,
    [activeConv, activeTurnId]
  )

  const displayHtml = pendingHtml ?? activeTurn?.html ?? null

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    if (!displayHtml) {
      wv.src = 'about:blank'
      return
    }
    const blob = new Blob([displayHtml], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    wv.src = url
    if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current)
    lastBlobUrlRef.current = url
  }, [displayHtml])

  // Subscribe to streaming events
  useEffect(() => {
    const offChunk = window.rendre.onChunk((id, text) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      const htmlSlice = partialAsHtml(text)
      if (!htmlSlice) return // still showing skeleton
      // Throttle blob URL refresh
      const now = Date.now()
      const elapsed = now - lastRenderAtRef.current
      if (elapsed >= RENDER_THROTTLE_MS) {
        lastRenderAtRef.current = now
        setPendingHtml(htmlSlice)
      } else {
        if (pendingRenderTimerRef.current) clearTimeout(pendingRenderTimerRef.current)
        pendingRenderTimerRef.current = setTimeout(() => {
          lastRenderAtRef.current = Date.now()
          setPendingHtml(htmlSlice)
        }, RENDER_THROTTLE_MS - elapsed)
      }
    })

    const offDone = window.rendre.onDone((id, result) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      if (pendingRenderTimerRef.current) {
        clearTimeout(pendingRenderTimerRef.current)
        pendingRenderTimerRef.current = null
      }
      const { conv, prompt: userPrompt, isNewConv } = generationRef.current
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
        } else if (isNewConv) {
          next = [updated, ...prev]
        } else {
          next = [updated, ...prev]
        }
        void window.rendre.setHistory(next)
        return next
      })
      setActiveTurnId(turn.id)
      if (result.usage) setLastUsage(result.usage)
      setPendingHtml(null)
      setGenerating(false)
      setGenId(null)
      generationRef.current = null
    })

    const offError = window.rendre.onError((id, msg) => {
      if (!generationRef.current || generationRef.current.id !== id) return
      setError(msg)
      setPendingHtml(null)
      setGenerating(false)
      setGenId(null)
      generationRef.current = null
    })

    return () => {
      offChunk()
      offDone()
      offError()
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
    let isNewConv = false
    if (!conv) {
      conv = freshConversation()
      conv.title = prompt.slice(0, 60)
      isNewConv = true
      setActiveConvId(conv.id)
      // optimistically place new conv at top so sidebar reflects state
      await persistConversations([conv, ...conversations])
    }

    const userPrompt = prompt
    setPrompt('')
    setGenerating(true)
    setPendingHtml(skeletonHtml(userPrompt, config.provider))
    lastRenderAtRef.current = 0

    try {
      const id = await window.rendre.startGenerate({
        prompt: userPrompt,
        history: conv.turns,
        provider: config.provider,
        model: config.model
      })
      generationRef.current = { id, conv, prompt: userPrompt, isNewConv }
      setGenId(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setGenerating(false)
      setPendingHtml(null)
    }
  }

  function cancelGeneration() {
    if (genId) void window.rendre.cancelGenerate(genId)
  }

  function newChat() {
    const conv = freshConversation()
    void persistConversations([conv, ...conversations])
    setActiveConvId(conv.id)
    setActiveTurnId(null)
  }

  const turnsForSidebar = activeConv?.turns ?? []

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">rendre</span>
          <div className="sidebar-actions">
            <button className="icon-btn" onClick={newChat} title="New chat">+</button>
            <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
          </div>
        </div>
        <div className="turn-list">
          {conversations.map((c) => (
            <div key={c.id} style={{ marginBottom: 8 }}>
              <button
                className={`turn-item ${c.id === activeConvId ? 'active' : ''}`}
                onClick={() => {
                  setActiveConvId(c.id)
                  const last = c.turns[c.turns.length - 1]
                  setActiveTurnId(last?.id ?? null)
                }}
                style={{ fontWeight: 500 }}
              >
                {c.title || 'Untitled'}
              </button>
              {c.id === activeConvId && turnsForSidebar.map((t, i) => (
                <button
                  key={t.id}
                  className={`turn-item ${t.id === activeTurnId ? 'active' : ''}`}
                  onClick={() => setActiveTurnId(t.id)}
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
          {displayHtml ? (
            // @ts-expect-error webview is an Electron-only element
            <webview ref={webviewRef as never} allowpopups="true" />
          ) : (
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
        <StatusBar config={config} usage={lastUsage} generating={generating} />
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
  generating
}: {
  config: ProviderConfig
  usage: UsageStats | null
  generating: boolean
}) {
  const cacheLabel =
    usage && (usage.cacheReadTokens || usage.cacheCreationTokens)
      ? ` · cache ${usage.cacheReadTokens ?? 0}r/${usage.cacheCreationTokens ?? 0}w`
      : ''
  const usageLabel = usage
    ? ` · ${usage.inputTokens}in/${usage.outputTokens}out${cacheLabel}`
    : ''
  return (
    <div className="status">
      {config.provider} · {config.model}
      {usageLabel}
      {generating ? ' · streaming…' : ' · ⌘↵ to send'}
    </div>
  )
}
