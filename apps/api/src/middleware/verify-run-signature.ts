// SPDX-License-Identifier: Apache-2.0

/**
 * Run-sink authentication for the routes an agent process calls back on
 * (`POST /api/runs/:runId/events`, `/finalize`, and
 * `POST /api/runs/:runId/documents`).
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
 *   - 409 `message_replayed`      (upload guard only — see below)
 *   - 410 `run_sink_closed` | `run_sink_expired`
 *   - 429 `rate_limited`
 *   - 401 `missing_signature_headers` | `invalid_timestamp`
 *         | `timestamp_out_of_tolerance` | `invalid_signature`
 *
 * Error codes are stable wire contract — do not rename without a deprecation.
 *
 * ## Ordering
 *
 * Signature verification comes FIRST on every run-HMAC route, before any
 * per-run limiter: those limiters key on the `:runId` from the URL, so
 * running them first would let anyone who merely knows a runId burn a
 * legitimate run's ingestion budget with unsigned requests. What guards the
 * pre-authentication work instead is the coarse, per-IP FAILURE budget below
 * (`assertRunSinkAuthBudget` / `recordRunSinkAuthFailure`) — it charges only
 * rejected attempts, so signed traffic from a NAT'd fleet of runners is never
 * throttled while a flood of random runIds is capped.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";
import { conflict, invalidRequest, notFound } from "../lib/errors.ts";
import { getCache } from "../infra/index.ts";
import { assertRunSinkAuthBudget, recordRunSinkAuthFailure } from "./rate-limit.ts";
import {
  assertSinkOpen,
  getRunSinkContext,
  verifyRunSignatureHeaders,
} from "../services/run-event-ingestion.ts";

/**
 * Key prefix for the upload guard's `webhook-id` single-use claim. Distinct
 * from the event pipeline's replay namespace (`ingestRunEvent`) on purpose:
 * the two surfaces have different semantics (an event replay is an idempotent
 * 200, an upload replay is a refusal) and must not be able to consume each
 * other's message ids.
 */
const UPLOAD_REPLAY_KEY_PREFIX = "appstrate:run-upload:replay:";

/**
 * Build a run-authentication middleware: resolve the run sink from `:runId`,
 * fast-reject a closed sink, and verify the Standard Webhooks HMAC over the body
 * `readBody` returns. Both the event-ingestion guard (signs the raw JSON body)
 * and the streaming document-upload guard (signs an EMPTY body) are this factory
 * with a different `readBody` — the only real difference between them.
 *
 * `exposeWebhookId` sets `c.get("webhookId")` for the event handler's replay
 * dedup; the upload path never reads it, so it is left unset there.
 *
 * `consumeMsgId` claims the `webhook-id` here, in the guard, so the header set
 * authenticates exactly one request — required wherever the signature does not
 * cover the body (see {@link verifyRunUploadSignature}).
 */
function makeRunSignatureGuard(
  readBody: (c: Context<AppEnv>) => Promise<string>,
  opts: { exposeWebhookId?: boolean; consumeMsgId?: boolean } = {},
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // Cheapest check first: a client that has already burned its failed-auth
    // budget is rejected before the DB is touched at all.
    await assertRunSinkAuthBudget(c);

    let authenticated = false;
    try {
      const runId = c.req.param("runId");
      if (!runId) throw invalidRequest("runId path parameter is required", "runId");

      const run = await getRunSinkContext(runId);
      if (!run) throw notFound(`run ${runId} not found`);

      // Fast-path rejection on a SNAPSHOT — a concurrent finalize can still close
      // the sink between this read and the handler's write. The authoritative
      // gate is the ingestion CAS (`persistEventAndAdvance` includes
      // `sink_closed_at IS NULL` in its WHERE) which surfaces the same 410.
      assertSinkOpen(run);

      verifyRunSignatureHeaders({
        run,
        signatureHeader: c.req.header("webhook-signature") ?? "",
        msgIdHeader: c.req.header("webhook-id") ?? "",
        timestampHeader: c.req.header("webhook-timestamp") ?? "",
        body: await readBody(c),
      });

      if (opts.consumeMsgId) await claimMsgId(run.id, c.req.header("webhook-id")!);

      authenticated = true;
      c.set("run", run);
      if (opts.exposeWebhookId) c.set("webhookId", c.req.header("webhook-id")!);
    } finally {
      if (!authenticated) await recordRunSinkAuthFailure(c);
    }

    await next();
  });
}

/**
 * Claim `msgId` for `runId` exactly once within the replay window. Throws 409
 * `message_replayed` when the same id comes back.
 *
 * `REMOTE_RUN_REPLAY_WINDOW_SECONDS` is env-validated to be strictly greater
 * than `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, so a captured header set can
 * never outlive its claim: by the time the claim expires the timestamp is
 * already out of tolerance.
 *
 * The claim is NOT released on a downstream failure. Unlike the event sink
 * (whose runner retries an in-flight envelope with the SAME `webhook-id`, so
 * `ingestRunEvent` must release the key for the retry to land), the document
 * uploader signs a fresh `randomUUID()` per attempt — see
 * `runtime-pi/publish.ts` — so a retry after any failure carries a new id and
 * is unaffected.
 */
async function claimMsgId(runId: string, msgId: string): Promise<void> {
  const cache = await getCache();
  const claimed = await cache.set(`${UPLOAD_REPLAY_KEY_PREFIX}${runId}:${msgId}`, "1", {
    ttlSeconds: getEnv().REMOTE_RUN_REPLAY_WINDOW_SECONDS,
    nx: true,
  });
  if (!claimed) {
    throw conflict("message_replayed", `webhook-id ${msgId} was already used for run ${runId}`);
  }
}

/**
 * `POST /api/runs/:runId/events` and `/finalize` — the HMAC signs the raw body
 * bytes (not a JSON re-serialisation), and the `webhook-id` is exposed for the
 * handler's replay dedup (`ingestRunEvent` owns the claim there, because it
 * also owns the release-on-error the runner's same-id retry depends on).
 */
export const verifyRunSignature = makeRunSignatureGuard(
  async (c) => new TextDecoder().decode(await c.req.raw.clone().arrayBuffer()),
  { exposeWebhookId: true },
);

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
 *
 * Because the body is unsigned, ONE captured header set would otherwise
 * authenticate an unbounded number of arbitrary bodies within the timestamp
 * tolerance — each replay spending the org's storage quota and the run's
 * document budget, and each with DIFFERENT content (so the `(run, sha256,
 * name)` dedup does not absorb them). The `webhook-id` claim above closes
 * that: the header set authenticates exactly one request, matching what the
 * `/events` path already gets from body-signing plus its own replay cache.
 */
export const verifyRunUploadSignature = makeRunSignatureGuard(async () => "", {
  consumeMsgId: true,
});
