#!/usr/bin/env node
// Smoke-tests the Anthropic + OpenAI providers end-to-end against the live API.
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/qa-provider.mjs anthropic
//   OPENAI_API_KEY=sk-... node scripts/qa-provider.mjs openai
//
// Validates that:
//   - the API call succeeds
//   - the response extracts to recognizable HTML (starts with <!doctype or <html)
//   - the HTML is a non-trivial size

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { writeFileSync } from 'fs'

const SYSTEM_PROMPT = `You are rendre — a chatbot whose every response is a complete, standalone HTML document.

RULES:
1. Respond ONLY with a complete HTML document. Start with <!doctype html> and end with </html>.
2. No prose, no markdown, no code fences, no commentary outside the HTML.
3. Make it visually rich: layout, typography, color, hierarchy.
4. Use inline <style> for all CSS. Inline <script> if interactivity helps. Inline <svg> for diagrams.
5. Never reference external URLs. Everything inline or data: URLs.
6. Default to a dark, easy-on-eyes theme unless content suggests otherwise.

You are NOT writing documentation about HTML. You ARE the HTML.`

function extractHtml(text) {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:html)?\s*\n?([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  const doc = trimmed.match(/<!doctype[\s\S]*<\/html>/i)
  if (doc) return doc[0]
  const html = trimmed.match(/<html[\s\S]*<\/html>/i)
  if (html) return `<!doctype html>\n${html[0]}`
  return null
}

const PROMPTS = [
  'A flashcard for the Krebs cycle.',
  'Compare TypeScript and Rust for systems programming, as a side-by-side table.',
  'A pomodoro timer I can use right now.'
]

async function runAnthropic(key) {
  const client = new Anthropic({ apiKey: key })
  const results = []
  for (const p of PROMPTS) {
    const t0 = Date.now()
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: p }]
    })
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('')
    const html = extractHtml(text)
    const ms = Date.now() - t0
    results.push({ prompt: p, ms, html, raw: text, usage: resp.usage })
  }
  return results
}

async function runOpenAI(key) {
  const client = new OpenAI({ apiKey: key })
  const results = []
  for (const p of PROMPTS) {
    const t0 = Date.now()
    const resp = await client.chat.completions.create({
      model: 'gpt-5',
      max_tokens: 16000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: p }
      ]
    })
    const text = resp.choices[0]?.message?.content ?? ''
    const html = extractHtml(text)
    const ms = Date.now() - t0
    results.push({ prompt: p, ms, html, raw: text, usage: resp.usage })
  }
  return results
}

const provider = process.argv[2] ?? 'anthropic'
const key = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY
if (!key) {
  console.error(`Set ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}`)
  process.exit(1)
}

console.log(`\n== rendre QA: ${provider} ==\n`)
const results = provider === 'anthropic' ? await runAnthropic(key) : await runOpenAI(key)

let pass = 0
results.forEach((r, i) => {
  const ok = r.html && r.html.length > 200
  if (ok) pass++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] (${(r.ms / 1000).toFixed(1)}s, ${r.html?.length ?? 0} chars) ${r.prompt}`)
  if (!ok) {
    console.log(`  raw start: ${r.raw.slice(0, 200)}`)
  }
  if (r.usage) {
    console.log(`  usage: ${JSON.stringify(r.usage)}`)
  }
  if (r.html) {
    const path = `/tmp/rendre-qa-${provider}-${i + 1}.html`
    writeFileSync(path, r.html)
    console.log(`  saved: ${path}`)
  }
})

console.log(`\n${pass}/${results.length} passed\n`)
process.exit(pass === results.length ? 0 : 1)
