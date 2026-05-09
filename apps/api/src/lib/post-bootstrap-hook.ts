// SPDX-License-Identifier: Apache-2.0

/**
 * Shared post-bootstrap-org side effects.
 *
 * Runs after `createBootstrapOrg` actually inserted a new org row,
 * regardless of how the bootstrap was initiated:
 *   - `AUTH_BOOTSTRAP_OWNER_EMAIL` first-signup (via the BA after-hook
 *     in `packages/db/src/auth.ts`)
 *   - `AUTH_BOOTSTRAP_TOKEN` redemption via `POST /api/auth/bootstrap/redeem`
 *
 * Side effects (all isolated — failures are logged, never re-raised):
 *   1. Emit `onOrgCreate` so module listeners (cloud free-tier, audit) see it.
 *   2. Create the default Application for the new org.
 *   3. Provision the hello-world default agent inside that Application.
 *
 * Lives outside `boot.ts` so the redeem route can call it without
 * pulling in the boot module's heavy import graph.
 */

import { logger } from "./logger.ts";
import { emitEvent } from "./modules/module-loader.ts";
import { createDefaultApplication } from "../services/applications.ts";
import { provisionDefaultAgentForOrg } from "../services/default-agent.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export interface PostBootstrapOrgArgs {
  orgId: string;
  slug: string;
  userId: string;
  userEmail: string;
}

export async function triggerPostBootstrapOrg(args: PostBootstrapOrgArgs): Promise<void> {
  const { orgId, slug, userId, userEmail } = args;
  await emitEvent("onOrgCreate", orgId, userEmail);
  const defaultApp = await createDefaultApplication(orgId, userId).catch((err) => {
    logger.warn("Failed to create default application for bootstrap org", {
      orgId,
      error: getErrorMessage(err),
    });
    return null;
  });
  if (defaultApp) {
    await provisionDefaultAgentForOrg(orgId, slug, userId, defaultApp.id).catch((err) => {
      logger.warn("Failed to provision default agent for bootstrap org", {
        orgId,
        error: getErrorMessage(err),
      });
    });
  }
}
