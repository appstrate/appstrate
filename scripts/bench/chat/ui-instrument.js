// SPDX-License-Identifier: Apache-2.0
//
// Injected into the page before the SPA loads (ui.ts): wraps `fetch` to stamp
// the moment the composer sends `POST /api/chat` and the moment its stream
// ends, and watches the DOM for what the user sees. Plain JS because it runs in
// the browser, outside the scripts' Bun types. Mock upstream text: answer
// words are `lorem`.
/* global window, document, requestAnimationFrame, MutationObserver */
(() => {
  const b = (window.__bench = {
    sendAt: null,
    dotsAt: null,
    textAt: null,
    lastTextAt: null,
    streamEndAt: null,
    blank: 0,
    lastFrame: null,
    frames: [],
    longTasks: 0,
    longTaskMs: 0,
    textLength: 0,
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
    const isTurn = method.toUpperCase() === "POST" && /\/api\/chat$/.test(url);
    if (isTurn) b.sendAt = performance.now();
    const res = await originalFetch(input, init);
    if (isTurn && res.body) {
      // A tee'd copy, read to the end: the SPA's own reader is left untouched.
      const reader = res.clone().body.getReader();
      void (async () => {
        while (!(await reader.read()).done) {
          // drain
        }
        b.streamEndAt = performance.now();
      })();
    }
    return res;
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (b.sendAt === null || entry.startTime < b.sendAt) continue;
      b.longTasks++;
      b.longTaskMs += entry.duration;
    }
  }).observe({ type: "longtask" });
  // The aria-label fallback: baseline builds predate the testid (and hardcode a French label).
  const dotsSelector =
    '[data-testid="chat-thinking-status"], [role="status"][aria-label^="L\'assistant"]';
  const scan = () => {
    if (b.sendAt === null) return;
    const now = performance.now();
    const text = document.body.textContent || "";
    if (b.dotsAt === null && document.querySelector(dotsSelector)) b.dotsAt = now;
    const answer = text.split("lorem").length - 1;
    if (answer > 0) {
      if (b.textAt === null) b.textAt = now;
      if (answer !== b.textLength) {
        b.textLength = answer;
        b.lastTextAt = now;
      }
    }
  };
  new MutationObserver(scan).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  const frame = (t) => {
    if (b.sendAt !== null) {
      if (b.lastFrame !== null) {
        const delta = t - b.lastFrame;
        if (b.textAt === null) {
          if (document.querySelector(dotsSelector) === null) b.blank += delta;
        } else if (b.streamEndAt === null) {
          b.frames.push(delta);
        }
      }
      b.lastFrame = t;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
