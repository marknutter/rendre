import Anthropic from '@anthropic-ai/sdk'
import type {
  GenerateOptions,
  LLMProvider,
  ProviderResult,
  SlotFillRequest,
  SlotFillResult
} from './types'
import type { GenerateRequest } from '../../shared/types'
import {
  ADDITIVE_ORCHESTRATOR_PROMPT,
  ORCHESTRATOR_PROMPT,
  SLOT_FILL_PROMPT
} from '../../shared/prompt'
import { extractHtml, extractRegion } from './extract'
import { buildToolList, createToolBudget, executeTool } from '../tools'

const MAX_TOOL_TURNS = 6

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',

  async generate(
    req: GenerateRequest,
    apiKey: string,
    opts: GenerateOptions = {}
  ): Promise<ProviderResult> {
    const client = new Anthropic({ apiKey })

    const messages: Anthropic.MessageParam[] = []
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
    messages.push({ role: 'user', content: req.prompt })

    let fullText = ''
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheCreation = 0
    const budget = createToolBudget()

    const systemPrompt =
      req.isAdditive && req.history.length > 0
        ? ADDITIVE_ORCHESTRATOR_PROMPT
        : ORCHESTRATOR_PROMPT

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: 16000,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ],
          tools: buildToolList({
            imageSearchEnabled: opts.imageSearchEnabled,
            imageGenEnabled: opts.imageGenEnabled
          }),
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
        const result = await executeTool(t.name, input, budget, {
          signal: opts.signal,
          onTool: opts.onTool,
          imageGenProvider: opts.imageGenProvider
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: t.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {})
        })
      }

      messages.push({ role: 'user', content: toolResults })
    }

    return {
      html:
        req.isAdditive && req.history.length > 0
          ? extractRegion(fullText)
          : extractHtml(fullText),
      usage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheCreationTokens: totalCacheCreation
      }
    }
  },

  async generateSlotFill(
    req: SlotFillRequest,
    apiKey: string,
    opts: GenerateOptions = {}
  ): Promise<SlotFillResult> {
    const client = new Anthropic({ apiKey })

    // Build a self-contained context: original conversation history (so the model
    // knows what's been said), then the user's prompt + the orchestrator's skeleton
    // as a cached prefix so multiple slot fills in the same turn hit the cache.
    const messages: Anthropic.MessageParam[] = []
    for (const turn of req.history) {
      messages.push({ role: 'user', content: turn.prompt })
      messages.push({ role: 'assistant', content: turn.html })
    }
    messages.push({ role: 'user', content: req.prompt })
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `Page skeleton for this turn:\n\n${req.skeleton}`,
          cache_control: { type: 'ephemeral' }
        }
      ]
    })
    messages.push({
      role: 'user',
      content: `Fill the slot named "${req.slotName}". Hint: ${req.slotHint}\n\nOutput ONLY the inner HTML for this slot (no wrapping <section>, no <html>/<body>, no markdown).`
    })

    const budget = createToolBudget()
    let fullText = ''
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheCreationTokens = 0

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: 8000,
          system: [
            {
              type: 'text',
              text: SLOT_FILL_PROMPT,
              cache_control: { type: 'ephemeral' }
            }
          ],
          tools: buildToolList({
            imageSearchEnabled: opts.imageSearchEnabled,
            imageGenEnabled: opts.imageGenEnabled
          }),
          messages
        },
        { signal: opts.signal }
      )

      // Buffer this turn's text separately. Only commit to fullText if the turn
      // ends without a tool call — otherwise the text is pre-tool preamble we
      // should discard (the post-tool turn re-emits the actual slot content).
      let turnText = ''
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
            turnText += event.delta.text
            opts.onChunk?.(fullText + turnText)
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
      inputTokens += finalMsg.usage.input_tokens
      outputTokens += finalMsg.usage.output_tokens
      cacheReadTokens += finalMsg.usage.cache_read_input_tokens ?? 0
      cacheCreationTokens += finalMsg.usage.cache_creation_input_tokens ?? 0

      if (finalMsg.stop_reason !== 'tool_use' || pendingTools.length === 0) {
        fullText += turnText
        break
      }

      // Tool turn: discard the preamble text from the streamed view by re-emitting
      // just what we'd already committed. The next turn's text replaces it.
      opts.onChunk?.(fullText)

      messages.push({ role: 'assistant', content: finalMsg.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const t of pendingTools) {
        let input: unknown = {}
        try {
          input = t.jsonBuf ? JSON.parse(t.jsonBuf) : {}
        } catch {
          input = {}
        }
        const result = await executeTool(t.name, input, budget, {
          signal: opts.signal,
          onTool: opts.onTool,
          imageGenProvider: opts.imageGenProvider
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: t.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {})
        })
      }
      messages.push({ role: 'user', content: toolResults })
    }

    return {
      html: stripSlotWrapper(fullText, req.slotName),
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens
      }
    }
  }
}

// Defensive strip in case the model wraps its output in a <section data-slot> despite the prompt.
function stripSlotWrapper(text: string, slotName: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:html)?\s*\n?([\s\S]*?)```/i)
  const body = fence ? fence[1].trim() : trimmed
  const wrap = body.match(
    new RegExp(
      `^<section[^>]*data-slot=["']${slotName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)</section>\\s*$`,
      'i'
    )
  )
  return wrap ? wrap[1] : body
}
