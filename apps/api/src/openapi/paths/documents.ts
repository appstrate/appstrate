// SPDX-License-Identifier: Apache-2.0

// Shared Document object schema (mirrors DocumentDto in services/documents.ts).
// Field casing follows CASING_CONVENTIONS.md carve-out 4b: `applicationId`,
// `packageId`, `createdAt`, `expiresAt` are on the universal DB-convention list
// (camelCase everywhere); `run_id` / `chat_session_id` are NOT on it, so they
// stay snake_case domain fields (matching the `notification` DTO's `run_id`).
const documentSchema = {
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
    object: { type: "string", enum: ["document"] },
    id: { type: "string", description: "Opaque document id (`doc_…`)." },
    uri: {
      type: "string",
      description: "Stable `document://doc_…` reference — pass in a run's file input field.",
    },
    purpose: { type: "string", enum: ["user_upload", "agent_output"] },
    applicationId: { type: "string" },
    run_id: { type: ["string", "null"], description: "Run container, or null." },
    chat_session_id: { type: ["string", "null"], description: "Chat-session container, or null." },
    packageId: { type: ["string", "null"], description: "Producing agent package id, or null." },
    name: {
      type: "string",
      description:
        'Display name. Degrades to the generic `"document"` when the caller lacks the `metadata` ' +
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
        "The caller's full access-capability set for this document — the single source the UI " +
        "drives its download/preview/keep/delete affordances from.",
      required: ["visible", "metadata", "download", "preview", "keep", "delete"],
      properties: {
        visible: {
          type: "boolean",
          description: "The caller can resolve this document at all (container ACL).",
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
        delete: { type: "boolean", description: "The caller may delete the document." },
      },
    },
    previewable: {
      type: "boolean",
      description:
        "Whether the caller can open an in-browser preview of this document (a readable document " +
        "of a previewable kind — see `preview_kind`). Present on every row; the signed " +
        "`preview_url` is minted only on the single-document GET (below).",
    },
    preview_kind: {
      type: ["string", "null"],
      enum: ["html", "image", "pdf", "text", null],
      description:
        "How this document previews, or null when not previewable: `html` (sandboxed iframe, " +
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
 * The document as served by the SINGLE-document GET — the only handler that
 * passes `mintPreview`, and therefore the only response that can carry a
 * `preview_url`. List rows and the `keep` response use `documentSchema` above
 * (no `preview_url` property at all), matching `toDocumentDto` exactly.
 */
const documentWithPreviewSchema = {
  type: "object",
  required: documentSchema.required,
  properties: {
    ...documentSchema.properties,
    preview_url: {
      type: ["string", "null"],
      format: "uri",
      description:
        "Absolute URL of a hardened, cookie-less preview (short-lived signed token in the " +
        "query). Minted ONLY on this single-document GET — the list rows and the `keep` " +
        "response carry `previewable` instead. Non-null only for a previewable document. " +
        'Load in a `sandbox="allow-scripts"` iframe: for an `html` document that iframe is ' +
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
 * Errors every `/api/documents` operation can answer with before its handler
 * ever runs — all three come from the shared pipeline, not from the handler,
 * and were previously undocumented:
 *
 *  - `400` — `requireAppContext()` with no resolvable `X-Application-Id`.
 *  - `403` — the RBAC guard without `documents:read`, or `requireAppContext()`
 *    when the header contradicts the application the credential is pinned to.
 *  - `404` — `requireAppContext()` when the application id is not in the
 *    caller's organization (same status the handlers use for an unreadable
 *    document, deliberately indistinguishable).
 */
const pipelineResponses = {
  "400": { $ref: "#/components/responses/ValidationError" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
} as const;

export const documentsPaths = {
  "/api/documents": {
    get: {
      operationId: "listDocuments",
      tags: ["Documents"],
      summary: "List documents",
      description:
        "List the documents visible to the caller in the current application. Requires the " +
        "`documents:read` permission (the family gate — mirrors `runs:read`); on top of it, " +
        "each row is filtered by its own container ACL, so members see their own documents " +
        "(and system-owned ones) and end-users see only their own. Filter by `purpose`, " +
        "`run_id`, `packageId`, or `chat_session_id`; paginate with `startingAfter` + `limit`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "purpose",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["user_upload", "agent_output"] },
          description: "Filter by document purpose.",
        },
        {
          name: "run_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter to documents anchored to this run.",
        },
        {
          name: "packageId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter to documents produced by this agent package.",
        },
        {
          name: "chat_session_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter to documents anchored to this chat session.",
        },
        {
          name: "startingAfter",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Keyset cursor — document id to page after (newest-first order).",
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
          description: "A page of documents.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: documentSchema },
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
  "/api/documents/{id}": {
    get: {
      operationId: "getDocument",
      tags: ["Documents"],
      summary: "Get document metadata",
      description:
        "Fetch a document's metadata, including the derived `downloadable` flag and — for a " +
        "previewable document — a freshly minted `preview_url`. Requires the `documents:read` " +
        "permission; on top of it access is inherited from the document's container, so an id " +
        "the caller cannot read returns 404.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "The document.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: { "application/json": { schema: documentWithPreviewSchema } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
    delete: {
      operationId: "deleteDocument",
      tags: ["Documents"],
      summary: "Delete a document",
      description:
        "Delete a document (storage object + row) and release its quota. Allowed for a caller " +
        "with the `documents:delete` permission (owner/admin) or the document's own creator. " +
        "A document referenced by a run cannot be deleted until those consumer runs are removed.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Deleted.",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "409": {
          description: "Document is still referenced by one or more consumer runs.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Conflict",
                status: 409,
                detail: "This document is referenced by one or more runs and cannot be deleted",
                code: "document_in_use",
                requestId: "req_abc123",
              },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/documents/{id}/keep": {
    post: {
      operationId: "keepDocument",
      tags: ["Documents"],
      summary: "Keep a document (clear its expiry)",
      description:
        "Pin a document so it is never swept by the retention GC: clears its `expires_at` " +
        "(sets it to null / permanent). Allowed for a caller with the `documents:delete` " +
        "permission (owner/admin) or the document's own creator. Idempotent — keeping an " +
        "already-permanent document is a no-op that returns 200 with the unchanged document. " +
        "An id the caller cannot read returns 404.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description:
            "The document, with `expiresAt` now null. No `preview_url` is minted on this " +
            "response — re-read `GET /api/documents/{id}` for a fresh one.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: { "application/json": { schema: documentSchema } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        ...pipelineResponses,
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/documents/{id}/content": {
    get: {
      operationId: "getDocumentContent",
      tags: ["Documents"],
      summary: "Download document content",
      description:
        "Download the document bytes with `Content-Disposition: attachment`. Requires the " +
        "`documents:read` permission. When object storage supports it (S3 with a public " +
        "endpoint), responds `307` with a short-lived presigned `Location`; otherwise " +
        "proxy-streams the bytes (`200`). Also gated by the per-document `downloadable` flag " +
        "— a user upload is served only to its creator (403 otherwise).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description:
            "The document bytes (proxy-stream mode). `Content-Type` is the document's own " +
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
                "when the caller has the document's `metadata` capability.",
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
