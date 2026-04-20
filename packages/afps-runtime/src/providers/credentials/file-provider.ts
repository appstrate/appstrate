// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { readFile } from "node:fs/promises";
import type {
  CredentialProvider,
  CredentialsResponse,
} from "../../interfaces/credential-provider.ts";
import { AUTH_KINDS, type AuthKind } from "../../types/auth-kind.ts";

export interface FileCredentialProviderOptions {
  /** Absolute path to the JSON credentials file. */
  path: string;
  /** Declared capabilities. Default: every kind in {@link AUTH_KINDS}. */
  supportedAuthKinds?: readonly AuthKind[];
}

interface FileEntry {
  credentials?: Record<string, string>;
  authorizedUris?: string[];
  allowAllUris?: boolean;
  expiresAt?: number;
}

/**
 * Reads credentials from a JSON file with the shape:
 *
 * ```jsonc
 * {
 *   "github": {
 *     "credentials": { "token": "ghp_xxx" },
 *     "authorizedUris": ["https://api.github.com"],
 *     "expiresAt": 1735689600000
 *   },
 *   "gmail": {
 *     "credentials": { "access_token": "ya29…" },
 *     "allowAllUris": true
 *   }
 * }
 * ```
 *
 * The file is read and cached on the first call; there is no watcher.
 * For rotation, re-instantiate the provider.
 *
 * Refresh is a no-op — rotation is out of scope for a static file
 * source; use {@link AppstrateCredentialProvider} or
 * {@link VaultCredentialProvider} for live-rotating tokens.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §11.
 */
export class FileCredentialProvider implements CredentialProvider {
  private readonly path: string;
  private readonly authKinds: readonly AuthKind[];
  private cache: Record<string, FileEntry> | null = null;
  private loadOnce: Promise<void> | null = null;

  constructor(opts: FileCredentialProviderOptions) {
    this.path = opts.path;
    this.authKinds = opts.supportedAuthKinds ?? AUTH_KINDS;
  }

  async getCredentials(providerId: string): Promise<CredentialsResponse> {
    await this.ensureLoaded();
    const entry = this.cache![providerId];
    if (!entry) {
      throw new Error(`FileCredentialProvider: no credentials for provider "${providerId}"`);
    }
    if (!entry.credentials || Object.keys(entry.credentials).length === 0) {
      throw new Error(`FileCredentialProvider: entry for "${providerId}" has no credentials field`);
    }
    const response: CredentialsResponse = {
      credentials: { ...entry.credentials },
      authorizedUris: entry.authorizedUris ?? [],
    };
    if (entry.allowAllUris) response.allowAllUris = true;
    if (entry.expiresAt !== undefined) response.expiresAt = entry.expiresAt;
    return response;
  }

  supportedAuthKinds(): AuthKind[] {
    return [...this.authKinds];
  }

  private ensureLoaded(): Promise<void> {
    if (this.cache) return Promise.resolve();
    if (!this.loadOnce) this.loadOnce = this.load();
    return this.loadOnce;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, { encoding: "utf8" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`FileCredentialProvider: cannot read "${this.path}": ${reason}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`FileCredentialProvider: invalid JSON in "${this.path}": ${reason}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `FileCredentialProvider: "${this.path}" must contain a JSON object keyed by providerId`,
      );
    }

    this.cache = parsed as Record<string, FileEntry>;
  }
}
