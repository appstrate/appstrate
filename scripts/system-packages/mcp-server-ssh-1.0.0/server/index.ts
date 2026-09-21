// SPDX-License-Identifier: Apache-2.0

/**
 * SSH — reach one host over SSH (Bun, dependency-free).
 *
 * Shells out to the `ssh` / `sftp` clients baked into the bun runner image
 * (`runtime-pi/runners/bun/Dockerfile`), as `@appstrate/github-git-mcp` shells
 * out to `git`. The `@appstrate/ssh` integration delivers the private key as a
 * file (`delivery.files`) and the non-secret fields as env (`delivery.env`).
 *
 * Invariants:
 *  - The private key never enters the agent container: it reaches THIS process
 *    at `SSH_PRIVATE_KEY_PATH`, is read by `ssh` itself, and no tool returns or
 *    accepts key material.
 *  - The Unix account is the only boundary. "Read-only" is a per-agent tool
 *    grant (`toolAllowlist`, enforced sidecar-side), never a branch in here —
 *    the tool descriptions say which tools write.
 *  - No trust-on-first-use: the connection carries the host's public key
 *    (`SSH_HOST_KEY`), written to a private `known_hosts`, and
 *    `StrictHostKeyChecking=yes` refuses anything else.
 *
 * Boot is lazy: `initialize` / `tools/list` answer with no env at all (the
 * conformance probe spawns the server that way); a bad configuration is
 * reported on the first tool call, not as "server closed the connection".
 *
 * Hand-rolled rather than @modelcontextprotocol/sdk: the runner image has no
 * node_modules, and the surface is `initialize` + `tools/list` + `tools/call`
 * over line-delimited JSON-RPC.
 */

import { rmSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { proxyUrlFromEnv } from "./proxy-connect.ts";

// ──────────────────────────── configuration ───────────────────────────

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  privateKeyPath: string;
  /** The host's own public key, normalised to `<type> <base64>`. */
  hostKey: string;
  /** CONNECT proxy to dial through, when the runner has no direct route. */
  proxyUrl: string | null;
}

/**
 * Accept `<type> <base64>` — what the integration manifest's `host_key` pattern
 * admits, read off the target's `/etc/ssh/ssh_host_*_key.pub`. No host column
 * and no comment: what is pinned is the KEY, bound to this connection's host
 * and port by `renderKnownHosts`.
 */
export function parseHostKey(raw: string): string {
  const m = /^(ssh-ed25519|ssh-rsa)\s+([A-Za-z0-9+/]+=*)$/.exec(raw.trim());
  if (!m) {
    throw new Error(
      "SSH_HOST_KEY must be `<type> <base64>` — ssh-ed25519 or ssh-rsa, and the base64 key, " +
        "nothing else. There is no trust-on-first-use fallback.",
    );
  }
  return `${m[1]} ${m[2]}`;
}

/** `known_hosts` line for this connection — bracketed form when the port is not 22. */
export function renderKnownHosts(host: string, port: number, hostKey: string): string {
  return `${port === 22 ? host : `[${host}]:${port}`} ${hostKey}\n`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new Error(`${name} is required`);
  return v.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SshConfig {
  const port = Number(env.SSH_PORT?.trim() || "22");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SSH_PORT must be a TCP port (got: ${env.SSH_PORT})`);
  }
  // The ProxyCommand helper's own reader: a drift here means a DIRECT dial
  // that skips the sidecar's SSRF floor.
  const proxy = proxyUrlFromEnv(env);
  return {
    host: required(env, "SSH_HOST"),
    port,
    user: required(env, "SSH_USER"),
    privateKeyPath: required(env, "SSH_PRIVATE_KEY_PATH"),
    hostKey: parseHostKey(required(env, "SSH_HOST_KEY")),
    proxyUrl: proxy,
  };
}

// ────────────────────────────── ssh argv ──────────────────────────────

/** Directory holding this file — `proxy-connect.ts` sits next to it. */
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

export interface SshOptionOverrides {
  /** `VERBOSE` for the probe, which reads its success off stderr; `ERROR` otherwise. */
  logLevel?: "ERROR" | "VERBOSE";
  /** `-N`: authenticate, open no session. An option, so it must precede the `--`. */
  noSession?: boolean;
}

/**
 * Options shared by every ssh/sftp invocation. `-F /dev/null` drops any config
 * the image carries, so this table is the whole policy: no prompts (there is no
 * terminal), auth pinned to the delivered key, no forwarding of any kind.
 *
 * Each key is emitted exactly once: for `-o` OpenSSH keeps the FIRST value and
 * ignores later ones (measured — an appended `LogLevel=VERBOSE` after `ERROR`
 * produced no output), so an override replaces a value, never appends one.
 */
export function buildSshOptions(
  cfg: SshConfig,
  knownHostsPath: string,
  overrides: SshOptionOverrides = {},
): string[] {
  const opts = [
    "-F",
    "/dev/null",
    ...Object.entries({
      BatchMode: "yes",
      StrictHostKeyChecking: "yes",
      UserKnownHostsFile: knownHostsPath,
      IdentitiesOnly: "yes",
      IdentityFile: cfg.privateKeyPath,
      PasswordAuthentication: "no",
      KbdInteractiveAuthentication: "no",
      ForwardAgent: "no",
      ForwardX11: "no",
      ConnectTimeout: "15",
      LogLevel: overrides.logLevel ?? "ERROR",
    }).flatMap(([key, value]) => ["-o", `${key}=${value}`]),
  ];
  if (overrides.noSession) opts.push("-N");
  if (cfg.proxyUrl) {
    // ssh expands %h/%p itself; the helper reads the proxy URL from env.
    opts.push("-o", `ProxyCommand=bun ${join(SERVER_DIR, "proxy-connect.ts")} %h %p`);
  }
  return opts;
}

/**
 * `ssh … -- user@host [command]` — the command is handed to the login shell.
 * The `--` is load-bearing: without it getopt reads a `user` or `host` starting
 * with `-` as an option (`-w…` measured as `Bad tun device`).
 */
export function buildSshArgs(
  cfg: SshConfig,
  knownHostsPath: string,
  command?: string,
  overrides: SshOptionOverrides = {},
): string[] {
  const args = [
    ...buildSshOptions(cfg, knownHostsPath, overrides),
    "-p",
    String(cfg.port),
    "--",
    `${cfg.user}@${cfg.host}`,
  ];
  if (command !== undefined) args.push(command);
  return args;
}

/** `sftp -b - … -- user@host`, batch commands arrive on stdin. Same `--` rule. */
export function buildSftpArgs(cfg: SshConfig, knownHostsPath: string): string[] {
  return [
    ...buildSshOptions(cfg, knownHostsPath),
    "-b",
    "-",
    "-P",
    String(cfg.port),
    "--",
    `${cfg.user}@${cfg.host}`,
  ];
}

/**
 * Double-quote a path for an sftp batch line. What quoting cannot carry (quote,
 * backslash, CR/LF, NUL) or a leading `-` (an option) is refused, not escaped.
 */
export function quoteSftpPath(path: string): string {
  if (path === "" || /["\\\n\r\0]/.test(path) || path.startsWith("-")) {
    throw new ProtocolError(`path cannot be used in an sftp batch: ${JSON.stringify(path)}`);
  }
  return `"${path}"`;
}

// ─────────────────────────── subprocess runner ────────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  stdin?: string;
  /** Resolve as code 0 once stderr matches, then kill — `ssh -N` never exits on success. */
  untilStderr?: RegExp;
  /** Wall-clock ceiling. On expiry the process is killed and code 124 returned. */
  ceilingMs?: number;
}

/** Injectable so tests exercise the tool logic without an sshd. */
export type Runner = (argv: string[], opts: RunOptions) => Promise<RunResult>;

export const runProcess: Runner = async (argv, opts) => {
  // `Bun.spawn({ env })` REPLACES the environment. The proxy variables the
  // sidecar sets must reach ssh, and through it the ProxyCommand helper —
  // dropping them silently bypasses the egress listener.
  const proc = Bun.spawn(argv, {
    env: { ...process.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!opts.untilStderr && !opts.ceilingMs) {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  // Streaming path: watch stderr as it arrives, settle once — on the marker,
  // on exit, or on the ceiling — and make sure the child is dead afterwards.
  let stderr = "";
  let settled = false;
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (result: RunResult): RunResult => {
    settled = true;
    if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
    try {
      proc.kill();
    } catch {
      // already gone
    }
    return result;
  };
  const stdoutPromise = new Response(proc.stdout).text();

  const watchStderr = (async (): Promise<RunResult | null> => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
      stderr += decoder.decode(chunk, { stream: true });
      if (opts.untilStderr && opts.untilStderr.test(stderr)) {
        return { stdout: "", stderr, code: 0 };
      }
    }
    return null; // stream ended: the process exited — let `exited` report it
  })();
  const waitExit = (async (): Promise<RunResult> => {
    const code = await proc.exited;
    await watchStderr.catch(() => null);
    return { stdout: await stdoutPromise.catch(() => ""), stderr, code };
  })();
  const ceiling = new Promise<RunResult>((resolve) => {
    if (!opts.ceilingMs) return;
    ceilingTimer = setTimeout(() => {
      if (!settled)
        resolve({
          stdout: "",
          stderr: stderr + `\n(killed after ${opts.ceilingMs} ms)`,
          code: 124,
        });
    }, opts.ceilingMs);
  });

  const first = await Promise.race([watchStderr.then((r) => r ?? waitExit), waitExit, ceiling]);
  return settle(first);
};

// ────────────────────────────── helpers ───────────────────────────────

const EXEC_OUTPUT_BYTES = 64 * 1024;
const READ_FILE_BYTES = 256 * 1024;

/**
 * Byte-budget truncation that never emits a broken UTF-8 sequence:
 * `Buffer.toString("utf8")` decodes a partial tail to U+FFFD (measured on
 * Bun 1.3), so the cut is moved back to a character boundary by hand.
 */
export function truncateUtf8(text: string, budget: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= budget) return { text, truncated: false };
  let cut = budget;
  while (cut > 0 && (bytes[cut]! & 0b1100_0000) === 0b1000_0000) cut--;
  // On a lead byte (or ASCII) now; exclude its sequence if it overruns.
  const lead = bytes[cut]!;
  const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (cut + seqLen <= budget) cut += seqLen;
  return { text: bytes.subarray(0, cut).toString("utf8"), truncated: true };
}

/**
 * Parse `sftp> ls -la` output, skipping the echoed `sftp> …` command line and
 * `.`/`..`. sftp prefixes each entry with the path it was GIVEN, so `name` is
 * the last segment; `detail` is the line verbatim. Sorted by name, because
 * readdir order differs between filesystems.
 */
export function parseSftpLs(output: string): Array<{ name: string; detail: string }> {
  return output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "" && !l.startsWith("sftp>"))
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      // Everything after the 8 fixed columns, so names with spaces survive.
      const rest = fields.length > 8 ? fields.slice(8).join(" ") : fields.at(-1)!;
      // A symlink line is `name -> target`.
      const arrow = rest.indexOf(" -> ");
      const path = arrow === -1 ? rest : rest.slice(0, arrow);
      return { name: path.slice(path.lastIndexOf("/") + 1), detail: line.trim() };
    })
    .filter((e) => e.name !== "." && e.name !== "..")
    .sort((a, b) => a.name.localeCompare(b.name));
}

function logLine(fields: Record<string, string | number | boolean>): void {
  const parts: string[] = ["[ssh-mcp]"];
  for (const [k, v] of Object.entries(fields)) {
    const val = typeof v === "string" ? v : String(v);
    parts.push(`${k}=${val.includes(" ") ? JSON.stringify(val) : val}`);
  }
  process.stderr.write(parts.join(" ") + "\n");
}

// ─────────────────────────── session material ─────────────────────────

/** Per-process 0700 directory for `known_hosts` and sftp scratch files, under HOME or tmpdir. */
let sessionDir: string | null = null;
let knownHostsPath: string | null = null;
let exitHookInstalled = false;

async function ensureSession(cfg: SshConfig): Promise<string> {
  if (knownHostsPath) return knownHostsPath;
  const root = process.env.HOME && process.env.HOME !== "" ? homedir() : tmpdir();
  sessionDir = await mkdtemp(join(root, ".appstrate-ssh-"));
  await chmod(sessionDir, 0o700);
  if (!exitHookInstalled) {
    // The only cleanup: the server ends when stdin does, and `exit` is the last
    // moment anything runs — so the unlink must be synchronous. Once per process.
    process.on("exit", () => {
      if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
    });
    exitHookInstalled = true;
  }
  knownHostsPath = join(sessionDir, "known_hosts");
  await writeFile(knownHostsPath, renderKnownHosts(cfg.host, cfg.port, cfg.hostKey), {
    mode: 0o600,
  });
  return knownHostsPath;
}

let cachedConfig: SshConfig | null = null;
let configError: string | null = null;

function getConfig(): SshConfig {
  if (cachedConfig) return cachedConfig;
  if (configError) throw new ProtocolError(`server is misconfigured: ${configError}`);
  try {
    cachedConfig = loadConfig();
    return cachedConfig;
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    throw new ProtocolError(`server is misconfigured: ${configError}`);
  }
}

/** Test hook: forget the cached config and session material. */
export async function _resetForTests(): Promise<void> {
  cachedConfig = null;
  configError = null;
  if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  sessionDir = null;
  knownHostsPath = null;
}

// ──────────────────────────────── tools ───────────────────────────────

export interface Deps {
  run?: Runner;
  /** Test hook — where the known_hosts file goes instead of a session dir. */
  knownHostsPath?: string;
}

interface Session {
  cfg: SshConfig;
  kh: string;
  run: Runner;
}

async function session(deps: Deps): Promise<Session> {
  const cfg = getConfig();
  return {
    cfg,
    kh: deps.knownHostsPath ?? (await ensureSession(cfg)),
    run: deps.run ?? runProcess,
  };
}

/** Staging path for one sftp `get`/`put`, inside the 0700 session dir. */
function scratchPath(prefix: string): string {
  return join(
    sessionDir ?? tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function sshFailure(what: string, res: RunResult): Error {
  const tail = res.stderr.trim() || res.stdout.trim();
  let hint = "";
  if (/host key verification failed|remote host identification has changed/i.test(tail)) {
    hint =
      "\nhint: the pinned host key does not match — the target's key changed or SSH_HOST_KEY is wrong. Never accept a new key silently; reconnect the integration.";
  } else if (/permission denied \(publickey/i.test(tail)) {
    // sshd sends the same refusal for all three causes, so they are named together.
    hint =
      "\nhint: the target rejected the key — check authorized_keys on the dedicated account. " +
      "The `restrict` option the install block writes needs OpenSSH 7.2 or newer; an older sshd " +
      "refuses the whole line as an unknown option, so the key is installed and never authenticates. " +
      "On an sshd built WITHOUT PAM (Alpine), a locked account password (`user:!:` in /etc/shadow, " +
      "what `adduser -D` and `useradd` leave behind) also refuses public-key login — unlock it with " +
      "`echo '<user>:*' | chpasswd -e`, never `passwd -u`, which leaves an empty password on busybox.";
  } else if (/CONNECT refused by proxy/i.test(tail)) {
    hint = "\nhint: the egress proxy refused the target (private address or blocked host).";
  } else if (what === "sftp" && /^connection closed/i.test(tail)) {
    // Only when the closed channel is the FIRST thing said: a forced command
    // without an sftp arm refuses the subsystem before a single packet, which
    // reads as a dead host. After another diagnostic it is that one's consequence.
    hint =
      "\nhint: the sftp subsystem was refused before the session opened. If this account has a " +
      "forced command (ForceCommand in sshd_config, or command= in authorized_keys), it needs an " +
      "arm that execs sftp-server for this case. Appstrate installs no forced command of its own.";
  }
  return new Error(`${what} failed (exit ${res.code}): ${tail}${hint}`);
}

export async function probeTool(deps: Deps = {}): Promise<Record<string, unknown>> {
  const { cfg, kh, run } = await session(deps);
  // `-N` runs nothing on the target (no forced command either) but then HOLDS
  // the connection, so success is read off stderr — at VERBOSE ssh prints
  // `Authenticated to <host> … using "publickey"` — and the process is killed.
  // Failure still exits 255.
  const res = await run(
    ["ssh", ...buildSshArgs(cfg, kh, undefined, { logLevel: "VERBOSE", noSession: true })],
    {
      untilStderr: /^Authenticated to .+ using "publickey"/m,
      ceilingMs: 20_000,
    },
  );
  if (res.code !== 0) throw sshFailure("ssh probe", res);
  const fp = await run(["ssh-keygen", "-lf", kh], {});
  const fingerprint = fp.stdout.match(/SHA256:[A-Za-z0-9+/]+/)?.[0] ?? null;
  return {
    reachable: true,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    host_key_fingerprint: fingerprint,
    dialled_via: cfg.proxyUrl ? "CONNECT proxy" : "direct",
  };
}

export async function execTool(
  args: { command?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const { cfg, kh, run } = await session(deps);
  if (typeof args.command !== "string" || args.command.trim() === "") {
    throw new ProtocolError("`command` must be a non-empty string");
  }
  const command = args.command;
  logLine({ op: "exec" });
  // A command that never returns must not pin the runner forever.
  const res = await run(["ssh", ...buildSshArgs(cfg, kh, command)], { ceilingMs: 120_000 });
  // A non-zero exit from the COMMAND is a result, not a transport failure, and
  // must reach the agent as data. Only ssh's own failures (255) are thrown.
  if (res.code === 255) throw sshFailure("ssh", res);
  const out = truncateUtf8(res.stdout, EXEC_OUTPUT_BYTES);
  const err = truncateUtf8(res.stderr, EXEC_OUTPUT_BYTES);
  return {
    // Echoed so the run journal records exactly what crossed the wire.
    command_sent: command,
    exit_code: res.code,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
  };
}

async function sftpBatch({ cfg, kh, run }: Session, commands: string[]): Promise<RunResult> {
  const res = await run(["sftp", ...buildSftpArgs(cfg, kh)], { stdin: commands.join("\n") + "\n" });
  if (res.code !== 0) throw sshFailure("sftp", res);
  return res;
}

export async function readFileTool(
  args: { path?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const s = await session(deps);
  if (typeof args.path !== "string") throw new ProtocolError("`path` must be a string");
  const scratch = scratchPath("get");
  try {
    await sftpBatch(s, [`get ${quoteSftpPath(args.path)} ${quoteSftpPath(scratch)}`]);
    const bytes = await readFile(scratch);
    const out = truncateUtf8(bytes.toString("utf8"), READ_FILE_BYTES);
    return { path: args.path, bytes: bytes.length, truncated: out.truncated, content: out.text };
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

export async function listDirTool(
  args: { path?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const s = await session(deps);
  if (typeof args.path !== "string") throw new ProtocolError("`path` must be a string");
  // `-a`: a home directory's interesting contents are dotfiles, and plain
  // `ls -l` hides them with no signal that anything was held back.
  const res = await sftpBatch(s, [`ls -la ${quoteSftpPath(args.path)}`]);
  return { path: args.path, entries: parseSftpLs(res.stdout) };
}

export async function writeFileTool(
  args: { path?: unknown; content?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const s = await session(deps);
  if (typeof args.path !== "string") throw new ProtocolError("`path` must be a string");
  if (typeof args.content !== "string") throw new ProtocolError("`content` must be a string");
  const scratch = scratchPath("put");
  try {
    await writeFile(scratch, args.content, { mode: 0o600 });
    await sftpBatch(s, [`put ${quoteSftpPath(scratch)} ${quoteSftpPath(args.path)}`]);
    return { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") };
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

// ─────────────────────── MCP stdio JSON-RPC loop ─────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Static — answered with no configuration, which is how the conformance probe
 * spawns the server. Each `description` must equal the manifest's (what the
 * platform shows when granting tools), and "WRITES" marks the tools a read-only
 * agent is NOT granted; `scripts/test/ssh-mcp.test.ts` pins both.
 */
export const TOOLS = [
  {
    name: "ssh_probe",
    description:
      "Connect, verify the pinned host key and authenticate, then report how the host was reached. Executes nothing on the target and returns no remote data. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ssh_exec",
    description:
      "Run a command on the remote host, as the connection's Unix account. WRITES — this tool can do anything that account can do; withhold it from an agent that must not change the target. The string is handed to the account's login shell, so shell syntax works and quoting is yours to get right.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run on the target." },
      },
      required: ["command"],
    },
  },
  {
    name: "ssh_read_file",
    description: "Read a remote file over SFTP (256 KiB cap). Read-only.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "ssh_list_dir",
    description: "List a remote directory over SFTP, sorted by name. Read-only.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "ssh_write_file",
    description:
      "Write a remote file over SFTP. WRITES — withhold it from an agent that must not change the target.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

class ProtocolError extends Error {}

function okResult(id: number | string | null | undefined, payload: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] },
  };
}

type ToolHandler = (args: Record<string, unknown>, deps: Deps) => Promise<Record<string, unknown>>;

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ["ssh_probe", (_args, deps) => probeTool(deps)],
  ["ssh_exec", execTool],
  ["ssh_read_file", readFileTool],
  ["ssh_list_dir", listDirTool],
  ["ssh_write_file", writeFileTool],
]);

export async function handleRequest(
  req: JsonRpcRequest,
  deps: Deps = {},
): Promise<JsonRpcResponse | null> {
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "appstrate-ssh-mcp", version: "1.0.0" },
      },
    };
  }
  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id: req.id ?? null, result: { tools: TOOLS } };
  }
  if (req.method === "tools/call") {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? "";
    const handler = TOOL_HANDLERS.get(name);
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32602, message: `Unknown tool: ${params.name}` },
      };
    }
    const started = performance.now();
    try {
      return okResult(req.id, await handler(params.arguments ?? {}, deps));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ms = Math.round(performance.now() - started);
      // Refusals and misconfiguration are tool RESULTS the agent can act on,
      // reported as isError content rather than a protocol error that reads as
      // a dead channel. Only a malformed request is a protocol error.
      const refused = err instanceof ProtocolError;
      logLine({ op: refused ? "tool-refused" : "tool-error", tool: name, ms, message });
      const body = refused ? { refused: true, reason: message } : { error: message };
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] },
      };
    }
  }
  if (req.id === undefined || req.id === null) return null;
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  };
}

async function main(): Promise<void> {
  let buf = "";
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        process.stderr.write(`[ssh-mcp] dropping malformed line: ${line.slice(0, 120)}\n`);
        continue;
      }
      const res = await handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
