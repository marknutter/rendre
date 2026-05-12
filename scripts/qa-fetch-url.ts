#!/usr/bin/env node
// Smoke test for the fetch_url tool. Runs in node (not electron) since the tool
// has no electron deps. Tests GitHub blob rewrite, code-with-line-numbers, and
// Readability article extraction.
//
// Usage: npx tsx scripts/qa-fetch-url.mjs

import { fetchUrl } from '../src/main/tools/fetchUrl'

const CASES = [
  {
    name: 'GitHub blob URL (TypeScript code)',
    url: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/main.ts',
    expect: (r) => {
      if (r.kind !== 'code') throw new Error(`expected kind=code, got ${r.kind}`)
      if (r.codeLanguage !== 'ts') throw new Error(`expected ts, got ${r.codeLanguage}`)
      if (!r.finalUrl.includes('raw.githubusercontent.com'))
        throw new Error(`expected raw URL rewrite, got ${r.finalUrl}`)
      if (!/^\s*\d+\s/m.test(r.content))
        throw new Error('expected line numbers in content')
    }
  },
  {
    name: 'HTML article (example.com)',
    url: 'https://example.com',
    expect: (r) => {
      if (r.kind !== 'article' && r.kind !== 'raw')
        throw new Error(`expected article|raw, got ${r.kind}`)
      if (!r.content.toLowerCase().includes('example'))
        throw new Error('expected "example" in content')
    }
  },
  {
    name: 'Raw text file',
    url: 'https://raw.githubusercontent.com/microsoft/TypeScript/main/README.md',
    expect: (r) => {
      if (r.kind !== 'code')
        throw new Error(`expected kind=code for .md, got ${r.kind}`)
    }
  },
  {
    name: 'Invalid URL (no scheme)',
    url: 'github.com/foo',
    shouldThrow: true
  },
  {
    name: '404',
    url: 'https://raw.githubusercontent.com/marknutter/rendre/main/does-not-exist.txt',
    shouldThrow: true
  }
]

async function main() {
  let passed = 0
  let failed = 0

  for (const c of CASES) {
    process.stdout.write(`▶ ${c.name} ... `)
    try {
      const result = await fetchUrl({ url: c.url })
      if (c.shouldThrow) {
        console.log('FAIL (expected throw)')
        failed++
        continue
      }
      c.expect?.(result)
      console.log(`OK (${result.kind}, ${result.content.length} chars${result.truncated ? ', truncated' : ''})`)
      passed++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (c.shouldThrow) {
        console.log(`OK (threw: ${msg})`)
        passed++
      } else {
        console.log(`FAIL: ${msg}`)
        failed++
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
