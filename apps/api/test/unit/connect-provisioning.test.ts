// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning turns a three-field form into a full credential bag. What is
 * worth pinning is therefore not "does it return a key" but the boundaries:
 * which names the client is allowed to influence, which hosts are refused
 * before anything is minted, and whether the script it renders can be made to
 * carry shell syntax.
 *
 * Both generated blocks are EXECUTED here, not only asserted on: the install
 * block for the one arm that must hold before anything is touched (an account
 * with no login shell), the revoke block for the three outcomes that would
 * otherwise destroy an `authorized_keys` instead of pruning it.
 */

import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { publicKeyFromOpenSshPrivateKey } from "../../src/lib/openssh-key.ts";
import {
  authWithoutMintedCredentials,
  handoffStepsFor,
  provisionCredentials,
  readProvisioning,
} from "../../src/services/connect/provisioning.ts";

const SSH_AUTH = {
  type: "custom",
  _meta: {
    "dev.appstrate/provisioning": {
      kind: "ssh_keypair",
    },
  },
};

const ctx = { integrationId: "@appstrate/ssh" };

/**
 * The handoff is a LIST of typed steps, so the tests reach into it by role
 * rather than by field name: there is one block to run now and one kept for the
 * teardown, and which index they land on is not the contract.
 *
 * Both go through `handoffStepsFor` on the bag the provisioner PERSISTS — the
 * same call the connect route and `GET /api/me/connections/{id}/handoff` make.
 * So every assertion below about the generated script doubles as an assertion
 * that the script is derivable from stored credentials alone: nothing in this
 * file can pass against a block the platform had to keep a copy of.
 */
function shellOf(credentials: Record<string, string>, deferred: boolean): string {
  const step = handoffStepsFor(SSH_AUTH, credentials).find(
    (s) => s.kind === "command" && !!s.deferred === deferred,
  );
  if (!step || step.kind !== "command")
    throw new Error(`no ${deferred ? "teardown" : "install"} step`);
  return step.shell;
}
const installShell = (credentials: Record<string, string>) => shellOf(credentials, false);
const revokeShell = (credentials: Record<string, string>) => shellOf(credentials, true);
const stepsOf = (credentials: Record<string, string>) => handoffStepsFor(SSH_AUTH, credentials);

describe("readProvisioning", () => {
  it("returns null for an auth that declares nothing", () => {
    expect(readProvisioning({ type: "custom" })).toBeNull();
    expect(readProvisioning(null)).toBeNull();
  });

  /**
   * The manifest names the KIND and nothing else: what a kind mints is read
   * from the code table beside the provisioner. A manifest is immutable once
   * published, so a list inside one could only ever drift from the provisioner
   * it claims to describe.
   */
  it("derives the names the platform owns from the kind alone", () => {
    expect(readProvisioning(SSH_AUTH)).toEqual({
      kind: "ssh_keypair",
      provides: ["private_key"],
    });
  });

  it("throws on a kind this build has no provisioner for", () => {
    const auth = { _meta: { "dev.appstrate/provisioning": { kind: "quantum_key" } } };
    // Falling back to "the user types it" would silently turn a
    // platform-minted credential into a field nobody filled.
    expect(() => readProvisioning(auth)).toThrow(/unknown credential provisioning kind/);
  });
});

/**
 * What the hosted form is handed. The names the platform mints are taken out
 * of the schema SERVER-SIDE, so the form renders what it is given rather than
 * second-guessing which fields it should hide.
 */
describe("authWithoutMintedCredentials", () => {
  const withSchema = {
    ...SSH_AUTH,
    credentials: {
      schema: {
        type: "object",
        required: ["private_key", "host", "user"],
        properties: {
          private_key: { type: "string" },
          host: { type: "string" },
          user: { type: "string" },
        },
      },
    },
  };

  it("removes the minted names from `properties` and `required`", () => {
    const shown = authWithoutMintedCredentials(withSchema);
    expect(Object.keys(shown.credentials.schema.properties)).toEqual(["host", "user"]);
    expect(shown.credentials.schema.required).toEqual(["host", "user"]);
    // Everything else the form renders against survives untouched.
    expect(shown.credentials.schema.type).toBe("object");
    expect(shown.type).toBe("custom");
  });

  it("copies rather than writes through the manifest it was given", () => {
    // The manifest is shared: stripping it in place would strip it for the
    // submit door too, which validates against the FULL schema.
    authWithoutMintedCredentials(withSchema);
    expect(Object.keys(withSchema.credentials.schema.properties)).toContain("private_key");
    expect(withSchema.credentials.schema.required).toContain("private_key");
  });

  it("hands back an auth that provisions nothing unchanged", () => {
    const plain = { type: "api_key", credentials: { schema: { properties: { api_key: {} } } } };
    expect(authWithoutMintedCredentials(plain)).toBe(plain);
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

  // Only literals are caught here. A NAME resolving to a private address
  // reaches the runner's own CONNECT gate at run time — the platform resolves
  // nothing, because it opens no socket to this host at any point.
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
});

/**
 * The happy path. What matters here is the generated script: it is the thing
 * that ends up appending a line to a customer's `authorized_keys`, and nothing
 * downstream reviews it.
 */
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPBj/sOdBfKkpuneRA7h6SaW8fRXZly/zo3c50YJVhE9";
const RSA_HOST_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDexample";

const base = {
  host: "ssh.example.test",
  user: "agent",
  port: "2222",
  host_key: HOST_KEY,
};

describe("provisionCredentials — what gets minted and rendered", () => {
  it("mints an OpenSSH private key and pins the supplied host key", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    expect(res.private_key).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(res.private_key).toEndWith("-----END OPENSSH PRIVATE KEY-----\n");
    expect(res.host_key).toBe(HOST_KEY);
    expect(res.port).toBe("2222");
    // The private half is never part of what is shown.
    expect(JSON.stringify(stepsOf(res))).not.toContain("PRIVATE KEY");
  });

  it("installs the very key it minted — the two halves cannot drift", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    const publicKey = publicKeyFromOpenSshPrivateKey(res.private_key!);
    expect(installShell(res)).toContain(`'restrict ${publicKey} appstrate'`);
  });

  /**
   * `restrict` narrows the KEY (no forwarding, no pty); the account narrows
   * what it may DO. The comment is this file's own literal, not the one inside
   * the key container — that one is caller-chosen on the programmatic import
   * door, and this line is pasted as root.
   */
  it("authorises the key with restrict and a platform-minted comment", async () => {
    const script = installShell((await provisionCredentials(SSH_AUTH, { ...base }, ctx))!);
    expect(script).toMatch(/'restrict ssh-ed25519 [A-Za-z0-9+/]+=* appstrate'/);
  });

  it("appends nothing a second time when the block is replayed", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    const base64 = publicKeyFromOpenSshPrivateKey(res.private_key!).split(/\s+/)[1];
    expect(installShell(res)).toContain(`grep -qF '${base64}' "$keys"`);
  });

  it("points the fingerprint check at the key type it actually pinned", async () => {
    const ed = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    expect(installShell(ed)).toContain("/etc/ssh/ssh_host_ed25519_key.pub");

    // An sshd too old for ed25519 pins RSA — and reading an ed25519 file there
    // would silently skip the only machine-in-the-middle check there is.
    const rsa = (await provisionCredentials(SSH_AUTH, { ...base, host_key: RSA_HOST_KEY }, ctx))!;
    expect(installShell(rsa)).toContain("/etc/ssh/ssh_host_rsa_key.pub");
    expect(installShell(rsa)).not.toContain("ed25519_key.pub");
  });

  it("refuses to install a key on an account with no login shell", async () => {
    // sshd runs an incoming command through the login shell, so an account set
    // to nologin runs nothing — and the failure would only surface mid-run, as
    // a command that produced no output.
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    expect(installShell(res)).toContain("*/nologin|*/false)");
  });

  /**
   * The handoff is data, and its SHAPE is the contract the SPA renders against:
   * a list of typed steps with no SSH in it. A second provisioning kind adds
   * steps, not a front-end branch — which is only true while nothing here
   * depends on their order or their count.
   */
  it("describes the handoff as typed steps, not named fields", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    expect(stepsOf(res).map((s) => s.kind)).toEqual(["command", "value", "command"]);

    const commands = stepsOf(res).filter((s) => s.kind === "command");
    // Exactly one of the two blocks is for later: the teardown. Shipping both
    // as "do this now" is how a removal command becomes a removal nobody runs.
    expect(commands.filter((s) => s.kind === "command" && s.deferred)).toHaveLength(1);

    // Every step is renderable: a label, and the payload its kind promises.
    for (const step of stepsOf(res)) {
      expect(step.label.length).toBeGreaterThan(0);
      if (step.kind === "command") expect(step.shell.length).toBeGreaterThan(0);
      else expect(step.value.length).toBeGreaterThan(0);
    }

    // The fingerprint moved from a bespoke field to a `value` step — and it is
    // still the SUPPLIED host key's, not the minted key's.
    const value = stepsOf(res).find((s) => s.kind === "value");
    expect(value && value.kind === "value" && value.value).toBe(
      "SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc",
    );
  });

  /**
   * The load-bearing property of the whole design: nothing about the handoff is
   * stored, so the block must be a pure function of the persisted bag.
   *
   * Pinned two ways. A bag narrowed to exactly the columns the keyring holds —
   * no extras carried over from the request — must render byte-identically to
   * the bag the provisioner returned; that is what makes the column, its
   * migration and its drizzle snapshot unnecessary rather than merely absent.
   * And the list must be NON-EMPTY here, because `sshHandoffSteps` fails soft:
   * a regression that made the happy path fall into that branch would
   * otherwise hand the user nothing while every other assertion stayed green.
   */
  it("derives the same block from the stored bundle alone", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    const atCreation = stepsOf(res);
    expect(atCreation.length).toBeGreaterThan(0);

    // What `getIntegrationConnectionCredentialFields` hands back months later:
    // the stored names, nothing else, order not preserved.
    const readBack = {
      host_key: res.host_key!,
      user: res.user!,
      port: res.port!,
      private_key: res.private_key!,
      host: res.host!,
    };
    expect(stepsOf(readBack)).toEqual(atCreation);
  });

  /**
   * The fail-soft branch itself: a bundle that cannot describe a step yields an
   * empty list, never a half-built command. `grep -vF ''` matches every line,
   * so a revoke block rendered from a missing key would empty the very
   * `authorized_keys` it was meant to prune.
   */
  it("renders nothing rather than a half-built command", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    for (const missing of ["private_key", "user", "host_key"]) {
      const { [missing]: _dropped, ...partial } = res;
      expect(stepsOf(partial)).toEqual([]);
    }
    // A private key that is not one parses to nothing, not to a block naming an
    // empty public half.
    expect(stepsOf({ ...res, private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nnope" })).toEqual(
      [],
    );
  });

  it("hands back the block that takes the key back off the target", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    const keyBase64 = /'restrict ssh-ed25519 (\S+)/.exec(installShell(res))?.[1];
    expect(keyBase64).toBeDefined();
    // Matched on the key's own base64 with `grep -F`, so it removes exactly
    // this connection's line — deleting the connection here cannot do it.
    expect(revokeShell(res)).toContain(`grep -vF '${keyBase64}'`);
  });

  /**
   * `provides` is the boundary, and it covers exactly what the platform MINTS.
   * A client can send anything; the names on that list are dropped from the
   * submitted bag before the merge, so no ordering of the composition can
   * resurrect them.
   *
   * `host_key` is deliberately NOT on it — it is the user's to supply, read off
   * the target from a session they authenticated. That is a smaller boundary
   * than it looks: a bogus host key breaks only the connection that carries it,
   * because a mismatch is what `StrictHostKeyChecking=yes` refuses at run time.
   * A bogus PRIVATE key would be a credential the platform did not mint, which
   * is the whole reason this list exists.
   */
  it("drops a client-supplied private key, and keeps the host key", async () => {
    const fields: Record<string, unknown> = {
      ...base,
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nattacker\n",
    };
    const res = (await provisionCredentials(SSH_AUTH, fields, ctx))!;
    expect(res.private_key).not.toContain("attacker");
    expect(fields.private_key).toBeUndefined();

    // Supplied, therefore honoured — and still in the bag, because nothing
    // strips a name the platform does not own. `private_key` is the whole of
    // what it owns now.
    expect(res.host_key).toBe(HOST_KEY);
    expect(fields.host_key).toBe(HOST_KEY);
  });

  /**
   * The host key is the one field the platform refuses to guess. It decides
   * which file the install block tells the user to read their fingerprint
   * from, so an absent or unrecognised one must stop the mint rather than
   * render a block that checks nothing.
   */
  it("mints nothing without a usable host key", async () => {
    const { host_key: _dropped, ...noHostKey } = base;
    await expect(provisionCredentials(SSH_AUTH, { ...noHostKey }, ctx)).rejects.toThrow(
      /`host_key` is required/,
    );
    await expect(
      provisionCredentials(
        SSH_AUTH,
        { ...base, host_key: "ecdsa-sha2-nistp256 AAAAE2VjZHNh" },
        ctx,
      ),
    ).rejects.toThrow(/`host_key` must be a `ssh-ed25519 <base64>` or `ssh-rsa <base64>` line/);
  });
});

/**
 * The programmatic door, `POST .../connect/fields`, runs no provisioner: the
 * private key is whatever the caller stored, and the manifest's `pattern` only
 * pins the PEM armour. So the fields INSIDE that container — key type and
 * comment — are caller-chosen, and the install block is pasted as root.
 */
describe("a forged key container cannot reach the generated script", () => {
  const HOSTILE = "x'; touch /tmp/PWNED; echo '";

  function sshString(value: Buffer | string): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, bytes]);
  }

  function forgeContainer(keyType: string, comment: string): string {
    const point = randomBytes(32);
    const blob = Buffer.concat([sshString(keyType), sshString(point)]);
    const priv = Buffer.concat([
      Buffer.alloc(8), // the two checkints
      sshString(keyType),
      sshString(point),
      sshString(Buffer.concat([randomBytes(32), point])),
      sshString(comment),
    ]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(1);
    const container = Buffer.concat([
      Buffer.from("openssh-key-v1\0", "binary"),
      sshString("none"),
      sshString("none"),
      sshString(""),
      len,
      sshString(blob),
      sshString(priv),
    ]);
    return (
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      container.toString("base64") +
      "\n-----END OPENSSH PRIVATE KEY-----\n"
    );
  }

  it("renders nothing at all for a hostile key type", () => {
    const private_key = forgeContainer(`ssh-ed25519'; ${HOSTILE}`, "agent");
    expect(stepsOf({ ...base, private_key })).toEqual([]);
  });

  it("renders the key from its blob, so a hostile comment never appears", () => {
    const private_key = forgeContainer("ssh-ed25519", `${HOSTILE}\nrm -rf /`);
    const steps = stepsOf({ ...base, private_key });
    expect(steps.length).toBeGreaterThan(0);
    const rendered = JSON.stringify(steps);
    for (const hostile of ["PWNED", "touch /tmp", "rm -rf"]) {
      expect(rendered).not.toContain(hostile);
    }
    expect(installShell({ ...base, private_key })).toMatch(
      /'restrict ssh-ed25519 [A-Za-z0-9+/]+=* appstrate'/,
    );
  });
});

// ───────────────── the generated scripts, actually executed ─────────────────

interface ShellRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runScript(body: string, cwd?: string): Promise<ShellRun> {
  const file = join(await mkdtemp(join(tmpdir(), "ssh-handoff-")), "script.sh");
  await writeFile(file, body + "\n", { mode: 0o700 });
  const proc = Bun.spawn(["sh", file], {
    // A fresh environment but for PATH — these blocks are pasted into a root
    // shell whose environment the platform knows nothing about.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    cwd,
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

async function parses(script: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "ssh-handoff-")), "script.sh");
  await writeFile(file, script + "\n");
  const proc = Bun.spawn(["sh", "-n", file], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return `${code} ${stderr}`.trim();
}

describe("the generated install script", () => {
  it("is valid POSIX shell", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    expect(await parses(installShell(res))).toBe("0");
  });

  it("stops before touching anything when the account has no login shell", async () => {
    // `nobody` is /usr/bin/false on macOS and /usr/sbin/nologin on Debian —
    // both are the shape that runs no command. The guard runs before the first
    // `install`, so this is safe to execute unprivileged.
    const res = (await provisionCredentials(SSH_AUTH, { ...base, user: "nobody" }, ctx))!;
    const run = await runScript(installShell(res));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("shell de login");
    expect(run.stderr).not.toContain("authorized_keys");
  });
});

/**
 * The revoke block edits a file the platform will never see again, under
 * `set -eu`, so every way it can go wrong ends in a destroyed
 * `authorized_keys` rather than a visible error. Executed against a real file
 * here, with no seam: `~<user>` for an account that does not exist is left
 * literal by every POSIX shell, so running the block from a directory holding
 * `~<user>/.ssh/authorized_keys` exercises the PRODUCTION text unmodified.
 */
describe("the generated revoke script", () => {
  const ABSENT_USER = "notarealaccount";
  const keysDir = (cwd: string) => join(cwd, `~${ABSENT_USER}`, ".ssh");

  async function revokeAgainst(
    lines: string[] | null,
  ): Promise<{ run: ShellRun; left?: string; file: string }> {
    const cwd = await mkdtemp(join(tmpdir(), "ssh-revoke-"));
    const res = (await provisionCredentials(SSH_AUTH, { ...base, user: ABSENT_USER }, ctx))!;
    const keyBase64 = publicKeyFromOpenSshPrivateKey(res.private_key!).split(/\s+/)[1]!;
    const file = join(keysDir(cwd), "authorized_keys");
    if (lines) {
      await mkdir(keysDir(cwd), { recursive: true });
      await writeFile(file, lines.map((l) => l.replace("<KEY>", keyBase64)).join("\n") + "\n");
    }
    const run = await runScript(revokeShell(res), cwd);
    return { run, left: lines ? await readFile(file, "utf8") : undefined, file };
  }

  it("is valid POSIX shell", async () => {
    const res = (await provisionCredentials(SSH_AUTH, { ...base }, ctx))!;
    expect(await parses(revokeShell(res))).toBe("0");
  });

  it("removes this key's line and leaves every other one", async () => {
    const { run, left } = await revokeAgainst([
      "ssh-ed25519 AAAAsomeoneelse other@host",
      "restrict ssh-ed25519 <KEY> appstrate",
      "ssh-rsa AAAAthird third@host",
    ]);
    expect(`${run.code} ${run.stderr}`.trim()).toBe("0");
    expect(left).toBe("ssh-ed25519 AAAAsomeoneelse other@host\nssh-rsa AAAAthird third@host\n");
  });

  it("empties a file holding only this key, which grep reports as no match", async () => {
    // `grep -v` answers 1 when nothing survives the filter. Under `set -e`
    // that would abort BEFORE the write-back, leaving the revoked key in place.
    const { run, left } = await revokeAgainst(["restrict ssh-ed25519 <KEY> appstrate"]);
    expect(`${run.code} ${run.stderr}`.trim()).toBe("0");
    expect(left).toBe("");
  });

  it("exits cleanly, creating nothing, when there is no authorized_keys", async () => {
    // The write-back is `cat > "$keys"`, which would otherwise CREATE the file
    // the block was supposed to prune — and an empty authorized_keys on a home
    // the user still has is a locked-out account, not a no-op.
    const { run, file } = await revokeAgainst(null);
    expect(`${run.code} ${run.stderr}`.trim()).toBe("0");
    expect(await Bun.file(file).exists()).toBe(false);
  });
});

describe("provisionCredentials — no-op path", () => {
  it("returns null and leaves the bag alone for an auth with no provisioning", async () => {
    const fields = { api_key: "secret" };
    expect(await provisionCredentials({ type: "api_key" }, fields, ctx)).toBeNull();
    expect(fields).toEqual({ api_key: "secret" });
  });
});
