// SPDX-License-Identifier: Apache-2.0

/**
 * First-party OAuth clients — the instance-level clients for Appstrate's own
 * apps (CLI, chat, …). Each is a public PKCE client with a **deterministic
 * clientId** so the distributed app authenticates against any instance with no
 * operator configuration (OAuth 2.1 treats public-client ids as non-secret,
 * RFC 9700 §4.1 — security rests on PKCE + consent + realm/audience gates).
 *
 * This is the declarative version of the old per-app `ensure-*-client` files:
 * add an app = add a registry entry, not a new module. Scopes are per-app
 * (least privilege) and each token is still filtered through the user's org
 * role at issuance (`auth/claims.ts`), so a broad client scope never escalates
 * a member. Unlike self-service DCR (bounded to identity + MCP), these seeded
 * rows go straight to the DB, so first-party apps can carry the scopes their
 * function needs — notably the chat's `llm-proxy:call` + `models:read`.
 *
 * Idempotent: an existing row with the same `client_id` is left untouched
 * (operators rotate scopes/redirects via SQL, never silently on upgrade).
 */

import { db } from "@appstrate/db/client";
import { oauthClient } from "@appstrate/db/schema";
import { getEnv } from "@appstrate/env";
import { prefixedId } from "../../../lib/ids.ts";
import { logger } from "../../../lib/logger.ts";

export const APPSTRATE_CLI_CLIENT_ID = "appstrate-cli";
export const APPSTRATE_CHAT_CLIENT_ID = "appstrate-chat";

interface FirstPartyClient {
  clientId: string;
  name: string;
  /** Per-app least-privilege scope set (still role-filtered at token issuance). */
  scopes: string[];
  grantTypes: string[];
  responseTypes: string[];
  redirectUris: string[];
  /** `false` keeps the consent screen (and its org picker) — true skips it. */
  skipConsent: boolean;
  allowSignup: boolean;
}

const IDENTITY = ["openid", "profile", "email", "offline_access"];

function registry(): FirstPartyClient[] {
  return [
    {
      // The official `appstrate` CLI (device-authorization login, RFC 8628).
      // No browser redirect; consent shown on the out-of-band /activate page.
      clientId: APPSTRATE_CLI_CLIENT_ID,
      name: "Appstrate CLI",
      scopes: IDENTITY,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      responseTypes: [],
      redirectUris: [],
      skipConsent: false,
      allowSignup: false,
    },
    {
      // The first-party chat satellite (browser authorization-code + PKCE).
      // Carries inference + MCP scopes; consent stays on so the user picks the
      // org (the grant binds to it). Redirect URIs are operator-configured.
      clientId: APPSTRATE_CHAT_CLIENT_ID,
      name: "Appstrate Chat",
      scopes: [...IDENTITY, "mcp:read", "mcp:invoke", "models:read", "llm-proxy:call"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      redirectUris: getEnv()
        .APPSTRATE_CHAT_REDIRECT_URIS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      skipConsent: false,
      allowSignup: false,
    },
  ];
}

async function seedClient(c: FirstPartyClient): Promise<void> {
  const now = new Date();
  // ON CONFLICT DO NOTHING closes the read-then-insert race between
  // concurrently-booting instances; the row is never auto-modified on restart.
  await db
    .insert(oauthClient)
    .values({
      id: prefixedId("oac"),
      clientId: c.clientId,
      clientSecret: null,
      name: c.name,
      redirectUris: c.redirectUris,
      postLogoutRedirectUris: [],
      scopes: c.scopes,
      level: "instance",
      referencedOrgId: null,
      referencedApplicationId: null,
      metadata: JSON.stringify({ level: "instance" as const, clientId: c.clientId }),
      skipConsent: c.skipConsent,
      allowSignup: c.allowSignup,
      signupRole: "member",
      disabled: false,
      type: "native",
      public: true,
      tokenEndpointAuthMethod: "none",
      grantTypes: c.grantTypes,
      responseTypes: c.responseTypes,
      requirePKCE: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: oauthClient.clientId });
}

/** Seed every first-party client. Idempotent; safe on every boot. */
export async function ensureFirstPartyClients(): Promise<void> {
  for (const c of registry()) {
    if (c.grantTypes.includes("authorization_code") && c.redirectUris.length === 0) {
      // An auth-code client with no redirect URI can't be used — skip it loudly
      // rather than seed a dead row (e.g. chat redirect not configured).
      logger.warn("Skipping first-party client with no redirect URIs", { clientId: c.clientId });
      continue;
    }
    await seedClient(c);
  }
}

/**
 * Back-compat: seed just the CLI client and return its id. Retained so existing
 * call sites and tests keep working after the move into the registry.
 */
export async function ensureCliClient(): Promise<string> {
  const cli = registry().find((c) => c.clientId === APPSTRATE_CLI_CLIENT_ID)!;
  await seedClient(cli);
  return APPSTRATE_CLI_CLIENT_ID;
}
