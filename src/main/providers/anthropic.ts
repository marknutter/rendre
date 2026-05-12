import Anthropic from '@anthropic-ai/sdk'
import type { GenerateOptions, LLMProvider, ProviderResult } from './types'
import type { GenerateRequest } from '../../shared/types'
import { SYSTEM_PROMPT } from '../../shared/prompt'
import { extractHtml } from './extract'

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  async generate(
    req: GenerateRequest,
    apiKey: string,
    opts: GenerateOptions = {}
  ): Promise<ProviderResult> {
    const client = new Anthropic({ apiKey })

    // Build messages. Mark the last historic assistant turn with cache_control so
    // every multi-turn conversation gets a growing cache prefix (system + history).
    const messages: Anthropic.MessageParam[] = []
    const lastHistoricIdx = req.history.length - 1
    req.history.forEach((turn, i) => {
      messages.push({ role: 'user', content: turn.prompt })
      if (i === lastHistoricIdx) {
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: turn.html,
              cache_control: { type: 'ephemeral' }
            }
          ]
        })
      } else {
        messages.push({ role: 'assistant', content: turn.html })
      }
    })
    messages.push({ role: 'user', content: req.prompt })

    const stream = client.messages.stream(
      {
        model: req.model,
        max_tokens: 16000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages
      },
      { signal: opts.signal }
    )

    let fullText = ''
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        fullText += event.delta.text
        opts.onChunk?.(fullText)
      }
    }

    const final = await stream.finalMessage()
    return {
      html: extractHtml(fullText),
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: final.usage.cache_creation_input_tokens ?? 0
      }
    }
  }
}
