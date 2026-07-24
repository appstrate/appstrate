// SPDX-License-Identifier: Apache-2.0

/**
 * Typed Docker errors that warrant specific handling upstream.
 *
 * The Docker Engine returns plain text error bodies; callers that need to
 * react differently per failure mode (retry, user-facing remediation) must
 * classify by string. Centralising that mapping here keeps `docker.ts` a
 * thin HTTP wrapper and makes the classifier trivially unit-testable.
 */

/**
 * Raised when Docker refuses to create a new bridge network because the
 * default IPAM address pool is exhausted — Moby's `ErrNoMoreSubnets`
 * (`daemon/libnetwork/ipamapi/contract.go`). By default the pool splits
 * `172.17.0.0/12` into `/16` subnets, yielding ~31 networks per host; a
 * single Appstrate install holds several of them and every run consumes
 * one more, so busy hosts hit the ceiling well before they run out of
 * actual address space.
 *
 * The thrown message is user-facing: it includes both the quick fix
 * (`docker network prune`) and the permanent remediation (tune
 * `default-address-pools` in `daemon.json`).
 */
export class DockerAddressPoolExhaustedError extends Error {
  readonly code = "DOCKER_ADDRESS_POOL_EXHAUSTED" as const;

  constructor(dockerMessage?: string) {
    super(
      [
        "Docker's default address pool is exhausted — cannot create more bridge networks.",
        "",
        "Quick fix:   docker network prune",
        "Permanent:   configure `default-address-pools` in /etc/docker/daemon.json",
        "             (macOS/Windows: Docker Desktop → Settings → Docker Engine)",
        "             see examples/self-hosting/README.md#docker-network-pool-tuning",
      ].join("\n"),
    );
    this.name = "DockerAddressPoolExhaustedError";
    if (dockerMessage) this.cause = dockerMessage;
  }
}

/**
 * Inspect a Docker API network-create failure and return a typed error
 * when the daemon signalled pool exhaustion, `null` otherwise.
 *
 * The match is a substring check against the stable Moby constant
 * `ErrNoMoreSubnets` — `types.InvalidParameterErrorf` maps to HTTP 400
 * at the REST layer, so we gate on status too to avoid false positives
 * in pathological 500 bodies.
 */
export function classifyDockerNetworkError(
  status: number,
  body: string,
): DockerAddressPoolExhaustedError | null {
  if (status === 400 && body.includes("all predefined address pools have been fully subnetted")) {
    return new DockerAddressPoolExhaustedError(body);
  }
  return null;
}

/**
 * Detect Moby's "image is not present locally" failure on container create.
 *
 * `POST /containers/create` **never pulls**: a missing image comes back as
 * `404 {"message":"No such image: <ref>"}` (Moby
 * `daemon/container_operations.go` → `errdefs.NotFound`). The Docker CLI
 * implements create → 404 → pull → retry itself — that is precisely what
 * `docker run --pull=missing` (the default) means — so every direct Engine
 * API client has to reproduce it or inherit a container-create that breaks
 * the moment a host image prune runs.
 *
 * The match gates on **status 404 + the stable `No such image` prefix**
 * rather than the full message: the suffix varies by reference shape (tag
 * vs digest, `(tag: latest)` embellishment). Other 404s from the same
 * endpoint (notably an unknown network in `NetworkingConfig`) must NOT
 * match — pulling would not fix them.
 */
export function isMissingImageError(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    const message = (parsed as { message?: unknown }).message;
    return typeof message === "string" && message.startsWith("No such image");
  } catch {
    return false;
  }
}

/**
 * Create a container, healing a locally-missing image exactly once.
 *
 * The flow:
 *   1. Try to create the container.
 *   2. On a `No such image` 404, pull the image and retry — **once**.
 *   3. Any other response (including other 404s) is returned untouched so
 *      the caller's normal error path reports it verbatim.
 *
 * Why this exists: runtime images are only referenced by containers while a
 * run is in flight, so a host-level `docker image prune -a` (Coolify's
 * scheduled Docker cleanup, a disk-pressure sweep, an operator) reclaims
 * them between runs. Without this, every subsequent run fails with a bare
 * 404 until the API process restarts and re-runs its boot-time pre-pull.
 *
 * Deliberately **one** retry: a second `No such image` after a successful
 * pull means the reference itself is wrong (bad tag/digest/platform), not a
 * cold cache. Looping would convert a clear failure into a hang.
 *
 * The response body is inspected through `clone()` so the original response
 * stays unread for the caller's error handler.
 *
 * Dependencies are injected so this helper is trivially unit-testable
 * without touching the real Docker socket.
 */
export async function createContainerWithImagePull(
  createContainer: () => Promise<Response>,
  pullImage: () => Promise<void>,
  log: { warn: (msg: string, data?: Record<string, unknown>) => void } = {
    warn: () => {},
  },
): Promise<Response> {
  const res = await createContainer();
  // Fast path: only a 404 can be a missing image, so nothing else pays the
  // cost of buffering a response clone.
  if (res.status !== 404) return res;

  const body = await res.clone().text();
  if (!isMissingImageError(res.status, body)) return res;

  log.warn("Container image missing locally (pruned?) — pulling once and retrying", { body });
  await pullImage();
  return createContainer();
}

/**
 * Create a network with opportunistic recovery on pool exhaustion.
 *
 * The flow:
 *   1. Try to create the network.
 *   2. On `DockerAddressPoolExhaustedError`, reclaim orphan networks left
 *      by crashed runs.
 *   3. If cleanup freed at least one network, retry once. Otherwise the
 *      pool is genuinely full → re-throw the typed error so the user sees
 *      the remediation steps instead of a pointless retry.
 *
 * Any other error type is propagated unchanged. Dependencies are injected
 * so this helper is trivially unit-testable without touching the real
 * Docker socket.
 */
export async function createNetworkWithPoolRetry(
  createNetwork: () => Promise<string>,
  cleanupOrphanedNetworks: () => Promise<number>,
  log: { warn: (msg: string, data?: Record<string, unknown>) => void } = {
    warn: () => {},
  },
): Promise<string> {
  try {
    return await createNetwork();
  } catch (err) {
    if (!(err instanceof DockerAddressPoolExhaustedError)) throw err;
    log.warn("Docker address pool exhausted, attempting orphan network cleanup");
    const reclaimed = await cleanupOrphanedNetworks();
    log.warn("Orphan network cleanup complete", { reclaimed });
    if (reclaimed === 0) throw err;
    return await createNetwork();
  }
}
