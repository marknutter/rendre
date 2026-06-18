/**
 * generate_image tool — produces a new image inline in the response.
 *
 * Two backends:
 *   - DALL-E 3 (OpenAI, reuses the chat key, ~$0.04/1024². Returns b64 natively.)
 *   - Flux Schnell (Replicate, ~$0.003/image, ~5-10s. Returns a URL we fetch.)
 *
 * Storage / token-cost trick:
 * Returning a base64 data URL through the tool result would force the model to
 * echo ~200KB of base64 back to embed it — roughly $0.15-0.30/image in token
 * cost alone, dwarfing the actual gen cost. Instead we write the image bytes
 * to disk under userData/generated-images/<inputHash>.png and have the tool
 * return a short URL on rendre's local stream server. The model embeds that URL
 * in an <img src="..."> tag — small token footprint, persists across restarts,
 * and identical-input calls hit the cache automatically (same hash → same file).
 */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import OpenAI from 'openai'
import { getKey, getReplicateKey } from '../keys'
import { getBaseUrl } from '../streamServer'

export type ImageGenProvider = 'dall-e-3' | 'flux-schnell'

export interface GenerateImageInput {
  prompt: string
  width?: number
  height?: number
  style?: 'natural' | 'vivid'
}

export interface GenerateImageResult {
  url: string
  width: number
  height: number
  provider: ImageGenProvider
  cost_usd: number
  cached: boolean
}

const REPLICATE_TIMEOUT_MS = 60_000
const FLUX_SCHNELL_COST = 0.003
const DALLE3_COST_BY_SIZE: Record<string, number> = {
  '1024x1024': 0.04,
  '1792x1024': 0.08,
  '1024x1792': 0.08
}

function imagesDir(): string {
  return join(app.getPath('userData'), 'generated-images')
}

async function ensureImagesDir(): Promise<void> {
  await fs.mkdir(imagesDir(), { recursive: true })
}

function inputHash(provider: ImageGenProvider, params: Record<string, unknown>): string {
  const json = JSON.stringify({ provider, ...params })
  return createHash('sha256').update(json).digest('hex').slice(0, 32)
}

function urlForHash(hash: string): string {
  return `${getBaseUrl()}/generated-images/${hash}.png`
}

async function writePng(hash: string, bytes: Buffer): Promise<void> {
  await ensureImagesDir()
  await fs.writeFile(join(imagesDir(), `${hash}.png`), bytes)
}

async function existsPng(hash: string): Promise<boolean> {
  try {
    await fs.access(join(imagesDir(), `${hash}.png`))
    return true
  } catch {
    return false
  }
}

/**
 * Snap an arbitrary width/height to DALL-E 3's three allowed sizes. Pick the
 * aspect-ratio match closest to the requested dimensions.
 */
function dalle3Size(
  w: number | undefined,
  h: number | undefined
): '1024x1024' | '1792x1024' | '1024x1792' {
  if (!w || !h || w === h) return '1024x1024'
  const ratio = w / h
  if (ratio > 1.3) return '1792x1024'
  if (ratio < 0.77) return '1024x1792'
  return '1024x1024'
}

/**
 * Pick Flux Schnell aspect ratio from arbitrary width/height. Supported:
 * 1:1, 16:9, 21:9, 3:2, 2:3, 4:5, 5:4, 3:4, 4:3, 9:16, 9:21.
 */
function fluxAspectRatio(w: number | undefined, h: number | undefined): string {
  if (!w || !h) return '1:1'
  const ratio = w / h
  const choices: Array<[string, number]> = [
    ['1:1', 1],
    ['16:9', 16 / 9],
    ['21:9', 21 / 9],
    ['3:2', 3 / 2],
    ['4:3', 4 / 3],
    ['5:4', 5 / 4],
    ['4:5', 4 / 5],
    ['3:4', 3 / 4],
    ['2:3', 2 / 3],
    ['9:16', 9 / 16],
    ['9:21', 9 / 21]
  ]
  let best = '1:1'
  let bestDelta = Infinity
  for (const [name, value] of choices) {
    const delta = Math.abs(value - ratio)
    if (delta < bestDelta) {
      bestDelta = delta
      best = name
    }
  }
  return best
}

function fluxDimsForAspect(aspect: string): { width: number; height: number } {
  const [w, h] = aspect.split(':').map((n) => parseInt(n, 10))
  // Flux Schnell renders at megapixel resolution; we don't actually need the
  // exact px count for the tool result, just something sensible for the model
  // to know about. Use 1024 as the long side.
  if (w >= h) {
    return { width: 1024, height: Math.round((1024 * h) / w) }
  }
  return { width: Math.round((1024 * w) / h), height: 1024 }
}

async function callDalle3(
  input: GenerateImageInput,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; width: number; height: number; size: string }> {
  const client = new OpenAI({ apiKey })
  const size = dalle3Size(input.width, input.height)
  const [w, h] = size.split('x').map((n) => parseInt(n, 10))
  const response = await client.images.generate(
    {
      model: 'dall-e-3',
      prompt: input.prompt,
      n: 1,
      size,
      quality: 'standard',
      style: input.style ?? 'natural',
      response_format: 'b64_json'
    },
    { signal }
  )
  const b64 = response.data?.[0]?.b64_json
  if (!b64) throw new Error('DALL-E 3 returned no image data')
  return { bytes: Buffer.from(b64, 'base64'), width: w, height: h, size }
}

async function callFluxSchnell(
  input: GenerateImageInput,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; width: number; height: number; size: string }> {
  const aspect = fluxAspectRatio(input.width, input.height)
  const { width, height } = fluxDimsForAspect(aspect)

  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const timer = setTimeout(() => controller.abort(), REPLICATE_TIMEOUT_MS)

  try {
    const res = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Prefer:wait blocks until prediction completes (up to 60s) so we
        // don't have to poll.
        Prefer: 'wait=60'
      },
      body: JSON.stringify({
        input: {
          prompt: input.prompt,
          aspect_ratio: aspect,
          output_format: 'png',
          num_outputs: 1,
          num_inference_steps: 4
        }
      }),
      signal: controller.signal
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Flux Schnell: invalid or unauthorized Replicate API token')
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Flux Schnell: HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`)
    }
    const prediction = (await res.json()) as {
      status?: string
      output?: string | string[]
      error?: string | null
    }
    if (prediction.status === 'failed' || prediction.error) {
      throw new Error(`Flux Schnell: prediction failed — ${prediction.error ?? 'unknown error'}`)
    }
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output
    if (!outputUrl || typeof outputUrl !== 'string') {
      throw new Error('Flux Schnell: no output URL in response')
    }

    // Fetch the actual image bytes from Replicate's CDN.
    const imgRes = await fetch(outputUrl, { signal: controller.signal })
    if (!imgRes.ok) {
      throw new Error(`Flux Schnell: failed to fetch image (${imgRes.status})`)
    }
    const buf = Buffer.from(await imgRes.arrayBuffer())
    return { bytes: buf, width, height, size: `${width}x${height}` }
  } finally {
    clearTimeout(timer)
  }
}

export async function generateImage(
  input: GenerateImageInput,
  opts: {
    provider: ImageGenProvider
    signal?: AbortSignal
  }
): Promise<GenerateImageResult> {
  const prompt = (input.prompt ?? '').trim()
  if (!prompt) throw new Error('generate_image: prompt is required')

  const hash = inputHash(opts.provider, {
    prompt,
    width: input.width ?? null,
    height: input.height ?? null,
    style: input.style ?? null
  })

  if (await existsPng(hash)) {
    const cached = await readCachedMeta(hash, opts.provider, input)
    return { ...cached, url: urlForHash(hash), cached: true }
  }

  let result: { bytes: Buffer; width: number; height: number; size: string }
  let cost_usd = 0

  if (opts.provider === 'dall-e-3') {
    const apiKey = await getKey('openai')
    if (!apiKey) {
      throw new Error('generate_image: DALL-E 3 selected but no OpenAI API key is configured.')
    }
    result = await callDalle3(input, apiKey, opts.signal)
    cost_usd = DALLE3_COST_BY_SIZE[result.size] ?? 0.04
  } else if (opts.provider === 'flux-schnell') {
    const apiKey = await getReplicateKey()
    if (!apiKey) {
      throw new Error(
        'generate_image: Flux Schnell selected but no Replicate API token configured. Add one in Settings or switch provider to DALL-E 3.'
      )
    }
    result = await callFluxSchnell(input, apiKey, opts.signal)
    cost_usd = FLUX_SCHNELL_COST
  } else {
    throw new Error(`generate_image: unknown provider "${opts.provider}"`)
  }

  await writePng(hash, result.bytes)

  return {
    url: urlForHash(hash),
    width: result.width,
    height: result.height,
    provider: opts.provider,
    cost_usd,
    cached: false
  }
}

async function readCachedMeta(
  hash: string,
  provider: ImageGenProvider,
  _input: GenerateImageInput
): Promise<Omit<GenerateImageResult, 'url' | 'cached'>> {
  // We don't persist size metadata separately; for the cached path we don't
  // know the exact gen size, so we infer from inputs the same way the
  // generator would. Cost is reported as 0 because no generation happened.
  void hash
  const dims = _inferDimsForProvider(provider, _input)
  return {
    width: dims.width,
    height: dims.height,
    provider,
    cost_usd: 0
  }
}

function _inferDimsForProvider(
  provider: ImageGenProvider,
  input: GenerateImageInput
): { width: number; height: number } {
  if (provider === 'dall-e-3') {
    const [w, h] = dalle3Size(input.width, input.height).split('x').map((n) => parseInt(n, 10))
    return { width: w, height: h }
  }
  return fluxDimsForAspect(fluxAspectRatio(input.width, input.height))
}

export function formatGenerateImageResult(r: GenerateImageResult): string {
  return [
    'Generated image:',
    `  url: ${r.url}`,
    `  size: ${r.width}x${r.height}`,
    `  provider: ${r.provider}`,
    `  cost_usd: ${r.cost_usd.toFixed(4)}${r.cached ? ' (cached — no new charge)' : ''}`,
    '',
    'EMBED this image in your slot HTML via:',
    `  <img src="${r.url}" alt="<descriptive alt text>" width="${r.width}" height="${r.height}" loading="lazy"/>`,
    'Wrap in <figure> with <figcaption> if context matters. Do NOT base64-encode the URL — use it as-is.'
  ].join('\n')
}

export const GENERATE_IMAGE_TOOL = {
  name: 'generate_image',
  description:
    "Generate a new image (NOT a search) for inlining into the response. Use this for stylized illustrations, diagrams, hero art, and depictions of things that don't exist as photos (fictional characters, conceptual art, custom branding). For real-world subjects (animals, places, monuments, products, people, scientific photos) PREFER search_images — it's faster and free. After calling, embed the returned `url` directly in an <img src=\"...\"> tag — do NOT base64-encode it. Multiple calls with the same prompt are cached automatically. Budget: 3 calls per turn.",
  input_schema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description:
          'A detailed visual description of the image to generate. Be specific about subject, composition, style, lighting, mood.'
      },
      width: {
        type: 'integer',
        description: 'Desired width in pixels. Snapped to nearest supported size per provider.'
      },
      height: {
        type: 'integer',
        description: 'Desired height in pixels. Snapped to nearest supported size per provider.'
      },
      style: {
        type: 'string',
        enum: ['natural', 'vivid'],
        description: "DALL-E 3 only. 'natural' (less saturated, more realistic) or 'vivid' (default, hyper-real)."
      }
    },
    required: ['prompt']
  }
}
