// SPDX-License-Identifier: Apache-2.0

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import resourcesToBackend from "i18next-resources-to-backend";

const savedLng = localStorage.getItem("i18nextLng");

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
    ns: ["common", "agents", "settings"],
    interpolation: { escapeValue: false },
  });

// Persist language choice to localStorage for next visit
i18n.on("languageChanged", (lng) => {
  localStorage.setItem("i18nextLng", lng);
});

export default i18n;
