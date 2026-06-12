// SPDX-License-Identifier: Apache-2.0

import { i18nReady } from "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { clearChunkReloadFlag, reloadOnceForChunkError } from "./lib/chunk-reload";
import "./stores/theme-store";
import "./styles.css";

// Vite fires this when a dynamic-import preload fails — typically a stale
// hashed chunk after a redeploy. Hard-reload once to pick up the fresh chunk
// graph; the sessionStorage guard in reloadOnceForChunkError prevents reload
// loops, and when it has already fired we let the rejection propagate to the
// ErrorBoundary instead.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForChunkError()) {
    // Reload underway — swallow the rejection so no error UI flashes.
    event.preventDefault();
  }
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Wait for the active language's namespaces to load before the first render
// so the UI never flashes raw translation keys. Render anyway on failure —
// i18next falls back to key echo, which beats a blank page.
void i18nReady
  .catch(() => undefined)
  .then(() => {
    // Boot reached → if a chunk-failure reload brought us here it worked;
    // clear the one-shot guard so a future redeploy can auto-recover again.
    clearChunkReloadFlag();
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
  });
