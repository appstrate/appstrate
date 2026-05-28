// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub Clone — single-tool MCP server (Bun runtime, dependency-free).
 *
 * Exposes one tool, `clone_repo`, that downloads a GitHub repository
 * tarball into the per-run shared workspace and returns a small JSON
 * receipt. The file contents land on disk (the workspace volume the
 * platform mounts at `APPSTRATE_WORKSPACE`) — they never appear in the
 * MCP response body, so the agent's LLM context stays small even for
 * multi-megabyte repos.
 *
 * Wire-up:
 *   - The companion `@appstrate/github-clone` integration declares an
 *     OAuth2 auth on GitHub and `delivery.env.GITHUB_TOKEN`. The
 *     sidecar resolves the user's access token, injects it as
 *     GITHUB_TOKEN, and spawns this server in a bun runner container.
 *   - The mcp-server manifest declares
 *     `_meta["dev.appstrate/workspace"]: { mount: "/workspace", access: "rw" }`,
 *     which makes the platform bind the per-run workspace volume
 *     under /workspace and set `APPSTRATE_WORKSPACE=/workspace`.
 *   - On `tools/call clone_repo`, this server hits
 *     `GET https://api.github.com/repos/{owner}/{repo}/tarball/{ref}`
 *     with the bearer, parses entries in-memory, and writes them
 *     under `${APPSTRATE_WORKSPACE}/${dest}` (or directly into the
 *     workspace root when `dest` is omitted).
 *
 * Why a dependency-free hand-rolled stdio JSON-RPC loop instead of
 * the official `@modelcontextprotocol/sdk`?
 *
 *   - The `appstrate-mcp-runner-bun:latest` image bakes `bun` +
 *     ca-certificates but no node_modules. Bundling the SDK + its
 *     transitive deps into the package archive would inflate it
 *     from ~5 KB to several hundred KB, and the npm-install + bundle
 *     hop would complicate the build-system-packages pipeline.
 *   - The wire surface we actually need is tiny: three request types
 *     (`initialize`, `tools/list`, `tools/call`) over newline-
 *     delimited JSON-RPC on stdio. The SDK adds value for clients
 *     juggling many transports and capabilities — for a leaf server
 *     with one tool, it's overkill.
 *   - Dependency-free also makes this file a fully-portable
 *     reference for any future Appstrate mcp-server in Bun.
 *
 * Safety:
 *   - Tarball entries with absolute paths or `..` segments are
 *     rejected (path-traversal defence — the tarball comes from
 *     GitHub but we still validate, in case of upstream compromise).
 *   - Symlink and hardlink entries are skipped (no need for them in
 *     a clone; allowing them is a known tarball-escape vector).
 *   - Total payload + file count are capped via env (with defaults
 *     wide enough for typical code repos, narrow enough to fail loud
 *     on accidental clones of a binary-asset monorepo).
 */

import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB total payload
const DEFAULT_MAX_FILES = 20_000;
const GITHUB_API = "https://api.github.com";

interface CloneArgs {
  owner: string;
  repo: string;
  ref?: string;
  dest?: string;
}

interface CloneReceipt {
  path: string;
  files: number;
  bytes: number;
  topLevelPrefix: string | null;
}

/**
 * Validate + normalise the workspace destination path. Returns the
 * absolute resolved path; throws when the resolved path escapes the
 * workspace root or contains `..` segments.
 */
export function resolveDest(workspaceRoot: string, dest: string | undefined): string {
  const cleaned = (dest ?? "").replace(/^\/+/, "").trim();
  if (cleaned.split("/").some((seg) => seg === "..")) {
    throw new Error(`dest contains "..": refused for path-traversal safety`);
  }
  const resolved = resolve(workspaceRoot, cleaned);
  if (!resolved.startsWith(workspaceRoot + sep) && resolved !== workspaceRoot) {
    throw new Error(`dest resolves outside workspace root: ${resolved}`);
  }
  return resolved;
}

/**
 * Minimal POSIX-tar parser. Reads typeflag, name, size; skips
 * symlinks/hardlinks/longlinks/global headers (those add complexity
 * without earning their keep for a code-clone path). Returns an array
 * of `{ name, content }` entries.
 *
 * Handles the GNU LongLink extension (type 'L'), which GitHub
 * tarballs emit for paths > 100 chars — without it, the first deep
 * file in a monorepo would surface as a malformed entry.
 *
 * Exported for unit testing.
 */
export function parseTar(buf: Buffer): Array<{ name: string; content: Buffer }> {
  const out: Array<{ name: string; content: Buffer }> = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header[0] === 0 && header[156] === 0) break;

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/[\0\s]/g, "");
    const size = sizeOctal.length > 0 ? parseInt(sizeOctal, 8) : 0;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      throw new Error("truncated tar entry");
    }
    const payload = buf.subarray(dataStart, dataEnd);

    if (typeflag === "L") {
      pendingLongName = payload.toString("utf8").replace(/\0.*$/, "");
    } else if (typeflag === "0" || typeflag === "" || typeflag === "\0") {
      const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      pendingLongName = null;
      out.push({ name, content: payload });
    } else if (typeflag === "5") {
      pendingLongName = null;
    } else {
      pendingLongName = null;
    }

    const padded = Math.ceil(size / 512) * 512;
    offset = dataStart + padded;
  }
  return out;
}

/**
 * Detect the single top-level directory prefix every entry shares
 * (GitHub tarballs wrap everything under `<owner>-<repo>-<sha>/`).
 * Returns null when no consistent prefix exists.
 *
 * Exported for unit testing.
 */
export function detectTopLevelPrefix(entries: ReadonlyArray<{ name: string }>): string | null {
  if (entries.length === 0) return null;
  const first = entries[0]!.name.split("/")[0];
  if (!first) return null;
  return entries.every((e) => e.name === first || e.name.startsWith(`${first}/`)) ? first : null;
}

/**
 * Internal — runs the actual clone. Exported for unit testing; the
 * caller stubs `fetch` via the `fetchImpl` injection to avoid live
 * GitHub calls.
 */
export async function cloneRepo(
  args: CloneArgs,
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<CloneReceipt> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const workspaceEnv = env.APPSTRATE_WORKSPACE;
  if (!workspaceEnv) {
    throw new Error(
      "APPSTRATE_WORKSPACE is not set — this server requires the platform to mount the per-run workspace. " +
        'Check that the integration\'s referenced mcp-server declares _meta["dev.appstrate/workspace"] AND that the run was launched on a workspace-capable orchestrator.',
    );
  }
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set — this server requires the @appstrate/github-clone integration's OAuth2 delivery.env mapping",
    );
  }

  const workspaceRoot = resolve(workspaceEnv);
  const destPath = resolveDest(workspaceRoot, args.dest);
  await mkdir(destPath, { recursive: true });

  const ref = args.ref ?? "HEAD";
  const url = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/tarball/${encodeURIComponent(ref)}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "appstrate-github-clone-mcp/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub tarball download failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
    );
  }

  const maxBytes = Number(env.GITHUB_CLONE_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  const maxFiles = Number(env.GITHUB_CLONE_MAX_FILES ?? DEFAULT_MAX_FILES);

  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.byteLength > maxBytes) {
    throw new Error(
      `Tarball exceeds GITHUB_CLONE_MAX_BYTES (${gz.byteLength} > ${maxBytes}). Increase the env or narrow the ref.`,
    );
  }
  const tar = gunzipSync(gz);

  const entries = parseTar(tar);
  if (entries.length > maxFiles) {
    throw new Error(
      `Tarball contains ${entries.length} files (> GITHUB_CLONE_MAX_FILES=${maxFiles}). Refusing as a defensive cap.`,
    );
  }

  const topLevelPrefix = detectTopLevelPrefix(entries);

  let bytesWritten = 0;
  let filesWritten = 0;
  for (const entry of entries) {
    const stripped =
      topLevelPrefix && entry.name.startsWith(`${topLevelPrefix}/`)
        ? entry.name.slice(topLevelPrefix.length + 1)
        : entry.name === topLevelPrefix
          ? ""
          : entry.name;
    if (!stripped) continue;
    if (stripped.split("/").some((seg) => seg === "..")) {
      throw new Error(`tarball entry contains "..": ${entry.name}`);
    }
    const filePath = join(destPath, stripped);
    if (!filePath.startsWith(destPath + sep) && filePath !== destPath) {
      throw new Error(`tarball entry resolves outside destination: ${entry.name}`);
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, entry.content);
    bytesWritten += entry.content.byteLength;
    filesWritten++;
  }

  return {
    path: destPath,
    files: filesWritten,
    bytes: bytesWritten,
    topLevelPrefix,
  };
}

// ───────────────────────── MCP stdio JSON-RPC loop ─────────────────────────

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

const CLONE_TOOL = {
  name: "clone_repo",
  description:
    "Download a GitHub repository tarball into the agent's shared workspace. Uses the OAuth2 GITHUB_TOKEN env var. Returns a JSON receipt with the absolute destination path, file count, and byte count. The repo contents land on disk; they do NOT enter the LLM context.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "GitHub repository owner (user or org)." },
      repo: { type: "string", description: "GitHub repository name." },
      ref: {
        type: "string",
        description:
          "Git ref to clone — branch, tag, or commit SHA. Defaults to the repository's default branch (HEAD).",
      },
      dest: {
        type: "string",
        description:
          "Workspace-relative destination directory (e.g. `repo`). Defaults to the workspace root. Absolute paths and `..` traversal are rejected.",
      },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
  },
};

export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "appstrate-github-clone-mcp", version: "1.0.0" },
      },
    };
  }
  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id: req.id ?? null, result: { tools: [CLONE_TOOL] } };
  }
  if (req.method === "tools/call") {
    const params = (req.params ?? {}) as { name?: string; arguments?: Partial<CloneArgs> };
    if (params.name !== CLONE_TOOL.name) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
        },
      };
    }
    const args = params.arguments ?? {};
    if (typeof args.owner !== "string" || typeof args.repo !== "string") {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: "owner and repo are required string fields" }],
        },
      };
    }
    try {
      const receipt = await cloneRepo({
        owner: args.owner,
        repo: args.repo,
        ...(typeof args.ref === "string" ? { ref: args.ref } : {}),
        ...(typeof args.dest === "string" ? { dest: args.dest } : {}),
      });
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }] },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        },
      };
    }
  }
  // Notifications (no id) — silently accept.
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
        process.stderr.write(`[github-clone-mcp] dropping malformed line: ${line.slice(0, 120)}\n`);
        continue;
      }
      const res = await handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}

// `import.meta.main` is the Bun-native entry guard; falls back to a
// simple env check so the file stays importable for unit tests
// without triggering the stdin loop.
const isEntry =
  (import.meta as unknown as { main?: boolean }).main === true ||
  process.env.GITHUB_CLONE_MCP_FORCE_MAIN === "1";
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
