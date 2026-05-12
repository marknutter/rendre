export function skeletonHtml(prompt: string, providerLabel: string): string {
  const safePrompt = prompt
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 200)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>thinking…</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: #0e0e10;
    color: #e7e7ea;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  body {
    display: flex;
    flex-direction: column;
    padding: 56px 80px;
    gap: 28px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #8a8a92;
    font-size: 13px;
  }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #7c5cff;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .prompt {
    font-size: 22px;
    line-height: 1.35;
    color: #c8c8d0;
    font-weight: 500;
    max-width: 780px;
    border-left: 3px solid rgba(124,92,255,0.55);
    padding-left: 16px;
  }
  .block {
    background: linear-gradient(90deg, #1a1a20 0%, #24242c 50%, #1a1a20 100%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    border-radius: 10px;
  }
  .row { display: flex; gap: 16px; }
  .h1 { height: 38px; width: 60%; }
  .line { height: 14px; }
  .line.long { width: 95%; }
  .line.med { width: 78%; }
  .line.short { width: 45%; }
  .card { height: 140px; flex: 1; }
  .col { display: flex; flex-direction: column; gap: 10px; flex: 1; }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.1); }
  }
</style>
</head>
<body>
  <div class="meta">
    <span class="dot"></span>
    <span>${providerLabel} is composing a webpage…</span>
  </div>

  <div class="prompt">${safePrompt}</div>

  <div class="block h1"></div>

  <div class="col">
    <div class="block line long"></div>
    <div class="block line med"></div>
    <div class="block line long"></div>
    <div class="block line short"></div>
  </div>

  <div class="row">
    <div class="block card"></div>
    <div class="block card"></div>
    <div class="block card"></div>
  </div>

  <div class="col">
    <div class="block line med"></div>
    <div class="block line long"></div>
    <div class="block line short"></div>
  </div>
</body>
</html>`
}
