import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Conversation, ProviderConfig } from '../shared/types'
import { DEFAULT_CONFIG, HAIKU_MODEL } from '../shared/types'

function historyPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export async function loadConversations(): Promise<Conversation[]> {
  try {
    const raw = await fs.readFile(historyPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveConversations(conversations: Conversation[]): Promise<void> {
  await fs.writeFile(historyPath(), JSON.stringify(conversations, null, 2), 'utf8')
}

export async function loadConfig(): Promise<ProviderConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const merged: ProviderConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
    if (merged.provider === 'anthropic' && merged.model === HAIKU_MODEL) {
      merged.model = DEFAULT_CONFIG.model
    }
    return merged
  } catch {
    return DEFAULT_CONFIG
  }
}

export async function saveConfig(config: ProviderConfig): Promise<void> {
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
}
