// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type {
  CredentialProvider,
  CredentialsResponse,
} from "../../interfaces/credential-provider.ts";
import { AUTH_KINDS, type AuthKind } from "../../types/auth-kind.ts";

export interface EnvCredentialProviderOptions {
  /**
   * Override the environment source. Defaults to `process.env`. Useful
   * for deterministic tests.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Declared capabilities. Defaults to every kind in {@link AUTH_KINDS} —
   * env-var storage doesn't impose a narrower constraint, so the runtime
   * only refuses at boot if the bundle needs something no provider can
   * satisfy. Narrow this when you want to force use of a more specific
   * provider.
   */
  supportedAuthKinds?: readonly AuthKind[];
}

/**
 * Reads credentials from environment variables by convention:
 *
 * ```
 * AFPS_CRED_<providerId>_<field>              = <value>
 * AFPS_CRED_<providerId>_AUTHORIZED_URIS      = https://api.x.com,https://api.y.com
 * AFPS_CRED_<providerId>_ALLOW_ALL_URIS       = true
 * AFPS_CRED_<providerId>_EXPIRES_AT           = 1735689600000   # Unix ms
 * ```
 *
 * `providerId` is normalised for env-name compatibility: uppercased, and
 * non-alphanumeric characters collapsed to a single underscore.
 * `@scope/provider` → `_SCOPE_PROVIDER`. This is a pure function, so
 * different providerIds that normalise to the same prefix will collide
 * and MUST be avoided.
 *
 * Reserved field names (recognised as envelope metadata, not
 * credentials): `AUTHORIZED_URIS`, `ALLOW_ALL_URIS`, `EXPIRES_AT`.
 * Their canonical underscore-lowercase form is NOT eligible as a
 * credential field.
 *
 * Refresh is a no-op — env vars don't rotate at runtime.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §11.
 */
export class EnvCredentialProvider implements CredentialProvider {
  private static readonly PREFIX = "AFPS_CRED_";
  private static readonly RESERVED = new Set(["AUTHORIZED_URIS", "ALLOW_ALL_URIS", "EXPIRES_AT"]);

  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly authKinds: readonly AuthKind[];

  constructor(opts: EnvCredentialProviderOptions = {}) {
    this.env = opts.env ?? globalThis.process?.env ?? {};
    this.authKinds = opts.supportedAuthKinds ?? AUTH_KINDS;
  }

  async getCredentials(providerId: string): Promise<CredentialsResponse> {
    const prefix = `${EnvCredentialProvider.PREFIX}${normaliseProviderId(providerId)}_`;
    const credentials: Record<string, string> = {};
    let authorizedUris: string[] = [];
    let allowAllUris = false;
    let expiresAt: number | undefined;

    for (const [key, rawValue] of Object.entries(this.env)) {
      if (rawValue === undefined) continue;
      if (!key.startsWith(prefix)) continue;
      const field = key.slice(prefix.length);
      if (!field) continue;

      if (EnvCredentialProvider.RESERVED.has(field)) {
        if (field === "AUTHORIZED_URIS") authorizedUris = parseUriList(rawValue);
        else if (field === "ALLOW_ALL_URIS") allowAllUris = parseBool(rawValue);
        else if (field === "EXPIRES_AT") expiresAt = parseTimestamp(rawValue);
        continue;
      }

      credentials[field.toLowerCase()] = rawValue;
    }

    if (Object.keys(credentials).length === 0) {
      throw new Error(`EnvCredentialProvider: no credentials found for provider "${providerId}"`);
    }

    const response: CredentialsResponse = {
      credentials,
      authorizedUris,
      allowAllUris,
    };
    if (expiresAt !== undefined) response.expiresAt = expiresAt;
    return response;
  }

  supportedAuthKinds(): AuthKind[] {
    return [...this.authKinds];
  }
}

/**
 * Normalise a providerId for env-var naming:
 *
 * - uppercased
 * - any run of non-alphanumeric characters replaced by a single `_`
 *
 * Exposed for symmetric use in tests; production callers should not
 * need to invoke this directly.
 */
export function normaliseProviderId(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function parseUriList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through to CSV parsing
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function parseTimestamp(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
