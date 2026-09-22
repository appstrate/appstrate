// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/openapi.json` — the live OpenAPI 3.1 document.
 *
 * Public and pre-auth by design (the CLI and Swagger UI both fetch it before
 * any credential exists), which is exactly why it must be cheap: the spec is
 * ~470 KiB of JSON and the endpoint is not rate-limited. Two properties make
 * it so:
 *
 *  - the serialization is computed ONCE per process (the spec is immutable
 *    once modules are initialized at boot), instead of re-running
 *    `JSON.stringify` over the whole document on every request;
 *  - the response carries a strong `ETag`, so a client that already has the
 *    document revalidates with `If-None-Match` and gets an empty `304`.
 *    `apps/cli` already sends the header — before this it could never hit.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { ifNoneMatchSatisfied } from "../lib/if-none-match.ts";

/**
 * @param getSpec - Returns the spec registered at boot (`getPlatformOperations().spec`).
 *   Called at most once per router instance, on the first request: the router
 *   is created before `registerPlatformApp()` runs.
 */
export function createOpenApiSpecRouter(getSpec: () => unknown) {
  const router = new Hono<AppEnv>();

  let payload: { body: string; etag: string } | null = null;
  const getPayload = () => {
    if (!payload) {
      const body = JSON.stringify(getSpec());
      const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32);
      payload = { body, etag: `"${digest}"` };
    }
    return payload;
  };

  router.get("/api/openapi.json", (c) => {
    const { body, etag } = getPayload();
    c.header("ETag", etag);
    // Always revalidate: the document changes across deployments, and the
    // ETag makes that check free for both sides.
    c.header("Cache-Control", "public, max-age=0, must-revalidate");
    if (ifNoneMatchSatisfied(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
    c.header("Content-Type", "application/json; charset=UTF-8");
    return c.body(body);
  });

  return router;
}
