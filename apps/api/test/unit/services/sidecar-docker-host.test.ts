// SPDX-License-Identifier: Apache-2.0

/**
 * DOCKER_HOST resolution for integration-carrying sidecars.
 *
 * When the platform's Docker endpoint is TCP (`DOCKER_SOCKET` =
 * `http(s)://…`, the socket-proxy hardening path), the sidecar must reach
 * the SAME endpoint — otherwise the proxy's verb filtering would gate the
 * platform's calls while the sidecar quietly kept a raw socket. The
 * endpoint travels as `DOCKER_HOST`, which the sidecar's `docker` CLI
 * already reads (`DOCKER_CLI_ENV_KEYS`). A unix-socket endpoint produces
 * no DOCKER_HOST: the socket bind plus the CLI's built-in default cover it.
 *
 * Reachability decides the hostname: with the platform on a Docker network
 * (the compose topology) the endpoint's hostname resolves for the sidecar
 * because it joins that network; with a bare-metal platform a loopback
 * endpoint would name the sidecar container itself, so it is rewritten to
 * `host.docker.internal` — the same host the platform's own fallback uses.
 */

import { describe, it, expect } from "bun:test";
import { resolveSidecarDockerHost } from "../../../src/services/orchestrator/docker-orchestrator.ts";

describe("resolveSidecarDockerHost", () => {
  it("unix endpoint → no DOCKER_HOST (the socket bind covers it)", () => {
    expect(resolveSidecarDockerHost("/var/run/docker.sock", true)).toBeUndefined();
    expect(resolveSidecarDockerHost("/var/run/docker.sock", false)).toBeUndefined();
  });

  it("TCP endpoint + platform on a network → forwarded verbatim", () => {
    expect(resolveSidecarDockerHost("http://appstrate-docker-proxy:2375", true)).toBe(
      "http://appstrate-docker-proxy:2375",
    );
  });

  it("TCP endpoint + bare-metal platform + non-loopback host → forwarded verbatim", () => {
    expect(resolveSidecarDockerHost("http://docker.lan:2375", false)).toBe(
      "http://docker.lan:2375",
    );
  });

  it("loopback endpoint + bare-metal platform → rewritten to the host gateway", () => {
    expect(resolveSidecarDockerHost("http://localhost:2375", false)).toBe(
      "http://host.docker.internal:2375",
    );
    expect(resolveSidecarDockerHost("http://127.0.0.1:2375", false)).toBe(
      "http://host.docker.internal:2375",
    );
  });

  it("loopback endpoint + platform on a network → NOT rewritten", () => {
    // On a network the platform already had to resolve the endpoint without
    // loopback; trusting it verbatim keeps one source of truth.
    expect(resolveSidecarDockerHost("http://localhost:2375", true)).toBe("http://localhost:2375");
  });

  it("no port → no port suffix injected", () => {
    expect(resolveSidecarDockerHost("http://localhost", false)).toBe("http://host.docker.internal");
  });

  it("a path survives the rewrite (daemon behind a path-routing reverse proxy)", () => {
    expect(resolveSidecarDockerHost("http://localhost:2375/docker", false)).toBe(
      "http://host.docker.internal:2375/docker",
    );
  });
});
