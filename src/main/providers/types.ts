import type { GenerateRequest } from '../../shared/types'

export interface LLMProvider {
  id: string
  generate(req: GenerateRequest, apiKey: string): Promise<string>
}
