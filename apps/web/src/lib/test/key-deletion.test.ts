// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import type { OrgModelInfo } from "../../hooks/use-models.ts";
import { keyDeletionPrompt } from "../key-deletion.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const KEY = { id: "cred_a", label: "Prod" };

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
  it("refuses a key that models use, naming the disabled and the default ones too", () => {
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
      "La clé « Prod » est utilisée par 2 modèles : GPT, Haiku. Supprimez ces modèles avant la clé.",
    );
  });

  it("refuses a key that only a disabled model uses", () => {
    const prompt = keyDeletionPrompt(KEY, [model("Haiku", { enabled: false })], i18n.t);
    expect(prompt.blocked).toBe(true);
    expect(prompt.description).toBe(
      "La clé « Prod » est utilisée par 1 modèle : Haiku. Supprimez ce modèle avant la clé.",
    );
  });

  it("lets an unused key go", () => {
    const prompt = keyDeletionPrompt(KEY, [model("Other", { credentialId: "cred_b" })], i18n.t);
    expect(prompt).toEqual({ description: "Supprimer la clé « Prod » ?", blocked: false });
  });
});
