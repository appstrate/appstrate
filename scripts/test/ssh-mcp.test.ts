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
import { statSync } from "node:fs";
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
  classifyLs,
  OutputCapture,
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
  outputBytes?: number;
}

type Answer = {
  stdout?: string;
  stderr?: string;
  code?: number;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

/** Runner stub: records every invocation, answers from a queue. */
function stubRunner(answers: Answer[]) {
  const calls: Call[] = [];
  const run = async (
    argv: string[],
    opts: { stdin?: string; untilStderr?: RegExp; ceilingMs?: number; outputBytes?: number },
  ) => {
    calls.push({ argv, ...opts });
    const a = answers.shift() ?? {};
    return { ...a, stdout: a.stdout ?? "", stderr: a.stderr ?? "", code: a.code ?? 0 };
  };
  return { run, calls };
}

type Deps = {
  run: (argv: string[], opts: Omit<Call, "argv">) => Promise<Answer & { code: number | null }>;
  knownHostsPath: string;
};

/** `tools/call` through the real dispatcher; `payload` is the parsed result text. */
async function callTool(name: string, args: Record<string, unknown>, deps: Deps) {
  const res = await handleRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    deps,
  );
  const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
  const text = result.content[0]!.text;
  return { isError: result.isError, text, payload: JSON.parse(text) as Record<string, unknown> };
}

/**
 * A remote filesystem behind a fake `sftp`: answers the batch lines the server
 * sends (`ls -la`, `get`, `put`) the way OpenSSH's client prints them — a file
 * as one line naming the path verbatim, a directory as `<path>/<entry>` lines
 * with `.` and `..` — and records what was put.
 */
function fakeHost(fs: {
  files?: Record<string, string | Uint8Array>;
  dirs?: Record<string, string[]>;
  sizes?: Record<string, number>;
  /** The first N `put`s fail after truncating their target, as sftp's can. */
  failPuts?: number;
  /** Paths whose `put` sftp refuses at open, writing nothing (a read-only file). */
  readOnly?: string[];
}) {
  const files = { ...fs.files };
  let failPuts = fs.failPuts ?? 0;
  const putModes: Record<string, number> = {};
  const dirs = fs.dirs ?? {};
  const sizes = { ...fs.sizes };
  const written: Record<string, string> = {};
  const calls: Call[] = [];
  const lsLine = (type: string, size: number, path: string) =>
    `${type}rw-r--r--    ? agent    agent    ${String(size).padStart(8)} Sep 18 08:40 ${path}`;
  const run = async (argv: string[], opts: Omit<Call, "argv">) => {
    calls.push({ argv, ...opts });
    const out: string[] = [];
    const fail = (msg: string) => ({ stdout: out.join("\n"), stderr: `${msg}\n`, code: 1 });
    for (const line of (opts.stdin ?? "").trimEnd().split("\n")) {
      out.push(`sftp> ${line}`);
      const m = /^(ls -la|get|put) "([^"]*)"(?: "([^"]*)")?$/.exec(line);
      if (!m) return fail(`unexpected batch line: ${line}`);
      const [, cmd, a, b] = m as unknown as [string, string, string, string];
      if (cmd === "ls -la") {
        if (a in files) out.push(lsLine("-", sizes[a] ?? Buffer.byteLength(files[a]!), a));
        else if (a in dirs) {
          out.push(lsLine("d", 4096, `${a}/.`), lsLine("d", 4096, `${a}/..`));
          for (const e of dirs[a]!) out.push(lsLine(e.startsWith(".") ? "d" : "-", 1, `${a}/${e}`));
        } else return fail(`Can't ls: "${a}" not found`);
      } else if (cmd === "get") {
        if (!(a in files)) return fail(`File "${a}" not found.`);
        await Bun.write(b, files[a]!);
      } else {
        putModes[b] = statSync(a).mode & 0o777;
        if (fs.readOnly?.includes(b)) {
          // Verbatim shape of OpenSSH 9.2 and 10.2, absolute path and all.
          return fail(`dest open "/home/agent/${b.replace(/^\//, "")}": Permission denied`);
        }
        if (failPuts > 0) {
          failPuts--;
          files[b] = "";
          // Measured on a dropped transfer: sftp exits 141 (SIGPIPE) and says nothing.
          return { stdout: out.join("\n") + "\n", stderr: "", code: 141 };
        }
        const bytes = new Uint8Array(await Bun.file(a).arrayBuffer());
        written[b] = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
        files[b] = bytes;
        delete sizes[b];
      }
    }
    return { stdout: out.join("\n") + "\n", stderr: "", code: 0 };
  };
  return {
    written,
    files,
    putModes,
    calls,
    batches: () => calls.map((c) => c.stdin),
    deps: (): Deps => ({ run, knownHostsPath: join(scratch, "kh") }),
  };
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
      "ssh_edit_file",
      "ssh_exec",
      "ssh_probe",
      "ssh_read",
      "ssh_write_file",
    ]);
    expect(byName(listed)).toEqual(byName(manifest.tools));
    expect(TOOLS).toHaveLength(5);
  });

  // MCP clients read these hints to decide what needs a confirmation; a
  // reading tool marked destructive, or a writer marked read-only, misleads them.
  // "Read-only" is a property of the AGENT: the platform grants tools per agent
  // (`toolAllowlist`, enforced sidecar-side) from the "WRITES" the grant UI
  // shows, so that marker and `readOnlyHint` must name the same tools.
  it("annotates every tool with its exact MCP hints, agreeing with the WRITES marker", async () => {
    restoreEnv = withEnv({});
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = (res?.result as { tools: Array<{ name: string; annotations: unknown }> }).tools;
    const reads = { readOnlyHint: true, openWorldHint: true };
    const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
    expect(Object.fromEntries(listed.map((t) => [t.name, t.annotations]))).toEqual({
      ssh_probe: reads,
      ssh_read: reads,
      ssh_exec: { ...writes, idempotentHint: false },
      ssh_write_file: { ...writes, idempotentHint: true },
      ssh_edit_file: { ...writes, idempotentHint: false },
    });
    const marked = (TOOLS as Array<{ name: string; description: string }>)
      .filter((t) => t.description.includes("WRITES"))
      .map((t) => t.name);
    // The complement is what a read-only agent is granted.
    expect(marked.sort()).toEqual(["ssh_edit_file", "ssh_exec", "ssh_write_file"]);
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

  // A malformed call is the caller's to fix, whatever the server's state: the
  // argument error must not hide behind a configuration one.
  it.each([
    ["ssh_exec", { command: "x", timeout_seconds: 0 }, "`timeout_seconds` must be an integer"],
    ["ssh_read", { path: "/f", offset: 0 }, "`offset` must be an integer"],
    ["ssh_read", { path: "/{a,b}" }, "is expanded"],
    ["ssh_write_file", { path: "/f", content: 1 }, "`content` must be a string"],
    ["ssh_edit_file", { path: "/f", old_str: "", new_str: "x" }, "`old_str` must be a non-empty"],
  ])("%s refuses bad arguments before reading the configuration", async (name, args, reason) => {
    restoreEnv = withEnv({});
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const text = (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain(reason);
    expect(text).not.toContain("misconfigured");
  });

  it("rejects an unknown tool as a protocol error", async () => {
    for (const name of ["ssh_shell", "ssh_read_file", "ssh_list_dir", "toString", undefined]) {
      const res = await handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name },
      });
      expect(res?.error).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
    }
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
    expect(cfg.hostKey).toBe(HOST_KEY);
  });

  it("accepts `<type> <base64>`, normalised to a single space", () => {
    expect(parseHostKey(HOST_KEY)).toBe(HOST_KEY);
    expect(parseHostKey(" ssh-rsa \t AAAAB3NzaC1yc2EAAAA=\n")).toBe("ssh-rsa AAAAB3NzaC1yc2EAAAA=");
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
    expect(renderKnownHosts("example.com", 22, HOST_KEY)).toBe(`example.com ${HOST_KEY}\n`);
    expect(renderKnownHosts("example.com", 2222, HOST_KEY)).toBe(
      `[example.com]:2222 ${HOST_KEY}\n`,
    );
  });
});

// ─────────────────────────────── argv ────────────────────────────────

describe("buildSshArgs — the connection policy", () => {
  const has = (args: string[], opt: string) =>
    args.some((a, i) => args[i - 1] === "-o" && a === opt);

  it("emits the options in one fixed order, each exactly once", () => {
    const o = (kv: string) => ["-o", kv];
    expect(buildSshArgs(loadConfig(ENV), "/kh", undefined, { noSession: true })).toEqual([
      "-F",
      "/dev/null",
      ...o("BatchMode=yes"),
      ...o("StrictHostKeyChecking=yes"),
      ...o("UserKnownHostsFile=/kh"),
      ...o("IdentitiesOnly=yes"),
      ...o("IdentityFile=/run/secrets/ssh_key"),
      ...o("PasswordAuthentication=no"),
      ...o("KbdInteractiveAuthentication=no"),
      ...o("ForwardAgent=no"),
      ...o("ForwardX11=no"),
      ...o("ConnectTimeout=15"),
      ...o("ServerAliveInterval=15"),
      ...o("ServerAliveCountMax=3"),
      ...o("LogLevel=ERROR"),
      "-N",
      "-p",
      "22",
      "--",
      "agent@example.com",
    ]);
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
    const res = await callTool(
      "ssh_exec",
      { command: "hostname" },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).toBe("ssh");
    expect(calls[0]!.argv.at(-1)).toBe("hostname");
    expect(calls[0]!.argv.filter((a) => a.startsWith("LogLevel="))).toEqual(["LogLevel=ERROR"]);
    expect(res.isError).toBeUndefined();
    expect(res.payload).toMatchObject({
      command_sent: "hostname",
      exit_code: 42,
      timed_out: false,
    });
  });

  it("refuses a malformed request BEFORE spawning anything", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([]);
    const res = await callTool(
      "ssh_exec",
      { command: "" },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("non-empty string");
  });

  // 255 is ssh's own failure status, so it is thrown — with a hint — not
  // returned as the command's exit code.
  it("reports a host-key mismatch with a hint and never retries", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([{ stderr: "Host key verification failed.\n", code: 255 }]);
    const res = await callTool(
      "ssh_exec",
      { command: "hostname" },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(calls).toHaveLength(1);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("ssh failed (exit 255)");
    expect(res.text).toMatch(/pinned host key does not match/);
  });

  it("kills after 120 s by default and after `timeout_seconds` when given", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([{}, {}]);
    const deps = { run, knownHostsPath: join(scratch, "kh") };
    const first = await callTool("ssh_exec", { command: "true" }, deps);
    const second = await callTool("ssh_exec", { command: "true", timeout_seconds: 600 }, deps);
    expect(calls.map((c) => c.ceilingMs)).toEqual([120_000, 600_000]);
    expect(first.payload.timeout_seconds).toBe(120);
    expect(second.payload.timeout_seconds).toBe(600);
  });

  it.each([0, 601, 1.5, "30", null])(
    "refuses timeout_seconds=%p before spawning anything",
    async (timeout) => {
      restoreEnv = withEnv(ENV);
      const { run, calls } = stubRunner([]);
      const res = await callTool(
        "ssh_exec",
        { command: "true", timeout_seconds: timeout },
        { run, knownHostsPath: join(scratch, "kh") },
      );
      expect(calls).toHaveLength(0);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("`timeout_seconds` must be an integer from 1 to 600");
    },
  );

  /** Stands a real local process in for `ssh`, through the real runner. */
  const localProcess = (script: string): Deps => ({
    run: (_argv, opts) => runProcess(["bun", "-e", script], opts),
    knownHostsPath: join(scratch, "kh"),
  });

  // Measured on OpenSSH 9.2: killing the local client after `sleep 30` left the
  // remote sleep running. The call reports that instead of claiming a kill.
  it("returns on timeout with what was written so far, flagged timed_out", async () => {
    restoreEnv = withEnv(ENV);
    const res = await callTool(
      "ssh_exec",
      { command: "long", timeout_seconds: 1 },
      localProcess(
        'process.stdout.write("partial-out\\n"); process.stderr.write("partial-err\\n"); await Bun.sleep(30_000)',
      ),
    );
    expect(res.isError).toBeUndefined();
    expect(res.payload).toMatchObject({
      exit_code: null,
      timed_out: true,
      stdout: "partial-out\n",
      stderr: "partial-err\n\n(killed after 1000 ms)",
    });
    expect(res.payload.note).toContain("the remote process may still be running");
  });

  it("does not flag a command that exits 124 by itself as timed out", async () => {
    restoreEnv = withEnv(ENV);
    const res = await callTool("ssh_exec", { command: "x" }, localProcess("process.exit(124)"));
    expect(res.payload).toMatchObject({ exit_code: 124, timed_out: false });
    expect(res.payload.note).toBeUndefined();
  });

  // The end of a failing build's output is where its error is: a head-only cut
  // would drop exactly the line the agent needs.
  it("keeps the head and the tail of an oversized stream around a marker", async () => {
    restoreEnv = withEnv(ENV);
    const half = 32 * 1024;
    const res = await callTool(
      "ssh_exec",
      { command: "make" },
      localProcess(
        `for (const [c, n] of [["A", ${half}], ["X", 50000], ["Z", ${half}]]) await Bun.write(Bun.stdout, c.repeat(n)); console.error("short"); process.exit(2)`,
      ),
    );
    const out = res.payload.stdout as string;
    expect(out.startsWith("A".repeat(half) + "\n[… 50000 bytes omitted")).toBe(true);
    expect(out.endsWith("…]\n" + "Z".repeat(half))).toBe(true);
    expect(out).not.toContain("X");
    expect(res.payload.stderr).toBe("short\n");
    expect(res.payload.truncated).toBe(true);
    expect(res.payload.exit_code).toBe(2);
  });
});

describe("ssh_write_file", () => {
  // sftp creates a new remote file with the local file's mode, and the scratch
  // file is 0600: what an agent writes is private until it chmods it.
  it("uploads from a 0600 scratch file, under the sftp ceiling", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({});
    const res = await callTool(
      "ssh_write_file",
      { path: "/data/new.txt", content: "x" },
      host.deps(),
    );
    expect(res.payload).toEqual({ path: "/data/new.txt", bytes: 1 });
    expect(host.putModes["/data/new.txt"]).toBe(0o600);
    expect(host.batches()[0]).toBe('ls -la "/data/new.txt"\n'); // not found: a new file
    expect(host.batches()[1]).toMatch(/^put "[^"]+" "\/data\/new\.txt"\n$/);
    expect(host.written["/data/new.txt"]).toBe("x");
  });

  // Measured: `put` onto a directory drops the scratch file INSIDE it under its
  // random name and reports success.
  it("refuses a directory target, writing nothing", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ dirs: { "/srv": ["app"] } });
    const res = await callTool("ssh_write_file", { path: "/srv", content: "x" }, host.deps());
    expect(res.text).toContain("/srv is a directory");
    expect(host.batches()).toEqual(['ls -la "/srv"\n']);
  });

  it("refuses content over the 8 MiB ceiling before spawning anything", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({});
    const content = "x".repeat(8 * 1024 * 1024 + 1);
    const res = await callTool("ssh_write_file", { path: "/big", content }, host.deps());
    expect(res.text).toContain("`content` is 8388609 bytes, over the 8388608-byte ceiling");
    expect(host.batches()).toHaveLength(0);
  });

  it("says the target is unchanged when sftp refuses to open it", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/data/ro.txt": "old" }, readOnly: ["/data/ro.txt"] });
    const res = await callTool(
      "ssh_write_file",
      { path: "/data/ro.txt", content: "new" },
      host.deps(),
    );
    expect(res.text).toContain(
      'write refused, /data/ro.txt unchanged: dest open \\"/home/agent/data/ro.txt\\": Permission denied',
    );
    expect(res.text).not.toContain("truncated");
    expect(host.files["/data/ro.txt"]).toBe("old");
  });

  it("says the target may be truncated when the upload fails", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/data/out.txt": "old" }, failPuts: 1 });
    const res = await callTool(
      "ssh_write_file",
      { path: "/data/out.txt", content: "new" },
      host.deps(),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain(
      "write failed — /data/out.txt may be truncated: sftp failed (exit 141)",
    );
    // A mid-transfer failure is not a refused subsystem.
    expect(res.text).not.toMatch(/forced command/);
  });
});

describe("ssh_read", () => {
  const FIVE = "l1\nl2\nl3\nl4\nl5\n";

  it("lists a directory from one `ls -la`, dotfiles kept, sorted by name", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ dirs: { "/home/agent": ["motd.txt", ".ssh", "a file.txt"] } });
    const res = await callTool("ssh_read", { path: "/home/agent" }, host.deps());
    expect(host.batches()).toEqual(['ls -la "/home/agent"\n']);
    expect(res.payload.type).toBe("directory");
    expect((res.payload.entries as Array<{ name: string }>).map((e) => e.name)).toEqual([
      ".ssh",
      "a file.txt",
      "motd.txt",
    ]);
  });

  it("returns a file's lines numbered like `cat -n`", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": FIVE } });
    const res = await callTool("ssh_read", { path: "/etc/app.conf" }, host.deps());
    expect(host.batches()[0]).toBe('ls -la "/etc/app.conf"\n');
    expect(host.batches()[1]).toMatch(/^get "\/etc\/app\.conf" ".+"\n$/);
    expect(res.payload).toMatchObject({ type: "file", total_lines: 5, next_offset: null });
    expect(res.payload.content).toBe(
      "     1\tl1\n     2\tl2\n     3\tl3\n     4\tl4\n     5\tl5\n",
    );
  });

  it("returns the offset/limit window and says where the next one starts", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/f": FIVE } });
    const res = await callTool("ssh_read", { path: "/f", offset: 2, limit: 2 }, host.deps());
    expect(res.payload.content).toBe(
      "     2\tl2\n     3\tl3\n[lines 2-3 of 5 shown; call ssh_read with offset=4 to continue]",
    );
    expect(res.payload.next_offset).toBe(4);
  });

  it("stops at the byte cap, with a marker naming the next offset", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/big": `${"x".repeat(200)}\n`.repeat(3000) } });
    const res = await callTool("ssh_read", { path: "/big" }, host.deps());
    const content = res.payload.content as string;
    const next = res.payload.next_offset as number;
    const shown = next - 1;
    expect(shown).toBeGreaterThan(1000);
    expect(shown).toBeLessThan(2000); // the cap bound the window, not `limit`
    expect(
      content.endsWith(
        `[output cap of 262144 bytes reached: lines 1-${shown} of 3000 shown; call ssh_read with offset=${next} to continue]`,
      ),
    ).toBe(true);
    const body = content.slice(0, content.lastIndexOf("["));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(256 * 1024);
    expect(body.endsWith(`${String(shown).padStart(6)}\t${"x".repeat(200)}\n`)).toBe(true);
  });

  it("clips an overlong line and says how much was left out", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/min.js": "y".repeat(5000) } });
    const res = await callTool("ssh_read", { path: "/min.js" }, host.deps());
    expect(res.payload.content).toBe(
      `     1\t${"y".repeat(2000)}… [line cut: 3000 more characters; ssh_exec shows it whole]\n`,
    );
  });

  it("marks an empty file rather than returning nothing", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/empty": "" } });
    const res = await callTool("ssh_read", { path: "/empty" }, host.deps());
    expect(res.payload).toMatchObject({ content: "[empty file]", total_lines: 0 });
  });

  it.each([
    ["binary", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), "is binary"],
    ["latin-1", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), "is not UTF-8 text"],
  ])("refuses %s content instead of returning garbage", async (_kind, bytes, reason) => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/bin/x": bytes } });
    const res = await callTool("ssh_read", { path: "/bin/x" }, host.deps());
    expect(res.isError).toBe(true);
    expect(res.text).toContain(reason);
    expect(res.text).not.toContain("content");
  });

  it("refuses a file over the ceiling without downloading it", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/var/log/huge": "x" }, sizes: { "/var/log/huge": 9 << 20 } });
    const res = await callTool("ssh_read", { path: "/var/log/huge" }, host.deps());
    expect(res.isError).toBe(true);
    expect(res.text).toContain("over the 8388608-byte ceiling");
    expect(host.batches()).toHaveLength(1);
  });

  it("reports a missing path as an error", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({});
    const res = await callTool("ssh_read", { path: "/nope" }, host.deps());
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Can\'t ls: \\"/nope\\" not found');
  });

  it("refuses an offset past the end, and a limit over the maximum", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/f": FIVE } });
    const past = await callTool("ssh_read", { path: "/f", offset: 6 }, host.deps());
    expect(past.text).toContain("offset 6 is past the end of /f (5 lines)");
    const big = await callTool("ssh_read", { path: "/f", limit: 10_001 }, host.deps());
    expect(big.text).toContain("`limit` must be an integer from 1 to 10000");
  });

  // sftp's `ls` expands `{a,b}` even inside quotes, so the listing would name
  // other paths than the one asked for.
  it("refuses a path sftp's `ls` would brace-expand, before spawning", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({});
    const res = await callTool("ssh_read", { path: "/etc/{passwd,shadow}" }, host.deps());
    expect(res.isError).toBe(true);
    expect(res.text).toContain("is expanded");
    expect(host.batches()).toHaveLength(0);
  });

  // Real sftp output for these names (OpenSSH 9.2 and 10.2): no symlink target
  // is printed, and the name keeps its inner and trailing spaces.
  it("names entries whose names hold ` -> `, double or edge spaces", async () => {
    restoreEnv = withEnv(ENV);
    const names = [" lead", "a -> b", "trail ", "two  spaces"];
    const host = fakeHost({ dirs: { n: names } });
    const res = await callTool("ssh_read", { path: "n" }, host.deps());
    expect((res.payload.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(names);
  });

  it.each(["n/a -> b", "n/trail ", "n/ lead", "n/two  spaces"])(
    "reads %p as the file it names",
    async (path) => {
      restoreEnv = withEnv(ENV);
      const host = fakeHost({ files: { [path]: "x\n" } });
      const res = await callTool("ssh_read", { path }, host.deps());
      expect(res.payload).toMatchObject({ type: "file", content: "     1\tx\n" });
    },
  );

  it("cuts a long listing at the byte budget, says so, and points at ssh_exec", async () => {
    restoreEnv = withEnv(ENV);
    const names = Array.from(
      { length: 3000 },
      (_, i) => `entry-${String(i).padStart(4, "0")}-${"p".repeat(40)}`,
    );
    const host = fakeHost({ dirs: { "/big": names } });
    const res = await callTool("ssh_read", { path: "/big" }, host.deps());
    const shown = res.payload.entries as Array<{ name: string }>;
    expect(shown.length).toBeGreaterThan(500);
    expect(shown.length).toBeLessThan(3000);
    expect(shown.map((e) => e.name)).toEqual(names.slice(0, shown.length));
    expect(res.payload.truncated).toBe(true);
    expect(res.payload.note).toContain(`listing cut to ${shown.length} entries`);
    expect(res.payload.note).toContain("ssh_exec");
    expect(Buffer.byteLength(res.text)).toBeLessThan(300 * 1024);
  });

  it("reports a listing the runner had to cut as incomplete, dropping the cut line", async () => {
    restoreEnv = withEnv(ENV);
    const row = (n: string) => `-rw-r--r--    ? a        a               1 Sep 18 08:40 /d/${n}`;
    const { run } = stubRunner([
      {
        stdout: `sftp> ls -la "/d"\n${row("a")}\n${row("b")}\n${row("c").slice(0, 30)}\n[… 9 bytes omitted: output over 8 bytes, head and tail kept …]\n${row("z")}\n`,
        stdoutTruncated: true,
      },
    ]);
    const res = await callTool(
      "ssh_read",
      { path: "/d" },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(res.payload.truncated).toBe(true);
    expect((res.payload.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("does not call a listing incomplete because stderr overflowed", async () => {
    restoreEnv = withEnv(ENV);
    const row = "-rw-r--r--    ? a        a               1 Sep 18 08:40 /d/a";
    const { run } = stubRunner([{ stdout: `${row}\n`, stderrTruncated: true }]);
    const res = await callTool(
      "ssh_read",
      { path: "/d" },
      { run, knownHostsPath: join(scratch, "kh") },
    );
    expect(res.payload.truncated).toBe(false);
  });

  it("refuses offset or limit on a directory", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ dirs: { "/etc": ["hosts"] } });
    for (const extra of [{ offset: 1 }, { limit: 10 }]) {
      const res = await callTool("ssh_read", { path: "/etc", ...extra }, host.deps());
      expect(res.text).toContain("/etc is a directory; offset and limit apply to files only");
    }
  });

  // 2000 characters, not 2000 UTF-16 units: an emoji is one character.
  it("clips by code points, never splitting or double-counting a pair", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/fits": "😀".repeat(1500), "/long": "😀".repeat(3000) } });
    const fits = await callTool("ssh_read", { path: "/fits" }, host.deps());
    expect(fits.payload.content).toBe(`     1\t${"😀".repeat(1500)}\n`);
    const long = await callTool("ssh_read", { path: "/long" }, host.deps());
    expect(long.payload.content).toBe(
      `     1\t${"😀".repeat(2000)}… [line cut: 1000 more characters; ssh_exec shows it whole]\n`,
    );
  });

  const failWith = async (stderr: string): Promise<string> => {
    restoreEnv = withEnv(ENV);
    const { run } = stubRunner([{ stderr, code: 255 }]);
    return (
      await callTool("ssh_read", { path: "/data" }, { run, knownHostsPath: join(scratch, "kh") })
    ).text;
  };

  it("names a forced command when the closed channel is all the target said", async () => {
    expect(await failWith("Connection closed\n")).toMatch(/forced command/);
  });

  // A `Connection closed` that TRAILS a diagnostic is that diagnostic's
  // consequence: a refused destination is not a forced command, and sending the
  // operator to sshd_config over it costs an afternoon.
  it("stays silent when the closed channel only trails another error", async () => {
    const text = await failWith("hostname contains invalid characters\r\nConnection closed\r\n");
    expect(text).toContain("invalid characters");
    expect(text).not.toMatch(/forced command/);
  });
});

describe("ssh_edit_file", () => {
  const CONF = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
  const edit = (host: ReturnType<typeof fakeHost>, args: Record<string, unknown>) =>
    callTool("ssh_edit_file", { path: "/etc/app.conf", ...args }, host.deps());

  it("replaces the one occurrence, writes in place, and shows the edited lines", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": CONF } });
    const res = await edit(host, { old_str: "e\n", new_str: "E1\nE2\n" });
    expect(res.isError).toBeUndefined();
    expect(host.written["/etc/app.conf"]).toBe("a\nb\nc\nd\nE1\nE2\nf\ng\nh\ni\nj\n");
    expect(res.payload).toMatchObject({ replacements: 1, bytes: 24 });
    // Three lines of context each side of lines 5-6; the file goes on past 9.
    expect(res.payload.snippet).toBe(
      ["b", "c", "d", "E1", "E2", "f", "g", "h"]
        .map((l, i) => `${String(i + 2).padStart(6)}\t${l}\n`)
        .join(""),
    );
  });

  // `put` without `-p` truncates and rewrites the existing file, so its mode,
  // owner and links survive; `-p`, a chmod or a rename would each lose one.
  it("stats, gets, then plain-puts back onto the same path — nothing else", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": CONF } });
    await edit(host, { old_str: "b", new_str: "B" });
    const [ls, get, put] = host.batches();
    expect(host.batches()).toHaveLength(3);
    expect(ls).toBe('ls -la "/etc/app.conf"\n');
    expect(get).toMatch(/^get "\/etc\/app\.conf" "[^"]+"\n$/);
    expect(put).toMatch(/^put "[^"]+" "\/etc\/app\.conf"\n$/);
    expect(host.calls.map((c) => c.ceilingMs)).toEqual([120_000, 120_000, 120_000]);
  });

  it("refuses when old_str is absent, and writes nothing", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": CONF } });
    const res = await edit(host, { old_str: "zzz", new_str: "y" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("old_str was not found in /etc/app.conf");
    expect(host.written).toEqual({});
  });

  it("refuses an ambiguous old_str, naming the count, unless replace_all", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": "x=1\nx=1\nx=1\n" } });
    const res = await edit(host, { old_str: "x=1", new_str: "x=2" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("old_str occurs 3 times in /etc/app.conf");
    expect(host.written).toEqual({});

    const all = await edit(host, { old_str: "x=1", new_str: "x=2", replace_all: true });
    expect(all.payload.replacements).toBe(3);
    expect(host.written["/etc/app.conf"]).toBe("x=2\nx=2\nx=2\n");
  });

  it.each([
    [{ old_str: "", new_str: "x" }, "`old_str` must be a non-empty string"],
    [{ old_str: "b", new_str: "b" }, "`old_str` and `new_str` are identical"],
    [{ old_str: "b", new_str: "c", replace_all: "yes" }, "`replace_all` must be a boolean"],
  ])("refuses %p before spawning anything", async (args, reason) => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": CONF } });
    const res = await edit(host, args);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(reason);
    expect(host.batches()).toHaveLength(0);
  });

  it("refuses a binary file and a file over the ceiling, writing nothing", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({
      files: { "/bin/tool": Buffer.from([0x62, 0x00, 0x63]), "/big": "b" },
      sizes: { "/big": 9 << 20 },
    });
    const bin = await callTool(
      "ssh_edit_file",
      { path: "/bin/tool", old_str: "b", new_str: "B" },
      host.deps(),
    );
    expect(bin.text).toContain("is binary");
    const big = await callTool(
      "ssh_edit_file",
      { path: "/big", old_str: "b", new_str: "B" },
      host.deps(),
    );
    expect(big.text).toContain("over the 8388608-byte ceiling");
    expect(host.written).toEqual({});
  });

  it("refuses a directory", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ dirs: { "/etc": ["app.conf"] } });
    const res = await callTool(
      "ssh_edit_file",
      { path: "/etc", old_str: "a", new_str: "b" },
      host.deps(),
    );
    expect(res.text).toContain("/etc is a directory");
  });

  it("hints at CRLF when old_str spans a bare \\n in a CRLF file", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": "a=1\r\nb=2\r\n", "/lf": "a=1\nb=2\n" } });
    const crlf = await edit(host, { old_str: "a=1\nb=2", new_str: "x" });
    expect(crlf.text).toContain("CRLF line endings");
    const lf = await callTool(
      "ssh_edit_file",
      { path: "/lf", old_str: "a=1\nb=3", new_str: "x" },
      host.deps(),
    );
    expect(lf.text).toContain("was not found");
    expect(lf.text).not.toContain("CRLF");
  });

  // `put` truncates before it streams, so a failed write can leave the file cut
  // short; the original bytes are put back once, and the report says which.
  it("restores the original when the write fails, and says so", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": CONF }, failPuts: 1 });
    const res = await edit(host, { old_str: "b", new_str: "B" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("write failed; original restored: sftp failed");
    expect(host.written["/etc/app.conf"]).toBe(CONF);
    expect(host.batches()).toHaveLength(4);
  });

  it("reports a refused open as unchanged, without a restore attempt", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": CONF }, readOnly: ["/etc/app.conf"] });
    const res = await edit(host, { old_str: "b", new_str: "B" });
    expect(res.text).toContain("write refused, /etc/app.conf unchanged: dest open");
    expect(res.text).not.toContain("restore");
    expect(host.batches()).toHaveLength(3); // ls, get, the refused put — no second put
    expect(host.files["/etc/app.conf"]).toBe(CONF);
  });

  it("says the file may be truncated when the restore fails too", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": CONF }, failPuts: 2 });
    const res = await edit(host, { old_str: "b", new_str: "B" });
    expect(res.text).toContain("write failed and restore failed — /etc/app.conf may be truncated");
    expect(host.files["/etc/app.conf"]).toBe("");
  });

  // `String.replace` would read `$&` as "the match"; the agent's text is text.
  it("writes new_str literally, `$` patterns included, and keeps a byte-order mark", async () => {
    restoreEnv = withEnv(ENV);
    const host = fakeHost({ files: { "/etc/app.conf": "\uFEFFprice=1\n" } });
    await edit(host, { old_str: "1", new_str: "$&$1" });
    expect(host.written["/etc/app.conf"]).toBe("\uFEFFprice=$&$1\n");
  });
});

describe("ssh_probe", () => {
  it("authenticates with -N (no session) and reports the fingerprint", async () => {
    restoreEnv = withEnv(ENV);
    const { run, calls } = stubRunner([
      { code: 0 },
      { stdout: "256 SHA256:e9BAhcGr5z9zvM6nYcXrEt2BkBrTfpCQ/QSvw/h2INc example.com (ED25519)\n" },
    ]);
    const res = await callTool("ssh_probe", {}, { run, knownHostsPath: join(scratch, "kh") });
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
    expect(res.payload).toMatchObject({
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
  // Real OpenSSH output: the command echoed, every entry prefixed with the path
  // it was GIVEN, `?` for the link count, and no symlink target.
  const OUT = [
    'sftp> ls -la "/home/agent"',
    "drwx------    ? agent    agent        4096 Sep 18 08:40 /home/agent/.",
    "drwxr-xr-x    ? root     root         4096 Sep 18 08:39 /home/agent/..",
    "drwx------    ? agent    agent        4096 Sep 18 08:40 /home/agent/.ssh",
    "-rw-r--r--    ? agent    agent          27 Sep 18 08:40 /home/agent/motd.txt",
    "-rw-r--r--    ? agent    agent           5 Jan  1  2020 /home/agent/a file.txt",
    "lrwxrwxrwx    ? agent    agent           8 Sep 18 08:40 /home/agent/latest -> x",
    "",
  ].join("\n");

  it("names each entry after `<path>/`, dotfiles kept, `.` and `..` dropped", () => {
    expect(parseSftpLs(OUT, "/home/agent").map((e: { name: string }) => e.name)).toEqual([
      ".ssh",
      "a file.txt",
      "latest -> x",
      "motd.txt",
    ]);
  });

  it("keeps the line verbatim in `detail`, trailing spaces included", () => {
    const line = "-rw-r--r--    ? agent    agent           5 Sep 18 08:40 d/trail  ";
    expect(parseSftpLs(`${line}\r\n`, "d/")).toEqual([{ name: "trail  ", detail: line }]);
  });
});

describe("OutputCapture", () => {
  it("keeps whole characters at both cuts and counts the bytes left out", () => {
    const capture = new OutputCapture(5);
    capture.push(Buffer.from("é".repeat(10))); // 20 bytes, 2 kept each side
    expect(capture.truncated).toBe(true);
    expect(capture.render()).toBe(
      "é\n[… 16 bytes omitted: output over 5 bytes, head and tail kept …]\né",
    );
    const small = new OutputCapture(3);
    small.push(Buffer.from("abc"));
    expect([small.render(), small.truncated]).toEqual(["abc", false]);
  });

  // The runner feeds chunks as the pipe delivers them, splitting characters
  // anywhere; the rendering must not depend on where.
  it("renders chunked input exactly as one whole push", () => {
    const bytes = Buffer.from("héllo wörld 😀 ".repeat(20_000)); // ~340 KB, multibyte
    const whole = new OutputCapture(64 * 1024);
    whole.push(bytes);
    expect(whole.render()).toContain("bytes omitted: output over 65536 bytes");
    for (const size of [1, 3, 7, 4096, 65_537]) {
      const capture = new OutputCapture(64 * 1024);
      for (let i = 0; i < bytes.length; i += size) capture.push(bytes.subarray(i, i + size));
      expect(capture.render()).toBe(whole.render());
    }
  });
});

describe("classifyLs", () => {
  const line = (type: string, path: string) =>
    `${type}rw-r--r--    ? agent    agent         42 Sep 18 08:40 ${path}`;

  it("reads one line naming the path verbatim as a file, with its size", () => {
    expect(classifyLs(`sftp> ls\n${line("-", "/etc/a b.conf")}\n`, "/etc/a b.conf")).toEqual({
      kind: "file",
      size: 42,
    });
  });

  // A directory holding one entry of its own name, listed by a server that
  // sends no `.`/`..`, is still one line — but it names `<path>/<entry>`.
  it("reads anything else as a directory, `.`/`..` or not", () => {
    const r = classifyLs(line("-", "/srv/b/b"), "/srv/b");
    expect(r).toEqual({
      kind: "directory",
      entries: [{ name: "b", detail: line("-", "/srv/b/b") }],
    });
    expect(classifyLs("", "/empty")).toEqual({ kind: "directory", entries: [] });
    // Relative `b` holding `x b`: the line ends in ` b`, but `b/x` is not metadata.
    expect(classifyLs(line("-", "b/x b"), "b")).toMatchObject({ kind: "directory" });
    expect(classifyLs(line("-", "a -> b"), "a -> b")).toEqual({ kind: "file", size: 42 });
  });

  it("refuses a device, socket or pipe", () => {
    expect(() => classifyLs(line("c", "/dev/zero"), "/dev/zero")).toThrow(/neither a regular file/);
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

  it("kills on the ceiling, reports no exit code and keeps what was written", async () => {
    const res = await runProcess(
      ["bun", "-e", 'process.stdout.write("so far"); await Bun.sleep(30_000)'],
      { ceilingMs: 500 },
    );
    expect(res).toMatchObject({ code: null, timedOut: true, stdout: "so far" });
    expect(res.stderr).toContain("killed after 500 ms");
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

// ───────────────────────────── session dir ───────────────────────────

// The session directory holds `known_hosts` and the sftp scratch files, and
// nothing unlinks it while the server runs. A real child process is the only
// way to observe the `exit` hook: the stdin loop ending is the normal end of
// this server, and an in-process test never reaches it.
describe("session directory", () => {
  it("is removed when the process ends", async () => {
    const home = await mkdtemp(join(tmpdir(), "ssh-mcp-home-"));
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `const { readdirSync } = await import("node:fs");
         const server = await import(process.env.SERVER_ENTRY);
         await server.probeTool({ run: async () => ({ stdout: "", stderr: "", code: 0 }) });
         console.log(JSON.stringify(readdirSync(process.env.HOME)));`,
      ],
      {
        env: {
          ...process.env,
          ...ENV,
          HOME: home,
          SERVER_ENTRY: join(SOURCES, serverDir, "server/index.ts"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const whileRunning = JSON.parse((await new Response(child.stdout).text()).trim());
    await child.exited;

    expect(whileRunning).toEqual([expect.stringMatching(/^\.appstrate-ssh-/)]);
    expect(await readdir(home)).toEqual([]);
    await rm(home, { recursive: true, force: true });
  });
});
