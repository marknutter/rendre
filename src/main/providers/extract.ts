export function extractHtml(text: string): string {
  const trimmed = text.trim()

  const fenceMatch = trimmed.match(/```(?:html)?\s*\n?([\s\S]*?)```/i)
  if (fenceMatch) return fenceMatch[1].trim()

  const docMatch = trimmed.match(/<!doctype[\s\S]*<\/html>/i)
  if (docMatch) return docMatch[0]

  const htmlMatch = trimmed.match(/<html[\s\S]*<\/html>/i)
  if (htmlMatch) {
    return `<!doctype html>\n${htmlMatch[0]}`
  }

  return `<!doctype html><html><body><pre style="white-space:pre-wrap;padding:24px;font-family:system-ui;color:#eee;background:#1a1a1a;margin:0;min-height:100vh">${escapeHtml(trimmed)}</pre></body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Extract an HTML *fragment* (not a full document) — used for additive
 * orchestrator output, which is an `<aside data-slot-region="...">...</aside>`
 * element. Strips code fences if the model wrapped its output in them; tries
 * to isolate the <aside> element; falls back to the trimmed text if neither
 * is detected (which would be a malformed response).
 */
export function extractRegion(text: string): string {
  const trimmed = text.trim()

  const fenceMatch = trimmed.match(/```(?:html)?\s*\n?([\s\S]*?)```/i)
  const body = fenceMatch ? fenceMatch[1].trim() : trimmed

  const asideMatch = body.match(/<aside[\s\S]*<\/aside>/i)
  if (asideMatch) return asideMatch[0]

  // Some other top-level element — accept it as long as it's a tag.
  if (/^<[a-zA-Z]/.test(body)) return body

  // Genuinely broken output — wrap it so something visible appears.
  return `<aside data-slot-region="follow-up" style="padding:24px;border:1px dashed #888;border-radius:8px;margin-top:24px"><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(body)}</pre></aside>`
}
