import type { ProviderId, SlotModelAlias } from '../shared/types'
import {
  ANTHROPIC_MODEL_BY_ALIAS,
  SLOT_MODEL_RANK
} from '../shared/types'

/**
 * Map a full Anthropic model ID to its alias tier, or null if the model is not
 * recognized. Matches on prefix so version bumps (claude-sonnet-4-7, etc.)
 * still resolve.
 */
export function anthropicModelToAlias(modelId: string): SlotModelAlias | null {
  if (modelId.startsWith('claude-haiku')) return 'haiku'
  if (modelId.startsWith('claude-sonnet')) return 'sonnet'
  if (modelId.startsWith('claude-opus')) return 'opus'
  return null
}

/**
 * Resolve the effective model ID for a slot fill.
 *
 * Rules:
 * - If dispatch is disabled, the slot alias is ignored and userModel is used.
 * - If provider is not Anthropic, userModel is used (cross-provider dispatch
 *   is out of scope for v1).
 * - If the slot alias is missing, unknown, or ranks LOWER than userModel
 *   (would demote), userModel is used.
 * - Otherwise the canonical model ID for the slot's alias is returned.
 */
export function resolveSlotModel(opts: {
  userModel: string
  provider: ProviderId
  dispatchEnabled: boolean
  slotAlias: SlotModelAlias | undefined
}): string {
  const { userModel, provider, dispatchEnabled, slotAlias } = opts
  if (!dispatchEnabled) return userModel
  if (provider !== 'anthropic') return userModel
  if (!slotAlias) return userModel

  const userAlias = anthropicModelToAlias(userModel)
  if (!userAlias) return userModel

  // Promote-only: reject demotion attempts.
  if (SLOT_MODEL_RANK[slotAlias] < SLOT_MODEL_RANK[userAlias]) return userModel

  return ANTHROPIC_MODEL_BY_ALIAS[slotAlias]
}
