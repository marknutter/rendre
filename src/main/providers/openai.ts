import OpenAI from 'openai'
import type { GenerateOptions, LLMProvider, ProviderResult } from './types'
import type { GenerateRequest } from '../../shared/types'
import { SYSTEM_PROMPT } from '../../shared/prompt'
import { extractHtml } from './extract'

export const openaiProvider: LLMProvider = {
  id: 'openai',
  async generate(
    req: GenerateRequest,
    apiKey: string,
    opts: GenerateOptions = {}
  ): Promise<ProviderResult> {
    const client = new OpenAI({ apiKey })

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT }
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
      html: extractHtml(fullText),
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            cacheReadTokens:
              usage.prompt_tokens_details?.cached_tokens ?? 0
          }
        : undefined
    }
  }
}
