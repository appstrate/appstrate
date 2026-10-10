// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0037-verify-authorized-uri-host-bounds.ts`: its reports in memory, its
 * Shopify query on a PGlite replayed to the current schema. No report names a value.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";
import {
  SHOPIFY_CONNECTIONS_QUERY,
  shopDomainIssue,
  unboundedEntries,
} from "../../../../scripts/migration/0037-verify-authorized-uri-host-bounds.ts";

const apiKeyAuth = (extra: Record<string, unknown>) => ({
  type: "api_key",
  delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
  ...extra,
});
const row = (id: string, auths: Record<string, unknown>) => ({
  id,
  version: "1.0.0",
  manifest: JSON.stringify({ auths }),
});

describe("0037 — authorized_uris entries the release refuses", () => {
  it("lists each refused entry of any auth, marking one whose auth injects nothing", () => {
    const rows = [
      row("@acme/tenant", {
        k: apiKeyAuth({ authorized_uris: ["https://*.zendesk.com/**", "https://*.github.io/**"] }),
      }),
      // Injects nothing: only a call substituting a credential under the entry is refused.
      row("@acme/custom", {
        c: {
          type: "custom",
          authorized_uris: ["https://*.supabase.co/**", "https://*.amazonaws.com/**"],
        },
      }),
    ];
    expect(unboundedEntries(rows)).toEqual([
      "@acme/tenant@1.0.0 auths.k.authorized_uris.1: https://*.github.io/**",
      "@acme/custom@1.0.0 auths.c.authorized_uris.0: https://*.supabase.co/** (refused when a credential is substituted)",
    ]);
  });

  it("leaves an empty list or allow_all_uris to 0035", () => {
    const rows = [row("@acme/all", { k: apiKeyAuth({ allow_all_uris: true }) })];
    expect(unboundedEntries(rows)).toEqual([]);
  });
});

describe("0037 — the Shopify connections it reads", () => {
  const SHOPIFY = "@appstrate/shopify";
  const OTHER = "@acme/other";
  const PRIMARY = "00000000-0000-4000-8000-000000000371";
  let pg: PGlite;

  beforeAll(async () => {
    pg = await journalPGlite();
    await pg.exec(`
      INSERT INTO packages (id, type, source, draft_manifest)
        VALUES ('${SHOPIFY}', 'integration', 'system', '{}'), ('${OTHER}', 'integration', 'local', '{}');
      INSERT INTO organizations (id, name, slug) VALUES ('00000000-0000-4000-8000-000000000370', 'Zero37', 'zero-37');
      INSERT INTO spaces (id, org_id, name, is_default) VALUES ('spc_0037', '00000000-0000-4000-8000-000000000370', 'Default', true);
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('usr_0037', 'Owner', 'o-0037@example.com', true, now(), now());
      INSERT INTO integration_connections
        (id, integration_package_id, auth_key, account_id, org_id, space_id, user_id, credentials_encrypted, label)
      VALUES
        ('${PRIMARY}', '${SHOPIFY}', 'primary', 'a', '00000000-0000-4000-8000-000000000370', 'spc_0037', 'usr_0037', 'enc-1', 'Shop'),
        ('00000000-0000-4000-8000-000000000372', '${SHOPIFY}', 'other', 'a', '00000000-0000-4000-8000-000000000370', 'spc_0037', 'usr_0037', 'enc-2', 'Other auth'),
        ('00000000-0000-4000-8000-000000000373', '${OTHER}', 'primary', 'a', '00000000-0000-4000-8000-000000000370', 'spc_0037', 'usr_0037', 'enc-3', 'Other');
    `);
  }, 300_000);

  afterAll(async () => {
    await pg.close();
  });

  it("are those of the primary auth only", async () => {
    const { rows } = await pg.query(SHOPIFY_CONNECTIONS_QUERY);
    expect(rows).toEqual([{ id: PRIMARY, credentials_encrypted: "enc-1" }]);
  });
});

describe("0037 — a Shopify shop_domain that would not reach its store", () => {
  it("accepts a <store>.myshopify.com host, in any case", () => {
    for (const shop_domain of ["my-store.myshopify.com", "My-Store.MyShopify.COM"]) {
      expect(shopDomainIssue({ shop_domain, access_token: "t" })).toBeNull();
    }
  });

  const NOT_SHOPIFY = "shop_domain is not a <store>.myshopify.com host";
  it.each([
    ["an absent field", {}, "shop_domain missing"],
    ["an empty field", { shop_domain: "" }, "shop_domain missing"],
    ["a URL", { shop_domain: "https://my-store.myshopify.com" }, NOT_SHOPIFY],
    ["a bare store name", { shop_domain: "my-store" }, NOT_SHOPIFY],
    ["another host", { shop_domain: "my-store.example.com" }, NOT_SHOPIFY],
  ])("refuses %s, naming no value", (_, fields, reason) => {
    expect(shopDomainIssue(fields)).toBe(reason);
  });
});
