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
