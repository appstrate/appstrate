// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/auth/bootstrap/redeem` — claim ownership of a closed-by-default
 * unattended install (issue #344 Layer 2b).
 *
 * Flow:
 *   1. Rate-limit per source IP (5/min) — closes the brute-force window
 *      on a misconfigured short token.
 *   2. Validate body shape (Zod).
 *   3. Reserve a Postgres connection and take a session-scoped advisory
 *      lock (`pg_try_advisory_lock`). On contention return 409 — only
 *      one redemption can be in flight cluster-wide.
 *   4. Atomic in-process CAS via `tryAcquireRedemption()` — defends
 *      single-process replicas (PGlite dev mode included) against
 *      parallel POSTs that both passed the lock check.
 *   5. Confirm no organizations exist yet (durable replay guard — once an
 *      org exists, the token is dead even across process restarts).
 *   6. Timing-safe compare of `token` against `env.AUTH_BOOTSTRAP_TOKEN`.
 *      Failed verifies are logged at WARN with `clientIp` so SIEMs can
 *      detect a brute-force attempt.
 *   7. Run BA's `signUpEmail` inside `withBootstrapTokenRedemption()` so
 *      the closed-mode gate (`AUTH_DISABLE_SIGNUP=true`) is bypassed
 *      exactly once for this request. The bypass is scoped — it does
 *      NOT skip an active `AUTH_ALLOWED_SIGNUP_DOMAINS` allowlist (see
 *      `packages/db/src/auth.ts`).
 *   8. Create the bootstrap org. The post-bootstrap hook (default app
 *      + hello-world agent) fires uniformly via `triggerPostBootstrapOrg`.
 *      Its failures are logged + surfaced in the response `warnings`
 *      array so the operator can self-heal (createDefaultApplication
 *      is idempotent — first manual call after login backfills).
 *   9. Mark the in-memory consume flag so a concurrent retry sees an
 *      already-redeemed instance even before the org row is committed.
 *
 * Response: BA's signup `Set-Cookie` is forwarded verbatim (using
 * `getSetCookie()` to preserve multi-cookie batching from BA plugins
 * with refresh-token issuance) so the SPA gets logged in immediately,
 * no second round-trip.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getAuth, withBootstrapTokenRedemption } from "@appstrate/db/auth";
import { createBootstrapOrg } from "@appstrate/db/bootstrap-org";
import { db, reservePgConnection } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { ApiError, parseBody } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { getClientIp } from "../lib/client-ip.ts";
import { rateLimitByIp } from "../middleware/rate-limit.ts";
import {
  isBootstrapTokenRedeemable,
  markBootstrapTokenConsumed,
  releaseRedemption,
  tryAcquireRedemption,
  verifyBootstrapToken,
} from "../lib/bootstrap-token.ts";
import { triggerPostBootstrapOrg } from "../lib/post-bootstrap-hook.ts";

const redeemSchema = z.object({
  token: z.string().min(1).max(128),
  email: z.string().email().toLowerCase().trim(),
  name: z.string().min(1).max(120).trim(),
  password: z.string().min(8).max(256),
});

// Stable bigint key for the cluster-wide advisory lock. Picked outside
// the range used by core migrations and module migrations so collisions
// are impossible. The same value is reused across replicas — that's the
// point: only one process holds it at a time.
const BOOTSTRAP_REDEEM_LOCK_KEY = 8729463725001923174n;

export function createAuthBootstrapRouter(): Hono {
  const router = new Hono();

  // 5 attempts per minute per source IP. The route is mounted before
  // `applyAuthPipeline`, so the global authenticated rate-limiter never
  // sees it — we pin our own IP-keyed limiter explicitly. Logged 429s
  // give SIEMs the brute-force signal.
  router.post("/redeem", rateLimitByIp(5, 60), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    const data = parseBody(redeemSchema, body);

    // Cluster-wide serialization. PGlite mode (single-process dev) returns
    // null — we fall through to the in-process CAS below.
    const reserved = await reservePgConnection();
    let lockAcquired = false;
    let inFlight = false;
    try {
      if (reserved) {
        const result = await reserved.sql`
          SELECT pg_try_advisory_lock(${String(BOOTSTRAP_REDEEM_LOCK_KEY)}::bigint) AS acquired
        `;
        const row = result[0] as { acquired: boolean } | undefined;
        lockAcquired = !!row?.acquired;
        if (!lockAcquired) {
          logger.warn("bootstrap-redeem: cluster lock contention", {
            ip: getClientIp(c),
          });
          throw new ApiError({
            status: 409,
            code: "bootstrap_redeem_in_progress",
            title: "Conflict",
            detail: "Another bootstrap redemption is already in progress on this instance.",
          });
        }
      }

      // In-process CAS — handles single-replica PGlite mode AND defends
      // against the (theoretical) case where the SAME replica receives
      // two parallel POSTs that both grabbed the advisory lock on
      // different reserved connections. The CAS distinguishes "consumed"
      // (already redeemed → 410, same as the durable DB-org-count guard)
      // from "in_flight" (another POST mid-redeem → 409).
      const slot = tryAcquireRedemption();
      if (slot === "in_flight") {
        throw new ApiError({
          status: 409,
          code: "bootstrap_redeem_in_progress",
          title: "Conflict",
          detail: "Another bootstrap redemption is already in progress on this instance.",
        });
      }
      if (slot === "consumed") {
        throw new ApiError({
          status: 410,
          code: "bootstrap_token_unavailable",
          title: "Gone",
          detail:
            "The bootstrap token has already been redeemed. " +
            "If you lost access, restart the platform with a fresh AUTH_BOOTSTRAP_TOKEN.",
        });
      }
      inFlight = true;

      // Step 1: token still valid? (in-memory + DB-org-count check)
      // Re-checked INSIDE the lock so two contending requests serialize
      // correctly: the second observes `n>0` after the first commits.
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
        // WARN-level so SIEMs alert on brute-force. The IP comes from
        // `getClientIp(c)` which respects `TRUST_PROXY` for accurate
        // attribution behind a reverse proxy.
        // Intentionally NO email field: the submitter's email is
        // attacker-supplied PII on this branch — keep logs free of it
        // so a public scan can't accumulate probe-emails in our SIEM.
        logger.warn("bootstrap-redeem: invalid token", {
          ip: getClientIp(c),
        });
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
        // Email omitted — see WARN-log comment above on the bad-token branch.
        logger.error("bootstrap-redeem: signUpEmail threw", { error: msg });
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
        // Domain allowlist rejection (#344 hardening — bootstrap-token
        // bypass does NOT skip AUTH_ALLOWED_SIGNUP_DOMAINS). Surface
        // the structured reason so the operator knows to use an
        // allowlisted email.
        if (msg.includes("signup_domain_not_allowed")) {
          throw new ApiError({
            status: 403,
            code: "signup_domain_not_allowed",
            title: "Forbidden",
            detail:
              "The instance has an active email-domain allowlist (AUTH_ALLOWED_SIGNUP_DOMAINS). " +
              "Use an allowlisted email for the bootstrap owner.",
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
        // Email omitted — see WARN-log comment above on the bad-token branch.
        logger.warn("bootstrap-redeem: signUpEmail !ok", {
          status: authResponse.status,
          body: bodyText.slice(0, 400),
        });
        // Domain-allowlist rejection — surfaced from the auth.ts gate
        // when the bootstrap-token bypass hits an active
        // `AUTH_ALLOWED_SIGNUP_DOMAINS`. Remap to 403 with the
        // structured code so the SPA can display the precise reason.
        if (bodyText.includes("signup_domain_not_allowed")) {
          throw new ApiError({
            status: 403,
            code: "signup_domain_not_allowed",
            title: "Forbidden",
            detail:
              "The instance has an active email-domain allowlist (AUTH_ALLOWED_SIGNUP_DOMAINS). " +
              "Use an allowlisted email for the bootstrap owner.",
          });
        }
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
      const warnings: string[] = [];
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
          // Best-effort post-bootstrap (default app + agent). On failure
          // we still return 200 — the org/user exist and login works —
          // but surface a `warnings` array so the SPA can show a "default
          // app provisioning failed, retry by visiting /settings/apps"
          // banner. `createDefaultApplication` is idempotent so any
          // subsequent call (manual or boot-time backfill) self-heals.
          await triggerPostBootstrapOrg({
            orgId: result.orgId,
            slug: result.slug,
            userId: row.id,
            userEmail: data.email,
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("bootstrap-redeem: post-hook failed", { error: msg });
            warnings.push("default_app_provisioning_failed");
          });
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

      // Step 5: mark consumed (clears in-flight + sets durable consumed flag)
      markBootstrapTokenConsumed();
      inFlight = false;

      // Pass-through BA's response (includes Set-Cookie for the session)
      // but rewrite the body to surface our org info to the SPA. Use
      // `getSetCookie()` so multi-cookie batches (refresh + session) are
      // appended individually instead of concatenated with `, ` which
      // browsers interpret as a malformed single cookie. Available on
      // Bun, Node 18.14+, and modern Undici — the runtimes Appstrate
      // supports — so no fallback is needed.
      const baBody = (await authResponse.json().catch(() => ({}))) as Record<string, unknown>;
      const passThroughHeaders = new Headers();
      for (const cookie of authResponse.headers.getSetCookie()) {
        passThroughHeaders.append("set-cookie", cookie);
      }
      passThroughHeaders.set("content-type", "application/json");
      return new Response(
        JSON.stringify({
          ...baBody,
          bootstrap: {
            orgId: orgInfo.orgId,
            orgSlug: orgInfo.slug,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
        }),
        { status: 200, headers: passThroughHeaders },
      );
    } finally {
      // Release the in-process slot if we never reached `markConsumed`
      // (i.e. we threw somewhere). On the success path `markConsumed`
      // has already cleared `_inFlight` so this is a no-op.
      if (inFlight) releaseRedemption();
      // Release the cluster-wide lock + reserved connection. Order
      // matters: unlock BEFORE release(), otherwise the connection
      // returns to the pool still holding the session-scoped lock.
      if (reserved) {
        if (lockAcquired) {
          await reserved.sql`
            SELECT pg_advisory_unlock(${String(BOOTSTRAP_REDEEM_LOCK_KEY)}::bigint)
          `.catch((err: unknown) =>
            logger.error("bootstrap-redeem: failed to release advisory lock", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        reserved.release();
      }
    }
  });

  return router;
}
