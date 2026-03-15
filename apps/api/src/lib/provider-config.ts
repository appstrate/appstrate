import type { ProviderConfig, JSONSchemaObject } from "@appstrate/shared-types";
import type { ProviderSetupGuide } from "@appstrate/core/validation";
import {
  getDefaultAdminCredentialSchema,
  buildProviderDefinitionFromManifest,
} from "@appstrate/core/validation";

export function packageToProviderConfig(
  pkg: {
    id: string;
    manifest: unknown;
    source: string | null;
  },
  credRow?: { credentialsEncrypted: string | null; enabled: boolean } | null,
): ProviderConfig {
  const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  const def = (manifest.definition ?? {}) as Record<string, unknown>;
  const resolved = buildProviderDefinitionFromManifest(pkg.id, manifest);
  const isSystem = pkg.source === "system";
  const explicitSchema = def.adminCredentialSchema as JSONSchemaObject | undefined;
  const adminCredentialSchema =
    explicitSchema ??
    (getDefaultAdminCredentialSchema(resolved.authMode) as JSONSchemaObject | undefined) ??
    undefined;
  return {
    ...resolved,
    version: (manifest.version as string) ?? undefined,
    description: (manifest.description as string) ?? undefined,
    author: (manifest.author as string) ?? undefined,
    source: isSystem ? "built-in" : "custom",
    hasCredentials: !!credRow?.credentialsEncrypted,
    enabled: !!credRow?.enabled,
    adminCredentialSchema,
    setupGuide: (manifest.setupGuide as ProviderSetupGuide) ?? undefined,
    tokenAuthMethod: resolved.tokenAuthMethod as ProviderConfig["tokenAuthMethod"],
    credentialSchema: (def.credentialSchema as Record<string, unknown>) ?? undefined,
  };
}
