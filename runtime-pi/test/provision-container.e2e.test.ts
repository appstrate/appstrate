// SPDX-License-Identifier: Apache-2.0

/**
 * Container e2e — the ONLY layer that catches the document-provisioning spin.
 *
 * The original bug (`Bun.write(path, Response)` busy-looping at 100% CPU)
 * reproduces only in the BUNDLED runtime (`dist/entrypoint.js`), so no
 * source-level unit test can trigger it. This test runs the real
 * `appstrate-pi` image against a document-bearing run, with a self-contained
 * mock sink serving the AFPS bundle + one input document. The regression
 * assertion is simple and direct: with a document present, the container must
 * emit a boot event PAST provisioning ("workspace initialized") within the
 * deadline. The buggy build never gets there — it spins in `provisionDocuments`
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
import { zipArtifact } from "@appstrate/core/zip";
import {
  extractRootFromAfps,
  buildBundleFromCatalog,
  writeBundleToBuffer,
  emptyPackageCatalog,
} from "@appstrate/afps-runtime/bundle";

const IMAGE = process.env.PI_IMAGE ?? "appstrate-pi:latest";
const DEADLINE_MS = 60_000;

function hasDocker(): boolean {
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
/**
 * `os/arch` from a docker `--format` template (e.g. "linux/arm64"), or null
 * when the command fails (daemon down, image absent) or prints something
 * unexpected. Both templates below emit Go's GOOS/GOARCH vocabulary, so the
 * two results are directly comparable.
 */
function dockerPlatform(args: string[]): string | null {
  try {
    const out = spawnSync("docker", args, { encoding: "utf8" });
    if (out.status !== 0) return null;
    const platform = out.stdout.trim();
    return /^[a-z0-9]+\/[a-z0-9]+$/.test(platform) ? platform : null;
  } catch {
    return null;
  }
}
/** Platform the Docker engine runs containers on natively. */
function daemonPlatform(): string | null {
  return dockerPlatform(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
}
/** Platform the local image was built for, or null when the image is absent. */
function imagePlatform(): string | null {
  return dockerPlatform(["image", "inspect", IMAGE, "--format", "{{.Os}}/{{.Architecture}}"]);
}

// Opt-in gate: TEST_DOCKER=1 locally, CI=true on GitHub Actions (set
// automatically). Mirrors the rule in apps/api/test/helpers/tier.ts.
const dockerEnabled = process.env.TEST_DOCKER === "1" || process.env.CI === "true";

// The `docker run` below uses the engine's native platform, so the gate must
// check more than image presence: a bare `docker image inspect` is
// architecture-blind, and an image built for another platform (e.g. an amd64
// build left over on an Apple Silicon host) would pass it and then fail inside
// `docker run` with a misleading "pull access denied" (#882). Require the
// image's platform to match the daemon's and skip honestly otherwise.
const daemon = dockerEnabled && hasDocker() ? daemonPlatform() : null;
const image = daemon !== null ? imagePlatform() : null;
const RUN = daemon !== null && image === daemon;
if (dockerEnabled && !RUN) {
  const hint =
    image !== null && daemon !== null && image !== daemon
      ? ` — rebuild natively: docker build --platform ${daemon} -t ${IMAGE} -f runtime-pi/Dockerfile .`
      : "";
  console.warn(
    `[provision-container.e2e] skipped — docker=${hasDocker()} image(${IMAGE})=${image ?? "absent"} daemon=${daemon ?? "unknown"}${hint}`,
  );
}

/**
 * Minimal valid agent `.afps-bundle` (the multi-package archive with
 * `bundle.json` that the platform's `/workspace` route serves and the runtime
 * reads via `readBundleFromFile`). A raw single-package `.afps` is rejected
 * with `BUNDLE_JSON_MISSING`.
 */
async function buildAgentBundle(): Promise<Uint8Array> {
  const manifest = {
    name: "@e2e/provision-probe",
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Provision Probe",
    author: "e2e",
  };
  const afps = zipArtifact({
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    "prompt.md": new TextEncoder().encode("# probe\n\nStop immediately.\n"),
  });
  const root = extractRootFromAfps(afps);
  const bundle = await buildBundleFromCatalog(root, emptyPackageCatalog, { depTypes: ["skills"] });
  return writeBundleToBuffer(bundle);
}

describe.skipIf(!RUN)("runtime-pi container provisions documents without spinning", () => {
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
        if (p.endsWith("/documents")) {
          return Response.json({ documents: [{ name: "note.txt", size: docBytes.byteLength }] });
        }
        if (p.match(/\/documents\/[^/]+$/)) {
          // Chunked stream — same shape as the platform's document route.
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
    "emits a post-provisioning boot event with a document present",
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
        // The buggy build spins in provisionDocuments and never emits it.
        for (;;) {
          if (events.some((e) => e.includes("workspace initialized"))) break;
          if (Date.now() - start > DEADLINE_MS) {
            const logs = spawnSync("docker", ["logs", containerName], { encoding: "utf8" });
            throw new Error(
              `no post-provisioning event within ${DEADLINE_MS}ms — runtime likely spun in provisionDocuments.\nevents=${JSON.stringify(events).slice(0, 500)}\ncontainer logs:\n${(logs.stdout ?? "") + (logs.stderr ?? "")}`.slice(
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
