// SPDX-License-Identifier: Apache-2.0

/**
 * Mint a hosted-connect link into the run-kickoff 412 (issue #1207).
 *
 * The readiness gate already names WHICH auth a connect flow must target and
 * WHICH scopes it must request (`auth_key` + `required_scopes`, relayed by
 * `translateResolutionError`). This module turns that description into the
 * remedy itself: a `connect_url` on the very error item, so a surface that
 * renders connect cards has nothing left to call. The chat is the case that
 * forced it — the model would otherwise have to read the 412, pick the connect
 * kickoff, and get the scopes right, three chances to do nothing at all.
 *
 * Minting is free of side effects (`buildConnectUrl` signs claims and returns a
 * URL; the only store write is `consumeJti` at redemption), so there is no
 * reuse cache and no attempt counter here: a link's blast radius is bounded by
 * `CONNECT_SESSION_TTL_MS` and by how fast a human can click.
 *
 * The claims are the ones `POST …/auths/{authKey}/connect/session` signs — same
 * actor projection, same `scopes` passthrough (the union with the auth's
 * `default_scopes` and what the target connection already granted happens at
 * redemption, in `/connect/start`, for a hand-minted link and this one alike).
 * Three differences from that route are deliberate, and none of them may be
 * read as "the route validates something this does not":
 *
 *  - `force_account_select` is a caller-supplied body field there; it has no
 *    caller here, so the claim is simply absent and the provider decides.
 *  - the manifest comes from `fetchIntegrationManifest` (the readiness pass's
 *    memo) rather than the route's org-scoped `readIntegrationAuth` →
 *    `getIntegration`. Safe because the ONLY ids reaching this function are the
 *    ones readiness just resolved for this org and space: the agent declared
 *    them, `listActiveIntegrationIds` confirmed each is installed and enabled
 *    HERE, and the id is what indexes the memo — an id outside the org never
 *    reaches the mint to be looked up unscoped.
 *  - the scope check is the same one, applied at a different moment: the route
 *    runs `assertScopesInAuthCatalog` on `body.scopes`, and this module runs
 *    `scopesNotInAuthCatalog` on `target.scopes` below. `/connect/start` replays
 *    signed claims and re-validates nothing, so whichever end mints is the end
 *    that must check.
 */

import { buildConnectUrl } from "./connect-session.ts";
import { fetchIntegrationManifest, type IntegrationManifestCache } from "../integration-service.ts";
import { isUserConnectionCreationBlocked } from "../integration-connection-resolver.ts";
import { scopesNotInAuthCatalog } from "../integration-manifest-helpers.ts";
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
  /** Present = upgrade the actor's existing connection in place. */
  connectionId?: string;
}

/** `integrations.` is the field prefix every resolution error carries. */
const FIELD_PREFIX = "integrations.";

/**
 * Decide whether one 412 item is something the CALLING actor can clear by
 * opening a link, and with which claims. Pure.
 *
 * Two codes qualify, and only two:
 *
 *  - `not_connected` — a fresh connect, no `connection_id`.
 *  - `insufficient_scopes` on a connection the actor OWNS — an upgrade in
 *    place, so the existing row is re-consented rather than duplicated.
 *
 * Everything else is refused deliberately. `needs_reconnection` names a dead
 * credential whose owner may not be the caller and whose repair the
 * MissingConnections modal already drives with the actor's own pick;
 * `must_choose_connection` is a choice, not a missing connection;
 * `auth_key_mismatch` needs the user to change the agent, not to connect; and a
 * foreign-owned under-scoped connection is somebody else's account — minting
 * against it would let the caller re-consent a colleague's credential.
 */
export function connectOfferTarget(e: ResolutionFieldError): ConnectOfferTarget | null {
  if (!e.field.startsWith(FIELD_PREFIX)) return null;
  const integrationId = e.field.slice(FIELD_PREFIX.length);
  if (!integrationId || !e.auth_key) return null;
  const scopes = e.required_scopes ?? [];

  if (e.code === "not_connected") {
    return { integrationId, authKey: e.auth_key, scopes };
  }
  if (e.code === "insufficient_scopes" && e.owned_by_actor === true && e.connection_id) {
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

        // The mint is the security boundary — `/connect/start` replays these
        // signed claims and re-validates nothing — so it must not trust
        // `required_scopes`. That value is derived from the agent manifest's own
        // `integrations_configuration[id].scopes`, which on the inline-run
        // surface is caller-supplied; the same catalog check the connect
        // kickoffs apply to `body.scopes` therefore applies here. A gap means
        // the selection is wrong upstream (the inline preflight now refuses it
        // with `scope_not_in_catalog`) — leave the item bare rather than sign a
        // consent request for scopes this auth never advertised.
        const undeclared = scopesNotInAuthCatalog(auth, target.scopes);
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

        const { connectUrl, expiresAt } = buildConnectUrl({
          org_id: scope.orgId,
          space_id: scope.spaceId,
          ...(actor.type === "user" ? { user_id: actor.id } : { end_user_id: actor.id }),
          package_id: target.integrationId,
          auth_key: target.authKey,
          ...(target.connectionId ? { connection_id: target.connectionId } : {}),
          ...(target.scopes.length > 0 ? { scopes: target.scopes } : {}),
        });
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
