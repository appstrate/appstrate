// SPDX-License-Identifier: Apache-2.0

import { i18nReady } from "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { startAuthBootstrap } from "./hooks/use-auth";
import { primeOrgList } from "./hooks/use-org";
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

// The first screen needs three server reads that share no data with each
// other: the Better Auth session, `GET /api/profile` and `GET /api/orgs`. All
// three authenticate on the session cookie alone, so none of them has to wait
// for another. They used to run strictly one after the next — the session
// gated the profile, the profile gated the first render, and the first render
// was what mounted the org gate that issued the org list.
//
// Kicking them here, before `i18nReady` resolves and before React mounts,
// collapses those three round-trips into one and takes them off the locale
// fetch's tail. `GET /api/applications` is the only first-screen read with a
// real data dependency (it needs the selected org id), so what is left is two
// network levels, not four.
startAuthBootstrap();
primeOrgList();

// Warm the chat route's chunk on the same idle window. `ChatModulePage` is
// `lazy()`, so its download only STARTS once the route element renders — which
// is after the auth gate and the org gate have both resolved. That chunk pulls
// assistant-ui, the AI SDK and react-markdown, so on a cold cache the composer
// appears a full serial download after the app is otherwise ready. Kicking it
// here overlaps it with the two fetches above instead. Failure is ignored: this
// is a warm-up, and `lazy()` will re-import (and surface a real error) if the
// user actually navigates there.
void import("./modules/chat/chat-page").catch(() => undefined);

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
