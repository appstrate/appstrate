// SPDX-License-Identifier: Apache-2.0

/**
 * The picker note that says who pays for a model. Only the caller's own
 * credential and the missing one are worth a word: an organization credential
 * is the default and renders nothing.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import settingsFr from "../../locales/fr/settings.json";
import { render } from "../../test/render.tsx";
import { ModelBillingHint } from "../model-billing-hint.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("ModelBillingHint", () => {
  it("names the caller's own credential when it pays for the model", () => {
    expect(render(<ModelBillingHint billedTo="user" />)).toContain(
      settingsFr["models.billing.userCredential"],
    );
  });

  it("asks for a credential when none serves the caller", () => {
    expect(render(<ModelBillingHint billedTo={null} />)).toContain(
      settingsFr["models.billing.credentialRequired"],
    );
  });

  it("says nothing for an organization credential", () => {
    expect(render(<ModelBillingHint billedTo="org" />)).toBe("");
  });
});
