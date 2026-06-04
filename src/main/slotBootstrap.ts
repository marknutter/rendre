/**
 * Generates the inline <script> + <style> block appended to the orchestrator's
 * HTML output. The script:
 * - Opens an EventSource on the supplied stream id and routes events:
 *     * `append-region` → appends a new HTML region just before </body>
 *     * `slot-chunk`    → routes deltas to [data-slot="..."] elements
 *     * `slot-done`     → flips the slot's lifecycle class
 *     * `all-done`      → closes the EventSource
 * - Exposes the same routing function on `window.__rendreAttach(streamId)` so
 *   the renderer can re-attach for additive turns (each additive turn opens a
 *   new EventSource against a new stream id without navigating the iframe).
 */
export function slotBootstrap(streamId: string, baseUrl: string): string {
  const safeId = streamId.replace(/[^a-zA-Z0-9_-]/g, '')
  const safeBase = baseUrl.replace(/['"\\]/g, '')
  const script = `
(function(){
  if (window.__rendreAttach) {
    // Bootstrap already installed by a prior turn — just attach to the new stream.
    window.__rendreAttach('${safeId}');
    return;
  }
  var RENDRE_BASE_URL = '${safeBase}';

  var slotBuffers = Object.create(null);

  function cssEscape(s) {
    return String(s).replace(/["\\\\]/g, '\\\\$&');
  }

  function applySlot(slotName, buffer) {
    var el = document.querySelector('[data-slot="' + cssEscape(slotName) + '"]');
    if (!el) return;
    el.classList.add('rendre-filling');
    // Replace children + parse the full accumulated buffer each chunk.
    // Re-parsing on every chunk avoids the partial-tag accumulation problems
    // of incremental insertAdjacentHTML calls.
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', buffer);
  }

  function appendRegion(html) {
    if (typeof html !== 'string' || !html) return;
    // Append just before </body> so subsequent regions stack in arrival order
    // below the existing content.
    var anchor = document.body;
    if (!anchor) return;
    var template = document.createElement('template');
    template.innerHTML = html;
    anchor.appendChild(template.content);
  }

  function attach(id, opts) {
    // Absolute URL — works whether the iframe was loaded from the stream
    // server (first-pass) or a blob (post-onDone, additive turns).
    var baseUrl = (opts && opts.baseUrl) || RENDRE_BASE_URL;
    var es;
    try { es = new EventSource(baseUrl + '/stream/' + id + '/events'); }
    catch (e) { console.error('rendre: EventSource failed', e); return; }

    es.addEventListener('append-region', function (e) {
      try {
        var msg = JSON.parse(e.data);
        appendRegion(msg && msg.html);
      } catch (err) { console.error('rendre append-region error', err); }
    });

    es.addEventListener('slot-chunk', function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (!msg || !msg.slot) return;
        slotBuffers[msg.slot] = (slotBuffers[msg.slot] || '') + (msg.chunk || '');
        applySlot(msg.slot, slotBuffers[msg.slot]);
      } catch (err) { console.error('rendre slot-chunk error', err); }
    });

    es.addEventListener('slot-done', function (e) {
      try {
        var msg = JSON.parse(e.data);
        var el = document.querySelector('[data-slot="' + cssEscape(msg.slot) + '"]');
        if (!el) return;
        el.classList.remove('rendre-filling');
        el.classList.add('rendre-filled');
      } catch (err) { console.error('rendre slot-done error', err); }
    });

    es.addEventListener('all-done', function () { es.close(); });
    es.addEventListener('error', function () { /* will auto-reconnect */ });
  }

  window.__rendreAttach = attach;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { attach('${safeId}'); });
  } else {
    attach('${safeId}');
  }
})();
`.trim()

  // Subtle progress indicator while a slot is filling. The orchestrator is
  // responsible for the empty-slot shimmer (it's part of the page design); we
  // just nudge the visual state during fill and freeze it when done.
  const style = `
[data-slot].rendre-filling {
  position: relative;
}
[data-slot].rendre-filling::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, currentColor, transparent);
  opacity: 0.35;
  animation: rendre-fill-progress 1.4s linear infinite;
  pointer-events: none;
}
@keyframes rendre-fill-progress {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%);  }
}
[data-slot].rendre-filled,
[data-slot]:not(:empty):not(.rendre-filling) {
  animation: none !important;
  background: none !important;
}
`.trim()

  return `\n<style data-rendre-runtime>${style}</style>\n<script data-rendre-runtime>${script}</script>\n`
}
