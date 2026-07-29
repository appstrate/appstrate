// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run sidecar DNS alias — shape, uniqueness, and endpoint round-trip.
 *
 * The Docker backend publishes the sidecar on the run's bridge network under
 * an unguessable per-run alias instead of the historical cross-run constant
 * `sidecar`. Two properties have to hold or runs break outright:
 *
 *   1. The alias must be a legal RFC 1123 host label, or `connectContainerToNetwork`
 *      is rejected by the daemon and Docker's embedded DNS never publishes it.
 *   2. The four `SidecarEndpoints` fields, the network alias attached to the
 *      container, and the `SIDECAR_DNS_ALIAS` the sidecar is told about itself
 *      must all name the SAME host. They are derived from one alias
 *      (`buildDockerSidecarEndpoints`) and recovered from the boundary
 *      (`sidecarAliasOf`), so this test pins the round-trip: nothing can update
 *      one use and silently leave another pointing at a dead name.
 *
 * Pure helpers — no Docker daemon, no DB. Same posture as
 * `sidecar-socket-gating.test.ts`, which unit-tests the other extracted
 * `DockerOrchestrator` helper.
 */

import { describe, it, expect } from "bun:test";
import {
  generateSidecarAlias,
  buildDockerSidecarEndpoints,
  sidecarAliasOf,
} from "../../../src/services/orchestrator/docker-orchestrator.ts";
import type { IsolationBoundary } from "@appstrate/core/platform-types";

/**
 * RFC 1123 host label: 1-63 chars from `[a-z0-9-]`, must not start or end
 * with a hyphen. We additionally require a non-digit first character (RFC 1123
 * relaxed RFC 952 here, but a leading digit still trips resolvers that treat a
 * fully-numeric first label as an IP fragment).
 */
const RFC_1123_LABEL = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function boundaryWith(
  endpoints: ReturnType<typeof buildDockerSidecarEndpoints>,
): IsolationBoundary {
  return {
    id: "net_test",
    name: "appstrate-exec-run_test",
    workspace: { kind: "volume", name: "appstrate-ws-run_test" },
    sidecarEndpoints: endpoints,
  };
}

describe("generateSidecarAlias — DNS label validity", () => {
  it("produces a valid RFC 1123 label: lowercase alphanumeric, no leading digit, no edge hyphen", () => {
    for (let i = 0; i < 200; i++) {
      const alias = generateSidecarAlias();
      expect(alias).toMatch(RFC_1123_LABEL);
      expect(alias.startsWith("-")).toBe(false);
      expect(alias.endsWith("-")).toBe(false);
      expect(/^[0-9]/.test(alias)).toBe(false);
      expect(alias).toBe(alias.toLowerCase());
    }
  });

  it("stays within the 63-char single-label limit (and is long enough to be unguessable)", () => {
    const alias = generateSidecarAlias();
    expect(alias.length).toBeLessThanOrEqual(63);
    expect(alias.length).toBeGreaterThanOrEqual(24);
  });

  it("is a valid URL hostname (it is embedded in every endpoint URL)", () => {
    const alias = generateSidecarAlias();
    expect(new URL(`http://${alias}:8080`).hostname).toBe(alias);
  });
});

describe("generateSidecarAlias — per-run uniqueness", () => {
  it("two consecutive calls differ", () => {
    expect(generateSidecarAlias()).not.toBe(generateSidecarAlias());
  });

  it("500 calls are all distinct (no shared constant, no reused seed)", () => {
    const aliases = new Set(Array.from({ length: 500 }, () => generateSidecarAlias()));
    expect(aliases.size).toBe(500);
  });
});

describe("buildDockerSidecarEndpoints ↔ sidecarAliasOf — round-trip", () => {
  it("recovers the exact alias the endpoints were built from", () => {
    const alias = generateSidecarAlias();
    expect(sidecarAliasOf(boundaryWith(buildDockerSidecarEndpoints(alias)))).toBe(alias);
  });

  it("derives all four endpoint fields from the one alias", () => {
    const alias = generateSidecarAlias();
    const endpoints = buildDockerSidecarEndpoints(alias);

    expect(endpoints).toEqual({
      sidecarUrl: `http://${alias}:8080`,
      llmProxyUrl: `http://${alias}:8080/llm`,
      forwardProxyUrl: `http://${alias}:8081`,
      noProxy: `${alias},localhost,127.0.0.1`,
    });

    // Nothing still carries the historical constant, and every field names the
    // same host the container will actually answer to.
    for (const value of Object.values(endpoints)) {
      expect(value).toContain(alias);
      expect(value).not.toContain("//sidecar:");
    }
    expect(new URL(endpoints.llmProxyUrl).hostname).toBe(alias);
    expect(new URL(endpoints.forwardProxyUrl).hostname).toBe(alias);
    expect(endpoints.noProxy.split(",")[0]).toBe(alias);
  });

  it("keeps two boundaries independent — one run's alias never leaks into another's endpoints", () => {
    const first = buildDockerSidecarEndpoints(generateSidecarAlias());
    const second = buildDockerSidecarEndpoints(generateSidecarAlias());

    const firstAlias = sidecarAliasOf(boundaryWith(first));
    const secondAlias = sidecarAliasOf(boundaryWith(second));

    expect(firstAlias).not.toBe(secondAlias);
    expect(second.noProxy).not.toContain(firstAlias);
    expect(second.forwardProxyUrl).not.toContain(firstAlias);
  });
});
