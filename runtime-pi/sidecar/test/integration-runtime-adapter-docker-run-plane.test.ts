// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveRunPlane` — the gate between the platform-launched topology and the
 * dev/test fallback.
 *
 * The fallback is not merely "less featureful": a runner container is created
 * there with NO `--network`, so `HTTPS_PROXY` points at 127.0.0.1 inside the
 * runner itself and a `delivery.env` integration gets full unfiltered egress
 * while holding real credentials in its env — the MITM/allowlist plane is
 * bypassed, not just unavailable. That is acceptable only when no platform
 * launcher is involved at all. So the fallback keys off "no `RUN_ID`" alone:
 * a launched run never lands there, whatever else is set.
 *
 * Pure — no Docker daemon, no PostgreSQL.
 */

import { describe, it, expect } from "bun:test";
import { resolveRunPlane } from "../integration-runtime-adapter-docker.ts";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe("resolveRunPlane — platform-launched topology", () => {
  it("derives the run network and carries the alias alongside it", () => {
    const plane = resolveRunPlane(
      env({ RUN_ID: "run_abc123", SIDECAR_DNS_ALIAS: "s5f3a1c9e7b2d4068159e2a7c3b0d6f84" }),
    );
    expect(plane).toEqual({
      network: "appstrate-exec-run_abc123",
      alias: "s5f3a1c9e7b2d4068159e2a7c3b0d6f84",
    });
  });

  it("the alias it returns is the one the runner's proxy URL is built from", () => {
    const plane = resolveRunPlane(env({ RUN_ID: "run_x", SIDECAR_DNS_ALIAS: "salias" }));
    // Non-null by construction: the network branch cannot carry an absent
    // alias, which is what stops a future edit emitting `http://undefined:PORT`.
    expect(`http://${plane?.alias}:39472`).toBe("http://salias:39472");
  });
});

describe("resolveRunPlane — dev/test fallback", () => {
  it("no RUN_ID → null (no launcher involved, loopback contract is honest)", () => {
    expect(resolveRunPlane(env({}))).toBeNull();
  });

  it("no RUN_ID → null even when an alias is somehow present", () => {
    expect(resolveRunPlane(env({ SIDECAR_DNS_ALIAS: "sorphan" }))).toBeNull();
  });

  it("empty RUN_ID → null (an empty var is not a launched run)", () => {
    expect(resolveRunPlane(env({ RUN_ID: "" }))).toBeNull();
  });
});

describe("resolveRunPlane — half-configured launcher", () => {
  // A launched run with no usable alias has nothing left to infer a plane
  // from, and must never degrade to the networkless dev path.
  it("RUN_ID without SIDECAR_DNS_ALIAS throws", () => {
    expect(() => resolveRunPlane(env({ RUN_ID: "run_abc123" }))).toThrow(
      /RUN_ID is set but SIDECAR_DNS_ALIAS is missing/,
    );
  });

  it("RUN_ID with an empty SIDECAR_DNS_ALIAS throws", () => {
    expect(() => resolveRunPlane(env({ RUN_ID: "run_abc123", SIDECAR_DNS_ALIAS: "" }))).toThrow(
      /RUN_ID is set but SIDECAR_DNS_ALIAS is missing/,
    );
  });

  it("the error names the credential-exposure consequence, not just the mangled var", () => {
    expect(() => resolveRunPlane(env({ RUN_ID: "run_abc123", SIDECAR_DNS_ALIAS: "" }))).toThrow(
      /unfiltered egress/,
    );
  });
});
