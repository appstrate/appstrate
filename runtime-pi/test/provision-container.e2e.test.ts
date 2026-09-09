// SPDX-License-Identifier: Apache-2.0

/**
 * Container e2e — the ONLY layer that catches the file-provisioning spin.
 *
 * The original bug (`Bun.write(path, Response)` busy-looping at 100% CPU)
 * reproduces only in the BUNDLED runtime (`dist/entrypoint.js`), so no
 * source-level unit test can trigger it. This test runs the real
 * `appstrate-pi` image against a file-bearing run, with a self-contained
 * mock sink serving the AFPS bundle + one input file. The regression
 * assertion is simple and direct: with a file present, the container must
 * emit a boot event PAST provisioning ("workspace initialized") within the
 * deadline. The buggy build never gets there — it spins in `provisionFiles`
 * and is silent after "runtime starting".
 *
 * Gated: heavy DinD e2e (~11s), so it is opt-in locally — set `TEST_DOCKER=1`
 * (or use the root `bun run test:docker` script) to enable it; CI always runs
 * it (GitHub Actions sets `CI=true` automatically). Even when enabled, it
 * still skips if Docker or the `appstrate-pi` image is unavailable (local dev
 * without a built image, CI without the runtime image). The container runs on
 * the engine's native platform, so build the image natively:
 *   docker build -t appstrate-pi -f runtime-pi/Dockerfile .
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  buildAgentBundle,
  dumpContainerLogs,
  resolveContainerE2eGate,
} from "./helpers/container-e2e.ts";

const IMAGE = process.env.PI_IMAGE ?? "appstrate-pi:latest";
const DEADLINE_MS = 60_000;

const { run: RUN, daemon } = resolveContainerE2eGate("provision-container.e2e", [IMAGE]);

describe.skipIf(!RUN)("runtime-pi container provisions files without spinning", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let containerName: string | undefined;
  const SECRET = "container-e2e-secret-0123456789";
  const RID = "run_container_e2e";
  const events: string[] = [];

  beforeAll(async () => {
    const bundle = await buildAgentBundle();
    const docBytes = new TextEncoder().encode("the answer is 42\n");
    server = Bun.serve({
      port: 0,
      // Bind all interfaces: on Linux the container reaches the mock via the
      // `host.docker.internal:host-gateway` IP, which a loopback-only bind
      // would not answer (Docker Desktop's host-routing magic hides this on
      // macOS, but CI runs on Linux).
      hostname: "0.0.0.0",
      async fetch(req) {
        const u = new URL(req.url);
        const p = u.pathname;
        if (p.endsWith("/workspace")) {
          return new Response(bundle, { headers: { "content-type": "application/octet-stream" } });
        }
        if (p.endsWith("/files")) {
          return Response.json({ files: [{ name: "note.txt", size: docBytes.byteLength }] });
        }
        if (p.match(/\/files\/[^/]+$/)) {
          // Chunked stream — same shape as the platform's file route.
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(docBytes);
              c.close();
            },
          });
          return new Response(stream);
        }
        if (p.endsWith("/events") || p.endsWith("/events/finalize")) {
          events.push(await req.text());
          return new Response(null, { status: 204 });
        }
        // Model endpoint (reached only if provisioning succeeded) — fail fast.
        return new Response("{}", { status: 503 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (containerName) spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  });

  it(
    "emits a post-provisioning boot event with a file present",
    async () => {
      const port = server!.port;
      const host = `http://host.docker.internal:${port}/api/runs/${RID}`;
      containerName = `appstrate-e2e-provision-${Date.now()}`;
      // Detached: the container runs independently of this test process, so no
      // long-lived child keeps Bun alive. We poll the sink, then `rm -f`.
      const run = spawnSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          containerName,
          // Pin to the engine's native platform (which the gate above
          // guarantees the local image matches, mirroring how the platform's
          // Docker orchestrator launches this image in production). Explicit
          // rather than omitted: a DOCKER_DEFAULT_PLATFORM env override would
          // otherwise re-route the run to a foreign platform behind the
          // gate's back (#882). `daemon` is non-null whenever RUN is true.
          ...(daemon !== null ? ["--platform", daemon] : []),
          // Linux portability — Docker Desktop adds this automatically, but CI
          // engines need it explicit.
          "--add-host",
          "host.docker.internal:host-gateway",
          "-e",
          `AGENT_RUN_ID=${RID}`,
          "-e",
          `APPSTRATE_SINK_URL=${host}/events`,
          "-e",
          `APPSTRATE_SINK_FINALIZE_URL=${host}/events/finalize`,
          "-e",
          `APPSTRATE_SINK_SECRET=${SECRET}`,
          "-e",
          "MODEL_API=anthropic-messages",
          "-e",
          "MODEL_ID=claude-sonnet-4-6",
          "-e",
          `MODEL_BASE_URL=http://host.docker.internal:${port}/llm`,
          "-e",
          "MODEL_API_KEY=test",
          "-e",
          "AGENT_PROMPT=Stop immediately.",
          IMAGE,
        ],
        { encoding: "utf8" },
      );
      expect(run.status, `docker run failed: ${run.stderr}`).toBe(0);

      try {
        const start = Date.now();
        // Poll the collected sink events for the post-provisioning marker.
        // The buggy build spins in provisionFiles and never emits it.
        for (;;) {
          if (events.some((e) => e.includes("workspace initialized"))) break;
          if (Date.now() - start > DEADLINE_MS) {
            throw new Error(
              `no post-provisioning event within ${DEADLINE_MS}ms — runtime likely spun in provisionFiles.\nevents=${JSON.stringify(events).slice(0, 500)}\ncontainer logs:\n${dumpContainerLogs(containerName)}`.slice(
                0,
                1500,
              ),
            );
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(events.some((e) => e.includes("workspace initialized"))).toBe(true);
      } finally {
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      }
    },
    DEADLINE_MS + 15_000,
  );
});
