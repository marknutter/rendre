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

    es.addEventListener('slot-reset', function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (!msg || !msg.slot) return;
        slotBuffers[msg.slot] = '';
        var el = document.querySelector('[data-slot="' + cssEscape(msg.slot) + '"]');
        if (!el) return;
        el.replaceChildren();
        el.classList.remove('rendre-filled');
        el.classList.add('rendre-filling');
      } catch (err) { console.error('rendre slot-reset error', err); }
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

  // Edit-mode helpers. The host can flip the iframe into a direct-manipulation
  // mode where the whole body is contenteditable and slot boundaries become
  // visible. Save captures the edited HTML; Cancel reverts via a snapshot
  // taken at edit-mode entry.
  var editSnapshot = null;
  window.__rendreEnterEdit = function () {
    if (document.documentElement.dataset.rendreEdit === '1') return;
    editSnapshot = document.body ? document.body.innerHTML : null;
    document.documentElement.dataset.rendreEdit = '1';
    if (document.body) document.body.contentEditable = 'true';
  };
  window.__rendreExitEdit = function (revert) {
    if (document.documentElement.dataset.rendreEdit !== '1') return;
    if (revert && editSnapshot !== null && document.body) {
      document.body.innerHTML = editSnapshot;
    }
    editSnapshot = null;
    document.documentElement.dataset.rendreEdit = '';
    if (document.body) document.body.contentEditable = 'false';
  };
  window.__rendreGetEditedHtml = function () {
    return '<!doctype html>\\n' + document.documentElement.outerHTML;
  };

  // Iterate-button click delegation. The user clicks a <button
  // data-rendre-iterate="<instruction>"> embedded in slot content; we find the
  // enclosing slot, then post the (slot, instruction, shiftKey) tuple to the
  // host via a magic-prefixed console.log. The host (App.tsx) listens via the
  // webview's console-message event.
  document.addEventListener('click', function (e) {
    // In edit mode iterate buttons are styled disabled and shouldn't fire;
    // clicking should let the user edit the button text instead.
    if (document.documentElement.dataset.rendreEdit === '1') return;
    var target = e.target;
    if (!target || target.nodeType !== 1) return;
    var btn = target.closest('[data-rendre-iterate]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var slotEl = btn.closest('[data-slot]');
    var slot = slotEl ? slotEl.getAttribute('data-slot') : null;
    var instruction = btn.getAttribute('data-rendre-iterate') || '';
    if (!slot || !instruction) return;
    var payload = JSON.stringify({ slot: slot, instruction: instruction, shiftKey: !!e.shiftKey });
    console.log('__rendre_iterate__:' + payload);
  });

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

/* Default styling for iterate buttons; the slot fill may override with inline
   styles if its design demands it. Pill chips that read as clickable without
   dominating the slot's content. */
button[data-rendre-iterate] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.4;
  background: rgba(127,127,127,0.10);
  color: inherit;
  border: 1px solid rgba(127,127,127,0.25);
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s, transform 0.05s;
  user-select: none;
}
button[data-rendre-iterate]:hover {
  background: rgba(127,127,127,0.20);
}
button[data-rendre-iterate]:active {
  background: rgba(127,127,127,0.30);
  transform: scale(0.97);
}
button[data-rendre-iterate]:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}

/* Direct-edit mode: outline editable slot boundaries so the user can see
   what they're working with; gray out iterate buttons (which are disabled
   via the click-handler guard but should also look inert). */
html[data-rendre-edit="1"] [data-slot] {
  outline: 1.5px dashed rgba(124, 92, 255, 0.55);
  outline-offset: 6px;
  border-radius: 4px;
  transition: outline-color 0.15s;
}
html[data-rendre-edit="1"] [data-slot]:focus-within {
  outline-color: rgba(124, 92, 255, 1);
}
html[data-rendre-edit="1"] button[data-rendre-iterate] {
  pointer-events: none;
  opacity: 0.4;
}
html[data-rendre-edit="1"] body {
  caret-color: rgba(124, 92, 255, 1);
}
`.trim()

  return `\n<style data-rendre-runtime>${style}</style>\n<script data-rendre-runtime>${script}</script>\n`
}
