// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC taxonomy is owned by core.
 *
 * Built-in modules do not declare their own permissions or API key scopes —
 * core's `lib/permissions.ts` is the single typed source of truth, and
 * modules consume it via the typed `requirePermission(resource, action)`
 * helper. This test pins that contract by asserting both sides:
 *   1. Module manifests expose no `permissions` / `apiKeyScopes` fields.
 *   2. Core's role sets and API key allowlist contain every resource the
 *      built-in modules rely on.
 */

import { describe, it, expect } from "bun:test";
import { resolvePermissions, API_KEY_ALLOWED_SCOPES } from "../../../src/lib/permissions.ts";
import webhooksModule from "../../../src/modules/webhooks/index.ts";
import providerManagementModule from "../../../src/modules/provider-management/index.ts";

type LooseModule = {
  permissions?: unknown;
  apiKeyScopes?: unknown;
};

describe("module RBAC taxonomy", () => {
  it("no built-in module declares its own permissions or apiKeyScopes", () => {
    for (const mod of [
      webhooksModule as unknown as LooseModule,
      providerManagementModule as unknown as LooseModule,
    ]) {
      expect(mod.permissions).toBeUndefined();
      expect(mod.apiKeyScopes).toBeUndefined();
    }
  });

  it("owner role includes every module-owned resource", () => {
    const owner = resolvePermissions("owner");
    for (const perm of [
      "schedules:read",
      "schedules:write",
      "schedules:delete",
      "webhooks:read",
      "webhooks:write",
      "webhooks:delete",
      "models:read",
      "models:write",
      "models:delete",
      "provider-keys:read",
      "provider-keys:write",
      "provider-keys:delete",
    ] as const) {
      expect(owner.has(perm)).toBe(true);
    }
  });

  it("member role includes scheduling write access and model read", () => {
    const member = resolvePermissions("member");
    expect(member.has("schedules:read")).toBe(true);
    expect(member.has("schedules:write")).toBe(true);
    expect(member.has("schedules:delete")).toBe(true);
    expect(member.has("models:read")).toBe(true);
    // Admin-only beyond read
    expect(member.has("models:write")).toBe(false);
    expect(member.has("webhooks:read")).toBe(false);
    expect(member.has("provider-keys:read")).toBe(false);
  });

  it("viewer role includes read-only module resources", () => {
    const viewer = resolvePermissions("viewer");
    expect(viewer.has("schedules:read")).toBe(true);
    expect(viewer.has("models:read")).toBe(true);
    expect(viewer.has("schedules:write")).toBe(false);
    expect(viewer.has("webhooks:read")).toBe(false);
  });

  it("API key allowlist grants every module scope except provider-keys", () => {
    for (const scope of [
      "schedules:read",
      "schedules:write",
      "schedules:delete",
      "webhooks:read",
      "webhooks:write",
      "webhooks:delete",
      "models:read",
      "models:write",
      "models:delete",
    ] as const) {
      expect(API_KEY_ALLOWED_SCOPES.has(scope)).toBe(true);
    }
    // Provider keys are session-only (too sensitive for API key scopes).
    expect(API_KEY_ALLOWED_SCOPES.has("provider-keys:read" as never)).toBe(false);
    expect(API_KEY_ALLOWED_SCOPES.has("provider-keys:write" as never)).toBe(false);
    expect(API_KEY_ALLOWED_SCOPES.has("provider-keys:delete" as never)).toBe(false);
  });
});
