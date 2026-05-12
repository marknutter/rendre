import Anthropic from '@anthropic-ai/sdk'
import type { GenerateOptions, LLMProvider, ProviderResult } from './types'
import type { GenerateRequest } from '../../shared/types'
import { HAIKU_MODEL } from '../../shared/types'
import { SYSTEM_PROMPT, PREVIEW_SYSTEM_PROMPT } from '../../shared/prompt'
import { extractHtml } from './extract'
import {
  FETCH_URL_TOOL,
  fetchUrl,
  formatFetchResult,
  type FetchUrlInput
} from '../tools/fetchUrl'

const MAX_TOOL_TURNS = 6
const MAX_TOOL_CALLS_MAIN = 5
const MAX_TOOL_CALLS_PREVIEW = 2

interface RunStreamArgs {
  client: Anthropic
  model: string
  systemPrompt: string
  req: GenerateRequest
  opts: GenerateOptions
  maxTokens: number
  maxToolCalls: number
  includeHistory: boolean
}

async function runAnthropicStream({
  client,
  model,
  systemPrompt,
  req,
  opts,
  maxTokens,
  maxToolCalls,
  includeHistory
}: RunStreamArgs): Promise<ProviderResult> {
  const messages: Anthropic.MessageParam[] = []
  if (includeHistory) {
    const lastHistoricIdx = req.history.length - 1
    req.history.forEach((turn, i) => {
      messages.push({ role: 'user', content: turn.prompt })
      if (i === lastHistoricIdx) {
        messages.push({
          role: 'assistant',
          content: [
            { type: 'text', text: turn.html, cache_control: { type: 'ephemeral' } }
          ]
        })
      } else {
        messages.push({ role: 'assistant', content: turn.html })
      }
    })
  }
  messages.push({ role: 'user', content: req.prompt })

  let fullText = ''
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheCreation = 0
  let toolCallsMade = 0

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ],
        tools: [FETCH_URL_TOOL],
        messages
      },
      { signal: opts.signal }
    )

    const pendingTools: Array<{ id: string; name: string; jsonBuf: string }> = []
    let currentToolIdx: number | null = null

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          pendingTools.push({
            id: event.content_block.id,
            name: event.content_block.name,
            jsonBuf: ''
          })
          currentToolIdx = pendingTools.length - 1
        } else {
          currentToolIdx = null
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          fullText += event.delta.text
          opts.onChunk?.(fullText)
        } else if (
          event.delta.type === 'input_json_delta' &&
          currentToolIdx !== null
        ) {
          pendingTools[currentToolIdx].jsonBuf += event.delta.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        currentToolIdx = null
      }
    }

    const finalMsg = await stream.finalMessage()
    totalInput += finalMsg.usage.input_tokens
    totalOutput += finalMsg.usage.output_tokens
    totalCacheRead += finalMsg.usage.cache_read_input_tokens ?? 0
    totalCacheCreation += finalMsg.usage.cache_creation_input_tokens ?? 0

    if (finalMsg.stop_reason !== 'tool_use' || pendingTools.length === 0) {
      break
    }

    messages.push({ role: 'assistant', content: finalMsg.content })

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const t of pendingTools) {
      let input: unknown = {}
      try {
        input = t.jsonBuf ? JSON.parse(t.jsonBuf) : {}
      } catch {
        input = {}
      }

      if (toolCallsMade >= maxToolCalls) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: t.id,
          content: `Error: tool-call budget exceeded (max ${maxToolCalls} per turn). Compose the response with what you have.`,
          is_error: true
        })
        continue
      }
      toolCallsMade++

      opts.onTool?.({ type: 'start', tool: t.name, input })
      try {
        if (t.name === 'fetch_url') {
          const result = await fetchUrl(input as FetchUrlInput, opts.signal)
          opts.onTool?.({ type: 'done', tool: t.name, input })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: t.id,
            content: formatFetchResult(result)
          })
        } else {
          opts.onTool?.({
            type: 'error',
            tool: t.name,
            error: `Unknown tool: ${t.name}`
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: t.id,
            content: `Unknown tool: ${t.name}`,
            is_error: true
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        opts.onTool?.({ type: 'error', tool: t.name, input, error: msg })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: t.id,
          content: `Error: ${msg}`,
          is_error: true
        })
      }
    }

    messages.push({ role: 'user', content: toolResults })
  }

  return {
    html: extractHtml(fullText),
    usage: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation
    }
  }
}

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  generate(req, apiKey, opts = {}) {
    return runAnthropicStream({
      client: new Anthropic({ apiKey }),
      model: req.model,
      systemPrompt: SYSTEM_PROMPT,
      req,
      opts,
      maxTokens: 16000,
      maxToolCalls: MAX_TOOL_CALLS_MAIN,
      includeHistory: true
    })
  },
  generatePreview(req, apiKey, opts = {}) {
    return runAnthropicStream({
      client: new Anthropic({ apiKey }),
      model: HAIKU_MODEL,
      systemPrompt: PREVIEW_SYSTEM_PROMPT,
      req,
      opts,
      maxTokens: 1500,
      maxToolCalls: MAX_TOOL_CALLS_PREVIEW,
      includeHistory: true
    })
  }
}
