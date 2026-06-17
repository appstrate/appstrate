// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI contribution for the storage module. Documented here = reachable
 * over MCP via the `mcp` module's meta-tools (`invoke_operation`) — agents
 * browse disks and read objects through the same surface as the UI.
 */

const stdHeaders = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
} as const;

function listOf(ref: string) {
  return {
    type: "object",
    required: ["object", "data", "hasMore"],
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: { $ref: ref } },
      hasMore: { type: "boolean" },
    },
  } as const;
}

export const storageComponentSchemas = {
  StorageDisk: {
    type: "object",
    required: ["object", "id", "kind", "name", "isDefault", "enabled", "createdAt", "updatedAt"],
    properties: {
      object: { type: "string", enum: ["storage_disk"] },
      id: { type: "string", description: "Disk ID (sdsk_ prefix)" },
      kind: { type: "string", enum: ["native", "s3", "google_drive", "onedrive", "dropbox"] },
      name: { type: "string" },
      isDefault: { type: "boolean", description: "The org's native default disk" },
      enabled: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  StorageObject: {
    type: "object",
    required: ["object", "id", "diskId", "name", "visibility", "createdAt"],
    properties: {
      object: { type: "string", enum: ["storage_object"] },
      id: { type: "string", description: "Object ID (sobj_ prefix) — the opaque handle" },
      diskId: { type: "string" },
      name: { type: "string" },
      mime: { type: ["string", "null"] },
      sizeBytes: { type: ["integer", "null"] },
      visibility: {
        type: "string",
        enum: ["org", "private"],
        description: "`org` = visible to every member; `private` = owner only",
      },
      ownerId: { type: ["string", "null"] },
      syncedAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
} as const;

export const storagePaths = {
  "/api/storage/disks": {
    get: {
      operationId: "listStorageDisks",
      tags: ["Storage"],
      summary: "List storage disks",
      description:
        "Lists the org's storage disks. The native default disk is created on first access if missing.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Disks list",
          headers: stdHeaders,
          content: { "application/json": { schema: listOf("#/components/schemas/StorageDisk") } },
        },
      },
    },
    post: {
      operationId: "createStorageDisk",
      tags: ["Storage"],
      summary: "Connect a cloud disk",
      description:
        "Connect an S3-compatible bucket (credentials encrypted at rest) or a Google Drive that references one of the caller's existing platform integration connections (no OAuth here — the credential-proxy injects the token). The initial inventory sync runs synchronously.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                {
                  type: "object",
                  required: ["kind", "name", "config"],
                  properties: {
                    kind: { type: "string", enum: ["s3"] },
                    name: { type: "string", maxLength: 200 },
                    config: {
                      type: "object",
                      required: ["bucket", "access_key_id", "secret_access_key"],
                      properties: {
                        bucket: { type: "string" },
                        region: { type: "string" },
                        endpoint: { type: "string", format: "uri" },
                        force_path_style: { type: "boolean" },
                        prefix: { type: "string" },
                        access_key_id: { type: "string" },
                        secret_access_key: { type: "string" },
                      },
                    },
                  },
                },
                {
                  type: "object",
                  required: ["kind", "name", "config"],
                  properties: {
                    kind: { type: "string", enum: ["google_drive"] },
                    name: { type: "string", maxLength: 200 },
                    config: {
                      type: "object",
                      required: ["integration_id", "connection_id", "application_id", "folder_ids"],
                      properties: {
                        integration_id: {
                          type: "string",
                          description: "Integration package id of the picked connection",
                        },
                        connection_id: {
                          type: "string",
                          description: "The caller's existing integration connection id",
                        },
                        application_id: {
                          type: "string",
                          description: "Application the connection lives in",
                        },
                        folder_ids: {
                          type: "array",
                          items: { type: "string" },
                          minItems: 1,
                          description: "Drive folder ids to index (never the whole Drive)",
                        },
                      },
                    },
                  },
                },
              ],
              discriminator: { propertyName: "kind" },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Disk connected (initial sync run)",
          headers: stdHeaders,
          content: { "application/json": { schema: { $ref: "#/components/schemas/StorageDisk" } } },
        },
      },
    },
  },
  "/api/storage/disks/{id}/sync": {
    post: {
      operationId: "syncStorageDisk",
      tags: ["Storage"],
      summary: "Sync a cloud disk",
      description:
        "Synchronously list a cloud disk's objects (filtered by the watermark cursor when the API allows) and upsert the inventory. Returns the counts.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Sync done",
          headers: stdHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "diskId", "listed", "upserted"],
                properties: {
                  object: { type: "string", enum: ["disk_sync"] },
                  diskId: { type: "string" },
                  listed: { type: "integer" },
                  upserted: { type: "integer" },
                },
              },
            },
          },
        },
        "400": { description: "Disk kind cannot be synced" },
        "404": { description: "Disk not found" },
      },
    },
  },
  "/api/storage/disks/{id}": {
    delete: {
      operationId: "deleteStorageDisk",
      tags: ["Storage"],
      summary: "Disconnect a storage disk",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Disk disconnected (objects cascade)" },
        "400": { description: "The default disk cannot be deleted" },
        "404": { description: "Disk not found" },
      },
    },
  },
  "/api/storage/objects": {
    get: {
      operationId: "listStorageObjects",
      tags: ["Storage"],
      summary: "List storage objects",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "diskId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter by disk",
        },
      ],
      responses: {
        "200": {
          description: "Objects inventory",
          headers: stdHeaders,
          content: { "application/json": { schema: listOf("#/components/schemas/StorageObject") } },
        },
      },
    },
    post: {
      operationId: "uploadStorageObject",
      tags: ["Storage"],
      summary: "Upload an object",
      description:
        "Upload a file (multipart/form-data) to a writable disk — the native default disk unless `diskId` is given. The new object gets a stable opaque id consumers read bytes by.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", format: "binary" },
                diskId: {
                  type: "string",
                  description: "Target disk (defaults to the native disk)",
                },
                name: { type: "string", maxLength: 500, description: "Overrides the file name" },
                visibility: { type: "string", enum: ["org", "private"], default: "org" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Object uploaded",
          headers: stdHeaders,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/StorageObject" } },
          },
        },
        "400": { description: "Missing file or disk is read-only" },
        "404": { description: "Disk not found" },
      },
    },
  },
  "/api/storage/objects/{id}": {
    get: {
      operationId: "getStorageObject",
      tags: ["Storage"],
      summary: "Get object metadata",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Object metadata",
          headers: stdHeaders,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/StorageObject" } },
          },
        },
        "404": { description: "Object not found" },
      },
    },
    delete: {
      operationId: "deleteStorageObject",
      tags: ["Storage"],
      summary: "Delete an object",
      description: "Deletes the bytes and the inventory row. Read-only disks (Drive) reject this.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Object deleted" },
        "400": { description: "Object lives on a read-only disk" },
        "404": { description: "Object not found" },
      },
    },
  },
  "/api/storage/objects/{id}/content": {
    get: {
      operationId: "downloadStorageObject",
      tags: ["Storage"],
      summary: "Download object bytes",
      description:
        "Stream the raw bytes of an object by its opaque id — the read seam chat, agents and the future search index use (never the disk's internal key). Enforces org + ACL.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Raw object bytes",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        "404": { description: "Object not found or content unavailable" },
      },
    },
  },
} as const;
