// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/runs/:runId/events` and `/finalize` authentication.
 *
 * These routes are called from agent processes that hold no user session —
 * the authentic principal is the **run itself**. Proof of authenticity is
 * a Standard Webhooks HMAC-SHA256 signature over the request body, keyed
 * on the run's ephemeral secret (AES-256-GCM encrypted at rest, decrypted
 * per-request via `@appstrate/connect.decrypt`).
 *
 * Post-middleware the handler reads:
 *   - `c.get("run")`       → {@link RunSinkContext} (org/app/id, sink state)
 *   - `c.get("webhookId")` → `webhook-id` header, used for replay dedup
 *
 * On failure this throws {@link ApiError} with one of the codes:
 *   - 400 `missing_run_id`
 *   - 404 `run_not_found`
 *   - 410 `run_sink_closed` | `run_sink_expired`
 *   - 401 `missing_signature_headers` | `invalid_timestamp`
 *         | `timestamp_out_of_tolerance` | `invalid_signature`
 *
 * Error codes are stable wire contract — do not rename without a deprecation.
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types/index.ts";
import { invalidRequest, notFound } from "../lib/errors.ts";
import {
  assertSinkOpen,
  getRunSinkContext,
  verifyRunSignatureHeaders,
} from "../services/run-event-ingestion.ts";

export const verifyRunSignature = createMiddleware<AppEnv>(async (c, next) => {
  const runId = c.req.param("runId");
  if (!runId) throw invalidRequest("runId path parameter is required", "runId");

  const run = await getRunSinkContext(runId);
  if (!run) throw notFound(`run ${runId} not found`);

  assertSinkOpen(run);

  // Raw body bytes — the HMAC signs the bytes, not a JSON re-serialisation.
  const bodyBytes = await c.req.raw.clone().arrayBuffer();
  const bodyString = new TextDecoder().decode(bodyBytes);

  verifyRunSignatureHeaders({
    run,
    signatureHeader: c.req.header("webhook-signature") ?? "",
    msgIdHeader: c.req.header("webhook-id") ?? "",
    timestampHeader: c.req.header("webhook-timestamp") ?? "",
    body: bodyString,
  });

  c.set("run", run);
  c.set("webhookId", c.req.header("webhook-id")!);
  await next();
});
