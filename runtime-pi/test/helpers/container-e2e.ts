// SPDX-License-Identifier: Apache-2.0

/**
 * Shared plumbing for the `runtime-pi` container e2e tests — the layer that
 * runs the BUILT images under the local Docker engine.
 *
 * Every such test needs the same three things, and getting any of them subtly
 * different is how a container e2e silently stops running: the opt-in gate
 * (docker present, images present, image platform == daemon platform, #882),
 * a valid agent `.afps-bundle` to serve from the mock `/workspace` route, and
 * the container-log dump that makes a deadline failure diagnosable. They live
 * here so both suites share one definition.
 */

import { spawnSync } from "node:child_process";
import { zipArtifact } from "@appstrate/core/zip";
import {
  extractRootFromAfps,
  buildBundleFromCatalog,
  writeBundleToBuffer,
  emptyPackageCatalog,
} from "@appstrate/afps-runtime/bundle";

/**
 * Opt-in gate: `TEST_DOCKER=1` locally, `CI=true` on GitHub Actions (set
 * automatically). Mirrors the rule in `apps/api/test/helpers/tier.ts`.
 */
const dockerEnabled = process.env.TEST_DOCKER === "1" || process.env.CI === "true";

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

/** Platform a local image was built for, or null when the image is absent. */
function imagePlatform(image: string): string | null {
  return dockerPlatform(["image", "inspect", image, "--format", "{{.Os}}/{{.Architecture}}"]);
}

interface ContainerE2eGate {
  /** Whether the suite may run: docker up, every image present and native. */
  run: boolean;
  /** The engine's native platform, non-null whenever {@link run} is true. */
  daemon: string | null;
}

/**
 * Decide whether a container e2e that needs `images` can run, and warn (once,
 * at import time) with an actionable hint when it cannot.
 *
 * The `docker run` calls in these suites use the engine's native platform, so
 * the gate must check more than image presence: a bare `docker image inspect`
 * is architecture-blind, and an image built for another platform (e.g. an
 * amd64 build left over on an Apple Silicon host) would pass it and then fail
 * inside `docker run` with a misleading "pull access denied" (#882). Require
 * every image's platform to match the daemon's and skip honestly otherwise.
 */
export function resolveContainerE2eGate(label: string, images: string[]): ContainerE2eGate {
  const daemon = dockerEnabled && hasDocker() ? daemonPlatform() : null;
  const platforms = images.map((image) => ({ image, platform: imagePlatform(image) }));
  const run = daemon !== null && platforms.every(({ platform }) => platform === daemon);
  if (dockerEnabled && !run) {
    const mismatched = daemon !== null && platforms.some(({ platform }) => platform !== null);
    const hint = mismatched
      ? " — rebuild natively: bun run docker:build:runtime (or, for one image," +
        ` docker build --platform ${daemon} -t <tag> -f <dockerfile> .)`
      : "";
    const seen = platforms
      .map(({ image, platform }) => `${image}=${platform ?? "absent"}`)
      .join(" ");
    console.warn(
      `[${label}] skipped — docker=${hasDocker()} ${seen} daemon=${daemon ?? "unknown"}${hint}`,
    );
  }
  return { run, daemon };
}

/**
 * Minimal valid agent `.afps-bundle` (the multi-package archive with
 * `bundle.json` that the platform's `/workspace` route serves and the runtime
 * reads via `readBundleFromFile`). A raw single-package `.afps` is rejected
 * with `BUNDLE_JSON_MISSING`.
 */
export async function buildAgentBundle(name = "@e2e/provision-probe"): Promise<Uint8Array> {
  const manifest = {
    name,
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

/** `docker logs` (stdout+stderr merged) for a container, for failure messages. */
export function dumpContainerLogs(containerName: string): string {
  const logs = spawnSync("docker", ["logs", containerName], { encoding: "utf8" });
  return (logs.stdout ?? "") + (logs.stderr ?? "");
}

/**
 * The `MODEL_API_KEY` a codex OAuth run carries inside the container: an
 * unsigned JWT whose only job is to let pi-ai read `chatgpt_account_id` off
 * the auth claim and stamp it on the request. The real bearer never enters the
 * container — the sidecar swaps it in. Same shape as
 * `packages/module-codex/src/index.ts`, hand-rolled because `@appstrate/module-codex`
 * is not a dependency of `runtime-pi`.
 */
export function codexPlaceholderJwt(accountId: string): string {
  const segment = (value: unknown): string =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return [
    segment({ alg: "none", typ: "JWT" }),
    segment({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    "placeholder",
  ].join(".");
}
