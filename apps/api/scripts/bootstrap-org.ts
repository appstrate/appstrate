#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate admin bootstrap-org` (issue #228) — create the root
 * organization for a self-hosted instance running in closed mode.
 *
 *   bun apps/api/scripts/bootstrap-org.ts \
 *     --owner=admin@acme.com [--name="Acme"] [--slug=acme]
 *
 * Idempotent. The owner user MUST already exist (sign up via the dashboard
 * first — `AUTH_BOOTSTRAP_OWNER_EMAIL` or `AUTH_PLATFORM_ADMIN_EMAILS` lets
 * them through the closed-mode signup gate). The script:
 *
 *   1. Looks up the user by email — exits 2 if absent.
 *   2. If they already own an org → exits 0 (idempotent no-op, prints orgId).
 *   3. Otherwise creates `{ name, slug }` and assigns them as owner.
 *
 * Output: a single JSON line on stdout. Designed for IaC / CI consumption
 * (Helm post-install hook, GitHub Action, …).
 *
 * Why this lives next to the API instead of in `@appstrate/cli`: the
 * remote CLI (`bunx appstrate …`) talks to a server over HTTP and assumes
 * the user is already authenticated. Bootstrap by definition runs BEFORE
 * authentication can succeed (no org, no API key) — so it ships as a
 * server-side script that connects directly to the database.
 */

import { parseArgs } from "node:util";
import { db } from "@appstrate/db/client";
import { user } from "@appstrate/db/schema";
import { createBootstrapOrg } from "@appstrate/db/bootstrap-org";
import { eq } from "drizzle-orm";

interface ScriptArgs {
  owner: string;
  name: string;
  slug?: string;
}

function exit(code: number, payload: Record<string, unknown>): never {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

function parseScriptArgs(): ScriptArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      owner: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: bun apps/api/scripts/bootstrap-org.ts --owner=<email> [--name=<org-name>] [--slug=<slug>]\n",
    );
    process.exit(0);
  }

  if (!values.owner) {
    exit(1, { error: "missing_owner", detail: "--owner=<email> is required" });
  }
  return {
    owner: values.owner.trim().toLowerCase(),
    name: values.name?.trim() || "Default",
    slug: values.slug?.trim() || undefined,
  };
}

async function main(): Promise<void> {
  const args = parseScriptArgs();

  const [ownerRow] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.email, args.owner))
    .limit(1);

  if (!ownerRow) {
    exit(2, {
      error: "owner_not_found",
      detail: `No user with email ${args.owner}. Sign up via the dashboard first (AUTH_BOOTSTRAP_OWNER_EMAIL or AUTH_PLATFORM_ADMIN_EMAILS lets you through closed mode).`,
    });
  }

  let result;
  try {
    result = await createBootstrapOrg(ownerRow.id, args.name, args.slug);
  } catch (err) {
    exit(1, {
      error: "org_insert_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (!result.created) {
    exit(0, {
      created: false,
      reason: result.reason,
      orgId: result.orgId,
      slug: result.slug,
    });
  }

  exit(0, {
    created: true,
    orgId: result.orgId,
    slug: result.slug,
    ownerId: ownerRow.id,
    ownerEmail: ownerRow.email,
  });
}

await main();
