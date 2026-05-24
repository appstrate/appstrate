// SPDX-License-Identifier: Apache-2.0

/**
 * E3 — Docker socket gating invariant (host-escape boundary).
 *
 * The sidecar gets the Docker socket bind + `user: "0:0"` ONLY when the
 * run declares ≥1 integration (it must spawn per-integration runner
 * containers via the mounted socket). Runs without integrations keep the
 * image's locked-down default (`nobody:nobody`, no socket) — granting the
 * socket unconditionally would hand every run a host-escape primitive.
 *
 * `DockerOrchestrator.createSidecar` builds these overrides through the
 * pure `sidecarSocketOverrides` helper and merges them into the
 * `createContainer` options. We assert the helper directly: the actual
 * container-create body is only observable against a live Docker daemon
 * (`docker.createContainer` POSTs to the unix socket), so the gating
 * decision is extracted into this pure helper to keep the invariant
 * unit-testable. This test imports nothing that touches the DB or Docker
 * — no PostgreSQL preload required.
 */

import { describe, it, expect } from "bun:test";
import { sidecarSocketOverrides } from "../../../src/services/orchestrator/docker-orchestrator.ts";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

function fakeIntegration(id: string): IntegrationSpawnSpec {
  return {
    integrationId: id,
    namespace: id.replace(/[^a-z]/gi, ""),
    manifest: { name: id, version: "1.0.0" },
    spawnEnv: {},
    toolAllowlist: [],
  };
}

describe("sidecarSocketOverrides — Docker socket gating", () => {
  it("zero-integration run → no socket bind, no root user (defaults apply)", () => {
    const overrides = sidecarSocketOverrides({ integrations: [] });
    expect(overrides).toEqual({});
    expect("binds" in overrides).toBe(false);
    expect("user" in overrides).toBe(false);
  });

  it("undefined integrations → no socket bind, no root user", () => {
    const overrides = sidecarSocketOverrides({ integrations: undefined });
    expect(overrides).toEqual({});
  });

  it("≥1-integration run → socket bind + user 0:0", () => {
    const overrides = sidecarSocketOverrides({
      integrations: [fakeIntegration("@test/gmail-mcp")],
    });
    expect(overrides).toEqual({
      binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      user: "0:0",
    });
  });

  it("multiple integrations → socket bind + user 0:0 (same as one)", () => {
    const overrides = sidecarSocketOverrides({
      integrations: [fakeIntegration("@test/a"), fakeIntegration("@test/b")],
    });
    expect(overrides).toEqual({
      binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      user: "0:0",
    });
  });

  it("the only socket binds the host docker.sock — no other path is exposed", () => {
    const overrides = sidecarSocketOverrides({
      integrations: [fakeIntegration("@test/x")],
    }) as { binds: string[] };
    expect(overrides.binds).toHaveLength(1);
    expect(overrides.binds[0]).toBe("/var/run/docker.sock:/var/run/docker.sock");
  });
});
