// SPDX-License-Identifier: Apache-2.0

/**
 * Wrapper around `@mariozechner/pi-ai`'s loopback PKCE flow for the OAuth
 * model providers Appstrate supports today. Currently only OpenAI Codex
 * ships in OSS; additional OAuth providers can be added by extending the
 * slug map below (operator-installed modules can extend it at runtime).
 *
 * Internal-only — driven by the helper binary (`apps/connect-helper/src/cli.ts`)
 * after it decodes a pairing token from the dashboard. The `codex` slug is
 * a pi-ai surface concern (which loopback to invoke); the dashboard /
 * platform speak only in canonical `providerId` values.
 */

import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";

/** Provider slugs accepted by pi-ai's loopback helpers. */
export type ConnectProviderSlug = "codex";

/** Map the platform's canonical `providerId` to the slug pi-ai expects. */
export const PROVIDER_ID_TO_SLUG: Readonly<Record<string, ConnectProviderSlug>> = Object.freeze({
  codex: "codex",
});

export const DISPLAY_NAME: Readonly<Record<ConnectProviderSlug, string>> = Object.freeze({
  codex: "ChatGPT (Codex / Plus / Pro / Business)",
});

export const DEFAULT_LABEL: Readonly<Record<ConnectProviderSlug, string>> = Object.freeze({
  codex: "ChatGPT",
});

/** Normalised credential shape returned by the loopback flow. */
export interface NormalisedOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. `0` means the upstream did not surface an expiry. */
  expiresAt: number;
  email?: string;
  subscriptionType?: string;
  /** Codex only — extracted from JWT by pi-ai. */
  accountId?: string;
}

/**
 * UI hooks injected by the caller. Both the CLI and the helper supply a
 * {@link spinner}-flavoured implementation; tests inject silent stubs.
 */
export interface LoopbackCallbacks {
  /** Display the authorize URL the user should visit. */
  onAuth?: (info: { url: string; instructions?: string }) => void;
  /** Prompt for manual code paste-back when the loopback bind fails. */
  onPrompt?: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  /** Surface a free-form progress message (token exchange, etc.). */
  onProgress?: (message: string) => void;
}

/**
 * Run the loopback PKCE flow for the chosen provider via Pi's helpers.
 * Pi spins up an HTTP listener on the provider-specific loopback port
 * (`127.0.0.1:1455` for Codex), exchanges the authorization code, and
 * returns Pi's `OAuthCredentials` shape. This function normalises that
 * shape into {@link NormalisedOAuthCredentials}.
 */
export async function runLoopbackOAuth(
  _slug: ConnectProviderSlug,
  callbacks: LoopbackCallbacks = {},
): Promise<NormalisedOAuthCredentials> {
  const piCallbacks = {
    onAuth: (info: { url: string; instructions?: string }) => callbacks.onAuth?.(info),
    onPrompt: async (prompt: { message: string; placeholder?: string }) =>
      callbacks.onPrompt
        ? callbacks.onPrompt(prompt)
        : Promise.reject(new Error("Manual code paste-back required but no onPrompt handler")),
    onProgress: (message: string) => callbacks.onProgress?.(message),
  };

  const creds = await loginOpenAICodex(piCallbacks);

  // pi-ai's `OAuthCredentials` shape: `{ access, refresh, expires (ms epoch), [extras] }`.
  // Surrounding code defensively narrows extras because pi-ai types extras as `[key: string]: unknown`
  // — a future rename of `accountId` / `subscription_type` would silently drop the field otherwise.
  const extras = creds as Record<string, unknown>;

  const account = extras.account as Record<string, unknown> | undefined;
  const accountEmail =
    account && typeof account.email_address === "string"
      ? (account.email_address as string)
      : undefined;
  const directEmail = typeof extras.email === "string" ? (extras.email as string) : undefined;
  const subscriptionType =
    typeof extras.subscription_type === "string" ? (extras.subscription_type as string) : undefined;
  const accountId = typeof extras.accountId === "string" ? (extras.accountId as string) : undefined;

  const normalised: NormalisedOAuthCredentials = {
    accessToken: creds.access,
    refreshToken: creds.refresh,
    expiresAt: typeof creds.expires === "number" ? creds.expires : 0,
  };
  const email = directEmail ?? accountEmail;
  if (email) normalised.email = email;
  if (subscriptionType) normalised.subscriptionType = subscriptionType;
  if (accountId) normalised.accountId = accountId;
  return normalised;
}
