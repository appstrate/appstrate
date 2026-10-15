// SPDX-License-Identifier: Apache-2.0

/**
 * Every permission the screens list has a name in both languages: the role
 * editor and matrix list the whole catalog, the API-key scope picker every
 * grantable scope. A string without a label shows as its wire id, next to
 * translated ones.
 */
import { describe, expect, it } from "bun:test";
import { CORE_RESOURCE_ACTIONS } from "@appstrate/core/permissions";
import fr from "../../locales/fr/settings.json";
import en from "../../locales/en/settings.json";
import { permissionLabel, permissionResourceLabel } from "../permission-labels.ts";

/**
 * The whole core catalog, so the API-key allowlist's core half (`apps/api/src/lib/permissions.ts`,
 * which the SPA's program cannot import) is covered whatever it grants.
 */
const CORE_PERMISSIONS = Object.entries(CORE_RESOURCE_ACTIONS).flatMap(([resource, actions]) =>
  actions.map((action) => `${resource}:${action}`),
);

/** The modules' contributions (`permissionsContribution()`), API-key-grantable ones included. */
const MODULE_PERMISSIONS = [
  "webhooks:read",
  "webhooks:write",
  "webhooks:delete",
  "org-webhooks:read",
  "org-webhooks:write",
  "org-webhooks:delete",
  "oauth-clients:read",
  "oauth-clients:write",
  "oauth-clients:delete",
  "cli-sessions:read",
  "cli-sessions:delete",
  "mcp:read",
  "mcp:invoke",
  "chat:read",
  "chat:write",
  "billing:read",
  "billing:manage",
];

describe.each([
  ["fr", fr as Record<string, string>],
  ["en", en as Record<string, string>],
])("permission labels (%s)", (_lang, bundle) => {
  const t = (key: string) => bundle[key] ?? key;

  it.each([...CORE_PERMISSIONS, ...MODULE_PERMISSIONS])(
    "names %s and its resource",
    (permission) => {
      expect(permissionLabel(permission, t)).not.toBe(permission);
      const resource = permission.slice(0, permission.indexOf(":"));
      expect(permissionResourceLabel(resource, t)).not.toBe(resource);
    },
  );

  it("labels no permission that does not exist", () => {
    const known = new Set([...CORE_PERMISSIONS, ...MODULE_PERMISSIONS]);
    const labelled = Object.keys(bundle)
      .filter((key) => key.startsWith("permissions.label."))
      .map((key) => {
        const [resource, action] = key.slice("permissions.label.".length).split(".");
        return `${resource}:${action}`;
      });
    expect(labelled.filter((permission) => !known.has(permission))).toEqual([]);
  });
});
