// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run sidecar DNS alias — shape, uniqueness, and the same-host invariant.
 *
 * Two properties have to hold or runs break outright:
 *
 *   1. The alias must be a legal RFC 1123 host label, or
 *      `connectContainerToNetwork` is rejected by the daemon.
 *   2. The four `SidecarEndpoints` fields the agent is handed, the network
 *      alias the container is published under, and the `SIDECAR_DNS_ALIAS` the
 *      sidecar is told about itself must all name the SAME host. The agent's
 *      `Host` is `<network alias>:8080` and the sidecar's guard compares it
 *      against `SIDECAR_DNS_ALIAS`, so a divergence 403s every `/mcp` call.
 *
 * (2) is proven at `sidecarAliasOverrides`, the single function `createSidecar`
 * calls for BOTH destinations. That `createSidecar` still routes them onward
 * is only observable against a live daemon and stays a call-site read.
 *
 * Pure helpers — no Docker daemon, no DB.
 */

import { describe, it, expect } from "bun:test";
import {
  generateSidecarAlias,
  buildDockerSidecarEndpoints,
  dockerSidecarAliasOf,
  sidecarAliasOverrides,
} from "../../../src/services/orchestrator/docker-orchestrator.ts";
import type { IsolationBoundary } from "@appstrate/core/platform-types";

/**
 * RFC 1123 host label, plus a non-digit first character: RFC 1123 relaxed that
 * from RFC 952, but a leading digit still trips resolvers that read a
 * fully-numeric first label as an IP fragment.
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

  it("is exactly 33 chars — inside the 63-char single-label limit", () => {
    // `s` + a hyphen-stripped UUIDv4. Pinned exactly, not as a range, so any
    // change to the shape (and to the 122 bits of entropy) fails here.
    expect(generateSidecarAlias()).toHaveLength(33);
    expect(generateSidecarAlias().length).toBeLessThanOrEqual(63);
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

describe("buildDockerSidecarEndpoints ↔ dockerSidecarAliasOf — round-trip", () => {
  it("recovers the exact alias the endpoints were built from", () => {
    const alias = generateSidecarAlias();
    expect(dockerSidecarAliasOf(boundaryWith(buildDockerSidecarEndpoints(alias)))).toBe(alias);
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

    // Every field names the same host the container will actually answer to.
    expect(new URL(endpoints.llmProxyUrl).hostname).toBe(alias);
    expect(new URL(endpoints.forwardProxyUrl).hostname).toBe(alias);
    expect(endpoints.noProxy.split(",")[0]).toBe(alias);
  });

  it("keeps two boundaries independent — one run's alias never leaks into another's endpoints", () => {
    const first = buildDockerSidecarEndpoints(generateSidecarAlias());
    const second = buildDockerSidecarEndpoints(generateSidecarAlias());

    const firstAlias = dockerSidecarAliasOf(boundaryWith(first));
    const secondAlias = dockerSidecarAliasOf(boundaryWith(second));

    expect(firstAlias).not.toBe(secondAlias);
    expect(second.noProxy).not.toContain(firstAlias);
    expect(second.forwardProxyUrl).not.toContain(firstAlias);
  });
});

describe("sidecarAliasOverrides — the container env and the network alias name one host", () => {
  it("hands both destinations the alias baked into the boundary", () => {
    const alias = generateSidecarAlias();
    const boundary = boundaryWith(buildDockerSidecarEndpoints(alias));

    const overrides = sidecarAliasOverrides(boundary);

    // The name the sidecar is told it answers to…
    expect(overrides.env.SIDECAR_DNS_ALIAS).toBe(alias);
    // …the name the container is actually published under on the run bridge…
    expect(overrides.networkAliases).toEqual([alias]);
    // …and the name the agent was handed in SIDECAR_URL. All three, one host.
    expect(overrides.env.SIDECAR_DNS_ALIAS).toBe(dockerSidecarAliasOf(boundary));
    expect(overrides.networkAliases[0]).toBe(
      new URL(boundary.sidecarEndpoints.sidecarUrl).hostname,
    );
  });

  it("publishes exactly one alias — no leftover cross-run name alongside it", () => {
    const overrides = sidecarAliasOverrides(
      boundaryWith(buildDockerSidecarEndpoints(generateSidecarAlias())),
    );
    expect(overrides.networkAliases).toHaveLength(1);
    expect(overrides.networkAliases).not.toContain("sidecar");
  });

  it("contributes only SIDECAR_DNS_ALIAS to the container env", () => {
    const overrides = sidecarAliasOverrides(
      boundaryWith(buildDockerSidecarEndpoints(generateSidecarAlias())),
    );
    expect(Object.keys(overrides.env)).toEqual(["SIDECAR_DNS_ALIAS"]);
  });

  it("two boundaries never share a name in either destination", () => {
    const a = sidecarAliasOverrides(
      boundaryWith(buildDockerSidecarEndpoints(generateSidecarAlias())),
    );
    const b = sidecarAliasOverrides(
      boundaryWith(buildDockerSidecarEndpoints(generateSidecarAlias())),
    );

    expect(a.env.SIDECAR_DNS_ALIAS).not.toBe(b.env.SIDECAR_DNS_ALIAS);
    expect(b.networkAliases).not.toContain(a.env.SIDECAR_DNS_ALIAS);
  });
});
