import { createServer, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

interface Slot {
  rawBuffer: string
  htmlOffset: number | null
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

      // Dump whatever we have buffered so far
      if (slot.htmlOffset !== null) {
        const available = slot.rawBuffer.slice(slot.htmlOffset)
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
  const mainUrl = `/gen/${id}`
  const previewUrl = `/gen/${id}:preview`
  res.end(composedWrapperHtml(mainUrl, previewUrl))
}

function composedWrapperHtml(mainPath: string, previewPath: string): string {
  return `<!doctype html>
<html>
<head>
<meta name="color-scheme" content="light dark">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; min-height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
</style>
</head>
<body>
<div id="rendre-preview"></div>
<div id="rendre-main"></div>
<script>
(function() {
  function strip(buf) {
    return buf
      .replace(/<!doctype[^>]*>/gi, '')
      .replace(/<\\/?html[^>]*>/gi, '')
      .replace(/<\\/?head[^>]*>/gi, '')
      .replace(/<\\/?body[^>]*>/gi, '');
  }
  async function streamInto(path, targetId) {
    if (!path) return;
    var target = document.getElementById(targetId);
    if (!target) return;
    try {
      var res = await fetch(path);
      if (!res.ok || !res.body) return;
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var emitted = 0;
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var stripped = strip(buf);
        if (stripped.length > emitted) {
          target.insertAdjacentHTML('beforeend', stripped.slice(emitted));
          emitted = stripped.length;
        }
      }
      buf += decoder.decode();
      var finalStripped = strip(buf);
      if (finalStripped.length > emitted) {
        target.insertAdjacentHTML('beforeend', finalStripped.slice(emitted));
      }
    } catch (e) {}
  }
  streamInto(${JSON.stringify(previewPath)}, 'rendre-preview');
  streamInto(${JSON.stringify(mainPath)}, 'rendre-main');
})();
</script>
</body>
</html>`
}

export function getComposedUrl(id: string): string {
  return `http://127.0.0.1:${port}/composed/${id}`
}

export function createSlot(id: string, onReady: () => void): void {
  slots.set(id, {
    rawBuffer: '',
    htmlOffset: null,
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

  // Push delta if connected
  if (slot.htmlOffset !== null && slot.res && !slot.closed) {
    const available = accumulated.slice(slot.htmlOffset)
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
