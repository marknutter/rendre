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

    const stream = await client.chat.completions.create(
      {
        model: req.model,
        messages,
        max_tokens: 16000,
        stream: true,
        stream_options: { include_usage: true }
      },
      { signal: opts.signal }
    )

    let fullText = ''
    let usage: OpenAI.CompletionUsage | undefined
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) {
        fullText += delta
        opts.onChunk?.(fullText)
      }
      if (chunk.usage) usage = chunk.usage
    }

    return {
      html:
        req.isAdditive && req.history.length > 0
          ? extractRegion(fullText)
          : extractHtml(fullText),
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0
          }
        : undefined
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

    const stream = await client.chat.completions.create(
      {
        model: req.model,
        messages,
        max_tokens: 8000,
        stream: true,
        stream_options: { include_usage: true }
      },
      { signal: opts.signal }
    )

    let fullText = ''
    let usage: OpenAI.CompletionUsage | undefined
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) {
        fullText += delta
        opts.onChunk?.(fullText)
      }
      if (chunk.usage) usage = chunk.usage
    }

    return {
      html: stripSlotWrapper(fullText, req.slotName),
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0
          }
        : undefined
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
