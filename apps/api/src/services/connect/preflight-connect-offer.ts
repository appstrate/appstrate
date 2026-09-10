// SPDX-License-Identifier: Apache-2.0

/**
 * Mint a hosted-connect link into the run-kickoff 412 (issue #1207).
 *
 * The readiness gate already names WHICH auth a connect flow must target and
 * WHICH scopes it must request (`auth_key` + `required_scopes`, relayed by
 * `translateResolutionError`). This module turns that description into the
 * remedy itself: a `connect_url` on the very error item, so a surface that
 * renders connect cards has nothing left to call. Who may ask for one, and why
 * that is a narrow set, is documented once — on `RUN_CONNECT_OFFERS_HEADER`
 * (`@appstrate/core/run-and-wait-client`).
 *
 * Minting is pure: `buildConnectUrl` signs claims and returns a URL, and the
 * only store write is `consumeJti` at redemption. So there is no reuse cache
 * and no attempt counter here — a link's blast radius is bounded by
 * `CONNECT_SESSION_TTL_MS`.
 *
 * SECURITY INVARIANT — the mint is the validation boundary. `/connect/start`
 * replays these signed claims and re-validates nothing, so every check the
 * `POST …/auths/{authKey}/connect/session` route runs on caller input has to
 * run here too. Two consequences, both load-bearing below: `target.scopes` gets
 * the same scope-catalog check the route applies to `body.scopes`, and the
 * unscoped `fetchIntegrationManifest` read is safe ONLY because the ids
 * reaching this function are the ones readiness just resolved for this org and
 * space (the agent declared them and `listActiveIntegrationIds` confirmed each
 * is installed and enabled HERE).
 */

import { buildConnectUrl, connectClaimsFor } from "./connect-session.ts";
import { fetchIntegrationManifest, type IntegrationManifestCache } from "../integration-service.ts";
import { isUserConnectionCreationBlocked } from "../integration-connection-resolver.ts";
import { partitionScopesByAuthCatalog } from "@appstrate/core/integration";
import type { ResolutionFieldError } from "../../lib/errors.ts";
import type { ConnectOfferPolicy } from "../../lib/connect-offer-policy.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import type { Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";

/** What one 412 item needs connected, when a connect flow can clear it here. */
export interface ConnectOfferTarget {
  integrationId: string;
  authKey: string;
  /** Exactly what the item asked for — no union computed at mint time. */
  scopes: string[];
  /** Present = re-consent the actor's existing connection in place. */
  connectionId?: string;
}

/** `integrations.` is the field prefix every resolution error carries. */
const FIELD_PREFIX = "integrations.";

/**
 * The codes whose remedy is a fresh consent on a connection that already
 * exists — a scope upgrade, or a dead credential re-granted. Both re-consent
 * the SAME row (`connection_id` rides the claims), never a duplicate.
 */
const IN_PLACE_CODES: ReadonlySet<string> = new Set(["insufficient_scopes", "needs_reconnection"]);

/**
 * Decide whether one 412 item is something the CALLING actor can clear by
 * opening a link, and with which claims. Pure.
 *
 * `not_connected` qualifies outright (a fresh connect, no `connection_id`).
 * The two {@link IN_PLACE_CODES} qualify only on a connection the actor OWNS
 * and only with an id to re-consent: a foreign-owned row is somebody else's
 * account, and minting against it would let the caller re-consent a
 * colleague's credential.
 *
 * Everything else is refused: `must_choose_connection` is a choice, not a
 * missing connection, and `auth_key_mismatch` needs the user to change the
 * agent, not to connect.
 */
export function connectOfferTarget(e: ResolutionFieldError): ConnectOfferTarget | null {
  if (!e.field.startsWith(FIELD_PREFIX)) return null;
  const integrationId = e.field.slice(FIELD_PREFIX.length);
  if (!integrationId || !e.auth_key) return null;
  const scopes = e.required_scopes ?? [];

  if (e.code === "not_connected") {
    return { integrationId, authKey: e.auth_key, scopes };
  }
  if (IN_PLACE_CODES.has(e.code) && e.owned_by_actor === true && e.connection_id) {
    return { integrationId, authKey: e.auth_key, scopes, connectionId: e.connection_id };
  }
  return null;
}

/**
 * Return a copy of `errors` with `connect_url` / `expires_at` / `package_id`
 * attached to every item this actor can clear by opening a link.
 *
 * Never mutates its input: the same array is projected into the
 * `onRunConnectionMissing` webhook payload, which must stay link-free.
 *
 * A mint that throws costs that ONE item its offer — the 412 still describes
 * every failure, and the modal's manual connect path still works. Failing the
 * whole response because a convenience could not be produced would turn a
 * legible readiness error into a 500.
 */
export async function attachConnectOffers(params: {
  errors: ResolutionFieldError[];
  scope: SpaceScope;
  actor: Actor;
  policy: ConnectOfferPolicy;
  /** The readiness pass's memo — every manifest read here is already in it. */
  manifestCache?: IntegrationManifestCache;
}): Promise<ResolutionFieldError[]> {
  const { errors, scope, actor, policy } = params;
  // No permission to create a connection as this actor ⇒ no capability handed
  // out, whatever the caller asked for.
  if (!policy.canConnect) return errors;

  return Promise.all(
    errors.map(async (e) => {
      const target = connectOfferTarget(e);
      if (!target) return e;
      try {
        // The auth must still exist AND be oauth2. Non-oauth2 auths connect
        // through the hosted credential form, where the human types a secret —
        // a link that opens a blank form is not a remedy the card can present.
        const loaded = await fetchIntegrationManifest(target.integrationId, params.manifestCache);
        if (!loaded.ok) return e;
        const auth = loaded.manifest.auths?.[target.authKey];
        if (auth?.type !== "oauth2") return e;

        // `required_scopes` is derived from the agent manifest's own
        // `integrations_configuration[id].scopes`, which on the inline-run
        // surface is caller-supplied — so it gets the same catalog check the
        // connect kickoffs apply to `body.scopes` (see the module note on the
        // validation boundary). A gap means the selection is wrong upstream;
        // leave the item bare rather than sign a consent request for scopes
        // this auth never advertised.
        const { undeclared } = partitionScopesByAuthCatalog(auth, target.scopes);
        if (undeclared.length > 0) {
          logger.warn("Connect offer refused: scopes outside the auth's catalog", {
            integrationId: target.integrationId,
            authKey: target.authKey,
            undeclared,
          });
          return e;
        }

        // Same carve-out as `assertConnectionCreationAllowed`: an admin may
        // create the shared connection the block exists to force everyone onto.
        if (
          !policy.canConfigure &&
          (await isUserConnectionCreationBlocked(scope.spaceId, target.integrationId))
        ) {
          return e;
        }

        const { connectUrl, expiresAt } = buildConnectUrl(
          connectClaimsFor({
            scope,
            actor,
            packageId: target.integrationId,
            authKey: target.authKey,
            ...(target.connectionId ? { connectionId: target.connectionId } : {}),
            scopes: target.scopes,
          }),
        );
        return {
          ...e,
          connect_url: connectUrl,
          expires_at: expiresAt,
          package_id: target.integrationId,
        };
      } catch (err) {
        logger.warn("Connect offer mint failed for readiness error", {
          integrationId: target.integrationId,
          authKey: target.authKey,
          err: String(err),
        });
        return e;
      }
    }),
  );
}
