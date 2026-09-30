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
 *    `https://<account_name>.api-us1.com`, and `account_name` (gone from 1.0.3) is removed. An
 *    account on another API domain must then edit its connection. Skipped when `account_name` is
 *    not a hostname label. Idempotent: it only touches connections still holding `account_name`.
 * 2. Audit: every connection of the four integrations whose URL field would not render, with its
 *    id and the form the field must take — never a value. Same rules as the runtime and the
 *    connect-time check (`unrenderableAuthorizedUriFields`): a query string is refused before a
 *    `/**` suffix, allowed in the bare `webhook_url` entry.
 *
 * Run `--apply` just BEFORE the deploy: the running 1.0.2 manifest reads neither `account_name` nor
 * `api_url` at runtime (`allow_all_uris`), so no call is refused in between; re-run the dry run
 * after the deploy. Dry run by default (rolled back). Exit 1 when any connection is refused, in
 * both modes: its owner must fix the URL in the connection.
 */

import { SQL } from "bun";
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

const apply = process.argv.includes("--apply");
const out = (line: string) => process.stdout.write(`${line}\n`);
const url = process.env.DATABASE_URL;
if (!url) {
  out("DATABASE_URL is required — the platform database to rewrite");
  process.exit(2);
}

const sql = new SQL(url, { max: 1 });
let refused = 0;
let failed = false;
try {
  await sql.begin(async (tx: SQL) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    const [db] = await tx`SELECT current_database() AS name`;
    out(`0034 — ${apply ? "APPLY" : "DRY RUN"} on database ${db.name}`);
    const rows: { id: string; pkg: string; credentials_encrypted: string }[] = await tx`
      SELECT id, integration_package_id AS pkg, credentials_encrypted FROM integration_connections
       WHERE integration_package_id IN ${tx(Object.keys(URL_AUTHS))} AND auth_key = 'primary'
       ORDER BY integration_package_id, id
         FOR UPDATE`;

    let rewritten = 0;
    for (const row of rows) {
      const envelope = decryptCredentials<Envelope>(row.credentials_encrypted);
      if (envelope?.v !== 2 || typeof envelope.outputs !== "object") {
        throw new Error(`connection ${row.id}: credentials are not a v2 envelope`);
      }
      let outputs = envelope.outputs;

      if (row.pkg === ACTIVECAMPAIGN && "account_name" in outputs) {
        const { account_name: account, ...rest } = outputs;
        const derivable = typeof account === "string" && HOST_LABEL.test(account);
        if (rest.api_url || derivable) {
          outputs = rest.api_url ? rest : { ...rest, api_url: `https://${account}.api-us1.com` };
          const ciphertext = encryptCredentialEnvelope({ outputs, inputs: envelope.inputs });
          await tx`
            UPDATE integration_connections
               SET credentials_encrypted = ${ciphertext}, updated_at = now()
             WHERE id = ${row.id}`;
          rewritten += 1;
          const what = rest.api_url ? "account_name dropped" : "api_url from account_name";
          out(`  rewrite ${row.pkg} ${row.id}: ${what}`);
        } else {
          out(`  skip    ${row.pkg} ${row.id}: account_name is not a hostname label`);
        }
      }

      const [bad] = unrenderableAuthorizedUriFields(URL_AUTHS[row.pkg]!, outputs);
      if (!bad) continue;
      refused += 1;
      const value = outputs[bad.field];
      const why = typeof value === "string" && value !== "" ? `must be ${bad.expected}` : "missing";
      out(`  REFUSED ${row.pkg} ${row.id}: ${bad.field} ${why}`);
    }

    out(`${rows.length} connection(s) scanned, ${rewritten} rewritten, ${refused} refused`);
    if (!apply) throw new DryRunRollback();
  });
  out("0034: APPLIED — committed.");
} catch (error) {
  if (error instanceof DryRunRollback) {
    out("0034: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
  } else {
    out(`0034: FAILED, nothing committed — ${error instanceof Error ? error.message : error}`);
    failed = true;
  }
} finally {
  await sql.close();
}
process.exit(failed || refused > 0 ? 1 : 0);
