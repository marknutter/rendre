import OpenAI from 'openai'
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
import { buildOpenAIToolList, createToolBudget, executeTool } from '../tools'

const MAX_TOOL_TURNS = 6

interface AccumulatedToolCall {
  id: string
  name: string
  arguments: string
}

export const openaiProvider: LLMProvider = {
  id: 'openai',

  async generate(
    req: GenerateRequest,
    apiKey: string,
    opts: GenerateOptions = {}
  ): Promise<ProviderResult> {
    const client = new OpenAI({ apiKey })

    const systemPrompt =
      req.isAdditive && req.history.length > 0
        ? ADDITIVE_ORCHESTRATOR_PROMPT
        : ORCHESTRATOR_PROMPT
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt }
    ]
    for (const turn of req.history) {
      messages.push({ role: 'user', content: turn.prompt })
      messages.push({ role: 'assistant', content: turn.html })
    }
    messages.push({ role: 'user', content: req.prompt })

    const budget = createToolBudget()
    const tools = buildOpenAIToolList({ imageSearchEnabled: opts.imageSearchEnabled })
    let fullText = ''
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = await client.chat.completions.create(
        {
          model: req.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: 16000,
          stream: true,
          stream_options: { include_usage: true }
        },
        { signal: opts.signal }
      )

      let turnText = ''
      const toolCalls = new Map<number, AccumulatedToolCall>()
      let finishReason: string | null = null
      let usage: OpenAI.CompletionUsage | undefined

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        const delta = choice?.delta
        if (delta?.content) {
          turnText += delta.content
          fullText += delta.content
          opts.onChunk?.(fullText)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            let acc = toolCalls.get(idx)
            if (!acc) {
              acc = { id: '', name: '', arguments: '' }
              toolCalls.set(idx, acc)
            }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) usage = chunk.usage
      }

      if (usage) {
        inputTokens += usage.prompt_tokens
        outputTokens += usage.completion_tokens
        cacheReadTokens += usage.prompt_tokens_details?.cached_tokens ?? 0
      }

      if (finishReason !== 'tool_calls' || toolCalls.size === 0) {
        break
      }

      // Roll back the text we accumulated this turn — it's pre-tool preamble.
      fullText = fullText.slice(0, fullText.length - turnText.length)
      opts.onChunk?.(fullText)

      const accumulated = Array.from(toolCalls.values())
      messages.push({
        role: 'assistant',
        content: turnText || null,
        tool_calls: accumulated.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments }
        }))
      })

      for (const t of accumulated) {
        let input: unknown = {}
        try {
          input = t.arguments ? JSON.parse(t.arguments) : {}
        } catch {
          input = {}
        }
        const result = await executeTool(t.name, input, budget, opts.signal, opts.onTool)
        messages.push({
          role: 'tool',
          tool_call_id: t.id,
          content: result.content
        })
      }
    }

    return {
      html:
        req.isAdditive && req.history.length > 0
          ? extractRegion(fullText)
          : extractHtml(fullText),
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens
      }
    }
  },

  async generateSlotFill(
    req: SlotFillRequest,
    apiKey: string,
    opts: GenerateOptions = {}
  ): Promise<SlotFillResult> {
    const client = new OpenAI({ apiKey })

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SLOT_FILL_PROMPT }
    ]
    for (const turn of req.history) {
      messages.push({ role: 'user', content: turn.prompt })
      messages.push({ role: 'assistant', content: turn.html })
    }
    messages.push({ role: 'user', content: req.prompt })
    messages.push({
      role: 'assistant',
      content: `Page skeleton for this turn:\n\n${req.skeleton}`
    })
    messages.push({
      role: 'user',
      content: `Fill the slot named "${req.slotName}". Hint: ${req.slotHint}\n\nOutput ONLY the inner HTML for this slot (no wrapping <section>, no <html>/<body>, no markdown).`
    })

    const budget = createToolBudget()
    const tools = buildOpenAIToolList({ imageSearchEnabled: opts.imageSearchEnabled })
    let fullText = ''
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = await client.chat.completions.create(
        {
          model: req.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: 8000,
          stream: true,
          stream_options: { include_usage: true }
        },
        { signal: opts.signal }
      )

      let turnText = ''
      const toolCalls = new Map<number, AccumulatedToolCall>()
      let finishReason: string | null = null
      let usage: OpenAI.CompletionUsage | undefined

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        const delta = choice?.delta
        if (delta?.content) {
          turnText += delta.content
          opts.onChunk?.(fullText + turnText)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            let acc = toolCalls.get(idx)
            if (!acc) {
              acc = { id: '', name: '', arguments: '' }
              toolCalls.set(idx, acc)
            }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) usage = chunk.usage
      }

      if (usage) {
        inputTokens += usage.prompt_tokens
        outputTokens += usage.completion_tokens
        cacheReadTokens += usage.prompt_tokens_details?.cached_tokens ?? 0
      }

      if (finishReason !== 'tool_calls' || toolCalls.size === 0) {
        fullText += turnText
        break
      }

      // Tool turn — discard preamble; the next turn's text replaces it.
      opts.onChunk?.(fullText)

      const accumulated = Array.from(toolCalls.values())
      messages.push({
        role: 'assistant',
        content: turnText || null,
        tool_calls: accumulated.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments }
        }))
      })

      for (const t of accumulated) {
        let input: unknown = {}
        try {
          input = t.arguments ? JSON.parse(t.arguments) : {}
        } catch {
          input = {}
        }
        const result = await executeTool(t.name, input, budget, opts.signal, opts.onTool)
        messages.push({
          role: 'tool',
          tool_call_id: t.id,
          content: result.content
        })
      }
    }

    return {
      html: stripSlotWrapper(fullText, req.slotName),
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens
      }
    }
  }
}

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
