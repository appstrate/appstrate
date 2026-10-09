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
 *    the tool descriptions and MCP annotations say which tools write.
 *  - No trust-on-first-use: the connection carries the host's public key
 *    (`SSH_HOST_KEY`), written to a private `known_hosts`, and
 *    `StrictHostKeyChecking=yes` refuses anything else.
 *  - Calls share one authenticated connection: channels on a ControlMaster
 *    that idles up to `CONTROL_PERSIST_S`, closed when the process ends.
 *
 * Boot is lazy: `initialize` / `tools/list` answer with no env at all (the
 * conformance probe spawns the server that way); a bad configuration is
 * reported on the first tool call, not as "server closed the connection".
 *
 * Hand-rolled rather than @modelcontextprotocol/sdk: the runner image has no
 * node_modules, and the surface is `initialize` + `tools/list` + `tools/call`
 * over line-delimited JSON-RPC.
 */

import { existsSync, rmSync } from "node:fs";
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

export interface SessionPaths {
  knownHosts: string;
  /** The multiplexing master's socket: whoever can connect to it is logged in. */
  controlPath: string;
  proxyLog: string;
}

export function sessionPaths(dir: string): SessionPaths {
  return {
    knownHosts: join(dir, "known_hosts"),
    controlPath: join(dir, "cm"),
    proxyLog: join(dir, "proxy.log"),
  };
}

// The master binds `<ControlPath>.<16 random characters>`, and ssh exits 255 past
// sockaddr_un's `sun_path`: 104 bytes on macOS and the BSDs, 108 on Linux.
const SUN_PATH_BYTES = 104;
const CONTROL_PATH_MAX_BYTES = SUN_PATH_BYTES - ".0123456789abcdef".length - 1;

const CONTROL_PERSIST_S = 300;
const CONNECT_TIMEOUT_S = 15;

/** ssh percent-expands paths and ProxyCommand; a literal `%` is `%%`. */
const sshLiteral = (s: string) => s.replaceAll("%", "%%");
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export interface SshOptionOverrides {
  /** `VERBOSE` for the probe, which reads its success off stderr; `ERROR` otherwise. */
  logLevel?: "ERROR" | "VERBOSE";
  /** `-N`: authenticate, open no session. An option, so it must precede the `--`. */
  noSession?: boolean;
  /** Dial a connection of its own instead of going through the shared master. */
  dedicated?: boolean;
}

/**
 * Options shared by every ssh/sftp invocation. `-F /dev/null` drops any config
 * the image carries, so this table is the whole policy: no prompts (there is no
 * terminal), auth pinned to the delivered key, no forwarding of any kind.
 *
 * Every call is a channel on one master (`ControlMaster=auto`): a target
 * rate-limiting new connections (`ufw limit`, fail2ban) would otherwise ban the
 * runner. A missing or stale socket makes the next call the new master.
 *
 * Each key is emitted exactly once: for `-o` OpenSSH keeps the FIRST value and
 * ignores later ones (measured — an appended `LogLevel=VERBOSE` after `ERROR`
 * produced no output), so an override replaces a value, never appends one.
 */
export function buildSshOptions(
  cfg: SshConfig,
  paths: SessionPaths,
  overrides: SshOptionOverrides = {},
): string[] {
  const opts = [
    "-F",
    "/dev/null",
    ...Object.entries({
      BatchMode: "yes",
      StrictHostKeyChecking: "yes",
      UserKnownHostsFile: sshLiteral(paths.knownHosts),
      IdentitiesOnly: "yes",
      IdentityFile: sshLiteral(cfg.privateKeyPath),
      PasswordAuthentication: "no",
      KbdInteractiveAuthentication: "no",
      ForwardAgent: "no",
      ForwardX11: "no",
      ConnectTimeout: String(CONNECT_TIMEOUT_S),
      // A peer that stops answering is dropped after ~45 s instead of hanging.
      ServerAliveInterval: "15",
      ServerAliveCountMax: "3",
      LogLevel: overrides.logLevel ?? "ERROR",
      ...(!overrides.dedicated && {
        ControlMaster: "auto",
        ControlPath: sshLiteral(paths.controlPath),
        ControlPersist: `${CONTROL_PERSIST_S}s`,
      }),
    }).flatMap(([key, value]) => ["-o", `${key}=${value}`]),
  ];
  if (overrides.noSession) opts.push("-N");
  if (cfg.proxyUrl) {
    // ssh expands %h/%p itself; the helper reads the proxy URL from env. Under
    // ControlPersist ssh sends its stderr to /dev/null, hence the log.
    const helper = shellQuote(sshLiteral(join(SERVER_DIR, "proxy-connect.ts")));
    const log = shellQuote(sshLiteral(paths.proxyLog));
    opts.push("-o", `ProxyCommand=bun ${helper} %h %p 2>>${log}`);
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
  paths: SessionPaths,
  command?: string,
  overrides: SshOptionOverrides = {},
): string[] {
  const args = [
    ...buildSshOptions(cfg, paths, overrides),
    "-p",
    String(cfg.port),
    "--",
    `${cfg.user}@${cfg.host}`,
  ];
  if (command !== undefined) args.push(command);
  return args;
}

/** `sftp -b - … -- user@host`, batch commands arrive on stdin. Same `--` rule. */
export function buildSftpArgs(cfg: SshConfig, paths: SessionPaths): string[] {
  return [
    ...buildSshOptions(cfg, paths),
    "-b",
    "-",
    "-P",
    String(cfg.port),
    "--",
    `${cfg.user}@${cfg.host}`,
  ];
}

/** `ssh -O check|exit`: asks the master over its socket, never the target. */
export function buildControlArgs(
  cfg: SshConfig,
  paths: SessionPaths,
  command: "check" | "exit",
): string[] {
  return [
    ...buildSshOptions(cfg, paths),
    "-O",
    command,
    "-p",
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

/**
 * `quoteSftpPath` for an `ls` operand. Quoting makes `*?[` literal, but sftp's
 * `ls` still expands `{a,b}` inside quotes (measured, OpenSSH 10.2), which would
 * list some other path under this one's name.
 */
function quoteSftpLsPath(path: string): string {
  if (path.includes("{")) {
    throw new ProtocolError(
      `path cannot be listed over sftp (\`{\` is expanded): ${JSON.stringify(path)}; use ssh_exec`,
    );
  }
  return quoteSftpPath(path);
}

// ────────────────────────────── limits ────────────────────────────────

const EXEC_OUTPUT_BYTES = 64 * 1024;
const EXEC_TIMEOUT_DEFAULT_S = 120;
const EXEC_TIMEOUT_MAX_S = 600;
// Sized for the largest transfer a tool makes — an 8 MiB `get` — at ~100 KiB/s,
// the slow end of a proxied link; a stalled batch fails instead of pinning the runner.
const SFTP_CEILING_MS = 120_000;
// sftp stdout is only ever `ls` output; past this a listing is reported incomplete.
const SFTP_OUTPUT_BYTES = 1024 * 1024;
// SFTP has no ranged read, so any window of a file costs the whole file on the
// runner; past this ceiling `sed -n` / `tail` through ssh_exec is the tool.
const FILE_BYTES_MAX = 8 * 1024 * 1024;
const READ_OUTPUT_BYTES = 256 * 1024;
// The 2000-line window agent harnesses converge on; the byte cap, not the line
// count, is what bounds a reply, so the maximum only stops absurd requests.
const READ_LIMIT_DEFAULT = 2000;
const READ_LIMIT_MAX = 10_000;
const LINE_CHARS_MAX = 2000;
const EDIT_CONTEXT_LINES = 3;
const EDIT_SNIPPET_BYTES = 8 * 1024;

// ────────────────────────────── utf-8 ─────────────────────────────────

/**
 * Largest prefix length ≤ `budget` ending on a character boundary; reads
 * `bytes[budget]`. `Buffer.toString("utf8")` would decode a cut sequence to
 * U+FFFD (measured on Bun 1.3), so the cut moves back by hand.
 */
function utf8Cut(bytes: Uint8Array, budget: number): number {
  if (bytes.length <= budget) return bytes.length;
  let cut = budget;
  while (cut > 0 && (bytes[cut]! & 0b1100_0000) === 0b1000_0000) cut--;
  return cut;
}

/**
 * Bounded capture of one output stream: the first half of `budget` bytes, a
 * rolling tail of the other half, and a count of what fell between. Memory
 * stays near `budget` however much the process writes. Over budget it renders
 * head and tail around an explicit marker: the end of a failing command's
 * output is where its error is.
 */
export class OutputCapture {
  private readonly half: number;
  private readonly head: Buffer;
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  private total = 0;

  constructor(private readonly budget: number) {
    this.half = Math.floor(budget / 2);
    this.head = Buffer.alloc(this.half + 1); // +1: `utf8Cut` reads the byte past the cut
  }

  push(chunk: Uint8Array): void {
    this.total += chunk.length;
    let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const room = this.head.length - this.headLen;
    if (room > 0) {
      const n = Math.min(room, rest.length);
      rest.copy(this.head, this.headLen, 0, n);
      this.headLen += n;
      rest = rest.subarray(n);
    }
    if (rest.length === 0) return;
    this.tail.push(Buffer.from(rest));
    this.tailLen += rest.length;
    while (this.tail.length > 1 && this.tailLen - this.tail[0]!.length >= this.half) {
      this.tailLen -= this.tail.shift()!.length;
    }
  }

  get truncated(): boolean {
    return this.total > this.budget;
  }

  render(): string {
    const head = this.head.subarray(0, this.headLen);
    if (!this.truncated) return Buffer.concat([head, ...this.tail]).toString("utf8");
    const cut = utf8Cut(head, this.half);
    // Tail chunks are only dropped while `half` bytes remain, so when fewer are
    // kept nothing was dropped and the head's spare byte joins them seamlessly.
    const after = Buffer.concat([head.subarray(this.half), ...this.tail]);
    let skip = after.length - this.half;
    while (skip < after.length && (after[skip]! & 0b1100_0000) === 0b1000_0000) skip++;
    const omitted = this.total - (after.length - skip) - cut;
    return (
      `${head.subarray(0, cut).toString("utf8")}\n` +
      `[… ${omitted} bytes omitted: output over ${this.budget} bytes, head and tail kept …]\n` +
      after.subarray(skip).toString("utf8")
    );
  }
}

// ─────────────────────────── subprocess runner ────────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
  /** `null` when the ceiling fired: the process was killed before it reported one. */
  code: number | null;
  timedOut?: boolean;
  /** The stream outgrew `outputBytes` and is rendered as a head+tail excerpt. */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface RunOptions {
  stdin?: string;
  /** Resolve as code 0 once stderr matches, then kill — `ssh -N` never exits on success. */
  untilStderr?: RegExp;
  /** Wall-clock ceiling. On expiry the process is killed; what it wrote so far is kept. */
  ceilingMs?: number;
  /** Per-stream memory budget (default 64 KiB), see `OutputCapture`. */
  outputBytes?: number;
}

/** Injectable so tests exercise the tool logic without an sshd. */
export type Runner = (argv: string[], opts: RunOptions) => Promise<RunResult>;

export const runProcess: Runner = (argv, opts) => {
  // `Bun.spawn({ env })` REPLACES the environment. The proxy variables the
  // sidecar sets must reach ssh, and through it the ProxyCommand helper —
  // dropping them silently bypasses the egress listener.
  const proc = Bun.spawn(argv, {
    env: { ...process.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const budget = opts.outputBytes ?? EXEC_OUTPUT_BYTES;
  const out = new OutputCapture(budget);
  const err = new OutputCapture(budget);
  const decoder = new TextDecoder();
  let early = ""; // stderr decoded for `untilStderr`, first `budget` characters only

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Settle once — on the marker, on exit, or on the ceiling — and make sure
    // the child is dead afterwards.
    const settle = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        // already gone
      }
      resolve({
        stdout: out.render(),
        stderr: err.render() + (timedOut ? `\n(killed after ${opts.ceilingMs} ms)` : ""),
        code,
        timedOut,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    };
    const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (c: Uint8Array) => void) => {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) onChunk(chunk);
    };
    const stdoutDone = drain(proc.stdout, (c) => out.push(c)).catch(() => {});
    const stderrDone = drain(proc.stderr, (c) => {
      err.push(c);
      if (!opts.untilStderr || early.length > budget) return;
      early += decoder.decode(c, { stream: true });
      if (opts.untilStderr.test(early)) settle(0, false);
    }).catch(() => {});
    void Promise.all([proc.exited, stdoutDone, stderrDone]).then(([code]) => settle(code, false));
    if (opts.ceilingMs) timer = setTimeout(() => settle(null, true), opts.ceilingMs);
  });
};

// ────────────────────────────── helpers ───────────────────────────────

/** Output lines of an sftp batch without its `sftp> ` echoes; only the terminator is stripped. */
function lsLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .filter((l) => l !== "" && !l.startsWith("sftp>"));
}

/**
 * Parse `sftp> ls -la <path>` output for a directory. sftp prints each entry
 * as `<path>/<name>` after metadata that never holds a `/`, and prints no
 * symlink target (measured, OpenSSH 9.2 and 10.2) — so a name is everything
 * after the first ` <path>/`, spaces and ` -> ` included. Sorted by name,
 * because readdir order differs between filesystems.
 */
export function parseSftpLs(output: string, path: string): Array<{ name: string; detail: string }> {
  const prefix = ` ${path.endsWith("/") ? path : `${path}/`}`;
  const entries: Array<{ name: string; detail: string }> = [];
  for (const line of lsLines(output)) {
    const at = line.indexOf(prefix);
    if (at === -1) continue;
    const name = line.slice(at + prefix.length);
    if (name !== "" && name !== "." && name !== "..") entries.push({ name, detail: line });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export type RemoteTarget =
  | { kind: "directory"; entries: Array<{ name: string; detail: string }> }
  | { kind: "file"; size: number };

/**
 * Classify `ls -la <path>` output. sftp stats (following symlinks) what it is
 * given: a non-directory comes back as ONE line ending in ` <path>` verbatim
 * with no `/` in the metadata before it; a directory as its entries, each
 * `<path>/<name>` — so a lone entry whose name ends like the path still has
 * that `/` in front of it, and is not mistaken for the path itself.
 */
export function classifyLs(output: string, path: string): RemoteTarget {
  const lines = lsLines(output);
  const line = lines.length === 1 ? lines[0]! : "";
  const meta = line.slice(0, line.length - path.length - 1);
  if (line.endsWith(` ${path}`) && !meta.includes("/") && !line.startsWith("d")) {
    // `<perm> <links> <owner> <group> <size> <Mon> <day> <time|year>`, read from
    // the right so an owner name with a space cannot shift the size.
    const size = Number(meta.trim().split(/\s+/).at(-4));
    if (!line.startsWith("-") || !Number.isSafeInteger(size)) {
      throw new ProtocolError(`${path} is neither a regular file nor a directory: ${line}`);
    }
    return { kind: "file", size };
  }
  return { kind: "directory", entries: parseSftpLs(output, path) };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Cut a line to `LINE_CHARS_MAX` code points; files are capped, so the array stays small. */
function clipLine(line: string): string {
  if (line.length <= LINE_CHARS_MAX) return line; // code points ≤ UTF-16 units
  const chars = Array.from(line);
  if (chars.length <= LINE_CHARS_MAX) return line;
  const more = chars.length - LINE_CHARS_MAX;
  return `${chars.slice(0, LINE_CHARS_MAX).join("")}… [line cut: ${more} more characters; ssh_exec shows it whole]`;
}

/**
 * Lines `from`..`to` (1-based, inclusive) numbered like `cat -n`, stopping
 * early once `budget` bytes are used. The first line always fits: `clipLine`
 * bounds a line far below any budget used here.
 */
function renderLines(
  lines: string[],
  from: number,
  to: number,
  budget: number,
): { text: string; last: number } {
  let text = "";
  let used = 0;
  let last = from - 1;
  for (let n = from; n <= to; n++) {
    const row = `${String(n).padStart(6)}\t${clipLine(lines[n - 1]!)}\n`;
    const size = Buffer.byteLength(row, "utf8");
    if (used + size > budget && n > from) break;
    text += row;
    used += size;
    last = n;
  }
  return { text, last };
}

/** UTF-8 text or a refusal — never U+FFFD garbage, and never a lossy round-trip for an edit. */
function decodeText(bytes: Uint8Array, path: string): string {
  const refuse = (why: string) =>
    new ProtocolError(
      `${path} ${why}; use ssh_exec for it (e.g. \`file\`, \`xxd\`, \`iconv -f latin1\`)`,
    );
  if (bytes.includes(0)) throw refuse("is binary (it contains NUL bytes)");
  try {
    // `ignoreBOM` keeps a byte-order mark in the text, so an edit writes it back.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw refuse("is not UTF-8 text");
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ProtocolError(`\`${name}\` must be a string`);
  return value;
}

/**
 * sftp starts in the account's home directory, so `~` and `~/…` become `.` and
 * `./…`, relative whatever follows. Another account's home (`~user`) is refused.
 */
function remotePath(value: unknown): string {
  const path = stringArg(value, "path");
  if (path === "~") return ".";
  if (path.startsWith("~/")) return `.${path.slice(1)}`;
  if (path.startsWith("~")) {
    throw new ProtocolError(
      `\`~user\` paths are not expanded (${JSON.stringify(path)}); give an absolute path, ` +
        "or `~/…` for this account's home",
    );
  }
  return path;
}

function intArg(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(
      `\`${name}\` must be an integer from ${min} to ${max} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
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

/** Per-process 0700 directory: known_hosts, control socket, scratch files. */
let sessionDir: string | null = null;
let exitHookInstalled = false;

function sessionRoot(): string {
  const roots = [process.env.HOME ? homedir() : null, tmpdir(), "/tmp"];
  // mkdtemp appends 6 characters to the prefix.
  const fits = (root: string) =>
    Buffer.byteLength(sessionPaths(join(root, ".appstrate-ssh-XXXXXX")).controlPath) <=
    CONTROL_PATH_MAX_BYTES;
  const root = roots.find((r): r is string => r !== null && fits(r));
  if (!root) throw new Error(`no directory short enough for the ssh control socket`);
  return root;
}

function endSession(): void {
  if (!sessionDir) return;
  const paths = sessionPaths(sessionDir);
  if (cachedConfig && existsSync(paths.controlPath)) {
    Bun.spawnSync(["ssh", ...buildControlArgs(cachedConfig, paths, "exit")], {
      env: { ...process.env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5_000,
    });
  }
  rmSync(sessionDir, { recursive: true, force: true });
}

async function ensureSession(cfg: SshConfig): Promise<string> {
  if (sessionDir) return sessionDir;
  const dir = await mkdtemp(join(sessionRoot(), ".appstrate-ssh-"));
  await chmod(dir, 0o700);
  sessionDir = dir;
  if (!exitHookInstalled) {
    // The server ends when stdin does, or on a signal; both reach `exit`.
    process.on("exit", endSession);
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
      ["SIGHUP", 129],
    ] as const) {
      process.on(signal, () => process.exit(code));
    }
    exitHookInstalled = true;
  }
  await writeFile(sessionPaths(dir).knownHosts, renderKnownHosts(cfg.host, cfg.port, cfg.hostKey), {
    mode: 0o600,
  });
  return dir;
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
    configError = errorText(err);
    throw new ProtocolError(`server is misconfigured: ${configError}`);
  }
}

/** Test hook: forget the cached config and session material. */
export async function _resetForTests(): Promise<void> {
  cachedConfig = null;
  configError = null;
  if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  sessionDir = null;
}

// ──────────────────────────────── tools ───────────────────────────────

export interface Deps {
  run?: Runner;
  /** Test hook — an existing directory used as the session directory, known_hosts left unwritten. */
  sessionDir?: string;
}

interface Session {
  cfg: SshConfig;
  dir: string;
  paths: SessionPaths;
  run: Runner;
}

/** A failed call carries what the ProxyCommand logged. Calls are serial: the log is this call's. */
function withProxyLog(run: Runner, proxyLog: string): Runner {
  return async (argv, opts) => {
    const res = await run(argv, opts);
    if (res.code === 0) return res;
    const said = await readFile(proxyLog, "utf8").catch(() => "");
    if (said.trim() === "") return res;
    await rm(proxyLog, { force: true });
    return { ...res, stderr: `${said.trim()}\n${res.stderr}` };
  };
}

async function session(deps: Deps): Promise<Session> {
  const cfg = getConfig();
  const dir = deps.sessionDir ?? (await ensureSession(cfg));
  const paths = sessionPaths(dir);
  return { cfg, dir, paths, run: withProxyLog(deps.run ?? runProcess, paths.proxyLog) };
}

/** Staging path for one sftp `get`/`put`, inside the 0700 session dir. */
function scratchPath(s: Session, prefix: string): string {
  return join(s.dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** The target refused the credential itself (only a reconnect fixes it), unlike a network failure. */
class CredentialRejected extends Error {
  constructor(
    message: string,
    readonly reason: "host_key_mismatch" | "publickey_rejected",
  ) {
    super(message);
  }
}

/** The rejection reason anywhere in `err`'s cause chain (tools wrap failures). */
function credentialRejection(err: unknown): CredentialRejected["reason"] | null {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e instanceof CredentialRejected) return e.reason;
  }
  return null;
}

function sshFailure(what: string, res: RunResult): Error {
  const tail = res.stderr.trim() || res.stdout.trim();
  const status = res.code === null ? "timed out" : `exit ${res.code}`;
  if (/host key verification failed|remote host identification has changed/i.test(tail)) {
    return new CredentialRejected(
      `${what} failed (${status}): ${tail}` +
        "\nhint: the pinned host key does not match — the target's key changed or SSH_HOST_KEY is wrong. Never accept a new key silently; reconnect the integration.",
      "host_key_mismatch",
    );
  }
  if (/permission denied \(publickey/i.test(tail)) {
    // sshd sends the same refusal for all three causes, so they are named together.
    return new CredentialRejected(
      `${what} failed (${status}): ${tail}` +
        "\nhint: the target rejected the key — check authorized_keys on the dedicated account. " +
        "The `restrict` option the install block writes needs OpenSSH 7.2 or newer; an older sshd " +
        "refuses the whole line as an unknown option, so the key is installed and never authenticates. " +
        "On an sshd built WITHOUT PAM (Alpine), a locked account password (`user:!:` in /etc/shadow, " +
        "what `adduser -D` and `useradd` leave behind) also refuses public-key login — unlock it with " +
        "`echo '<user>:*' | chpasswd -e`, never `passwd -u`, which leaves an empty password on busybox.",
      "publickey_rejected",
    );
  }
  let hint = "";
  if (/CONNECT refused by proxy/i.test(tail)) {
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
  return new Error(`${what} failed (${status}): ${tail}${hint}`);
}

export async function probeTool(deps: Deps = {}): Promise<Record<string, unknown>> {
  const { cfg, paths, run } = await session(deps);
  // `-N` runs nothing on the target (no forced command either) but then HOLDS
  // the connection, so success is read off stderr — at VERBOSE ssh prints
  // `Authenticated to <host> … using "publickey"` — and the process is killed.
  // Failure still exits 255. Its own connection: a channel on the master proves nothing.
  const res = await run(
    [
      "ssh",
      ...buildSshArgs(cfg, paths, undefined, {
        logLevel: "VERBOSE",
        noSession: true,
        dedicated: true,
      }),
    ],
    {
      untilStderr: /^Authenticated to .+ using "publickey"/m,
      ceilingMs: 20_000,
    },
  );
  if (res.code !== 0) throw sshFailure("ssh probe", res);
  const fp = await run(["ssh-keygen", "-lf", paths.knownHosts], {});
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
  args: { command?: unknown; timeout_seconds?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.command !== "string" || args.command.trim() === "") {
    throw new ProtocolError("`command` must be a non-empty string");
  }
  const command = args.command;
  const timeoutS = intArg(
    args.timeout_seconds,
    "timeout_seconds",
    EXEC_TIMEOUT_DEFAULT_S,
    1,
    EXEC_TIMEOUT_MAX_S,
  );
  const s = await session(deps);
  logLine({ op: "exec", timeout_s: timeoutS });
  const marker = `appstrate-ssh-pid-${crypto.randomUUID().replaceAll("-", "")}=`;
  const res = await s.run(
    ["ssh", ...buildSshArgs(s.cfg, s.paths, markedCommand(marker, command))],
    {
      ceilingMs: timeoutS * 1000,
    },
  );
  const { stdout, pid } = takePidMarker(res.stdout, marker);
  const timedOut = res.timedOut === true;
  // A non-zero exit from the COMMAND is a result, not a transport failure, and
  // must reach the agent as data. Only ssh's own failures (255) are thrown —
  // which a command exiting 255 is indistinguishable from.
  if (res.code === 255 && !timedOut) throw sshFailure("ssh", res);
  return {
    // Echoed for the run journal; on the wire it follows the pid `echo` above.
    command_sent: command,
    timeout_seconds: timeoutS,
    exit_code: res.code, // null on timeout: the killed client never learnt it
    timed_out: timedOut,
    stdout,
    stderr: res.stderr,
    truncated: res.stdoutTruncated === true || res.stderrTruncated === true,
    ...(timedOut && (await stopRemote(s, pid, timeoutS))),
  };
}

export function takePidMarker(
  stdout: string,
  marker: string,
): { stdout: string; pid: number | null } {
  const at = `\n${stdout}`.indexOf(`\n${marker}`);
  if (at === -1) return { stdout, pid: null };
  const end = stdout.indexOf("\n", at);
  const value = stdout.slice(at + marker.length, end === -1 ? undefined : end);
  if (!/^\d+$/.test(value)) return { stdout, pid: null };
  const pid = Number(value);
  // `kill -TERM -1` would signal every process of the account, `-0` the killer's own group.
  if (!Number.isSafeInteger(pid) || pid < 2) return { stdout, pid: null };
  return { stdout: stdout.slice(0, at) + (end === -1 ? "" : stdout.slice(end + 1)), pid };
}

/**
 * sshd runs the command as the leader of a new session, so the login shell's
 * pid is its process group: a child `sh` echoes it as `$PPID`, in single
 * quotes that fish and csh leave alone as POSIX shells do.
 */
export function markedCommand(marker: string, command: string): string {
  return `sh -c 'echo ${marker}$PPID'\n${command}`;
}

const TERM_GRACE_S = 5;
const STOP_CEILING_MS = (TERM_GRACE_S + 2 + CONNECT_TIMEOUT_S) * 1000;

/**
 * SIGTERM, then SIGKILL; exits 0 (gone), 3 (gone already), 4 (survived). The group `pid` leads,
 * else `pid` alone (a wrapper's child leads none). `kill -SIG -PGID`: dash refuses `--`.
 */
export function stopScript(pid: number): string {
  // `sh -c`, whatever the login shell; the script holds no single quote.
  return (
    `sh -c 'if kill -TERM -${pid}; then t=-${pid}; elif kill -TERM ${pid}; then t=${pid}; else exit 3; fi; ` +
    `n=0; while kill -0 $t; do ` +
    `[ "$n" -lt ${TERM_GRACE_S} ] || { kill -KILL $t; sleep 1; kill -0 $t && exit 4; exit 0; }; ` +
    `sleep 1; n=$((n + 1)); done'`
  );
}

/** Killing the local client only closes its channel: no pty, so nothing signals the remote side. */
async function stopRemote(
  s: Session,
  pid: number | null,
  timeoutS: number,
): Promise<Record<string, unknown>> {
  const after = `the call returned after ${timeoutS} s`;
  if (pid === null) {
    return {
      remote_pid: null,
      remote_process: "unknown",
      note:
        `${after}, but the target did not report the command's pid, so it was not stopped ` +
        "and may still be running",
    };
  }
  const res = await s.run(["ssh", ...buildSshArgs(s.cfg, s.paths, stopScript(pid))], {
    ceilingMs: STOP_CEILING_MS,
  });
  const outcome =
    { 0: "terminated", 3: "already_exited", 4: "still_running" }[res.code ?? -1] ?? "unknown";
  logLine({ op: "exec-stop", pid, outcome });
  const notes: Record<string, string> = {
    terminated: `${after} and the command was terminated on the target`,
    already_exited: `${after}; the command had already ended on the target`,
    still_running: `${after}; the command survived SIGKILL on the target`,
    unknown:
      `${after}, but stopping the command failed (${res.code === null ? "timed out" : `exit ${res.code}`}); ` +
      `it may still be running as pid ${pid}`,
  };
  return { remote_pid: pid, remote_process: outcome, note: notes[outcome] };
}

/**
 * sftp passes `ControlMaster=no` ahead of our options, so it never becomes the
 * master: one is opened with `ssh -N` when `-O check` finds none. Never `-N`
 * through a live master — before OpenSSH 10 that opens a login-shell session.
 */
async function ensureMaster({ cfg, paths, run }: Session): Promise<void> {
  if (
    (await run(["ssh", ...buildControlArgs(cfg, paths, "check")], { ceilingMs: 5_000 })).code === 0
  ) {
    return;
  }
  const res = await run(["ssh", ...buildSshArgs(cfg, paths, undefined, { noSession: true })], {
    ceilingMs: 20_000,
  });
  if (res.code !== 0) throw sshFailure("ssh", res);
}

async function sftpBatch(s: Session, commands: string[]): Promise<RunResult> {
  await ensureMaster(s);
  const { cfg, paths, run } = s;
  const res = await run(["sftp", ...buildSftpArgs(cfg, paths)], {
    stdin: commands.join("\n") + "\n",
    ceilingMs: SFTP_CEILING_MS,
    outputBytes: SFTP_OUTPUT_BYTES,
  });
  if (res.code !== 0) throw sshFailure("sftp", res);
  return res;
}

async function statPath(
  s: Session,
  path: string,
  quoted: string,
): Promise<{ target: RemoteTarget; incomplete: boolean }> {
  // `-a`: a home directory's interesting contents are dotfiles, and plain
  // `ls -l` hides them with no signal that anything was held back.
  const res = await sftpBatch(s, [`ls -la ${quoted}`]);
  if (!res.stdoutTruncated) return { target: classifyLs(res.stdout, path), incomplete: false };
  // Keep the head, minus the line the excerpt marker cut through.
  const head = res.stdout.slice(0, res.stdout.indexOf("\n[… "));
  return {
    target: classifyLs(head.slice(0, head.lastIndexOf("\n")), path),
    incomplete: true,
  };
}

/** Download a regular file whose `ls` size is known, as UTF-8 text. */
async function fetchText(
  s: Session,
  path: string,
  size: number,
): Promise<{ bytes: Buffer; text: string }> {
  const tooBig = (n: number) =>
    new ProtocolError(
      `${path} is ${n} bytes, over the ${FILE_BYTES_MAX}-byte ceiling for SFTP reads and edits; ` +
        "use ssh_exec (sed -n, head, tail, grep) on it",
    );
  if (size > FILE_BYTES_MAX) throw tooBig(size);
  const scratch = scratchPath(s, "get");
  try {
    await sftpBatch(s, [`get ${quoteSftpPath(path)} ${quoteSftpPath(scratch)}`]);
    const bytes = await readFile(scratch);
    if (bytes.length > FILE_BYTES_MAX) throw tooBig(bytes.length); // grew since `ls`
    return { bytes, text: decodeText(bytes, path) };
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

/** The remote open was refused: the target is exactly as it was. */
class WriteRefused extends Error {}

/**
 * Upload through a 0600 scratch file. `put` onto an existing path truncates and
 * rewrites it in place, so its mode, owner, hard links and a symlink's target
 * survive (measured; `-p` would copy the scratch mode instead). A NEW file is
 * created with the scratch file's 0600.
 */
async function putFile(s: Session, path: string, data: string | Uint8Array): Promise<void> {
  const scratch = scratchPath(s, "put");
  try {
    await writeFile(scratch, data, { mode: 0o600 });
    await sftpBatch(s, [`put ${quoteSftpPath(scratch)} ${quoteSftpPath(path)}`]);
  } catch (err) {
    // sftp's `dest open "<path>": <reason>` (identical in OpenSSH 9.2 and 10.2)
    // is the open itself failing: nothing was truncated or written.
    const refusal = /^sftp failed \(exit \d+\): (dest open ".*": .*)/.exec(errorText(err));
    if (!refusal) throw err;
    throw new WriteRefused(`write refused, ${path} unchanged: ${refusal[1]}`, { cause: err });
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

function directoryListing(
  path: string,
  entries: Array<{ name: string; detail: string }>,
  incomplete: boolean,
): Record<string, unknown> {
  let used = 0;
  let n = 0;
  for (; n < entries.length; n++) {
    used += Buffer.byteLength(entries[n]!.detail) + Buffer.byteLength(entries[n]!.name) + 32;
    if (used > READ_OUTPUT_BYTES) break;
  }
  const listing = { path, type: "directory", entries: entries.slice(0, n) };
  if (!incomplete && n === entries.length) return { ...listing, truncated: false };
  return {
    ...listing,
    truncated: true,
    note:
      `listing cut to ${n} entries (${READ_OUTPUT_BYTES}-byte budget), so this is a subset; ` +
      "page through the directory with ssh_exec, e.g. `ls -la <dir> | sed -n '1,500p'` " +
      "or `find <dir> -maxdepth 1 -name '<pattern>'`",
  };
}

export async function readTool(
  args: { path?: unknown; offset?: unknown; limit?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const path = remotePath(args.path);
  const quoted = quoteSftpLsPath(path);
  const offset = intArg(args.offset, "offset", 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = intArg(args.limit, "limit", READ_LIMIT_DEFAULT, 1, READ_LIMIT_MAX);
  const s = await session(deps);
  const { target, incomplete } = await statPath(s, path, quoted);
  if (target.kind === "directory") {
    if (args.offset !== undefined || args.limit !== undefined) {
      throw new ProtocolError(`${path} is a directory; offset and limit apply to files only`);
    }
    return directoryListing(path, target.entries, incomplete);
  }

  const lines = splitLines((await fetchText(s, path, target.size)).text);
  const file = { path, type: "file", bytes: target.size, total_lines: lines.length };
  if (lines.length === 0) return { ...file, content: "[empty file]", next_offset: null };
  if (offset > lines.length) {
    throw new ProtocolError(`offset ${offset} is past the end of ${path} (${lines.length} lines)`);
  }
  const to = Math.min(lines.length, offset + limit - 1);
  const { text, last } = renderLines(lines, offset, to, READ_OUTPUT_BYTES);
  if (last === lines.length) return { ...file, content: text, next_offset: null };
  const why = last < to ? `output cap of ${READ_OUTPUT_BYTES} bytes reached: ` : "";
  return {
    ...file,
    content: `${text}[${why}lines ${offset}-${last} of ${lines.length} shown; call ssh_read with offset=${last + 1} to continue]`,
    next_offset: last + 1,
  };
}

export async function writeFileTool(
  args: { path?: unknown; content?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const path = remotePath(args.path);
  const quoted = quoteSftpLsPath(path);
  const content = stringArg(args.content, "content");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > FILE_BYTES_MAX) {
    throw new ProtocolError(
      `\`content\` is ${bytes} bytes, over the ${FILE_BYTES_MAX}-byte ceiling`,
    );
  }
  const s = await session(deps);
  // `put` onto a directory drops the file INSIDE it under the scratch name, so
  // the target is stat'ed first; only "not found" means a new file.
  const existing = await statPath(s, path, quoted).then(
    ({ target }) => target,
    (err: unknown) => {
      if (/^sftp failed \(exit \d+\): Can't ls: ".*" not found/.test(errorText(err))) return null;
      throw err;
    },
  );
  if (existing?.kind === "directory") throw new ProtocolError(`${path} is a directory`);
  try {
    await putFile(s, path, content);
  } catch (err) {
    if (err instanceof WriteRefused) throw err;
    // `put` truncates before it streams: a failure can leave the file cut short.
    throw new Error(`write failed — ${path} may be truncated: ${errorText(err)}`, { cause: err });
  }
  return { path, bytes };
}

export async function editFileTool(
  args: { path?: unknown; old_str?: unknown; new_str?: unknown; replace_all?: unknown },
  deps: Deps = {},
): Promise<Record<string, unknown>> {
  const path = remotePath(args.path);
  const quoted = quoteSftpLsPath(path);
  if (typeof args.old_str !== "string" || args.old_str === "") {
    throw new ProtocolError(
      "`old_str` must be a non-empty string; to create or replace a whole file, use ssh_write_file",
    );
  }
  const oldStr = args.old_str;
  const newStr = stringArg(args.new_str, "new_str");
  if (oldStr === newStr) throw new ProtocolError("`old_str` and `new_str` are identical");
  if (args.replace_all !== undefined && typeof args.replace_all !== "boolean") {
    throw new ProtocolError("`replace_all` must be a boolean");
  }
  const s = await session(deps);
  const { target } = await statPath(s, path, quoted);
  if (target.kind === "directory") throw new ProtocolError(`${path} is a directory`);
  const original = await fetchText(s, path, target.size);
  const before = original.text;

  const pieces = before.split(oldStr);
  const count = pieces.length - 1;
  if (count === 0) {
    const crlf =
      before.includes("\r\n") && oldStr.includes("\n") && !oldStr.includes("\r\n")
        ? " The file has CRLF line endings: write each line break in old_str as \\r\\n."
        : "";
    throw new ProtocolError(
      `old_str was not found in ${path}. It must match exactly, whitespace and indentation ` +
        "included, without the line-number prefix ssh_read adds; read the file again if it may have changed." +
        crlf,
    );
  }
  if (count > 1 && args.replace_all !== true) {
    throw new ProtocolError(
      `old_str occurs ${count} times in ${path}; include more surrounding text to make it unique, ` +
        "or set replace_all to replace every occurrence.",
    );
  }
  // `split`/`join`, never `String.replace`: `$&` and `$1` in new_str are text.
  const after = pieces.join(newStr);
  const bytes = Buffer.byteLength(after, "utf8");
  if (bytes > FILE_BYTES_MAX) {
    throw new ProtocolError(`the edit would make ${path} ${bytes} bytes, over ${FILE_BYTES_MAX}`);
  }

  // Nothing locks the file between the `get` above and this `put`: a write
  // landing in between is lost. A failed `put` may have truncated the file,
  // so the original bytes go back once before the failure is reported.
  try {
    await putFile(s, path, after);
  } catch (err) {
    if (err instanceof WriteRefused) throw err;
    const restored = await putFile(s, path, original.bytes).then(
      () => true,
      () => false,
    );
    throw new Error(
      restored
        ? `write failed; original restored: ${errorText(err)}`
        : `write failed and restore failed — ${path} may be truncated: ${errorText(err)}`,
      { cause: err },
    );
  }

  const lines = splitLines(after);
  const startLine = pieces[0]!.split("\n").length;
  // Lines the replacement occupies: a trailing "\n" ends its last line, it does not open one.
  const endLine = startLine + newStr.replace(/\n$/, "").split("\n").length - 1;
  const from = Math.max(1, startLine - EDIT_CONTEXT_LINES);
  const to = Math.min(lines.length, endLine + EDIT_CONTEXT_LINES);
  const snippet = from <= to ? renderLines(lines, from, to, EDIT_SNIPPET_BYTES) : null;
  return {
    path,
    replacements: count,
    bytes,
    snippet: snippet ? snippet.text + (snippet.last < to ? "[…]" : "") : "",
  };
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
 * agent is NOT granted, as `readOnlyHint: false` does for MCP clients;
 * `scripts/test/ssh-mcp.test.ts` pins all three.
 */
const READ_HINTS = { readOnlyHint: true, openWorldHint: true };
const WRITE_HINTS = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const TOOLS = [
  {
    name: "ssh_probe",
    description:
      "Connect, verify the pinned host key and authenticate, then report how the host was reached. Executes nothing on the target and returns no remote data. Read-only.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_HINTS,
  },
  {
    name: "ssh_exec",
    description: `Run a command on the remote host, as the connection's Unix account. WRITES — this tool can do anything that account can do; withhold it from an agent that must not change the target. The string is handed to the account's login shell, so shell syntax works and quoting is yours to get right. After \`timeout_seconds\` (default 120, max 600) the command's process group on the target — background jobs it started included — gets SIGTERM, then SIGKILL 5 s later, and the call returns at most ${STOP_CEILING_MS / 1000} s past \`timeout_seconds\` with \`timed_out: true\`, \`exit_code: null\`, \`remote_pid\`, and \`remote_process\` saying whether it ended. A process that leaves the group (\`setsid\`, a daemon) is not reached. Longer work can be started detached — \`nohup cmd > log 2>&1 < /dev/null &\`; without the redirections the call waits for it — and followed with ssh_read on the log. The server handles one call at a time: a running ssh_exec holds up every other ssh tool until it returns. Exit status 255 is reserved by ssh itself: a command exiting 255 is reported as an ssh failure. stdout and stderr over 64 KiB each keep their head and tail around an omission marker.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run on the target." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: EXEC_TIMEOUT_MAX_S,
          default: EXEC_TIMEOUT_DEFAULT_S,
          description: "Wall-clock limit for the command, in seconds.",
        },
      },
      required: ["command"],
    },
    annotations: { ...WRITE_HINTS, idempotentHint: false },
  },
  {
    name: "ssh_read",
    description:
      "Read a remote path over SFTP. A directory returns its entries, dotfiles included, sorted by name, cut at 256 KiB with a note saying so; `offset`/`limit` are refused on a directory. A UTF-8 text file returns its lines numbered like `cat -n`, from `offset` (1-based) for `limit` lines, at most 256 KiB per call; when more remains, the reply ends with the offset to read next. Binary or non-UTF-8 files and files over 8 MiB are refused — use ssh_exec for those. Symlinks are followed. Relative paths, `~` and `~/…` start at the account's home directory; `~user` is refused. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "First line to return (files only).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: READ_LIMIT_MAX,
          default: READ_LIMIT_DEFAULT,
          description: "Number of lines to return (files only).",
        },
      },
      required: ["path"],
    },
    annotations: READ_HINTS,
  },
  {
    name: "ssh_write_file",
    description:
      "Write a remote file over SFTP, creating or overwriting it (8 MiB at most; a directory is refused). An existing file keeps its mode; a new file is created 0600 — chmod it with ssh_exec if needed. A symlink is followed: its target is written. Relative paths, `~` and `~/…` start at the account's home directory; `~user` is refused. WRITES — withhold it from an agent that must not change the target.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    annotations: { ...WRITE_HINTS, idempotentHint: true },
  },
  {
    name: "ssh_edit_file",
    description:
      "Replace an exact string in a remote UTF-8 text file over SFTP, rewriting it in place so its mode, owner and links are kept; a symlink is followed and its target edited. `old_str` must occur exactly once unless `replace_all` is set; copy it from ssh_read output without the line-number prefix, whitespace included. Relative paths, `~` and `~/…` start at the account's home directory; `~user` is refused. WRITES — withhold it from an agent that must not change the target.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string", description: "Exact text to replace; must not be empty." },
        new_str: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          default: false,
          description: "Replace every occurrence instead of requiring exactly one.",
        },
      },
      required: ["path", "old_str", "new_str"],
    },
    annotations: { ...WRITE_HINTS, idempotentHint: false },
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
  ["ssh_read", readTool],
  ["ssh_write_file", writeFileTool],
  ["ssh_edit_file", editFileTool],
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
        serverInfo: { name: "appstrate-ssh-mcp", version: "1.0.2" },
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
      const message = errorText(err);
      const ms = Math.round(performance.now() - started);
      // Refusals and misconfiguration are tool RESULTS the agent can act on,
      // reported as isError content rather than a protocol error that reads as
      // a dead channel. Only a malformed request is a protocol error.
      const refused = err instanceof ProtocolError;
      logLine({ op: refused ? "tool-refused" : "tool-error", tool: name, ms, message });
      const body = refused ? { refused: true, reason: message } : { error: message };
      const rejection = credentialRejection(err);
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
          // The sidecar's cue to report the connection for reconnect.
          ...(rejection
            ? { _meta: { "dev.appstrate/credential": { status: "rejected", reason: rejection } } }
            : {}),
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

if ((import.meta as unknown as { main?: boolean }).main === true) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
