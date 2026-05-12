import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Conversation,
  ProviderConfig,
  Turn
} from '../../shared/types'
import { DEFAULT_CONFIG } from '../../shared/types'
import { Settings } from './Settings'
import './types'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function freshConversation(): Conversation {
  const now = Date.now()
  return { id: uid(), createdAt: now, updatedAt: now, title: 'New chat', turns: [] }
}

export function App() {
  const [config, setConfig] = useState<ProviderConfig>(DEFAULT_CONFIG)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const webviewRef = useRef<(HTMLElement & { src: string }) | null>(null)

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

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    if (!activeTurn) {
      wv.src = 'about:blank'
      return
    }
    const blob = new Blob([activeTurn.html], { type: 'text/html' })
    wv.src = URL.createObjectURL(blob)
  }, [activeTurn])

  async function persist(next: Conversation[]) {
    setConversations(next)
    await window.rendre.setHistory(next)
  }

  async function sendPrompt() {
    if (!prompt.trim() || generating) return
    setError(null)

    let conv = activeConv
    let convs = conversations
    if (!conv) {
      conv = freshConversation()
      conv.title = prompt.slice(0, 60)
      convs = [conv, ...conversations]
      setActiveConvId(conv.id)
    }

    const userPrompt = prompt
    setPrompt('')
    setGenerating(true)
    try {
      const res = await window.rendre.generate({
        prompt: userPrompt,
        history: conv.turns,
        provider: config.provider,
        model: config.model
      })
      const turn: Turn = {
        id: uid(),
        createdAt: Date.now(),
        prompt: userPrompt,
        html: res.html,
        provider: config.provider,
        model: config.model
      }
      const updatedConv: Conversation = {
        ...conv,
        updatedAt: Date.now(),
        title: conv.turns.length === 0 ? userPrompt.slice(0, 60) : conv.title,
        turns: [...conv.turns, turn]
      }
      const nextConvs = convs.map((c) => (c.id === conv!.id ? updatedConv : c))
      if (!convs.some((c) => c.id === conv!.id)) nextConvs.unshift(updatedConv)
      await persist(nextConvs)
      setActiveTurnId(turn.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  function newChat() {
    const conv = freshConversation()
    void persist([conv, ...conversations])
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
          {activeTurn ? (
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
                Try: <em>“Compare TypeScript and Rust for systems programming.”</em>
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
          <button className="send" onClick={() => void sendPrompt()} disabled={generating || !prompt.trim()}>
            {generating ? '…' : 'Send'}
          </button>
        </div>
        <div className="status">
          {config.provider} · {config.model} · ⌘↵ to send
        </div>
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
