// SPDX-License-Identifier: Apache-2.0

/**
 * The skill-authoring loop for MCP callers, at parity with the CLI's
 * `skills pull` / `status` / `push`: a coding agent that only has this MCP
 * server can bring a skill's files into its context, see what it changed, and
 * write them back to the DRAFT — annex files included — without publishing.
 *
 * Every mutation is an in-process dispatch to the same REST routes the CLI
 * uses (`POST /api/packages/import?draft=true`), so guards, audit and
 * permissions cannot drift between the two clients.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { zipArtifact } from "@appstrate/core/zip";
import { getErrorMessage } from "@appstrate/core/errors";
import type { Actor } from "@appstrate/connect";
import type { SpaceScope } from "../../lib/scope.ts";
import { internalDispatchHeader } from "../../lib/internal-dispatch.ts";
import { asString, textResult } from "./tool-results.ts";

export interface PackageDraftToolContext {
  origin: string;
  authHeaders: Headers;
  permissions: ReadonlySet<string>;
  actor: Actor;
  scope: SpaceScope;
  dispatch: (req: Request) => Promise<Response>;
}

/** Packaging, not content: regenerated on push, never part of a comparison. */
const IGNORED = new Set(["manifest.json", "RECORD"]);

type PackageType = "skill" | "agent" | "integration" | "mcp-server";
const TYPE_PLURAL: Record<PackageType, string> = {
  skill: "skills",
  agent: "agents",
  integration: "integrations",
  "mcp-server": "mcp-servers",
};
const PACKAGE_TYPES = Object.keys(TYPE_PLURAL) as PackageType[];

function isPackageType(value: unknown): value is PackageType {
  return typeof value === "string" && (PACKAGE_TYPES as string[]).includes(value);
}

/**
 * The type of a package the org owns, from `/api/library` — the per-type list
 * routes only show what is installed in the current space. `null` when the org
 * has no such package (a push then creates it).
 */
async function locateType(
  ctx: PackageDraftToolContext,
  packageId: string,
  spaceId?: string,
): Promise<PackageType | null> {
  const library = await dispatchJson<{ packages?: Record<string, { id?: unknown }[]> }>(
    ctx,
    "/api/library",
  );
  if (library.status === 200) {
    for (const [type, rows] of Object.entries(library.body?.packages ?? {})) {
      if (isPackageType(type) && rows.some((row) => row.id === packageId)) return type;
    }
    return null;
  }
  // No library on this instance: ask each type's detail route in turn.
  for (const type of PACKAGE_TYPES) {
    const probe = await dispatchJson<unknown>(ctx, detailPath(type, packageId), {}, spaceId);
    if (probe.status === 200) return type;
  }
  return null;
}

function detailPath(type: PackageType, packageId: string): string {
  return `/api/packages/${TYPE_PLURAL[type]}/${encodePackageIdPath(packageId)}`;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The caller's auth plus the trusted self-dispatch marker. A self-service OAuth
 * token (what `claude mcp add` obtains) is confined to the MCP protected
 * resource by RFC 8707 audience checks; the marker is what lets an in-process
 * hop to `/api/packages/*` accept it, exactly as `invoke_operation` does.
 * Without it every read here answers 401 for an OAuth caller while API keys
 * sail through — which is why the API-key integration tests could not see it.
 */
function authHeaders(ctx: PackageDraftToolContext, spaceId?: string): Headers {
  const headers = new Headers(ctx.authHeaders);
  headers.set(...internalDispatchHeader());
  // The MCP request is bound to the org's default space; an explicit `space`
  // argument re-targets this hop, the way operations that take a space id do.
  if (spaceId) headers.set("x-space-id", spaceId);
  return headers;
}

const SPACE_ARG = {
  type: "string",
  description:
    "Space to act in, by id (spc_…) or exact name. Default: the org's default space. The package must be installed there to be read; a push installs it there.",
} as const;

/** `space` argument → space id, or undefined for the default space. */
async function resolveSpaceArg(
  ctx: PackageDraftToolContext,
  value: unknown,
): Promise<string | undefined> {
  const ref = asString(value)?.trim();
  if (!ref) return undefined;
  const spaces = await dispatchJson<{ data?: { id?: unknown; name?: unknown }[] }>(
    ctx,
    "/api/spaces",
  );
  const rows = (spaces.body?.data ?? []).filter(
    (row): row is { id: string; name: string } =>
      typeof row.id === "string" && typeof row.name === "string",
  );
  const byId = rows.find((row) => row.id === ref);
  if (byId) return byId.id;
  const byName = rows.filter((row) => row.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0]!.id;
  throw new McpError(
    ErrorCode.InvalidParams,
    `space "${ref}" ${byName.length > 1 ? "matches several spaces" : "matches no space"}. Available: ${rows.map((row) => `${row.name} (${row.id})`).join(", ")}`,
  );
}

function writeAccessError(ctx: PackageDraftToolContext): string | undefined {
  if (!ctx.permissions.has("mcp:invoke") || !ctx.permissions.has("agents:write")) {
    return "Permissions 'mcp:invoke' and 'agents:write' are required to write a package draft.";
  }
  if (ctx.actor.type !== "user") return "Only organization users can write package drafts.";
  return undefined;
}

export function canWritePackageDrafts(ctx: PackageDraftToolContext): boolean {
  return writeAccessError(ctx) === undefined;
}

function requirePackageId(value: unknown): string {
  const id = asString(value);
  if (!id || !parseScopedName(id)) {
    throw new McpError(ErrorCode.InvalidParams, "package_id must be @scope/name.");
  }
  return id;
}

async function dispatchJson<T>(
  ctx: PackageDraftToolContext,
  path: string,
  init: RequestInit = {},
  spaceId?: string,
): Promise<{ status: number; body: T | null }> {
  const headers = authHeaders(ctx, spaceId);
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
  const res = await ctx.dispatch(new Request(`${ctx.origin}${path}`, { ...init, headers }));
  const text = await res.text();
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

interface DraftSnapshot {
  packageId: string;
  type: PackageType;
  source: string;
  lockVersion: number | null;
  manifest: Record<string, unknown> | null;
  files: Record<string, Uint8Array>;
}

/** The draft (or a version) as the file explorer serves it, text or bytes. */
async function readSnapshot(
  ctx: PackageDraftToolContext,
  packageId: string,
  version: string | undefined,
  spaceId?: string,
): Promise<DraftSnapshot> {
  const encoded = encodePackageIdPath(packageId);
  const type = await locateType(ctx, packageId, spaceId);
  if (!type) throw new Error(`${packageId} is not a package of this organization.`);
  const detail = await dispatchJson<{ lock_version?: unknown; manifest?: unknown }>(
    ctx,
    detailPath(type, packageId),
    {},
    spaceId,
  );
  if (detail.status === 404) {
    throw new Error(
      `${packageId} is not installed in ${spaceId ? "that space" : "the default space"}; its files can only be read from a space it is installed in.`,
    );
  }
  if (detail.status >= 400) throw new Error(`Reading ${packageId} failed: HTTP ${detail.status}`);

  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const index = await dispatchJson<{ entries?: { path?: unknown; inline?: unknown }[] }>(
    ctx,
    `/api/packages/${encoded}/files${query}`,
    {},
    spaceId,
  );
  if (index.status >= 400) {
    throw new Error(
      version
        ? `${packageId} has no version ${version}.`
        : `Reading the files of ${packageId} failed: HTTP ${index.status}`,
    );
  }
  const files: Record<string, Uint8Array> = {};
  for (const entry of index.body?.entries ?? []) {
    if (typeof entry.path !== "string" || entry.path.length === 0) continue;
    if (typeof entry.inline === "string") {
      files[entry.path] = encoder.encode(entry.inline);
      continue;
    }
    const res = await ctx.dispatch(
      new Request(
        `${ctx.origin}/api/packages/${encoded}/files/content?path=${encodeURIComponent(entry.path)}${query ? `&${query.slice(1)}` : ""}`,
        { headers: authHeaders(ctx, spaceId) },
      ),
    );
    if (!res.ok)
      throw new Error(`Reading ${entry.path} of ${packageId} failed: HTTP ${res.status}`);
    files[entry.path] = new Uint8Array(await res.arrayBuffer());
  }
  const manifest =
    typeof detail.body?.manifest === "object" && detail.body.manifest !== null
      ? (detail.body.manifest as Record<string, unknown>)
      : null;
  return {
    packageId,
    type,
    source: version ?? "draft",
    lockVersion: typeof detail.body?.lock_version === "number" ? detail.body.lock_version : null,
    manifest,
    files,
  };
}

function isText(bytes: Uint8Array): boolean {
  for (const byte of bytes.subarray(0, 8000)) if (byte === 0) return false;
  return true;
}

/** Files as an agent can read them: text inline, binaries in base64. */
function presentFiles(files: Record<string, Uint8Array>): {
  files: Record<string, string>;
  binary_files: Record<string, string>;
} {
  const text: Record<string, string> = {};
  const binary: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (path === "RECORD") continue;
    if (isText(bytes)) text[path] = decoder.decode(bytes);
    else binary[path] = Buffer.from(bytes).toString("base64");
  }
  return { files: text, binary_files: binary };
}

/** The inverse of {@link presentFiles}: the agent's `files` + `binary_files` args. */
function collectFiles(args: Record<string, unknown>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const text = args.files;
  if (text !== undefined) {
    if (typeof text !== "object" || text === null || Array.isArray(text)) {
      throw new McpError(ErrorCode.InvalidParams, "files must be an object of path → text.");
    }
    for (const [path, content] of Object.entries(text as Record<string, unknown>)) {
      if (typeof content !== "string") {
        throw new McpError(ErrorCode.InvalidParams, `files["${path}"] must be a string.`);
      }
      out[path] = encoder.encode(content);
    }
  }
  const binary = args.binary_files;
  if (binary !== undefined) {
    if (typeof binary !== "object" || binary === null || Array.isArray(binary)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "binary_files must be an object of path → base64.",
      );
    }
    for (const [path, content] of Object.entries(binary as Record<string, unknown>)) {
      if (typeof content !== "string") {
        throw new McpError(ErrorCode.InvalidParams, `binary_files["${path}"] must be base64 text.`);
      }
      out[path] = new Uint8Array(Buffer.from(content, "base64"));
    }
  }
  for (const path of Object.keys(out)) {
    if (
      path.startsWith("/") ||
      path.split("/").some((segment) => segment === ".." || segment === "" || segment === ".")
    ) {
      throw new McpError(ErrorCode.InvalidParams, `Refusing path "${path}".`);
    }
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function compare(
  local: Record<string, Uint8Array>,
  remote: Record<string, Uint8Array>,
): { path: string; change: "modified" | "added" | "removed" }[] {
  const changes: { path: string; change: "modified" | "added" | "removed" }[] = [];
  const paths = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const path of paths) {
    if (IGNORED.has(path)) continue;
    const mine = local[path];
    const theirs = remote[path];
    if (mine && !theirs) changes.push({ path, change: "added" });
    else if (!mine && theirs) changes.push({ path, change: "removed" });
    else if (mine && theirs && !sameBytes(mine, theirs)) changes.push({ path, change: "modified" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function bumpPatch(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

/** The version a push should carry: the frontmatter's, else a patch over the latest published, else 1.0.0. */
async function nextVersion(
  ctx: PackageDraftToolContext,
  packageId: string,
  type: PackageType,
  spaceId?: string,
): Promise<string> {
  const latest = await dispatchJson<{ version?: unknown }>(
    ctx,
    `${detailPath(type, packageId)}/versions/latest`,
    {},
    spaceId,
  );
  return latest.status === 200 && typeof latest.body?.version === "string"
    ? bumpPatch(latest.body.version)
    : "1.0.0";
}

function frontmatterName(skillMd: string): string | undefined {
  const block = skillMd.match(/^---[^\S\n]*\n([\s\S]*?)\n---/)?.[1];
  return block?.match(/^name:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m)?.[1];
}

function frontmatterDescription(skillMd: string): string | undefined {
  const block = skillMd.match(/^---[^\S\n]*\n([\s\S]*?)\n---/)?.[1];
  return block?.match(/^description:[ \t]*["']?([^\n]+?)["']?[ \t]*$/m)?.[1];
}

function buildPullTool(ctx: PackageDraftToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "pull_package_files",
    description:
      "Read every file of a package — a skill (SKILL.md and annexes), an agent (manifest.json and " +
      "prompt.md), an integration or an MCP server — from its draft (default) or from a published " +
      "version. Returns text files inline, binaries as base64, the package type, and the draft's " +
      "lock_version to pass back to push_package_files so a later push is accepted without force. " +
      "This is how you take a package into your working context before editing it; never edit " +
      "synced copies on a machine.",
    annotations: {
      title: "Pull package files",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["package_id"],
      properties: {
        package_id: { type: "string", description: "The package, as @scope/name (any type)." },
        version: {
          type: "string",
          description: "A published version (semver or `latest`) instead of the draft.",
        },
        space: SPACE_ARG,
      },
    },
  };
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const packageId = requirePackageId(args.package_id);
    const version = asString(args.version);
    try {
      const spaceId = await resolveSpaceArg(ctx, args.space);
      const snapshot = await readSnapshot(ctx, packageId, version, spaceId);
      const presented = presentFiles(snapshot.files);
      if (!presented.files["manifest.json"] && snapshot.manifest && !version) {
        presented.files["manifest.json"] = `${JSON.stringify(snapshot.manifest, null, 2)}\n`;
      }
      return textResult({
        package_id: packageId,
        type: snapshot.type,
        ...(spaceId ? { space_id: spaceId } : {}),
        source: snapshot.source,
        lock_version: snapshot.lockVersion,
        ...presented,
        next: "Edit, then call push_package_files with every file and this lock_version.",
      });
    } catch (err) {
      if (err instanceof McpError) throw err;
      return textResult({ error: getErrorMessage(err) }, true);
    }
  };
  return { descriptor, handler };
}

function buildStatusTool(ctx: PackageDraftToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "package_status",
    description:
      "Compare a set of files you hold to a package's current draft (any type): which are modified, " +
      "added or removed, and whether the draft was edited elsewhere since the lock_version you " +
      "hold. Call it before push_package_files when you are not sure what changed.",
    annotations: {
      title: "Package status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["package_id", "files"],
      properties: {
        package_id: { type: "string", description: "The skill, as @scope/name." },
        files: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Every text file you hold, path → content (SKILL.md at least).",
        },
        binary_files: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Binary files you hold, path → base64.",
        },
        lock_version: {
          type: "integer",
          description: "The lock_version you received from pull_package_files or your last push.",
        },
        space: SPACE_ARG,
      },
    },
  };
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const packageId = requirePackageId(args.package_id);
    const local = collectFiles(args);
    try {
      const spaceId = await resolveSpaceArg(ctx, args.space);
      const snapshot = await readSnapshot(ctx, packageId, undefined, spaceId);
      const changes = compare(local, snapshot.files);
      const seen = typeof args.lock_version === "number" ? args.lock_version : undefined;
      const moved =
        seen !== undefined && snapshot.lockVersion !== null && seen !== snapshot.lockVersion;
      return textResult({
        package_id: packageId,
        type: snapshot.type,
        clean: changes.length === 0,
        changes,
        lock_version: snapshot.lockVersion,
        draft_edited_elsewhere: moved,
        ...(moved
          ? {
              warning: `The draft moved from lock_version ${seen} to ${snapshot.lockVersion}: someone edited it since you pulled. Pull again and merge before pushing, or push with force to replace their edit.`,
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof McpError) throw err;
      return textResult({ error: getErrorMessage(err) }, true);
    }
  };
  return { descriptor, handler };
}

function buildPushTool(ctx: PackageDraftToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "push_package_files",
    description:
      "Write a package's files to its DRAFT on Appstrate without publishing, the same way " +
      "`appstrate packages push` does — a skill (SKILL.md and annexes), an agent (manifest.json " +
      "and prompt.md), an integration or an MCP server. Send the COMPLETE set of files (what you " +
      "omit is removed from the draft) and the lock_version you got from pull_package_files: when " +
      "it still matches, the push is accepted; when the draft was edited elsewhere it is refused " +
      "with draft_overwrite unless force is true. A manifest.json is used as sent and decides the " +
      "type; without one, only a skill can be pushed, its manifest synthesized from the SKILL.md " +
      "frontmatter. Publish afterwards with the create<Type>Version operation (createSkillVersion, " +
      "createAgentVersion, …), or pass publish: true to cut a version right away.",
    annotations: {
      title: "Push package files",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["package_id", "files"],
      properties: {
        package_id: { type: "string", description: "The skill, as @scope/name." },
        files: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Every text file, path → content. manifest.json for any type but a skill; SKILL.md for a skill.",
        },
        binary_files: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Binary files, path → base64.",
        },
        lock_version: {
          type: "integer",
          description:
            "The draft's lock_version you last saw. Required to re-push without force once the draft exists.",
        },
        force: {
          type: "boolean",
          description: "Replace a draft that was edited elsewhere (409 draft_overwrite).",
        },
        version: {
          type: "string",
          description:
            "Manifest version to write when no manifest.json is sent. Default: a patch bump over the latest published version, else 1.0.0.",
        },
        publish: {
          type: "boolean",
          description:
            "Cut an immutable version from these files immediately instead of writing the draft.",
        },
        space: SPACE_ARG,
      },
    },
  };
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const accessError = writeAccessError(ctx);
    if (accessError) return textResult({ error: accessError }, true);
    const packageId = requirePackageId(args.package_id);
    const files = collectFiles(args);
    let type: PackageType = "skill";
    if (files["manifest.json"]) {
      try {
        const parsed = JSON.parse(decoder.decode(files["manifest.json"])) as { type?: unknown };
        if (isPackageType(parsed.type)) type = parsed.type;
      } catch {
        throw new McpError(ErrorCode.InvalidParams, "manifest.json is not valid JSON.");
      }
    } else if (!files["SKILL.md"]) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "files must include manifest.json (agent, integration, mcp-server) or SKILL.md (skill).",
      );
    }
    try {
      const spaceId = await resolveSpaceArg(ctx, args.space);
      if (!files["manifest.json"]) {
        const skillMd = decoder.decode(files["SKILL.md"]!);
        const name = parseScopedName(packageId)!.name;
        const manifest: Record<string, unknown> = {
          name: packageId,
          version: asString(args.version) ?? (await nextVersion(ctx, packageId, "skill", spaceId)),
          type: "skill",
          schema_version: "0.1",
          display_name: frontmatterName(skillMd) ?? name,
        };
        const description = frontmatterDescription(skillMd);
        if (description) manifest.description = description;
        files["manifest.json"] = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
      }
      const archive = zipArtifact(files);
      const form = new FormData();
      form.append(
        "file",
        new File([archive], `${parseScopedName(packageId)!.name}.afps`, {
          type: "application/zip",
        }),
      );
      const params = new URLSearchParams();
      if (args.publish !== true) params.set("draft", "true");
      if (args.force === true) params.set("force", "true");
      if (typeof args.lock_version === "number")
        params.set("lock_version", String(args.lock_version));
      const headers = authHeaders(ctx, spaceId);
      const res = await ctx.dispatch(
        new Request(`${ctx.origin}/api/packages/import?${params.toString()}`, {
          method: "POST",
          headers,
          body: form,
        }),
      );
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = { raw: text };
      }
      if (!res.ok) {
        const hint =
          body.code === "draft_overwrite"
            ? "The draft was edited elsewhere since your lock_version. Pull again and merge, or retry with force: true to replace it."
            : undefined;
        return textResult({ status: res.status, ...body, ...(hint ? { hint } : {}) }, true);
      }
      const publishOp = `create${type === "mcp-server" ? "McpServer" : type[0]!.toUpperCase() + type.slice(1)}Version`;
      return textResult({
        status: res.status,
        ...body,
        ...(spaceId ? { space_id: spaceId } : {}),
        next:
          args.publish === true
            ? "Published. Every machine syncing published skills picks it up on its next sync."
            : `Draft written. Keep this lock_version for your next push. Publish with the ${publishOp} operation when it is ready.`,
      });
    } catch (err) {
      if (err instanceof McpError) throw err;
      return textResult({ error: getErrorMessage(err) }, true);
    }
  };
  return { descriptor, handler };
}

export function buildPackageDraftTools(ctx: PackageDraftToolContext): AppstrateToolDefinition[] {
  return [
    buildPullTool(ctx),
    buildStatusTool(ctx),
    ...(canWritePackageDrafts(ctx) ? [buildPushTool(ctx)] : []),
  ];
}
