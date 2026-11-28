// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

const problem = {
  "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
};
const configResponse = {
  "application/json": { schema: { $ref: "#/components/schemas/ModelConfig" } },
};
const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const baseUrlProperty = {
  type: "string",
  format: "uri",
  description:
    "The endpoint of a gateway configuration (`baseUrlOverridable` provider): required at creation for a gateway, refused (`400`, param `base_url`) for any other provider. Stored canonical (lowercase host, no trailing slash): `https://h/v1` and `https://h/v1/` are one endpoint.",
};

export const modelConfigsPaths = {
  "/api/model-configs": {
    get: {
      operationId: "listModelConfigs",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "List model configurations",
      description:
        "Every model configuration of the organization, sorted by label. A configuration is one catalog family (a provider and the subscriptions that serve its catalog, e.g. `anthropic` with Claude Code) or one endpoint of a gateway provider. Its connections (`GET /api/model-provider-credentials`, `config_id`) serve its models (`GET /api/models`, `config_id`). **Permission:** `models:read`; `personal_connection_count` needs `model-provider-credentials:read`.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model configuration list",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/ModelConfig" } },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createModelConfig",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Create a model configuration",
      description:
        "Create a configuration. `provider_id` is normalised to its family's representative provider (`claude-code` → `anthropic`). One configuration per family for a catalog provider, one per endpoint for a gateway: an existing one is `409 model_config_exists` with `existing_config_id`. **Permission:** `models:write`.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["provider_id"],
              properties: {
                provider_id: {
                  type: "string",
                  minLength: 1,
                  description:
                    "A registered provider (`GET /api/model-provider-credentials/registry`).",
                },
                label: {
                  type: "string",
                  minLength: 1,
                  maxLength: 120,
                  description:
                    "Display name. Default: the provider's name, prefixed by a gateway's host.",
                },
                base_url: baseUrlProperty,
                personal_connections_allowed: {
                  type: "boolean",
                  default: true,
                  description: "Whether members may connect their own keys or subscriptions.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Model configuration created",
          headers: STD_RESPONSE_HEADERS,
          content: configResponse,
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "`model_config_exists` — the organization already has this configuration; the problem body carries `existing_config_id`.",
          content: problem,
        },
      },
    },
  },
  "/api/model-configs/{id}": {
    patch: {
      operationId: "updateModelConfig",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Update a model configuration",
      description:
        "Merge semantics: an absent field is left unchanged, and a body that sets none is a `400`. A gateway's `base_url` cannot change while the configuration has any connection, organization or personal (`409 model_config_has_connections`): remove them first. Turning `personal_connections_allowed` off keeps the members' connections, which stop serving (and end the runs on one). **Permission:** `models:write`.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }, idParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1, maxLength: 120 },
                base_url: baseUrlProperty,
                personal_connections_allowed: { type: "boolean" },
              },
              minProperties: 1,
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Model configuration updated",
          headers: STD_RESPONSE_HEADERS,
          content: configResponse,
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "`model_config_exists` — another configuration of the organization already has this endpoint; the problem body carries `existing_config_id`. `model_config_has_connections` — `base_url` cannot move while the configuration has connections; the problem body carries `connection_count`.",
          content: problem,
        },
      },
    },
    delete: {
      operationId: "deleteModelConfig",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Delete a model configuration",
      description:
        "Delete a configuration with its connections and models. The organization default is cleared when it named one of its models, and each removed connection and model leaves its own audit entry (`model_provider_credential.deleted`, `model.deleted`). **Permission:** `models:delete` and `model-provider-credentials:delete`.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }, idParam],
      responses: {
        "204": { description: "Model configuration deleted", headers: REQUEST_ID_ONLY_HEADERS },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
