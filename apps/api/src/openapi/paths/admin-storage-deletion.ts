// SPDX-License-Identifier: Apache-2.0

const storageDeletionJobSchema = {
  type: "object",
  required: [
    "id",
    "bucket",
    "storageKey",
    "reason",
    "attempts",
    "nextAttemptAt",
    "completedAt",
    "lastError",
    "createdAt",
  ],
  properties: {
    id: { type: "string", example: "sdj_0c9f…" },
    bucket: { type: "string", example: "documents" },
    storageKey: {
      type: "string",
      description: "In-bucket object key (no bucket prefix).",
      example: "app_abc/doc_def/report.pdf",
    },
    reason: {
      type: "string",
      description:
        "Why the object is being purged (document_deleted | document_expired | org_deleted | " +
        "application_deleted | end_user_deleted | run_workspace_deleted | upload_expired | " +
        "materialization_failed).",
    },
    attempts: { type: "integer", description: "Delete attempts made so far." },
    nextAttemptAt: { type: "string", format: "date-time" },
    completedAt: { type: ["string", "null"], format: "date-time" },
    lastError: { type: ["string", "null"] },
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
        "Platform-admin only (`AUTH_PLATFORM_ADMIN_EMAILS`). Lists jobs from the transactional " +
        "storage-deletion outbox, newest-first, keyset-paginated on `created_at`. `dead` = " +
        "pending jobs past the dead-letter attempt threshold (still retrying — the threshold is " +
        "a visibility line, not an abandon point).",
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
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string", format: "date-time" },
          description: "Opaque cursor — the `nextCursor` returned by a prior page.",
        },
      ],
      responses: {
        "200": {
          description: "A page of storage-deletion jobs.",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items", "nextCursor"],
                properties: {
                  items: { type: "array", items: storageDeletionJobSchema },
                  nextCursor: { type: ["string", "null"], format: "date-time" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/admin/storage-deletion-jobs/{id}/retry": {
    post: {
      operationId: "retryStorageDeletionJob",
      tags: ["Admin"],
      summary: "Retry a storage-deletion job now",
      description:
        "Platform-admin only. Resets a pending job's `next_attempt_at` to now so the next worker " +
        "pass retries it immediately. No-op (404) on a completed or unknown job.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Job scheduled for immediate retry.",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
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
      },
    },
  },
} as const;
