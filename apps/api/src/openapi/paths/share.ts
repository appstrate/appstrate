export const sharePaths = {
  "/share/{token}/flow": {
    get: {
      operationId: "getSharedFlowInfo",
      tags: ["Share"],
      summary: "Get shared flow info",
      description:
        "Public endpoint. Returns flow metadata for a share token (displayName, description, input schema).",
      security: [],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Flow info",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ShareFlowInfo" },
            },
          },
        },
        "404": { description: "Invalid or consumed token" },
      },
    },
  },
  "/share/{token}/run": {
    post: {
      operationId: "runSharedFlow",
      tags: ["Share"],
      summary: "Execute via share token",
      description:
        "Execute a flow using a one-time public share token. No authentication required.",
      security: [],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                input: { type: "object", description: "Execution input values" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Execution started",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { executionId: { type: "string" } },
              },
            },
          },
        },
        "404": { description: "Invalid or consumed token" },
      },
    },
  },
  "/share/{token}/status": {
    get: {
      operationId: "getSharedExecutionStatus",
      tags: ["Share"],
      summary: "Get shared execution status",
      description: "Public endpoint. Poll execution status for a share token.",
      security: [],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Execution status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                    enum: ["pending", "running", "success", "failed", "timeout", "cancelled"],
                  },
                  result: { type: "object" },
                },
              },
            },
          },
        },
        "404": { description: "Invalid token or no execution" },
      },
    },
  },
} as const;
