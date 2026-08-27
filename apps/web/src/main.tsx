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

// True only while the speculative chat warm-up below is in flight. Vite
// dispatches `vite:preloadError` for EVERY failed dynamic import, including one
// nobody asked for, so the listener needs to tell the two cases apart.
let chatWarmupPending = false;

// Vite fires this when a dynamic-import preload fails — typically a stale
// hashed chunk after a redeploy. Hard-reload once to pick up the fresh chunk
// graph; the sessionStorage guard in reloadOnceForChunkError prevents reload
// loops, and when it has already fired we let the rejection propagate to the
// ErrorBoundary instead.
window.addEventListener("vite:preloadError", (event) => {
  // A failed WARM-UP is not a failed navigation. The user never asked for that
  // chunk and is not looking at a broken screen, so there is nothing to
  // recover: reloading would turn a background miss into a visible
  // interruption. It would also loop without bound — the one-shot guard is
  // cleared on every successful boot (below), which lands BEFORE this rejection
  // does, so each reload would clear the flag that was meant to stop the next
  // one. `lazy()` re-imports and surfaces a real error if the user ever
  // navigates there, which is the only moment the failure actually matters.
  if (chatWarmupPending) {
    event.preventDefault();
    return;
  }
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
// fetch's tail. `GET /api/spaces` is the only first-screen read with a
// real data dependency (it needs the selected org id), so what is left is two
// network levels, not four.
startAuthBootstrap();
primeOrgList();

// Warm the chat route's chunk on the same idle window. `ChatModulePage` is
// `lazy()`, so its download only STARTS once the route element renders — which
// is after the auth gate and the org gate have both resolved. That chunk pulls
// assistant-ui, the AI SDK and react-markdown, so on a cold cache the composer
// appears a full serial download after the app is otherwise ready. Kicking it
// here overlaps it with the two fetches above instead.
//
// Gated on the same flag as the route (`app.tsx`): with the chat module absent
// the route renders nowhere, and warming its chunk would download and compile
// the single largest asset on the page for a screen that does not exist. The
// config is injected synchronously by the server, so it is readable here.
//
// Failure is ignored — but NOT by the `.catch()` alone. `import()` compiles to
// Vite's `__vitePreload`, which dispatches `vite:preloadError` from its own
// `baseModule().catch(handlePreloadError)` BEFORE any userland handler runs;
// the marker above is what actually keeps that event from reloading the tab.
if (window.__APP_CONFIG__?.features?.chat) {
  chatWarmupPending = true;
  void import("./modules/chat/chat-page")
    .catch(() => undefined)
    .finally(() => {
      chatWarmupPending = false;
    });
}

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
