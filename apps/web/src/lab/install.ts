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

installLabFetch();
document.addEventListener("DOMContentLoaded", mountLabPanel);
