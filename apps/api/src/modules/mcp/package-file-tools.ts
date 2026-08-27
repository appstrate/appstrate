// SPDX-License-Identifier: Apache-2.0

/** File-backed package validation/import and MCP runtime discovery tools. */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { parseFileUri, fileUri } from "@appstrate/core/file-uri";
import { getErrorMessage } from "@appstrate/core/errors";
import { MCP_SERVER_RUNTIME_CAPABILITIES, MCP_SERVER_RUNTIMES } from "@appstrate/core/mcp-server";
import { PACKAGE_ZIP_MAX_COMPRESSED_BYTES } from "@appstrate/core/zip";
import type { Actor } from "@appstrate/connect";
import type { SpaceScope } from "../../lib/scope.ts";
import { getFileForActor, streamFileContent } from "../../services/files.ts";
import {
  bundleImportAuditRecords,
  handleImportBundle,
  preflightBundleImport,
} from "../../services/bundle-import.ts";
import { recordAudit } from "../../services/audit.ts";
import { asString, textResult } from "./tool-results.ts";

interface PackageFileToolContext {
  permissions: ReadonlySet<string>;
  actor: Actor;
  scope: SpaceScope;
}

interface PackageFileBytes {
  bytes: Uint8Array;
  fileId: string;
  name: string;
  mime: string;
}

type PackageFileImportContext = Pick<PackageFileToolContext, "permissions" | "actor">;

function packageFileImportAccessError(ctx: PackageFileImportContext): string | undefined {
  if (!ctx.permissions.has("mcp:invoke") || !ctx.permissions.has("agents:write")) {
    return "Permissions 'mcp:invoke' and 'agents:write' are required to import packages.";
  }
  if (ctx.actor.type !== "user") return "Only organization users can import packages.";
  return undefined;
}

/** Keep tool disclosure and server guidance on the same import eligibility rule. */
export function canImportPackageFiles(ctx: PackageFileImportContext): boolean {
  return packageFileImportAccessError(ctx) === undefined;
}

function packageSizeError(): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    `File exceeds the package import limit of ${PACKAGE_ZIP_MAX_COMPRESSED_BYTES} bytes.`,
  );
}

/** Materialize a web stream without ever allocating beyond the package cap. */
async function readPackageStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > PACKAGE_ZIP_MAX_COMPRESSED_BYTES) {
        await reader.cancel().catch(() => {});
        throw packageSizeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read downloadable file bytes through the canonical file ACL. */
async function readPackageFileBytes(
  ctx: PackageFileToolContext,
  uri: string,
): Promise<PackageFileBytes> {
  const fileId = parseFileUri(uri);
  if (!fileId) throw new McpError(ErrorCode.InvalidParams, `Not a file URI: ${uri}`);
  const resolved = await getFileForActor(ctx.scope, ctx.actor, fileId, ctx.permissions);
  if (!resolved) throw new McpError(ErrorCode.InvalidParams, `File not found: ${uri}`);
  if (!resolved.capabilities.download) {
    throw new McpError(ErrorCode.InvalidParams, `File is not downloadable: ${uri}`);
  }
  if (resolved.row.size > PACKAGE_ZIP_MAX_COMPRESSED_BYTES) throw packageSizeError();
  const stream = await streamFileContent(resolved.row.storageKey);
  if (!stream) {
    throw new McpError(ErrorCode.InvalidParams, `File content is missing: ${uri}`);
  }
  return {
    bytes: await readPackageStream(stream),
    fileId,
    name: resolved.row.name,
    mime: resolved.row.mime,
  };
}

function packageFileInputSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    additionalProperties: false,
    required: ["file_uri"],
    properties: {
      file_uri: {
        type: "string",
        description: "Downloadable appfile:// URI containing .afps, .zip, or .afps-bundle bytes.",
      },
    },
  };
}

function buildValidatePackageFileTool(ctx: PackageFileToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "validate_package_file",
    description:
      "Validate a file-backed .afps/.zip/.afps-bundle using the exact import preflight. " +
      "Performs no mutation. Returns package identities, root, integrity and conflicts.",
    annotations: {
      title: "Validate package file",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: packageFileInputSchema(),
  };
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const uri = asString(args.file_uri);
    if (!uri) throw new McpError(ErrorCode.InvalidParams, "file_uri is required.");
    try {
      const file = await readPackageFileBytes(ctx, uri);
      const { bundle, conflicts } = await preflightBundleImport(file.bytes, ctx.scope);
      return textResult({
        valid: true,
        importable: conflicts.length === 0,
        file: {
          id: file.fileId,
          uri: fileUri(file.fileId),
          name: file.name,
          mime: file.mime,
          size: file.bytes.byteLength,
        },
        root: bundle.root,
        integrity: bundle.integrity,
        packages: [...bundle.packages].map(([identity, pkg]) => ({
          identity,
          type: pkg.manifest.type ?? null,
          integrity: pkg.integrity,
        })),
        conflicts: conflicts.map(({ identity, reason }) => ({ identity, reason })),
      });
    } catch (err) {
      if (err instanceof McpError) throw err;
      return textResult({ valid: false, importable: false, error: getErrorMessage(err) }, true);
    }
  };
  return { descriptor, handler };
}

function buildImportPackageFileTool(ctx: PackageFileToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "import_package_file",
    description:
      "Import and install a package or bundle directly from an appfile:// URI. Bytes stay " +
      "server-side and pass through the exact same preflight, conflict, version and install " +
      "contracts as multipart bundle import. Call validate_package_file first and continue " +
      "only when it returns valid:true and importable:true.",
    annotations: {
      title: "Import package file",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: packageFileInputSchema(),
  };
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const accessError = packageFileImportAccessError(ctx);
    if (accessError) return textResult({ error: accessError }, true);
    const uri = asString(args.file_uri);
    if (!uri) throw new McpError(ErrorCode.InvalidParams, "file_uri is required.");
    try {
      const file = await readPackageFileBytes(ctx, uri);
      const result = await handleImportBundle(file.bytes, ctx.scope, ctx.actor.id);
      for (const audit of bundleImportAuditRecords(result, {
        via: "import:file",
        fileId: file.fileId,
      })) {
        await recordAudit({
          orgId: ctx.scope.orgId,
          spaceId: ctx.scope.spaceId,
          actorType: "user",
          actorId: ctx.actor.id,
          action: "package.version_created",
          resourceType: "package",
          resourceId: audit.resourceId,
          after: audit.after,
        });
      }
      return textResult({ ...result, file_uri: fileUri(file.fileId) });
    } catch (err) {
      if (err instanceof McpError) throw err;
      return textResult({ error: getErrorMessage(err) }, true);
    }
  };
  return { descriptor, handler };
}

function runtimeManifestTemplate(runtime: (typeof MCP_SERVER_RUNTIMES)[number]) {
  const capability = MCP_SERVER_RUNTIME_CAPABILITIES[runtime];
  const entryPoint = "<archive-relative-entry-point>";
  const command = capability.manifestCommand ?? entryPoint;
  const args = capability.manifestCommand
    ? [...capability.manifestArgsBeforeEntryPoint, entryPoint]
    : [];
  return {
    manifest_version: capability.manifestVersion,
    schema_version: "0.1",
    type: "mcp-server",
    name: "@<organization-scope>/<package-name>",
    version: "1.0.0",
    display_name: "<human-readable-name>",
    server: {
      type: capability.manifestServerType,
      entry_point: entryPoint,
      mcp_config: { command, args },
    },
    ...(runtime === "bun"
      ? {
          _meta: {
            "dev.appstrate/mcp-server": {
              runtime: MCP_SERVER_RUNTIME_CAPABILITIES.bun.runtimeOverride,
            },
          },
        }
      : {}),
  };
}

function buildRuntimeCapabilitiesTool(): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "get_runtime_capabilities",
    description:
      "Return the executable MCP-server runtimes this Appstrate build supports and an exact " +
      "minimal manifest template for each. Call this before authoring a local MCP package.",
    annotations: {
      title: "Get MCP runtime capabilities",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  };
  const handler = async (): Promise<CallToolResult> =>
    textResult({
      archive_required: true,
      package_archive_max_bytes: PACKAGE_ZIP_MAX_COMPRESSED_BYTES,
      schema_version: "0.1",
      entry_point_must_exist: true,
      required_archive_files: ["manifest.json", "<server.entry_point>"],
      runtimes: MCP_SERVER_RUNTIMES.map((runtime) => ({
        runtime,
        manifest_version: MCP_SERVER_RUNTIME_CAPABILITIES[runtime].manifestVersion,
        server_type: MCP_SERVER_RUNTIME_CAPABILITIES[runtime].manifestServerType,
        entry_point: MCP_SERVER_RUNTIME_CAPABILITIES[runtime].entryPoint,
        manifest_template: runtimeManifestTemplate(runtime),
      })),
    });
  return { descriptor, handler };
}

export function buildPackageFileTools(ctx: PackageFileToolContext): AppstrateToolDefinition[] {
  return [
    buildValidatePackageFileTool(ctx),
    ...(canImportPackageFiles(ctx) ? [buildImportPackageFileTool(ctx)] : []),
    buildRuntimeCapabilitiesTool(),
  ];
}
