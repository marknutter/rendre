import { createServer, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

interface SseEvent {
  type: string
  data: unknown
}

interface Slot {
  // Skeleton stream (orchestrator output → progressive HTML response).
  rawBuffer: string
  htmlOffset: number | null
  lastSent: number
  res: ServerResponse | null
  done: boolean
  closed: boolean
  onReady?: () => void

  // SSE channel (slot-fill events pushed to the page after first paint).
  sseRes: ServerResponse | null
  sseClosed: boolean
  pendingSseEvents: SseEvent[]
  sseOpened: boolean
  onSseConnected?: () => void
}

const slots = new Map<string, Slot>()
let port = 0

export function startStreamServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // SSE endpoint: /stream/:id/events
      const sseMatch = req.url?.match(/^\/stream\/([^/?]+)\/events/)
      if (sseMatch) {
        return handleSse(sseMatch[1], res)
      }
      // Skeleton stream: /stream/:id
      const streamMatch = req.url?.match(/^\/stream\/([^/?]+)\/?$/)
      if (streamMatch) {
        return handleStream(streamMatch[1], res)
      }
      res.statusCode = 404
      res.end('not found')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      port = addr.port
      resolve(port)
    })
  })
}

function handleStream(id: string, res: ServerResponse): void {
  const slot = slots.get(id)
  if (!slot) {
    res.statusCode = 404
    res.end('unknown stream id')
    return
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')

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

  res.on('close', () => {
    slot.closed = true
    slot.res = null
  })
}

function handleSse(id: string, res: ServerResponse): void {
  const slot = slots.get(id)
  if (!slot) {
    res.statusCode = 404
    res.end('unknown stream id')
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  // Comment line to open the stream
  res.write(': open\n\n')

  slot.sseRes = res
  slot.sseClosed = false
  slot.sseOpened = true

  // Flush any queued events
  for (const ev of slot.pendingSseEvents) {
    writeSseEvent(res, ev)
  }
  slot.pendingSseEvents = []

  res.on('close', () => {
    slot.sseClosed = true
    slot.sseRes = null
  })

  slot.onSseConnected?.()
}

function writeSseEvent(res: ServerResponse, ev: SseEvent): void {
  const payload = JSON.stringify(ev.data ?? {})
  res.write(`event: ${ev.type}\n`)
  res.write(`data: ${payload}\n\n`)
}

export function createSlot(id: string, onReady: () => void): void {
  slots.set(id, {
    rawBuffer: '',
    htmlOffset: null,
    lastSent: 0,
    res: null,
    done: false,
    closed: false,
    onReady,
    sseRes: null,
    sseClosed: false,
    pendingSseEvents: [],
    sseOpened: false
  })
}

export function getStreamUrl(id: string): string {
  return `http://127.0.0.1:${port}/stream/${id}`
}

export function pushChunk(id: string, accumulated: string): void {
  const slot = slots.get(id)
  if (!slot) return

  slot.rawBuffer = accumulated

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

  if (slot.htmlOffset !== null && slot.res && !slot.closed) {
    const available = accumulated.slice(slot.htmlOffset)
    const delta = available.slice(slot.lastSent)
    if (delta) {
      slot.res.write(delta)
      slot.lastSent = available.length
    }
  }
}

/**
 * Append a final HTML chunk (typically the SSE bootstrap script) to the stream
 * and write it to the connected browser before closing.
 */
export function appendAndFinish(id: string, finalChunk: string): void {
  const slot = slots.get(id)
  if (!slot) return

  // If the orchestrator never produced parseable HTML (early failure), force
  // detection now so the browser at least gets the appended chunk.
  if (slot.htmlOffset === null) {
    slot.htmlOffset = 0
    slot.lastSent = slot.rawBuffer.length
    slot.onReady?.()
  }

  slot.rawBuffer += finalChunk
  if (slot.res && !slot.closed) {
    slot.res.write(finalChunk)
    slot.lastSent = slot.rawBuffer.length - slot.htmlOffset
    slot.res.end()
  }
  slot.done = true
}

export function finishSlot(id: string): void {
  const slot = slots.get(id)
  if (!slot) return
  slot.done = true
  if (slot.res && !slot.closed) slot.res.end()
}

export function failSlot(id: string): void {
  const slot = slots.get(id)
  if (!slot) return
  if (slot.res && !slot.closed) slot.res.end()
  if (slot.sseRes && !slot.sseClosed) slot.sseRes.end()
  slots.delete(id)
}

export function getBuffer(id: string): string {
  return slots.get(id)?.rawBuffer ?? ''
}

/**
 * Send an SSE event. Queued if the EventSource hasn't connected yet.
 */
export function sendSseEvent(id: string, type: string, data: unknown): void {
  const slot = slots.get(id)
  if (!slot) return
  const ev: SseEvent = { type, data }
  if (slot.sseRes && !slot.sseClosed) {
    writeSseEvent(slot.sseRes, ev)
  } else {
    slot.pendingSseEvents.push(ev)
  }
}

export function closeSseChannel(id: string): void {
  const slot = slots.get(id)
  if (!slot) return
  if (slot.sseRes && !slot.sseClosed) slot.sseRes.end()
  slot.sseRes = null
  slot.sseClosed = true
}

/**
 * Wait for the page's EventSource to connect, or return immediately if it
 * already did. Used by the fill loop so the first events aren't queued
 * unnecessarily (queuing works, but live delivery is closer to streaming feel).
 */
export function waitForSse(id: string, timeoutMs = 10_000): Promise<void> {
  const slot = slots.get(id)
  if (!slot) return Promise.resolve()
  if (slot.sseOpened) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      slot.onSseConnected = undefined
      resolve()
    }, timeoutMs)
    slot.onSseConnected = () => {
      clearTimeout(timer)
      slot.onSseConnected = undefined
      resolve()
    }
  })
}

/**
 * Remove the slot after the page has had time to render. Called after all fills
 * are done and the SSE channel is closed.
 */
export function cleanupSlot(id: string, delayMs = 30_000): void {
  setTimeout(() => slots.delete(id), delayMs)
}
