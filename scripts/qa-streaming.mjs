#!/usr/bin/env node
// Smoke-tests streaming + prompt caching on the Anthropic provider.
// Run two turns in the same "conversation"; the second turn should report
// cache_read_input_tokens > 0, proving prompt caching works.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/qa-streaming.mjs

import Anthropic from '@anthropic-ai/sdk'

const SYSTEM_PROMPT = `You are rendre — a chatbot whose every response is a complete, standalone HTML document. Respond ONLY with a complete HTML document starting with <!doctype html> and ending with </html>. No prose, no markdown, no code fences. Inline all CSS and JS. Dark theme by default. Make it visually rich.`

const key = process.env.ANTHROPIC_API_KEY
if (!key) {
  console.error('Set ANTHROPIC_API_KEY')
  process.exit(1)
}

const client = new Anthropic({ apiKey: key })

async function turn(history, userPrompt, label) {
  console.log(`\n--- ${label} ---`)
  const t0 = Date.now()
  let firstChunkAt = null
  let chunkCount = 0
  let fullText = ''

  const messages = []
  history.forEach((h, i) => {
    messages.push({ role: 'user', content: h.prompt })
    if (i === history.length - 1) {
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: h.html, cache_control: { type: 'ephemeral' } }
        ]
      })
    } else {
      messages.push({ role: 'assistant', content: h.html })
    }
  })
  messages.push({ role: 'user', content: userPrompt })

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
    ],
    messages
  })

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      if (firstChunkAt === null) firstChunkAt = Date.now() - t0
      chunkCount++
      fullText += event.delta.text
    }
  }
  const final = await stream.finalMessage()
  const total = Date.now() - t0
  console.log(`first chunk: ${firstChunkAt}ms`)
  console.log(`total: ${total}ms`)
  console.log(`chunks: ${chunkCount}`)
  console.log(`length: ${fullText.length} chars`)
  console.log(`usage:`, JSON.stringify(final.usage))
  return { html: fullText, usage: final.usage }
}

// First turn: should write cache (no read)
const t1 = await turn([], 'A flashcard for the Krebs cycle.', 'Turn 1 (fresh)')

// Second turn: cache_creation should fire once the prefix exceeds Anthropic's minimum
const t2 = await turn(
  [{ prompt: 'A flashcard for the Krebs cycle.', html: t1.html }],
  'Now make it for glycolysis, same visual style.',
  'Turn 2 (writes cache)'
)

// Third turn: should read cache from turn 2's write
const t3 = await turn(
  [
    { prompt: 'A flashcard for the Krebs cycle.', html: t1.html },
    { prompt: 'Now make it for glycolysis, same visual style.', html: t2.html }
  ],
  'Now electron transport chain, same style.',
  'Turn 3 (should hit cache)'
)

console.log('\n== Verdict ==')
const t2Write = t2.usage.cache_creation_input_tokens ?? 0
const t3Read = t3.usage.cache_read_input_tokens ?? 0
console.log(`Turn 2 cache_creation: ${t2Write} (expect > 0)`)
console.log(`Turn 3 cache_read: ${t3Read} (expect > 0)`)
if (t2Write > 0 && t3Read > 0) {
  console.log('PASS: streaming + caching both working.')
  process.exit(0)
} else {
  console.log('FAIL: caching not engaged as expected.')
  process.exit(1)
}
