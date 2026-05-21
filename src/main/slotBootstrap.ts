/**
 * Generates the inline <script> + <style> block appended to the orchestrator's
 * HTML output. It opens an EventSource on /stream/:id/events, routes
 * `slot-chunk` deltas into the matching [data-slot] element by re-parsing the
 * accumulated buffer for that slot (avoids the partial-tag accumulation
 * problems of incremental insertAdjacentHTML calls), and applies CSS state
 * classes for the empty / filling / filled lifecycle.
 */
export function slotBootstrap(streamId: string): string {
  const safeId = streamId.replace(/[^a-zA-Z0-9_-]/g, '')
  const script = `
(function(){
  if (window.__rendreSlotsInit) return;
  window.__rendreSlotsInit = true;

  var slotBuffers = Object.create(null);

  function applySlot(slotName, buffer) {
    var el = document.querySelector('[data-slot="' + cssEscape(slotName) + '"]');
    if (!el) return;
    el.classList.add('rendre-filling');
    // Replace children + parse the full accumulated buffer each chunk.
    // Re-parsing on every chunk is wasteful for huge slots, but it's correct
    // (partial tags never linger as broken trees) and the prototype can absorb
    // the cost. Optimize later by debouncing if needed.
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', buffer);
  }

  function attach() {
    var es;
    try { es = new EventSource('/stream/${safeId}/events'); }
    catch (e) { console.error('rendre: EventSource failed', e); return; }

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

  function cssEscape(s) {
    return String(s).replace(/["\\\\]/g, '\\\\$&');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
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
