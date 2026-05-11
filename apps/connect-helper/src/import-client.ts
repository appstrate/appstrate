// SPDX-License-Identifier: Apache-2.0

/**
 * Tiny client for `POST /api/model-providers-oauth/import` that uses a
 * pairing-token bearer for auth (instead of a session cookie or API key).
 *
 * Used by both the helper binary and any future automation that wants to
 * complete a pairing flow programmatically. Platform-side, the bearer
 * shape is recognised by the route's `assertPairingToken` middleware
 * (kept separate from the cookie/API-key auth tracks).
 */

import type { NormalisedOAuthCredentials } from "./loopback-oauth.ts";

export interface ImportResult {
  providerKeyId: string;
  providerId: string;
  email?: string;
  subscriptionType?: string;
  availableModelIds: string[];
}

export interface ImportError {
  status: number;
  code: string;
  detail: string;
}

export class ImportRequestError extends Error {
  constructor(public readonly response: ImportError) {
    super(`${response.code} (${response.status}): ${response.detail}`);
    this.name = "ImportRequestError";
  }
}

/**
 * POST credentials to the platform's import endpoint, authenticated by
 * the pairing token (Bearer). The platform consumes the token atomically
 * — a second call with the same bearer returns 409.
 *
 * `label` is what the dashboard surfaces in the credential card; the
 * helper passes a sane default (provider display name) when invoked by
 * the front-end. CLIs may override.
 */
export async function postImport(args: {
  platformUrl: string;
  bearer: string;
  providerId: string;
  label: string;
  credentials: NormalisedOAuthCredentials;
  /** Optional connection profile id when the front-end has a specific one in scope. */
  connectionProfileId?: string;
}): Promise<ImportResult> {
  const url = `${args.platformUrl.replace(/\/+$/, "")}/api/model-providers-oauth/import`;
  const body: Record<string, unknown> = {
    providerId: args.providerId,
    label: args.label,
    accessToken: args.credentials.accessToken,
    refreshToken: args.credentials.refreshToken,
    expiresAt: args.credentials.expiresAt > 0 ? args.credentials.expiresAt : null,
  };
  if (args.credentials.email) body.email = args.credentials.email;
  if (args.credentials.subscriptionType) body.subscriptionType = args.credentials.subscriptionType;
  if (args.credentials.accountId) body.accountId = args.credentials.accountId;
  if (args.connectionProfileId) body.connectionProfileId = args.connectionProfileId;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.bearer}`,
      "user-agent": "@appstrate/connect-helper",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = response.statusText;
    let code = `HTTP_${response.status}`;
    try {
      const err = (await response.json()) as { detail?: string; code?: string; title?: string };
      if (err.detail) detail = err.detail;
      if (err.code) code = err.code;
      else if (err.title) code = err.title;
    } catch {
      // Non-JSON error body — fall through with statusText.
    }
    throw new ImportRequestError({ status: response.status, code, detail });
  }

  return (await response.json()) as ImportResult;
}
