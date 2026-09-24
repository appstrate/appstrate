// SPDX-License-Identifier: Apache-2.0

/**
 * #1458 — egress wiring of a local runner at boot: which listener fronts it
 * (MITM-first, plain CONNECT when `spec.egress` is set, none otherwise), that
 * the listener enforces the policy compiled from `spec.egress`, and that it
 * admits only the peer the adapter attributes to this integration.
 *
 * A fake adapter captures the spawn options and stops the pipeline; the
 * listener stays up until `shutdown()`, so the test drives it over TCP. The
 * stub resolver records which CONNECT targets got past the policy (every
 * resolution then lands in a blocked range, so nothing leaves the process).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { zipArtifact } from "@appstrate/core/zip";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations } from "../integrations-boot.ts";
import {
  registerIntegrationRuntimeAdapter,
  type SpawnIntegrationOptions,
} from "../integration-runtime-adapter.ts";
import type { PeerAttribution } from "../runner-peers.ts";

const ADAPTER_ID = `egress-wiring-${Math.random().toString(36).slice(2, 8)}`;
const INTEGRATION_ID = "@tractr/egress";
const SERVER_ID = "@tractr/egress-server";
const EGRESS = { authorizedUris: ["https://api.allowed.test/**"], allowAllUris: false };

let spawnedWith: SpawnIntegrationOptions[] = [];
/** What the fake adapter attributes every peer to (see {@link PeerAttribution}). */
let peerOwner: string | null | undefined = INTEGRATION_ID;
/** `false` = the backend cannot attribute peers at all (`peerAttribution()` → null). */
let attributes = true;

registerIntegrationRuntimeAdapter({
  id: ADAPTER_ID,
  create: () => ({
    id: ADAPTER_ID,
    async prepare() {
      return { listenerBindHost: "127.0.0.1", proxyUrlFor: (p: number) => `http://127.0.0.1:${p}` };
    },
    async spawn(options) {
      spawnedWith.push(options);
      throw new Error("spawn stopped by test");
    },
    peerAttribution: (): PeerAttribution | null => (attributes ? async () => peerOwner : null),
    async shutdown() {},
  }),
});

afterEach(() => {
  spawnedWith = [];
  peerOwner = INTEGRATION_ID;
  attributes = true;
});

const bundle = zipArtifact({ "server.ts": new TextEncoder().encode("export {};\n") });

const fetchFn = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/internal/mcp-server-bundle/")) return new Response(bundle, { status: 200 });
  if (url.includes("/internal/integration-credentials/")) {
    return new Response(
      JSON.stringify({
        auths: [
          {
            auth_key: "main",
            auth_type: "api_key",
            fields: { token: "t" },
            authorized_uris: EGRESS.authorizedUris,
          },
        ],
        delivery_plans: {
          main: {
            header_name: "Authorization",
            header_prefix: "Bearer ",
            value: "t",
            allow_server_override: false,
          },
        },
        expires_at_epoch_ms: { main: null },
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ detail: `unexpected: ${url}` }), { status: 404 });
}) as unknown as typeof fetch;

function spec(overrides: Partial<IntegrationSpawnSpec> = {}): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace: "egress",
    sourceKind: "local",
    manifest: {
      name: INTEGRATION_ID,
      version: "1.0.0",
      server: { type: "bun", entry_point: "./server.ts", packageId: SERVER_ID },
    },
    spawnEnv: {},
    ...overrides,
  } as IntegrationSpawnSpec;
}

const MITM_AUTHS = {
  main: { authKey: "main", authType: "api_key", authorizedUris: EGRESS.authorizedUris },
} as unknown as IntegrationSpawnSpec["httpDeliveryAuths"];

async function boot(s: IntegrationSpawnSpec, resolved: string[]) {
  const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = ADAPTER_ID;
  try {
    return await bootIntegrations(
      [s],
      {
        platformApiUrl: "http://platform.local",
        runToken: "run-token",
        fetchFn,
        resolveHostFn: async (host: string) => {
          resolved.push(host);
          return ["10.0.0.5"];
        },
      },
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
  }
}

/** Send a CONNECT to the listener behind `proxyUrl`; resolves with the response's first line. */
function connectVia(proxyUrl: string, target: string): Promise<string> {
  const { port } = new URL(proxyUrl);
  return new Promise((resolve) => {
    const socket = connect(Number(port), "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let data = "";
    const done = () => {
      socket.destroy();
      resolve(data.split("\r\n")[0] ?? "");
    };
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n")) done();
    });
    socket.on("close", done);
    socket.on("error", done);
  });
}

describe("bootIntegrations — runner egress wiring (#1458)", () => {
  it("fronts a spec with `egress` and no delivery.http with a policed CONNECT listener", async () => {
    const resolved: string[] = [];
    const result = await boot(spec({ egress: EGRESS }), resolved);
    try {
      const egress = spawnedWith[0]!.egress!;
      expect(egress.caCertHostPath).toBeNull();
      expect(egress.policy.allowsAuthority("api.allowed.test", 443)).toBe(true);
      expect(egress.policy.allowsAuthority("evil.test", 443)).toBe(false);

      expect(await connectVia(egress.proxyUrl, "evil.test:443")).toContain("403");
      expect(resolved).toEqual([]);
      // Granted target: past the policy, into the resolve-and-pin floor.
      expect(await connectVia(egress.proxyUrl, "api.allowed.test:443")).toContain("403");
      expect(resolved).toEqual(["api.allowed.test"]);
    } finally {
      await result.shutdown();
    }
  });

  it("refuses a peer attributed to another integration, or to none", async () => {
    const resolved: string[] = [];
    const result = await boot(spec({ egress: EGRESS }), resolved);
    try {
      const { proxyUrl } = spawnedWith[0]!.egress!;
      for (const owner of ["@tractr/other", null, undefined]) {
        peerOwner = owner;
        expect(await connectVia(proxyUrl, "api.allowed.test:443")).toContain("403");
      }
      expect(resolved).toEqual([]);
    } finally {
      await result.shutdown();
    }
  });

  it("admits every peer when the backend cannot attribute them", async () => {
    attributes = false;
    peerOwner = "@tractr/other";
    const resolved: string[] = [];
    const result = await boot(spec({ egress: EGRESS }), resolved);
    try {
      await connectVia(spawnedWith[0]!.egress!.proxyUrl, "api.allowed.test:443");
      expect(resolved).toEqual(["api.allowed.test"]);
    } finally {
      await result.shutdown();
    }
  });

  it("gives a spec without `egress` or delivery.http no egress route", async () => {
    const result = await boot(spec(), []);
    try {
      expect(spawnedWith).toHaveLength(1);
      expect(spawnedWith[0]!.egress).toBeNull();
    } finally {
      await result.shutdown();
    }
  });

  it("prefers the MITM listener for delivery.http, under the same policy and peer gate", async () => {
    const result = await boot(spec({ egress: EGRESS, httpDeliveryAuths: MITM_AUTHS }), []);
    try {
      const egress = spawnedWith[0]!.egress!;
      expect(egress.caCertHostPath).not.toBeNull();
      expect(egress.policy.allowsUrl("https://api.allowed.test/v1/items")).toBe(true);
      expect(egress.policy.allowsUrl("https://evil.test/")).toBe(false);

      expect(await connectVia(egress.proxyUrl, "api.allowed.test:443")).toContain("200");
      peerOwner = "@tractr/other";
      expect(await connectVia(egress.proxyUrl, "api.allowed.test:443")).toContain("403");
    } finally {
      await result.shutdown();
    }
  });

  it("denies everything through a MITM listener whose spec carries no `egress`", async () => {
    const result = await boot(spec({ httpDeliveryAuths: MITM_AUTHS }), []);
    try {
      const { policy } = spawnedWith[0]!.egress!;
      expect(policy.allowsUrl("https://api.allowed.test/v1/items")).toBe(false);
      expect(policy.allowsAuthority("api.allowed.test", 443)).toBe(false);
    } finally {
      await result.shutdown();
    }
  });
});
