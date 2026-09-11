// SPDX-License-Identifier: Apache-2.0

/**
 * A custom role holding a permission the platform no longer knows — its module
 * was unloaded — must stay repairable: the save resends the whole selection and
 * the write route 400s on the unknown string, so the editor has to offer a
 * control that removes it. Dropping it on open would rewrite the role instead.
 * The pieces are exercised directly; the editor's Radix dialog needs a DOM.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { unavailablePermissions } from "../../lib/role-permissions.ts";
import { UnavailablePermissions } from "../org-settings/roles.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const VOCABULARY = [
  {
    resource: "agents",
    permissions: [{ permission: "agents:read" }, { permission: "agents:run" }],
  },
  { resource: "runs", permissions: [{ permission: "runs:read" }] },
];

describe("which selected permissions the platform cannot name", () => {
  it("lists the ones outside the vocabulary, sorted", () => {
    const selected = new Set(["agents:read", "chat:write", "runs:read", "billing:manage"]);
    expect(unavailablePermissions(selected, VOCABULARY)).toEqual(["billing:manage", "chat:write"]);
  });

  it("lists none when every selected permission is known", () => {
    expect(unavailablePermissions(new Set(["agents:run"]), VOCABULARY)).toEqual([]);
  });
});

describe("the unavailable group", () => {
  it("names each permission and offers to remove it", () => {
    const html = render(
      <UnavailablePermissions permissions={["chat:write"]} onRemove={() => {}} disabled={false} />,
    );
    expect(html).toContain("Indisponible");
    expect(html).toContain("chat:write");
    expect(html).toContain("Retirer la permission chat:write");
    expect(html).toContain("Retirer");
  });

  it("renders nothing when the role holds no unknown permission", () => {
    const html = render(
      <UnavailablePermissions permissions={[]} onRemove={() => {}} disabled={false} />,
    );
    expect(html).toBe("");
  });
});
