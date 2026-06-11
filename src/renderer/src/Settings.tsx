import { useEffect, useState } from 'react'
import type { ProviderConfig, ProviderId } from '../../shared/types'
import { ANTHROPIC_MODELS, OPENAI_MODELS } from '../../shared/types'

interface Props {
  config: ProviderConfig
  onClose: () => void
  onSaved: (c: ProviderConfig) => void
}

export function Settings({ config, onClose, onSaved }: Props) {
  const [provider, setProvider] = useState<ProviderId>(config.provider)
  const [model, setModel] = useState(config.model)
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [useSlotDispatch, setUseSlotDispatch] = useState(config.useSlotDispatch)
  const [imageSearchEnabled, setImageSearchEnabled] = useState(
    config.imageSearchEnabled !== false
  )
  const [braveKey, setBraveKey] = useState('')
  const [hasBraveKey, setHasBraveKey] = useState(false)

  const models = provider === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS

  useEffect(() => {
    void window.rendre.hasKey(provider).then(setHasKey)
  }, [provider])

  useEffect(() => {
    void window.rendre.hasBraveKey().then(setHasBraveKey)
  }, [])

  useEffect(() => {
    if (!(models as readonly string[]).includes(model)) {
      setModel(models[0])
    }
  }, [provider, model, models])

  async function save() {
    setSaving(true)
    try {
      if (apiKey.trim()) {
        await window.rendre.setKey(provider, apiKey.trim())
      }
      if (braveKey.trim()) {
        await window.rendre.setBraveKey(braveKey.trim())
      }
      const next: ProviderConfig = {
        ...config,
        provider,
        model,
        useSlotDispatch,
        imageSearchEnabled
      }
      await window.rendre.setConfig(next)
      onSaved(next)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="field">
          <label>Provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>

        <div className="field">
          <label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            API key {hasKey && <span style={{ color: '#6fd16f' }}>(set — leave blank to keep)</span>}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
          />
        </div>

        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useSlotDispatch}
              onChange={(e) => setUseSlotDispatch(e.target.checked)}
              disabled={provider !== 'anthropic'}
            />
            <span>
              Use faster models on simple slots (experimental)
              {provider !== 'anthropic' && (
                <span style={{ color: '#888', marginLeft: 6, fontSize: 12 }}>
                  — Anthropic only for now
                </span>
              )}
            </span>
          </label>
          <p style={{ color: '#888', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
            When on, the orchestrator can promote individual sections of a response to a
            smarter model than your default. Best paired with Haiku as the default — the
            orchestrator handles routine sections with Haiku and escalates complex ones to
            Sonnet/Opus. Quality on a per-slot basis is not yet validated.
          </p>
        </div>

        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={imageSearchEnabled}
              onChange={(e) => setImageSearchEnabled(e.target.checked)}
            />
            <span>Enable web image search</span>
          </label>
          <p style={{ color: '#888', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
            When on, responses can inline images from Wikimedia Commons (free, CC-licensed)
            and Brave Search (requires a key below). Adds ~500ms when the model decides to
            search.
          </p>
        </div>

        <div className="field">
          <label>
            Brave Search API key{' '}
            {hasBraveKey && (
              <span style={{ color: '#6fd16f' }}>(set — leave blank to keep)</span>
            )}
            <span style={{ color: '#888', marginLeft: 6, fontSize: 12 }}>— optional</span>
          </label>
          <input
            type="password"
            value={braveKey}
            onChange={(e) => setBraveKey(e.target.value)}
            placeholder="Brave Search Subscription Token"
            disabled={!imageSearchEnabled}
          />
          <p style={{ color: '#888', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
            Brave covers everything Wikimedia doesn't (news, products, modern photography).
            Free tier: 2k queries/month. Get a key at{' '}
            <span style={{ fontFamily: 'monospace' }}>api.search.brave.com</span>. Without a
            Brave key, image search still works via Wikimedia only.
          </p>
        </div>

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>Cancel</button>
          <button className="send" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
