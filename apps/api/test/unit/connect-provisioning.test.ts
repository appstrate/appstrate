// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning turns a three-field form into a full credential bag. What is
 * worth pinning is therefore not "does it return a key" but the boundaries:
 * which names the client is allowed to influence, which hosts are refused
 * before anything is minted, and whether the script it renders can be made to
 * carry shell syntax.
 */

import { describe, it, expect } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { provisionCredentials, provisioningKind } from "../../src/services/connect/provisioning.ts";

const SSH_AUTH = {
  type: "custom",
  _meta: { "dev.appstrate/provisioning": { kind: "ssh_keypair" } },
};

const ctx = { integrationId: "@appstrate/ssh" };

/**
 * A reachable target: the API test harness already trusts `127.0.0.1` through
 * `EGRESS_ALLOW_INTERNAL_HOSTS`, but the RUNNER floor (`isBlockedHost`) has no
 * allowlist and refuses loopback outright — which provisioning mirrors on
 * purpose. So the happy path needs a public-looking name, and the scan itself
 * is the part these tests cannot run offline.
 */
describe("provisioningKind", () => {
  it("returns null for an auth that declares nothing", () => {
    expect(provisioningKind({ type: "custom" })).toBeNull();
    expect(provisioningKind(null)).toBeNull();
  });

  it("reads the declared kind", () => {
    expect(provisioningKind(SSH_AUTH)).toBe("ssh_keypair");
  });

  it("throws on a kind this build has no provisioner for", () => {
    const auth = { _meta: { "dev.appstrate/provisioning": { kind: "quantum_key" } } };
    // Falling back to "the user types it" would silently turn a
    // platform-minted credential into a field nobody filled.
    expect(() => provisioningKind(auth)).toThrow(/unknown credential provisioning kind/);
  });
});

describe("provisionCredentials — the runner floor is mirrored at the form", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC1918"],
    ["192.168.1.10", "RFC1918"],
    ["169.254.169.254", "cloud metadata"],
    ["localhost", "localhost"],
  ])("refuses %s (%s) before minting anything", async (host) => {
    await expect(
      provisionCredentials(SSH_AUTH, { host, user: "agent", port: "22" }, ctx),
    ).rejects.toThrow(/runs cannot reach this host/);
  });

  it("refuses a loopback target even when the operator allowlists it", async () => {
    // The platform's own egress guard WOULD let this through. The runner's
    // would not, and the runner is what has to reach the host — so a
    // connection created here could never be used.
    const prev = process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
    process.env.EGRESS_ALLOW_INTERNAL_HOSTS = "127.0.0.1";
    resetEnvCache();
    try {
      await expect(
        provisionCredentials(SSH_AUTH, { host: "127.0.0.1", user: "agent" }, ctx),
      ).rejects.toThrow(/runs cannot reach this host/);
    } finally {
      if (prev === undefined) delete process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
      else process.env.EGRESS_ALLOW_INTERNAL_HOSTS = prev;
      resetEnvCache();
    }
  });
});

describe("provisionCredentials — input validation", () => {
  const badHostFree = { host: "ssh.example.test" };

  it("requires a host and a user", async () => {
    await expect(provisionCredentials(SSH_AUTH, { user: "agent" }, ctx)).rejects.toThrow(
      /`host` is required/,
    );
    await expect(provisionCredentials(SSH_AUTH, badHostFree, ctx)).rejects.toThrow(
      /`user` is required/,
    );
  });

  it.each(["root; rm -rf /", "ag ent", "$(whoami)", "-oProxyCommand=x", "AGENT", "agent\nroot"])(
    "refuses %p as a Unix account name",
    async (user) => {
      // The account name is interpolated into the generated script, so the
      // character class is the whole defence — there is no quoting to rely on.
      await expect(provisionCredentials(SSH_AUTH, { ...badHostFree, user }, ctx)).rejects.toThrow(
        /Unix account name/,
      );
    },
  );

  it.each(["0", "70000", "-1", "22abc"])("refuses port %p", async (port) => {
    await expect(
      provisionCredentials(SSH_AUTH, { ...badHostFree, user: "agent", port }, ctx),
    ).rejects.toThrow(/`port` must be a number between 1 and 65535/);
  });

  it("refuses a verb list that is not a JSON array", async () => {
    await expect(
      provisionCredentials(
        SSH_AUTH,
        { ...badHostFree, user: "agent", allowed_verbs: "hostname" },
        ctx,
      ),
    ).rejects.toThrow(/must be a JSON array/);
  });

  it.each(['["rm -rf /"]', '["Hostname"]', '["a;b"]', "[42]", '["../../etc"]'])(
    "refuses %s as a verb name",
    async (allowed_verbs) => {
      await expect(
        provisionCredentials(SSH_AUTH, { ...badHostFree, user: "agent", allowed_verbs }, ctx),
      ).rejects.toThrow(/is not a valid name|implements/);
    },
  );

  it("refuses a verb the generated dispatcher cannot implement", async () => {
    await expect(
      provisionCredentials(
        SSH_AUTH,
        { ...badHostFree, user: "agent", allowed_verbs: '["deploy_latest"]' },
        ctx,
      ),
    ).rejects.toThrow(/add deploy_latest to the script on the target first/);
  });
});

/**
 * The happy path, with the network step stubbed. What matters here is the
 * generated script: it is the thing that ends up appending a line to a
 * customer's `authorized_keys`, and nothing downstream reviews it.
 */
describe("provisionCredentials — what gets minted and rendered", () => {
  const HOST_KEY =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPBj/sOdBfKkpuneRA7h6SaW8fRXZly/zo3c50YJVhE9";
  const stubCtx = {
    integrationId: "@appstrate/ssh",
    scanHostKey: async () => ({
      ok: true as const,
      hostKey: HOST_KEY,
      fingerprint: "SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc",
    }),
  };
  const base = { host: "ssh.example.test", user: "agent", port: "2222" };

  it("mints an OpenSSH private key and pins the scanned host key", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    expect(res.credentials.private_key).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(res.credentials.private_key).toEndWith("-----END OPENSSH PRIVATE KEY-----\n");
    expect(res.credentials.host_key).toBe(HOST_KEY);
    expect(res.credentials.port).toBe("2222");
    // The private half is never part of what is shown.
    expect(JSON.stringify(res.display)).not.toContain("PRIVATE KEY");
  });

  it("installs the very key it minted — the two halves cannot drift", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    expect(res.display.install_command).toContain(res.display.public_key);
    expect(res.display.install_command).toContain(
      `restrict,command="/usr/local/bin/appstrate-dispatch"`,
    );
  });

  it("renders one exact-match arm per allowed verb, and a refusing default", async () => {
    const res = (await provisionCredentials(
      SSH_AUTH,
      { ...base, allowed_verbs: '["hostname", "disk_usage"]' },
      stubCtx,
    ))!;
    const script = res.display.install_command;
    expect(script).toContain("    hostname) exec hostname ;;");
    expect(script).toContain("    disk_usage) exec df -h / ;;");
    // Not requested — must not be reachable on the target either.
    expect(script).not.toContain("whoami)");
    expect(script).toContain("refused verb");
    // The dispatcher must never hand the request to a shell.
    expect(script).not.toContain("eval");
    expect(JSON.parse(res.credentials.allowed_verbs!)).toEqual(["hostname", "disk_usage"]);
  });

  it("defaults the verb list to what the generated dispatcher implements", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    expect(JSON.parse(res.credentials.allowed_verbs!)).toEqual([
      "hostname",
      "uptime",
      "disk_usage",
      "memory",
      "whoami",
    ]);
  });

  it("ignores a client-supplied private key, host key or read-only flag", async () => {
    const fields: Record<string, unknown> = {
      ...base,
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nattacker\n",
      host_key: "ssh-ed25519 AAAAattacker",
      read_only: "0",
    };
    const res = (await provisionCredentials(SSH_AUTH, fields, stubCtx))!;
    expect(res.credentials.private_key).not.toContain("attacker");
    expect(res.credentials.host_key).toBe(HOST_KEY);
    expect(res.credentials.read_only).toBe("1");
    // Stripped from the submitted bag too, so a later merge cannot resurrect
    // them whatever order the caller composes in.
    expect(fields.private_key).toBeUndefined();
    expect(fields.host_key).toBeUndefined();
    expect(fields.read_only).toBeUndefined();
  });

  it("surfaces a failed scan as a form error, minting nothing", async () => {
    await expect(
      provisionCredentials(
        SSH_AUTH,
        { ...base },
        {
          integrationId: "@appstrate/ssh",
          scanHostKey: async () => ({ ok: false as const, reason: "unreachable" as const }),
        },
      ),
    ).rejects.toThrow(/host key could not be read from ssh\.example\.test:2222/);
  });
});

describe("provisionCredentials — no-op path", () => {
  it("returns null and leaves the bag alone for an auth with no provisioning", async () => {
    const fields = { api_key: "secret" };
    expect(await provisionCredentials({ type: "api_key" }, fields, ctx)).toBeNull();
    expect(fields).toEqual({ api_key: "secret" });
  });
});
