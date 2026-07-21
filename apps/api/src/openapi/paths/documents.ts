// SPDX-License-Identifier: Apache-2.0

// Shared Document object schema (mirrors DocumentDto in services/documents.ts).
const documentSchema = {
  type: "object",
  required: [
    "object",
    "id",
    "uri",
    "purpose",
    "application_id",
    "run_id",
    "chat_session_id",
    "package_id",
    "name",
    "mime",
    "size",
    "sha256",
    "downloadable",
    "expires_at",
    "created_at",
  ],
  properties: {
    object: { type: "string", enum: ["document"] },
    id: { type: "string", description: "Opaque document id (`doc_…`)." },
    uri: {
      type: "string",
      description: "Stable `document://doc_…` reference — pass in a run's file input field.",
    },
    purpose: { type: "string", enum: ["user_upload", "agent_output"] },
    application_id: { type: "string" },
    run_id: { type: ["string", "null"], description: "Run container, or null." },
    chat_session_id: { type: ["string", "null"], description: "Chat-session container, or null." },
    package_id: { type: ["string", "null"], description: "Producing agent package id, or null." },
    name: { type: "string" },
    mime: { type: "string" },
    size: { type: "integer", description: "Size in bytes." },
    sha256: { type: "string", description: "SHA-256 of the bytes (hex)." },
    downloadable: {
      type: "boolean",
      description:
        "Whether `/content` will serve the bytes to the current caller: an agent output is " +
        "downloadable by anyone who can read the container; a user upload only by its creator.",
    },
    expires_at: {
      type: ["string", "null"],
      format: "date-time",
      description: "Retention deadline, or null when permanent.",
    },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

export const documentsPaths = {
  "/api/documents": {
    get: {
      operationId: "listDocuments",
      tags: ["Documents"],
      summary: "List documents",
      description:
        "List the documents visible to the caller in the current application. Members see their " +
        "own documents (and system-owned ones); end-users see only their own. Filter by " +
        "`purpose`, `run_id`, `package_id`, or `chat_session_id`; paginate with `starting_after` " +
        "+ `limit`. Access is inherited from each document's container (no per-file grants).",
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
          name: "package_id",
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
          name: "starting_after",
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
        "Fetch a document's metadata, including the derived `downloadable` flag. Access is " +
        "inherited from the document's container; an id the caller cannot read returns 404.",
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
          content: { "application/json": { schema: documentSchema } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
    delete: {
      operationId: "deleteDocument",
      tags: ["Documents"],
      summary: "Delete a document",
      description:
        "Delete a document (storage object + row) and release its quota. Allowed for a caller " +
        "with the `documents:delete` permission (owner/admin) or the document's own creator.",
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
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
        "Download the document bytes with `Content-Disposition: attachment`. When object storage " +
        "supports it (S3 with a public endpoint), responds `307` with a short-lived presigned " +
        "`Location`; otherwise proxy-streams the bytes (`200`). Gated by the `downloadable` " +
        "flag — a user upload is served only to its creator (403 otherwise).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "The document bytes (proxy-stream mode).",
          headers: {
            "Content-Disposition": {
              schema: { type: "string" },
              description: "attachment; filename=…",
            },
          },
          content: {
            "application/octet-stream": { schema: { type: "string", format: "binary" } },
          },
        },
        "307": {
          description: "Redirect to a presigned GET URL (public-endpoint S3 mode).",
          headers: {
            Location: { schema: { type: "string", format: "uri" }, description: "Presigned URL." },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
