// SPDX-License-Identifier: Apache-2.0

/**
 * Data-driven wrapper around `@mariozechner/pi-ai`'s loopback PKCE flow.
 *
 * Each entry in {@link PROVIDERS} binds a canonical platform `providerId`
 * to the pi-ai login function that runs the loopback dance, plus the
 * display strings the CLI surfaces to the user. New OAuth providers are
 * added by appending an entry — there is no provider-specific branching
 * anywhere else in this file or in the CLI.
 *
 * Internal-only — driven by `apps/connect-helper/src/cli.ts` after it
 * decodes a pairing token from the dashboard. The dashboard and platform
 * speak only in canonical `providerId` values; pi-ai's per-provider login
 * function is an implementation detail isolated to this registry.
 */

import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";

/** Pi-AI callback signature shared by every loopback login function. */
type PiCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress: (message: string) => void;
};

/**
 * Pi-AI's `OAuthCredentials` shape. Defensively typed as a permissive
 * record because pi-ai surfaces `[key: string]: unknown` extras — narrowed
 * below in {@link normalisePiCreds}.
 */
type PiOAuthCredentials = {
  access: string;
  refresh: string;
  expires?: number;
} & Record<string, unknown>;

type PiLoginFn = (callbacks: PiCallbacks) => Promise<PiOAuthCredentials>;

interface ProviderLoopback {
  /** Pi-AI login function that runs the loopback dance for this provider. */
  login: PiLoginFn;
  /** Long-form name surfaced in the helper banner. */
  displayName: string;
  /** Default credential label used when the user does not pass `--label`. */
  defaultLabel: string;
}

/**
 * Registry of supported OAuth providers. The platform's canonical
 * `providerId` is the key; adding a new provider means adding one entry.
 */
export const PROVIDERS: Readonly<Record<string, ProviderLoopback>> = Object.freeze({
  codex: {
    login: loginOpenAICodex,
    displayName: "ChatGPT (Codex / Plus / Pro / Business)",
    defaultLabel: "ChatGPT",
  },
});

/** Normalised credential shape returned by the loopback flow. */
export interface NormalisedOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. `0` means the upstream did not surface an expiry. */
  expiresAt: number;
  email?: string;
  /** Pi-AI surfaces this for some providers (Codex JWT, etc.) when present. */
  accountId?: string;
}

/**
 * UI hooks injected by the caller. Both the CLI and the helper supply a
 * spinner-flavoured implementation; tests inject silent stubs.
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
 * Resolve a registered provider by canonical id, or `undefined` when the
 * helper does not support it (typically because a private platform module
 * registered a providerId that the OSS helper does not know about).
 */
export function getProvider(providerId: string): ProviderLoopback | undefined {
  return PROVIDERS[providerId];
}

/**
 * Run the loopback PKCE flow for the chosen provider. Pi spins up an
 * HTTP listener on the provider-specific loopback port, exchanges the
 * authorization code, and returns Pi's `OAuthCredentials` shape — this
 * function normalises it into {@link NormalisedOAuthCredentials}.
 *
 * Throws if `providerId` is not registered; callers should first check
 * with {@link getProvider} and surface a friendly error.
 */
export async function runLoopbackOAuth(
  providerId: string,
  callbacks: LoopbackCallbacks = {},
): Promise<NormalisedOAuthCredentials> {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unsupported providerId: ${providerId}`);
  }

  const piCallbacks: PiCallbacks = {
    onAuth: (info) => callbacks.onAuth?.(info),
    onPrompt: async (prompt) =>
      callbacks.onPrompt
        ? callbacks.onPrompt(prompt)
        : Promise.reject(new Error("Manual code paste-back required but no onPrompt handler")),
    onProgress: (message) => callbacks.onProgress?.(message),
  };

  const creds = await provider.login(piCallbacks);
  return normalisePiCreds(creds);
}

/**
 * Narrow pi-ai's `[key: string]: unknown` extras into our normalised shape.
 * A future pi-ai rename of `accountId` / `email` / `account.email_address`
 * would silently drop the field if we did naive casts — the defensive
 * `typeof` checks turn that into a `undefined` we can detect.
 */
function normalisePiCreds(creds: PiOAuthCredentials): NormalisedOAuthCredentials {
  const account = creds.account as Record<string, unknown> | undefined;
  const accountEmail =
    account && typeof account.email_address === "string" ? account.email_address : undefined;
  const directEmail = typeof creds.email === "string" ? creds.email : undefined;
  const accountId = typeof creds.accountId === "string" ? creds.accountId : undefined;

  const normalised: NormalisedOAuthCredentials = {
    accessToken: creds.access,
    refreshToken: creds.refresh,
    expiresAt: typeof creds.expires === "number" ? creds.expires : 0,
  };
  const email = directEmail ?? accountEmail;
  if (email) normalised.email = email;
  if (accountId) normalised.accountId = accountId;
  return normalised;
}
