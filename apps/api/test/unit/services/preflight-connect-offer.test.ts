// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the run-kickoff connect-offer mint (#1207).
 *
 * Two halves, and the split matters:
 *
 *  - `connectOfferTarget` is pure — the whole decision of WHICH 412 item may
 *    carry a bearer capability, exercised as a matrix over every resolution
 *    code and every combination of the relay fields.
 *  - `attachConnectOffers` is asserted against the REAL `buildConnectUrl`, and
 *    each minted token is decoded back with `readConnectToken`. Asserting the
 *    URL is non-empty would pass while the claims say something else entirely;
 *    the claims are the security-relevant output.
 *
 * Integration manifests are supplied through the caller's `manifestCache` — the
 * same memo the readiness pass threads, so this exercises the production read
 * path with no DB round-trip. The `block_user_connections` gate is the one
 * thing that must be a real row, so its two cases seed org/space/package
 * directly (no `truncateAll` — unique ids per case, nothing shared).
 */

import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "@appstrate/db/client";
import { organizations, packages, spaces, spacePackages } from "@appstrate/db/schema";
import {
  attachConnectOffers,
  connectOfferTarget,
} from "../../../src/services/connect/preflight-connect-offer.ts";
import { readConnectToken } from "../../../src/services/connect/connect-session.ts";
import type { IntegrationManifestCache } from "../../../src/services/integration-service.ts";
import type { ResolutionFieldError } from "../../../src/lib/errors.ts";
import type { ConnectOfferPolicy } from "../../../src/lib/connect-offer-policy.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const INTEGRATION = "@offers/svc";
const ACTOR: Actor = { type: "user", id: "user-1" };
const SCOPE = { orgId: "org-1", spaceId: "spc_1" };
const CONNECT: ConnectOfferPolicy = { canConnect: true, canConfigure: false };

function authManifest(type: string): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    source: { kind: "none" },
    auths: {
      primary: {
        type,
        delivery: { http: { in: "header", name: "Authorization", value: "Bearer x" } },
      },
    },
  } as unknown as IntegrationManifest;
}

/** Pre-seeded memo — `fetchIntegrationManifest` returns the hit without a SELECT. */
function manifestCache(
  entries: Record<string, IntegrationManifest | "missing">,
): IntegrationManifestCache {
  const cache: IntegrationManifestCache = new Map();
  for (const [id, value] of Object.entries(entries)) {
    cache.set(
      id,
      Promise.resolve(
        value === "missing"
          ? { ok: false, failure: { kind: "not_found" } }
          : { ok: true, manifest: value },
      ),
    );
  }
  return cache;
}

function notConnected(integrationId = INTEGRATION): ResolutionFieldError {
  return {
    field: `integrations.${integrationId}`,
    code: "not_connected",
    title: "Integration Not Connected",
    message: "not connected",
    auth_key: "primary",
    required_scopes: ["mail.read", "mail.send"],
  };
}

function underScoped(ownedByActor: boolean): ResolutionFieldError {
  return {
    field: `integrations.${INTEGRATION}`,
    code: "insufficient_scopes",
    title: "Insufficient Permissions",
    message: "missing scopes",
    auth_key: "primary",
    required_scopes: ["mail.read", "mail.send"],
    connection_id: "conn-9",
    owned_by_actor: ownedByActor,
  };
}

/** The token claims behind a minted `connect_url`. */
function claimsOf(item: ResolutionFieldError) {
  const token = new URL(item.connect_url!).searchParams.get("token");
  expect(token).toBeTruthy();
  return readConnectToken(token!);
}

describe("connectOfferTarget", () => {
  it("accepts not_connected and carries the relayed scopes with no connection id", () => {
    expect(connectOfferTarget(notConnected())).toEqual({
      integrationId: INTEGRATION,
      authKey: "primary",
      scopes: ["mail.read", "mail.send"],
    });
  });

  it("accepts insufficient_scopes on the actor's OWN connection, as an in-place upgrade", () => {
    expect(connectOfferTarget(underScoped(true))).toEqual({
      integrationId: INTEGRATION,
      authKey: "primary",
      scopes: ["mail.read", "mail.send"],
      connectionId: "conn-9",
    });
  });

  it("refuses insufficient_scopes on a foreign-owned connection", () => {
    expect(connectOfferTarget(underScoped(false))).toBeNull();
    // Absent (older relay, or a resolver that could not decide) is not "mine".
    const unknownOwner = { ...underScoped(true) };
    delete unknownOwner.owned_by_actor;
    expect(connectOfferTarget(unknownOwner)).toBeNull();
  });

  it("refuses an owned insufficient_scopes with no connection id to upgrade", () => {
    const noTarget = { ...underScoped(true) };
    delete noTarget.connection_id;
    expect(connectOfferTarget(noTarget)).toBeNull();
  });

  it("refuses every other resolution code, connect-flow relay or not", () => {
    for (const code of [
      "needs_reconnection",
      "must_choose_connection",
      "auth_key_mismatch",
      "pinned_connection_unavailable",
      "override_connection_unavailable",
      "integration_not_active",
      "integration_invalid_manifest",
    ]) {
      expect(connectOfferTarget({ ...notConnected(), code })).toBeNull();
    }
  });

  it("refuses an item with no auth_key — there is no flow to target", () => {
    const noAuthKey = { ...notConnected() };
    delete noAuthKey.auth_key;
    expect(connectOfferTarget(noAuthKey)).toBeNull();
  });

  it("refuses a field outside the integrations namespace, and an empty id", () => {
    expect(connectOfferTarget({ ...notConnected(), field: "prompt" })).toBeNull();
    expect(connectOfferTarget({ ...notConnected(), field: "integrations." })).toBeNull();
  });

  it("defaults scopes to [] when the item relayed none", () => {
    const noScopes = { ...notConnected() };
    delete noScopes.required_scopes;
    expect(connectOfferTarget(noScopes)?.scopes).toEqual([]);
  });
});

describe("attachConnectOffers", () => {
  const cache = manifestCache({ [INTEGRATION]: authManifest("oauth2") });

  it("mints nothing when the actor lacks integrations:connect", async () => {
    const errors = [notConnected()];
    const out = await attachConnectOffers({
      errors,
      scope: SCOPE,
      actor: ACTOR,
      policy: { canConnect: false, canConfigure: false },
      manifestCache: cache,
    });
    expect(out).toEqual(errors);
  });

  it("mints an absolute link on not_connected, with exactly the relayed scopes", async () => {
    const input = notConnected();
    const [item] = await attachConnectOffers({
      errors: [input],
      scope: SCOPE,
      actor: ACTOR,
      policy: CONNECT,
      manifestCache: cache,
    });

    expect(item!.connect_url).toStartWith("http");
    expect(typeof item!.expires_at).toBe("number");
    expect(item!.expires_at).toBeGreaterThan(Date.now());
    expect(item!.package_id).toBe(INTEGRATION);

    const claims = claimsOf(item!);
    expect(claims).toMatchObject({
      org_id: "org-1",
      space_id: "spc_1",
      user_id: "user-1",
      package_id: INTEGRATION,
      auth_key: "primary",
      // Exactly what the item asked for — no union computed at mint time; the
      // defaults ∪ granted union happens at redemption in /connect/start.
      scopes: ["mail.read", "mail.send"],
    });
    expect(claims!.connection_id).toBeUndefined();
    expect(claims!.end_user_id).toBeUndefined();

    // The caller's array and its items are untouched — the same objects feed
    // the `onRunConnectionMissing` webhook payload, which must stay link-free.
    expect(input.connect_url).toBeUndefined();
    expect(item).not.toBe(input);
  });

  it("mints nothing when the relayed scopes are outside the auth's catalog", async () => {
    // The mint is the security boundary: `/connect/start` replays these signed
    // claims and re-validates nothing, so it must not trust `required_scopes`.
    // On the inline-run surface that value is derived from a caller-supplied
    // manifest selection.
    const catalogued = authManifest("oauth2") as unknown as {
      auths: { primary: Record<string, unknown> };
    };
    catalogued.auths.primary.scope_catalog = [{ value: "mail.read", label: "Read" }];
    const [item] = await attachConnectOffers({
      errors: [notConnected()],
      scope: SCOPE,
      actor: ACTOR,
      policy: CONNECT,
      manifestCache: manifestCache({
        [INTEGRATION]: catalogued as unknown as IntegrationManifest,
      }),
    });
    // `mail.send` is not declared → the whole item stays bare, relay fields and all.
    expect(item!.connect_url).toBeUndefined();
    expect(item!.expires_at).toBeUndefined();
    expect(item!.package_id).toBeUndefined();
  });

  it("mints when every relayed scope IS in the catalog", async () => {
    // Discriminating control for the case above: the catalog is what refuses,
    // not its mere presence.
    const catalogued = authManifest("oauth2") as unknown as {
      auths: { primary: Record<string, unknown> };
    };
    catalogued.auths.primary.scope_catalog = [
      { value: "mail.read", label: "Read" },
      { value: "mail.send", label: "Send" },
    ];
    const [item] = await attachConnectOffers({
      errors: [notConnected()],
      scope: SCOPE,
      actor: ACTOR,
      policy: CONNECT,
      manifestCache: manifestCache({
        [INTEGRATION]: catalogued as unknown as IntegrationManifest,
      }),
    });
    expect(item!.connect_url).toStartWith("http");
  });

  it("carries the connection id on an owned insufficient_scopes upgrade", async () => {
    const [item] = await attachConnectOffers({
      errors: [underScoped(true)],
      scope: SCOPE,
      actor: ACTOR,
      policy: CONNECT,
      manifestCache: cache,
    });
    expect(claimsOf(item!)).toMatchObject({ connection_id: "conn-9" });
  });

  it("leaves a foreign-owned insufficient_scopes untouched", async () => {
    const errors = [underScoped(false)];
    expect(
      await attachConnectOffers({
        errors,
        scope: SCOPE,
        actor: ACTOR,
        policy: CONNECT,
        manifestCache: cache,
      }),
    ).toEqual(errors);
  });

  it("mints for an end-user actor under the end_user claim", async () => {
    const [item] = await attachConnectOffers({
      errors: [notConnected()],
      scope: SCOPE,
      actor: { type: "end_user", id: "eu_7" },
      policy: CONNECT,
      manifestCache: cache,
    });
    const claims = claimsOf(item!);
    expect(claims).toMatchObject({ end_user_id: "eu_7" });
    expect(claims!.user_id).toBeUndefined();
  });

  it("leaves the item alone when the auth is not oauth2, or the manifest is gone", async () => {
    const others = manifestCache({
      "@offers/keyed": authManifest("api_key"),
      "@offers/gone": "missing",
    });
    for (const id of ["@offers/keyed", "@offers/gone"]) {
      const errors = [notConnected(id)];
      expect(
        await attachConnectOffers({
          errors,
          scope: SCOPE,
          actor: ACTOR,
          policy: CONNECT,
          manifestCache: others,
        }),
      ).toEqual(errors);
    }
  });

  it("leaves the item alone when the auth key no longer exists on the manifest", async () => {
    const renamed = manifestCache({ [INTEGRATION]: authManifest("oauth2") });
    const errors = [{ ...notConnected(), auth_key: "legacy" }];
    expect(
      await attachConnectOffers({
        errors,
        scope: SCOPE,
        actor: ACTOR,
        policy: CONNECT,
        manifestCache: renamed,
      }),
    ).toEqual(errors);
  });

  it("mints one item's failure without costing the others theirs", async () => {
    // A manifest entry whose promise rejects makes exactly one mint throw; the
    // sibling in the same 412 must still get its link.
    const second = "@offers/other";
    const partial = manifestCache({ [second]: authManifest("oauth2") });
    partial.set(INTEGRATION, Promise.reject(new Error("manifest read exploded")));

    const out = await attachConnectOffers({
      errors: [notConnected(), notConnected(second)],
      scope: SCOPE,
      actor: ACTOR,
      policy: CONNECT,
      manifestCache: partial,
    });
    expect(out[0]!.connect_url).toBeUndefined();
    expect(out[1]!.connect_url).toStartWith("http");
    expect(out[1]!.package_id).toBe(second);
  });

  describe("block_user_connections", () => {
    async function seedBlockedInstall(): Promise<{ spaceId: string; integrationId: string }> {
      const [org] = await db
        .insert(organizations)
        .values({ name: "offers", slug: `offers-${randomUUID().slice(0, 8)}` })
        .returning({ id: organizations.id });
      const spaceId = `spc_${randomUUID().slice(0, 12)}`;
      await db.insert(spaces).values({ id: spaceId, orgId: org!.id, name: "default" });
      const integrationId = `@offers/blocked-${randomUUID().slice(0, 8)}`;
      await db.insert(packages).values({
        id: integrationId,
        orgId: org!.id,
        type: "integration",
        source: "local",
        draftManifest: authManifest("oauth2") as unknown as Record<string, unknown>,
      });
      await db
        .insert(spacePackages)
        .values({ spaceId, packageId: integrationId, blockUserConnections: true });
      return { spaceId, integrationId };
    }

    it("refuses to mint for an actor who may only connect", async () => {
      const { spaceId, integrationId } = await seedBlockedInstall();
      const errors = [notConnected(integrationId)];
      expect(
        await attachConnectOffers({
          errors,
          scope: { orgId: "org-1", spaceId },
          actor: ACTOR,
          policy: CONNECT,
          manifestCache: manifestCache({ [integrationId]: authManifest("oauth2") }),
        }),
      ).toEqual(errors);
    });

    it("mints for an actor holding integrations:configure — the admin carve-out", async () => {
      const { spaceId, integrationId } = await seedBlockedInstall();
      const [item] = await attachConnectOffers({
        errors: [notConnected(integrationId)],
        scope: { orgId: "org-1", spaceId },
        actor: ACTOR,
        policy: { canConnect: true, canConfigure: true },
        manifestCache: manifestCache({ [integrationId]: authManifest("oauth2") }),
      });
      expect(item!.connect_url).toStartWith("http");
      expect(claimsOf(item!)).toMatchObject({ package_id: integrationId });
    });
  });
});
