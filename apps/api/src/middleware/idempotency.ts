/**
 * Idempotency middleware — ensures POST requests with the same `Idempotency-Key`
 * produce the same response without re-executing.
 *
 * Pattern: Stripe `Idempotency-Key` header (IETF draft-ietf-httpapi-idempotency-key-header).
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";
import {
  acquireIdempotencyLock,
  storeIdempotencyResult,
  releaseIdempotencyLock,
  computeBodyHash,
} from "../lib/idempotency.ts";

const MAX_KEY_LENGTH = 255;

/**
 * Idempotency middleware factory. Apply to POST routes that create resources.
 *
 * If `Idempotency-Key` header is absent, the request proceeds normally (opt-in).
 *
 * Note: control characters in headers are rejected at the HTTP layer (Request constructor),
 * so we only need to validate length here.
 */
export function idempotency() {
  return async (c: Context<AppEnv>, next: Next) => {
    const key = c.req.header("Idempotency-Key");
    if (!key) return next();

    if (key.length > MAX_KEY_LENGTH) {
      throw new ApiError({
        status: 400,
        code: "invalid_idempotency_key",
        title: "Invalid Idempotency Key",
        detail: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`,
        param: "Idempotency-Key",
      });
    }

    const orgId = c.get("orgId");
    const rawBody = await c.req.text();
    const bodyHash = computeBodyHash(rawBody);

    const lockResult = await acquireIdempotencyLock(orgId, key, bodyHash);

    if (lockResult.status === "processing") {
      throw new ApiError({
        status: 409,
        code: "idempotency_in_progress",
        title: "Idempotency Conflict",
        detail: "A request with this idempotency key is currently being processed. Retry later.",
        param: "Idempotency-Key",
      });
    }

    if (lockResult.status === "cached") {
      const cached = lockResult.result;
      if (cached.bodyHash !== bodyHash) {
        throw new ApiError({
          status: 422,
          code: "idempotency_conflict",
          title: "Idempotency Conflict",
          detail: "This idempotency key was already used with a different request body.",
          param: "Idempotency-Key",
        });
      }

      // Replay the cached response
      const headers = new Headers(cached.headers);
      headers.set("Idempotent-Replayed", "true");
      return new Response(cached.body, {
        status: cached.statusCode,
        headers,
      });
    }

    // Lock acquired — execute the request.
    // Re-inject body so downstream handlers can read it via c.req.json()/text().
    // Hono caches the parsed body internally — replace the raw Request with a fresh one.
    const freshRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: rawBody,
    });
    // Hono's HonoRequest wraps c.req.raw — replacing it lets downstream re-read the body.
    (c.req as { raw: Request }).raw = freshRequest;

    try {
      await next();
    } catch (err) {
      // On thrown error (including ApiError 4xx), release the lock so client can retry.
      // Thrown errors don't produce a c.res — they go through errorHandler which builds
      // a new Response. We can't cache that here, so releasing is the safe choice.
      await releaseIdempotencyLock(orgId, key);
      throw err;
    }

    const res = c.res;
    const statusCode = res.status;

    // Only cache 2xx and 4xx (deterministic). 5xx = release lock for retry.
    if (statusCode >= 500) {
      await releaseIdempotencyLock(orgId, key);
      return;
    }

    // Clone and read the response body for caching
    const cloned = res.clone();
    const resBody = await cloned.text();
    const resHeaders: Record<string, string> = {};
    cloned.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    await storeIdempotencyResult(orgId, key, {
      statusCode,
      headers: resHeaders,
      body: resBody,
      bodyHash,
    });
  };
}
