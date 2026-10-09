// SPDX-License-Identifier: Apache-2.0

/**
 * The "required" switch of an integration dependency renders for every
 * integration — whatever its catalog, and before its detail has loaded — and
 * reflects the entry's `required` flag.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import { IntegrationToolPicker } from "../integration-tool-picker.tsx";
import type { ResourceEntry } from "../types.ts";

await i18nReady;
await i18n.changeLanguage("fr");
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const ID = "@acme/gmail";

function renderPicker(entry: ResourceEntry): string {
  return render(<IntegrationToolPicker packageId={ID} entry={entry} onChange={() => {}} />);
}

describe("IntegrationToolPicker — required switch", () => {
  it("renders even when the integration detail is unavailable", () => {
    const html = renderPicker({ id: ID, version: "*" });
    expect(html).toContain(`integ-required-${ID}`);
    expect(html).toContain(i18n.t("settings:agentEditor.integrations.required.label"));
    expect(html).toContain(i18n.t("settings:agentEditor.integrations.tools.detailUnavailable"));
  });

  it("is checked only for an entry marked required", () => {
    expect(renderPicker({ id: ID, version: "*", required: true })).toContain(
      'data-state="checked"',
    );
    expect(renderPicker({ id: ID, version: "*" })).not.toContain('data-state="checked"');
  });
});
