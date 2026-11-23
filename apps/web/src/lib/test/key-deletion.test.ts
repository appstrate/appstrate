// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { ApiError } from "../../api/errors.ts";
import { keyDeletionPrompt } from "../key-deletion.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const KEY = { label: "Prod", owner_type: "org" as const, referencing_model_count: 0 };

describe("keyDeletionPrompt", () => {
  it("blocks two model references even when the visible model list is empty", () => {
    const prompt = keyDeletionPrompt({ ...KEY, referencing_model_count: 2 }, i18n.t);
    expect(prompt.blocked).toBe(true);
    expect(prompt.description).toContain("La clé « Prod » est utilisée par 2 modèles.");
  });

  it("uses the singular for the last referencing model", () => {
    const prompt = keyDeletionPrompt({ ...KEY, referencing_model_count: 1 }, i18n.t);
    expect(prompt.blocked).toBe(true);
    expect(prompt.description).toContain("La clé « Prod » est utilisée par 1 modèle.");
  });

  it("shows a refusal for a reference added after opening, until the count is refreshed", () => {
    const refusal = new ApiError("credential_in_use", "now referenced", 409);
    expect(keyDeletionPrompt(KEY, i18n.t).blocked).toBe(false);
    expect(keyDeletionPrompt(KEY, i18n.t, refusal)).toEqual({
      description: i18n.t("apiError.credential_in_use", { ns: "common" }),
      blocked: true,
    });
    expect(
      keyDeletionPrompt({ ...KEY, referencing_model_count: 1 }, i18n.t, refusal).description,
    ).toContain("1 modèle.");
  });

  it("lets the user retry a temporary failure", () => {
    expect(keyDeletionPrompt(KEY, i18n.t, new Error("offline"))).toEqual({
      description: "offline",
      blocked: false,
    });
  });

  it("lets an unused organization key or personal key go", () => {
    expect(keyDeletionPrompt(KEY, i18n.t)).toEqual({
      description: "Supprimer la clé « Prod » ?",
      blocked: false,
    });
    expect(keyDeletionPrompt({ ...KEY, owner_type: "user", label: "Clé de Bob" }, i18n.t)).toEqual({
      description:
        "Supprimer la clé perso « Clé de Bob » de ce membre ? Il devra en ajouter une nouvelle.",
      blocked: false,
    });
  });
});
