/**
 * search_images tool — finds web images for inlining into rendered HTML.
 *
 * Two backends:
 *   - Wikimedia Commons (no key, CC-licensed, ideal for educational/historical/
 *     scientific subjects). Free, hotlinkable.
 *   - Brave Search Image API (requires API key; covers everything Wikimedia
 *     doesn't — news, products, modern photography).
 *
 * `auto` routing uses a keyword heuristic that prefers Wikimedia for queries
 * that read educational/historical/scientific, otherwise Brave. Falls back to
 * the other source on empty results.
 */

import { getBraveKey } from '../keys'

const WIKIMEDIA_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/images/search'
const TIMEOUT_MS = 12_000

export type ImageSource = 'wikimedia' | 'brave'

export interface SearchImagesInput {
  query: string
  count?: number
  source?: ImageSource | 'auto'
}

export interface ImageCandidate {
  url: string
  thumbnail_url: string
  alt: string
  width: number
  height: number
  source: ImageSource
  source_page_url: string
  license: string
  author?: string
}

export interface SearchImagesResult {
  query: string
  source_used: ImageSource | 'auto-empty'
  candidates: ImageCandidate[]
}

const EDUCATIONAL_HINTS = [
  // Sciences & academia
  'evolution',
  'biology',
  'chemistry',
  'physics',
  'mathematics',
  'astronomy',
  'galaxy',
  'nebula',
  'planet',
  'anatomy',
  'mitochondria',
  'cell',
  'protein',
  'molecule',
  'crystal',
  'mineral',
  'fossil',
  'dinosaur',
  'species',
  // History & geography
  'history',
  'ancient',
  'medieval',
  'renaissance',
  'roman',
  'greek',
  'egyptian',
  'dynasty',
  'empire',
  'revolution',
  'war',
  'battle',
  'castle',
  'cathedral',
  'monument',
  'ruin',
  // Arts (canonical)
  'painting',
  'sculpture',
  'museum',
  'baroque',
  'impressionist',
  // Common Wikimedia subjects
  'jwst',
  'nasa',
  'hubble',
  'apollo'
]

/**
 * Naive heuristic: does the query look "educational/encyclopedic"?
 * Two signals: presence of an educational hint word, OR ≥2 capitalized
 * non-stop words (proper nouns are a strong signal for Wikipedia subjects).
 */
function looksEducational(query: string): boolean {
  const lower = query.toLowerCase()
  for (const hint of EDUCATIONAL_HINTS) {
    if (lower.includes(hint)) return true
  }
  const STOP = new Set([
    'the',
    'a',
    'an',
    'of',
    'and',
    'or',
    'is',
    'was',
    'in',
    'on',
    'to',
    'from',
    'how',
    'why',
    'what'
  ])
  const tokens = query.split(/\s+/).filter(Boolean)
  let capCount = 0
  for (const t of tokens) {
    const stripped = t.replace(/[^\w]/g, '')
    if (!stripped) continue
    if (STOP.has(stripped.toLowerCase())) continue
    if (/^[A-Z]/.test(stripped)) capCount++
  }
  return capCount >= 2
}

function clampCount(count: number | undefined): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 4
  return Math.max(1, Math.min(8, Math.floor(count)))
}

function timeoutFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

/**
 * Wikimedia Commons search via the MediaWiki API.
 *
 * Two-step flow: `generator=search` over the File namespace, then `prop=imageinfo`
 * to pull the actual image URL, thumbnail, dimensions, and `extmetadata` for
 * license + author. This is the documented Commons hotlinking pattern.
 */
async function searchWikimedia(
  query: string,
  count: number,
  signal?: AbortSignal
): Promise<ImageCandidate[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: String(count),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata|mime',
    iiurlwidth: '600',
    origin: '*'
  })

  const res = await timeoutFetch(
    `${WIKIMEDIA_ENDPOINT}?${params.toString()}`,
    {
      headers: {
        'User-Agent': 'rendre/0.1 (+https://github.com/marknutter/rendre)',
        Accept: 'application/json'
      }
    },
    signal
  )

  if (!res.ok) {
    throw new Error(`Wikimedia: HTTP ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as {
    query?: {
      pages?: Array<{
        title: string
        imageinfo?: Array<{
          url: string
          thumburl?: string
          width: number
          height: number
          mime?: string
          extmetadata?: Record<string, { value: string }>
        }>
      }>
    }
  }

  const pages = json.query?.pages ?? []
  const out: ImageCandidate[] = []
  for (const page of pages) {
    const info = page.imageinfo?.[0]
    if (!info) continue
    // Skip non-image media (audio, video, PDFs, SVGs that may not render reliably).
    if (info.mime && !info.mime.startsWith('image/')) continue
    if (info.mime === 'image/svg+xml') continue
    const meta = info.extmetadata ?? {}
    const stripHtml = (s: string): string =>
      s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const license =
      stripHtml(meta.LicenseShortName?.value ?? meta.License?.value ?? '') || 'Wikimedia Commons'
    const author = stripHtml(meta.Artist?.value ?? '') || undefined
    const description = stripHtml(meta.ImageDescription?.value ?? '') || page.title
    const titleSlug = page.title.replace(/^File:/, '').replace(/_/g, ' ')
    out.push({
      url: info.url,
      thumbnail_url: info.thumburl ?? info.url,
      alt: description || titleSlug,
      width: info.width,
      height: info.height,
      source: 'wikimedia',
      source_page_url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
      license,
      author
    })
  }
  return out
}

/**
 * Brave Search Image API.
 *
 * Returns results from across the web; we prefer the Brave-CDN-cached thumbnail
 * URL for hotlink robustness (some original hosts block hot referers).
 */
async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
  signal?: AbortSignal
): Promise<ImageCandidate[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
    safesearch: 'strict'
  })
  const res = await timeoutFetch(
    `${BRAVE_ENDPOINT}?${params.toString()}`,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey
      }
    },
    signal
  )

  if (res.status === 401 || res.status === 403) {
    throw new Error('Brave: invalid or unauthorized API key')
  }
  if (res.status === 429) {
    throw new Error('Brave: rate limited (free tier 2k/month exhausted?)')
  }
  if (!res.ok) {
    throw new Error(`Brave: HTTP ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as {
    results?: Array<{
      title?: string
      url?: string
      source?: string
      thumbnail?: { src?: string }
      properties?: { url?: string; placeholder?: string }
      meta_url?: { hostname?: string }
    }>
  }

  const results = json.results ?? []
  const out: ImageCandidate[] = []
  for (const r of results) {
    const original = r.properties?.url ?? r.url ?? ''
    const thumb = r.thumbnail?.src ?? r.properties?.placeholder ?? original
    if (!original && !thumb) continue
    out.push({
      url: original || thumb,
      thumbnail_url: thumb || original,
      alt: r.title ?? '',
      // Brave doesn't return reliable dimensions; leave as 0 and let the page render naturally.
      width: 0,
      height: 0,
      source: 'brave',
      source_page_url: r.url ?? '',
      license: 'Brave Search',
      author: r.meta_url?.hostname || r.source
    })
  }
  return out
}

export async function searchImages(
  input: SearchImagesInput,
  signal?: AbortSignal
): Promise<SearchImagesResult> {
  const query = (input.query ?? '').trim()
  if (!query) throw new Error('search_images: query is required')
  const count = clampCount(input.count)
  const requested = input.source ?? 'auto'

  const braveKey = await getBraveKey()

  // Explicit source overrides
  if (requested === 'wikimedia') {
    const candidates = await searchWikimedia(query, count, signal)
    return { query, source_used: 'wikimedia', candidates }
  }
  if (requested === 'brave') {
    if (!braveKey) {
      throw new Error(
        'search_images: source=brave requested but no Brave API key is configured. Set one in Settings or use source=wikimedia / source=auto.'
      )
    }
    const candidates = await searchBrave(query, count, braveKey, signal)
    return { query, source_used: 'brave', candidates }
  }

  // auto routing: educational queries → Wikimedia first; everything else → Brave first.
  // Empty results fall through to the other source.
  const tryWikimediaFirst = looksEducational(query) || !braveKey
  if (tryWikimediaFirst) {
    const wiki = await searchWikimedia(query, count, signal)
    if (wiki.length > 0) return { query, source_used: 'wikimedia', candidates: wiki }
    if (braveKey) {
      const brave = await searchBrave(query, count, braveKey, signal)
      return {
        query,
        source_used: brave.length > 0 ? 'brave' : 'auto-empty',
        candidates: brave
      }
    }
    return { query, source_used: 'auto-empty', candidates: [] }
  } else {
    const brave = await searchBrave(query, count, braveKey!, signal)
    if (brave.length > 0) return { query, source_used: 'brave', candidates: brave }
    const wiki = await searchWikimedia(query, count, signal)
    return {
      query,
      source_used: wiki.length > 0 ? 'wikimedia' : 'auto-empty',
      candidates: wiki
    }
  }
}

export function formatSearchImagesResult(r: SearchImagesResult): string {
  if (r.candidates.length === 0) {
    return `No images found for query "${r.query}" (source: ${r.source_used}).`
  }
  const header = `Image search results for "${r.query}" (source: ${r.source_used})\n`
  const lines = r.candidates.map((c, i) => {
    const parts = [
      `[${i + 1}] ${c.alt || '(no description)'}`,
      `  url: ${c.url}`,
      `  thumbnail_url: ${c.thumbnail_url}`,
      `  dimensions: ${c.width}x${c.height}`,
      `  source: ${c.source}`,
      `  source_page_url: ${c.source_page_url}`,
      `  license: ${c.license}`
    ]
    if (c.author) parts.push(`  author: ${c.author}`)
    return parts.join('\n')
  })
  return header + '\n' + lines.join('\n\n')
}

export const SEARCH_IMAGES_TOOL = {
  name: 'search_images',
  description:
    "Search the web for images to inline in the response. Use this whenever the response would benefit from a real-world image (educational subjects, products, places, people, scientific imagery, illustrations). Returns 4 candidates by default with url, thumbnail_url, alt text, dimensions, source, license, and author. PICK one or more and embed via <figure><img src=\"...\" alt=\"...\"/><figcaption>...</figcaption></figure>. When the source is 'wikimedia', the figcaption MUST credit author + license (e.g., 'Image: <author>, <license>'). Prefer thumbnail_url for Brave results (better hotlink reliability). Use source='auto' (default) — it picks Wikimedia for educational/historical queries and Brave otherwise.",
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query (subject of the desired image).'
      },
      count: {
        type: 'integer',
        description: 'Number of candidates to return (1-8). Default 4.'
      },
      source: {
        type: 'string',
        enum: ['wikimedia', 'brave', 'auto'],
        description:
          "Image source. 'auto' (default) routes by query type. 'wikimedia' is free + CC-licensed. 'brave' requires a configured API key."
      }
    },
    required: ['query']
  }
}
