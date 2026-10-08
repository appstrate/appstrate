// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0037-verify-authorized-uri-host-bounds.ts` on a private PGlite replayed to the
 * current schema: the report lists each `authorized_uris` entry whose wildcard is not under a
 * literal registrable domain, on every auth of every org draft and published version, and nothing
 * for a system package; the accepted wildcards, as information; and the Shopify connections of the
 * primary auth. The Shopify check names why a connection's `shop_domain` would not reach its store,
 * never the value.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";
import {
  STORED_MANIFESTS_QUERY,
  type StoredManifest,
} from "../../../../scripts/migration/0035-verify-manifest-expressions.ts";
import {
  SHOPIFY_CONNECTIONS_QUERY,
  shopDomainCaseNote,
  shopDomainIssue,
  unboundedEntries,
  wildcardEntries,
} from "../../../../scripts/migration/0037-verify-authorized-uri-host-bounds.ts";

const TENANT = "@acme0037/tenant";
const SUFFIX = "@acme0037/suffix";
const SYSTEM = "@acme0037/system";
const CUSTOM = "@acme0037/custom";
const SHOPIFY = "@appstrate/shopify";
const SHOPIFY_PRIMARY = "00000000-0000-4000-8000-000000000371";
const SHOPIFY_OTHER_AUTH = "00000000-0000-4000-8000-000000000372";
const OTHER_INTEGRATION = "00000000-0000-4000-8000-000000000373";

const apiKeyAuth = (authorized_uris: string[]) => ({
  auths: {
    k: {
      type: "api_key",
      delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
      authorized_uris,
    },
  },
});

let pg: PGlite;

beforeAll(async () => {
  pg = await journalPGlite();
  const tenant = apiKeyAuth(["https://*.zendesk.com/**", "https://*.example.co.uk/**"]);
  const suffix = apiKeyAuth(["https://api.acme.test/**", "https://*.github.io/**"]);
  await pg.query(
    `INSERT INTO packages (id, type, draft_manifest) VALUES ($1, 'integration', $2), ($3, 'integration', $4)`,
    [TENANT, JSON.stringify(tenant), SUFFIX, JSON.stringify(tenant)],
  );
  await pg.query(
    `INSERT INTO packages (id, type, source, draft_manifest) VALUES ($1, 'integration', 'system', $2)`,
    [SYSTEM, JSON.stringify(suffix)],
  );
  await pg.query(
    `INSERT INTO package_versions (package_id, version, integrity, artifact_size, manifest) VALUES ($1, '1.0.0', 'sha256-x', 1, $2), ($3, '1.0.0', 'sha256-x', 1, $2)`,
    [SUFFIX, JSON.stringify(suffix), SYSTEM],
  );
  await pg.query(
    `INSERT INTO packages (id, type, source, draft_manifest) VALUES ($1, 'integration', 'system', '{}')`,
    [SHOPIFY],
  );
  // No delivery: nothing injected, but a call substituting `{{key}}` under the entry is refused.
  const custom = {
    auths: {
      c: {
        type: "custom",
        authorized_uris: ["https://*.supabase.co/**", "https://*.amazonaws.com/**"],
      },
    },
  };
  await pg.query(`INSERT INTO packages (id, type, draft_manifest) VALUES ($1, 'integration', $2)`, [
    CUSTOM,
    JSON.stringify(custom),
  ]);
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('00000000-0000-4000-8000-000000000370', 'Zero37', 'zero-37');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('spc_0037', '00000000-0000-4000-8000-000000000370', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('usr_0037', 'Owner', 'o-0037@example.com', true, now(), now());
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id, credentials_encrypted, label)
    VALUES
      ('${SHOPIFY_PRIMARY}', '${SHOPIFY}', 'primary', 'a', 'spc_0037', 'usr_0037', 'enc-1', 'Shop'),
      ('${SHOPIFY_OTHER_AUTH}', '${SHOPIFY}', 'other', 'a', 'spc_0037', 'usr_0037', 'enc-2', 'Other auth'),
      ('${OTHER_INTEGRATION}', '${TENANT}', 'primary', 'a', 'spc_0037', 'usr_0037', 'enc-3', 'Tenant');
  `);
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0037 — authorized_uris wildcards the release no longer bounds", () => {
  it("lists each unbounded entry of every org integration version, no system package", async () => {
    const { rows } = await pg.query<StoredManifest>(STORED_MANIFESTS_QUERY);
    expect(unboundedEntries(rows)).toEqual([
      `${CUSTOM}@draft auths.c.authorized_uris.0: https://*.supabase.co/** (refused when a credential is substituted)`,
      `${SUFFIX}@1.0.0 auths.k.authorized_uris.1: https://*.github.io/**`,
    ]);
  });

  it("lists every accepted host wildcard, as information on its run-time targets", async () => {
    const { rows } = await pg.query<StoredManifest>(STORED_MANIFESTS_QUERY);
    expect(wildcardEntries(rows)).toEqual([
      `${CUSTOM}@draft auths.c.authorized_uris.1: https://*.amazonaws.com/** (judged when a credential is substituted)`,
      `${SUFFIX}@draft auths.k.authorized_uris.0: https://*.zendesk.com/**`,
      `${SUFFIX}@draft auths.k.authorized_uris.1: https://*.example.co.uk/**`,
      `${TENANT}@draft auths.k.authorized_uris.0: https://*.zendesk.com/**`,
      `${TENANT}@draft auths.k.authorized_uris.1: https://*.example.co.uk/**`,
    ]);
  });

  it("leaves an empty list or allow_all_uris to 0035", () => {
    const manifest = JSON.stringify({
      auths: { k: { ...apiKeyAuth([]).auths.k, allow_all_uris: true } },
    });
    expect(unboundedEntries([{ id: TENANT, version: "draft", manifest }])).toEqual([]);
  });

  it("reads the Shopify connections of the primary auth only", async () => {
    const { rows } = await pg.query(SHOPIFY_CONNECTIONS_QUERY);
    expect(rows).toEqual([{ id: SHOPIFY_PRIMARY, credentials_encrypted: "enc-1" }]);
  });
});

describe("0037 — a Shopify shop_domain that would not reach its store", () => {
  it("accepts a <store>.myshopify.com host, in any case", () => {
    for (const shop_domain of ["my-store.myshopify.com", "My-Store.MyShopify.COM"]) {
      expect(shopDomainIssue({ shop_domain, access_token: "t" })).toBeNull();
    }
  });

  it("notes a value only its case keeps from the schema pattern, and nothing else", () => {
    const note = shopDomainCaseNote({ shop_domain: "My-Store.MyShopify.COM" });
    expect(note).toContain("case fails the schema pattern");
    expect(note).not.toContain("My-Store");
    for (const shop_domain of ["my-store.myshopify.com", "my-store"]) {
      expect(shopDomainCaseNote({ shop_domain })).toBeNull();
    }
  });

  const NOT_SHOPIFY = "shop_domain is not a <store>.myshopify.com host";
  it.each([
    ["an absent field", {}, "shop_domain missing"],
    ["an empty field", { shop_domain: "" }, "shop_domain missing"],
    ["a URL", { shop_domain: "https://my-store.myshopify.com" }, "shop_domain must be a host"],
    ["a bare store name", { shop_domain: "my-store" }, NOT_SHOPIFY],
    ["another host", { shop_domain: "my-store.example.com" }, NOT_SHOPIFY],
  ])("refuses %s, naming no value", (_, fields, reason) => {
    const issue = shopDomainIssue(fields);
    expect(issue?.startsWith(reason)).toBe(true);
    expect(issue).not.toContain("my-store");
  });
});
