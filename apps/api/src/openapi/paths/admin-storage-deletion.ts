// SPDX-License-Identifier: Apache-2.0

import { REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

const storageDeletionJobSchema = {
  type: "object",
  required: [
    "id",
    "bucket",
    "storage_key",
    "reason",
    "attempts",
    "next_attempt_at",
    "completed_at",
    "last_error",
    "createdAt",
  ],
  properties: {
    id: { type: "string", example: "sdj_0c9f…" },
    bucket: { type: "string", example: "files" },
    storage_key: {
      type: "string",
      description: "In-bucket object key (no bucket prefix).",
      example: "app_abc/file_def/report.pdf",
    },
    reason: {
      type: "string",
      description:
        "Why the object is being purged (file_deleted | file_expired | org_deleted | " +
        "application_deleted | end_user_deleted | run_workspace_deleted | version_deleted | " +
        "upload_expired | materialization_failed). Free text, not a constrained enum.",
    },
    attempts: { type: "integer", description: "Delete attempts made so far." },
    next_attempt_at: { type: "string", format: "date-time" },
    completed_at: { type: ["string", "null"], format: "date-time" },
    last_error: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const adminStorageDeletionPaths = {
  "/api/admin/storage-deletion-jobs": {
    get: {
      operationId: "listStorageDeletionJobs",
      tags: ["Admin"],
      summary: "List storage-deletion outbox jobs",
      description:
        "Platform-operator surface. Requires an authentic first-party dashboard SESSION whose " +
        "realm is `platform` AND whose email is in `AUTH_PLATFORM_ADMIN_EMAILS`; API keys and " +
        "OIDC-issued bearer tokens are refused outright, whatever their scopes. Lists jobs from " +
        "the transactional storage-deletion outbox, newest-first, keyset-paginated on " +
        "`(created_at, id)`. `dead` = pending jobs past the dead-letter attempt threshold " +
        "(still retrying — the threshold is a visibility line, not an abandon point). The " +
        "listing is instance-global: rows carry the bucket + in-bucket key of objects belonging " +
        "to ANY organization. Rate-limited to 60/min.",
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["pending", "dead", "completed"], default: "pending" },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        {
          name: "startingAfter",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Cursor — the `id` of the last job of the previous page. Follow the RFC 5988 " +
            '`Link: <…>; rel="next"` response header instead of building it by hand.',
        },
      ],
      responses: {
        "200": {
          description: "A page of storage-deletion jobs.",
          headers: { ...REQUEST_ID_ONLY_HEADERS, Link: { $ref: "#/components/headers/Link" } },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: storageDeletionJobSchema },
                  hasMore: { type: "boolean" },
                },
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
  "/api/admin/storage-deletion-jobs/{id}/retry": {
    post: {
      operationId: "retryStorageDeletionJob",
      tags: ["Admin"],
      summary: "Retry a storage-deletion job now",
      description:
        "Same platform-operator session gate as the listing above (session + `platform` realm + " +
        "allowlisted email). Resets a pending job's `next_attempt_at` to now so the next worker " +
        "pass retries it immediately. No-op (404) on a completed or unknown job. " +
        "Rate-limited to 30/min.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Job scheduled for immediate retry.",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "retried"],
                properties: {
                  id: { type: "string" },
                  retried: { type: "boolean", enum: [true] },
                },
              },
            },
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
