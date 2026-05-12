import keytar from 'keytar'
import type { ProviderId } from '../shared/types'

const SERVICE = 'rendre'

function account(provider: ProviderId): string {
  return `${provider}-api-key`
}

export function getKey(provider: ProviderId): Promise<string | null> {
  return keytar.getPassword(SERVICE, account(provider))
}

export function setKey(provider: ProviderId, key: string): Promise<void> {
  return keytar.setPassword(SERVICE, account(provider), key)
}

export async function hasKey(provider: ProviderId): Promise<boolean> {
  return Boolean(await keytar.getPassword(SERVICE, account(provider)))
}
