// SPDX-License-Identifier: Apache-2.0

/** Document-backed package validation/import and MCP runtime discovery tools. */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { parseDocumentUri, documentUri } from "@appstrate/core/document-uri";
import { getErrorMessage } from "@appstrate/core/errors";
import { MCP_SERVER_RUNTIME_CAPABILITIES, MCP_SERVER_RUNTIMES } from "@appstrate/core/mcp-server";
import { PACKAGE_ZIP_MAX_COMPRESSED_BYTES } from "@appstrate/core/zip";
import type { Actor } from "@appstrate/connect";
import type { AppScope } from "../../lib/scope.ts";
import { getDocumentForActor, streamDocumentContent } from "../../services/documents.ts";
import {
  bundleImportAuditRecords,
  handleImportBundle,
  preflightBundleImport,
} from "../../services/bundle-import.ts";
import { recordAudit } from "../../services/audit.ts";
import { asString, textResult } from "./tool-results.ts";

interface PackageDocumentToolContext {
  permissions: ReadonlySet<string>;
  actor: Actor;
  scope: AppScope;
}

interface PackageDocumentBytes {
  bytes: Uint8Array;
  documentId: string;
  name: string;
  mime: string;
}

type PackageDocumentImportContext = Pick<PackageDocumentToolContext, "permissions" | "actor">;

function packageDocumentImportAccessError(ctx: PackageDocumentImportContext): string | undefined {
  if (!ctx.permissions.has("mcp:invoke") || !ctx.permissions.has("agents:write")) {
    return "Permissions 'mcp:invoke' and 'agents:write' are required to import packages.";
  }
  if (ctx.actor.type !== "user") return "Only organization users can import packages.";
  return undefined;
}

/** Keep tool disclosure and server guidance on the same import eligibility rule. */
export function canImportPackageDocuments(ctx: PackageDocumentImportContext): boolean {
  return packageDocumentImportAccessError(ctx) === undefined;
}

function packageSizeError(): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    `Document exceeds the package import limit of ${PACKAGE_ZIP_MAX_COMPRESSED_BYTES} bytes.`,
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

/** Read downloadable document bytes through the canonical document ACL. */
async function readPackageDocumentBytes(
  ctx: PackageDocumentToolContext,
  uri: string,
): Promise<PackageDocumentBytes> {
  const documentId = parseDocumentUri(uri);
  if (!documentId) throw new McpError(ErrorCode.InvalidParams, `Not a document URI: ${uri}`);
  const resolved = await getDocumentForActor(ctx.scope, ctx.actor, documentId, ctx.permissions);
  if (!resolved) throw new McpError(ErrorCode.InvalidParams, `Document not found: ${uri}`);
  if (!resolved.capabilities.download) {
    throw new McpError(ErrorCode.InvalidParams, `Document is not downloadable: ${uri}`);
  }
  if (resolved.row.size > PACKAGE_ZIP_MAX_COMPRESSED_BYTES) throw packageSizeError();
  const stream = await streamDocumentContent(resolved.row.storageKey);
  if (!stream) {
    throw new McpError(ErrorCode.InvalidParams, `Document content is missing: ${uri}`);
  }
  return {
    bytes: await readPackageStream(stream),
    documentId,
    name: resolved.row.name,
    mime: resolved.row.mime,
  };
}

function packageDocumentInputSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    additionalProperties: false,
    required: ["document_uri"],
    properties: {
      document_uri: {
        type: "string",
        description: "Downloadable document:// URI containing .afps, .zip, or .afps-bundle bytes.",
      },
    },
  };
}

function buildValidatePackageDocumentTool(
  ctx: PackageDocumentToolContext,
): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "validate_package_document",
    description:
      "Validate a document-backed .afps/.zip/.afps-bundle using the exact import preflight. " +
      "Performs no mutation. Returns package identities, root, integrity and conflicts.",
    annotations: {
      title: "Validate package document",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: packageDocumentInputSchema(),
  };
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const uri = asString(args.document_uri);
    if (!uri) throw new McpError(ErrorCode.InvalidParams, "document_uri is required.");
    try {
      const document = await readPackageDocumentBytes(ctx, uri);
      const { bundle, conflicts } = await preflightBundleImport(document.bytes, ctx.scope);
      return textResult({
        valid: true,
        importable: conflicts.length === 0,
        document: {
          id: document.documentId,
          uri: documentUri(document.documentId),
          name: document.name,
          mime: document.mime,
          size: document.bytes.byteLength,
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

function buildImportPackageDocumentTool(ctx: PackageDocumentToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "import_package_document",
    description:
      "Import and install a package or bundle directly from a document:// URI. Bytes stay " +
      "server-side and pass through the exact same preflight, conflict, version and install " +
      "contracts as multipart bundle import. Call validate_package_document first and continue " +
      "only when it returns valid:true and importable:true.",
    annotations: {
      title: "Import package document",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: packageDocumentInputSchema(),
  };
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const accessError = packageDocumentImportAccessError(ctx);
    if (accessError) return textResult({ error: accessError }, true);
    const uri = asString(args.document_uri);
    if (!uri) throw new McpError(ErrorCode.InvalidParams, "document_uri is required.");
    try {
      const document = await readPackageDocumentBytes(ctx, uri);
      const result = await handleImportBundle(document.bytes, ctx.scope, ctx.actor.id);
      for (const audit of bundleImportAuditRecords(result, {
        via: "import:document",
        documentId: document.documentId,
      })) {
        await recordAudit({
          orgId: ctx.scope.orgId,
          applicationId: ctx.scope.applicationId,
          actorType: "user",
          actorId: ctx.actor.id,
          action: "package.version_created",
          resourceType: "package",
          resourceId: audit.resourceId,
          after: audit.after,
        });
      }
      return textResult({ ...result, document_uri: documentUri(document.documentId) });
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

export function buildPackageDocumentTools(
  ctx: PackageDocumentToolContext,
): AppstrateToolDefinition[] {
  return [
    buildValidatePackageDocumentTool(ctx),
    ...(canImportPackageDocuments(ctx) ? [buildImportPackageDocumentTool(ctx)] : []),
    buildRuntimeCapabilitiesTool(),
  ];
}
