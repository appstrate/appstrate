// SPDX-License-Identifier: Apache-2.0

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import resourcesToBackend from "i18next-resources-to-backend";

// Accessing localStorage throws when storage is blocked (sandboxed iframe,
// Safari private mode, cookies-disabled). Guard it so a blocked store can
// never crash the SPA bootstrap — we just fall back to the default language.
function readSavedLng(): string | null {
  try {
    return localStorage.getItem("i18nextLng");
  } catch {
    return null;
  }
}

const savedLng = readSavedLng();

/**
 * Locale bundles are loaded on demand: only the active language's namespaces
 * are fetched (as small Vite-split JSON chunks) instead of bundling all
 * languages into the entry. `main.tsx` awaits `i18nReady` before rendering so
 * the UI never flashes raw translation keys.
 *
 * NOTE: locale JSONs are FLAT dotted-key maps — do not restructure them.
 */
export const i18nReady = i18n
  .use(resourcesToBackend((lng: string, ns: string) => import(`./locales/${lng}/${ns}.json`)))
  .use(initReactI18next)
  .init({
    lng: savedLng || undefined,
    fallbackLng: "fr",
    supportedLngs: ["fr", "en"],
    defaultNS: "common",
    fallbackNS: "common",
    ns: ["common", "agents", "settings", "documents"],
    interpolation: { escapeValue: false },
  });

// Persist language choice to localStorage for next visit (best-effort — a
// blocked store must not throw out of the languageChanged handler).
i18n.on("languageChanged", (lng) => {
  try {
    localStorage.setItem("i18nextLng", lng);
  } catch {
    // Storage blocked — language just won't persist across reloads.
  }
});

export default i18n;
