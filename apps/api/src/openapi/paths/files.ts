// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

// Shared File object schema (mirrors FileDto in services/files.ts).
// Field casing follows CASING_CONVENTIONS.md carve-out 4b: `applicationId`,
// `packageId`, `createdAt`, `expiresAt` are on the universal DB-convention list
// (camelCase everywhere); `run_id` / `chat_session_id` are NOT on it, so they
// stay snake_case domain fields (matching the `notification` DTO's `run_id`).
const fileSchema = {
  type: "object",
  required: [
    "object",
    "id",
    "uri",
    "purpose",
    "applicationId",
    "run_id",
    "chat_session_id",
    "packageId",
    "name",
    "mime",
    "size",
    "downloadable",
    "capabilities",
    "previewable",
    "preview_kind",
    "expiresAt",
    "createdAt",
  ],
  properties: {
    object: { type: "string", enum: ["file"] },
    id: { type: "string", description: "Opaque file id (`doc_…`)." },
    uri: {
      type: "string",
      description: "Stable `appfile://doc_…` reference — pass in a run's file input field.",
    },
    purpose: { type: "string", enum: ["user_upload", "agent_output"] },
    applicationId: { type: "string" },
    run_id: { type: ["string", "null"], description: "Run container, or null." },
    chat_session_id: { type: ["string", "null"], description: "Chat-session container, or null." },
    packageId: { type: ["string", "null"], description: "Producing agent package id, or null." },
    name: {
      type: "string",
      description:
        'Display name. Degrades to the generic `"file"` when the caller lacks the `metadata` ' +
        "capability (a non-creator run reader of a `user_upload`) — the real filename is withheld.",
    },
    mime: {
      type: "string",
      description:
        "MIME type. Degrades to `application/octet-stream` when the caller lacks the `metadata` " +
        "capability.",
    },
    size: { type: "integer", description: "Size in bytes." },
    sha256: {
      type: "string",
      description:
        "SHA-256 of the bytes (hex). OMITTED (absent) when the caller lacks the `metadata` " +
        "capability, so a private upload's content hash is never disclosed to a non-creator.",
    },
    downloadable: {
      type: "boolean",
      description:
        "Whether `/content` will serve the bytes to the current caller: an agent output is " +
        "downloadable by anyone who can read the container; a user upload only by its creator. " +
        "Flat mirror of `capabilities.download`.",
    },
    capabilities: {
      type: "object",
      description:
        "The caller's full access-capability set for this file — the single source the UI " +
        "drives its download/preview/keep/delete affordances from.",
      required: ["visible", "metadata", "download", "preview", "keep", "delete"],
      properties: {
        visible: {
          type: "boolean",
          description: "The caller can resolve this file at all (container ACL).",
        },
        metadata: {
          type: "boolean",
          description:
            "The caller may see the real name, mime and sha256. When false the row serves an " +
            "opaque reference (generic name + mime, no sha256).",
        },
        download: { type: "boolean", description: "The caller may fetch the bytes (`/content`)." },
        preview: {
          type: "boolean",
          description:
            "The caller may render an in-browser preview (download + a previewable mime).",
        },
        keep: { type: "boolean", description: "The caller may pin/clear the retention deadline." },
        delete: { type: "boolean", description: "The caller may delete the file." },
      },
    },
    previewable: {
      type: "boolean",
      description:
        "Whether the caller can open an in-browser preview of this file (a readable file " +
        "of a previewable kind — see `preview_kind`). Present on every row; the signed " +
        "`preview_url` is minted only on the single-file GET (below).",
    },
    preview_kind: {
      type: ["string", "null"],
      enum: ["html", "image", "pdf", "text", null],
      description:
        "How this file previews, or null when not previewable: `html` (sandboxed iframe, " +
        "active content), `image` (inline `<img>`), `pdf` (native-viewer iframe), `text` " +
        "(plaintext). Present on every row.",
    },
    expiresAt: {
      type: ["string", "null"],
      format: "date-time",
      description: "Retention deadline, or null when permanent.",
    },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

/**
 * The file as served by the SINGLE-file GET — the only handler that
 * passes `mintPreview`, and therefore the only response that can carry a
 * `preview_url`. List rows and the `keep` response use `fileSchema` above
 * (no `preview_url` property at all), matching `toFileDto` exactly.
 */
const fileWithPreviewSchema = {
  type: "object",
  required: fileSchema.required,
  properties: {
    ...fileSchema.properties,
    preview_url: {
      type: ["string", "null"],
      format: "uri",
      description:
        "Absolute URL of a hardened, cookie-less preview (short-lived signed token in the " +
        "query). Minted ONLY on this single-file GET — the list rows and the `keep` " +
        "response carry `previewable` instead. Non-null only for a previewable file. " +
        'Load in a `sandbox="allow-scripts"` iframe: for an `html` file that iframe is ' +
        "the ONLY context in which the markup is served as active HTML, whether or not the " +
        "instance configures a separate `USERCONTENT_URL` preview origin. Any other loading " +
        "context — a top-level navigation to the same URL above all — is served as inert " +
        "`text/plain` source, because a top-level agent document can navigate itself and so " +
        "cannot be contained. Minted on the `USERCONTENT_URL` origin when the instance " +
        "configures a separate preview domain, else same-origin.",
    },
  },
} as const;

/**
 * Errors every `/api/files` operation can answer with before its handler
 * ever runs — all three come from the shared pipeline, not from the handler,
 * and were previously undocumented:
 *
 *  - `400` — `requireAppContext()` with no resolvable `X-Application-Id`.
 *  - `403` — the RBAC guard without `files:read`, or `requireAppContext()`
 *    when the header contradicts the application the credential is pinned to.
 *  - `404` — `requireAppContext()` when the application id is not in the
 *    caller's organization (same status the handlers use for an unreadable
 *    file, deliberately indistinguishable).
 */
const pipelineResponses = {
  "400": { $ref: "#/components/responses/ValidationError" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
} as const;

const canonicalFilesPaths = {
  "/api/files": {
    get: {
      operationId: "listFiles",
      tags: ["Files"],
      summary: "List files",
      description:
        "List the files visible to the caller in the current application. Requires the " +
        "`files:read` permission (the family gate — mirrors `runs:read`); on top of it, " +
        "each row is filtered by its own container ACL, so members see their own files " +
        "(and system-owned ones) and end-users see only their own. Filter by `purpose`, " +
        "`run_id`, `packageId`, `chat_session_id`, or a chat session's complete context; " +
        "paginate with `startingAfter` + `limit`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "purpose",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["user_upload", "agent_output"] },
          description: "Filter by file purpose.",
        },
        {
          name: "run_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter to files anchored to this run.",
        },
        {
          name: "packageId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter to files produced by this agent package.",
        },
        {
          name: "chat_session_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter to files anchored to this chat session.",
        },
        {
          name: "context_chat_session_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Filter to the private conversation context: direct attachments plus files produced or consumed by runs launched from the session.",
        },
        {
          name: "startingAfter",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Keyset cursor — file id to page after (newest-first order).",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          description: "Page size (1–100, default 20).",
        },
      ],
      responses: {
        "200": {
          description: "A page of files.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: fileSchema },
                  hasMore: { type: "boolean" },
                  limit: { type: "integer" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/files/{id}": {
    get: {
      operationId: "getFile",
      tags: ["Files"],
      summary: "Get file metadata",
      description:
        "Fetch a file's metadata, including the derived `downloadable` flag and — for a " +
        "previewable file — a freshly minted `preview_url`. Requires the `files:read` " +
        "permission; on top of it access is inherited from the file's container, so an id " +
        "the caller cannot read returns 404.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "The file.",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: fileWithPreviewSchema } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
    delete: {
      operationId: "deleteFile",
      tags: ["Files"],
      summary: "Delete a file",
      description:
        "Delete a file (storage object + row) and release its quota. Allowed for a caller " +
        "with the `files:delete` permission (owner/admin) or the file's own creator. " +
        "A file referenced by a run cannot be deleted until those consumer runs are removed.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Deleted.",
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "409": {
          description: "File is still referenced by one or more consumer runs.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Conflict",
                status: 409,
                detail: "This file is referenced by one or more runs and cannot be deleted",
                code: "file_in_use",
                requestId: "req_abc123",
              },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/files/{id}/keep": {
    post: {
      operationId: "keepFile",
      tags: ["Files"],
      summary: "Keep a file (clear its expiry)",
      description:
        "Pin a file so it is never swept by the retention GC: clears its `expires_at` " +
        "(sets it to null / permanent). Allowed for a caller with the `files:delete` " +
        "permission (owner/admin) or the file's own creator. Idempotent — keeping an " +
        "already-permanent file is a no-op that returns 200 with the unchanged file. " +
        "An id the caller cannot read returns 404.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description:
            "The file, with `expiresAt` now null. No `preview_url` is minted on this " +
            "response — re-read `GET /api/files/{id}` for a fresh one.",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: fileSchema } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/files/{id}/content": {
    get: {
      operationId: "getFileContent",
      tags: ["Files"],
      summary: "Download file content",
      description:
        "Download the file bytes with `Content-Disposition: attachment`. Requires the " +
        "`files:read` permission. When object storage supports it (S3 with a public " +
        "endpoint), responds `307` with a short-lived presigned `Location`; otherwise " +
        "proxy-streams the bytes (`200`). Also gated by the per-file `downloadable` flag " +
        "— a user upload is served only to its creator (403 otherwise).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description:
            "The file bytes (proxy-stream mode). `Content-Type` is the file's own " +
            "stored MIME (never rewritten), served with `X-Content-Type-Options: nosniff` and " +
            "an `attachment` disposition — hence the `*/*` media type here rather than a fixed " +
            "`application/octet-stream`.",
          headers: {
            "Content-Disposition": {
              schema: { type: "string" },
              description: "attachment; filename=…",
            },
            "X-Content-Type-Options": {
              schema: { type: "string", enum: ["nosniff"] },
              description:
                "Always `nosniff` — the stored MIME is uploader-controlled, so the browser " +
                "must never re-interpret the body as active content.",
            },
            "Repr-Digest": {
              schema: { type: "string" },
              description:
                "RFC 9530 representation digest of the bytes, `sha-256=:<base64>:`. Present only " +
                "when the caller has the file's `metadata` capability.",
            },
          },
          content: {
            "*/*": { schema: { type: "string", format: "binary" } },
          },
        },
        "307": {
          description: "Redirect to a presigned GET URL (public-endpoint S3 mode).",
          headers: {
            Location: { schema: { type: "string", format: "uri" }, description: "Presigned URL." },
            "Repr-Digest": {
              schema: { type: "string" },
              description:
                "RFC 9530 representation digest of the bytes, `sha-256=:<base64>:` (carried on the " +
                "redirect; present only when the caller has the `metadata` capability).",
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;

/**
 * The pre-#1177 `/api/documents…` spelling of every path above, published as a
 * DEPRECATED alias of the same operation.
 *
 * Derived rather than hand-copied: the aliases cannot drift from the canonical
 * paths, and adding an operation above adds its alias for free. Each alias gets
 * `deprecated: true`, a `Deprecated` operationId suffix (OpenAPI requires
 * operationIds to be unique, and a generated client would otherwise collide),
 * and a description line naming the replacement.
 *
 * They are documented rather than merely tolerated because they are REGISTERED
 * — `routes/files.ts` binds both spellings to one handler, and
 * `scripts/verify-openapi.ts` §5 fails on any registered endpoint the spec does
 * not describe. A spec that hides half of what the server answers is the drift
 * that gate exists to catch.
 */
function deprecateOperations(
  operations: Record<string, unknown>,
  canonicalPath: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [method, op] of Object.entries(operations)) {
    const operation = op as { operationId: string; summary?: string; description?: string };
    out[method] = {
      ...operation,
      operationId: `${operation.operationId}Deprecated`,
      deprecated: true,
      summary: `${operation.summary ?? operation.operationId} (deprecated)`,
      description:
        `DEPRECATED — use \`${canonicalPath}\`. This path is the pre-#1177 spelling of the ` +
        `same operation, served by the same handler with the same authorization, and is kept ` +
        `for callers pinned to it.\n\n${operation.description ?? ""}`,
    };
  }
  return out;
}

const deprecatedFilesPaths = Object.fromEntries(
  Object.entries(canonicalFilesPaths).map(([path, operations]) => [
    path.replace("/api/files", "/api/documents"),
    deprecateOperations(operations as Record<string, unknown>, path),
  ]),
);

export const filesPaths = {
  ...canonicalFilesPaths,
  ...deprecatedFilesPaths,
};
