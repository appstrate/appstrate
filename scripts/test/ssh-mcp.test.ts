// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `@appstrate/ssh-mcp` system package server.
 *
 * Every test here runs without an sshd: the tool logic takes an injectable
 * `Runner` (mirroring `fetchImpl` in the github-git suite), and the pure
 * helpers — argv construction, known_hosts rendering, host-key parsing, sftp
 * quoting — are exercised directly. What the argv tests pin is the POLICY:
 * a missing `StrictHostKeyChecking=yes` or a stray `ForwardAgent` is a
 * security regression, not a style change.
 *
 * Lives in `scripts/test/`, beside the other tests for `scripts/`, and NOT in
 * `apps/api/test/unit/`: it tests a SYSTEM PACKAGE, not the platform. A system
 * package is deletable by construction — remove its sources and its `.afps`
 * and the platform must be unaffected — and this file resolves those sources
 * at module load, so from the API suite it would take every unit file down
 * with it. Nor does it belong inside the package directory: `collectZipEntries`
 * (scripts/build-system-packages.ts) walks everything but `node_modules` and
 * dotfiles, so a `*.test.ts` there would ship inside the archive handed to
 * customers.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

// Resolved, not hard-coded: the source directory carries the package version
// in its name, so a static import breaks on every version bump.
const { readdir } = await import("node:fs/promises");
const SOURCES = join(import.meta.dir, "..", "system-packages");
const serverDir = (await readdir(SOURCES))
  .filter((d) => d.startsWith("mcp-server-ssh-"))
  .sort()
  .at(-1);
if (!serverDir) throw new Error("no mcp-server-ssh-* source directory found");

const {
  handleRequest,
  loadConfig,
  parseHostKey,
  renderKnownHosts,
  buildSshArgs,
  buildSftpArgs,
  quoteSftpPath,
  parseSftpLs,
  truncateUtf8,
  TOOLS,
  runProcess,
  _resetForTests,
} = await import(join(SOURCES, serverDir, "server/index.ts"));
const { parseConnectResponse, proxyUrlFromEnv } = await import(
  join(SOURCES, serverDir, "server/proxy-connect.ts")
);

/** The one accepted form: `<type> <base64>`, exactly what the manifest's pattern admits. */
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmvXHvkoa0xnL5aW6L2fPdQ8Q0m2p8Zt1YxV3q7uJ9k";

const ENV = {
  SSH_HOST: "example.com",
  SSH_PORT: "22",
  SSH_USER: "agent",
  SSH_PRIVATE_KEY_PATH: "/run/secrets/ssh_key",
  SSH_HOST_KEY: HOST_KEY,
};

/** Set process.env for the server's lazy config, restoring after. */
function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of [...Object.keys(ENV), "HTTPS_PROXY", "https_proxy", ...Object.keys(vars)]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

interface Call {
  argv: string[];
  stdin?: string;
  untilStderr?: RegExp;
  ceilingMs?: number;
}

/** Runner stub: records every invocation, answers from a queue. */
function stubRunner(answers: Array<{ stdout?: string; stderr?: string; code?: number }>) {
  const calls: Call[] = [];
  const run = async (
    argv: string[],
    opts: { stdin?: string; untilStderr?: RegExp; ceilingMs?: number },
  ) => {
    calls.push({
      argv,
      stdin: opts.stdin,
      untilStderr: opts.untilStderr,
      ceilingMs: opts.ceilingMs,
    });
    const a = answers.shift() ?? {};
    return { stdout: a.stdout ?? "", stderr: a.stderr ?? "", code: a.code ?? 0 };
  };
  return { run, calls };
}

let scratch: string;
let restoreEnv: () => void = () => {};

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ssh-mcp-test-"));
});
afterEach(async () => {
  restoreEnv();
  restoreEnv = () => {};
  await _resetForTests();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

// ───────────────────────────── protocol ──────────────────────────────

describe("handleRequest — protocol surface without any configuration", () => {
  it("answers initialize", async () => {
    restoreEnv = withEnv({});
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res?.result).toMatchObject({ protocolVersion: "2024-11-05" });
  });

  // The conformance gate spawns the server with an env allowlist that carries
  // no SSH_* variable, then diffs `tools/list` against the manifest, strictly.
  // Names AND descriptions: the manifest is what the platform shows when
  // granting tools, `tools/list` is what the agent reads, and two copies of
  // one sentence drift unless something diffs them.
  it("lists exactly the five declared tools, described as the manifest describes them", async () => {
    restoreEnv = withEnv({});
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = (res?.result as { tools: Array<{ name: string; description: string }> }).tools;
    const manifest = (await Bun.file(join(SOURCES, serverDir, "manifest.json")).json()) as {
      tools: Array<{ name: string; description: string }>;
    };
    const byName = (ts: Array<{ name: string; description: string }>) =>
      Object.fromEntries(ts.map((t) => [t.name, t.description]));

    expect(Object.keys(byName(listed)).sort()).toEqual([
      "ssh_exec",
      "ssh_list_dir",
      "ssh_probe",
      "ssh_read_file",
      "ssh_write_file",
    ]);
    expect(byName(listed)).toEqual(byName(manifest.tools));
    expect(TOOLS).toHaveLength(5);
  });

  it("reports misconfiguration on the first tool call, as a result, not a dead channel", async () => {
    restoreEnv = withEnv({});
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ssh_exec", arguments: { command: "hostname" } },
    });
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("misconfigured");
    expect(result.content[0]!.text).toContain("SSH_HOST");
  });

  it("rejects an unknown tool as a protocol error", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ssh_shell" },
    });
    expect(res?.error?.code).toBe(-32602);
  });

  it("ignores notifications and answers unknown methods with -32601", async () => {
    expect(await handleRequest({ jsonrpc: "2.0", method: "notifications/x" })).toBeNull();
    const res = await handleRequest({ jsonrpc: "2.0", id: 5, method: "nope" });
    expect(res?.error?.code).toBe(-32601);
  });
});

// ────────────────────────── configuration ────────────────────────────

describe("loadConfig / parseHostKey", () => {
  it("parses the full env", () => {
    const cfg = loadConfig(ENV);
    expect(cfg.host).toBe("example.com");
    expect(cfg.port).toBe(22);
    expect(cfg.hostKey.type).toBe("ssh-ed25519");
  });

  it("accepts `<type> <base64>` and nothing else", () => {
    expect(parseHostKey(HOST_KEY).type).toBe("ssh-ed25519");
    expect(parseHostKey("ssh-rsa AAAAB3NzaC1yc2EAAAA=").key).toBe("AAAAB3NzaC1yc2EAAAA=");
  });

  // No trust-on-first-use: a host key that is absent or unparseable must fail
  // configuration, not fall through to an interactive prompt that nobody is
  // there to answer. One accepted form — a three-column `ssh-keyscan` line, a
  // trailing comment and any other key type are all refused, not repaired.
  it("refuses a missing or malformed host key", () => {
    expect(() => loadConfig({ ...ENV, SSH_HOST_KEY: "" })).toThrow(/SSH_HOST_KEY is required/);
    expect(() => parseHostKey("SHA256:abcdef")).toThrow(/<type> <base64>/);
    expect(() => parseHostKey(`example.com ${HOST_KEY}`)).toThrow(/<type> <base64>/);
    expect(() => parseHostKey(`${HOST_KEY} root@example.com`)).toThrow(/<type> <base64>/);
    expect(() => parseHostKey("ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTI=")).toThrow(
      /<type> <base64>/,
    );
    expect(() => parseHostKey("ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1")).toThrow(
      /<type> <base64>/,
    );
  });

  /**
   * One reader of the proxy signal, shared with the ProxyCommand helper. Two
   * readers drift, and this one drifting means no ProxyCommand and a DIRECT
   * dial that skips the sidecar's SSRF floor entirely.
   */
  it.each(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])(
    "picks the proxy up from %s, exactly as the ProxyCommand helper does",
    (name) => {
      const cfg = loadConfig({ ...ENV, [name]: "http://sidecar:39472" });
      expect(cfg.proxyUrl).toBe("http://sidecar:39472");
      expect(cfg.proxyUrl).toBe(proxyUrlFromEnv({ [name]: "http://sidecar:39472" }));
    },
  );
});

describe("renderKnownHosts", () => {
  it("uses the bare host on port 22 and the bracketed form otherwise", () => {
    const hk = parseHostKey(HOST_KEY);
    expect(renderKnownHosts("example.com", 22, hk)).toBe(`example.com ssh-ed25519 ${hk.key}\n`);
    expect(renderKnownHosts("example.com", 2222, hk)).toBe(
      `[example.com]:2222 ssh-ed25519 ${hk.key}\n`,
    );
  });
});

// ─────────────────────────────── argv ────────────────────────────────

describe("buildSshArgs — the connection policy", () => {
  const has = (args: string[], opt: string) =>
    args.some((a, i) => args[i - 1] === "-o" && a === opt);

  it("pins the host key, the identity, and disables every prompt and forward", () => {
    const args = buildSshArgs(loadConfig(ENV), "/kh");
    expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    for (const opt of [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "UserKnownHostsFile=/kh",
      "IdentitiesOnly=yes",
      "IdentityFile=/run/secrets/ssh_key",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "ForwardAgent=no",
      "ForwardX11=no",
    ]) {
      expect(has(args, opt)).toBe(true);
    }
    expect(args.slice(-4)).toEqual(["-p", "22", "--", "agent@example.com"]);
  });

  it("appends the command string as the last argv entry, and nothing else", () => {
    const args = buildSshArgs(loadConfig(ENV), "/kh", "hostname");
    expect(args.at(-1)).toBe("hostname");
    expect(args.at(-2)).toBe("agent@example.com");
  });

  // Without the terminator a user or host starting with `-` is read as an
  // option (`-w…` lands as `Bad tun device`), and only the manifest's pattern
  // stands between a connect form and that. `--` is the argv-level floor.
  it("terminates the options with `--` immediately before the destination", () => {
    expect(buildSshArgs(loadConfig(ENV), "/kh").slice(-2)).toEqual(["--", "agent@example.com"]);
    expect(buildSshArgs(loadConfig(ENV), "/kh", "hostname").slice(-3)).toEqual([
      "--",
      "agent@example.com",
      "hostname",
    ]);
    expect(buildSftpArgs(loadConfig(ENV), "/kh").slice(-2)).toEqual(["--", "agent@example.com"]);
  });

  it("adds a ProxyCommand only when a proxy is configured", () => {
    const direct = buildSshArgs(loadConfig(ENV), "/kh");
    expect(direct.some((a: string) => a.startsWith("ProxyCommand="))).toBe(false);
    const proxied = buildSshArgs(loadConfig({ ...ENV, HTTPS_PROXY: "http://sidecar:8080" }), "/kh");
    const pc = proxied.find((a: string) => a.startsWith("ProxyCommand="));
    expect(pc).toMatch(/^ProxyCommand=bun .*proxy-connect\.ts %h %p$/);
  });

  it("sftp uses -P for the port and reads its batch from stdin", () => {
    const args = buildSftpArgs(loadConfig({ ...ENV, SSH_PORT: "2222" }), "/kh");
    expect(args.slice(-6)).toEqual(["-b", "-", "-P", "2222", "--", "agent@example.com"]);
    expect(has(args, "StrictHostKeyChecking=yes")).toBe(true);
  });
});

// ─────────────────────────── tool behaviour ──────────────────────────

describe("ssh_exec via injected runner", () => {
  // The command string reaches the login shell verbatim, and a non-zero exit
  // is the COMMAND's result — data for the agent, not a transport failure.
  it("hands the command to the login shell and returns its exit code as data", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([{ stdout: "web-01\n", code: 42 }]);
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: { command: "hostname" } },
      },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).toBe("ssh");
    expect(calls[0]!.argv.at(-1)).toBe("hostname");
    expect(calls[0]!.argv.filter((a) => a.startsWith("LogLevel="))).toEqual(["LogLevel=ERROR"]);
    const payload = JSON.parse(
      (res?.result as { content: Array<{ text: string }> }).content[0]!.text,
    );
    expect(payload.command_sent).toBe("hostname");
    expect(payload.exit_code).toBe(42);
    expect((res?.result as { isError?: boolean }).isError).toBeUndefined();
  });

  it("refuses a malformed request BEFORE spawning anything", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([]);
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: { command: "" } },
      },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(0);
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("non-empty string");
  });

  it("reports a host-key mismatch with a hint and never retries", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([{ stderr: "Host key verification failed.\n", code: 255 }]);
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: { command: "hostname" } },
      },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(1);
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/pinned host key does not match/);
  });
});

/**
 * "Read-only" is a property of the AGENT, not of the connection: the platform
 * grants tools per agent (`toolAllowlist`, enforced sidecar-side), so an agent
 * that must not change the target is simply not given `ssh_exec` or
 * `ssh_write_file`. This server therefore advertises which tools write, and
 * that advertisement is what the grant is made from.
 */
describe("ssh_write_file", () => {
  it("declares itself a writing tool, so a read-only agent is given the others", () => {
    const listed = TOOLS as Array<{ name: string; description: string }>;
    const writes = listed.filter((t) => t.description.includes("WRITES")).map((t) => t.name);
    expect(writes.sort()).toEqual(["ssh_exec", "ssh_write_file"]);

    // The complement is what a read-only agent is granted. Naming it here is
    // what keeps a new reading tool from being forgotten in that grant.
    const reads = listed.filter((t) => !t.description.includes("WRITES")).map((t) => t.name);
    expect(reads.sort()).toEqual(["ssh_list_dir", "ssh_probe", "ssh_read_file"]);
  });

  it("puts a scratch file when writes are allowed", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([{ code: 0 }]);
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ssh_write_file", arguments: { path: "/data/out.txt", content: "hello" } },
      },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).toBe("sftp");
    expect(calls[0]!.stdin).toMatch(/^put ".*" "\/data\/out\.txt"\n$/);
  });
});

describe("ssh_probe", () => {
  it("authenticates with -N (no session) and reports the fingerprint", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([
      { code: 0 },
      { stdout: "256 SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc example.com (ED25519)\n" },
    ]);
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ssh_probe", arguments: {} } },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls[0]!.argv[0]).toBe("ssh");
    // `-N` is an option: past the `--` it would be sent as the remote command,
    // which is the one thing the probe must not do.
    expect(calls[0]!.argv.at(-1)).toBe("agent@example.com");
    expect(calls[0]!.argv.indexOf("-N")).toBeLessThan(calls[0]!.argv.indexOf("--"));
    // `-N` holds the connection open after auth, so the probe must read
    // success off stderr and give up on a ceiling — never wait for an exit.
    expect(calls[0]!.untilStderr).toBeInstanceOf(RegExp);
    expect(
      calls[0]!.untilStderr!.test('Authenticated to h ([1.2.3.4]:22) using "publickey".'),
    ).toBe(true);
    expect(calls[0]!.ceilingMs).toBeGreaterThan(0);
    // OpenSSH keeps the FIRST `-o LogLevel` it sees and ignores later ones,
    // so the probe's argv must carry exactly one, and it must be VERBOSE.
    const levels = calls[0]!.argv.filter((a) => a.startsWith("LogLevel="));
    expect(levels).toEqual(["LogLevel=VERBOSE"]);
    expect(calls[1]!.argv[0]).toBe("ssh-keygen");
    const payload = JSON.parse(
      (res?.result as { content: Array<{ text: string }> }).content[0]!.text,
    );
    expect(payload).toMatchObject({
      reachable: true,
      host_key_fingerprint: "SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc",
      dialled_via: "direct",
    });
  });
});

// ─────────────────────────────── helpers ─────────────────────────────

describe("quoteSftpPath", () => {
  it("double-quotes an ordinary path, spaces included", () => {
    expect(quoteSftpPath("/data/my file.txt")).toBe('"/data/my file.txt"');
  });

  it("refuses what a batch line cannot carry", () => {
    for (const bad of ["", 'a"b', "a\\b", "a\nb", "-rf"]) {
      expect(() => quoteSftpPath(bad)).toThrow(/cannot be used/);
    }
  });
});

describe("parseSftpLs", () => {
  it("skips the command echo, keeps names with spaces, sorts", () => {
    const out = [
      'sftp> ls -l "/data"',
      "-rw-r--r--    1 1001     1001           27 Sep 18 08:40 motd.txt",
      "-rw-r--r--    1 1001     1001            5 Sep 18 08:40 a file.txt",
      "",
    ].join("\n");
    const entries = parseSftpLs(out);
    expect(entries.map((e: { name: string }) => e.name)).toEqual(["a file.txt", "motd.txt"]);
  });
});

describe("truncateUtf8", () => {
  it("cuts on a byte budget without emitting a broken sequence", () => {
    const { text, truncated } = truncateUtf8("ééé", 3); // each é is 2 bytes
    expect(truncated).toBe(true);
    expect(text).toBe("é");
    expect(truncateUtf8("abc", 3)).toEqual({ text: "abc", truncated: false });
  });
});

// ───────────────────────────── runProcess ────────────────────────────

// The real runner, against real subprocesses — no sshd needed. What is pinned
// is the shape `ssh -N` demands: settle on a stderr marker while the child is
// still running, and kill it; settle on a ceiling when nothing lands.
describe("runProcess — streaming path", () => {
  it("returns 0 as soon as stderr matches, killing a child that would run on", async () => {
    const started = performance.now();
    const res = await runProcess(
      [
        "bun",
        "-e",
        'console.error("Authenticated to h ([1.2.3.4]:22) using \\"publickey\\"."); await Bun.sleep(30_000)',
      ],
      { untilStderr: /^Authenticated to /m, ceilingMs: 10_000 },
    );
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("Authenticated to");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("reports the real exit code when the child exits before the marker", async () => {
    const res = await runProcess(
      ["bun", "-e", 'console.error("Permission denied (publickey)."); process.exit(255)'],
      {
        untilStderr: /^Authenticated to /m,
        ceilingMs: 10_000,
      },
    );
    expect(res.code).toBe(255);
    expect(res.stderr).toContain("Permission denied");
  });

  it("kills on the ceiling and reports 124", async () => {
    const res = await runProcess(["bun", "-e", "await Bun.sleep(30_000)"], { ceilingMs: 300 });
    expect(res.code).toBe(124);
    expect(res.stderr).toContain("killed after 300 ms");
  });
});

// ───────────────────────────── proxy-connect ─────────────────────────

describe("proxy-connect", () => {
  it("reads the proxy URL from the variables the sidecar sets", () => {
    expect(proxyUrlFromEnv({ HTTPS_PROXY: "http://sidecar:1" })).toBe("http://sidecar:1");
    expect(proxyUrlFromEnv({ https_proxy: " http://s:2 " })).toBe("http://s:2");
    expect(proxyUrlFromEnv({})).toBeNull();
  });

  it("accepts a 2xx and hands back the bytes after the header", () => {
    const v = parseConnectResponse(
      Buffer.from("HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0"),
    );
    expect(v?.ok).toBe(true);
    expect(v?.rest.toString()).toBe("SSH-2.0");
  });

  // A refused target must stay legible: the sidecar's status line is what
  // tells an SSRF refusal apart from a dead host.
  it("refuses a non-2xx and keeps the status line", () => {
    const v = parseConnectResponse(Buffer.from("HTTP/1.1 403 Forbidden\r\nX-Reason: ssrf\r\n\r\n"));
    expect(v?.ok).toBe(false);
    expect(v?.statusLine).toBe("HTTP/1.1 403 Forbidden");
  });

  it("waits for the header terminator", () => {
    expect(parseConnectResponse(Buffer.from("HTTP/1.1 200 OK\r\n"))).toBeNull();
  });
});

// A real TCP round-trip through the helper as a subprocess, against an
// in-process fake proxy: proves ssh's `%h %p` contract end to end.
describe("proxy-connect as a ProxyCommand subprocess", () => {
  let server: Server;
  let port = 0;
  let seen = "";

  beforeEach(async () => {
    server = createServer((sock) => {
      sock.once("data", (d) => {
        seen = d.toString();
        sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
        sock.write("SSH-2.0-fake\r\n");
        sock.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterEach(() => server.close());

  it("sends CONNECT host:port and splices the tunnel onto stdout", async () => {
    const proc = Bun.spawn(
      ["bun", join(SOURCES, serverDir, "server/proxy-connect.ts"), "target.example", "22"],
      {
        env: { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${port}` },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(seen).toMatch(/^CONNECT target\.example:22 HTTP\/1\.1\r\n/);
    expect(out).toBe("SSH-2.0-fake\r\n");
  });
});
