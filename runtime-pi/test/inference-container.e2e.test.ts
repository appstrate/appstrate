// SPDX-License-Identifier: Apache-2.0

/**
 * Container e2e — one inference turn through the BUILT pi + sidecar pair.
 *
 * #1195 was not a code regression: it was a MISMATCHED IMAGE PAIR. pi-ai
 * compresses the Codex request body with zstd on the SSE path
 * (`content-encoding: zstd`), and a sidecar predating #1166 text-decoded that
 * body while buffering it, corrupting every byte above U+007F. Both halves
 * were individually correct; only their combination failed.
 *
 * No in-process test can see that. `sidecar/test/oauth-llm.test.ts` proves the
 * sidecar forwards bytes verbatim, and `pi-runner-transport.test.ts` proves the
 * runner reaches `/llm/codex/responses` over SSE — but both wire the two halves
 * together from ONE source tree, which is exactly the configuration that never
 * breaks. The version gap only exists between two built images, container to
 * container, so that is where this test lives.
 *
 * Shape: a stub platform on the host serves the run's sink + workspace routes,
 * the sidecar's `/internal/oauth-token/:id` read, and a stub Codex upstream
 * that records the request and answers a canned `response.completed`. The
 * agent container runs one turn against it and finalizes; we then assert what
 * arrived at the upstream — the request Pi signed, carried verbatim across the
 * container boundary with only the bearer swapped.
 *
 * Both containers reach the stub via `host.docker.internal`. In production the
 * agent's sink traffic rides the sidecar's forward proxy instead; that leg has
 * its own coverage and is deliberately not under test here.
 *
 * Gated exactly like `provision-container.e2e.test.ts`: `TEST_DOCKER=1`
 * locally, `CI=true` on GitHub Actions, and skipped unless BOTH images are
 * present and native. Build them with `bun run docker:build:runtime`, which is
 * the only command that stamps the pair with one revision.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { zstdDecompressSync } from "node:zlib";
import { SIDECAR_AUTH_HEADER } from "@appstrate/core/sidecar-types";
import {
  buildAgentBundle,
  codexPlaceholderJwt,
  docker,
  dockerRun,
  dumpContainerLogs,
  resolveContainerE2eGate,
} from "./helpers/container-e2e.ts";

const PI_IMAGE = process.env.PI_IMAGE ?? "appstrate-pi:latest";
const SIDECAR_IMAGE = process.env.SIDECAR_IMAGE ?? "appstrate-sidecar:latest";
const DEADLINE_MS = 120_000;

const { run: RUN, daemon } = resolveContainerE2eGate("inference-container.e2e", [
  PI_IMAGE,
  SIDECAR_IMAGE,
]);

const RID = "run_inference_e2e";
const MODEL_ID = "gpt-5-codex";
const ACCOUNT_ID = "acct_inference_e2e";
const CREDENTIAL_ID = "cred_inference_e2e";
const SINK_SECRET = "inference-e2e-secret-0123456789";
const SIDECAR_AUTH_TOKEN = "inference-e2e-sidecar-token";
const RUN_TOKEN = "inference-e2e-run-token";
/** What the sidecar must swap ONTO the request. Never enters the agent container. */
const REAL_ACCESS_TOKEN = "inference-e2e-real-subscription-bearer";
/** What the agent container carries as `MODEL_API_KEY`. Must never reach upstream. */
const PLACEHOLDER_JWT = codexPlaceholderJwt(ACCOUNT_ID);

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes: Uint8Array;
}

/**
 * The canned Codex SSE completion — enough for the Pi run loop to finish its
 * one turn and finalize `success`. Same frame as `pi-runner-transport.test.ts`.
 *
 * `output: []` is load-bearing, not just brevity: the sidecar advertises
 * `run_history` and `recall_memory` to the model (`runtime-pi/sidecar/mcp.ts`),
 * so a frame carrying a tool call would send the agent to
 * `GET /internal/run-history` or `/internal/memories`, which the stub below
 * deliberately does not serve — a surprise call must stay a failure, and it
 * shows up as the offending path in `unmatchedRequests`.
 */
function completedSseBody(): string {
  return `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_test",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        total_tokens: 2,
      },
    },
  })}\n\n`;
}

describe.skipIf(!RUN)("runtime-pi + sidecar images carry one inference turn verbatim", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const stamp = Date.now();
  const networkName = `appstrate-e2e-inference-net-${stamp}`;
  const sidecarName = `appstrate-e2e-inference-sidecar-${stamp}`;
  const piName = `appstrate-e2e-inference-pi-${stamp}`;

  const upstreamRequests: CapturedRequest[] = [];
  /** Anything the stub did not expect, so a surprising call shows up in the failure. */
  const unmatchedRequests: string[] = [];
  const finalizeBodies: string[] = [];
  let tokenReadAuthorization: string | undefined;

  beforeAll(async () => {
    const bundle = await buildAgentBundle("@e2e/inference-probe");
    server = Bun.serve({
      port: 0,
      // Bind all interfaces: on Linux the containers reach the stub via the
      // `host.docker.internal:host-gateway` IP, which a loopback-only bind
      // would not answer (Docker Desktop hides this on macOS; CI is Linux).
      hostname: "0.0.0.0",
      async fetch(req) {
        const path = new URL(req.url).pathname;

        // ─ Stub Codex upstream (what the sidecar re-originates against) ─
        if (path.startsWith("/upstream/")) {
          upstreamRequests.push({
            method: req.method,
            path,
            headers: Object.fromEntries(
              [...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]),
            ),
            bodyBytes: new Uint8Array(await req.arrayBuffer()),
          });
          return new Response(completedSseBody(), {
            headers: { "content-type": "text/event-stream" },
          });
        }

        // ─ Platform-internal: the sidecar resolves the real subscription bearer ─
        if (path.startsWith("/internal/oauth-token/")) {
          tokenReadAuthorization = req.headers.get("authorization") ?? undefined;
          return Response.json({
            accessToken: REAL_ACCESS_TOKEN,
            expiresAt: Date.now() + 3_600_000,
          });
        }

        // ─ Run sink + workspace, as the agent container expects them ─
        if (path.endsWith("/workspace")) {
          return new Response(bundle, { headers: { "content-type": "application/octet-stream" } });
        }
        if (path.endsWith("/files")) {
          return new Response(null, { status: 404 });
        }
        if (path.endsWith("/events/finalize")) {
          finalizeBodies.push(await req.text());
          return new Response(null, { status: 204 });
        }
        if (path.endsWith("/events") || path.endsWith("/events/heartbeat")) {
          return new Response(null, { status: 204 });
        }

        unmatchedRequests.push(`${req.method} ${path}`);
        return new Response(null, { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    docker(["rm", "-f", sidecarName, piName]);
    docker(["network", "rm", networkName]);
  });

  it(
    "delivers the signed Codex request to the upstream with the bearer swapped and the zstd body intact",
    async () => {
      const port = server!.port;
      const platformUrl = `http://host.docker.internal:${port}`;
      const sinkBase = `${platformUrl}/api/runs/${RID}`;

      const network = docker(["network", "create", networkName]);
      expect(network.status, `docker network create failed: ${network.stderr}`).toBe(0);

      try {
        const sidecar = dockerRun({
          name: sidecarName,
          image: SIDECAR_IMAGE,
          // Non-null whenever RUN is true; `dockerRun` pins it on the argv.
          platform: daemon,
          network: networkName,
          // The sidecar answers the agent on the DNS alias `sidecar`, exactly
          // as the platform's Docker orchestrator wires it in production.
          networkAlias: "sidecar",
          env: {
            PORT: "8080",
            RUN_ID: RID,
            RUN_TOKEN,
            PLATFORM_API_URL: platformUrl,
            SIDECAR_AUTH_TOKEN,
            PI_LLM_OAUTH_CONFIG_JSON: JSON.stringify({
              authMode: "oauth",
              baseUrl: `${platformUrl}/upstream`,
              credentialId: CREDENTIAL_ID,
            }),
            // Mandatory: `host.docker.internal` resolves into a private range,
            // so without this operator allowlist the sidecar's SSRF gate
            // answers 403 "Resolved OAuth base URL targets a blocked network
            // range" before any request leaves. The platform forwards the same
            // var in prod.
            EGRESS_ALLOW_INTERNAL_HOSTS: "host.docker.internal",
          },
        });
        expect(sidecar.status, `docker run sidecar failed: ${sidecar.stderr}`).toBe(0);

        const pi = dockerRun({
          name: piName,
          image: PI_IMAGE,
          platform: daemon,
          network: networkName,
          env: {
            AGENT_RUN_ID: RID,
            APPSTRATE_SINK_URL: `${sinkBase}/events`,
            APPSTRATE_SINK_FINALIZE_URL: `${sinkBase}/events/finalize`,
            APPSTRATE_SINK_SECRET: SINK_SECRET,
            MODEL_API: "openai-codex-responses",
            MODEL_ID,
            MODEL_PROVIDER: "codex",
            MODEL_BASE_URL: "http://sidecar:8080/llm",
            MODEL_API_KEY: PLACEHOLDER_JWT,
            SIDECAR_URL: "http://sidecar:8080",
            SIDECAR_AUTH_TOKEN,
            // Both the system prompt and the run's single user turn — no
            // `startMessage`, so the run is exactly one inference call.
            AGENT_PROMPT: "Stop immediately.",
          },
        });
        expect(pi.status, `docker run pi failed: ${pi.stderr}`).toBe(0);

        const start = Date.now();
        for (;;) {
          if (finalizeBodies.length > 0) break;
          if (Date.now() - start > DEADLINE_MS) {
            // Both containers' logs are appended by the `catch` below, which
            // covers every failure in here, not just this one.
            throw new Error(
              `run did not finalize within ${DEADLINE_MS}ms\n` +
                `upstream=${JSON.stringify(upstreamRequests.map((r) => `${r.method} ${r.path}`))}\n` +
                `unmatched=${JSON.stringify(unmatchedRequests)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        expect(unmatchedRequests).toEqual([]);
        expect(tokenReadAuthorization).toBe(`Bearer ${RUN_TOKEN}`);
        expect(upstreamRequests).toHaveLength(1);

        const request = upstreamRequests[0]!;
        expect(request.method).toBe("POST");
        // `resolveCodexUrl` appends `/codex/responses`; the sidecar maps
        // `/llm/codex/responses` onto `${llm.baseUrl}/codex/responses`.
        expect(request.path).toBe("/upstream/codex/responses");

        // The bearer swap: the real subscription token arrives, and the
        // placeholder the container carried appears in NO header at all.
        expect(request.headers.authorization).toBe(`Bearer ${REAL_ACCESS_TOKEN}`);
        expect(Object.values(request.headers).some((v) => v.includes(PLACEHOLDER_JWT))).toBe(false);

        // Pi's own Codex fingerprint, forwarded verbatim — the sidecar forges
        // none of it, it only passes it through.
        expect(request.headers["chatgpt-account-id"]).toBe(ACCOUNT_ID);
        expect(request.headers.originator).toBe("pi");
        expect(request.headers["openai-beta"]).toBe("responses=experimental");
        expect(request.headers.accept).toBe("text/event-stream");
        expect(request.headers["content-type"]).toStartWith("application/json");
        // Pi's own UA, `getPiUserAgent()`: `pi (<platform> <release>; <arch>)`,
        // or `pi (browser)` off Node. Assert the prefix rather than mere
        // presence — Bun's fetch supplies a `Bun/<version>` UA when a request
        // carries none, so `toBeTruthy()` would hold even had the header never
        // crossed the container boundary.
        expect(request.headers["user-agent"]).toStartWith("pi (");

        // The container→sidecar-only header must stop at the sidecar: the
        // agent's own auth token has no business reaching the model provider.
        // (Verified: a beta.51 sidecar really did leak it upstream.)
        expect(request.headers[SIDECAR_AUTH_HEADER]).toBeUndefined();

        // Pinned deliberately. zstd on the SSE path is the one thing the
        // subscription path does that nothing else does, and it is what #1195
        // corrupted. If a Pi bump stops compressing, this gate must go red so
        // the leg is re-examined consciously rather than quietly losing the
        // only coverage of it.
        expect(request.headers["content-encoding"]).toBe("zstd");

        // A successful decode + parse IS the byte-identity witness: zstd is a
        // framed binary format — magic number, frame descriptor, block headers —
        // and a text round-trip replaces every byte above U+007F, so a sidecar
        // that decodes the body as text (#1195) cannot produce anything
        // `zstdDecompressSync` accepts, let alone anything `JSON.parse` and the
        // field assertions behind it survive.
        const body = JSON.parse(zstdDecompressSync(request.bodyBytes).toString("utf8"));
        expect(body.model).toBe(MODEL_ID);
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        expect(typeof body.instructions).toBe("string");
        expect(body.instructions.length).toBeGreaterThan(0);
        expect(Array.isArray(body.input)).toBe(true);
        expect(body.input.length).toBeGreaterThan(0);

        // The turn actually completed — the canned SSE frame was parsed by the
        // real runner, not just accepted at the socket.
        const finalize = JSON.parse(finalizeBodies[0]!);
        expect(finalize.status).toBe("success");
      } catch (err) {
        // Every failure in here — a missed assertion as much as the deadline —
        // is a statement about what the two containers did, and the `finally`
        // below is about to delete them, so this is the last chance to read
        // their logs. Capped, because a boot loop can print megabytes.
        if (err instanceof Error) {
          err.message +=
            `\n\nsidecar logs:\n${dumpContainerLogs(sidecarName).slice(-3000)}` +
            `\n\npi logs:\n${dumpContainerLogs(piName).slice(-3000)}`;
        }
        throw err;
      } finally {
        docker(["rm", "-f", sidecarName, piName]);
        docker(["network", "rm", networkName]);
      }
    },
    DEADLINE_MS + 30_000,
  );
});
