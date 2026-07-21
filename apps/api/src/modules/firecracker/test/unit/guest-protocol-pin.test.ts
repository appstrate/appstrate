// SPDX-License-Identifier: Apache-2.0

/**
 * Guest-protocol compatibility pin: the config-drive wire shape
 * (buildGuestConfig output — what the in-guest supervisor parses) is
 * snapshotted PER GUEST_PROTOCOL_VERSION. Changing the shape without
 * bumping the version fails here — exactly the drift that shipped the
 * MMDS `credentials.source` field under protocol 1 and let an upgraded
 * daemon boot a supervisor that silently ignored it (review B-4).
 */

import { describe, it, expect } from "bun:test";
import { buildGuestConfig } from "../../vm-config.ts";
import { GUEST_PROTOCOL_VERSION } from "../../runner/artifacts.ts";

/** Sorted deep key paths of a JSON value — a structural fingerprint. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path, ...keyPaths((value as Record<string, unknown>)[key], path));
  }
  return paths.sort();
}

/**
 * The config-drive contract per protocol version. Adding/renaming/removing
 * a field the supervisor reads = a host↔guest contract change:
 *   1. bump GUEST_PROTOCOL_VERSION in runner/artifacts.ts (see its BUMP
 *      RULES — a lockstep artifact release),
 *   2. add the new version's fingerprint here (keep the old entries).
 */
const CONTRACT_BY_PROTOCOL: Record<number, string[]> = {
  2: [
    "agent",
    "agent.argv",
    "agent.env",
    "agent.env.MODEL_API_KEY",
    "agent.unrestricted_egress",
    "credentials",
    "credentials.source",
    "exit_marker_nonce",
    "network",
    "network.platform_ip",
    "network.platform_port",
    "run_id",
    "sidecar",
    "sidecar.enabled",
    "sidecar.env",
    "sidecar.env.RUN_TOKEN",
  ],
  // Protocol 3 changes required rootfs paths/UID policy, not the JSON shape.
  3: [
    "agent",
    "agent.argv",
    "agent.env",
    "agent.env.MODEL_API_KEY",
    "agent.unrestricted_egress",
    "credentials",
    "credentials.source",
    "exit_marker_nonce",
    "network",
    "network.platform_ip",
    "network.platform_port",
    "run_id",
    "sidecar",
    "sidecar.enabled",
    "sidecar.env",
    "sidecar.env.RUN_TOKEN",
  ],
};

describe("guest config ↔ GUEST_PROTOCOL_VERSION pin", () => {
  it("the config-drive shape matches the snapshot recorded for the current protocol", () => {
    const expected = CONTRACT_BY_PROTOCOL[GUEST_PROTOCOL_VERSION];
    if (!expected) {
      throw new Error(
        `No config-drive fingerprint recorded for GUEST_PROTOCOL_VERSION=${GUEST_PROTOCOL_VERSION} ` +
          `— add one to CONTRACT_BY_PROTOCOL in this test (and publish artifacts in lockstep).`,
      );
    }
    const config = buildGuestConfig({
      runId: "run_pin",
      exitMarkerNonce: "00ff",
      platformIp: "10.231.255.1",
      platformPort: 3000,
      sidecarEnv: { RUN_TOKEN: "tok" },
      agentEnv: { MODEL_API_KEY: "sk-x" },
      agentUnrestrictedEgress: false,
      credentialSource: "mmds",
      agentArgv: ["/bin/sh", "-c", "true"],
    });
    expect(keyPaths(config)).toEqual(expected);
  });
});
