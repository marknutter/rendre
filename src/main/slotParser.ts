import type { SlotModelAlias } from '../shared/types'
import { SLOT_MODEL_ALIASES } from '../shared/types'

/**
 * Parses the orchestrator's HTML output to discover `[data-slot]` elements in
 * document order. We use a regex over the source rather than a real DOM parser
 * because (a) Electron main has no document, (b) we don't need the full parse,
 * and (c) the orchestrator's output is well-formed enough in practice.
 */
export interface SlotDef {
  name: string
  hint: string
  /** Optional orchestrator-declared model alias for this slot (promote-only). */
  modelAlias?: SlotModelAlias
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
    const rawAlias = extractAttr(attrs, 'data-slot-model')?.toLowerCase()
    const modelAlias = rawAlias && (SLOT_MODEL_ALIASES as readonly string[]).includes(rawAlias)
      ? (rawAlias as SlotModelAlias)
      : undefined
    seen.add(name)
    slots.push({ name, hint, modelAlias })
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
 * Locate a single named slot inside an HTML document and return its metadata
 * plus its current inner contents. Used for iteration: the iterate-slot
 * handler needs the slot's original hint + current content as context for the
 * refill, and its declared modelAlias (if any) to honor dispatch settings.
 */
export interface SlotInfo extends SlotDef {
  innerHtml: string
}

export function getSlotInfo(html: string, slotName: string): SlotInfo | null {
  const escaped = slotName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const re = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b([^>]*?\\bdata-slot\\s*=\\s*("${escaped}"|'${escaped}')[^>]*)>([\\s\\S]*?)</\\1>`
  )
  const m = html.match(re)
  if (!m) return null
  const attrs = m[2]
  const innerHtml = m[4]
  const hint = extractAttr(attrs, 'data-slot-hint') ?? ''
  const rawAlias = extractAttr(attrs, 'data-slot-model')?.toLowerCase()
  const modelAlias = rawAlias && (SLOT_MODEL_ALIASES as readonly string[]).includes(rawAlias)
    ? (rawAlias as SlotModelAlias)
    : undefined
  return { name: slotName, hint, modelAlias, innerHtml }
}

/**
 * Insert an additive region just before the closing </body> tag of the prior
 * page's HTML. Falls back to appending at the end if no </body> tag is found
 * (which shouldn't happen for well-formed orchestrator output but isn't fatal).
 */
export function mergeRegionIntoHtml(priorHtml: string, region: string): string {
  const idx = priorHtml.toLowerCase().lastIndexOf('</body>')
  if (idx === -1) return priorHtml + '\n' + region
  return priorHtml.slice(0, idx) + region + '\n' + priorHtml.slice(idx)
}

/**
 * Replace the inner contents of `[data-slot]` elements with the supplied HTML.
 *
 * Slots PRESENT in `fills` get their inner contents replaced (empty string is
 * a valid replacement and clears the slot — used when a fill returned no
 * content). Slots NOT PRESENT in `fills` keep their existing inner content
 * untouched. This is what enables iteration assembly: pass a one-entry map
 * `{ slotName → newContent }` to rebuild a turn's HTML with only that slot
 * refilled, leaving every other slot's content as it was.
 */
export function fillSlotsInHtml(
  html: string,
  fills: Map<string, string>
): string {
  return html.replace(
    /(<([a-zA-Z][\w-]*)\b[^>]*?\bdata-slot\s*=\s*("([^"]+)"|'([^']+)')[^>]*>)([\s\S]*?)(<\/\2>)/g,
    (_full, openTag: string, _tagName: string, _quoted: string, dq: string | undefined, sq: string | undefined, inner: string, closeTag: string) => {
      const slotName = dq ?? sq
      if (!slotName || !fills.has(slotName)) {
        return openTag + inner + closeTag
      }
      return openTag + (fills.get(slotName) ?? '') + closeTag
    }
  )
}
