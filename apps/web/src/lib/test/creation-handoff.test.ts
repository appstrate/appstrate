// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import settingsEn from "../../locales/en/settings.json";
import settingsFr from "../../locales/fr/settings.json";
import {
  buildChatCreationDraft,
  chatDraftNavigationState,
  creationResourceFromSearch,
  creationSearch,
  readChatComposerDraft,
  type CreationResource,
} from "../creation-handoff.ts";

const resources: CreationResource[] = ["agent", "skill", "integration", "mcp-server"];
const frenchChatDrafts: Record<CreationResource, string> = {
  agent:
    "Aide-moi à créer un nouvel agent Appstrate. Commence par me poser les questions nécessaires.",
  skill:
    "Aide-moi à créer un nouveau skill Appstrate. Commence par me poser les questions nécessaires.",
  integration:
    "Aide-moi à créer une nouvelle intégration Appstrate. Commence par me poser les questions nécessaires.",
  "mcp-server":
    "Aide-moi à créer un nouveau serveur MCP Appstrate. Commence par me poser les questions nécessaires.",
};
const dictionaries = { en: settingsEn, fr: settingsFr } as const;

function translator(locale: keyof typeof dictionaries) {
  const dictionary = dictionaries[locale] as Record<string, string>;
  return (key: string, values: Record<string, string> = {}) => {
    const message = dictionary[key];
    if (!message) throw new Error(`Missing ${locale} translation: ${key}`);
    return Object.entries(values).reduce(
      (result, [name, value]) => result.split(`{{${name}}}`).join(value),
      message,
    );
  };
}

describe("creation handoff", () => {
  it("opens and closes an addressable chooser without dropping unrelated URL state", () => {
    expect(creationSearch("?q=mail&catalogue=1", "integration")).toBe(
      "?q=mail&catalogue=1&create=integration",
    );
    expect(creationResourceFromSearch("?q=mail&create=integration")).toBe("integration");
    expect(creationSearch("?q=mail&create=integration", null)).toBe("?q=mail");
    expect(creationResourceFromSearch("?create=unknown")).toBeNull();
  });

  it.each(resources)("builds a short, specific Chat draft for %s", (resource) => {
    expect(buildChatCreationDraft(resource, translator("fr"))).toBe(frenchChatDrafts[resource]);
  });

  it("accepts only a non-empty composer draft from router state", () => {
    const state = chatDraftNavigationState("Create an agent");
    expect(readChatComposerDraft(state)).toBe("Create an agent");
    expect(readChatComposerDraft({ composerDraft: "" })).toBeUndefined();
    expect(readChatComposerDraft({ composerDraft: 42 })).toBeUndefined();
  });
});
