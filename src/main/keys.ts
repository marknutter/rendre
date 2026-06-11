import keytar from 'keytar'
import type { ProviderId } from '../shared/types'

const SERVICE = 'rendre'
const BRAVE_ACCOUNT = 'brave-api-key'

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

export function getBraveKey(): Promise<string | null> {
  return keytar.getPassword(SERVICE, BRAVE_ACCOUNT)
}

export function setBraveKey(key: string): Promise<void> {
  return keytar.setPassword(SERVICE, BRAVE_ACCOUNT, key)
}

export async function hasBraveKey(): Promise<boolean> {
  return Boolean(await keytar.getPassword(SERVICE, BRAVE_ACCOUNT))
}
