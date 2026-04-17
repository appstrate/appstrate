// SPDX-License-Identifier: Apache-2.0

/**
 * Declarative provisioning of instance-level OAuth clients from the
 * `OIDC_INSTANCE_CLIENTS` env var.
 *
 * Called once from `oidcModule.init()` at boot, after `ensureInstanceClient()`
 * has provisioned the platform SPA client. The sync materializes every
 * declared satellite client (admin dashboard, second-party web app, …) as
 * a `level: "instance"` row in `oauth_clients`.
 *
 * ## Policy — create-only + fail-on-drift
 *
 * - First boot: client absent → INSERT via `createInstanceClientFromEnv`.
 * - Later boots: client present and every managed field matches → no-op.
 * - Later boots: client present but a managed field differs → **boot
 *   aborted** with an error listing the divergent fields. The operator
 *   must either revert the env or manually delete the row and restart.
 * - Client removed from env (still present in DB) → **warning only**, no
 *   destructive action. The operator owns the lifecycle of deletion.
 *
 * Rationale: a silent sync on `redirectUris` would quietly invalidate prod
 * satellite sessions; a loud fail forces a conscious review. The
 * auto-provisioned platform client (created by `createClient()` with an
 * `oauth_`-prefixed random `clientId`) is whitelisted from orphan warnings
 * so it never pollutes the logs.
 *
 * ## Secret handling
 *
 * The operator supplies the `clientSecret` in plaintext in the env JSON
 * (typically via `openssl rand -base64 32` and their secret manager). The
 * secret is SHA-256 hashed at insert — plaintext lives only in memory for
 * the duration of the hash call and is never logged.
 *
 * See also:
 * - `services/oauth-admin.ts` — the underlying `createInstanceClientFromEnv`,
 *   `compareDeclaredClientWithStored`, and `listInstanceClientIds` helpers.
 * - `docs/architecture/OSS_EE_SPEC.md` — why we avoid HTTP admin surface
 *   for instance clients.
 */

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { logger } from "../../../lib/logger.ts";
import {
  createInstanceClientFromEnv,
  compareDeclaredClientWithStored,
  listInstanceClientIds,
  updateInstanceClientPolicyFromEnv,
  OAuthAdminValidationError,
  type CreateInstanceClientFromEnvInput,
} from "./oauth-admin.ts";
import { APPSTRATE_CLI_CLIENT_ID } from "./ensure-cli-client.ts";

/**
 * Strict Zod schema for a single declared entry.
 *
 * Stricter than `createClient` / `oauthClientBaseSchema`:
 *  - `clientId` is a human-chosen stable key with a restricted charset to
 *    avoid nasty URL-encoding footguns at the OAuth endpoints.
 *  - `clientId` cannot start with `oauth_` — that prefix is reserved for
 *    auto-generated random clientIds produced by `createClient()`. Allowing
 *    operator-chosen `oauth_`-prefixed values would break the orphan
 *    whitelist heuristic downstream.
 *  - `clientSecret` imposes a 32-char minimum (~192 bits of entropy when
 *    base64-encoded — enough for HMAC and strong-auth integrations).
 *  - `redirectUris` requires at least one entry; service-level validation
 *    (`assertValidRedirectUris` inside `createInstanceClientFromEnv`) then
 *    runs SSRF + scheme checks via `isValidRedirectUri`.
 */
const declaredInstanceClientSchema = z.object({
  clientId: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, "clientId must match /^[a-zA-Z0-9_-]+$/")
    .refine((v) => !v.startsWith("oauth_"), {
      message: "clientId prefix 'oauth_' is reserved for auto-generated platform clients",
    }),
  clientSecret: z.string().min(32, "clientSecret must be at least 32 characters"),
  name: z.string().min(1).max(200),
  redirectUris: z.array(z.url()).min(1),
  postLogoutRedirectUris: z.array(z.url()).default([]),
  scopes: z.array(z.string()).default(["openid", "profile", "email", "offline_access"]),
  skipConsent: z.boolean().default(false),
  /**
   * Policy flag — whether BA should let a brand-new user sign up through
   * this client. Mutable: unlike redirectUris / secret, this flag is
   * re-synced on every boot (see `syncInstanceClientPolicy` in the sync
   * loop below), so an operator can flip it in env + restart without
   * manually touching the DB. Drift on this field is NOT fatal.
   */
  allowSignup: z.boolean().default(false),
});

const declaredInstanceClientsSchema = z.array(declaredInstanceClientSchema);

type DeclaredInstanceClient = z.infer<typeof declaredInstanceClientSchema>;

function toServiceInput(declared: DeclaredInstanceClient): CreateInstanceClientFromEnvInput {
  return {
    clientId: declared.clientId,
    clientSecretPlaintext: declared.clientSecret,
    name: declared.name,
    redirectUris: declared.redirectUris,
    postLogoutRedirectUris: declared.postLogoutRedirectUris,
    scopes: declared.scopes,
    skipConsent: declared.skipConsent,
    allowSignup: declared.allowSignup,
  };
}

/**
 * Fatal boot error raised when env-declared instance clients cannot be
 * synchronized. Distinguished from generic errors so the module loader
 * can surface a clean message without a stack trace dump.
 */
export class InstanceClientSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceClientSyncError";
  }
}

/**
 * Entry point — reconcile the declaration against the DB.
 *
 * MUST be called after `applyMigrations` and after `ensureInstanceClient()`
 * in `oidcModule.init()`. Throws on any parse, drift, or collision error.
 */
export async function syncInstanceClientsFromEnv(): Promise<void> {
  const env = getEnv();
  const raw = env.OIDC_INSTANCE_CLIENTS;

  // Step 1 — parse + validate.
  const parseResult = declaredInstanceClientsSchema.safeParse(raw);
  if (!parseResult.success) {
    // z.prettifyError available in Zod 4; fall back to a concise issue list.
    const issues = parseResult.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new InstanceClientSyncError(`OIDC_INSTANCE_CLIENTS: invalid JSON schema\n${issues}`);
  }
  const declared = parseResult.data;

  // Step 2 — reject duplicate clientIds inside the declaration itself.
  const seen = new Set<string>();
  for (const entry of declared) {
    if (seen.has(entry.clientId)) {
      throw new InstanceClientSyncError(
        `OIDC_INSTANCE_CLIENTS: duplicate clientId '${entry.clientId}' in declaration`,
      );
    }
    seen.add(entry.clientId);
  }

  // Step 3 — reconcile each entry against the DB.
  let createdCount = 0;
  let unchangedCount = 0;
  for (const entry of declared) {
    const input = toServiceInput(entry);
    let drift;
    try {
      drift = await compareDeclaredClientWithStored(input);
    } catch (err) {
      throw new InstanceClientSyncError(
        `OIDC_INSTANCE_CLIENTS: failed to load stored client '${entry.clientId}': ${(err as Error).message}`,
      );
    }

    if (drift.kind === "not-found") {
      try {
        await createInstanceClientFromEnv(input);
      } catch (err) {
        if (err instanceof OAuthAdminValidationError) {
          throw new InstanceClientSyncError(
            `OIDC_INSTANCE_CLIENTS: client '${entry.clientId}' rejected by service validation on field '${err.field}': ${err.message}`,
          );
        }
        throw new InstanceClientSyncError(
          `OIDC_INSTANCE_CLIENTS: failed to create client '${entry.clientId}': ${(err as Error).message}`,
        );
      }
      createdCount++;
      logger.info("OIDC instance client created from env", {
        module: "oidc",
        clientId: entry.clientId,
        redirectUrisCount: entry.redirectUris.length,
      });
      continue;
    }

    if (drift.kind === "wrong-level") {
      throw new InstanceClientSyncError(
        `OIDC_INSTANCE_CLIENTS: clientId '${entry.clientId}' collides with an existing ${drift.storedLevel}-level OAuth client. Refusing to operate — pick a different clientId or remove the conflicting row manually.`,
      );
    }

    if (drift.kind === "match") {
      // Always re-sync mutable policy fields — `allowSignup` is designed
      // to be toggled from env + restart without manually editing the DB.
      // Idempotent: a no-op UPDATE when the flag already matches.
      await updateInstanceClientPolicyFromEnv(entry.clientId, {
        allowSignup: entry.allowSignup,
      });
      unchangedCount++;
      logger.debug("OIDC instance client unchanged", {
        module: "oidc",
        clientId: entry.clientId,
        allowSignup: entry.allowSignup,
      });
      continue;
    }

    // drift.kind === "drift"
    const fields = drift.mismatches.map((m) => m.field).join(", ");
    const detailed = drift.mismatches
      .map(
        (m) =>
          `    ${m.field}: stored=${JSON.stringify(m.stored)} declared=${JSON.stringify(m.declared)}`,
      )
      .join("\n");
    throw new InstanceClientSyncError(
      `OIDC_INSTANCE_CLIENTS: drift detected on client '${entry.clientId}' (fields: ${fields}).\n` +
        `  The env declaration no longer matches the stored client. To change these fields, delete\n` +
        `  the oauth_clients row manually (SQL: DELETE FROM oauth_clients WHERE client_id='${entry.clientId}')\n` +
        `  and restart — this refuses silent updates to avoid invalidating prod satellite sessions.\n` +
        `  Mismatches:\n${detailed}`,
    );
  }

  // Step 4 — orphan warning for instance rows absent from the declaration.
  // Whitelist the auto-provisioned platform client (`oauth_`-prefixed) and
  // the auto-provisioned CLI client (`appstrate-cli`) so neither raises a
  // warning — the `oauth_` prefix is reserved by the strict Zod schema
  // above, and `appstrate-cli` is a fixed literal used across every
  // install. Both are provisioned from code (see `ensureInstanceClient`
  // and `ensureCliClient`), not from `OIDC_INSTANCE_CLIENTS`.
  const storedIds = await listInstanceClientIds();
  const declaredIds = new Set(declared.map((d) => d.clientId));
  const orphans = storedIds.filter(
    (id) => !declaredIds.has(id) && !id.startsWith("oauth_") && id !== APPSTRATE_CLI_CLIENT_ID,
  );
  for (const orphanId of orphans) {
    logger.warn(
      "OIDC instance client exists in DB but is absent from OIDC_INSTANCE_CLIENTS — ignoring (no automatic deletion)",
      { module: "oidc", clientId: orphanId },
    );
  }

  logger.info("OIDC instance client sync complete", {
    module: "oidc",
    declared: declared.length,
    created: createdCount,
    unchanged: unchangedCount,
    orphans: orphans.length,
  });
}
