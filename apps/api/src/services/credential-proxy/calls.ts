// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-call envelope for the credential proxy: N independent upstream calls
 * in one HTTP request to `/api/credential-proxy/calls`.
 *
 * Provider-agnostic by construction. The envelope is NOT a provider batch
 * protocol: each call goes through {@link proxyCall} exactly as a call to
 * `/proxy` does — same integration allowlist, same credential injection, same
 * egress guard, same 401 refresh-and-retry. There is no second authorization
 * path, so a call the allowlist refuses on `/proxy` is refused here, and
 * the other calls of the envelope are unaffected.
 *
 * Scope: one integration, one connection selection and one session for the
 * whole envelope (they ride in the request headers, like `/proxy`).
 */

import { z } from "zod";
import { stripUpstreamResponseHeaders } from "@appstrate/connect/proxy-primitives";
import { ApiError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { proxyProblem } from "../../lib/proxy-status.ts";
import { bodyReadError, proxyCall, ProxyCallError } from "./core.ts";
import { CALLER_RESPONSE_SKIP_HEADERS, PROXY_CONTROL_HEADERS } from "./headers.ts";

/** Calls in flight at once for one envelope. */
const CALLS_CONCURRENCY = 5;

/**
 * No call STARTS after this much time in the envelope. A started call is bounded by the
 * outbound timeout (30 s), so the whole request stays under a 60 s reverse-proxy idle cut.
 */
const START_DEADLINE_MS = 25_000;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const callSchema = z
  .object({
    /** Caller-chosen label echoed in the result; defaults to the call's index. */
    id: z
      .string()
      .regex(/^[\w.:-]{1,64}$/)
      .optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    target: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    /** UTF-8 request body (POST, PUT, PATCH). */
    body: z.string().optional(),
  })
  .strict()
  .refine((c) => c.body === undefined || BODY_METHODS.has(c.method), {
    message: "body is only allowed with POST, PUT and PATCH",
    path: ["body"],
  });

export const callsRequestSchema = z
  .object({ calls: z.array(callSchema).min(1) })
  .strict()
  .superRefine((req, ctx) => {
    const seen = new Set<string>();
    req.calls.forEach((call, i) => {
      if (call.id === undefined) return;
      if (seen.has(call.id)) {
        ctx.addIssue({ code: "custom", message: "duplicate call id", path: ["calls", i, "id"] });
      }
      seen.add(call.id);
    });
  });

type Call = z.infer<typeof callSchema>;

/** A call answered by the upstream: its status, headers and body, as `/proxy` would relay them. */
interface UpstreamCallResult {
  id: string;
  status: number;
  headers: Record<string, string>;
  /** UTF-8 text, or base64 when the upstream body is not valid UTF-8. */
  body: string | null;
  body_encoding: "utf8" | "base64";
  /** True when the body was cut at the per-call response cap. */
  truncated?: true;
}

/** A call the platform refused, could not complete, or did not start. */
interface RefusedCallResult {
  id: string;
  /** The HTTP status `/proxy` would have answered with for the same call. */
  status: number;
  error: { code: string; message: string };
}

type CallResult = UpstreamCallResult | RefusedCallResult;

/** One call's outcome, with the connection whose credential it may have carried (for audit). */
export interface CallOutcome {
  result: CallResult;
  connectionId?: string;
}

type ProxyCallInput = Parameters<typeof proxyCall>[0];

interface ExecuteCallsInput {
  calls: Call[];
  /** Fields shared by every call: org, space, actor, integration, connection pin, run, cookie jar. */
  common: Pick<
    ProxyCallInput,
    | "orgId"
    | "spaceId"
    | "actor"
    | "integrationId"
    | "connectionId"
    | "run"
    | "cookieJar"
    | "jarSessionId"
    | "cookieJarTtlSeconds"
  >;
  /** Response bytes allowed for the whole envelope; each call may use an equal share. */
  maxResponseBytes: number;
  /** Test seams. */
  proxy?: typeof proxyCall;
  startDeadlineMs?: number;
}

/**
 * Run the calls with bounded concurrency; outcomes come back in request order.
 *
 * The first call runs alone: a failure that is not about its target (no reachable
 * connection, several to choose from, integration inactive, unusable credential) would
 * repeat identically on every call, so it is thrown for the whole envelope, with the same
 * problem `/proxy` answers (`candidate_connections` included).
 */
export async function executeCalls(input: ExecuteCallsInput): Promise<CallOutcome[]> {
  const { calls, common, proxy = proxyCall, startDeadlineMs = START_DEADLINE_MS } = input;
  const perCallCap = Math.max(1, Math.floor(input.maxResponseBytes / calls.length));
  const startedAt = Date.now();
  const outcomes: CallOutcome[] = new Array(calls.length);

  // The cap holds on what the envelope SENDS: base64 and JSON escaping can grow an upstream body
  // several times (a control byte becomes `\u0001`), so the per-call byte cap alone is not enough.
  let encodedBytes = 0;
  const withinBudget = (outcome: CallOutcome): CallOutcome => {
    const size = Buffer.byteLength(JSON.stringify(outcome.result));
    if (encodedBytes + size <= input.maxResponseBytes) {
      encodedBytes += size;
      return outcome;
    }
    const result = { ...outcome.result, body: null, truncated: true as const };
    encodedBytes += Buffer.byteLength(JSON.stringify(result));
    return { ...outcome, result };
  };

  const run = async (index: number, firstCall: boolean): Promise<void> => {
    const call = calls[index]!;
    const id = call.id ?? String(index);
    if (!firstCall && Date.now() - startedAt > startDeadlineMs) {
      outcomes[index] = {
        result: {
          id,
          status: 503,
          error: {
            code: "not_attempted",
            message: "Not sent: the envelope ran out of time. Nothing reached the upstream.",
          },
        },
      };
      return;
    }
    try {
      outcomes[index] = withinBudget(await runCall(id, call, common, perCallCap, proxy));
    } catch (err) {
      // Rethrown as-is: the route maps it like `/proxy`, auditing a connection already used.
      if (firstCall && isEnvelopeLevel(err)) throw err;
      outcomes[index] = refusal(id, err, common.integrationId);
    }
  };

  await run(0, true);
  let next = 1;
  const worker = async () => {
    while (next < calls.length) await run(next++, false);
  };
  await Promise.all(Array.from({ length: Math.min(CALLS_CONCURRENCY, calls.length - 1) }, worker));
  return outcomes;
}

/** A failure about the connection or the integration, not about one call's target. */
function isEnvelopeLevel(err: unknown): boolean {
  if (err instanceof ApiError) return true;
  return (
    err instanceof ProxyCallError &&
    (err.code === "credential_not_found" || err.code === "credential_unusable")
  );
}

async function runCall(
  id: string,
  call: Call,
  common: ExecuteCallsInput["common"],
  maxResponseBytes: number,
  proxy: typeof proxyCall,
): Promise<CallOutcome> {
  const res = await proxy({
    ...common,
    method: call.method,
    target: call.target,
    // Same filter as `/proxy`: control headers and the caller's `Authorization` never go upstream.
    headers: Object.fromEntries(
      Object.entries(call.headers ?? {}).filter(
        ([k]) => !PROXY_CONTROL_HEADERS.has(k.toLowerCase()),
      ),
    ),
    body: call.body ?? null,
    maxResponseBytes,
  });

  let bytes: Uint8Array | null = null;
  if (res.body) {
    try {
      bytes = new Uint8Array(await new Response(res.body).arrayBuffer());
    } catch (err) {
      // A read failing after the headers is the upstream's, never the proxy's own 500.
      throw Object.assign(bodyReadError(err, res.redactedHost), { connectionId: res.connectionId });
    }
  }
  const headers: Record<string, string> = {};
  stripUpstreamResponseHeaders(res.headers, CALLER_RESPONSE_SKIP_HEADERS).forEach((v, k) => {
    headers[k] = v;
  });

  let body: string | null = null;
  let bodyEncoding: "utf8" | "base64" = "utf8";
  if (bytes) {
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      body = Buffer.from(bytes).toString("base64");
      bodyEncoding = "base64";
    }
  }
  return {
    connectionId: res.connectionId,
    result: {
      id,
      status: res.status,
      headers,
      body,
      body_encoding: bodyEncoding,
      ...(res.truncated ? { truncated: true as const } : {}),
    },
  };
}

/** Same classification as the `/proxy` route's catch, as data instead of a thrown HTTP error. */
function refusal(id: string, err: unknown, integrationId: string): CallOutcome {
  if (err instanceof ApiError) {
    return { result: { id, status: err.status, error: { code: err.code, message: err.message } } };
  }
  if (err instanceof ProxyCallError) {
    const problem = proxyProblem(err.code, err.message);
    return {
      result: { id, status: problem.status, error: { code: err.code, message: err.message } },
      ...(err.connectionId ? { connectionId: err.connectionId } : {}),
    };
  }
  logger.error("credential-proxy: unexpected failure", {
    integrationId,
    // The name only: a runtime error (`Headers`, URL parsing) may quote a credential value.
    error: err instanceof Error ? err.name : typeof err,
  });
  return {
    result: { id, status: 500, error: { code: "internal_error", message: "Internal error" } },
  };
}
