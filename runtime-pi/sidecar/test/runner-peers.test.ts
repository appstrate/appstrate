// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createRunnerPeers, policyForRunnerPeer } from "../runner-peers.ts";

/** `docker network inspect` stdout for a network with these `name → ip` members. */
function inspectOutput(members: Record<string, string>): string {
  const containers = Object.fromEntries(
    Object.entries(members).map(([name, ip], i) => [
      `id${i}`,
      { Name: name, EndpointID: `ep${i}`, IPv4Address: `${ip}/16`, IPv6Address: "" },
    ]),
  );
  return JSON.stringify([{ Name: "appstrate-exec-run", Driver: "bridge", Containers: containers }]);
}

function fakeInspect(initial: Record<string, string>) {
  const state = { members: initial, calls: 0, fail: false };
  const inspect = async (network: string) => {
    expect(network).toBe("appstrate-exec-run");
    state.calls += 1;
    await Bun.sleep(1);
    if (state.fail) throw new Error("daemon unreachable");
    return inspectOutput(state.members);
  };
  return { state, inspect };
}

const NETWORK = "appstrate-exec-run";

describe("createRunnerPeers", () => {
  it("attributes a registered runner, the agent, and a stranger", async () => {
    const { inspect } = fakeInspect({ "runner-a": "172.18.0.3", agent: "172.18.0.2" });
    const peers = createRunnerPeers({ network: NETWORK, inspect });
    peers.register("runner-a", "@tractr/a");
    expect(await peers.integrationOf("172.18.0.3")).toBe("@tractr/a");
    expect(await peers.integrationOf("172.18.0.2")).toBeNull();
    expect(await peers.integrationOf("172.18.0.99")).toBeUndefined();
  });

  it("unwraps an IPv4-mapped IPv6 peer address", async () => {
    const { inspect } = fakeInspect({ "runner-a": "172.18.0.3" });
    const peers = createRunnerPeers({ network: NETWORK, inspect });
    peers.register("runner-a", "@tractr/a");
    expect(await peers.integrationOf("::ffff:172.18.0.3")).toBe("@tractr/a");
  });

  it("caches the member table and single-flights concurrent lookups", async () => {
    const { state, inspect } = fakeInspect({ "runner-a": "172.18.0.3", agent: "172.18.0.2" });
    const peers = createRunnerPeers({ network: NETWORK, inspect });
    peers.register("runner-a", "@tractr/a");
    await Promise.all([
      peers.integrationOf("172.18.0.3"),
      peers.integrationOf("172.18.0.2"),
      peers.integrationOf("172.18.0.3"),
    ]);
    await peers.integrationOf("172.18.0.2");
    expect(state.calls).toBe(1);
  });

  it("re-reads the network after a register", async () => {
    const { state, inspect } = fakeInspect({ agent: "172.18.0.2" });
    const peers = createRunnerPeers({ network: NETWORK, inspect });
    expect(await peers.integrationOf("172.18.0.2")).toBeNull();
    // The register drops the cached table: the next lookup sees the new runner.
    state.members = { agent: "172.18.0.2", "runner-b": "172.18.0.4" };
    peers.register("runner-b", "@tractr/b");
    expect(await peers.integrationOf("172.18.0.4")).toBe("@tractr/b");
    expect(state.calls).toBe(2);
  });

  it("re-reads once for an address missing from a cached table (a runner started since)", async () => {
    const { state, inspect } = fakeInspect({ agent: "172.18.0.2" });
    const peers = createRunnerPeers({ network: NETWORK, inspect });
    peers.register("runner-c", "@tractr/c");
    // Registered before `docker start`: not a member yet.
    expect(await peers.integrationOf("172.18.0.5")).toBeUndefined();
    state.members = { agent: "172.18.0.2", "runner-c": "172.18.0.5" };
    expect(await peers.integrationOf("172.18.0.5")).toBe("@tractr/c");
    expect(state.calls).toBe(2);
  });

  it("fails closed when the inspect fails, and retries on the next lookup", async () => {
    const { state, inspect } = fakeInspect({ "runner-a": "172.18.0.3" });
    const peers = createRunnerPeers({ network: NETWORK, inspect });
    peers.register("runner-a", "@tractr/a");
    state.fail = true;
    expect(await peers.integrationOf("172.18.0.3")).toBeUndefined();
    state.fail = false;
    expect(await peers.integrationOf("172.18.0.3")).toBe("@tractr/a");
  });

  it("fails closed on unparseable inspect output", async () => {
    const peers = createRunnerPeers({ network: NETWORK, inspect: async () => "not json" });
    peers.register("runner-a", "@tractr/a");
    expect(await peers.integrationOf("172.18.0.3")).toBeUndefined();
  });
});

describe("policyForRunnerPeer", () => {
  it("serves the policy of the runner at the peer address, and nobody else", async () => {
    const { inspect } = fakeInspect({
      "runner-a": "172.18.0.3",
      "runner-b": "172.18.0.4",
      agent: "172.18.0.2",
    });
    const peers = createRunnerPeers({ network: NETWORK, inspect });
    peers.register("runner-a", "@tractr/a");
    peers.register("runner-b", "@tractr/b");
    const policyA = { allowsAuthority: () => true };
    const policyFor = policyForRunnerPeer(peers, new Map([["@tractr/a", policyA]]));
    expect(await policyFor("172.18.0.3")).toBe(policyA);
    // A runner without a transparent-plane policy, the agent, a stranger.
    expect(await policyFor("172.18.0.4")).toBeNull();
    expect(await policyFor("172.18.0.2")).toBeNull();
    expect(await policyFor("10.9.9.9")).toBeNull();
  });
});
