// SPDX-License-Identifier: Apache-2.0

/**
 * Lab-mode entry point. Injected by the `labMode()` Vite plugin as the module
 * script *before* `/src/main.tsx`.
 *
 * WHY IT CANNOT LIVE IN `main.tsx` — both HTTP clients capture a reference to
 * `globalThis.fetch` when they are constructed, and both are constructed at
 * module-evaluation time (`api/client.ts` via `createFetchClient`,
 * `lib/auth-client.ts` via `createAuthClient`). Module imports are evaluated
 * before the importing module's body runs, so anything `main.tsx` does is
 * already too late: the clients hold the real `fetch` and go straight to the
 * network. Running as a separate, earlier module script is what puts the patch
 * in front of them.
 */
import { installLabFetch } from "./mock-fetch";
import { mountLabPanel } from "./panel";

// Start on the non-default workspace whose settings fixture exposes all three
// row shapes, including the destructive action. Preserve a deliberate switch
// made while using the lab instead of forcing this on every reload.
if (!localStorage.getItem("appstrate_current_app")) {
  localStorage.setItem("appstrate_current_app", "app_lab");
}

// The platform injects this into index.html at serve time; `vite dev` serves
// the file raw, so the lab supplies it. Modules are ON here: the point of the
// lab is to see the whole surface, not the subset a given deployment enables.
window.__APP_CONFIG__ = {
  features: {
    googleAuth: false,
    githubAuth: false,
    smtp: false,
    signupDisabled: false,
    orgCreationDisabled: false,
    bootstrapTokenPending: false,
    chat: true,
    billing: true,
    webhooks: true,
    oidc: true,
  },
  trustedOrigins: [],
};

installLabFetch();
document.addEventListener("DOMContentLoaded", mountLabPanel);
