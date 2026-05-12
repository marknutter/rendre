import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'

const MAX_CONTENT_CHARS = 40_000
const MAX_BODY_BYTES = 4_000_000
const TIMEOUT_MS = 15_000

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'swift', 'php', 'sh',
  'bash', 'zsh', 'yaml', 'yml', 'toml', 'md', 'sql', 'html', 'css', 'scss',
  'svelte', 'vue', 'lua', 'r', 'pl', 'pm', 'ex', 'exs', 'erl', 'fs', 'fsx',
  'dart', 'clj', 'cljs', 'elm', 'hs'
])

function rewriteGithubBlob(url: string): string {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
  if (!m) return url
  const [, owner, repo, ref, path] = m
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
}

function detectCodeExtension(url: string): string | null {
  const noQuery = url.split('?')[0].split('#')[0]
  const m = noQuery.match(/\.([a-z0-9]+)$/i)
  if (!m) return null
  const ext = m[1].toLowerCase()
  return CODE_EXTENSIONS.has(ext) ? ext : null
}

function withLineNumbers(text: string): string {
  const lines = text.split('\n')
  const pad = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(pad, ' ')}  ${line}`).join('\n')
}

export interface FetchUrlInput {
  url: string
}

export interface FetchUrlResult {
  url: string
  finalUrl: string
  contentType: string
  title?: string
  content: string
  truncated: boolean
  kind: 'code' | 'article' | 'raw'
  codeLanguage?: string
}

export async function fetchUrl(
  input: FetchUrlInput,
  signal?: AbortSignal
): Promise<FetchUrlResult> {
  const inputUrl = (input.url || '').trim()
  if (!/^https?:\/\//i.test(inputUrl)) {
    throw new Error(`URL must start with http:// or https:// — got: ${inputUrl}`)
  }
  const rewritten = rewriteGithubBlob(inputUrl)

  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(rewritten, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'rendre/0.1 (+https://github.com/marknutter/rendre)',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8'
      }
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BODY_BYTES) {
      throw new Error(`Response too large (${buf.byteLength} bytes, max ${MAX_BODY_BYTES})`)
    }
    const raw = new TextDecoder('utf-8').decode(buf)

    const codeExt = detectCodeExtension(rewritten)
    const looksLikeCode =
      codeExt !== null &&
      (contentType.startsWith('text/plain') ||
        contentType.startsWith('text/x-') ||
        contentType.startsWith('application/') ||
        contentType === '')

    if (looksLikeCode) {
      const numbered = withLineNumbers(raw)
      const truncated = numbered.length > MAX_CONTENT_CHARS
      return {
        url: inputUrl,
        finalUrl: res.url,
        contentType,
        content: truncated
          ? numbered.slice(0, MAX_CONTENT_CHARS) + '\n\n... [truncated, file longer than limit]'
          : numbered,
        truncated,
        kind: 'code',
        codeLanguage: codeExt!
      }
    }

    if (contentType.startsWith('text/html')) {
      try {
        const dom = new JSDOM(raw, { url: res.url })
        const reader = new Readability(dom.window.document)
        const article = reader.parse()
        if (article && article.textContent) {
          const text = article.textContent.replace(/\n{3,}/g, '\n\n').trim()
          const truncated = text.length > MAX_CONTENT_CHARS
          return {
            url: inputUrl,
            finalUrl: res.url,
            contentType,
            title: article.title || undefined,
            content: truncated
              ? text.slice(0, MAX_CONTENT_CHARS) + '\n\n... [truncated]'
              : text,
            truncated,
            kind: 'article'
          }
        }
      } catch {
        // fall through to raw
      }
    }

    const truncated = raw.length > MAX_CONTENT_CHARS
    return {
      url: inputUrl,
      finalUrl: res.url,
      contentType,
      content: truncated
        ? raw.slice(0, MAX_CONTENT_CHARS) + '\n\n... [truncated]'
        : raw,
      truncated,
      kind: 'raw'
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function formatFetchResult(r: FetchUrlResult): string {
  const header: string[] = [`URL: ${r.finalUrl}`, `Kind: ${r.kind}`]
  if (r.codeLanguage) header.push(`Language: ${r.codeLanguage}`)
  if (r.title) header.push(`Title: ${r.title}`)
  if (r.truncated) header.push(`Truncated: yes`)
  return `${header.join('\n')}\n---\n${r.content}`
}

export const FETCH_URL_TOOL = {
  name: 'fetch_url',
  description:
    'Fetch the text content of a public URL. Use this whenever the user references a webpage, article, or code file by URL — especially GitHub URLs. GitHub blob URLs (github.com/.../blob/...) are automatically resolved to raw source with line numbers. HTML articles are extracted via Readability. Returns up to ~40K chars. Call only once per distinct URL.',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The full URL to fetch. Must start with http:// or https://.'
      }
    },
    required: ['url']
  }
}
