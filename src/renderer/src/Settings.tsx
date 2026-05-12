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

  const models = provider === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS

  useEffect(() => {
    void window.rendre.hasKey(provider).then(setHasKey)
  }, [provider])

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
      const next: ProviderConfig = { ...config, provider, model }
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
