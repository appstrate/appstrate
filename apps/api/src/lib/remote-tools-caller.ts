// SPDX-License-Identifier: Apache-2.0

/**
 * The caller of a remote integration's tools outside a run, read from the request: whoever the
 * credential proxy would act for, reaching what its rule reaches. Bearer-only surfaces assert that
 * (`assertBearerOnly`) before calling this; it decides no access.
 */

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getActor } from "./actor.ts";
import { connectOfferPolicyFromRequest } from "./connect-offer-policy.ts";
import { callerPermissions } from "./permissions.ts";
import { getSpaceScope } from "./scope.ts";
import { reachOutsideRun } from "../services/credential-proxy/access.ts";
import type { RemoteToolsCaller } from "../services/credential-proxy/remote-tools.ts";

export function remoteToolsCaller(c: Context<AppEnv>): RemoteToolsCaller {
  return {
    scope: getSpaceScope(c),
    actor: getActor(c),
    reach: reachOutsideRun(callerPermissions(c), c.get("space")!),
    caller: {
      apiKeyId: c.get("apiKeyId") || null,
      authMethod: c.get("authMethod"),
      requestId: c.get("requestId"),
    },
    signal: c.req.raw.signal,
    connectOffers: connectOfferPolicyFromRequest(c),
  };
}
