// SPDX-License-Identifier: Apache-2.0

/**
 * Container e2e — run-scoped secrets are not recoverable from inside the
 * agent container after boot, proven in the built image as the agent uid. The
 * stub model scripts the agent's tool calls ({@link TURNS}): `bash` dumping
 * every readable `/proc/<pid>/environ` and planting a fake `rg` first on PATH,
 * the `grep` tool (Pi spawns `rg` WITHOUT an explicit env, i.e. with the
 * runtime's startup environment), `bash` reading what the fake `rg` saw, and
 * `read` on `/proc/self/environ` and `/proc/1/environ`. Every tool result rides
 * the next request, so no secret may appear in any request body. A
 * `docker exec -u pi` probe covers any other same-uid process.
 * Gated like `inference-container.e2e.test.ts` (both images, native platform).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  buildAgentBundle,
  docker,
  dockerRun,
  dumpContainerLogs,
  resolveContainerE2eGate,
} from "./helpers/container-e2e.ts";

const PI_IMAGE = process.env.PI_IMAGE ?? "appstrate-pi:latest";
const SIDECAR_IMAGE = process.env.SIDECAR_IMAGE ?? "appstrate-sidecar:latest";
const DEADLINE_MS = 120_000;

const { run: RUN, daemon } = resolveContainerE2eGate("runtime-secrets-container.e2e", [
  PI_IMAGE,
  SIDECAR_IMAGE,
]);

const RID = "run_secrets_e2e";
const SINK_SECRET = "secrets-e2e-sink-secret-0123456789";
const SIDECAR_AUTH_TOKEN = "secrets-e2e-sidecar-token-0123456789";
const PLACEHOLDER = "sk-secrets-e2e-placeholder";
const SECRETS = [SINK_SECRET, SIDECAR_AUTH_TOKEN];

// Markers are computed by the shell, so they appear in tool OUTPUT only —
// never in an echoed command: PID 1's environment was refused, the fake `rg` ran.
const PID1_REFUSED_MARKER = "PID1_ENVIRON_REFUSED_42";
const FAKE_RG_RAN_MARKER = "FAKE_RG_RAN_42";
const RUNTIME_READONLY_MARKER = "RUNTIME_TREE_READONLY_42";
const FAKE_RG = "/opt/agent-venv/bin/rg";

// The runtime code the entrypoint process loads (bundle, node_modules, the
// transpiler cache it reads in place of source) and the directory Bun resolves
// its relative module paths against (the entrypoint's cwd) must be read-only to
// the agent uid — otherwise the agent could get code loaded INTO the process
// that holds the secrets. Marker emitted only when every path refuses a write.
const READONLY_PATHS = [
  "/runtime/dist/entrypoint.js",
  "/runtime/dist/launcher.js",
  "/runtime/dist", // the entrypoint's working directory
  "/runtime/.transpiler-cache",
  "/runtime/node_modules/@earendil-works",
];
const RUNTIME_READONLY_PROBE =
  READONLY_PATHS.map((p) => `[ -w ${p} ] && exit 0`).join("; ") +
  "; echo RUNTIME_TREE_READONLY_$((6*7))";

const TURNS: Array<[tool: string, input: Record<string, unknown>]> = [
  [
    "bash",
    {
      command:
        "cat /proc/1/environ || echo PID1_ENVIRON_REFUSED_$((6*7)); " +
        'for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f"; done; env; ' +
        `printf '#!/bin/sh\\necho FAKE_RG_RAN_$((6*7)) >> /workspace/rg-env\\nenv >> /workspace/rg-env\\n' > ${FAKE_RG}; ` +
        `chmod +x ${FAKE_RG}`,
    },
  ],
  ["grep", { pattern: "secrets-probe" }],
  ["bash", { command: "cat /workspace/rg-env" }],
  ["bash", { command: RUNTIME_READONLY_PROBE }],
  ["read", { path: "/proc/self/environ" }],
  ["read", { path: "/proc/1/environ" }],
];

/** Anthropic Messages SSE for one assistant turn. */
function anthropicSse(block: Record<string, unknown>, delta: Record<string, unknown>): string {
  const frames: Array<[string, Record<string, unknown>]> = [
    [
      "message_start",
      {
        message: {
          id: "msg_secrets_e2e",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-6",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    ["content_block_start", { index: 0, content_block: block }],
    ["content_block_delta", { index: 0, delta }],
    ["content_block_stop", { index: 0 }],
    [
      "message_delta",
      {
        delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn" },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", {}],
  ];
  return frames
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join("");
}

/** The stub model's answer to request `n` (0-based): the scripted turn, then "done". */
function turnSse(n: number): string {
  const turn = TURNS[n];
  if (!turn) return doneSse();
  const [name, input] = turn;
  return anthropicSse(
    { type: "tool_use", id: `toolu_secrets_e2e_${n}`, name, input: {} },
    { type: "input_json_delta", partial_json: JSON.stringify(input) },
  );
}

const doneSse = () =>
  anthropicSse({ type: "text", text: "" }, { type: "text_delta", text: "done" });

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!RUN)("runtime-pi keeps run-scoped secrets out of reach after boot", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const stamp = Date.now();
  const networkName = `appstrate-e2e-secrets-net-${stamp}`;
  const sidecarName = `appstrate-e2e-secrets-sidecar-${stamp}`;
  const piName = `appstrate-e2e-secrets-pi-${stamp}`;

  const upstreamBodies: string[] = [];
  const finalizeBodies: string[] = [];
  const unmatchedRequests: string[] = [];
  let execProbe: Promise<ExecResult> | undefined;

  beforeAll(async () => {
    const bundle = await buildAgentBundle("@e2e/secrets-probe");
    server = Bun.serve({
      port: 0,
      // All interfaces: on Linux the containers reach the stub via the
      // host-gateway IP (see inference-container.e2e.test.ts).
      hostname: "0.0.0.0",
      async fetch(req) {
        const path = new URL(req.url).pathname;

        if (path.startsWith("/upstream/")) {
          upstreamBodies.push(await req.text());
          if (upstreamBodies.length === 1) {
            // The model is being called: bootstrap is over. Probe from a
            // same-uid process that is not a descendant of the runtime, and
            // hold the turn until it is done so the container is still up.
            execProbe = (async () => {
              const proc = Bun.spawn(
                ["docker", "exec", "-u", "pi", piName, "cat", "/proc/1/environ"],
                {
                  stdout: "pipe",
                  stderr: "pipe",
                },
              );
              const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
              ]);
              return { exitCode, stdout, stderr };
            })();
            await execProbe;
          }
          const body = turnSse(upstreamBodies.length - 1);
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }

        if (path.endsWith("/workspace")) {
          return new Response(bundle, { headers: { "content-type": "application/octet-stream" } });
        }
        if (path.endsWith("/files")) return new Response(null, { status: 404 });
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
    "neither the bash tool nor another same-uid process can read the sink secret or sidecar token",
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
          platform: daemon,
          network: networkName,
          networkAlias: "sidecar",
          env: {
            PORT: "8080",
            FORWARD_PROXY_PORT: "8081",
            RUN_ID: RID,
            RUN_TOKEN: "secrets-e2e-run-token",
            PLATFORM_API_URL: platformUrl,
            SIDECAR_AUTH_TOKEN,
            PI_BASE_URL: `${platformUrl}/upstream`,
            PI_API_KEY: "secrets-e2e-upstream-key",
            PI_PLACEHOLDER: PLACEHOLDER,
            // `host.docker.internal` is a private address: without this the
            // sidecar refuses the upstream base URL.
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
            MODEL_API: "anthropic-messages",
            MODEL_ID: "claude-sonnet-4-6",
            MODEL_PROVIDER: "anthropic",
            MODEL_BASE_URL: "http://sidecar:8080/llm",
            MODEL_API_KEY: PLACEHOLDER,
            SIDECAR_URL: "http://sidecar:8080",
            SIDECAR_AUTH_TOKEN,
            AGENT_PROMPT: "Run the probe.",
          },
        });
        expect(pi.status, `docker run pi failed: ${pi.stderr}`).toBe(0);

        const start = Date.now();
        while (finalizeBodies.length === 0) {
          if (Date.now() - start > DEADLINE_MS) {
            throw new Error(
              `run did not finalize within ${DEADLINE_MS}ms\n` +
                `upstream calls=${upstreamBodies.length}\n` +
                `unmatched=${JSON.stringify(unmatchedRequests)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        expect(unmatchedRequests).toEqual([]);
        expect(upstreamBodies).toHaveLength(TURNS.length + 1);

        // Every scripted call actually ran (its own env printed, PID 1 refused,
        // the fake `rg` spawned by the grep tool) and no request carries a
        // secret. Last body = every tool result, so it is checked whole.
        const transcript = upstreamBodies.at(-1)!;
        expect(transcript).toContain(`AGENT_RUN_ID=${RID}`);
        expect(transcript).toContain(PID1_REFUSED_MARKER);
        expect(transcript).toContain(FAKE_RG_RAN_MARKER);
        expect(transcript).toContain(RUNTIME_READONLY_MARKER);
        for (const body of upstreamBodies) {
          for (const secret of SECRETS) expect(body).not.toContain(secret);
          expect(body).not.toContain("APPSTRATE_SINK_");
          expect(body).not.toContain("SIDECAR_AUTH_TOKEN");
        }

        const exec = await execProbe!;
        expect(exec.exitCode).not.toBe(0);
        expect(exec.stderr).toContain("Permission denied");
        for (const secret of SECRETS) expect(exec.stdout).not.toContain(secret);

        expect(JSON.parse(finalizeBodies[0]!).status).toBe("success");
      } catch (err) {
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
