#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0037 — READ-ONLY pre-flight (#1656), before the deploy, env loaded:
 *
 *   set -a && . ./.env && set +a && bun scripts/migration/0037-verify-authorized-uri-host-bounds.ts
 *
 * Lists `[unbounded]` org `authorized_uris` entries the Public Suffix List rule refuses, and
 * `[shopify]` connections whose `shop_domain` is not a `<store>.myshopify.com` host (no value
 * printed). Exits 1 while one remains, 2 without `DATABASE_URL`. Details: README.md here.
 */

import { SQL } from "bun";
import { isHostUnboundedUriPattern } from "@appstrate/afps-shared/authorized-uris";
import { injectsHttpCredential, type AfpsHttpDelivery } from "@appstrate/afps-shared/delivery-http";
import { STORED_MANIFESTS_QUERY, type StoredManifest } from "./0035-verify-manifest-expressions.ts";

interface StoredConnection {
  id: string;
  credentials_encrypted: string;
}

export const SHOPIFY_CONNECTIONS_QUERY = `
  SELECT id, credentials_encrypted FROM integration_connections
   WHERE integration_package_id = '@appstrate/shopify' AND auth_key = 'primary'
   ORDER BY id`;

interface ShopifyAuth {
  credentials: { schema: { properties: { shop_domain: { pattern: string } } } };
}

function shopifySource(): string {
  const dir = `${import.meta.dir}/../system-packages`;
  const found = [...new Bun.Glob("integration-shopify-*/manifest.json").scanSync({ cwd: dir })];
  if (found.length !== 1) {
    throw new Error(
      `0037: expected one integration-shopify-* source in ${dir}, found ${found.length}`,
    );
  }
  return `${dir}/${found[0]}`;
}

const SHOPIFY_MANIFEST = (await Bun.file(shopifySource()).json()) as {
  auths: { primary: ShopifyAuth };
};

const SHOPIFY = SHOPIFY_MANIFEST.auths.primary;
const SHOP_DOMAIN = new RegExp(SHOPIFY.credentials.schema.properties.shop_domain.pattern);

type Auth = { type?: unknown; authorized_uris?: unknown; delivery?: { http?: unknown } } | null;

// An auth that injects nothing still has a call refused when it substitutes a credential.
const SUBSTITUTED_ONLY = " (refused when a credential is substituted)";

/** `<id>@<version> auths.<key>.authorized_uris.<i>: <entry>` per refused entry, any auth. */
export function unboundedEntries(rows: readonly StoredManifest[]): string[] {
  return rows.flatMap((row) => {
    const manifest: unknown = row.manifest && JSON.parse(row.manifest);
    const auths = (manifest as { auths?: Record<string, Auth> } | null)?.auths ?? {};
    return Object.entries(auths).flatMap(([key, auth]) => {
      const uris: unknown[] = Array.isArray(auth?.authorized_uris) ? auth.authorized_uris : [];
      const injects = injectsHttpCredential(
        typeof auth?.type === "string" ? auth.type : "",
        auth?.delivery?.http as AfpsHttpDelivery | undefined,
      );
      const at = `${row.id}@${row.version} auths.${key}.authorized_uris`;
      return uris.flatMap((entry, i) =>
        typeof entry === "string" && isHostUnboundedUriPattern(entry)
          ? [`${at}.${i}: ${entry}${injects ? "" : SUBSTITUTED_ONLY}`]
          : [],
      );
    });
  });
}

/** Why a Shopify connection would not reach its store, or `null`. Names no value. */
export function shopDomainIssue(fields: Readonly<Record<string, unknown>>): string | null {
  const value = fields.shop_domain;
  if (typeof value !== "string" || value === "") return "shop_domain missing";
  // The rendered host is matched lowercased (WHATWG), so case is no defect here.
  if (!SHOP_DOMAIN.test(value.toLowerCase())) {
    return "shop_domain is not a <store>.myshopify.com host";
  }
  return null;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required — the platform database to read\n");
    process.exit(2);
  }
  // Imported here: `@appstrate/connect` validates the whole environment on import.
  const { decryptCredentialsToStringMap } = await import("@appstrate/connect");
  const sql = new SQL(url, { max: 1 });
  const [manifests, connections] = await sql.begin(async (tx: SQL) => {
    await tx`SET TRANSACTION READ ONLY`;
    return [
      (await tx.unsafe(STORED_MANIFESTS_QUERY)) as StoredManifest[],
      (await tx.unsafe(SHOPIFY_CONNECTIONS_QUERY)) as StoredConnection[],
    ] as const;
  });
  await sql.close();

  const write = (line: string) => process.stdout.write(`${line}\n`);
  const entries = unboundedEntries(manifests);
  for (const line of entries) write(`[unbounded] ${line}`);
  let refused = 0;
  for (const row of connections) {
    let issue: string | null;
    try {
      issue = shopDomainIssue(decryptCredentialsToStringMap(row.credentials_encrypted));
    } catch {
      issue = "credentials do not decrypt";
    }
    if (issue === null) continue;
    refused += 1;
    write(`[shopify] ${row.id}: ${issue}`);
  }
  write(
    `\n${manifests.length} manifest(s) scanned: ${entries.length} refused authorized_uris ` +
      `entr${entries.length === 1 ? "y" : "ies"}; ${connections.length} Shopify connection(s): ` +
      `${refused} not reaching a myshopify.com store`,
  );
  process.exit(entries.length + refused > 0 ? 1 : 0);
}
