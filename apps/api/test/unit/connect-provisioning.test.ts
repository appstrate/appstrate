// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning turns a three-field form into a full credential bag. What is
 * worth pinning is therefore not "does it return a key" but the boundaries:
 * which names the client is allowed to influence, which hosts are refused
 * before anything is minted, and whether the script it renders can be made to
 * carry shell syntax.
 *
 * The dispatcher tests below RUN the generated script's forced command with
 * `sh`, rather than asserting on its text. Its text looked right for every
 * case while the sftp subsystem — three of the five tools — was refused before
 * a single packet, because `command=` intercepts a subsystem request too and
 * nothing in the script said so. A text assertion cannot see that; executing
 * the arm can.
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import {
  provisionCredentials,
  readProvisioning,
  type HandoffStep,
} from "../../src/services/connect/provisioning.ts";

const SSH_AUTH = {
  type: "custom",
  _meta: {
    "dev.appstrate/provisioning": {
      kind: "ssh_keypair",
      provides: ["private_key", "host_key", "read_only"],
    },
  },
};

const ctx = { integrationId: "@appstrate/ssh" };

/**
 * The handoff is a LIST of typed steps, so the tests reach into it by role
 * rather than by field name: there is one block to run now and one kept for the
 * teardown, and which index they land on is not the contract.
 */
function shellOf(res: { display: { steps: readonly HandoffStep[] } }, deferred: boolean): string {
  const step = res.display.steps.find((s) => s.kind === "command" && !!s.deferred === deferred);
  if (!step || step.kind !== "command")
    throw new Error(`no ${deferred ? "teardown" : "install"} step`);
  return step.shell;
}
const installShell = (res: { display: { steps: readonly HandoffStep[] } }) => shellOf(res, false);
const revokeShell = (res: { display: { steps: readonly HandoffStep[] } }) => shellOf(res, true);

describe("readProvisioning", () => {
  it("returns null for an auth that declares nothing", () => {
    expect(readProvisioning({ type: "custom" })).toBeNull();
    expect(readProvisioning(null)).toBeNull();
  });

  it("reads the declared kind and the names the platform owns", () => {
    expect(readProvisioning(SSH_AUTH)).toEqual({
      kind: "ssh_keypair",
      provides: ["private_key", "host_key", "read_only"],
    });
  });

  it("throws on a kind this build has no provisioner for", () => {
    const auth = { _meta: { "dev.appstrate/provisioning": { kind: "quantum_key" } } };
    // Falling back to "the user types it" would silently turn a
    // platform-minted credential into a field nobody filled.
    expect(() => readProvisioning(auth)).toThrow(/unknown credential provisioning kind/);
  });

  it("throws when `provides` does not cover the kind's floor", () => {
    // The connect form hides fields by reading `provides`. A manifest that
    // forgets one would put a mintable secret back in front of the user, and
    // the two sides would disagree with nothing failing.
    const auth = {
      _meta: { "dev.appstrate/provisioning": { kind: "ssh_keypair", provides: ["private_key"] } },
    };
    expect(() => readProvisioning(auth)).toThrow(/must list host_key, read_only in `provides`/);
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

  // The NAME case — an allowlisted hostname resolving to a private address,
  // which no literal check can see — lives with the resolving gate that has to
  // refuse it: `ssh-host-key.test.ts`.
  it("refuses a loopback literal even when the operator allowlists it", async () => {
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
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPBj/sOdBfKkpuneRA7h6SaW8fRXZly/zo3c50YJVhE9";
const RSA_HOST_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDexample";

const stubCtx = {
  integrationId: "@appstrate/ssh",
  scanHostKey: async () => ({
    ok: true as const,
    hostKey: HOST_KEY,
    fingerprint: "SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc",
  }),
};
const base = { host: "ssh.example.test", user: "agent", port: "2222" };

describe("provisionCredentials — what gets minted and rendered", () => {
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
    expect(installShell(res)).toMatch(
      /restrict,command="\/usr\/local\/bin\/appstrate-dispatch-[0-9a-f]{12}"/,
    );
  });

  /**
   * Two connections to one host must not share a dispatcher: the second paste
   * would overwrite the first and hand its key the second's verb list.
   */
  it("gives every minted key its own dispatcher path", async () => {
    const a = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    const b = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    const pathOf = (script: string) => /appstrate-dispatch-[0-9a-f]{12}/.exec(script)?.[0];
    expect(pathOf(installShell(a))).toBeDefined();
    expect(pathOf(installShell(a))).not.toBe(pathOf(installShell(b)));
  });

  it("renders one exact-match arm per allowed verb, and a refusing default", async () => {
    const res = (await provisionCredentials(
      SSH_AUTH,
      { ...base, allowed_verbs: '["hostname", "disk_usage"]' },
      stubCtx,
    ))!;
    const script = installShell(res);
    expect(script).toContain("    hostname) exec hostname ;;");
    expect(script).toContain("    disk_usage) exec df -h / ;;");
    // Not requested — must not be reachable on the target either.
    expect(script).not.toContain("whoami)");
    expect(script).toContain("refused verb");
    // The dispatcher must never hand the request to a shell.
    expect(script).not.toContain("eval");
    expect(JSON.parse(res.credentials.allowed_verbs!)).toEqual(["hostname", "disk_usage"]);
  });

  /**
   * Emptying a permission field has to NARROW it. The form seeds the
   * manifest's declared default, so clearing that box used to hand back the
   * full set of five — more than the three it had been showing.
   */
  it.each([
    ["absent", undefined],
    ["cleared", ""],
    ["an explicit empty array", "[]"],
  ])("allows no verb at all when the list is %s", async (_label, allowed_verbs) => {
    const res = (await provisionCredentials(
      SSH_AUTH,
      { ...base, ...(allowed_verbs === undefined ? {} : { allowed_verbs }) },
      stubCtx,
    ))!;
    expect(JSON.parse(res.credentials.allowed_verbs!)).toEqual([]);
  });

  it("points the fingerprint check at the key type it actually pinned", async () => {
    const ed = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    expect(installShell(ed)).toContain("/etc/ssh/ssh_host_ed25519_key.pub");

    // An sshd too old for ed25519 pins RSA — and reading an ed25519 file there
    // would silently skip the only machine-in-the-middle check there is.
    const rsa = (await provisionCredentials(
      SSH_AUTH,
      { ...base },
      {
        ...stubCtx,
        scanHostKey: async () => ({
          ok: true as const,
          hostKey: RSA_HOST_KEY,
          fingerprint: "SHA256:rsa",
        }),
      },
    ))!;
    expect(installShell(rsa)).toContain("/etc/ssh/ssh_host_rsa_key.pub");
    expect(installShell(rsa)).not.toContain("ed25519_key.pub");
  });

  it("refuses to install a key on an account that cannot run a forced command", async () => {
    // A forced command runs through the login shell. The guide used to
    // recommend nologin, which refuses every verb — and the failure only
    // surfaced mid-run, as a verb that ran and produced nothing.
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    expect(installShell(res)).toContain("*/nologin|*/false)");
  });

  /**
   * The handoff is data, and its SHAPE is the contract the SPA renders against:
   * a list of typed steps with no SSH in it. A second provisioning kind adds
   * steps, not a front-end branch — which is only true while nothing here
   * depends on their order or their count.
   */
  it("describes the handoff as typed steps, not named fields", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    expect(res.display.steps.map((s) => s.kind)).toEqual(["command", "value", "command"]);

    const commands = res.display.steps.filter((s) => s.kind === "command");
    // Exactly one of the two blocks is for later: the teardown. Shipping both
    // as "do this now" is how a removal command becomes a removal nobody runs.
    expect(commands.filter((s) => s.kind === "command" && s.deferred)).toHaveLength(1);

    // Every step is renderable: a label, and the payload its kind promises.
    for (const step of res.display.steps) {
      expect(step.label.length).toBeGreaterThan(0);
      if (step.kind === "command") expect(step.shell.length).toBeGreaterThan(0);
      else expect(step.value.length).toBeGreaterThan(0);
    }

    // The fingerprint moved from a bespoke field to a `value` step — and it is
    // still the scanned one, not the minted key's.
    const value = res.display.steps.find((s) => s.kind === "value");
    expect(value && value.kind === "value" && value.value).toBe(
      "SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc",
    );
  });

  it("hands back the block that takes the key back off the target", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    const keyBase64 = /restrict,command="[^"]+" ssh-ed25519 (\S+)/.exec(installShell(res))?.[1];
    expect(keyBase64).toBeDefined();
    // Matched on the key's own base64 with `grep -F`, so it removes exactly
    // this connection's line — deleting the connection here cannot do it.
    expect(revokeShell(res)).toContain(`grep -vF '${keyBase64}'`);
    expect(revokeShell(res)).toMatch(/rm -f "\$tmp" \/usr\/local\/bin\/appstrate-dispatch-/);
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

// ───────────────── the generated script, actually executed ─────────────────

/** Pull the forced command out of the install block's quoted heredoc. */
function extractDispatcher(script: string): string {
  const m = /<<'DISPATCH'\n([\s\S]*?)\nDISPATCH\n/.exec(script);
  if (!m) throw new Error("no dispatcher heredoc in the install script");
  return m[1]!;
}

interface ShellRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runScript(body: string, env: Record<string, string> = {}): Promise<ShellRun> {
  const file = join(await mkdtemp(join(tmpdir(), "ssh-dispatch-")), "script.sh");
  await writeFile(file, body + "\n", { mode: 0o700 });
  const proc = Bun.spawn(["sh", file], {
    // A fresh environment, plus PATH so the verbs can find their binaries:
    // sshd hands the forced command nothing but SSH_ORIGINAL_COMMAND either.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("the generated install script", () => {
  it("is valid POSIX shell", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, stubCtx))!;
    const file = join(await mkdtemp(join(tmpdir(), "ssh-install-")), "install.sh");
    await writeFile(file, installShell(res) + "\n");
    const proc = Bun.spawn(["sh", "-n", file], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(`${code} ${stderr}`.trim()).toBe("0");
  });

  it("stops before touching anything when the account cannot run a forced command", async () => {
    // `nobody` is /usr/bin/false on macOS and /usr/sbin/nologin on Debian —
    // both are the shape that breaks a forced command. The guard runs before
    // the first `install`, so this is safe to execute unprivileged.
    const res = (await provisionCredentials(SSH_AUTH, { ...base, user: "nobody" }, stubCtx))!;
    const run = await runScript(installShell(res));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("shell de login");
    expect(run.stderr).not.toContain("authorized_keys");
  });
});

describe("the generated dispatcher, run as sshd would run it", () => {
  const dispatcherFor = async (allowed_verbs?: string) => {
    const res = (await provisionCredentials(
      SSH_AUTH,
      { ...base, ...(allowed_verbs === undefined ? {} : { allowed_verbs }) },
      stubCtx,
    ))!;
    return extractDispatcher(installShell(res));
  };

  it("runs an allowed verb", async () => {
    const run = await runScript(await dispatcherFor('["hostname"]'), {
      SSH_ORIGINAL_COMMAND: "hostname",
    });
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).not.toBe("");
  });

  it("refuses anything that is not an exact verb, with exit 42", async () => {
    for (const command of ["hostname; id", "uptime", "hostname ", "../../bin/sh"]) {
      const run = await runScript(await dispatcherFor('["hostname"]'), {
        SSH_ORIGINAL_COMMAND: command,
      });
      expect({ command, code: run.code }).toEqual({ command, code: 42 });
      expect(run.stderr).toContain("refused verb");
    }
  });

  it("reports an empty request as exit 2", async () => {
    expect((await runScript(await dispatcherFor('["hostname"]'))).code).toBe(2);
    expect(
      (await runScript(await dispatcherFor('["hostname"]'), { SSH_ORIGINAL_COMMAND: "" })).code,
    ).toBe(2);
  });

  /**
   * The one that was missing. sshd routes a `subsystem sftp` request through
   * the SAME forced command, handing it the subsystem line from sshd_config
   * (measured against OpenSSH 9.2: `/usr/lib/openssh/sftp-server`). Without an
   * arm for it the session is refused and `ssh_read_file`, `ssh_list_dir` and
   * `ssh_write_file` all die with an opaque "Connection closed".
   */
  it.each([
    // Measured, not guessed: the first is what Debian 12 / OpenSSH 9.2 hands
    // the forced command, the SECOND is what Ubuntu 24.04 / OpenSSH 9.6 hands
    // it — same path, trailing space — and the fourth is the `Subsystem sftp
    // internal-sftp -f AUTHPRIV -l INFO` many distributions ship. A glob on
    // the whole string matched only the first.
    "/usr/lib/openssh/sftp-server",
    "/usr/lib/openssh/sftp-server ",
    "/usr/lib/ssh/sftp-server",
    "internal-sftp -f AUTHPRIV -l INFO",
    "/usr/libexec/sftp-server -e",
    "internal-sftp",
    "sftp-server",
  ])("routes the sftp subsystem (%p) instead of refusing it", async (subsystem) => {
    const run = await runScript(await dispatcherFor('["hostname"]'), {
      SSH_ORIGINAL_COMMAND: subsystem,
    });
    // Either the binary was found and exec'd, or exit 3 says it is absent on
    // THIS machine. What must never happen is the refusing default (42) or the
    // no-verb arm (2) — those are what kill the subsystem.
    expect([2, 42]).not.toContain(run.code);
    expect(run.stderr).not.toContain("refused verb");
  });

  it("opens sftp read-only, matching the connection's read_only", async () => {
    // `-R` is the target's own enforcement; `SSH_READ_ONLY` server-side is the
    // half that a wrong platform could get wrong.
    expect(await dispatcherFor('["hostname"]')).toContain('exec "$candidate" -R');
  });
});

describe("provisionCredentials — no-op path", () => {
  it("returns null and leaves the bag alone for an auth with no provisioning", async () => {
    const fields = { api_key: "secret" };
    expect(await provisionCredentials({ type: "api_key" }, fields, ctx)).toBeNull();
    expect(fields).toEqual({ api_key: "secret" });
  });
});
