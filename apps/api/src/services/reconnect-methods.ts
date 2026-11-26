// SPDX-License-Identifier: Apache-2.0

import type { IntegrationManifest } from "@appstrate/core/integration";
import { db } from "@appstrate/db/client";
import { integrationOauthClients as clients } from "@appstrate/db/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  getDefaultSystemIntegrationClient,
  listSystemIntegrationClientsFor,
} from "./integration-client-registry.ts";
import {
  usesAutoProvisionedClient,
  type AfpsManifestAuth,
} from "./integration-manifest-helpers.ts";

/** Client tiers visible in these spaces, without reading any client secrets. */
export function readOAuthClientRegistrations(
  orgId: string,
  packageIds: string[],
  spaceIds: string[],
) {
  return db
    .selectDistinct({
      packageId: clients.integrationId,
      authKey: clients.authKey,
      spaceId: clients.spaceId,
      autoProvisioned: clients.autoProvisioned,
    })
    .from(clients)
    .where(
      and(
        eq(clients.orgId, orgId),
        inArray(clients.integrationId, packageIds),
        or(isNull(clients.spaceId), inArray(clients.spaceId, spaceIds)),
      ),
    );
}

/**
 * The scopes where each method can renew an existing connection. As on a registered client,
 * `null` serves the whole org. Discovery and provisioning belong to connect itself.
 */
export function reconnectMethods(
  manifests: ReadonlyMap<string, IntegrationManifest>,
  registrations: Awaited<ReturnType<typeof readOAuthClientRegistrations>>,
) {
  const methods = new Map<string, Map<string, Set<string | null>>>();
  for (const [packageId, manifest] of manifests) {
    const auths = new Map<string, Set<string | null>>();
    for (const [key, auth] of Object.entries(manifest.auths ?? {})) {
      const scopes = new Set<string | null>();
      if (
        auth.type !== "oauth2" ||
        usesAutoProvisionedClient(manifest, auth) ||
        getDefaultSystemIntegrationClient(packageId, key) !== null
      )
        scopes.add(null);
      auths.set(key, scopes);
    }
    methods.set(packageId, auths);
  }
  for (const row of registrations) {
    if (!row.autoProvisioned) methods.get(row.packageId)?.get(row.authKey)?.add(row.spaceId);
  }
  return (packageId: string, authKey: string, rowSpaceId: string | null): boolean => {
    const scopes = methods.get(packageId)?.get(authKey);
    return scopes !== undefined && (scopes.has(null) || scopes.has(rowSpaceId));
  };
}

/** What a connect of one auth can use: the three flags the integration sheet reports. */
export function authClientFlags(
  packageId: string,
  manifest: IntegrationManifest,
  authKey: string,
  auth: AfpsManifestAuth,
  registrations: Awaited<ReturnType<typeof readOAuthClientRegistrations>>,
) {
  // Provisioned at connect time (CIMD or DCR): connectable without a registered client.
  const autoProvisioned = usesAutoProvisionedClient(manifest, auth);
  return {
    // A classic auth chooses among the manual rows only (`loadClientTiers`), so a leftover
    // auto-provisioned row does not make it connectable.
    has_oauth_client: registrations.some(
      (r) =>
        r.packageId === packageId &&
        r.authKey === authKey &&
        (autoProvisioned || !r.autoProvisioned),
    ),
    // A shared platform client (SYSTEM_INTEGRATIONS) also serves connect.
    has_system_client: listSystemIntegrationClientsFor(packageId, authKey).length > 0,
    client_auto_provisioned: autoProvisioned,
  };
}

/** A connect flow can start for the auth: non-oauth2 always, oauth2 with a usable client. */
export function isAuthConnectable(
  packageId: string,
  manifest: IntegrationManifest,
  authKey: string,
  auth: AfpsManifestAuth,
  registrations: Awaited<ReturnType<typeof readOAuthClientRegistrations>>,
): boolean {
  if (auth.type !== "oauth2") return true;
  const flags = authClientFlags(packageId, manifest, authKey, auth, registrations);
  return flags.has_oauth_client || flags.has_system_client || flags.client_auto_provisioned;
}
