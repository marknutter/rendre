import { createServer, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { wrapperPageHtml } from '../shared/wrapper'

interface Slot {
  rawBuffer: string
  htmlOffset: number | null
  htmlEnd: number | null
  lastSent: number
  res: ServerResponse | null
  done: boolean
  closed: boolean
  onReady?: () => void
}

const slots = new Map<string, Slot>()
let port = 0

export function startStreamServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const composedMatch = req.url?.match(/^\/composed\/([^/?]+)/)
      if (composedMatch) {
        const id = composedMatch[1]
        serveComposed(id, res)
        return
      }
      const match = req.url?.match(/^\/gen\/([^/?]+)/)
      if (!match) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      const id = match[1]
      const slot = slots.get(id)
      if (!slot) {
        res.statusCode = 404
        res.end('unknown stream id')
        return
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')

      // Dump whatever we have buffered so far (truncated at </html> if seen)
      if (slot.htmlOffset !== null) {
        const end = slot.htmlEnd ?? slot.rawBuffer.length
        const available = slot.rawBuffer.slice(slot.htmlOffset, end)
        if (available) res.write(available)
        slot.lastSent = available.length
      }

      slot.res = res
      slot.closed = false

      if (slot.done) {
        res.end()
        return
      }

      req.on('close', () => {
        slot.closed = true
        slot.res = null
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      port = addr.port
      resolve(port)
    })
  })
}

function serveComposed(id: string, res: ServerResponse): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(
    wrapperPageHtml({
      preview: { src: `/gen/${id}:preview` },
      main: { src: `/gen/${id}` }
    })
  )
}

export function getComposedUrl(id: string): string {
  return `http://127.0.0.1:${port}/composed/${id}`
}

export function createSlot(id: string, onReady: () => void): void {
  slots.set(id, {
    rawBuffer: '',
    htmlOffset: null,
    htmlEnd: null,
    lastSent: 0,
    res: null,
    done: false,
    closed: false,
    onReady
  })
}

export function getStreamUrl(id: string): string {
  return `http://127.0.0.1:${port}/gen/${id}`
}

export function pushChunk(id: string, accumulated: string): void {
  const slot = slots.get(id)
  if (!slot) return

  slot.rawBuffer = accumulated

  // Detect HTML start once — but wait until paintable body content is buffered.
  // Models typically emit a large <head><style>…</style></head> before any body
  // text, and browsers won't paint anything until <body> content arrives. If we
  // navigate to the stream URL on first `<!doctype>`, the webview goes blank for
  // 20-30s while the head streams. Hold the skeleton until body content is here.
  if (slot.htmlOffset === null) {
    const stripped = accumulated.replace(/^\s*```(?:html)?\s*\n?/i, '')
    const startMatch = stripped.match(/<!doctype|<html|<body/i)
    const hasBodyContent = /<body[^>]*>[\s\S]{120,}/i.test(stripped)
    if (startMatch && startMatch.index !== undefined && hasBodyContent) {
      const offset = accumulated.length - stripped.length + startMatch.index
      slot.htmlOffset = offset
      slot.lastSent = 0
      slot.onReady?.()
    }
  }

  // Detect end of document once — keeps trailing ``` and other post-</html>
  // tokens from bleeding into the iframe.
  if (slot.htmlOffset !== null && slot.htmlEnd === null) {
    const tail = accumulated.slice(slot.htmlOffset)
    const m = tail.match(/<\/html\s*>/i)
    if (m && m.index !== undefined) {
      slot.htmlEnd = slot.htmlOffset + m.index + m[0].length
    }
  }

  // Push delta if connected
  if (slot.htmlOffset !== null && slot.res && !slot.closed) {
    const end = slot.htmlEnd ?? accumulated.length
    const available = accumulated.slice(slot.htmlOffset, end)
    const delta = available.slice(slot.lastSent)
    if (delta) {
      slot.res.write(delta)
      slot.lastSent = available.length
    }
  }
}

export function finishSlot(id: string): void {
  const slot = slots.get(id)
  if (!slot) return
  slot.done = true
  if (slot.res && !slot.closed) slot.res.end()
  // GC after 30s — gives the browser time to finish rendering if anyone reconnects
  setTimeout(() => slots.delete(id), 30_000)
}

export function failSlot(id: string): void {
  const slot = slots.get(id)
  if (!slot) return
  if (slot.res && !slot.closed) slot.res.end()
  slots.delete(id)
}
