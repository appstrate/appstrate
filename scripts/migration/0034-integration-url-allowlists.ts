#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0034 — per-connection URL allowlists (#1627, #1628), env loaded (it decrypts):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0034-integration-url-allowlists.ts [--apply]
 *
 * `@appstrate/activecampaign` 1.0.3, `wordpress` / `woocommerce` 1.0.4 and `webhooks` 1.0.3 drop
 * `allow_all_uris` for `authorized_uris` rendered from one URL field of the connection
 * (`{$credential.api_url}/**`, `{$credential.site_url}/**`, `{$credential.webhook_url}`). A
 * connection whose field does not render has every call refused; from this release a new or
 * updated connection is refused at connect time instead (`unrenderableAuthorizedUriFields`).
 *
 * 1. Rewrite: an ActiveCampaign connection without `api_url` gets
 *    `https://<account_name>.api-us1.com`. `account_name` is kept: 1.0.3 still declares it
 *    (optional), so prompts calling `https://{{account_name}}.api-us1.com/…` keep resolving. An
 *    account on another API domain must then edit its `api_url`. Skipped when `account_name` is
 *    missing or not a hostname label. Idempotent: a connection holding `api_url` is never touched.
 * 2. Audit: every connection of the four integrations whose URL field would not render, with its
 *    id and the form the field must take — never a value. Same rules as the runtime and the
 *    connect-time check (`unrenderableAuthorizedUriFields`): a query string is refused before a
 *    `/**` suffix, allowed in the bare `webhook_url` entry.
 *
 * Run `--apply` just BEFORE the deploy: it only adds a field, which the running 1.0.2 manifest
 * ignores (its `allow_all_uris` and `{{account_name}}` substitution are unchanged), so no call is
 * refused in between; re-run the dry run after the deploy. Dry run by default (rolled back). Exit
 * 1 when any connection is refused, in both modes: its owner must fix the URL in the connection.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { unrenderableAuthorizedUriFields } from "@appstrate/afps-shared/credential-template";
import { decryptCredentials, encryptCredentialEnvelope } from "@appstrate/connect";

/** `auths.primary.authorized_uris` of each integration, as shipped. */
const URL_AUTHS: Record<string, string[]> = {
  "@appstrate/activecampaign": ["{$credential.api_url}/**"],
  "@appstrate/wordpress": ["{$credential.site_url}/**"],
  "@appstrate/woocommerce": ["{$credential.site_url}/**"],
  "@appstrate/webhooks": ["{$credential.webhook_url}"],
};
const ACTIVECAMPAIGN = "@appstrate/activecampaign";
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

type Envelope = { v: 2; outputs: Record<string, unknown>; inputs?: Record<string, unknown> };
class DryRunRollback extends Error {}

/** @returns the exit status: 1 when any connection is refused. */
export async function runIntegrationUrlAllowlists(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<0 | 1> {
  const { apply, out } = options;
  // Imported here, not at the top: `@appstrate/db/client` opens its database on import, and the
  // entry point refuses the embedded one before that.
  const { db, toRows } = await import("@appstrate/db/client");
  let refused = 0;
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '120s'");
      const [target] = toRows<{ name: string }>(
        await tx.execute("SELECT current_database() AS name"),
      );
      out(`0034 — ${apply ? "APPLY" : "DRY RUN"} on database ${target!.name}`);
      const rows = await tx
        .select({
          id: integrationConnections.id,
          pkg: integrationConnections.integrationId,
          credentialsEncrypted: integrationConnections.credentialsEncrypted,
        })
        .from(integrationConnections)
        .where(
          and(
            inArray(integrationConnections.integrationId, Object.keys(URL_AUTHS)),
            eq(integrationConnections.authKey, "primary"),
          ),
        )
        .orderBy(asc(integrationConnections.integrationId), asc(integrationConnections.id))
        .for("update");

      let rewritten = 0;
      for (const row of rows) {
        const envelope = decryptCredentials<Envelope>(row.credentialsEncrypted);
        if (envelope?.v !== 2 || typeof envelope.outputs !== "object") {
          throw new Error(`connection ${row.id}: credentials are not a v2 envelope`);
        }
        let outputs = envelope.outputs;

        if (row.pkg === ACTIVECAMPAIGN && !outputs.api_url) {
          const account = outputs.account_name;
          if (typeof account === "string" && HOST_LABEL.test(account)) {
            outputs = { ...outputs, api_url: `https://${account}.api-us1.com` };
            const ciphertext = encryptCredentialEnvelope({ outputs, inputs: envelope.inputs });
            await tx
              .update(integrationConnections)
              .set({ credentialsEncrypted: ciphertext, updatedAt: sql`now()` })
              .where(eq(integrationConnections.id, row.id));
            rewritten += 1;
            out(`  rewrite ${row.pkg} ${row.id}: api_url from account_name`);
          } else {
            out(`  skip    ${row.pkg} ${row.id}: account_name missing or not a hostname label`);
          }
        }

        const [bad] = unrenderableAuthorizedUriFields(URL_AUTHS[row.pkg]!, outputs);
        if (!bad) continue;
        refused += 1;
        const value = outputs[bad.field];
        const why =
          typeof value === "string" && value !== "" ? `must be ${bad.expected}` : "missing";
        out(`  REFUSED ${row.pkg} ${row.id}: ${bad.field} ${why}`);
      }

      out(`${rows.length} connection(s) scanned, ${rewritten} rewritten, ${refused} refused`);
      if (!apply) throw new DryRunRollback();
    });
    out("0034: APPLIED — committed.");
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0034: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
  }
  return refused > 0 ? 1 : 0;
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  const out = (line: string) => process.stdout.write(`${line}\n`);
  // An empty DATABASE_URL makes `@appstrate/db/client` open ./data/pglite instead.
  if (!process.env.DATABASE_URL) {
    out("DATABASE_URL is required — the platform database to rewrite");
    process.exit(2);
  }
  const { closeDb } = await import("@appstrate/db/client");
  let code = 1;
  try {
    code = await runIntegrationUrlAllowlists({ apply, out });
  } catch (error) {
    out(`0034: FAILED, nothing committed — ${getErrorMessage(error)}`);
  } finally {
    await closeDb();
  }
  process.exit(code);
}
