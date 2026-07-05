// SPDX-License-Identifier: Apache-2.0

export const uploadsPaths = {
  "/api/uploads": {
    post: {
      operationId: "createUpload",
      tags: ["Uploads"],
      summary: "Create a direct-upload descriptor",
      description:
        "Reserve an upload slot and return a signed URL the client PUTs the binary to. " +
        "Full upload→run recipe: " +
        "(1) POST /api/uploads with the file's `name`, exact `size` in bytes, and `mime` — " +
        "the response carries a `uri` (e.g. `upload://upl_xxx`), a signed `url`, and `headers`. " +
        "(2) PUT the raw file bytes (not multipart) to `url`, sending exactly the returned " +
        "`headers` (`Content-Type`, plus `Content-Length` when the storage signs the declared " +
        "size — the body must then be exactly `size` bytes). No other headers are required — " +
        "in particular no checksum headers; the signed URL does not bind one. " +
        "(3) Call `runAgent` with `uri` as the value of the file-typed input field. The actual " +
        "byte count must equal the declared `size`, and binary MIMEs are verified by magic-byte " +
        "sniffing. Consumed uploads are NOT single-use: the bytes stay retained — and the `uri` " +
        "re-consumable — for `UPLOAD_RETENTION_HOURS` (default 24 h) after the first consume, so " +
        "the same input can be re-run (e.g. via `rerun_from` after cancelling) without " +
        "re-uploading. Unconsumed uploads expire with the signed URL. " +
        "Small files (≤4 MiB decoded) can skip this flow entirely: inline the content directly " +
        "in the `runAgent` input as `data:<mime>;name=<filename>;base64,<payload>`. " +
        "Rate-limited to 20/min.",
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
                // Mirrors CreateUploadResponse (services/uploads.ts) — every
                // field is always serialized.
                required: ["object", "id", "uri", "url", "method", "headers", "expiresAt"],
                properties: {
                  object: { type: "string", enum: ["upload"] },
                  id: { type: "string" },
                  uri: {
                    type: "string",
                    description:
                      "Reference to embed in the agent's file-typed input field on `runAgent` " +
                      "(e.g. `upload://upl_xxx`).",
                  },
                  url: {
                    type: "string",
                    format: "uri",
                    description:
                      "Signed PUT URL. Points at the platform's proxy sink on the app domain " +
                      "(filesystem storage, or S3 in proxy mode), or directly at S3/MinIO when " +
                      "`S3_PUBLIC_ENDPOINT` is configured. PUT the raw binary body to it before " +
                      "the upload expires.",
                  },
                  method: { type: "string", enum: ["PUT"] },
                  headers: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description:
                      "The complete set of headers the client MUST send verbatim on the PUT " +
                      "request (`Content-Type`, plus `Content-Length` bound to the declared " +
                      "`size` in direct-presign S3 mode). Nothing else is required — no " +
                      "checksum headers.",
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
                headers: { "Content-Type": "application/pdf", "Content-Length": "24576" },
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
      summary: "Write upload bytes (proxy sink)",
      description:
        "Public endpoint receiving upload bytes on the app domain — used by filesystem " +
        "storage, and by S3 storage in proxy mode (`S3_PUBLIC_ENDPOINT` unset; the platform " +
        "streams the body to the private bucket server-side). Authenticated via HMAC-signed " +
        "`token` query parameter returned in the upload descriptor. The token binds storage " +
        "key, declared MIME, max size and expiry; the max size is enforced while the body " +
        "streams to the backend, so chunked uploads cannot exceed it. In direct-presign S3 " +
        "mode (`S3_PUBLIC_ENDPOINT` set) the signed URL points directly at the bucket and " +
        "this endpoint is not used. Rate-limited per IP (60/min).",
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
