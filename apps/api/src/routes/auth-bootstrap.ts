// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/auth/bootstrap/redeem` — claim ownership of a closed-by-default
 * unattended install (issue #344 Layer 2b).
 *
 * Flow:
 *   1. Validate body shape (Zod).
 *   2. Timing-safe compare of `token` against `env.AUTH_BOOTSTRAP_TOKEN`.
 *   3. Confirm no organizations exist yet (durable replay guard — once an
 *      org exists, the token is dead even across process restarts).
 *   4. Run BA's `signUpEmail` inside `withBootstrapTokenRedemption()` so
 *      the closed-mode gate (`AUTH_DISABLE_SIGNUP=true`) is bypassed
 *      exactly once for this request.
 *   5. Create the bootstrap org with the freshly-minted user as owner,
 *      reusing the same `createBootstrapOrg` helper as
 *      `AUTH_BOOTSTRAP_OWNER_EMAIL`. The post-bootstrap hook (default app
 *      + hello-world agent) fires uniformly via `setPostBootstrapOrgHook`.
 *   6. Mark the in-memory consume flag so a concurrent retry sees an
 *      already-redeemed instance even before the org row is committed.
 *
 * Response: BA's signup Response (sets the session cookie) is returned
 * verbatim so the SPA gets logged in immediately, no second round-trip.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getAuth, withBootstrapTokenRedemption } from "@appstrate/db/auth";
import { createBootstrapOrg } from "@appstrate/db/bootstrap-org";
import { user as userTable } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import { eq } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { ApiError, parseBody } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import {
  isBootstrapTokenRedeemable,
  markBootstrapTokenConsumed,
  verifyBootstrapToken,
} from "../lib/bootstrap-token.ts";
import { triggerPostBootstrapOrg } from "../lib/post-bootstrap-hook.ts";

const redeemSchema = z.object({
  token: z.string().min(1).max(128),
  email: z.string().email().toLowerCase().trim(),
  name: z.string().min(1).max(120).trim(),
  password: z.string().min(8).max(256),
});

export function createAuthBootstrapRouter(): Hono {
  const router = new Hono();

  router.post("/redeem", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    const data = parseBody(redeemSchema, body);

    // Step 1: token still valid? (in-memory + DB-org-count check)
    if (!(await isBootstrapTokenRedeemable())) {
      // Generic 410 — same response shape regardless of "no token configured"
      // vs "token already redeemed" so a probe can't distinguish the two.
      throw new ApiError({
        status: 410,
        code: "bootstrap_token_unavailable",
        title: "Gone",
        detail:
          "No bootstrap token is currently redeemable. The instance has either " +
          "no token configured, has already been claimed, or was bootstrapped " +
          "via AUTH_BOOTSTRAP_OWNER_EMAIL.",
      });
    }

    // Step 2: timing-safe compare against env value
    if (!verifyBootstrapToken(data.token)) {
      throw new ApiError({
        status: 401,
        code: "bootstrap_token_invalid",
        title: "Unauthorized",
        detail: "Invalid bootstrap token.",
      });
    }

    // Step 3: signup via BA inside the bypass envelope
    const authApi = getAuth().api;
    let authResponse: Response;
    try {
      authResponse = (await withBootstrapTokenRedemption(() =>
        authApi.signUpEmail({
          body: { email: data.email, password: data.password, name: data.name },
          headers: c.req.raw.headers,
          asResponse: true,
        }),
      )) as Response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("bootstrap-redeem: signUpEmail threw", { error: msg, email: data.email });
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        throw new ApiError({
          status: 409,
          code: "bootstrap_user_exists",
          title: "Conflict",
          detail:
            "An account with that email already exists. Use a different email — " +
            "the bootstrap owner must be a fresh account.",
        });
      }
      throw new ApiError({
        status: 500,
        code: "bootstrap_signup_failed",
        title: "Internal Server Error",
        detail: "Signup failed during bootstrap redemption.",
      });
    }

    if (!authResponse.ok) {
      const bodyText = await authResponse.text().catch(() => "");
      logger.warn("bootstrap-redeem: signUpEmail !ok", {
        status: authResponse.status,
        body: bodyText.slice(0, 400),
        email: data.email,
      });
      // Surface BA's status to the SPA so password-policy / duplicate-email
      // errors keep their structured semantics.
      throw new ApiError({
        status: authResponse.status === 422 ? 422 : 400,
        code: "bootstrap_signup_rejected",
        title: authResponse.status === 422 ? "Unprocessable Entity" : "Bad Request",
        detail:
          authResponse.status === 422
            ? "Bootstrap signup rejected (likely duplicate email or weak password)."
            : "Bootstrap signup rejected by auth provider.",
      });
    }

    // Step 4: locate the freshly-inserted user row and create the bootstrap org
    const [row] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, data.email))
      .limit(1);
    if (!row) {
      logger.error("bootstrap-redeem: user not found post-signup", { email: data.email });
      throw new ApiError({
        status: 500,
        code: "bootstrap_user_lookup_failed",
        title: "Internal Server Error",
        detail: "Signup appeared to succeed but the user row could not be located.",
      });
    }

    const env = getEnv();
    let orgInfo: { orgId: string; slug: string };
    try {
      const result = await createBootstrapOrg(row.id, env.AUTH_BOOTSTRAP_ORG_NAME);
      orgInfo = { orgId: result.orgId, slug: result.slug };
      if (result.created) {
        logger.info("bootstrap-redeem: org created", {
          userId: row.id,
          email: data.email,
          orgId: result.orgId,
          slug: result.slug,
        });
        // Best-effort post-bootstrap (default app + agent). Failures are
        // logged but non-fatal — the org itself is committed.
        await triggerPostBootstrapOrg({
          orgId: result.orgId,
          slug: result.slug,
          userId: row.id,
          userEmail: data.email,
        }).catch((err: unknown) =>
          logger.error("bootstrap-redeem: post-hook failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } catch (err) {
      logger.error("bootstrap-redeem: org creation failed", {
        userId: row.id,
        email: data.email,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ApiError({
        status: 500,
        code: "bootstrap_org_failed",
        title: "Internal Server Error",
        detail: "Bootstrap org creation failed after signup; instance is in a partial state.",
      });
    }

    // Step 5: mark consumed (prevents in-process replay on a duplicate POST)
    markBootstrapTokenConsumed();

    // Pass-through BA's response (includes Set-Cookie for the session)
    // but rewrite the body to surface our org info to the SPA.
    const baBody = (await authResponse.json().catch(() => ({}))) as Record<string, unknown>;
    const passThroughHeaders = new Headers();
    authResponse.headers.forEach((value, key) => {
      // Preserve only Set-Cookie + Content-Type from BA. Other headers
      // (CORS, etc.) are re-derived by the platform layer.
      if (key.toLowerCase() === "set-cookie") {
        passThroughHeaders.append("set-cookie", value);
      }
    });
    passThroughHeaders.set("content-type", "application/json");
    return new Response(
      JSON.stringify({
        ...baBody,
        bootstrap: {
          orgId: orgInfo.orgId,
          orgSlug: orgInfo.slug,
        },
      }),
      { status: 200, headers: passThroughHeaders },
    );
  });

  return router;
}
