// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub Git — full clone/edit/commit/push/PR MCP server (Bun, dependency-free).
 *
 * Shells out to the `git` CLI baked into the bun runner image
 * (`runtime-pi/runners/bun/Dockerfile` adds git + openssh-client) and
 * hits the GitHub REST API for the operations that have no git
 * equivalent (open_pr, default-branch lookup, identity for commit
 * config). Pairs with the @appstrate/github-git integration which mints
 * `GITHUB_TOKEN` via OAuth2 with `repo` scope.
 *
 * Workspace contract:
 *
 *   - The sidecar mounts the per-run workspace volume at
 *     `APPSTRATE_WORKSPACE` (set by the platform from
 *     `_meta["dev.appstrate/workspace"]`). Every working-tree operation
 *     resolves under this root and refuses paths that escape it
 *     (`..` segments, leading slashes that survive normalisation).
 *   - Files land on the shared volume that the agent reads/writes via
 *     the platform runtime tools (Bash/Read/Edit). They never enter
 *     the LLM context — only the small JSON receipts this server
 *     returns do.
 *
 * Auth:
 *
 *   - The token never lands on disk. `.git/config` carries only the
 *     remote URL; the bearer is injected per-command via the
 *     `GIT_CONFIG_COUNT/KEY/VALUE` env vars feeding `http.extraheader`.
 *     That mechanism is what GitHub's own tooling uses on CI (gh
 *     auth, actions/checkout) so it's the SOTA pattern, not a custom
 *     workaround.
 *   - GitHub identity (`login`, noreply email) is fetched once on
 *     first `commit` and used to set local `user.name`/`user.email`
 *     when the cloned repo has none. Avoids the "Author identity
 *     unknown" git error without forcing every agent to set them by
 *     hand.
 *
 * Why hand-rolled (not @modelcontextprotocol/sdk): bundle stays ~10 KB,
 * no node_modules in the runner image, the wire surface we need is
 * three RPC methods (initialize, tools/list, tools/call).
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const GITHUB_API = "https://api.github.com";
const GITHUB_HOST = "https://github.com";
const DIFF_TRUNCATE_BYTES = 200 * 1024;

// ────────────────────────── path safety ──────────────────────────────

/**
 * Resolve a workspace-relative path to an absolute path; throw on any
 * traversal attempt or escape. Defence-in-depth: strip leading slashes
 * (workspace-relative semantics), reject literal `..` segments, then
 * belt-and-suspenders check that the resolved path stays under root.
 */
export function resolveInWorkspace(workspaceRoot: string, rel: string | undefined): string {
  const cleaned = (rel ?? "").replace(/^\/+/, "").trim();
  if (cleaned.split("/").some((seg) => seg === "..")) {
    throw new Error(`path contains "..": refused for path-traversal safety`);
  }
  const resolved = resolve(workspaceRoot, cleaned);
  if (!resolved.startsWith(workspaceRoot + sep) && resolved !== workspaceRoot) {
    throw new Error(`path resolves outside workspace root: ${resolved}`);
  }
  return resolved;
}

/**
 * Pick the default clone destination from `owner/repo` when the agent
 * omits `dest`. Just the repo name — keeps clones siblings inside the
 * workspace root instead of nested under `owner/`.
 */
export function defaultDestForRepo(_owner: string, repo: string): string {
  return repo;
}

/**
 * Screen an agent-supplied ref/branch value before it lands in a
 * positional `git` argument. git treats a leading `-` as a CLI option
 * and `:` as refspec syntax, so an unguarded value reaches git as a
 * flag/refspec rather than a ref:
 *
 *   - `ref: "-f"`        → `git checkout -f`        → discards the
 *     working tree (confirmed data loss on the shared workspace)
 *   - `ref: "--orphan"`  → `git checkout --orphan`  → unintended state
 *   - `branch: ":main"`  → `git push origin :main`  → deletes the
 *     remote branch without `force`
 *
 * Tools spawn git via an argv array (no shell), so this is about git's
 * own option/refspec parsing — not shell injection. Reject rather than
 * sanitise: a value that looks like a flag or refspec is never a ref
 * the agent legitimately meant.
 */
export function assertSafeRefArg(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with "-": git would parse it as an option`);
  }
  if (value.startsWith("+")) {
    throw new Error(`${label} must not start with "+": git would parse it as a force refspec`);
  }
  // Control chars + refspec/whitespace separators are never valid in a
  // ref or branch name (git check-ref-format rejects them too).
  // eslint-disable-next-line no-control-regex -- screening control chars is the point
  if (/[\x00-\x1f\s:]/.test(value)) {
    throw new Error(`${label} contains characters not allowed in a git ref/branch`);
  }
  return value;
}

// ────────────────────── git invocation helpers ──────────────────────

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunGitOptions {
  cwd?: string;
  /** Capture stdout (default true). */
  capture?: boolean;
}

/**
 * Structured stderr log line. Format: `[github-git-mcp] op=<phase>
 * tool=<tool> ...key=value`. Goes through `process.stderr.write` so
 * the sidecar's per-integration log pipeline picks it up verbatim
 * (the platform tags it with `integrationId` upstream).
 */
function logLine(fields: Record<string, string | number | boolean>): void {
  const parts: string[] = ["[github-git-mcp]"];
  for (const [k, v] of Object.entries(fields)) {
    const val = typeof v === "string" ? v : String(v);
    parts.push(`${k}=${val.includes(" ") ? JSON.stringify(val) : val}`);
  }
  process.stderr.write(parts.join(" ") + "\n");
}

/**
 * Classify a git stderr blob into an actionable hint. Returns a short
 * string when a known failure pattern matches, otherwise undefined.
 * Lets `runGit` enrich the thrown error with operator guidance instead
 * of just dumping the raw stderr. Exported for unit testing.
 */
export function classifyGitError(stderr: string): string | undefined {
  if (/Permission denied|EACCES|EPERM/i.test(stderr)) {
    return (
      "workspace permission denied — likely runner UID mismatch with workspace owner. " +
      "Expected runner UID 1001 (matches the agent's pi user). Rebuild the runner image with the latest Dockerfile."
    );
  }
  if (/dubious ownership/i.test(stderr)) {
    return (
      'git refused the working tree as "dubious ownership" — runner UID differs from the .git owner. ' +
      "This server now passes `-c safe.directory='*'` on every invocation; if you still see this, the working tree predates the fix."
    );
  }
  if (/could not resolve host|Temporary failure in name resolution|getaddrinfo/i.test(stderr)) {
    return (
      "DNS resolution failed — runner is on an internal network and must route through the sidecar proxy. " +
      "Verify HTTPS_PROXY is set in the runner env (sidecar injects it via buildMitmEnvBlock)."
    );
  }
  if (/SSL certificate problem|unable to get local issuer/i.test(stderr)) {
    return (
      "git rejected the MITM TLS cert — `GIT_SSL_CAINFO` is not set in the runner env. " +
      "The sidecar should inject it via buildMitmEnvBlock; verify the platform is on a build that includes the GIT_SSL_CAINFO addition."
    );
  }
  if (/Authentication failed|401|403/i.test(stderr)) {
    return "GitHub rejected the bearer token — confirm the OAuth connection still has `repo` scope and hasn't expired.";
  }
  if (/Repository not found|404/i.test(stderr)) {
    return (
      "GitHub returned 404 — the repository may not exist OR the token lacks access. " +
      "Re-check owner/repo casing and the connected user's permissions."
    );
  }
  return undefined;
}

/**
 * Spawn `git`. Returns stdout/stderr/exit code. Throws on non-zero
 * exit with a classified hint when one applies.
 *
 * Transport + auth: the github-git integration declares `delivery.http`
 * with `prefix: "Basic "`, `value: "x-access-token:{$credential
 * .access_token}"`, `encoding: "base64"`. The sidecar's per-run MITM
 * proxy renders that to `Authorization: Basic
 * <base64('x-access-token:<token>')>` and injects it on every request
 * matching the integration's `authorized_uris` — the format GitHub's
 * git smart-HTTP layer actually accepts (Bearer works for the REST
 * API but is rejected by `/info/refs` + `/git-upload-pack` +
 * `/git-receive-pack`). The MITM also sets `HTTPS_PROXY` +
 * `CURL_CA_BUNDLE` + `GIT_SSL_CAINFO` in the runner env. We inherit
 * `process.env` wholesale so libcurl / git honour all of them;
 * stripping the env would break both transport and auth simultaneously.
 *
 * The token therefore NEVER lands in the MCP server: it lives on the
 * sidecar side and gets injected per-request. The server only spawns
 * git and reads the response. This is the same trust model as every
 * other workspace integration (gmail-mcp, github-mcp).
 *
 * Always prepends `-c safe.directory='*'` — git refuses to operate on
 * a working tree whose ownership differs from the calling uid. Even
 * with UID-1001 runners we can hit this when the agent clones via its
 * own bash (also uid 1001 but a different shell user record) and the
 * MCP runner picks up later. Belt-and-suspenders, no functional cost.
 */
async function runGit(args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Force git to fail rather than block waiting on an interactive
  // credential prompt — there is no terminal in the runner.
  env.GIT_TERMINAL_PROMPT = "0";

  const fullArgs = ["-c", "safe.directory=*", ...args];
  const started = performance.now();
  logLine({
    op: "git-spawn",
    cmd: args[0] ?? "<unknown>",
    cwd: opts.cwd ?? "<inherit>",
  });

  const proc = Bun.spawn(["git", ...fullArgs], {
    cwd: opts.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const elapsed = Math.round(performance.now() - started);
  logLine({ op: "git-exit", cmd: args[0] ?? "<unknown>", code, ms: elapsed });
  if (code !== 0) {
    const hint = classifyGitError(stderr);
    const rawTail = stderr.trim() || stdout.trim();
    const msg = hint
      ? `git ${args[0]} failed (exit ${code}): ${rawTail}\nhint: ${hint}`
      : `git ${args[0]} failed (exit ${code}): ${rawTail}`;
    throw new Error(msg);
  }
  return { stdout, stderr, code };
}

// ──────────────────────── GitHub REST helpers ────────────────────────

interface GhFetchDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Send a GitHub REST request. NO Authorization header is set — the
 * sidecar's per-run MITM proxy (declared via `delivery.http` on the
 * integration manifest) intercepts the HTTPS connection and injects
 * the bearer token per-request. The server never sees the token,
 * matching how every other workspace integration on the platform
 * (github-mcp, gmail-mcp) handles auth.
 */
async function ghFetch(
  path: string,
  init: RequestInit = {},
  deps: GhFetchDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return fetchImpl(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "appstrate-github-git-mcp/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

async function ghJson<T>(path: string, init: RequestInit = {}, deps: GhFetchDeps = {}): Promise<T> {
  const method = init.method ?? "GET";
  const started = performance.now();
  logLine({ op: "github-fetch", method, path });
  const res = await ghFetch(path, init, deps);
  const elapsed = Math.round(performance.now() - started);
  logLine({ op: "github-fetch-done", method, path, status: res.status, ms: elapsed });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint =
      res.status === 401
        ? " hint: bearer token rejected by MITM or GitHub — re-check the OAuth connection's scope grant and expiry."
        : res.status === 403
          ? " hint: forbidden — the token's scopes don't cover this resource (need `repo` for private, `public_repo` for public)."
          : res.status === 404
            ? " hint: 404 — the repo may not exist OR the token lacks visibility into it."
            : "";
    throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${body.slice(0, 200)}.${hint}`);
  }
  return (await res.json()) as T;
}

interface GhUser {
  login: string;
  id: number;
  email?: string | null;
}

interface GhRepo {
  default_branch: string;
}

interface GhPullCreated {
  number: number;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

// ────────────────────────── tool handlers ────────────────────────────

interface CloneArgs {
  owner: string;
  repo: string;
  ref?: string;
  dest?: string;
}

export async function cloneTool(
  args: CloneArgs,
  ctx: { workspaceRoot: string },
): Promise<{ path: string; branch: string }> {
  const dest = args.dest ?? defaultDestForRepo(args.owner, args.repo);
  const target = resolveInWorkspace(ctx.workspaceRoot, dest);
  await mkdir(dirname(target), { recursive: true });
  const url = `${GITHUB_HOST}/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}.git`;
  // `--no-tags` + `--depth=1` would be faster but break later push/branch
  // operations; agents that want a shallow clone can opt in later if it
  // becomes a real ergonomic problem. Default to a full clone — KISS.
  await runGit(["clone", url, target]);
  if (args.ref) {
    assertSafeRefArg(args.ref, "ref");
    await runGit(["checkout", args.ref], { cwd: target });
  }
  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: target });
  return { path: target, branch: head.stdout.trim() };
}

interface CheckoutBranchArgs {
  repo: string;
  branch: string;
  create?: boolean;
  base?: string;
}

export async function checkoutBranchTool(
  args: CheckoutBranchArgs,
  ctx: { workspaceRoot: string },
): Promise<{ branch: string }> {
  const cwd = resolveInWorkspace(ctx.workspaceRoot, args.repo);
  assertSafeRefArg(args.branch, "branch");
  const gitArgs = ["switch"];
  if (args.create) {
    gitArgs.push("-c", args.branch);
    if (args.base) gitArgs.push(assertSafeRefArg(args.base, "base"));
  } else {
    gitArgs.push(args.branch);
  }
  await runGit(gitArgs, { cwd });
  return { branch: args.branch };
}

interface StatusArgs {
  repo: string;
}

export async function statusTool(
  args: StatusArgs,
  ctx: { workspaceRoot: string },
): Promise<{ output: string }> {
  const cwd = resolveInWorkspace(ctx.workspaceRoot, args.repo);
  const res = await runGit(["status", "--short"], { cwd });
  return { output: res.stdout };
}

interface DiffArgs {
  repo: string;
  staged?: boolean;
}

export async function diffTool(
  args: DiffArgs,
  ctx: { workspaceRoot: string },
): Promise<{ output: string; truncated: boolean }> {
  const cwd = resolveInWorkspace(ctx.workspaceRoot, args.repo);
  const res = await runGit(["diff", ...(args.staged ? ["--staged"] : [])], { cwd });
  if (res.stdout.length > DIFF_TRUNCATE_BYTES) {
    return { output: res.stdout.slice(0, DIFF_TRUNCATE_BYTES), truncated: true };
  }
  return { output: res.stdout, truncated: false };
}

let cachedIdentity: { name: string; email: string } | null = null;

async function ensureCommitIdentity(
  cwd: string,
  deps: GhFetchDeps,
): Promise<{ name: string; email: string }> {
  // Caller-side check first — already-configured local identity wins
  // (operator may have set it deliberately via a prior `git config`).
  try {
    const [n, e] = await Promise.all([
      runGit(["config", "user.name"], { cwd }),
      runGit(["config", "user.email"], { cwd }),
    ]);
    const name = n.stdout.trim();
    const email = e.stdout.trim();
    if (name && email) return { name, email };
  } catch {
    // `git config <key>` exits 1 when unset — fall through to derive.
  }
  if (!cachedIdentity) {
    const user = await ghJson<GhUser>("/user", {}, deps);
    cachedIdentity = {
      name: user.login,
      // GitHub's noreply pattern includes the user id so commits are
      // attributable in the UI without leaking the user's real email.
      email: user.email ?? `${user.id}+${user.login}@users.noreply.github.com`,
    };
  }
  await runGit(["config", "user.name", cachedIdentity.name], { cwd });
  await runGit(["config", "user.email", cachedIdentity.email], { cwd });
  return cachedIdentity;
}

interface CommitArgs {
  repo: string;
  message: string;
  paths?: string[];
}

export async function commitTool(
  args: CommitArgs,
  ctx: { workspaceRoot: string },
  deps: GhFetchDeps = {},
): Promise<{ sha: string; message: string }> {
  const cwd = resolveInWorkspace(ctx.workspaceRoot, args.repo);
  await ensureCommitIdentity(cwd, deps);
  if (args.paths && args.paths.length > 0) {
    // Validate each path stays inside the repo (the workspace check
    // alone would let `../other-repo/...` slip through — the resolved
    // path is inside the workspace but outside this repo's working
    // tree).
    for (const p of args.paths) {
      const abs = resolveInWorkspace(cwd, p);
      if (abs !== cwd && !abs.startsWith(cwd + sep)) {
        throw new Error(`commit path resolves outside repo: ${p}`);
      }
    }
    await runGit(["add", "--", ...args.paths], { cwd });
  } else {
    await runGit(["add", "-A"], { cwd });
  }
  await runGit(["commit", "-m", args.message], { cwd });
  const head = await runGit(["rev-parse", "HEAD"], { cwd });
  return { sha: head.stdout.trim(), message: args.message };
}

interface PushArgs {
  repo: string;
  branch?: string;
  force?: boolean;
}

export async function pushTool(
  args: PushArgs,
  ctx: { workspaceRoot: string },
): Promise<{ ref: string }> {
  const cwd = resolveInWorkspace(ctx.workspaceRoot, args.repo);
  const branch =
    args.branch ?? (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
  // Guard agent-supplied branch only — a value read back from
  // `rev-parse` is git's own output and already a valid ref.
  if (args.branch !== undefined) assertSafeRefArg(args.branch, "branch");
  const gitArgs = ["push", "-u", "origin", branch];
  if (args.force) gitArgs.push("--force-with-lease");
  await runGit(gitArgs, { cwd });
  return { ref: `origin/${branch}` };
}

interface OpenPrArgs {
  owner: string;
  repo: string;
  head: string;
  base?: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export async function openPrTool(
  args: OpenPrArgs,
  deps: GhFetchDeps = {},
): Promise<{ number: number; url: string; head: string; base: string }> {
  let base = args.base;
  if (!base) {
    const repoInfo = await ghJson<GhRepo>(
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`,
      {},
      deps,
    );
    base = repoInfo.default_branch;
  }
  const pr = await ghJson<GhPullCreated>(
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: args.title,
        head: args.head,
        base,
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.draft !== undefined ? { draft: args.draft } : {}),
      }),
    },
    deps,
  );
  return { number: pr.number, url: pr.html_url, head: pr.head.ref, base: pr.base.ref };
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

const TOOLS = [
  {
    name: "clone",
    description:
      "Clone a GitHub repository into the per-run shared workspace. Returns the absolute clone path + checked-out branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub repository owner (user or org)." },
        repo: { type: "string", description: "GitHub repository name." },
        ref: {
          type: "string",
          description: "Optional branch, tag, or SHA to checkout after clone. Defaults to HEAD.",
        },
        dest: {
          type: "string",
          description:
            "Workspace-relative clone destination directory. Defaults to the repo name. Absolute paths and `..` traversal are rejected.",
        },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "checkout_branch",
    description:
      "Switch to (or create + switch to) a branch in a cloned repo. Set `create: true` to create the branch; optional `base` selects the start point.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Workspace-relative path to the cloned repo." },
        branch: { type: "string", description: "Branch name." },
        create: { type: "boolean", description: "Create the branch if it doesn't exist." },
        base: {
          type: "string",
          description: "Start point for the new branch (only used with `create: true`).",
        },
      },
      required: ["repo", "branch"],
      additionalProperties: false,
    },
  },
  {
    name: "status",
    description: "Return `git status --short` for a cloned repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Workspace-relative path to the cloned repo." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
  {
    name: "diff",
    description: "Return `git diff` for a cloned repo. Truncated at 200KB.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Workspace-relative path to the cloned repo." },
        staged: {
          type: "boolean",
          description: "When true, returns `git diff --staged` instead of unstaged changes.",
        },
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
  {
    name: "commit",
    description:
      "Stage paths (or all changes when omitted) and create a commit. Sets `user.name`/`user.email` from the GitHub identity when unset on the local repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Workspace-relative path to the cloned repo." },
        message: { type: "string", description: "Commit message." },
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Repo-relative paths to stage. Defaults to `git add -A` (everything) when omitted.",
        },
      },
      required: ["repo", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "push",
    description:
      "Push the current branch to origin. Sets the upstream on first push. Optional `force: true` uses `--force-with-lease`.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Workspace-relative path to the cloned repo." },
        branch: {
          type: "string",
          description: "Branch to push. Defaults to the currently checked-out branch.",
        },
        force: {
          type: "boolean",
          description: "Force push with lease (safer than --force, still rewrites remote).",
        },
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
  {
    name: "open_pr",
    description:
      "Open a pull request via the GitHub REST API. `head` is the branch with the changes; `base` defaults to the repository's default branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Target repository owner." },
        repo: { type: "string", description: "Target repository name." },
        head: {
          type: "string",
          description:
            "Head branch — either `branch-name` for same-repo PRs or `fork-owner:branch` for cross-repo PRs.",
        },
        base: {
          type: "string",
          description: "Base branch. Defaults to the repository's default branch.",
        },
        title: { type: "string", description: "PR title." },
        body: { type: "string", description: "PR body (markdown)." },
        draft: { type: "boolean", description: "Open as draft." },
      },
      required: ["owner", "repo", "head", "title"],
      additionalProperties: false,
    },
  },
] as const;

function requireWorkspace(env: NodeJS.ProcessEnv): { workspaceRoot: string } {
  const workspaceEnv = env.APPSTRATE_WORKSPACE;
  if (!workspaceEnv) {
    throw new Error(
      "APPSTRATE_WORKSPACE is not set — this server requires the platform to mount the per-run workspace. " +
        'Check that the integration\'s referenced mcp-server declares _meta["dev.appstrate/workspace"] AND that the run was launched on a workspace-capable orchestrator.',
    );
  }
  return { workspaceRoot: resolve(workspaceEnv) };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

interface DispatchDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export async function handleRequest(
  req: JsonRpcRequest,
  deps: DispatchDeps = {},
): Promise<JsonRpcResponse | null> {
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "appstrate-github-git-mcp", version: "1.0.0" },
      },
    };
  }
  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id: req.id ?? null, result: { tools: TOOLS } };
  }
  if (req.method === "tools/call") {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const args = params.arguments ?? {};
    const env = deps.env ?? process.env;

    // Resolve runtime context lazily — `open_pr` doesn't need a
    // workspace, the others do. Each tool requests what it actually
    // uses so a missing APPSTRATE_WORKSPACE doesn't gate a pure-API
    // call.
    // Arg-shape validation happens BEFORE we look at runtime context
    // (workspace + token) so a missing-arg call returns a clean
    // -32602 even when the runner happens to lack env config — the
    // arg shape is a property of the request, not the deployment.
    const toolStarted = performance.now();
    logLine({ op: "tool-call", tool: params.name ?? "<unset>" });
    try {
      switch (params.name) {
        case "clone": {
          const owner = asString(args.owner);
          const repo = asString(args.repo);
          if (!owner || !repo) throw new ProtocolError("owner and repo are required strings");
          const ctx = requireWorkspace(env);
          const out = await cloneTool(
            {
              owner,
              repo,
              ...(asString(args.ref) ? { ref: asString(args.ref)! } : {}),
              ...(asString(args.dest) ? { dest: asString(args.dest)! } : {}),
            },
            ctx,
          );
          return okResult(req.id, out);
        }
        case "checkout_branch": {
          const repo = asString(args.repo);
          const branch = asString(args.branch);
          if (!repo || !branch) throw new ProtocolError("repo and branch are required strings");
          const ctx = requireWorkspace(env);
          const out = await checkoutBranchTool(
            {
              repo,
              branch,
              ...(asBool(args.create) ? { create: true } : {}),
              ...(asString(args.base) ? { base: asString(args.base)! } : {}),
            },
            { workspaceRoot: ctx.workspaceRoot },
          );
          return okResult(req.id, out);
        }
        case "status": {
          const repo = asString(args.repo);
          if (!repo) throw new ProtocolError("repo is a required string");
          const ctx = requireWorkspace(env);
          const out = await statusTool({ repo }, { workspaceRoot: ctx.workspaceRoot });
          return okResult(req.id, out);
        }
        case "diff": {
          const repo = asString(args.repo);
          if (!repo) throw new ProtocolError("repo is a required string");
          const ctx = requireWorkspace(env);
          const out = await diffTool(
            { repo, ...(asBool(args.staged) ? { staged: true } : {}) },
            { workspaceRoot: ctx.workspaceRoot },
          );
          return okResult(req.id, out);
        }
        case "commit": {
          const repo = asString(args.repo);
          const message = asString(args.message);
          if (!repo || !message) throw new ProtocolError("repo and message are required strings");
          const ctx = requireWorkspace(env);
          const out = await commitTool(
            {
              repo,
              message,
              ...(asStringArray(args.paths) ? { paths: asStringArray(args.paths)! } : {}),
            },
            ctx,
            deps,
          );
          return okResult(req.id, out);
        }
        case "push": {
          const repo = asString(args.repo);
          if (!repo) throw new ProtocolError("repo is a required string");
          const ctx = requireWorkspace(env);
          const out = await pushTool(
            {
              repo,
              ...(asString(args.branch) ? { branch: asString(args.branch)! } : {}),
              ...(asBool(args.force) ? { force: true } : {}),
            },
            ctx,
          );
          return okResult(req.id, out);
        }
        case "open_pr": {
          const owner = asString(args.owner);
          const repo = asString(args.repo);
          const head = asString(args.head);
          const title = asString(args.title);
          if (!owner || !repo || !head || !title) {
            throw new ProtocolError("owner, repo, head, and title are required strings");
          }
          const out = await openPrTool(
            {
              owner,
              repo,
              head,
              title,
              ...(asString(args.base) ? { base: asString(args.base)! } : {}),
              ...(asString(args.body) ? { body: asString(args.body)! } : {}),
              ...(asBool(args.draft) ? { draft: true } : {}),
            },
            deps,
          );
          return okResult(req.id, out);
        }
        default:
          logLine({ op: "tool-error", tool: params.name ?? "<unset>", kind: "unknown-tool" });
          return {
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: { code: -32602, message: `Unknown tool: ${params.name}` },
          };
      }
    } catch (err) {
      const elapsed = Math.round(performance.now() - toolStarted);
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ProtocolError) {
        logLine({
          op: "tool-error",
          tool: params.name ?? "<unset>",
          kind: "protocol",
          ms: elapsed,
          message,
        });
        return {
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: { code: -32602, message },
        };
      }
      logLine({
        op: "tool-error",
        tool: params.name ?? "<unset>",
        kind: "runtime",
        ms: elapsed,
        message,
      });
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: message }],
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

class ProtocolError extends Error {}

function okResult(id: number | string | null | undefined, payload: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] },
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
        process.stderr.write(`[github-git-mcp] dropping malformed line: ${line.slice(0, 120)}\n`);
        continue;
      }
      const res = await handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}

const isEntry =
  (import.meta as unknown as { main?: boolean }).main === true ||
  process.env.GITHUB_GIT_MCP_FORCE_MAIN === "1";
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}

// Helper hook used by unit tests to flush the cached identity between
// runs without resorting to fragile module reloads.
export function _resetCachedIdentityForTests(): void {
  cachedIdentity = null;
}
