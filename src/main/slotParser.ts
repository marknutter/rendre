/**
 * Parses the orchestrator's HTML output to discover `[data-slot]` elements in
 * document order. We use a regex over the source rather than a real DOM parser
 * because (a) Electron main has no document, (b) we don't need the full parse,
 * and (c) the orchestrator's output is well-formed enough in practice.
 */
export interface SlotDef {
  name: string
  hint: string
}

export function parseSlots(html: string): SlotDef[] {
  const slots: SlotDef[] = []
  const seen = new Set<string>()
  // Match opening tags that include data-slot="..." — attribute order
  // independent, single or double quotes, allows other attrs in between.
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*?\bdata-slot\s*=\s*("([^"]+)"|'([^']+)')[^>]*)>/g
  for (const match of html.matchAll(tagRe)) {
    const attrs = match[2]
    const name = match[4] ?? match[5]
    if (!name) continue
    if (seen.has(name)) continue
    const hint = extractAttr(attrs, 'data-slot-hint') ?? ''
    seen.add(name)
    slots.push({ name, hint })
  }
  return slots
}

function extractAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const m = attrs.match(re)
  if (!m) return null
  return m[2] ?? m[3] ?? null
}

/**
 * Replace the inner contents of each [data-slot="name"] element with the
 * supplied HTML. Used to build the final, fully-filled HTML stored as the
 * conversation turn (so reload/scroll-back doesn't re-stream).
 */
export function fillSlotsInHtml(
  html: string,
  fills: Map<string, string>
): string {
  return html.replace(
    /(<([a-zA-Z][\w-]*)\b[^>]*?\bdata-slot\s*=\s*("([^"]+)"|'([^']+)')[^>]*>)([\s\S]*?)(<\/\2>)/g,
    (_full, openTag: string, _tagName: string, _quoted: string, dq: string | undefined, sq: string | undefined, _inner: string, closeTag: string) => {
      const slotName = dq ?? sq
      const fill = slotName ? fills.get(slotName) : undefined
      return openTag + (fill ?? '') + closeTag
    }
  )
}
