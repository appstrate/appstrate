// SPDX-License-Identifier: Apache-2.0

/**
 * Shared plumbing for the `runtime-pi` container e2e tests — the layer that
 * runs the BUILT images under the local Docker engine.
 *
 * Every such test needs the same five things, and getting any of them subtly
 * different is how a container e2e silently stops running: the opt-in gate
 * (docker present, images present, image platform == daemon platform, #882),
 * the `docker run` argv both suites launch containers with, a valid agent
 * `.afps-bundle` to serve from the mock `/workspace` route, the container-log
 * dump that makes a failure diagnosable, and the placeholder codex JWT a
 * subscription run carries. They live here so both suites share one definition.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
  const dockerPresent = dockerEnabled && hasDocker();
  const daemon = dockerPresent ? daemonPlatform() : null;
  // One `docker` process per image, so only probe when there is a daemon to
  // answer: with none, every inspect fails identically and the images are
  // unreachable by definition. Keeps a skipped suite at zero docker spawns.
  const platforms: { image: string; platform: string | null }[] =
    daemon === null
      ? images.map((image) => ({ image, platform: null }))
      : images.map((image) => ({ image, platform: imagePlatform(image) }));
  const run = daemon !== null && platforms.every(({ platform }) => platform === daemon);
  if (dockerEnabled && !run) {
    // Same remedy whether an image is absent or built for another platform:
    // build it natively. `docker:build:runtime` is the only command that builds
    // the pi + sidecar pair with one revision stamp.
    const hint =
      daemon !== null
        ? " — build natively: bun run docker:build:runtime (or, for one image," +
          ` docker build --platform ${daemon} -t <tag> -f <dockerfile> .)`
        : "";
    const seen = platforms
      .map(({ image, platform }) => `${image}=${platform ?? "absent"}`)
      .join(" ");
    console.warn(
      `[${label}] skipped — docker=${dockerPresent} ${seen} daemon=${daemon ?? "unknown"}${hint}`,
    );
  }
  return { run, daemon };
}

/** `docker` with string output. Every docker call in these suites goes here. */
export function docker(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("docker", args, { encoding: "utf8" });
}

export interface DockerRunOptions {
  /** `--name`, so `docker logs` and `docker rm -f` can reach the container. */
  name: string;
  image: string;
  /**
   * `--platform`. Explicit rather than omitted: a `DOCKER_DEFAULT_PLATFORM`
   * override would otherwise re-route the run to a foreign platform behind the
   * gate's back (#882). Null only when there is no daemon platform to pin,
   * which the gate makes unreachable from a running suite.
   */
  platform: string | null;
  /** `-e KEY=VALUE`, in insertion order. */
  env: Record<string, string>;
  /** `--network`, when the container shares a private network with a peer. */
  network?: string;
  /** `--network-alias`, the DNS name peers on {@link network} reach it by. */
  networkAlias?: string;
}

/**
 * `docker run -d` as both container e2e suites need it: detached, so no
 * long-lived child keeps Bun alive — each suite polls its own mock sink and
 * then `rm -f`s — and always with `--add-host
 * host.docker.internal:host-gateway`, which Docker Desktop adds by itself but a
 * Linux engine (CI) needs spelled out.
 */
export function dockerRun({
  name,
  image,
  platform,
  env,
  network,
  networkAlias,
}: DockerRunOptions): SpawnSyncReturns<string> {
  return docker([
    "run",
    "-d",
    "--name",
    name,
    ...(platform !== null ? ["--platform", platform] : []),
    ...(network !== undefined ? ["--network", network] : []),
    ...(networkAlias !== undefined ? ["--network-alias", networkAlias] : []),
    "--add-host",
    "host.docker.internal:host-gateway",
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image,
  ]);
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
  const logs = docker(["logs", containerName]);
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
