// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the guest→platform boot probe (runner/net-probe.ts).
 * A fake HostExec records the exact command sequence and can be
 * programmed to fail any step (curl drop, missing tooling); a fake fetch
 * models host→platform reachability. No netns, no CAP_NET_ADMIN, no
 * network.
 */

import { describe, it, expect } from "bun:test";
import {
  verifyGuestPath,
  type ProbeLogger,
  type VerifyGuestPathDeps,
} from "../../runner/net-probe.ts";
import type { HostExec } from "../../host-net.ts";

const SUBNET_CIDR = "10.231.0.0/16";
const PLATFORM_URL = "http://10.0.0.5:3000";

interface RecordedCall {
  cmd: string[];
  stdin?: string;
}

/**
 * Fake HostExec. `respond` maps a command to its stdout, or an Error to
 * simulate a non-zero exit (thrown, exactly like the real executor).
 */
function fakeExec(respond: (cmd: string[]) => string | Error = () => ""): {
  exec: HostExec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    exec: {
      async run(cmd, opts) {
        calls.push({ cmd, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
        const result = respond(cmd);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

/** Records logger calls by level for assertions. */
function fakeLogger(): {
  logger: ProbeLogger;
  entries: { level: "info" | "warn" | "error"; msg: string; data?: Record<string, unknown> }[];
} {
  const entries: {
    level: "info" | "warn" | "error";
    msg: string;
    data?: Record<string, unknown>;
  }[] = [];
  const make =
    (level: "info" | "warn" | "error") => (msg: string, data?: Record<string, unknown>) =>
      entries.push({ level, msg, data });
  return { logger: { info: make("info"), warn: make("warn"), error: make("error") }, entries };
}

// Bun's `typeof fetch` carries a `preconnect` member these one-shot mocks
// never need, so cast at the assignment boundary (same pattern as
// llm-proxy.test.ts / integration-connections.ts).
/** fetch that always resolves (host CAN reach the platform). */
const reachableFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
/** fetch that always rejects (host CANNOT reach the platform). */
const unreachableFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

/** cmd matcher: is this argv the given contiguous prefix/tokens? */
function is(cmd: string[], ...tokens: string[]): boolean {
  return tokens.every((t, i) => cmd[i] === t);
}

function baseDeps(over: Partial<VerifyGuestPathDeps> = {}): VerifyGuestPathDeps {
  return {
    exec: fakeExec().exec,
    platformUrl: PLATFORM_URL,
    subnetCidr: SUBNET_CIDR,
    fetchFn: reachableFetch,
    timeoutMs: 100,
    ...over,
  };
}

describe("verifyGuestPath — success", () => {
  it("brings up an afc-prefixed veth in the guest subnet and curls the platform from the netns", async () => {
    const { exec, calls } = fakeExec();
    const { logger, entries } = fakeLogger();
    const result = await verifyGuestPath(baseDeps({ exec, logger }));

    expect(result).toEqual({ platformReachable: true, guestPathVerified: true });
    expect(entries.some((e) => e.level === "info" && e.msg.includes("path verified"))).toBe(true);

    const cmds = calls.map((c) => c.cmd);
    // Tooling probes first.
    expect(cmds.some((c) => is(c, "ip", "netns", "list"))).toBe(true);
    expect(cmds.some((c) => is(c, "curl", "--version"))).toBe(true);
    // netns + veth setup, host end named afcprobe0 (matches the nft `afc*` glob).
    expect(cmds.some((c) => is(c, "ip", "netns", "add", "appstrate-fc-probe"))).toBe(true);
    const addLink = cmds.find((c) => is(c, "ip", "link", "add"));
    expect(addLink?.[3]).toBe("afcprobe0");
    expect(addLink).toContain("veth");
    // Host end addressed with index-1's /30 host IP; guest side gets the guest IP.
    expect(cmds.some((c) => is(c, "ip", "addr", "add", "10.231.0.5/30", "dev", "afcprobe0"))).toBe(
      true,
    );
    expect(
      cmds.some((c) => is(c, "ip", "-n", "appstrate-fc-probe", "addr", "add", "10.231.0.6/30")),
    ).toBe(true);
    // strict rp_filter on the host end, mirroring a real TAP.
    expect(cmds.some((c) => is(c, "sysctl", "-qw", "net.ipv4.conf.afcprobe0.rp_filter=1"))).toBe(
      true,
    );
    // The probe itself runs curl INSIDE the netns against the platform URL.
    const curl = cmds.find((c) => is(c, "ip", "netns", "exec", "appstrate-fc-probe", "curl"));
    expect(curl).toBeDefined();
    expect(curl).toContain(PLATFORM_URL);
    // Teardown always runs.
    expect(cmds.some((c) => is(c, "ip", "netns", "del", "appstrate-fc-probe"))).toBe(true);
    expect(cmds.some((c) => is(c, "ip", "link", "del", "afcprobe0"))).toBe(true);
  });
});

describe("verifyGuestPath — nft drop (the DNAT regression)", () => {
  // Host reaches the platform, but the in-netns curl is dropped. This is
  // exactly the incident signature; the probe must return guestPathVerified
  // false AND dump the nft ruleset + docker DNAT diagnostics.
  function droppedExec(): { exec: HostExec; calls: RecordedCall[] } {
    return fakeExec((cmd) => {
      if (is(cmd, "ip", "netns", "exec")) return new Error("curl: (28) timed out");
      if (is(cmd, "nft", "list", "table")) {
        return 'table ip appstrate_fc {\n  chain forward {\n    iifname "afc*" ip daddr 10.0.0.5 tcp dport 3000 accept\n  }\n}';
      }
      if (is(cmd, "iptables", "-t", "nat", "-S", "DOCKER")) {
        return "-A DOCKER -p tcp -m tcp --dport 3000 -j DNAT --to-destination 172.17.0.2:3000";
      }
      return "";
    });
  }

  it("returns guestPathVerified:false and logs the nft ruleset + DNAT diagnostic", async () => {
    const { exec, calls } = droppedExec();
    const { logger, entries } = fakeLogger();
    const result = await verifyGuestPath(baseDeps({ exec, logger, fetchFn: reachableFetch }));

    expect(result).toEqual({ platformReachable: true, guestPathVerified: false });
    // Diagnostic dumps ran.
    const cmds = calls.map((c) => c.cmd);
    expect(cmds.some((c) => is(c, "nft", "list", "table", "ip", "appstrate_fc"))).toBe(true);
    expect(cmds.some((c) => is(c, "iptables", "-t", "nat", "-S", "DOCKER"))).toBe(true);
    // A failure diagnostic was logged with the ruleset + DNAT detection.
    const fail = entries.find((e) => e.msg.includes("verification FAILED"));
    expect(fail).toBeDefined();
    expect(fail?.data?.platformIsDockerDnat).toBe(true);
    expect(String(fail?.data?.nftRuleset)).toContain("appstrate_fc");
    expect(String(fail?.data?.hint)).toContain("ct original");
  });

  it("in warn mode logs at warn level and does NOT throw (non-fatal)", async () => {
    const { exec } = droppedExec();
    const { logger, entries } = fakeLogger();
    await verifyGuestPath(baseDeps({ exec, logger, mode: "warn" }));
    const fail = entries.find((e) => e.msg.includes("verification FAILED"));
    expect(fail?.level).toBe("warn");
  });

  it("in strict mode logs the failure at error level (caller decides fatality)", async () => {
    const { exec } = droppedExec();
    const { logger, entries } = fakeLogger();
    const result = await verifyGuestPath(baseDeps({ exec, logger, mode: "strict" }));
    expect(result.guestPathVerified).toBe(false);
    const fail = entries.find((e) => e.msg.includes("verification FAILED"));
    expect(fail?.level).toBe("error");
  });
});

describe("verifyGuestPath — platform down (indeterminate)", () => {
  it("returns guestPathVerified:null when neither host nor guest can reach the platform", async () => {
    // curl fails AND host fetch fails → platform is down, path unprovable.
    const { exec, calls } = fakeExec((cmd) =>
      is(cmd, "ip", "netns", "exec") ? new Error("curl: (7) connection refused") : "",
    );
    const { logger, entries } = fakeLogger();
    const result = await verifyGuestPath(baseDeps({ exec, logger, fetchFn: unreachableFetch }));

    expect(result).toEqual({ platformReachable: false, guestPathVerified: null });
    // No DNAT diagnostic — the drop is not the failure mode here.
    expect(calls.some((c) => is(c.cmd, "nft", "list", "table"))).toBe(false);
    expect(entries.some((e) => e.msg.includes("unreachable from the host too"))).toBe(true);
  });
});

describe("verifyGuestPath — degraded (no netns tooling)", () => {
  it("skips the netns probe and returns guestPathVerified:null when `ip netns` is unavailable", async () => {
    const { exec, calls } = fakeExec((cmd) =>
      is(cmd, "ip", "netns", "list") ? new Error("ip: netns unavailable") : "",
    );
    const { logger, entries } = fakeLogger();
    const result = await verifyGuestPath(baseDeps({ exec, logger, fetchFn: reachableFetch }));

    expect(result).toEqual({ platformReachable: true, guestPathVerified: null });
    // Never attempted to create a namespace.
    expect(calls.some((c) => is(c.cmd, "ip", "netns", "add"))).toBe(false);
    const warn = entries.find((e) => e.msg.includes("guest path NOT verified"));
    expect(warn?.level).toBe("warn");
    expect(warn?.data?.missing).toContain("ip netns");
  });

  it("degrades when curl is missing, reporting it as the missing tool", async () => {
    const { exec } = fakeExec((cmd) =>
      is(cmd, "curl", "--version") ? new Error("curl: not found") : "",
    );
    const { logger, entries } = fakeLogger();
    const result = await verifyGuestPath(baseDeps({ exec, logger }));
    expect(result.guestPathVerified).toBeNull();
    expect(entries.find((e) => e.data?.missing === "curl")).toBeDefined();
  });
});
