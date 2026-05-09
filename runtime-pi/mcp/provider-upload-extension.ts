// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Pi extension that registers the LLM-facing `provider_upload` tool.
 *
 * Why a Pi extension and NOT a sidecar MCP tool:
 *   - The orchestration is purely client-side state (chunk index,
 *     session URL, ETag list). Putting it on the sidecar would
 *     require giving the sidecar workspace access — a hard line per
 *     ISSUE-283 §"Why not chunking inside the sidecar".
 *   - Each chunk transits through the existing `provider_call` MCP
 *     tool, so credential isolation, `authorizedUris` gating, and
 *     `_meta` header propagation reuse already-shipped code paths.
 *
 * Tool gating:
 *   - The tool is only registered when ≥1 provider in the bundle's
 *     manifest declares an `uploadProtocols` capability list.
 *   - The `providerId` enum and the `uploadProtocol` enum are
 *     constrained to the union of capabilities found in the bundle,
 *     so the LLM can only call combinations that have been vetted.
 *   - When the bundle declares no upload-capable provider, this
 *     factory returns `[]` — `provider_upload` does not appear in
 *     `tools/list` at all, which is the SOTA "don't advertise tools
 *     the agent can't actually use" pattern.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { ProviderRef } from "@appstrate/afps-runtime/resolvers";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { McpProviderUploadResolver } from "./provider-upload-resolver.ts";
import { UPLOAD_PROTOCOLS, type UploadProtocol } from "./upload-adapters/index.ts";

const PROVIDER_UPLOAD_TOOL_NAME = "provider_upload";

export type ProviderUploadEventEmitter = (event: { type: string; [k: string]: unknown }) => void;

/**
 * Read `definition.uploadProtocols` from each provider package in
 * the bundle. Filters out unknown protocol identifiers — the LLM
 * must never see a protocol value the resolver can't dispatch.
 *
 * Returns a Map<providerId, validProtocols[]>. Providers without an
 * `uploadProtocols` field are NOT included.
 */
export function readProviderUploadCapabilities(
  bundle: Bundle,
  refs: ReadonlyArray<ProviderRef>,
): Map<string, UploadProtocol[]> {
  const known = new Set<string>(UPLOAD_PROTOCOLS);
  const out = new Map<string, UploadProtocol[]>();
  for (const ref of refs) {
    const pkg = findProviderPackage(bundle, ref);
    if (!pkg) continue;
    const manifest = readProviderManifest(pkg);
    const def = (manifest as { definition?: { uploadProtocols?: unknown } } | undefined)
      ?.definition;
    const declared = def?.uploadProtocols;
    if (!Array.isArray(declared)) continue;
    const valid = declared.filter(
      (p): p is UploadProtocol => typeof p === "string" && known.has(p),
    );
    if (valid.length === 0) continue;
    out.set(ref.name, valid);
  }
  return out;
}

interface ProviderPackage {
  manifest: unknown;
  files: ReadonlyMap<string, Uint8Array>;
}

function findProviderPackage(bundle: Bundle, ref: ProviderRef): ProviderPackage | undefined {
  for (const pkg of bundle.packages.values()) {
    const m = pkg.manifest as { name?: string };
    if (m.name === ref.name) {
      return { manifest: pkg.manifest, files: pkg.files };
    }
  }
  return undefined;
}

/**
 * Read provider manifest in the same precedence order as
 * `readProviderMeta` (provider.json → manifest.json → in-memory
 * manifest). The `uploadProtocols` field lives under
 * `definition.uploadProtocols`.
 */
function readProviderManifest(pkg: ProviderPackage): unknown {
  for (const candidate of ["provider.json", "manifest.json"] as const) {
    const bytes = pkg.files.get(candidate);
    if (!bytes) continue;
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // Fall through — manifest.json was malformed, try the in-memory copy.
    }
  }
  return pkg.manifest;
}

export interface BuildProviderUploadFactoryOptions {
  bundle: Bundle;
  providerRefs: ReadonlyArray<ProviderRef>;
  mcp: AppstrateMcpClient;
  runId: string;
  workspace: string;
  emit: ProviderUploadEventEmitter;
}

/**
 * Build the `provider_upload` Pi extension factory list.
 *
 * Returns `[]` when the bundle has no provider declaring
 * `uploadProtocols` — the tool is gated off entirely so the LLM
 * doesn't see an unusable capability.
 */
export function buildProviderUploadExtensionFactory(
  opts: BuildProviderUploadFactoryOptions,
): ExtensionFactory[] {
  const capabilities = readProviderUploadCapabilities(opts.bundle, opts.providerRefs);
  if (capabilities.size === 0) return [];
  return [makeExtension(capabilities, opts)];
}

function makeExtension(
  capabilities: ReadonlyMap<string, UploadProtocol[]>,
  opts: BuildProviderUploadFactoryOptions,
): ExtensionFactory {
  // Union of all protocols across the bundle's upload-capable
  // providers. Pinned for the tool's input schema enum.
  const allProtocols = new Set<UploadProtocol>();
  for (const protocols of capabilities.values()) {
    for (const p of protocols) allProtocols.add(p);
  }
  const providerIds = [...capabilities.keys()];
  const protocolEnum = [...allProtocols];

  return (pi: ExtensionAPI) => {
    const resolver = new McpProviderUploadResolver(opts.mcp);
    pi.registerTool({
      name: PROVIDER_UPLOAD_TOOL_NAME,
      label: PROVIDER_UPLOAD_TOOL_NAME,
      description:
        "Upload a workspace file (>5 MB friendly) to a provider over a chunked resumable " +
        "protocol. Bytes flow through the credential-injecting proxy per chunk; the " +
        "agent never holds credentials. Returns the upstream's final response (file ID, " +
        "ETag, etc.) plus a SHA-256 of the bytes uploaded so post-upload verification is " +
        "possible. Pick the protocol the provider's API uses: " +
        "`google-resumable` (Drive, Cloud Storage, YouTube, Photos), " +
        "`s3-multipart` (S3 / R2 / MinIO / Backblaze B2), " +
        "`tus` (Cloudflare Stream, Vimeo, tusd), " +
        "`ms-resumable` (OneDrive, SharePoint, Graph).",
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        additionalProperties: false,
        required: ["providerId", "target", "fromFile", "uploadProtocol"],
        properties: {
          providerId: {
            type: "string",
            enum: providerIds,
            description: "Provider declared in the bundle with an `uploadProtocols` capability.",
          },
          target: {
            type: "string",
            format: "uri",
            description:
              "Initial upload endpoint (Drive: `…?uploadType=resumable`; S3: object URL; tus: tus endpoint; MS: `…:/createUploadSession`).",
          },
          fromFile: {
            type: "string",
            description: "Workspace-relative path to the file to upload.",
          },
          uploadProtocol: {
            type: "string",
            enum: protocolEnum,
            description:
              "Wire protocol the upstream API speaks. The provider's manifest gates which protocols are legal here.",
          },
          metadata: {
            type: "object",
            additionalProperties: true,
            description:
              "Per-protocol metadata. Drive: file metadata JSON (`{ name, parents, mimeType }`). " +
              "S3: header overrides (`Content-Type`, `x-amz-meta-*`). " +
              "tus: free-form key/value (encoded as `Upload-Metadata`). " +
              "MS Graph: `{ item: { ... } }` envelope.",
          },
          partSizeBytes: {
            type: "integer",
            minimum: 1,
            description:
              "Chunk size in bytes. Defaults are protocol-tuned (Google: 8 MiB; S3: 5 MiB; tus: 4 MiB; MS: 5 MiB). " +
              "Constraints: Google 256-KiB aligned; S3 ≥5 MiB except the last; MS ≤60 MiB and 320-KiB aligned.",
          },
        },
      }),
      async execute(toolCallId, params, signal) {
        const args = (params ?? {}) as {
          providerId?: string;
          target?: string;
          fromFile?: string;
          uploadProtocol?: string;
          metadata?: Record<string, unknown>;
          partSizeBytes?: number;
        };

        // Defence-in-depth: validate provider/protocol combination
        // server-side, since the LLM-facing schema's `enum` can be
        // dropped by older clients that don't enforce schemas.
        const providerId = args.providerId;
        const protocol = args.uploadProtocol;
        if (!providerId || !protocol || !args.target || !args.fromFile) {
          return {
            content: [
              {
                type: "text",
                text: `provider_upload: missing one of providerId/target/fromFile/uploadProtocol`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        const allowed = capabilities.get(providerId);
        if (!allowed) {
          return {
            content: [
              {
                type: "text",
                text:
                  `provider_upload: provider '${providerId}' has no upload capability. ` +
                  `Upload-capable providers: ${providerIds.join(", ") || "(none)"}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        if (!allowed.includes(protocol as UploadProtocol)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `provider_upload: protocol '${protocol}' not declared by '${providerId}'. ` +
                  `Allowed for this provider: ${allowed.join(", ")}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }

        const startedAt = Date.now();
        opts.emit({
          type: "provider_upload.called",
          runId: opts.runId,
          providerId,
          protocol,
          toolCallId,
          timestamp: startedAt,
        });

        const result = await resolver.executeUpload(
          {
            providerId,
            target: args.target,
            fromFile: args.fromFile,
            uploadProtocol: protocol as UploadProtocol,
            metadata: args.metadata,
            ...(args.partSizeBytes !== undefined ? { partSizeBytes: args.partSizeBytes } : {}),
          },
          {
            workspace: opts.workspace,
            toolCallId,
            signal: signal ?? new AbortController().signal,
          },
        );

        opts.emit({
          type: result.ok ? "provider_upload.completed" : "provider_upload.failed",
          runId: opts.runId,
          providerId,
          protocol,
          toolCallId,
          durationMs: Date.now() - startedAt,
          ...(result.ok
            ? { size: result.size, chunks: result.chunks, sha256: result.sha256 }
            : { status: result.status, bytesSent: result.bytesSent }),
          timestamp: Date.now(),
        });

        // Return a single text block with the structured result as
        // JSON so the LLM gets a uniform shape regardless of
        // protocol — easier to reason about than a per-protocol
        // payload.
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: undefined,
          isError: !result.ok,
        };
      },
    });
  };
}
