// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  buildCreationPrompt,
  chatDraftNavigationState,
  creationResourceFromSearch,
  creationSearch,
  readChatComposerDraft,
  type CreationResource,
} from "../creation-handoff.ts";

const resources: CreationResource[] = ["agent", "skill", "integration", "mcp-server"];

describe("creation handoff", () => {
  it("opens and closes an addressable chooser without dropping unrelated URL state", () => {
    expect(creationSearch("?q=mail&catalogue=1", "integration")).toBe(
      "?q=mail&catalogue=1&create=integration",
    );
    expect(creationResourceFromSearch("?q=mail&create=integration")).toBe("integration");
    expect(creationSearch("?q=mail&create=integration", null)).toBe("?q=mail");
    expect(creationResourceFromSearch("?create=unknown")).toBeNull();
  });

  it.each(resources)("builds a specific Chat prompt for %s", (resource) => {
    const prompt = buildCreationPrompt(resource, "chat", "fr");
    expect(prompt).toContain("Chat Appstrate");
    expect(prompt).toContain("avant toute mutation");
    expect(prompt).toContain("Ne publie ou n’installe");
  });

  it("names only real package operationIds", () => {
    expect(buildCreationPrompt("agent", "chat", "en")).toContain("`createAgent`");
    expect(buildCreationPrompt("skill", "chat", "en")).toContain("`createSkill`");
    expect(buildCreationPrompt("integration", "chat", "en")).toContain(
      "`createIntegrationPackage`",
    );
  });

  it("uses the real document-backed MCP server authoring workflow", () => {
    const prompt = buildCreationPrompt("mcp-server", "chat", "en");
    for (const tool of [
      "get_runtime_capabilities",
      "run_and_wait",
      "publish_document",
      "validate_package_document",
      "import_package_document",
    ]) {
      expect(prompt).toContain(`\`${tool}\``);
    }
    expect(prompt).toContain("valid: true");
    expect(prompt).toContain("importable: true");
  });

  it("hands a coding agent back to the canonical MCP access instructions", () => {
    const prompt = buildCreationPrompt("agent", "coding-agent", "fr");
    expect(prompt).toContain("Paramètres de l’organisation > Accès MCP");
    expect(prompt).toContain("Ne reconstruis jamais l’URL ni la commande");
  });

  it("accepts only a non-empty composer draft from router state", () => {
    const state = chatDraftNavigationState("Create an agent");
    expect(readChatComposerDraft(state)).toBe("Create an agent");
    expect(readChatComposerDraft({ composerDraft: "" })).toBeUndefined();
    expect(readChatComposerDraft({ composerDraft: 42 })).toBeUndefined();
  });
});
