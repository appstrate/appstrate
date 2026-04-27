// SPDX-License-Identifier: Apache-2.0

import type { ProviderConfig } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import type { ProviderSetupGuide } from "@appstrate/core/validation";
import {
  getDefaultAdminCredentialSchema,
  buildProviderDefinitionFromManifest,
} from "@appstrate/core/validation";
import { decryptCredentials } from "@appstrate/connect";
import { asRecord } from "@appstrate/core/safe-json";

/** Check if encrypted credentials contain actual data (not just an empty object). */
export function hasActualCredentials(encrypted: string | undefined): boolean {
  if (!encrypted) return false;
  try {
    const decrypted = decryptCredentials<Record<string, unknown>>(encrypted);
    return Object.keys(decrypted).length > 0;
  } catch {
    return false;
  }
}

export function packageToProviderConfig(
  pkg: {
    id: string;
    manifest: unknown;
    source: string | null;
  },
  credRow?: { credentialsEncrypted: string; enabled: boolean } | null,
): ProviderConfig {
  const manifest = asRecord(pkg.manifest);
  const def = asRecord(manifest.definition);
  const resolved = buildProviderDefinitionFromManifest(pkg.id, manifest);
  const isSystem = pkg.source === "system";
  const explicitSchema = def.adminCredentialSchema as JSONSchemaObject | undefined;
  const adminCredentialSchema =
    explicitSchema ??
    (resolved.authMode
      ? (getDefaultAdminCredentialSchema(resolved.authMode) as JSONSchemaObject | undefined)
      : undefined) ??
    undefined;
  const credentials = (def.credentials as Record<string, unknown>) ?? {};
  return {
    ...resolved,
    version: (manifest.version as string) ?? undefined,
    description: (manifest.description as string) ?? undefined,
    author: (manifest.author as string) ?? undefined,
    source: isSystem ? "built-in" : "custom",
    hasCredentials: hasActualCredentials(credRow?.credentialsEncrypted),
    enabled: !!credRow?.enabled,
    adminCredentialSchema,
    setupGuide: (manifest.setupGuide as ProviderSetupGuide) ?? undefined,
    tokenAuthMethod: resolved.tokenAuthMethod as ProviderConfig["tokenAuthMethod"],
    credentialSchema: (credentials.schema as Record<string, unknown>) ?? undefined,
  };
}
