#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0037 — READ-ONLY pre-flight, run BEFORE deploying the release that judges `authorized_uris`
 * wildcards with the Public Suffix List (#1656), and again after a `tldts` bump, env loaded (it
 * decrypts Shopify connections):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0037-verify-authorized-uri-host-bounds.ts
 *
 * 1. `[unbounded]` Every `authorized_uris` entry of an org integration draft or published
 *    version, on any auth, that `isHostUnboundedUriPattern` refuses (`*.googleapis.com`,
 *    `*.github.io`). On an auth whose credential the proxy injects, its next write is refused
 *    and every call refused; on another auth, a call that substitutes a credential is refused.
 *    `0035` lists the injected ones among its `[exfiltration]` hits; this script stands alone.
 * 2. `[shopify]` Every `@appstrate/shopify` connection whose `shop_domain` does not render
 *    `https://{$credential.shop_domain}/**` into a `<store>.myshopify.com` host — the shipped
 *    version calls nothing else. Only that field is inspected; no value is printed.
 * 3. Informational, not counted: `[wildcard]` every remaining host wildcard, whose run-time half
 *    refuses a target under a deeper public suffix (`*.amazonaws.com` → all of `us-east-1` and
 *    S3); `[shopify-case]` a `shop_domain` that only its case keeps from the schema `pattern`.
 *
 * Exits 1 while 1 or 2 lists a hit, 2 without a database. System integrations are skipped in 1
 * and 3, as in `0035`: the platform runs the version it ships, whatever an agent pins. What it
 * means and how to fix one: `scripts/migration/README.md`.
 */

import { SQL } from "bun";
import {
  isHostUnboundedUriPattern,
  unrenderableAuthorizedUriFields,
  wildcardHostLiteral,
} from "@appstrate/afps-shared/authorized-uris";
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
  authorized_uris: string[];
  credentials: { schema: { properties: { shop_domain: { pattern: string } } } };
}

/** The shipped `@appstrate/shopify` source: one version dir, whatever its number. */
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

/** `@appstrate/shopify` as this pre-flight checks it: its allowlist and its `shop_domain` rule. */
const SHOPIFY = SHOPIFY_MANIFEST.auths.primary;
const SHOP_DOMAIN = new RegExp(SHOPIFY.credentials.schema.properties.shop_domain.pattern);

type Auth = { type?: unknown; authorized_uris?: unknown; delivery?: { http?: unknown } } | null;

const SUBSTITUTED_ONLY = " (refused when a credential is substituted)";
const JUDGED_IF_SUBSTITUTED = " (judged when a credential is substituted)";

/** Each string entry of each auth of a stored manifest, with whether the proxy injects for it. */
function manifestEntries(rows: readonly StoredManifest[]) {
  return rows.flatMap((row) => {
    const manifest: unknown = row.manifest && JSON.parse(row.manifest);
    const auths = (manifest as { auths?: Record<string, Auth> } | null)?.auths ?? {};
    return Object.entries(auths).flatMap(([key, auth]) => {
      const uris: unknown[] = Array.isArray(auth?.authorized_uris) ? auth.authorized_uris : [];
      const injects = injectsHttpCredential(
        typeof auth?.type === "string" ? auth.type : "",
        auth?.delivery?.http as AfpsHttpDelivery | undefined,
      );
      const at = (i: number) => `${row.id}@${row.version} auths.${key}.authorized_uris.${i}`;
      return uris.flatMap((entry, index) =>
        typeof entry === "string" ? [{ at: at(index), entry, injects }] : [],
      );
    });
  });
}

/**
 * One line per refused entry, every auth: `<id>@<version> auths.<key>.authorized_uris.<i>:
 * <entry>`, suffixed when the auth injects nothing (only a substituted credential is refused).
 */
export function unboundedEntries(rows: readonly StoredManifest[]): string[] {
  return manifestEntries(rows)
    .filter(({ entry }) => isHostUnboundedUriPattern(entry))
    .map(({ at, entry, injects }) => `${at}: ${entry}${injects ? "" : SUBSTITUTED_ONLY}`);
}

/** One line per accepted entry whose host holds a wildcard: its targets are judged at run time. */
export function wildcardEntries(rows: readonly StoredManifest[]): string[] {
  return manifestEntries(rows)
    .filter(({ entry }) => !isHostUnboundedUriPattern(entry) && wildcardHostLiteral(entry) !== null)
    .map(({ at, entry, injects }) => `${at}: ${entry}${injects ? "" : JUDGED_IF_SUBSTITUTED}`);
}

/** Why a Shopify connection's fields would not reach its store, or `null`. Names no value. */
export function shopDomainIssue(fields: Readonly<Record<string, unknown>>): string | null {
  const value = fields.shop_domain;
  if (typeof value !== "string" || value === "") return "shop_domain missing";
  const [bad] = unrenderableAuthorizedUriFields(SHOPIFY.authorized_uris, fields);
  if (bad) return `shop_domain must be ${bad.expected}`;
  // The rendered host is matched lowercased (WHATWG), so case is no defect here.
  if (!SHOP_DOMAIN.test(value.toLowerCase())) {
    return "shop_domain is not a <store>.myshopify.com host";
  }
  return null;
}

/**
 * A `shop_domain` that reaches its store (the rendered host is lowercased) but that the schema
 * `pattern` refuses as written, on the connection's next credential update; else `null`.
 */
export function shopDomainCaseNote(fields: Readonly<Record<string, unknown>>): string | null {
  const value = fields.shop_domain;
  if (typeof value !== "string" || shopDomainIssue(fields) !== null) return null;
  return SHOP_DOMAIN.test(value)
    ? null
    : "shop_domain reaches its store, but its case fails the schema pattern on the next update";
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
    let fields: Record<string, string> | null = null;
    try {
      fields = decryptCredentialsToStringMap(row.credentials_encrypted);
    } catch {
      // Counted below as an issue: the connection cannot be checked.
    }
    const issue = fields ? shopDomainIssue(fields) : "credentials do not decrypt";
    if (issue !== null) {
      refused += 1;
      write(`[shopify] ${row.id}: ${issue}`);
      continue;
    }
    const note = shopDomainCaseNote(fields!);
    if (note !== null) write(`[shopify-case] ${row.id}: ${note}`);
  }
  const wildcards = wildcardEntries(manifests);
  for (const line of wildcards) write(`[wildcard] ${line}`);
  if (wildcards.length > 0) {
    write(
      "  ↳ accepted, but a credential reaches a target only when its registrable domain lies " +
        "inside the entry's literal part: hosts under a deeper public suffix are refused at run " +
        "time (under *.amazonaws.com: all of us-east-1, all of S3); list those hosts literally.",
    );
  }
  write(
    `\n${manifests.length} manifest(s) scanned: ${entries.length} refused authorized_uris ` +
      `entr${entries.length === 1 ? "y" : "ies"}, ${wildcards.length} wildcard(s) to review; ` +
      `${connections.length} Shopify connection(s): ${refused} not reaching a myshopify.com store`,
  );
  process.exit(entries.length + refused > 0 ? 1 : 0);
}
