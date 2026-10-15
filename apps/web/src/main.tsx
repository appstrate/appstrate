// SPDX-License-Identifier: Apache-2.0

import { i18nReady } from "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";
import { App } from "./app";
import { TranslatedUiLabels } from "./components/translated-ui-labels";
import { queryClient } from "./lib/query-client";
import { startAuthBootstrap } from "./hooks/use-auth";
import { sessionExpected } from "./lib/session-read";
import { primeOrgList } from "./hooks/use-org";
import { primeSpaceList } from "./hooks/use-spaces";
import { clearChunkReloadFlag, reloadOnceForChunkError } from "./lib/chunk-reload";
import { warmChunk, warmupPending } from "./lib/chunk-warmup";
import "./stores/theme-store";
import "./styles.css";

// A failed dynamic-import preload is typically a stale hashed chunk after a redeploy:
// hard-reload once (the sessionStorage guard in reloadOnceForChunkError prevents loops).
window.addEventListener("vite:preloadError", (event) => {
  // A failed WARM-UP (`lib/chunk-warmup.ts`) must not reload: it would loop, since the
  // one-shot guard is cleared on every successful boot, before this rejection lands.
  if (warmupPending()) {
    event.preventDefault();
    return;
  }
  if (reloadOnceForChunkError()) {
    event.preventDefault();
  }
});

// The session, `GET /api/profile` and `GET /api/orgs` share no data and authenticate on
// the cookie alone: kick them before React mounts so they run in parallel. `GET /api/spaces`
// starts once the org list confirms the persisted org (every space-scoped read waits on
// it, `useSpaceResolver`).
startAuthBootstrap();
if (sessionExpected(localStorage)) primeSpaceList(primeOrgList());

// Warm the lazy chat chunk (assistant-ui, AI SDK, react-markdown) in parallel with the
// fetches above. Gated on the same flag as the route in `app.tsx`; the config is injected
// synchronously by the server.
if (window.__APP_CONFIG__?.features?.chat) {
  warmChunk(() => import("./modules/chat/chat-page"));
}

// Wait for the language's namespaces so the UI never flashes raw keys; render anyway on failure.
void i18nReady
  .catch(() => undefined)
  .then(() => {
    // Boot reached: clear the one-shot guard so a future redeploy can auto-recover.
    clearChunkReloadFlag();
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <TranslatedUiLabels>
              <TooltipProvider>
                <App />
              </TooltipProvider>
            </TranslatedUiLabels>
          </BrowserRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
  });

// e2e path-trigger probe (throwaway, do not merge)
