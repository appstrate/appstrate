// SPDX-License-Identifier: Apache-2.0

/**
 * Platform network detection against a stubbed Docker Engine (#1129): only a
 * definitive answer from a live daemon may be cached — a daemon outage at boot
 * must not pin every later sidecar to `host.docker.internal`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetPlatformNetworkCacheForTesting,
  detectPlatformNetwork,
} from "../../../src/services/docker.ts";

const realFetch = globalThis.fetch;
let fetches: number;

function stubInspect(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => {
    fetches++;
    return respond();
  }) as unknown as typeof fetch;
}

const inspectBody = {
  Config: { Hostname: "abc123" },
  NetworkSettings: {
    Networks: {
      bridge: { NetworkID: "net-bridge", Aliases: null },
      appstrate_default: { NetworkID: "net-platform", Aliases: ["appstrate", "api"] },
    },
  },
};

beforeEach(() => {
  fetches = 0;
  _resetPlatformNetworkCacheForTesting();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetPlatformNetworkCacheForTesting();
});

describe("detectPlatformNetwork", () => {
  it("rejects on a transport error, then detects the network once the daemon is back", async () => {
    stubInspect(() => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    });
    await expect(detectPlatformNetwork()).rejects.toThrow("Unable to connect");

    stubInspect(() => Response.json(inspectBody));
    expect(await detectPlatformNetwork()).toEqual({
      networkId: "net-platform",
      hostname: "appstrate",
    });
  });

  it("rejects on a 5xx without caching it", async () => {
    stubInspect(() => new Response("daemon restarting", { status: 500 }));
    await expect(detectPlatformNetwork()).rejects.toThrow("HTTP 500");
    await expect(detectPlatformNetwork()).rejects.toThrow("HTTP 500");
    expect(fetches).toBe(2);
  });

  it("caches null on 404 (not running in Docker)", async () => {
    stubInspect(() => new Response("no such container", { status: 404 }));
    expect(await detectPlatformNetwork()).toBeNull();
    expect(await detectPlatformNetwork()).toBeNull();
    expect(fetches).toBe(1);
  });

  it("caches null on a 403 (socket proxy denies inspecting ourselves)", async () => {
    stubInspect(() => new Response("forbidden", { status: 403 }));
    expect(await detectPlatformNetwork()).toBeNull();
    expect(await detectPlatformNetwork()).toBeNull();
    expect(fetches).toBe(1);
  });

  it("caches the first non-default network with its first alias", async () => {
    stubInspect(() => Response.json(inspectBody));
    const expected = { networkId: "net-platform", hostname: "appstrate" };
    expect(await detectPlatformNetwork()).toEqual(expected);
    expect(await detectPlatformNetwork()).toEqual(expected);
    expect(fetches).toBe(1);
  });
});
