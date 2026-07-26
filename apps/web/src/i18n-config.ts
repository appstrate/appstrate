// SPDX-License-Identifier: Apache-2.0

/**
 * i18n constants shared by the runtime (`i18n.ts`) and the build
 * (`vite.config.ts`, which emits `modulepreload` hints for the boot locale
 * chunks).
 *
 * **This module MUST stay import-free.** `vite.config.ts` loads it in the Node
 * build context, where pulling in i18next — or anything reaching for `window`
 * — would break config evaluation.
 *
 * These values used to be written out twice, once here and once in the Vite
 * plugin, under a "keep in sync" comment. A drifted namespace list is
 * invisible: the preload hint simply stops matching, the RTT comes back, and
 * nothing fails. Deriving both sides from this file makes that impossible.
 */

/** Language used when nothing is stored and nothing matches. */
export const I18N_FALLBACK_LANGUAGE = "fr";

/** Languages with a complete locale directory. */
export const I18N_SUPPORTED_LANGUAGES = ["fr", "en"] as const;

/** localStorage key i18next persists the active language under. */
export const I18N_LANGUAGE_STORAGE_KEY = "i18nextLng";

/**
 * Namespaces preloaded for every user, and therefore on the critical path to
 * first paint: `main.tsx` gates `createRoot()` on `i18nReady`, which resolves
 * once these have loaded.
 *
 * A MODULE's namespace is deliberately absent (e.g. `chat`):
 * `useTranslation("chat")` loads it on demand inside the module route's
 * Suspense boundary, so a disabled module costs nothing — same rule as its
 * code chunk.
 */
export const I18N_BOOT_NAMESPACES = ["common", "agents", "settings", "documents"] as const;
