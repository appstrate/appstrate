// SPDX-License-Identifier: Apache-2.0

/**
 * A custom role that holds a permission the platform no longer knows — its
 * module was unloaded — must stay repairable.
 *
 * The editor rendered only what the vocabulary named, kept everything else
 * selected out of sight, and resent the whole selection on save; the write
 * route refuses the unknown string with a 400, so the role could not be saved
 * and nothing on screen could take the string out. Dropping it on open would
 * be the other failure: rewriting a role because someone looked at it.
 *
 * The editor lives inside a Radix dialog, which renders nothing without a DOM
 * (the web runner has none), so the two pieces are exercised directly.
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
