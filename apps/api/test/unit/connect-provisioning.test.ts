// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning turns a four-field form (host, port, user, host_key) into a
 * full credential bag. What is worth pinning is therefore not "does it return
 * a key" but the boundaries: which names the client is allowed to influence,
 * which hosts are refused before anything is minted, and whether the script it
 * renders can be made to carry shell syntax.
 *
 * Both generated blocks are EXECUTED here, not only asserted on: the install
 * block for the arms that must hold before anything is touched (an sshd too old
 * for `restrict`, an account with no login shell), the revoke block for the
 * three outcomes that would otherwise destroy an `authorized_keys` instead of
 * pruning it.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
import {
  _setSystemPackagesForTesting,
  type SystemPackageEntry,
} from "../../src/services/system-packages.ts";

/**
 * Provisioning is honoured for system packages only, and the boot registry that
 * says which ids those are is empty under test — so this file installs one for
 * its own id and hands the registry back afterwards, since every file after it
 * in the same `bun test` process reads the same module state.
 */
const SSH_ID = "@appstrate/ssh";
let restoreRegistry: () => void;
/** One bundle for every test that only reads it; reconnect tests mint their own. */
let minted: Record<string, string>;
beforeAll(async () => {
  restoreRegistry = _setSystemPackagesForTesting(
    new Map([[SSH_ID, { packageId: SSH_ID } as SystemPackageEntry]]),
  );
  minted = (await provisionCredentials(SSH_ID, SSH_AUTH, { ...base }, null))!;
});
afterAll(() => restoreRegistry());

const SSH_AUTH = {
  type: "custom",
  _meta: {
    "dev.appstrate/provisioning": {
      kind: "ssh_keypair",
    },
  },
};

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
  const step = handoffStepsFor(SSH_ID, SSH_AUTH, credentials).find(
    (s) => s.kind === "command" && !!s.deferred === deferred,
  );
  if (!step || step.kind !== "command")
    throw new Error(`no ${deferred ? "teardown" : "install"} step`);
  return step.shell;
}
const installShell = (credentials: Record<string, string>) => shellOf(credentials, false);
const revokeShell = (credentials: Record<string, string>) => shellOf(credentials, true);
const stepsOf = (credentials: Record<string, string>) =>
  handoffStepsFor(SSH_ID, SSH_AUTH, credentials);

describe("readProvisioning", () => {
  it("returns null for an auth that declares nothing", () => {
    expect(readProvisioning(SSH_ID, { type: "custom" })).toBeNull();
    expect(readProvisioning(SSH_ID, null)).toBeNull();
  });

  /**
   * The manifest names the KIND and nothing else: what a kind mints is read
   * from the code table beside the provisioner. A manifest is immutable once
   * published, so a list inside one could only ever drift from the provisioner
   * it claims to describe.
   */
  it("derives the names the platform owns from the kind alone", () => {
    expect(readProvisioning(SSH_ID, SSH_AUTH)?.provides).toEqual(["private_key"]);
  });

  /**
   * The block has the platform mint a key and author a root install script, so
   * only a package the platform ships may declare it. Refused loudly: reading
   * it as "provisions nothing" would ask the user to type the key the manifest
   * expects to be minted.
   */
  it("refuses the block, and minting, on a package that is not a system package", async () => {
    expect(() => readProvisioning("@acme/ssh", SSH_AUTH)).toThrow(/only system packages may/);
    expect(() => authWithoutMintedCredentials("@acme/ssh", SSH_AUTH)).toThrow(
      /only system packages may/,
    );
    await expect(provisionCredentials("@acme/ssh", SSH_AUTH, { ...base }, null)).rejects.toThrow(
      /only system packages may/,
    );
  });

  it("reads nothing into a non-system package that declares no block", () => {
    expect(readProvisioning("@acme/ssh", { type: "custom" })).toBeNull();
  });

  it("answers no handoff steps rather than throwing, for a non-system package", () => {
    // The same complete bundle yields every step under the system id, so the
    // empty list below is the refusal and not an incomplete bundle.
    expect(handoffStepsFor(SSH_ID, SSH_AUTH, minted)).toHaveLength(3);
    // The deletion surface reads this: a refusal must never block a deletion.
    expect(handoffStepsFor("@acme/ssh", SSH_AUTH, minted)).toEqual([]);
  });

  it("throws on a kind this build has no provisioner for", () => {
    // Falling back to "the user types it" would silently turn a
    // platform-minted credential into a field nobody filled. Inherited
    // `Object.prototype` names are not kinds either.
    for (const kind of ["quantum_key", "toString", "__proto__"]) {
      const auth = { _meta: { "dev.appstrate/provisioning": { kind } } };
      expect(() => readProvisioning(SSH_ID, auth)).toThrow(/unknown credential provisioning kind/);
    }
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
    const shown = authWithoutMintedCredentials(SSH_ID, withSchema);
    expect(Object.keys(shown.credentials.schema.properties)).toEqual(["host", "user"]);
    expect(shown.credentials.schema.required).toEqual(["host", "user"]);
    // Everything else the form renders against survives untouched.
    expect(shown.credentials.schema.type).toBe("object");
    expect(shown.type).toBe("custom");
  });

  it("copies rather than writes through the manifest it was given", () => {
    // The manifest is shared: stripping it in place would strip it for the
    // submit door too, which validates against the FULL schema.
    authWithoutMintedCredentials(SSH_ID, withSchema);
    expect(Object.keys(withSchema.credentials.schema.properties)).toContain("private_key");
    expect(withSchema.credentials.schema.required).toContain("private_key");
  });

  it("hands back an auth that provisions nothing unchanged", () => {
    const plain = { type: "api_key", credentials: { schema: { properties: { api_key: {} } } } };
    expect(authWithoutMintedCredentials(SSH_ID, plain)).toBe(plain);
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
      provisionCredentials(SSH_ID, SSH_AUTH, { host, user: "agent", port: "22" }, null),
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
        provisionCredentials(SSH_ID, SSH_AUTH, { host: "127.0.0.1", user: "agent" }, null),
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
    await expect(provisionCredentials(SSH_ID, SSH_AUTH, { user: "agent" }, null)).rejects.toThrow(
      /`host` is required/,
    );
    await expect(provisionCredentials(SSH_ID, SSH_AUTH, badHostFree, null)).rejects.toThrow(
      /`user` is required/,
    );
  });

  it.each(["root; rm -rf /", "ag ent", "$(whoami)", "-oProxyCommand=x", "AGENT", "agent\nroot"])(
    "refuses %p as a Unix account name",
    async (user) => {
      // The account name is interpolated into the generated script, so the
      // character class is the whole defence — there is no quoting to rely on.
      await expect(
        provisionCredentials(SSH_ID, SSH_AUTH, { ...badHostFree, user }, null),
      ).rejects.toThrow(/Unix account name/);
    },
  );

  it.each(["0", "70000", "-1", "22abc"])("refuses port %p", async (port) => {
    await expect(
      provisionCredentials(SSH_ID, SSH_AUTH, { ...badHostFree, user: "agent", port }, null),
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
  it("mints an OpenSSH private key and pins the supplied host key", () => {
    expect(minted.private_key).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(minted.private_key).toEndWith("-----END OPENSSH PRIVATE KEY-----\n");
    expect(minted.host_key).toBe(HOST_KEY);
    expect(minted.port).toBe("2222");
    // The private half is never part of what is shown.
    expect(JSON.stringify(stepsOf(minted))).not.toContain("PRIVATE KEY");
  });

  it("points the fingerprint check at the key type it actually pinned", async () => {
    expect(installShell(minted)).toContain("/etc/ssh/ssh_host_ed25519_key.pub");

    // A server with no ed25519 host key pins RSA — and reading an ed25519 file
    // there would silently skip the check that the pinned key is this server's.
    const rsa = (await provisionCredentials(
      SSH_ID,
      SSH_AUTH,
      { ...base, host_key: RSA_HOST_KEY },
      null,
    ))!;
    expect(installShell(rsa)).toContain("/etc/ssh/ssh_host_rsa_key.pub");
    expect(installShell(rsa)).not.toContain("ed25519_key.pub");
  });

  /**
   * The handoff is data, and its SHAPE is the contract the SPA renders against:
   * typed steps with no SSH in it, each with a nonempty payload. The `id` is what
   * a localised client keys on, so renaming one silently drops a translation.
   * Exactly one command is deferred: the teardown.
   */
  it("describes the handoff as typed, identified steps", () => {
    const nonEmpty = expect.stringMatching(/\S/);
    expect(stepsOf(minted)).toMatchObject([
      { kind: "command", id: "ssh_install", label: nonEmpty, shell: nonEmpty },
      {
        kind: "value",
        id: "ssh_host_fingerprint",
        label: nonEmpty,
        // The SUPPLIED host key's fingerprint, not the minted key's.
        value: "SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc",
      },
      { kind: "command", id: "ssh_revoke", deferred: true, label: nonEmpty, shell: nonEmpty },
    ]);
    expect(stepsOf(minted).filter((s) => s.kind === "command" && s.deferred)).toHaveLength(1);
  });

  /**
   * The load-bearing property of the whole design: nothing about the handoff is
   * stored, so the block must be a pure function of the persisted bag.
   *
   * Pinned two ways. A bag narrowed to exactly the columns the keyring holds —
   * no extras carried over from the request — must render byte-identically to
   * the bag the provisioner returned, so the handoff needs no column of its
   * own.
   * And the list must be NON-EMPTY here, because `sshHandoffSteps` fails soft:
   * a regression that made the happy path fall into that branch would
   * otherwise hand the user nothing while every other assertion stayed green.
   */
  it("derives the same block from the stored bundle alone", () => {
    const atCreation = stepsOf(minted);
    expect(atCreation.length).toBeGreaterThan(0);

    // What `getIntegrationConnectionCredentialFields` hands back months later:
    // the stored names, nothing else, order not preserved.
    const readBack = {
      host_key: minted.host_key!,
      user: minted.user!,
      port: minted.port!,
      private_key: minted.private_key!,
      host: minted.host!,
    };
    expect(stepsOf(readBack)).toEqual(atCreation);
  });

  /**
   * The fail-soft branch itself: a bundle that cannot describe a step yields an
   * empty list, never a half-built command. `grep -vF ''` matches every line,
   * so a revoke block rendered from a missing key would empty the very
   * `authorized_keys` it was meant to prune.
   */
  it("renders nothing rather than a half-built command", () => {
    for (const missing of ["private_key", "user", "host_key"]) {
      const { [missing]: _dropped, ...partial } = minted;
      expect(stepsOf(partial)).toEqual([]);
    }
    // A private key that is not one parses to nothing, not to a block naming an
    // empty public half.
    expect(
      stepsOf({ ...minted, private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nnope" }),
    ).toEqual([]);
  });

  /**
   * `provides` is the boundary, and it covers exactly what the platform MINTS.
   * A client can send anything; what comes back for a minted name is the
   * platform's own value, which the route spreads OVER the submitted bag.
   *
   * `host_key` is deliberately NOT on it — it is the user's to supply, read off
   * the target from a session they authenticated. That is a smaller boundary
   * than it looks: a bogus host key breaks only the connection that carries it,
   * because a mismatch is what `StrictHostKeyChecking=yes` refuses at run time.
   * A bogus PRIVATE key would be a credential the platform did not mint, which
   * is the whole reason this list exists.
   */
  it("mints the private key whatever the body sent, and keeps the host key", async () => {
    const fields: Record<string, unknown> = {
      ...base,
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nattacker\n",
    };
    const res = (await provisionCredentials(SSH_ID, SSH_AUTH, fields, null))!;
    expect(res.private_key).not.toContain("attacker");
    expect(publicKeyFromOpenSshPrivateKey(res.private_key!)).toMatch(/^ssh-ed25519 /);

    // Supplied, therefore honoured: nothing overrides a name the platform does
    // not own. `private_key` is the whole of what it owns.
    expect(res.host_key).toBe(HOST_KEY);
  });

  /**
   * The host key is the one field the platform refuses to guess. It decides
   * which file the install block tells the user to read their fingerprint
   * from, so an absent or unrecognised one must stop the mint rather than
   * render a block that checks nothing.
   */
  it.each([
    ["an unsupported type", "ecdsa-sha2-nistp256 AAAAE2VjZHNh"],
    // The text says RSA, the blob says ed25519. Honouring the text would send
    // the user to read a fingerprint out of a file holding another key, so the
    // one comparison they make by eye would fail against the very key they
    // pinned.
    ["a blob that names another type", `ssh-rsa ${HOST_KEY.split(" ")[1]}`],
  ])("mints nothing for a host key with %s", async (_label, host_key) => {
    await expect(
      provisionCredentials(SSH_ID, SSH_AUTH, { ...base, host_key }, null),
    ).rejects.toThrow(/`host_key` must be a `ssh-ed25519 <base64>` or `ssh-rsa <base64>` line/);
  });

  it("mints nothing without a host key at all", async () => {
    const { host_key: _dropped, ...noHostKey } = base;
    await expect(provisionCredentials(SSH_ID, SSH_AUTH, { ...noHostKey }, null)).rejects.toThrow(
      /`host_key` is required/,
    );
  });
});

// ───────────────── the generated scripts, actually executed ─────────────────

interface ShellRun {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * A stand-in for `su` at the head of PATH. Every filesystem operation in these
 * blocks is handed to the account, and a test cannot become another account —
 * so this drops the `-s <shell> <user>` arguments and runs the payload as the
 * current user, over the `HOME` the caller points at its sandbox. That is
 * exactly the reach the real `su` gives the payload, and no more.
 */
let fakeSuBin: Promise<string> | null = null;
function fakeSuPath(): Promise<string> {
  fakeSuBin ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "ssh-fake-su-"));
    const script = [
      "#!/bin/sh",
      'while [ "$1" = "-s" ]; do shift 2; done',
      "shift",
      'exec /bin/sh "$@"',
      "",
    ].join("\n");
    await writeFile(join(dir, "su"), script, { mode: 0o755 });
    return dir;
  })();
  return fakeSuBin;
}

/** A one-command PATH head: a binary that behaves as `body` says, and no other. */
async function binWith(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ssh-bin-"));
  await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

/**
 * A stand-in for `sshd`, which the install block asks twice: `-V` for its
 * version, `-T` for whether it runs with PAM. `version` is the whole text it
 * prints for `-V`, on stderr and with a failing status, as an sshd that does not
 * know the flag answers — its usage text still carries the version. `config` is
 * what `-T` prints; null makes `-T` fail, as it does run unprivileged.
 */
function sshdStub(opts: { version: string; config?: string | null }): Promise<string> {
  const config = opts.config ?? null;
  return binWith(
    "sshd",
    [
      'case "$1" in',
      `  -V) printf '%s\\n' '${opts.version}' >&2; exit 1 ;;`,
      config === null ? "  -T) exit 1 ;;" : `  -T) printf '%s\\n' '${config}' ;;`,
      "esac",
    ].join("\n"),
  );
}

/**
 * Every run gets a current sshd whose `-T` fails unless the test says otherwise:
 * what the host running the suite has installed is not the subject, and an
 * unreadable `-T` is the case that keeps every warning on.
 */
let defaultSshdBin: Promise<string> | null = null;
const defaultSshd = () =>
  (defaultSshdBin ??= sshdStub({
    version: "sshd: illegal option -- V\nOpenSSH_9.2p1, OpenSSL 3.0",
  }));

async function runScript(
  body: string,
  opts: { home?: string; bin?: string; sshd?: string } = {},
): Promise<ShellRun> {
  const file = join(await mkdtemp(join(tmpdir(), "ssh-handoff-")), "script.sh");
  await writeFile(file, body + "\n", { mode: 0o700 });
  const proc = Bun.spawn(["sh", file], {
    // A fresh environment but for PATH — these blocks are pasted into a root
    // shell whose environment the platform knows nothing about. `HOME` is the
    // one the fake `su` above hands the payload, standing in for the account's;
    // `bin` heads the PATH, so a test can make one binary fail.
    env: {
      PATH: [
        opts.bin,
        opts.sshd ?? (await defaultSshd()),
        await fakeSuPath(),
        process.env.PATH ?? "/usr/bin:/bin",
      ]
        .filter(Boolean)
        .join(":"),
      ...(opts.home === undefined ? {} : { HOME: opts.home }),
    },
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
  it("stops before touching anything when the account has no login shell", async () => {
    // `nobody` is /usr/bin/false on macOS and /usr/sbin/nologin on Debian —
    // both are the shape that runs no command. The guard runs before the `su`,
    // so this is safe to execute unprivileged.
    const res = (await provisionCredentials(SSH_ID, SSH_AUTH, { ...base, user: "nobody" }, null))!;
    const run = await runScript(installShell(res));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("login shell");
    expect(run.stderr).not.toContain("authorized_keys");
  });

  /**
   * The fingerprint is how the user checks the host key they pinned is this
   * server's, and they make that check by eye. A heading over an empty line reads as "nothing to
   * compare", which is indistinguishable from "nothing to worry about" — so the
   * heading and a value are one outcome, and a warning is the other. Both arms
   * are pinned, because the block asks a `ssh-keygen` this test must stand in
   * for: whether the host running the suite HAS a host key is not the subject.
   */
  async function installWithSshKeygen(body: string): Promise<ShellRun> {
    return runScript(installShell(minted), {
      home: await mkdtemp(join(tmpdir(), "ssh-fingerprint-")),
      bin: await binWith("ssh-keygen", body),
    });
  }

  it("prints the fingerprint ssh-keygen reports, under its heading", async () => {
    const run = await installWithSshKeygen('echo "256 SHA256:TESTFP nobody@nowhere (ED25519)"');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("fingerprint of this host:");
    expect(run.stdout).toContain("  SHA256:TESTFP");
    expect(run.stderr).not.toContain("WARNING");
  });

  it.each([
    ["fails", "exit 3"],
    ["answers nothing", "exit 0"],
  ])("warns rather than heading an empty line when ssh-keygen %s", async (_label, body) => {
    const run = await installWithSshKeygen(body);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("fingerprint of this host");
    expect(run.stderr).toContain("no fingerprint could be read");
  });
});

/**
 * A dedicated account created with no password (`adduser -D`, `useradd` with
 * none) has a LOCKED password field, which an sshd built without PAM refuses
 * even for public-key login — `Permission denied (publickey)` mid-run, the
 * shape the login-shell guard exists to prevent. A PAM sshd accepts it, so the
 * block warns — unless `sshd -T` answers `usepam yes` — and installs the key
 * either way.
 *
 * The check reads /etc/shadow, which no sandbox can write. So the ONE literal
 * path is rewritten to a temp file and the otherwise untouched production text
 * is executed — a seam in the renderer would exist for nothing but this test.
 */
describe("the install block warns about a locked password", () => {
  async function installWithShadow(field: string | null, sshd?: string) {
    const home = await mkdtemp(join(tmpdir(), "ssh-shadow-"));
    const shell = installShell(minted);
    // Exactly one site, so the rewrite cannot silently miss or over-reach.
    expect(shell.split("/etc/shadow")).toHaveLength(2);

    let shadow = join(home, "absent-shadow");
    if (field !== null) {
      shadow = join(home, "shadow");
      await writeFile(shadow, `root:*:1::::::\nagent:${field}:1::::::\n`);
    }
    return {
      run: await runScript(shell.replace("/etc/shadow", shadow), { home, sshd }),
      keys: () => readFile(join(home, ".ssh", "authorized_keys"), "utf8"),
    };
  }

  it("warns, installs the key and still exits 0 for a locked account", async () => {
    const { run, keys } = await installWithShadow("!");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("the password of agent is locked");
    // The remedy is the one that keeps password login impossible.
    expect(run.stderr).toContain("echo 'agent:*' | chpasswd -e");
    expect(await keys()).toContain("restrict ssh-ed25519");
  });

  const FIELDS: Array<[string, string | null, boolean]> = [
    ["a lock in front of a hash", "!$6$salt$hash", true],
    ["the recommended `*`", "*", false],
    ["a real hash", "$6$salt$hash", false],
    ["no shadow file at all", null, false],
  ];

  it.each(FIELDS)("%s: warns = %p", async (_label, field, warns) => {
    const { run, keys } = await installWithShadow(field);
    expect(run.code).toBe(0);
    expect(run.stderr.includes("is locked")).toBe(warns);
    expect(await keys()).toContain("restrict ssh-ed25519");
  });

  /**
   * The lock only matters without PAM, and Debian, Ubuntu and CentOS all run
   * sshd with it — warning there is a false alarm on the common case. So the
   * block asks sshd itself. An sshd BUILT without PAM (Alpine) prints no
   * `usepam` line at all, and an `-T` that fails says nothing: both still warn.
   */
  const PAM: Array<[string, string | null, boolean]> = [
    ["usepam yes", "port 22\nusepam yes\npermitrootlogin no", false],
    ["usepam no", "port 22\nusepam no", true],
    ["no usepam line (built without PAM)", "port 22\npermitrootlogin no", true],
    ["sshd -T failing", null, true],
  ];

  it.each(PAM)("a locked account with %s: warns = %p", async (_label, config, warns) => {
    const sshd = await sshdStub({ version: "OpenSSH_9.2p1, OpenSSL 3.0", config });
    const { run, keys } = await installWithShadow("!", sshd);
    expect(run.code).toBe(0);
    expect(run.stderr.includes("the password of agent is locked")).toBe(warns);
    expect(await keys()).toContain("restrict ssh-ed25519");
  });
});

/**
 * `restrict` arrived in OpenSSH 7.2. An older sshd rejects the whole
 * authorized_keys line as a bad option, so the key would be installed and never
 * authenticate — the failure surfacing mid-run as `Permission denied`. The block
 * refuses before writing anything. The version is read from the target's sshd,
 * which prints it even for a `-V` it does not know (in its usage text).
 */
describe("the install block refuses an sshd older than OpenSSH 7.2", () => {
  async function installUnder(version: string) {
    const home = await mkdtemp(join(tmpdir(), "ssh-version-"));
    const run = await runScript(installShell(minted), {
      home,
      sshd: await sshdStub({ version }),
    });
    return { run, keys: join(home, ".ssh", "authorized_keys") };
  }

  it.each([
    ["6.6.1", "sshd: illegal option -- V\nOpenSSH_6.6.1p1 Ubuntu-2ubuntu2.13, OpenSSL 1.0.1f"],
    ["6.9", "OpenSSH_6.9p1, OpenSSL 1.0.2"],
    ["7.1", "OpenSSH_7.1p2, OpenSSL 1.0.2"],
  ])("refuses %s and writes nothing", async (shown, version) => {
    const { run, keys } = await installUnder(version);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`OpenSSH ${shown} is older than 7.2`);
    expect(run.stderr).toContain("'restrict'");
    expect(await Bun.file(keys).exists()).toBe(false);
    // Nothing after the refusal ran either.
    expect(run.stdout).not.toContain("fingerprint");
  });

  it.each([
    ["7.2", "OpenSSH_7.2p2 Ubuntu-4ubuntu2.10, OpenSSL 1.0.2g"],
    ["7.4", "OpenSSH_7.4p1, OpenSSL 1.0.2k-fips"],
    // A two-digit minor: a comparison on text would put 7.10 before 7.2.
    ["7.10", "OpenSSH_7.10p1, OpenSSL 1.1.1"],
    ["9.2", "OpenSSH_9.2p1 Debian-2+deb12u3, OpenSSL 3.0.13"],
    // A two-digit major: a comparison on the first digit would refuse it.
    ["10.3", "OpenSSH_10.3p1, OpenSSL 3.5.0"],
  ])("installs under %s", async (_shown, version) => {
    const { run, keys } = await installUnder(version);
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain("older than 7.2");
    expect(run.stderr).not.toContain("could not read the OpenSSH version");
    expect(await Bun.file(keys).text()).toContain("restrict ssh-ed25519");
  });

  it.each([
    ["an sshd that is not OpenSSH", "dropbear v2022.83"],
    ["an sshd that answers nothing", ""],
    ["no sshd at all", "sh: sshd: not found"],
    ["a version with no minor", "OpenSSH_7"],
  ])("warns and installs anyway under %s", async (_label, version) => {
    const { run, keys } = await installUnder(version);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("could not read the OpenSSH version");
    // One line: the key line may still work, so it is a warning, not a stop.
    expect(run.stderr.split("\n").filter((l) => l.includes("OpenSSH"))).toHaveLength(1);
    expect(await Bun.file(keys).text()).toContain("restrict ssh-ed25519");
  });
});

/**
 * These blocks are PASTED, and the documented way is into an interactive root
 * shell. There, a top-level `set -eu` outlives the paste and an `exit` closes
 * the session — so each block is one subshell, and everything it arms or exits
 * stays inside it.
 */
describe("the blocks survive being pasted into a live shell", () => {
  it("ends the block on a failure, leaves the shell running, and answers its status", async () => {
    // A `set -e` or `exit` that leaked out would take the whole paste — and the
    // session it was pasted into — down with the failing command.
    const bin = await binWith("su", "exit 7");
    for (const shell of [installShell(minted), revokeShell(minted)]) {
      const run = await runScript([shell, `echo STILL-HERE`].join("\n"), { bin });
      expect(run.stdout).toContain("STILL-HERE");
      expect((await runScript(shell, { bin })).code).toBe(7);
    }
  });
});

/**
 * `authorized_keys` is line-oriented and the platform never sees the one it
 * appends to. A last line with no newline is ordinary — several editors write
 * one — and appending onto it authorises nothing, mangles the key that was
 * there, and exits 0 with this key's base64 now in the file, so the idempotence
 * guard makes every replay a no-op.
 */
describe("the install block appends a whole line", () => {
  async function installInto(existing: string | null) {
    const home = await mkdtemp(join(tmpdir(), "ssh-append-"));
    const keys = join(home, ".ssh", "authorized_keys");
    if (existing !== null) {
      await mkdir(join(home, ".ssh"), { recursive: true });
      await writeFile(keys, existing);
    }
    const line = `restrict ${publicKeyFromOpenSshPrivateKey(minted.private_key!)} appstrate\n`;
    return {
      line,
      run: await runScript(installShell(minted), { home }),
      read: () => readFile(keys, "utf8"),
      again: () => runScript(installShell(minted), { home }),
    };
  }

  const PRESENT = "ssh-ed25519 AAAAsomeoneelse other@host";

  it("separates its line from a last line that has no newline", async () => {
    const { run, read, line } = await installInto(PRESENT);
    expect(run.code).toBe(0);
    // The key that was there is byte-identical, on a line of its own.
    expect(await read()).toBe(`${PRESENT}\n${line}`);
  });

  it("adds no blank line to a file that already ends with one newline", async () => {
    const { run, read, line } = await installInto(`${PRESENT}\n`);
    expect(run.code).toBe(0);
    expect(await read()).toBe(`${PRESENT}\n${line}`);
  });

  it.each([
    ["no file at all", null],
    ["a file that is empty", ""],
  ])("writes exactly one line when there is %s", async (_label, existing) => {
    const { run, read, line } = await installInto(existing);
    expect(run.code).toBe(0);
    expect(await read()).toBe(line);
  });

  it("adds nothing on a replay", async () => {
    const { read, again, line } = await installInto(PRESENT);
    const run = await again();
    expect(run.code).toBe(0);
    expect(await read()).toBe(`${PRESENT}\n${line}`);
  });
});

/**
 * The blocks are pasted AS ROOT, and every path under the account's home is a
 * path that account controls — it is the very account an agent gets a shell on,
 * and the install block invites a replay. So root resolves a login shell, reads
 * `/etc/ssh`, and hands every filesystem operation to `su`.
 */
describe("root performs no write under the account's home", () => {
  /** Everything outside the heredoc fed to `su` — the half root runs itself. */
  const rootHalf = (shell: string) =>
    shell.replace(/<<'APPSTRATE_SSH'\n[\s\S]*?\nAPPSTRATE_SSH/g, "<<'APPSTRATE_SSH'");

  it("leaves both blocks with nothing for root to open, create, chown or chmod", () => {
    for (const shell of [installShell(minted), revokeShell(minted)]) {
      const root = rootHalf(shell);
      expect(root).toContain("su -s /bin/sh agent <<'APPSTRATE_SSH'");
      for (const verb of ["chown", "chmod", "install ", ">>"]) {
        expect(root).not.toContain(verb);
      }
      // Root names no path under the home at all: the payload resolves `~`
      // itself, from the HOME `su` gives it.
      expect(root).not.toContain("~");
    }
  });

  it("follows a symlinked authorized_keys with the account's privilege, never root's", async () => {
    // A symlink cannot be made harmless here: writing through one is what the
    // ACCOUNT may already do to its own file. What must never happen is ROOT
    // opening, creating or chowning it — `chown agent /etc/shadow` on a replay.
    const home = await mkdtemp(join(tmpdir(), "ssh-symlink-"));
    const victim = join(home, "victim");
    const keys = join(home, ".ssh", "authorized_keys");
    await writeFile(victim, "VICTIM\n");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await symlink(victim, keys);

    const install = await runScript(installShell(minted), { home });
    expect(install.code).toBe(0);
    expect(await readFile(victim, "utf8")).toStartWith("VICTIM\n");
    expect(await readFile(victim, "utf8")).toContain("restrict ssh-ed25519");
    // Still a link: the block replaced nothing and created nothing beside it.
    expect((await lstat(keys)).isSymbolicLink()).toBe(true);

    // And the teardown prunes through the same link, back to the byte.
    const revoke = await runScript(revokeShell(minted), { home });
    expect(`${revoke.code} ${revoke.stderr}`.trim()).toBe("0");
    expect(await readFile(victim, "utf8")).toBe("VICTIM\n");
    expect((await lstat(keys)).isSymbolicLink()).toBe(true);
  });
});

/**
 * The revoke block edits a file the platform will never see again, under
 * `set -eu`, so every way it can go wrong ends in a destroyed
 * `authorized_keys` rather than a visible error. Executed against a real file
 * here, on the PRODUCTION text unmodified: the payload resolves `~` from the
 * `HOME` it is handed, which is the sandbox below.
 */
describe("the generated revoke script", () => {
  async function revokeAgainst(
    lines: string[] | null,
  ): Promise<{ run: ShellRun; left?: string; file: string }> {
    const home = await mkdtemp(join(tmpdir(), "ssh-revoke-"));
    const keyBase64 = publicKeyFromOpenSshPrivateKey(minted.private_key!).split(/\s+/)[1]!;
    const file = join(home, ".ssh", "authorized_keys");
    if (lines) {
      await mkdir(join(home, ".ssh"), { recursive: true });
      await writeFile(file, lines.map((l) => l.replace("<KEY>", keyBase64)).join("\n") + "\n");
    }
    const run = await runScript(revokeShell(minted), { home });
    return { run, left: lines ? await readFile(file, "utf8") : undefined, file };
  }

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

/**
 * Reconnecting is not a second connection: the public key already sits in the
 * target's `authorized_keys`, and the bundle that carries it is the only thing
 * a removal block can be derived from. Minting a fresh pair would strand it
 * there, and the platform cannot reach the host to take it out.
 *
 * Which binds reuse to the TARGET. A pair carried onto another host, port or
 * account would describe a line that is not there, while the line that IS there
 * loses the only bundle a teardown could be rendered from.
 */
describe("provisionCredentials — reconnect", () => {
  it("reuses the stored pair, so the installed line is the one already on the target", async () => {
    const first = (await provisionCredentials(SSH_ID, SSH_AUTH, { ...base }, null))!;
    const again = (await provisionCredentials(SSH_ID, SSH_AUTH, { ...base }, first))!;

    expect(again.private_key).toBe(first.private_key);
    expect(installShell(again)).toContain(publicKeyFromOpenSshPrivateKey(first.private_key!));
  });

  it.each([
    ["account", { user: "deploy" }],
    ["port", { port: "2200" }],
    ["host", { host: "other.example.test" }],
  ])("mints a fresh pair when the %s is not the one it was installed on", async (_label, moved) => {
    const first = (await provisionCredentials(SSH_ID, SSH_AUTH, { ...base }, null))!;
    const res = (await provisionCredentials(SSH_ID, SSH_AUTH, { ...base, ...moved }, first))!;

    expect(res.private_key).not.toBe(first.private_key);
    expect(installShell(res)).not.toContain(publicKeyFromOpenSshPrivateKey(first.private_key!));
  });

  it.each([
    ["armour with no container in it", "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n"],
    ["an empty string", ""],
    ["a value that is not one", 42],
    ["nothing at all", undefined],
  ])("mints a fresh pair when the stored half is %s", async (_label, private_key) => {
    // Nothing is protected by keeping bytes no block could be rendered from.
    // The bundle names the SAME target, so the target comparison passes and
    // what refuses the reuse can only be the key itself.
    const first = (await provisionCredentials(SSH_ID, SSH_AUTH, { ...base }, null))!;
    const res = (await provisionCredentials(
      SSH_ID,
      SSH_AUTH,
      { ...base },
      { ...base, private_key },
    ))!;

    expect(res.private_key).not.toBe(first.private_key);
    expect(publicKeyFromOpenSshPrivateKey(res.private_key!)).toMatch(/^ssh-ed25519 /);
  });
});

describe("provisionCredentials — no-op path", () => {
  it("returns null and leaves the bag alone for an auth with no provisioning", async () => {
    const fields = { api_key: "secret" };
    expect(await provisionCredentials(SSH_ID, { type: "api_key" }, fields, null)).toBeNull();
    expect(fields).toEqual({ api_key: "secret" });
  });
});
