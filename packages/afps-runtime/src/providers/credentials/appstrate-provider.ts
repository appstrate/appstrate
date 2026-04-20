// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type {
  CredentialProvider,
  CredentialsResponse,
} from "../../interfaces/credential-provider.ts";
import { AUTH_KINDS, type AuthKind } from "../../types/auth-kind.ts";

export interface AppstrateCredentialProviderOptions {
  /**
   * Base URL of the Appstrate platform API (not the sidecar). The
   * provider appends `/internal/credentials/{providerId}` for fetch and
   * `/internal/credentials/{providerId}/refresh` for rotation.
   */
  endpoint: string;
  /**
   * Run-scoped bearer token signed by the platform. Scopes the call to
   * this specific run's org/application.
   */
  runToken: string;
  /** Override the low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Declared capabilities. Default: every kind in {@link AUTH_KINDS}. */
  supportedAuthKinds?: readonly AuthKind[];
}

/**
 * Wire to the existing Appstrate platform credential endpoints — the
 * same surface the in-container sidecar already calls. Keeps Appstrate
 * and external runners on the exact same control plane for rotations
 * and authorisation.
 *
 * Response mapping from the platform:
 *
 * ```
 * { credentials, authorizedUris: string[] | null, allowAllUris: boolean }
 *   ⇒ { credentials, authorizedUris: authorizedUris ?? [], allowAllUris }
 * ```
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §6, §11. The
 * companion server-side endpoint contract lives in
 * `apps/api/src/routes/internal.ts`.
 */
export class AppstrateCredentialProvider implements CredentialProvider {
  private readonly endpoint: string;
  private readonly runToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authKinds: readonly AuthKind[];

  constructor(opts: AppstrateCredentialProviderOptions) {
    if (!opts.endpoint) throw new Error("AppstrateCredentialProvider: endpoint is required");
    if (!opts.runToken) throw new Error("AppstrateCredentialProvider: runToken is required");
    this.endpoint = opts.endpoint.replace(/\/$/, "");
    this.runToken = opts.runToken;
    this.fetchImpl = opts.fetch ?? fetch;
    this.authKinds = opts.supportedAuthKinds ?? AUTH_KINDS;
  }

  async getCredentials(providerId: string): Promise<CredentialsResponse> {
    const url = `${this.endpoint}/internal/credentials/${encodeURIComponent(providerId)}`;
    return this.call("GET", url, providerId);
  }

  async refresh(providerId: string): Promise<void> {
    const url = `${this.endpoint}/internal/credentials/${encodeURIComponent(providerId)}/refresh`;
    await this.call("POST", url, providerId);
  }

  supportedAuthKinds(): AuthKind[] {
    return [...this.authKinds];
  }

  private async call(
    method: "GET" | "POST",
    url: string,
    providerId: string,
  ): Promise<CredentialsResponse> {
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${this.runToken}` },
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { detail?: string };
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        // platform returned a non-JSON error body — ignore and fall back to status
      }
      throw new Error(
        `AppstrateCredentialProvider: ${method} ${providerId} failed — ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }

    const body = (await res.json()) as {
      credentials?: Record<string, string>;
      authorizedUris?: string[] | null;
      allowAllUris?: boolean;
      expiresAt?: number;
    };

    if (!body.credentials || typeof body.credentials !== "object") {
      throw new Error(
        `AppstrateCredentialProvider: platform returned no credentials for "${providerId}"`,
      );
    }

    const response: CredentialsResponse = {
      credentials: body.credentials,
      authorizedUris: body.authorizedUris ?? [],
    };
    if (body.allowAllUris) response.allowAllUris = true;
    if (typeof body.expiresAt === "number") response.expiresAt = body.expiresAt;
    return response;
  }
}
