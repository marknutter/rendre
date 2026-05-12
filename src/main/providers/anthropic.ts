import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider } from './types'
import type { GenerateRequest } from '../../shared/types'
import { SYSTEM_PROMPT } from '../../shared/prompt'
import { extractHtml } from './extract'

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  async generate(req: GenerateRequest, apiKey: string): Promise<string> {
    const client = new Anthropic({ apiKey })

    const messages: Anthropic.MessageParam[] = []
    for (const turn of req.history) {
      messages.push({ role: 'user', content: turn.prompt })
      messages.push({ role: 'assistant', content: turn.html })
    }
    messages.push({ role: 'user', content: req.prompt })

    const response = await client.messages.create({
      model: req.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages
    })

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    return extractHtml(text)
  }
}
