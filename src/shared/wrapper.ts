// Two-iframe wrapper page used by both the main process (served from
// streamServer for live streaming) and the renderer (built inline as a blob URL
// for saved-turn replay). Each iframe auto-resizes to its content height so the
// outer page scrolls as one continuous flow.

function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

export function wrapperPageHtml(args: {
  preview: { src?: string; srcdoc?: string }
  main: { src?: string; srcdoc?: string }
}): string {
  const attr = (a: { src?: string; srcdoc?: string }): string =>
    a.src ? `src="${attrEscape(a.src)}"` : `srcdoc="${attrEscape(a.srcdoc ?? '')}"`
  return `<!doctype html>
<html>
<head>
<meta name="color-scheme" content="light dark">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; min-height: 100%; background: Canvas; color: CanvasText; }
  iframe { display: block; width: 100%; border: 0; background: transparent; }
  iframe[data-rendre="preview"] { min-height: 0; }
  iframe[data-rendre="main"] { min-height: 200px; }
</style>
</head>
<body>
<iframe data-rendre="preview" ${attr(args.preview)} scrolling="no"></iframe>
<iframe data-rendre="main" ${attr(args.main)} scrolling="no"></iframe>
<script>
(function () {
  function resize(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (!doc || !doc.documentElement) return;
      var h = doc.documentElement.scrollHeight;
      if (!h) return;
      var current = parseFloat(iframe.style.height) || 0;
      if (Math.abs(current - h) > 4) iframe.style.height = h + 'px';
    } catch (e) {}
  }
  function track(iframe) {
    iframe.addEventListener('load', function () { resize(iframe); });
    var iv = setInterval(function () { resize(iframe); }, 200);
    setTimeout(function () { clearInterval(iv); }, 120000);
  }
  document.querySelectorAll('iframe').forEach(track);
})();
</script>
</body>
</html>`
}
