// SPDX-License-Identifier: Apache-2.0

/** Fixtures for tests of `refreshConnectionCredential`: a Gmail-like OAuth2 integration with a pinned client. */

import { eq } from "drizzle-orm";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AfpsManifestAuth } from "../../src/services/integration-manifest-helpers.ts";
import {
  refreshConnectionCredential,
  type RefreshTarget,
  type RefreshTrigger,
} from "../../src/services/integration-token-refresh.ts";
import type { TestContext } from "./auth.ts";
import { readCredentialRevision } from "./credential-revision.ts";
import { db } from "./db.ts";
import { seedPackage } from "./seed.ts";

export const GMAIL_PACKAGE_ID = "@official/gmail";

function gmailManifest(tokenUrl: string): IntegrationManifest {
  return {
    schema_version: "0.1",
    type: "integration",
    name: GMAIL_PACKAGE_ID,
    version: "1.0.0",
    display_name: "Gmail",
    source: {
      kind: "local",
      server: {
        type: "node",
        entry_point: "server/index.js",
        mcp_config: { command: "node", args: ["server/index.js"] },
      },
    },
    auths: {
      primary: {
        type: "oauth2",
        authorization_endpoint: "https://idp/a",
        token_endpoint: tokenUrl,
        authorized_uris: ["https://api/*"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
}

/**
 * The integration, its token endpoint at `tokenUrl`, and the per-space OAuth client a connection
 * pins (`client_ref`) so its refresh context builds. Returns that client's id.
 */
export async function seedPinnedClient(ctx: TestContext, tokenUrl: string): Promise<string> {
  await seedPackage({
    id: GMAIL_PACKAGE_ID,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: gmailManifest(tokenUrl) as unknown as Record<string, unknown>,
  });
  const [client] = await db
    .insert(integrationOauthClients)
    .values({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      integrationId: GMAIL_PACKAGE_ID,
      authKey: "primary",
      clientId: "cid",
      clientSecretEncrypted: encryptCredentials({ client_secret: "csec" }),
    })
    .returning({ id: integrationOauthClients.id });
  return client!.id;
}

export type RefreshFixtureTarget = RefreshTarget & {
  expiresAt: Date | null;
  credentialRevision: string;
};

/** The connection as a resolver reads it: what a refresh is pinned to. */
export async function readRefreshTarget(connId: string): Promise<RefreshFixtureTarget> {
  const [row] = await db
    .select({
      id: integrationConnections.id,
      orgId: integrationConnections.orgId,
      spaceId: integrationConnections.spaceId,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      clientRef: integrationConnections.clientRef,
      oauthResource: integrationConnections.oauthResource,
      expiresAt: integrationConnections.expiresAt,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connId));
  return { ...row!, credentialRevision: (await readCredentialRevision(connId))! };
}

/** Ask `refreshConnectionCredential` about `target`, the manifest's token endpoint being `tokenUrl`. */
export function refreshOf(target: RefreshFixtureTarget, tokenUrl: string, trigger: RefreshTrigger) {
  const manifest = gmailManifest(tokenUrl);
  return refreshConnectionCredential({
    connection: { ...target, authKey: "primary" },
    integrationId: GMAIL_PACKAGE_ID,
    manifest,
    authDef: manifest.auths!.primary as AfpsManifestAuth,
    trigger,
  });
}
