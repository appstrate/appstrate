// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { keyDeletionPrompt } from "../key-deletion.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const KEY = { id: "cred_a", label: "Prod", owner_type: "org" as const };

function model(id: string, over: Partial<OrgModelInfo> = {}): OrgModelInfo {
  return {
    id,
    label: id,
    modelId: id,
    credentialId: "cred_a",
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    binding: "org",
    source: "custom",
    ...over,
  } as OrgModelInfo;
}

describe("keyDeletionPrompt", () => {
  it("refuses a key that models use, naming the disabled and the default ones and where they go", () => {
    const prompt = keyDeletionPrompt(
      KEY,
      [
        model("GPT", { is_default: true }),
        model("Haiku", { enabled: false }),
        model("Other", { credentialId: "cred_b" }),
        model("Sys", { credentialId: null, source: "built-in", binding: "managed" }),
      ],
      i18n.t,
    );
    expect(prompt.blocked).toBe(true);
    expect(prompt.description).toBe(
      "La clé « Prod » est utilisée par 2 modèles : GPT, Haiku. Supprimez ces modèles ou liez-les à une autre clé (« Choisir les modèles », puis « Réglages avancés ») avant de supprimer la clé.",
    );
  });

  it("refuses a key that only a disabled model uses", () => {
    const prompt = keyDeletionPrompt(KEY, [model("Haiku", { enabled: false })], i18n.t);
    expect(prompt.blocked).toBe(true);
    expect(prompt.description).toBe(
      "La clé « Prod » est utilisée par 1 modèle : Haiku. Supprimez ce modèle ou liez-le à une autre clé (« Choisir les modèles », puis « Réglages avancés ») avant de supprimer la clé.",
    );
  });

  it("lets an unused key go", () => {
    const prompt = keyDeletionPrompt(KEY, [model("Other", { credentialId: "cred_b" })], i18n.t);
    expect(prompt).toEqual({ description: "Supprimer la clé « Prod » ?", blocked: false });
  });

  it("says a member's personal key is theirs, and lets it go", () => {
    const prompt = keyDeletionPrompt(
      { id: "cred_bob", label: "Clé de Bob", owner_type: "user" },
      [model("Claude", { credentialId: null, binding: "member" })],
      i18n.t,
    );
    expect(prompt).toEqual({
      description:
        "Supprimer la clé perso « Clé de Bob » de ce membre ? Il devra en ajouter une nouvelle.",
      blocked: false,
    });
  });
});
