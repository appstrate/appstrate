// SPDX-License-Identifier: Apache-2.0

/*
 * One-shot migration: convert legacy provider system-package sources
 * into `server.type: "api_call"` integrations (provider to integration unification).
 *
 * For each scripts/system-packages/provider-X/manifest.json:
 *   - oauth1 providers are SKIPPED (not ported, see Trello / chantier
 *     decision); the source dir is left untouched for manual handling.
 *   - everything else is rewritten to a serverless integration manifest
 *     (`server.type: "api_call"` + a single auths.primary) under
 *     scripts/system-packages/integration-NAME-VERSION/, and the original
 *     provider source dir is removed.
 *
 * Re-run safe: a provider dir already converted (no longer present) is
 * skipped. After running, build-system-packages repacks the .afps
 * archives and prunes orphaned provider archives.
 *
 *   bun run scripts/convert-providers-to-integrations.ts          apply
 *   bun run scripts/convert-providers-to-integrations.ts --dry    preview
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { integrationManifestSchema } from "@appstrate/core/integration";

const dry = process.argv.includes("--dry");
const SOURCES_DIR = join(import.meta.dir, "system-packages");

const INTEGRATION_SCHEMA = "https://afps.appstrate.dev/packages/schema/v1/integration.schema.json";

interface ProviderManifest {
  name: string;
  version: string;
  displayName: string;
  description?: string;
  iconUrl?: string;
  categories?: string[];
  schemaVersion?: string;
  definition: {
    authMode: "oauth2" | "oauth1" | "api_key" | "basic" | "custom";
    oauth2?: {
      authorizationUrl?: string;
      tokenUrl?: string;
      refreshUrl?: string;
      userinfoUrl?: string;
      defaultScopes?: string[];
      scopeSeparator?: string;
      pkceEnabled?: boolean;
      tokenAuthMethod?: string;
    };
    credentials?: { schema?: { properties?: Record<string, unknown> }; fieldName?: string };
    credentialTransform?: { template: string; encoding?: "base64" };
    credentialHeaderName?: string;
    credentialHeaderPrefix?: string;
    authorizedUris?: string[];
    allowAllUris?: boolean;
    availableScopes?: Array<{ value: string; label: string; description?: string }>;
  };
}

/** Field name an api_key/basic auth injects from. */
function credentialFieldName(def: ProviderManifest["definition"]): string | undefined {
  if (def.credentials?.fieldName) return def.credentials.fieldName;
  const props = def.credentials?.schema?.properties;
  const keys = props ? Object.keys(props) : [];
  return keys[0];
}

function convert(p: ProviderManifest): Record<string, unknown> {
  const def = p.definition;
  const auth: Record<string, unknown> = {
    type: def.authMode,
    required: true,
    authorizedUris: def.authorizedUris ?? [],
  };
  if (def.allowAllUris) auth.allowAllUris = true;

  if (def.authMode === "oauth2") {
    const o = def.oauth2 ?? {};
    if (o.authorizationUrl) auth.authorizationUrl = o.authorizationUrl;
    if (o.tokenUrl) auth.tokenUrl = o.tokenUrl;
    if (o.refreshUrl) auth.refreshUrl = o.refreshUrl;
    if (o.userinfoUrl) auth.userinfoUrl = o.userinfoUrl;
    if (o.defaultScopes?.length) auth.scopes = o.defaultScopes;
    if (o.scopeSeparator) auth.scopeSeparator = o.scopeSeparator;
    if (typeof o.pkceEnabled === "boolean") auth.pkceEnabled = o.pkceEnabled;
    if (o.tokenAuthMethod) auth.tokenAuthMethod = o.tokenAuthMethod;
  }
  if (def.availableScopes?.length) auth.availableScopes = def.availableScopes;
  if (def.credentials?.schema) auth.credentials = { schema: def.credentials.schema };

  // delivery — http injection mirrors the legacy provider header config.
  const http: Record<string, unknown> = {};
  if (def.credentialHeaderName) {
    http.headerName = def.credentialHeaderName;
    if (def.credentialHeaderPrefix) http.headerPrefix = def.credentialHeaderPrefix;
    if (def.credentialTransform) {
      http.valueFrom = {
        template: def.credentialTransform.template,
        ...(def.credentialTransform.encoding ? { encoding: def.credentialTransform.encoding } : {}),
      };
    } else if (def.authMode === "oauth2") {
      http.valueFrom = "accessToken";
    } else {
      const field = credentialFieldName(def);
      if (field) http.valueFrom = field;
    }
  }
  // `delivery` requires ≥1 of http/env/files. `custom` providers with no
  // server-side injection still declare an empty `http` block — the agent
  // supplies auth via `{{var}}` substitution; resolveHttpDelivery yields
  // no injection plan for that auth.
  auth.delivery = { http };

  return {
    $schema: INTEGRATION_SCHEMA,
    manifestVersion: p.schemaVersion ?? "1.1",
    type: "integration",
    name: p.name,
    version: p.version,
    // " (API)" suffix differentiates raw-REST (server.type api_call)
    // integrations from MCP integrations of the same service in the catalogue.
    displayName: p.displayName.endsWith("(API)") ? p.displayName : `${p.displayName} (API)`,
    ...(p.description ? { description: p.description } : {}),
    license: "Apache-2.0",
    author: "Appstrate",
    ...(p.iconUrl ? { icon: p.iconUrl } : {}),
    ...(p.categories?.length ? { keywords: p.categories } : {}),
    server: { type: "api_call" },
    auths: { primary: auth },
  };
}

async function main() {
  const entries = await readdir(SOURCES_DIR);
  const providerDirs = entries.filter((e) => e.startsWith("provider-"));
  let converted = 0;
  let skipped = 0;
  for (const dir of providerDirs.sort()) {
    const full = join(SOURCES_DIR, dir);
    if (!(await stat(full)).isDirectory()) continue;
    const manifestPath = join(full, "manifest.json");
    const provider = JSON.parse(await readFile(manifestPath, "utf8")) as ProviderManifest;
    if (provider.definition.authMode === "oauth1") {
      console.log(`  SKIP (oauth1): ${dir}`);
      skipped += 1;
      continue;
    }
    const integration = convert(provider);
    const parsed = integrationManifestSchema.safeParse(integration);
    if (!parsed.success) {
      console.error(`  FAIL ${dir}: ${JSON.stringify(parsed.error.issues, null, 2)}`);
      process.exitCode = 1;
      continue;
    }
    const slug = dir.replace(/^provider-/, "");
    const outDir = join(SOURCES_DIR, `integration-${slug}`);
    if (dry) {
      console.log(`  would convert ${dir} → integration-${slug}`);
      converted += 1;
      continue;
    }
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "manifest.json"), JSON.stringify(integration, null, 2) + "\n");
    await rm(full, { recursive: true, force: true });
    console.log(`  converted ${dir} → integration-${slug}`);
    converted += 1;
  }
  console.log(`\nDone: ${converted} converted, ${skipped} skipped (oauth1).`);
}

main();
