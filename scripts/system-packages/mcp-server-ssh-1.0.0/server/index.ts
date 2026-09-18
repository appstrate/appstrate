// SPDX-License-Identifier: Apache-2.0

/**
 * SSH — reach one host over SSH (Bun, dependency-free).
 *
 * Shells out to the `ssh` / `sftp` clients baked into the bun runner image
 * (`runtime-pi/runners/bun/Dockerfile` adds git + openssh-client), exactly
 * as `@appstrate/github-git-mcp` shells out to `git`. Pairs with the
 * `@appstrate/ssh` integration, which delivers the private key as a file
 * (`delivery.files`) and the non-secret connection fields as env
 * (`delivery.env`).
 *
 * Design rules, in order of importance:
 *
 *  1. The private key never enters the agent container. It is delivered to
 *     THIS process at `SSH_PRIVATE_KEY_PATH`, read by `ssh` itself, and no
 *     tool returns or accepts key material.
 *
 *  2. There is no free-form command tool. `ssh_exec` sends the NAME of a verb
 *     from a closed allowlist, verbatim, and the target's `command=`
 *     dispatcher decides what it means. SSH `exec` always runs through the
 *     remote login shell (`$SHELL -c "…"`) — there is no argv at the protocol
 *     level — so a string this process rendered would be shell input on the
 *     far side. A bare token from a closed list is the only payload that is
 *     safe to send, and a target that ignores the token (no `command=`) only
 *     ever receives that token.
 *
 *  3. Capabilities are separate TOOLS. The platform grants tools per agent
 *     (`toolAllowlist`, enforced sidecar-side), so read-only means a tool the
 *     agent does not have rather than a branch it might talk its way past.
 *
 *  4. No trust-on-first-use. The connection carries the host's public key
 *     (`SSH_HOST_KEY`, the `ssh-keyscan` line); it is written to a private
 *     `known_hosts` and `StrictHostKeyChecking=yes` refuses anything else. In
 *     an autonomous run nobody is there to accept a new key.
 *
 *  5. The real boundary is on the target — a dedicated account, `restrict` and
 *     `command=` in authorized_keys. Everything here is defence in depth.
 *
 * Boot is lazy: `initialize` / `tools/list` answer with no env at all (the
 * conformance probe spawns the server that way), and a missing or malformed
 * configuration is reported on the first tool call instead of as an opaque
 * "server closed the connection".
 *
 * Why hand-rolled (not @modelcontextprotocol/sdk): no node_modules in the
 * runner image, and the wire surface needed is `initialize` + `tools/list` +
 * `tools/call` over line-delimited JSON-RPC.
 */

import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ──────────────────────────── configuration ───────────────────────────

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  privateKeyPath: string;
  /** `keytype base64` taken from the pasted `ssh-keyscan` line. */
  hostKey: { type: string; key: string };
  /** Closed verb allowlist. The bare name is the whole wire payload. */
  verbs: readonly string[];
  readOnly: boolean;
  /** CONNECT proxy to dial through, when the runner has no direct route. */
  proxyUrl: string | null;
}

const HOST_KEY_TYPES =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|ssh-ed25519-cert-v01@openssh\.com)$/;

/**
 * Parse an `ssh-keyscan` line into its key type + key. The host column is
 * deliberately dropped: the user may have scanned an alias, and what is
 * pinned is the KEY, which `renderKnownHosts` binds to the connection's own
 * host and port.
 */
export function parseHostKey(raw: string): { type: string; key: string } {
  const fields = raw.trim().split(/\s+/);
  // `host type key [comment]` from ssh-keyscan, or `type key` pasted bare.
  const start = fields.length >= 3 && HOST_KEY_TYPES.test(fields[1]!) ? 1 : 0;
  const type = fields[start];
  const key = fields[start + 1];
  if (!type || !key || !HOST_KEY_TYPES.test(type) || !/^[A-Za-z0-9+/]+=*$/.test(key)) {
    throw new Error(
      "SSH_HOST_KEY must be the line printed by `ssh-keyscan -t ed25519 -p <port> <host>` " +
        "(host, key type, base64 key). There is no trust-on-first-use fallback.",
    );
  }
  return { type, key };
}

/** `known_hosts` line for this connection — bracketed form when the port is not 22. */
export function renderKnownHosts(
  host: string,
  port: number,
  hostKey: { type: string; key: string },
): string {
  const hostField = port === 22 ? host : `[${host}]:${port}`;
  return `${hostField} ${hostKey.type} ${hostKey.key}\n`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new Error(`${name} is required`);
  return v.trim();
}

function parseVerbs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SSH_ALLOWED_VERBS is not valid JSON (expected an array of verb names)");
  }
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
    throw new Error("SSH_ALLOWED_VERBS must be a JSON array of strings");
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SshConfig {
  const port = Number(env.SSH_PORT?.trim() || "22");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SSH_PORT must be a TCP port (got: ${env.SSH_PORT})`);
  }
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? null;
  return {
    host: required(env, "SSH_HOST"),
    port,
    user: required(env, "SSH_USER"),
    privateKeyPath: required(env, "SSH_PRIVATE_KEY_PATH"),
    hostKey: parseHostKey(required(env, "SSH_HOST_KEY")),
    verbs: parseVerbs(env.SSH_ALLOWED_VERBS),
    readOnly: env.SSH_READ_ONLY === "1" || env.SSH_READ_ONLY === "true",
    proxyUrl: proxy && proxy.trim() !== "" ? proxy.trim() : null,
  };
}

// ────────────────────────────── ssh argv ──────────────────────────────

/** Directory holding this file — `proxy-connect.ts` sits next to it. */
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Options shared by every ssh/sftp invocation.
 *
 * `-F /dev/null` ignores any user or system config the image might carry, so
 * the policy below is the whole policy. `BatchMode` fails instead of
 * prompting — there is no terminal. `IdentitiesOnly` pins auth to the
 * delivered key. Forwarding of every kind is off: an agent-driven session has
 * no business opening tunnels.
 */
export interface SshOptionOverrides {
  /**
   * `ERROR` for every tool; `VERBOSE` for the probe, which reads its success
   * off stderr. Exactly ONE `LogLevel=` is emitted: for `-o` options OpenSSH
   * keeps the FIRST value it obtains and ignores later ones (measured — a
   * `-o LogLevel=VERBOSE` appended after the base `ERROR` produced no output
   * at all), so overriding by appending is not an option.
   */
  logLevel?: "ERROR" | "VERBOSE";
}

export function buildSshOptions(
  cfg: SshConfig,
  knownHostsPath: string,
  overrides: SshOptionOverrides = {},
): string[] {
  const opts = [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `IdentityFile=${cfg.privateKeyPath}`,
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ConnectTimeout=15",
    "-o",
    `LogLevel=${overrides.logLevel ?? "ERROR"}`,
  ];
  if (cfg.proxyUrl) {
    // ssh expands %h/%p itself; the helper reads the proxy URL from env.
    opts.push("-o", `ProxyCommand=bun ${join(SERVER_DIR, "proxy-connect.ts")} %h %p`);
  }
  return opts;
}

/** `ssh … user@host [command]` — `command` is a bare verb or nothing. */
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
    `${cfg.user}@${cfg.host}`,
  ];
  if (command !== undefined) args.push(command);
  return args;
}

/** `sftp -b - … user@host`, batch commands arrive on stdin. */
export function buildSftpArgs(cfg: SshConfig, knownHostsPath: string): string[] {
  return [
    ...buildSshOptions(cfg, knownHostsPath),
    "-b",
    "-",
    "-P",
    String(cfg.port),
    `${cfg.user}@${cfg.host}`,
  ];
}

/**
 * Quote a path for an sftp batch line. sftp accepts double-quoted arguments;
 * a path that cannot be represented that way is refused rather than escaped
 * — the set is small (double quote, backslash, newline, NUL) and a leading `-` would be
 * read as an option.
 */
export function quoteSftpPath(path: string): string {
  if (path === "" || /["\\\n\r\0]/.test(path) || path.startsWith("-")) {
    throw new ProtocolError(`path cannot be used in an sftp batch: ${JSON.stringify(path)}`);
  }
  return `"${path}"`;
}

// ─────────────────────────────── verbs ────────────────────────────────

/**
 * Resolve a requested verb against the allowlist — exact match only. A
 * prefix match would let `hostname; rm -rf /` through on the `hostname` arm,
 * which is the same mistake a target-side dispatcher must not make.
 */
export function resolveVerb(cfg: SshConfig, requested: unknown): string {
  if (typeof requested !== "string" || requested === "") {
    throw new ProtocolError("`verb` must be a non-empty string");
  }
  if (!cfg.verbs.includes(requested)) {
    throw new ProtocolError(
      `verb '${requested}' is not in the allowlist. Allowed: ${cfg.verbs.join(", ") || "(none)"}`,
    );
  }
  return requested;
}

// ─────────────────────────── subprocess runner ────────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  stdin?: string;
  /**
   * Resolve as SUCCESS (code 0) as soon as accumulated stderr matches, then
   * kill the process. For `ssh -N`, which authenticates and then holds the
   * connection open forever — there is no exit to wait for on success.
   */
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
 * Byte-budget truncation that never emits a broken UTF-8 sequence.
 *
 * `Buffer.subarray(0, n).toString("utf8")` does NOT drop a partial trailing
 * sequence — it decodes it to U+FFFD (measured on Bun 1.3), so the cut has to
 * be moved back to a character boundary by hand: skip continuation bytes
 * (`10xxxxxx`), then drop a lead byte whose sequence would not have fit.
 */
export function truncateUtf8(text: string, budget: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= budget) return { text, truncated: false };
  let cut = budget;
  while (cut > 0 && (bytes[cut]! & 0b1100_0000) === 0b1000_0000) cut--;
  // `cut` now sits on a lead byte (or ASCII). If the sequence it starts runs
  // past the budget, exclude it too.
  const lead = bytes[cut]!;
  const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (cut + seqLen <= budget) cut += seqLen;
  return { text: bytes.subarray(0, cut).toString("utf8"), truncated: true };
}

/**
 * Parse `sftp> ls -l` output into entries. Batch mode echoes each command as
 * a `sftp> …` line, which is skipped. Sorted by name — readdir order differs
 * between filesystems, and a caller comparing output should not see that.
 */
export function parseSftpLs(output: string): Array<{ name: string; detail: string }> {
  return output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "" && !l.startsWith("sftp>"))
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      // `-rw-r--r--    1 uid  gid  size  mon day  time  name…` — name is the
      // remainder after the 8 fixed columns, so names with spaces survive.
      const name = fields.length > 8 ? fields.slice(8).join(" ") : fields.at(-1)!;
      return { name, detail: line.trim() };
    })
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

/**
 * Per-process private directory: the `known_hosts` file and sftp scratch
 * files. Created lazily under HOME (writable in the runner image), falling
 * back to the system tmpdir.
 */
let sessionDir: string | null = null;
let knownHostsPath: string | null = null;

async function ensureSession(cfg: SshConfig): Promise<string> {
  if (knownHostsPath) return knownHostsPath;
  const root = process.env.HOME && process.env.HOME !== "" ? homedir() : tmpdir();
  sessionDir = await mkdtemp(join(root, ".appstrate-ssh-"));
  await chmod(sessionDir, 0o700);
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

async function knownHostsFor(cfg: SshConfig, deps: Deps): Promise<string> {
  return deps.knownHostsPath ?? ensureSession(cfg);
}

function sshFailure(what: string, res: RunResult): Error {
  const tail = res.stderr.trim() || res.stdout.trim();
  let hint = "";
  if (/host key verification failed|remote host identification has changed/i.test(tail)) {
    hint =
      "\nhint: the pinned host key does not match — the target's key changed or SSH_HOST_KEY is wrong. Never accept a new key silently; reconnect the integration.";
  } else if (/permission denied \(publickey/i.test(tail)) {
    hint = "\nhint: the target rejected the key — check authorized_keys on the dedicated account.";
  } else if (/CONNECT refused by proxy/i.test(tail)) {
    hint = "\nhint: the egress proxy refused the target (private address or blocked host).";
  }
  return new Error(`${what} failed (exit ${res.code}): ${tail}${hint}`);
}

export async function probeTool(deps: Deps = {}): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  const kh = await knownHostsFor(cfg, deps);
  const run = deps.run ?? runProcess;
  // `-N`: authenticate, open no session — nothing runs on the target and a
  // forced command is never invoked. But `-N` then HOLDS the connection (it
  // exists for port forwarding), so success is read off stderr: at VERBOSE
  // ssh prints `Authenticated to <host> … using "publickey"`, and the process
  // is killed once that line lands. Failure still exits 255.
  const res = await run(
    ["ssh", ...buildSshArgs(cfg, kh, undefined, { logLevel: "VERBOSE" }), "-N"],
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
    allowed_verbs: cfg.verbs,
    read_only: cfg.readOnly,
    dialled_via: cfg.proxyUrl ? "CONNECT proxy" : "direct",
  };
}

export async function execTool(
  args: { verb?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  const verb = resolveVerb(cfg, args.verb);
  const kh = await knownHostsFor(cfg, deps);
  const run = deps.run ?? runProcess;
  logLine({ op: "exec", verb });
  // A verb that never returns must not pin the runner forever.
  const res = await run(["ssh", ...buildSshArgs(cfg, kh, verb)], { ceilingMs: 120_000 });
  // A non-zero exit from the VERB is a result, not a transport failure — the
  // dispatcher's refusal (exit 42 in the reference script) must reach the
  // agent as data. Only ssh's own failures (255) are thrown.
  if (res.code === 255) throw sshFailure("ssh", res);
  const out = truncateUtf8(res.stdout, EXEC_OUTPUT_BYTES);
  const err = truncateUtf8(res.stderr, EXEC_OUTPUT_BYTES);
  return {
    verb,
    // Echoed so the run journal records exactly what crossed the wire.
    command_sent: verb,
    exit_code: res.code,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
  };
}

async function sftpBatch(cfg: SshConfig, deps: Deps, commands: string[]): Promise<RunResult> {
  const kh = await knownHostsFor(cfg, deps);
  const run = deps.run ?? runProcess;
  const res = await run(["sftp", ...buildSftpArgs(cfg, kh)], { stdin: commands.join("\n") + "\n" });
  if (res.code !== 0) throw sshFailure("sftp", res);
  return res;
}

export async function readFileTool(
  args: { path?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  if (typeof args.path !== "string") throw new ProtocolError("`path` must be a string");
  await knownHostsFor(cfg, deps);
  const scratch = join(
    sessionDir ?? tmpdir(),
    `get-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await sftpBatch(cfg, deps, [`get ${quoteSftpPath(args.path)} ${quoteSftpPath(scratch)}`]);
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
  const cfg = getConfig();
  if (typeof args.path !== "string") throw new ProtocolError("`path` must be a string");
  const res = await sftpBatch(cfg, deps, [`ls -l ${quoteSftpPath(args.path)}`]);
  return { path: args.path, entries: parseSftpLs(res.stdout) };
}

export async function writeFileTool(
  args: { path?: unknown; content?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  if (cfg.readOnly)
    throw new ProtocolError("this connection is configured read-only (SSH_READ_ONLY)");
  if (typeof args.path !== "string") throw new ProtocolError("`path` must be a string");
  if (typeof args.content !== "string") throw new ProtocolError("`content` must be a string");
  await knownHostsFor(cfg, deps);
  const scratch = join(
    sessionDir ?? tmpdir(),
    `put-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await writeFile(scratch, args.content, { mode: 0o600 });
    await sftpBatch(cfg, deps, [`put ${quoteSftpPath(scratch)} ${quoteSftpPath(args.path)}`]);
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

/** Static — answered with no configuration, which is how the conformance probe spawns the server. */
export const TOOLS = [
  {
    name: "ssh_probe",
    description:
      "Connect, verify the pinned host key and authenticate, then report the effective policy. Executes nothing on the target and returns no remote data.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ssh_exec",
    description:
      "Run ONE pre-declared verb on the remote host. `verb` must be a name from the connection's allowlist (see ssh_probe); arbitrary shell commands are not accepted.",
    inputSchema: {
      type: "object",
      properties: { verb: { type: "string", description: "A verb name from the allowlist." } },
      required: ["verb"],
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
      "Write a remote file over SFTP. Mutating — refused when the connection is read-only.",
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
    const args = params.arguments ?? {};
    const started = performance.now();
    try {
      switch (params.name) {
        case "ssh_probe":
          return okResult(req.id, await probeTool(deps));
        case "ssh_exec":
          return okResult(req.id, await execTool(args, deps));
        case "ssh_read_file":
          return okResult(req.id, await readFileTool(args, deps));
        case "ssh_list_dir":
          return okResult(req.id, await listDirTool(args, deps));
        case "ssh_write_file":
          return okResult(req.id, await writeFileTool(args, deps));
        default:
          return {
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: { code: -32602, message: `Unknown tool: ${params.name}` },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ms = Math.round(performance.now() - started);
      // Refusals and misconfiguration are tool RESULTS the agent can act on
      // ("verb not allowed", "read-only"), reported as isError content rather
      // than a protocol error that reads as a dead channel. Only a malformed
      // request is a protocol error.
      if (err instanceof ProtocolError) {
        logLine({ op: "tool-refused", tool: params.name ?? "<unset>", ms, message });
        return {
          jsonrpc: "2.0",
          id: req.id ?? null,
          result: {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify({ refused: true, reason: message }, null, 2) },
            ],
          },
        };
      }
      logLine({ op: "tool-error", tool: params.name ?? "<unset>", ms, message });
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
        },
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

const isEntry =
  (import.meta as unknown as { main?: boolean }).main === true ||
  process.env.SSH_MCP_FORCE_MAIN === "1";
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
