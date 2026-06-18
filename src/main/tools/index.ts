/**
 * Shared tool definitions + executor. Both the Anthropic and OpenAI providers
 * route tool calls through `executeTool`, which:
 *   - Enforces per-tool per-turn budgets (separate counters).
 *   - Caches identical (tool, input) invocations within a turn.
 *   - Emits onTool start/done/error events for the streaming UI.
 *   - Returns a serialized string result the provider hands back to the model.
 */

import type { ToolUseEvent } from '../../shared/types'
import {
  FETCH_URL_TOOL,
  fetchUrl,
  formatFetchResult,
  type FetchUrlInput
} from './fetchUrl'
import {
  SEARCH_IMAGES_TOOL,
  searchImages,
  formatSearchImagesResult,
  type SearchImagesInput
} from './searchImages'
import {
  GENERATE_IMAGE_TOOL,
  generateImage,
  formatGenerateImageResult,
  type GenerateImageInput,
  type ImageGenProvider
} from './generateImage'

export const MAX_FETCH_URL_CALLS = 5
export const MAX_IMAGE_SEARCH_CALLS = 5
export const MAX_IMAGE_GEN_CALLS = 3

export interface ToolBudget {
  fetchUrl: number
  searchImages: number
  imageGen: number
  imageGenCostUsd: number
  cache: Map<string, string>
}

export function createToolBudget(): ToolBudget {
  return {
    fetchUrl: 0,
    searchImages: 0,
    imageGen: 0,
    imageGenCostUsd: 0,
    cache: new Map()
  }
}

type AnyTool =
  | typeof FETCH_URL_TOOL
  | typeof SEARCH_IMAGES_TOOL
  | typeof GENERATE_IMAGE_TOOL

export function buildToolList(opts: {
  imageSearchEnabled?: boolean
  imageGenEnabled?: boolean
}): AnyTool[] {
  const tools: AnyTool[] = [FETCH_URL_TOOL]
  if (opts.imageSearchEnabled) tools.push(SEARCH_IMAGES_TOOL)
  if (opts.imageGenEnabled) tools.push(GENERATE_IMAGE_TOOL)
  return tools
}

/**
 * OpenAI's Chat Completions API uses a slightly different tool envelope
 * ({type:'function', function:{name, description, parameters}}) but the same
 * underlying JSON schema. Convert from the Anthropic-style tool defs.
 */
export function buildOpenAIToolList(opts: {
  imageSearchEnabled?: boolean
  imageGenEnabled?: boolean
}): Array<{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}> {
  const src = buildToolList(opts)
  return src.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Record<string, unknown>
    }
  }))
}

export interface ExecuteToolResult {
  content: string
  isError: boolean
}

export interface ExecuteToolOpts {
  signal?: AbortSignal
  onTool?: (event: ToolUseEvent) => void
  /** Which provider to use for generate_image (required if the tool is offered). */
  imageGenProvider?: ImageGenProvider
}

/**
 * Run a tool by name. Hidden inside: budget enforcement, in-turn caching,
 * onTool event emission. Always resolves (no throws) — errors come back as
 * { isError: true, content: 'Error: ...' } so providers can hand the message
 * back to the model and let it recover.
 */
export async function executeTool(
  name: string,
  input: unknown,
  budget: ToolBudget,
  opts: ExecuteToolOpts
): Promise<ExecuteToolResult> {
  const { signal, onTool } = opts
  const cacheKey = name + ':' + JSON.stringify(input ?? {})
  const cached = budget.cache.get(cacheKey)
  if (cached !== undefined) {
    // Return cached result silently — no onTool event, since the model already saw it.
    return { content: cached, isError: false }
  }

  if (name === 'fetch_url') {
    if (budget.fetchUrl >= MAX_FETCH_URL_CALLS) {
      const msg = `Error: fetch_url budget exceeded (max ${MAX_FETCH_URL_CALLS} per turn). Compose with what you have.`
      onTool?.({ type: 'error', tool: name, input, error: 'budget exceeded' })
      return { content: msg, isError: true }
    }
    budget.fetchUrl++
    onTool?.({ type: 'start', tool: name, input })
    try {
      const result = await fetchUrl(input as FetchUrlInput, signal)
      const formatted = formatFetchResult(result)
      budget.cache.set(cacheKey, formatted)
      onTool?.({ type: 'done', tool: name, input })
      return { content: formatted, isError: false }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      onTool?.({ type: 'error', tool: name, input, error: errMsg })
      return { content: `Error: ${errMsg}`, isError: true }
    }
  }

  if (name === 'search_images') {
    if (budget.searchImages >= MAX_IMAGE_SEARCH_CALLS) {
      const msg = `Error: search_images budget exceeded (max ${MAX_IMAGE_SEARCH_CALLS} per turn). Compose with what you have.`
      onTool?.({ type: 'error', tool: name, input, error: 'budget exceeded' })
      return { content: msg, isError: true }
    }
    budget.searchImages++
    onTool?.({ type: 'start', tool: name, input })
    try {
      const result = await searchImages(input as SearchImagesInput, signal)
      const formatted = formatSearchImagesResult(result)
      budget.cache.set(cacheKey, formatted)
      onTool?.({ type: 'done', tool: name, input })
      return { content: formatted, isError: false }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      onTool?.({ type: 'error', tool: name, input, error: errMsg })
      return { content: `Error: ${errMsg}`, isError: true }
    }
  }

  if (name === 'generate_image') {
    if (budget.imageGen >= MAX_IMAGE_GEN_CALLS) {
      const msg = `Error: generate_image budget exceeded (max ${MAX_IMAGE_GEN_CALLS} per turn). Compose with what you have.`
      onTool?.({ type: 'error', tool: name, input, error: 'budget exceeded' })
      return { content: msg, isError: true }
    }
    if (!opts.imageGenProvider) {
      const msg =
        'Error: image generation provider not configured. Open Settings → choose DALL-E 3 or Flux Schnell.'
      onTool?.({ type: 'error', tool: name, input, error: 'no provider' })
      return { content: msg, isError: true }
    }
    budget.imageGen++
    onTool?.({ type: 'start', tool: name, input })
    try {
      const result = await generateImage(input as GenerateImageInput, {
        provider: opts.imageGenProvider,
        signal
      })
      budget.imageGenCostUsd += result.cost_usd
      const formatted = formatGenerateImageResult(result)
      budget.cache.set(cacheKey, formatted)
      onTool?.({
        type: 'done',
        tool: name,
        input: { ...(input as Record<string, unknown>), cost_usd: result.cost_usd }
      })
      return { content: formatted, isError: false }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      onTool?.({ type: 'error', tool: name, input, error: errMsg })
      return { content: `Error: ${errMsg}`, isError: true }
    }
  }

  onTool?.({ type: 'error', tool: name, error: `Unknown tool: ${name}` })
  return { content: `Unknown tool: ${name}`, isError: true }
}
