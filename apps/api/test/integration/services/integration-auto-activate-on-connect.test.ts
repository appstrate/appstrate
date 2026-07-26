// SPDX-License-Identifier: Apache-2.0

/**
 * C1 — connecting an integration ACTIVATES it in the application.
 *
 * Production failure this pins: the chat offered a connect card, the user
 * connected, four agent runs launched, and all four died with
 * `integration_not_active` (412, "not installed or is disabled in this
 * application"). Storing a credential did not create the `application_packages`
 * row the activation gate reads, so the integration stayed inactive.
 *
 * The write happens at the connection-persist seam
 * (`persistCredentialBundle` → `activateOnConnect`), inside the connection's
 * transaction, on BOTH user-initiated branches (insert + reconnect). Rules:
 *
 *   1. `mayActivate` false/absent → NOTHING. Connecting is a personal act
 *      (`integrations:connect`); activating is tenant-wide
 *      (`integrations:install`, admin-only). The shortcut must never grant it.
 *   2. NO row                → INSERT `enabled = true` + one audit event.
 *   3. row `enabled = false` → NOTHING. Deactivation is a deliberate, STICKY
 *      opt-out (it is what turns off an auto-active system integration);
 *      resurrecting it on reconnect would be a security regression.
 *   4. row `enabled = true`  → no duplicate row, no duplicate audit, and no
 *      clobbering of the row's existing per-app settings.
 *
 * Route-level proof that `mayActivate` reflects the caller's real permissions
 * lives in `test/integration/routes/integration-auto-activate-authz.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, auditEvents } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApplication, seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import {
  isIntegrationActive,
  saveIntegrationConnection,
} from "../../../src/services/integration-connections.ts";
import type { AppScope } from "../../../src/lib/scope.ts";
import type { Actor } from "@appstrate/connect";

const INTEGRATION = "@autoact/firecrawl";

describe("auto-activation on connect (C1)", () => {
  let ctx: TestContext;
  let scope: AppScope;
  let actor: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "autoact" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    actor = { type: "user", id: ctx.user.id };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
  });

  /** Fresh connection (INSERT branch). `mayActivate` mirrors the caller's grant. */
  function connect(accountId: string, opts?: { mayActivate?: boolean }) {
    return saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "api_key",
      accountId,
      credentials: { api_key: `key-${accountId}` },
      actor,
      ...(opts?.mayActivate !== undefined ? { mayActivate: opts.mayActivate } : {}),
    });
  }

  /** Reconnect an existing row (UPDATE-owned branch). */
  function reconnect(connectionId: string, accountId: string, opts?: { mayActivate?: boolean }) {
    return saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "api_key",
      accountId,
      credentials: { api_key: `rotated-${accountId}` },
      actor,
      connectionId,
      ...(opts?.mayActivate !== undefined ? { mayActivate: opts.mayActivate } : {}),
    });
  }

  function installRows() {
    return db
      .select()
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, INTEGRATION),
        ),
      );
  }

  function activationAudits() {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, ctx.orgId),
          eq(auditEvents.action, "integration.activated"),
          eq(auditEvents.resourceId, INTEGRATION),
        ),
      );
  }

  // ─── Rule 1 — the capability gate ────────────────────────

  it("does NOT activate when the caller may not install (mayActivate false)", async () => {
    const conn = await connect("member@example.com", { mayActivate: false });

    // The connection itself still succeeds — lacking the install grant is a
    // normal outcome, not an error.
    expect(conn.id).toBeTruthy();
    expect(await installRows()).toHaveLength(0);
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);
    expect(await activationAudits()).toHaveLength(0);
  });

  it("fails closed when the capability is omitted entirely", async () => {
    // A future call site that forgets to thread the flag must NOT activate.
    await connect("forgetful@example.com");

    expect(await installRows()).toHaveLength(0);
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);
    expect(await activationAudits()).toHaveLength(0);
  });

  it("does not activate on reconnect either when the caller may not install", async () => {
    const conn = await connect("member@example.com", { mayActivate: false });
    await reconnect(conn.id, "member@example.com", { mayActivate: false });

    expect(await installRows()).toHaveLength(0);
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);
  });

  // ─── Rule 2 — first connection activates ─────────────────

  it("activates a never-installed integration and audits it as auto_on_connect", async () => {
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);

    await connect("alice@example.com", { mayActivate: true });

    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(true);
    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);

    // Distinguishable from the manual POST /activate route, which records no
    // `after` payload.
    const audits = await activationAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.applicationId).toBe(ctx.defaultAppId);
    expect(audits[0]!.actorType).toBe("user");
    expect(audits[0]!.actorId).toBe(ctx.user.id);
    expect(audits[0]!.resourceType).toBe("integration");
    expect(audits[0]!.after).toEqual({ enabled: true, reason: "auto_on_connect" });
  });

  it("repairs a connection that outlived its install row, on reconnect", async () => {
    // The permanent-trap case: the connection exists but the
    // `application_packages` row does not (uninstall deletes the row and keeps
    // connections). Every run 412s, and reconnecting — the obvious remedy —
    // must fix it rather than leave the user stuck forever.
    const conn = await connect("alice@example.com", { mayActivate: true });
    await db
      .delete(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, INTEGRATION),
        ),
      );
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);

    await reconnect(conn.id, "alice@example.com", { mayActivate: true });

    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(true);
    expect(await installRows()).toHaveLength(1);
  });

  // ─── Rule 3 — the sticky opt-out ─────────────────────────

  it("NEVER resurrects an explicitly deactivated integration (sticky opt-out)", async () => {
    // The operator deliberately turned this integration off for the app. A
    // connect must not silently undo that decision — `ON CONFLICT DO NOTHING`
    // is what guarantees it. This is the single most important assertion here.
    await seedInstalledPackage(ctx.defaultAppId, INTEGRATION, { enabled: false });

    await connect("alice@example.com", { mayActivate: true });

    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);
    expect(await activationAudits()).toHaveLength(0);
  });

  it("NEVER resurrects a deactivated integration on RECONNECT either", async () => {
    // The reconnect branch runs the same guarded writer — adding it must not
    // have opened a second door onto the sticky opt-out.
    const conn = await connect("alice@example.com", { mayActivate: true });
    await seedInstalledPackage(ctx.defaultAppId, INTEGRATION, { enabled: false });

    await reconnect(conn.id, "alice@example.com", { mayActivate: true });

    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);
  });

  it("stays inactive across repeated connections once explicitly deactivated", async () => {
    await seedInstalledPackage(ctx.defaultAppId, INTEGRATION, { enabled: false });

    await connect("alice@example.com", { mayActivate: true });
    await connect("bob@example.com", { mayActivate: true });

    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(false);
    expect(await installRows()).toHaveLength(1);
    expect(await activationAudits()).toHaveLength(0);
  });

  // ─── Rule 4 — idempotence ────────────────────────────────

  it("is a no-op when the integration is already active", async () => {
    // An existing enabled row also carries per-app settings — the activation
    // write must not touch them (a DO UPDATE upsert would have reset `config`).
    await seedInstalledPackage(ctx.defaultAppId, INTEGRATION, {
      enabled: true,
      config: { region: "eu" },
    });

    await connect("alice@example.com", { mayActivate: true });

    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.config).toEqual({ region: "eu" });
    expect(await activationAudits()).toHaveLength(0);
  });

  it("audits the activation exactly once across several connections", async () => {
    const first = await connect("alice@example.com", { mayActivate: true });
    await connect("bob@example.com", { mayActivate: true });
    await reconnect(first.id, "alice@example.com", { mayActivate: true });

    expect(await installRows()).toHaveLength(1);
    expect(await activationAudits()).toHaveLength(1);
    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(true);
  });

  it("activates only in the application the connection was made in", async () => {
    // Activation is per-(application, integration): connecting in app A must not
    // make the integration active in a sibling application of the same org.
    const sibling = await seedApplication({ orgId: ctx.orgId, name: "Sibling App" });

    await connect("alice@example.com", { mayActivate: true });

    expect(await isIntegrationActive(INTEGRATION, ctx.defaultAppId)).toBe(true);
    expect(await isIntegrationActive(INTEGRATION, sibling.id)).toBe(false);
  });
});
