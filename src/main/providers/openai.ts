import OpenAI from 'openai'
import type { LLMProvider } from './types'
import type { GenerateRequest } from '../../shared/types'
import { SYSTEM_PROMPT } from '../../shared/prompt'
import { extractHtml } from './extract'

export const openaiProvider: LLMProvider = {
  id: 'openai',
  async generate(req: GenerateRequest, apiKey: string): Promise<string> {
    const client = new OpenAI({ apiKey })

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT }
    ]
    for (const turn of req.history) {
      messages.push({ role: 'user', content: turn.prompt })
      messages.push({ role: 'assistant', content: turn.html })
    }
    messages.push({ role: 'user', content: req.prompt })

    const response = await client.chat.completions.create({
      model: req.model,
      messages,
      max_tokens: 16000
    })

    const text = response.choices[0]?.message?.content ?? ''
    return extractHtml(text)
  }
}
