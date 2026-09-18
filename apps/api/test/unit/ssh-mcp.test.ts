// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `@appstrate/ssh-mcp` system package server.
 *
 * Every test here runs without an sshd: the tool logic takes an injectable
 * `Runner` (mirroring `fetchImpl` in the github-git suite), and the pure
 * helpers — argv construction, known_hosts rendering, verb resolution, sftp
 * quoting — are exercised directly. What the argv tests pin is the POLICY:
 * a missing `StrictHostKeyChecking=yes` or a stray `ForwardAgent` is a
 * security regression, not a style change.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

// Resolved, not hard-coded: the source directory carries the package version
// in its name, so a static import breaks on every version bump.
const { readdir } = await import("node:fs/promises");
const SOURCES = join(import.meta.dir, "../../../../scripts/system-packages");
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
  resolveVerb,
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

const KEYSCAN_LINE =
  "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmvXHvkoa0xnL5aW6L2fPdQ8Q0m2p8Zt1YxV3q7uJ9k";

const ENV = {
  SSH_HOST: "example.com",
  SSH_PORT: "22",
  SSH_USER: "agent",
  SSH_PRIVATE_KEY_PATH: "/run/secrets/ssh_key",
  SSH_HOST_KEY: KEYSCAN_LINE,
  SSH_ALLOWED_VERBS: JSON.stringify(["hostname", "read_motd"]),
  SSH_READ_ONLY: "1",
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
  it("lists exactly the five declared tools with no env", async () => {
    restoreEnv = withEnv({});
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (res?.result as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "ssh_exec",
      "ssh_list_dir",
      "ssh_probe",
      "ssh_read_file",
      "ssh_write_file",
    ]);
    expect(TOOLS).toHaveLength(5);
  });

  it("reports misconfiguration on the first tool call, as a result, not a dead channel", async () => {
    restoreEnv = withEnv({});
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ssh_exec", arguments: { verb: "hostname" } },
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
    expect(cfg.verbs).toEqual(["hostname", "read_motd"]);
    expect(cfg.readOnly).toBe(true);
    expect(cfg.hostKey.type).toBe("ssh-ed25519");
  });

  it("accepts the ssh-keyscan line and a bare `type key` pair alike", () => {
    expect(parseHostKey(KEYSCAN_LINE).type).toBe("ssh-ed25519");
    expect(parseHostKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmv").key).toBe(
      "AAAAC3NzaC1lZDI1NTE5AAAAIFmv",
    );
  });

  // No trust-on-first-use: a host key that is absent or unparseable must fail
  // configuration, not fall through to an interactive prompt that nobody is
  // there to answer.
  it("refuses a missing or malformed host key", () => {
    expect(() => loadConfig({ ...ENV, SSH_HOST_KEY: "" })).toThrow(/SSH_HOST_KEY is required/);
    expect(() => parseHostKey("SHA256:abcdef")).toThrow(/ssh-keyscan/);
    expect(() => parseHostKey("example.com dsa AAAA")).toThrow(/ssh-keyscan/);
  });

  it("refuses a non-array verb list", () => {
    expect(() => loadConfig({ ...ENV, SSH_ALLOWED_VERBS: '{"a":1}' })).toThrow(/array/);
    expect(() => loadConfig({ ...ENV, SSH_ALLOWED_VERBS: "not json" })).toThrow(/JSON/);
  });

  it("treats an empty verb list as no verbs", () => {
    expect(loadConfig({ ...ENV, SSH_ALLOWED_VERBS: "" }).verbs).toEqual([]);
  });
});

describe("renderKnownHosts", () => {
  it("uses the bare host on port 22 and the bracketed form otherwise", () => {
    const hk = parseHostKey(KEYSCAN_LINE);
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
    expect(args.slice(-3)).toEqual(["-p", "22", "agent@example.com"]);
  });

  it("appends the verb as the remote command, and nothing else", () => {
    const args = buildSshArgs(loadConfig(ENV), "/kh", "hostname");
    expect(args.at(-1)).toBe("hostname");
    expect(args.at(-2)).toBe("agent@example.com");
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
    expect(args.slice(-5)).toEqual(["-b", "-", "-P", "2222", "agent@example.com"]);
    expect(has(args, "StrictHostKeyChecking=yes")).toBe(true);
  });
});

// ─────────────────────────────── verbs ───────────────────────────────

describe("resolveVerb — exact match against a closed list", () => {
  const cfg = loadConfig(ENV);

  it("accepts a listed verb", () => {
    expect(resolveVerb(cfg, "hostname")).toBe("hostname");
  });

  it("refuses anything not listed, including shell-shaped strings", () => {
    for (const bad of [
      "rm -rf /",
      "hostname; id",
      "hostname && cat /etc/shadow",
      "HOSTNAME",
      "host",
      "",
    ]) {
      expect(() => resolveVerb(cfg, bad)).toThrow(/not in the allowlist|non-empty/);
    }
  });

  it("refuses a non-string", () => {
    expect(() => resolveVerb(cfg, { verb: "hostname" })).toThrow(/non-empty string/);
  });
});

// ─────────────────────────── tool behaviour ──────────────────────────

describe("ssh_exec via injected runner", () => {
  it("sends the bare verb and returns the verb's exit code as data", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([{ stdout: "refused verb: rm -rf /\n", code: 42 }]);
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: { verb: "hostname" } },
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

  it("refuses a verb outside the allowlist BEFORE spawning anything", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([]);
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: { verb: "cat /srv/data/canary.txt" } },
      },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(0);
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not in the allowlist");
  });

  it("reports a host-key mismatch with a hint and never retries", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([{ stderr: "Host key verification failed.\n", code: 255 }]);
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: { verb: "hostname" } },
      },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(1);
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/pinned host key does not match/);
  });
});

describe("ssh_write_file", () => {
  it("is refused by SSH_READ_ONLY without spawning", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([]);
    const res = await handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ssh_write_file", arguments: { path: "/x", content: "y" } },
      },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(0);
    expect((res?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "read-only",
    );
  });

  it("puts a scratch file when writes are allowed", async () => {
    restoreEnv = withEnv({ ...ENV, SSH_READ_ONLY: "0" });
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
    expect(calls[0]!.argv.at(-1)).toBe("-N");
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
      allowed_verbs: ["hostname", "read_motd"],
      read_only: true,
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
