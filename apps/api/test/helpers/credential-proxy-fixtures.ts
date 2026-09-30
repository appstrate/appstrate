// SPDX-License-Identifier: Apache-2.0

/** Fixtures for `proxyCall()` integration tests: a placed integration and its connections. */

import type { IntegrationManifest } from "@appstrate/core/integration";
import { spacePackages, integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { db } from "./db.ts";
import type { TestContext } from "./auth.ts";
import { seedPackage, seedPackageShare, seedPublishedVersion } from "./seed.ts";

/**
 * Seed a local integration, publish its manifest as `latest` (the version the proxy reads), and
 * switch it on in the context's default space. The OFFER is the PLACEMENT: a `space_packages` row
 * only speaks for a space the package is placed in, so both writes are needed for it to be active.
 */
export async function seedProxyIntegration(
  ctx: TestContext,
  manifest: IntegrationManifest,
): Promise<void> {
  await seedPackage({
    id: manifest.name,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
  await seedPublishedVersion(manifest.name, manifest.version);
  await seedPackageShare(ctx.defaultSpaceId, manifest.name);
  await db.insert(spacePackages).values({ spaceId: ctx.defaultSpaceId, packageId: manifest.name });
}

/** Add a connection owned by the context user on `authKey`, labelled `accountId`; returns its id. */
export async function seedProxyConnection(
  ctx: TestContext,
  packageId: string,
  authKey: string,
  fields: Record<string, string>,
  accountId = "acct-1",
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: packageId,
      authKey,
      accountId,
      label: accountId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: fields }),
      scopesGranted: [],
      sharedWithOrg: false,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}
