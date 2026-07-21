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

  // Fast-path rejection on a SNAPSHOT — a concurrent finalize can still close
  // the sink between this read and the handler's write. The authoritative
  // gate is the ingestion CAS (`persistEventAndAdvance` includes
  // `sink_closed_at IS NULL` in its WHERE) which surfaces the same 410.
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

/**
 * Signature guard for the streaming document-ingestion POST
 * (`POST /api/runs/:runId/documents`). Identical run-authentication to
 * {@link verifyRunSignature} — Standard Webhooks HMAC over the run secret —
 * but the HMAC is verified over an EMPTY body, exactly like the run's signed
 * workspace/documents GET provisioning fetches (see `runtime-pi/provision.ts`).
 *
 * The document bytes are therefore NOT part of the signature, which is
 * deliberate: buffering the whole (up to 100 MiB) file to re-hash it for the
 * HMAC would defeat the streaming ingestion the route is built for. The run
 * secret authenticates the caller as the run; the body's integrity is captured
 * by the server-computed sha256 returned to the caller. The request body is
 * left completely untouched so the handler can stream it straight to storage.
 */
export const verifyRunUploadSignature = createMiddleware<AppEnv>(async (c, next) => {
  const runId = c.req.param("runId");
  if (!runId) throw invalidRequest("runId path parameter is required", "runId");

  const run = await getRunSinkContext(runId);
  if (!run) throw notFound(`run ${runId} not found`);

  assertSinkOpen(run);

  verifyRunSignatureHeaders({
    run,
    signatureHeader: c.req.header("webhook-signature") ?? "",
    msgIdHeader: c.req.header("webhook-id") ?? "",
    timestampHeader: c.req.header("webhook-timestamp") ?? "",
    body: "",
  });

  c.set("run", run);
  c.set("webhookId", c.req.header("webhook-id")!);
  await next();
});
