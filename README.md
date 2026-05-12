# rendre

A desktop chatbot whose every response is a complete HTML page, not text.

Inspired by [Andrej Karpathy's framing](https://x.com/karpathy/status/2053872850101285137) of HTML as the next default output format for LLMs: raw text → markdown → HTML → interactive neural simulations. `rendre` is the simplest version of that step — ask anything, get back a self-contained webpage rendered full-screen.

> Hot tip: try asking your LLM to *"structure your response as HTML"*. `rendre` does that for you, every turn, with a system prompt tuned for visually rich, content-shaped responses.

## Status

v0.1 — pure chatbot. No filesystem or shell tools yet. v2 will turn it into a coding-agent harness that *also* renders HTML.

## Prerequisites

- Node.js 20+ and npm 10+
- An API key for **Anthropic**, **OpenAI**, or both. Keys are stored in the OS keychain via `keytar` — never written to disk in plaintext.

## Setup

```bash
npm install
npm run dev
```

On first launch the Settings dialog opens. Pick a provider, choose a model, and paste in an API key. The key is written to your OS keychain (macOS Keychain / Windows Credential Vault / libsecret on Linux).

## Build

```bash
npm run build        # bundle main + preload + renderer
npm run build:mac    # package a macOS .app (requires electron-builder)
npm run build:win
npm run build:linux
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Renderer (React + Vite)                                  │
│  ┌──────────┐   ┌─────────────────────────────────────┐  │
│  │ History  │   │  <webview>  loads response HTML     │  │
│  │ sidebar  │   │  via blob: URL, no sandbox          │  │
│  └──────────┘   └─────────────────────────────────────┘  │
│                  prompt input ↑                          │
└──────────────────────────────────────────────────────────┘
                          ↕ IPC (contextBridge)
┌──────────────────────────────────────────────────────────┐
│ Main process (Node)                                      │
│   LLMProvider abstraction                                │
│      ├── anthropic.ts  (@anthropic-ai/sdk)               │
│      └── openai.ts     (openai)                          │
│   Conversation store   → userData/history.json           │
│   Config store         → userData/config.json            │
│   API keys             → OS keychain via keytar          │
└──────────────────────────────────────────────────────────┘
```

The system prompt (`src/shared/prompt.ts`) instructs the model to respond with a complete `<!doctype html>` document, inline CSS/JS only, no external network references. The webview renders each response full-screen.

## Render model

Each response replaces the canvas — like a browser navigating to a new page. The left sidebar keeps history, so clicking a prior turn brings its HTML back. Within a conversation, the model sees the full prior turn HTML as context, so follow-ups like *"now make it dark mode"* or *"swap the chart for a table"* work.

## Security note

The webview runs **without** an iframe sandbox so that response HTML can use full interactivity (scripts, animations, mini-apps). The threat model assumes the LLM is non-adversarial. If you ever pipe untrusted content into a prompt, swap the `<webview>` in `src/renderer/src/App.tsx` for a sandboxed iframe.

## License

MIT
