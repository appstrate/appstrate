// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-provision the `appstrate-cli` OAuth client — instance-level public
 * client that powers the official `appstrate` CLI's device-authorization
 * login flow (RFC 8628).
 *
 * Parallels `ensureInstanceClient()` (platform SPA) with these differences:
 *
 *   - **Deterministic clientId** (`appstrate-cli`). Every Appstrate install
 *     ships the same identifier so a binary built elsewhere can authenticate
 *     against any instance without operator configuration. OAuth 2.1
 *     explicitly treats public-client identifiers as non-secret
 *     (RFC 9700 § 4.1); security rests on PKCE + consent + realm/audience
 *     gates, not on the id.
 *   - **Public client** — `type="native"`, `tokenEndpointAuthMethod="none"`,
 *     no stored `client_secret`. The device grant uses `client_id` alone at
 *     `/device/token` and relies on the server-enforced `device_code` as
 *     its proof-of-possession.
 *   - **Device + refresh grants only**. `authorization_code` is omitted
 *     because the CLI never performs a browser redirect (the device flow
 *     does all user interaction via the out-of-band `/activate` page).
 *   - **`skipConsent: false`** — RFC 8628 § 5.2 anti-phishing guidance
 *     requires an explicit user approval on `/activate` that shows the
 *     CLI's user-agent + IP. Honored regardless of any future
 *     first-party-trust promotion.
 *   - **No `redirect_uris`** — device flow has no redirect step.
 *
 * Idempotent: subsequent invocations short-circuit if a row with
 * `client_id = "appstrate-cli"` already exists. The row is never
 * auto-modified on restart — operators who need to rotate anything
 * related to this client (extra scopes, disable) must do it via SQL
 * explicitly to avoid surprise behavior on upgrades.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthClient } from "../schema.ts";
import { prefixedId } from "../../../lib/ids.ts";

/**
 * Deterministic `client_id` for the Appstrate CLI. Stable across every
 * install; safe to embed in the binary. Any consumer that needs to
 * reference the CLI client by id should import this constant rather than
 * hard-coding the string — keeps the orphan-whitelist in
 * `instance-client-sync.ts` and the CLI binary aligned.
 */
export const APPSTRATE_CLI_CLIENT_ID = "appstrate-cli";

export async function ensureCliClient(): Promise<string> {
  const [existing] = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, APPSTRATE_CLI_CLIENT_ID))
    .limit(1);
  if (existing) return existing.clientId;

  const now = new Date();
  // Metadata mirrors `createClient`'s contract so the OIDC hook pipeline
  // (`oidcGuardsPlugin` on `/device/approve`) can read `level` + `clientId`
  // without ad-hoc branches. For an instance client there is no
  // `referencedOrgId` or `referencedApplicationId`.
  const metadata = {
    level: "instance" as const,
    clientId: APPSTRATE_CLI_CLIENT_ID,
  };

  // ON CONFLICT DO NOTHING closes the read-then-insert race between two
  // concurrently-booting platform instances (blue-green rollout, test
  // preload, HA restart). The unique constraint on `client_id` would
  // raise anyway, but surfacing it as a hard error would abort the
  // whole boot path for a benign race — both processes have already
  // reached the same conclusion (the row should exist with these
  // values). Whichever insert wins, the outcome is identical.
  await db
    .insert(oauthClient)
    .values({
      id: prefixedId("oac"),
      clientId: APPSTRATE_CLI_CLIENT_ID,
      clientSecret: null,
      name: "Appstrate CLI",
      redirectUris: [],
      postLogoutRedirectUris: [],
      scopes: ["openid", "profile", "email", "offline_access"],
      level: "instance",
      referencedOrgId: null,
      referencedApplicationId: null,
      metadata: JSON.stringify(metadata),
      skipConsent: false,
      // CLI does not self-provision users — a platform operator authenticates
      // with an account that already exists. Signup through this client is
      // nonsensical (there is no browser-side registration surface).
      allowSignup: false,
      signupRole: "member",
      disabled: false,
      type: "native",
      public: true,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      // `responseTypes` is defined by RFC 6749 for the `authorization_code`
      // grant; not applicable to the device grant. Left empty.
      responseTypes: [],
      requirePKCE: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: oauthClient.clientId });

  return APPSTRATE_CLI_CLIENT_ID;
}
