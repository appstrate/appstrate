// SPDX-License-Identifier: Apache-2.0

/**
 * A saved model's own deeds, at the start of its form's footer. The form's dialog is a Radix
 * portal, so the footer's part is rendered on its own: a test for a model bound to a key of the
 * organization's, a delete only for a caller the page hands it to (`models:delete`).
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import settingsFr from "../../../locales/fr/settings.json";
import commonFr from "../../../locales/fr/common.json";
import { render } from "../../../test/render.tsx";
import { SavedModelActions } from "../saved-model-actions.tsx";
import type { OrgModelInfo } from "../../../hooks/use-models.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const BOUND = { id: "mdl_1", credentialId: "cred_org", binding: "org" } as OrgModelInfo;
const LEFT_TO_MEMBERS = { id: "mdl_m", credentialId: null, binding: "member" } as OrgModelInfo;

describe("SavedModelActions", () => {
  it("tests the model, and deletes it when the caller may", () => {
    const html = render(<SavedModelActions model={BOUND} onDelete={() => {}} />);
    expect(html).toContain(`>${settingsFr["models.test"]}<`);
    expect(html).toContain(`>${commonFr["btn.delete"]}<`);
  });

  it("offers no delete to a caller who may not", () => {
    const html = render(<SavedModelActions model={BOUND} />);
    expect(html).toContain(`>${settingsFr["models.test"]}<`);
    expect(html).not.toContain(`>${commonFr["btn.delete"]}<`);
  });

  it("offers no test of a model left to each member, which no organization key serves", () => {
    const html = render(<SavedModelActions model={LEFT_TO_MEMBERS} onDelete={() => {}} />);
    expect(html).not.toContain(`>${settingsFr["models.test"]}<`);
    expect(html).toContain(`>${commonFr["btn.delete"]}<`);
  });
});
