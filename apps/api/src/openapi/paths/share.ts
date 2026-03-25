export const sharePaths = {
  "/share/{token}/flow": {
    get: {
      operationId: "getSharedFlowInfo",
      tags: ["Share"],
      summary: "Get shared flow info",
      description:
        "Public endpoint. Returns flow metadata for a share link (displayName, description, input schema, usage stats).",
      security: [],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Flow info",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ShareFlowInfo" },
            },
          },
        },
        "410": { description: "Invalid, expired, or inactive link" },
      },
    },
  },
  "/share/{token}/run": {
    post: {
      operationId: "runSharedFlow",
      tags: ["Share"],
      summary: "Execute via share link",
      description:
        "Execute a flow using a public share link. No authentication required. The link must be active and not exhausted (usageCount < maxUses or unlimited).",
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { executionId: { type: "string" } },
              },
            },
          },
        },
        "400": {
          description:
            "Flow readiness validation failed (empty prompt, missing skill/tool, provider not connected, or incomplete config)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "410": { description: "Exhausted, expired, or inactive link" },
      },
    },
  },
  "/share/{token}/status": {
    get: {
      operationId: "getSharedExecutionStatus",
      tags: ["Share"],
      summary: "Get shared execution status",
      description:
        "Public endpoint. Poll execution status for the most recent execution on this share link.",
      security: [],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Execution status",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
                  error: { type: "string" },
                  logs: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        "410": { description: "Invalid link" },
      },
    },
  },
} as const;
