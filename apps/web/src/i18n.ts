// SPDX-License-Identifier: Apache-2.0

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import frCommon from "./locales/fr/common.json";
import frAgents from "./locales/fr/agents.json";
import frSettings from "./locales/fr/settings.json";
import enCommon from "./locales/en/common.json";
import enAgents from "./locales/en/agents.json";
import enSettings from "./locales/en/settings.json";

const savedLng = localStorage.getItem("i18nextLng");

i18n.use(initReactI18next).init({
  lng: savedLng || undefined,
  fallbackLng: "fr",
  supportedLngs: ["fr", "en"],
  defaultNS: "common",
  fallbackNS: "common",
  ns: ["common", "agents", "settings"],
  interpolation: { escapeValue: false },
  resources: {
    fr: { common: frCommon, agents: frAgents, settings: frSettings },
    en: { common: enCommon, agents: enAgents, settings: enSettings },
  },
});

// Persist language choice to localStorage for next visit
i18n.on("languageChanged", (lng) => {
  localStorage.setItem("i18nextLng", lng);
});

export default i18n;
