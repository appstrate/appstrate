// SPDX-License-Identifier: Apache-2.0

export const uploadsPaths = {
  "/api/uploads": {
    post: {
      operationId: "createUpload",
      tags: ["Uploads"],
      summary: "Create a direct-upload descriptor",
      description:
        "Reserve an upload slot and return a signed URL the client PUTs the binary to. " +
        "The returned `uri` (e.g. `upload://upl_xxx`) is embedded in agent `input` fields; " +
        "the run pipeline resolves and consumes it atomically. Rate-limited to 20/min.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name", "size", "mime"],
              properties: {
                name: {
                  type: "string",
                  minLength: 1,
                  maxLength: 255,
                  description: "Client-supplied filename. Path separators are stripped.",
                },
                size: {
                  type: "integer",
                  minimum: 1,
                  maximum: 104857600,
                  description: "Expected payload size in bytes (max 100 MB).",
                },
                mime: {
                  type: "string",
                  minLength: 1,
                  maxLength: 255,
                  description:
                    "Declared MIME. Verified via magic-byte sniffing on consume for binary types.",
                },
              },
            },
            example: { name: "invoice.pdf", size: 24576, mime: "application/pdf" },
          },
        },
      },
      responses: {
        "201": {
          description: "Upload descriptor created.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["upload"] },
                  id: { type: "string" },
                  uri: {
                    type: "string",
                    description: "Reference to embed in agent input (e.g. `upload://upl_xxx`).",
                  },
                  url: {
                    type: "string",
                    format: "uri",
                    description:
                      "Pre-signed PUT URL. Points at S3/MinIO directly, or at the platform FS sink.",
                  },
                  method: { type: "string", enum: ["PUT"] },
                  headers: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description: "Headers the client MUST forward on the PUT request.",
                  },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
              example: {
                object: "upload",
                id: "upl_abc123",
                uri: "upload://upl_abc123",
                url: "https://s3.example.com/uploads/app_1/upl_abc123/invoice.pdf?X-Amz-...",
                method: "PUT",
                headers: { "Content-Type": "application/pdf" },
                expiresAt: "2026-04-14T12:15:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/uploads/_content": {
    put: {
      operationId: "writeUploadContent",
      tags: ["Uploads"],
      summary: "Write upload bytes (filesystem sink)",
      description:
        "Public endpoint used when the platform runs in filesystem storage mode. " +
        "Authenticated via HMAC-signed `token` query parameter returned in the upload " +
        "descriptor. The token binds storage key, declared MIME, max size and expiry. " +
        "In S3 mode the signed URL points directly at the bucket and this endpoint is not used. " +
        "Rate-limited per IP (60/min).",
      security: [],
      parameters: [
        {
          name: "token",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "HMAC-signed upload token (opaque base64url.base64url).",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      responses: {
        "204": {
          description: "Bytes accepted.",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": {
          description: "Upload content already written for this token.",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
