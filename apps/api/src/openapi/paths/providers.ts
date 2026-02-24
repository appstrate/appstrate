export const providersPaths = {
  "/api/providers": {
    get: {
      operationId: "listProviders",
      tags: ["Providers"],
      summary: "List all providers",
      description:
        "List all provider configurations (built-in + custom) for the organization. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Provider list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ProviderConfig" },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      operationId: "createProvider",
      tags: ["Providers"],
      summary: "Create a custom provider",
      description: "Create a new provider configuration. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ProviderConfigInput" },
          },
        },
      },
      responses: {
        "201": {
          description: "Provider created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/providers/{providerId}": {
    put: {
      operationId: "updateProvider",
      tags: ["Providers"],
      summary: "Update a provider",
      description:
        "Update a custom provider configuration. Admin only. Built-in providers cannot be modified.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "providerId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ProviderConfigInput" },
          },
        },
      },
      responses: {
        "200": { description: "Provider updated" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteProvider",
      tags: ["Providers"],
      summary: "Delete a provider",
      description:
        "Delete a custom provider. Built-in providers cannot be deleted. Cannot delete if used by flows.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "providerId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Provider deleted" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { description: "Provider in use by flows" },
      },
    },
  },
} as const;
