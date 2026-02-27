export const providerTemplatesPaths = {
  "/api/provider-templates": {
    get: {
      operationId: "listProviderTemplates",
      tags: ["Provider Templates"],
      summary: "List available provider templates",
      description:
        "List provider templates available for creation. Templates whose ID already exists as a built-in or custom provider are excluded. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "search",
          in: "query",
          description: "Filter templates by name, description, category, or auth mode",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Available templates",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  templates: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        templateId: { type: "string" },
                        displayName: { type: "string" },
                        description: { type: "string" },
                        authMode: {
                          type: "string",
                          enum: ["oauth2", "oauth1", "api_key", "basic", "custom", "proxy"],
                        },
                        iconUrl: { type: "string" },
                        categories: { type: "array", items: { type: "string" } },
                        docsUrl: { type: "string" },
                        providerDefaults: { type: "object" },
                        setupGuide: {
                          type: "object",
                          properties: {
                            steps: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  title: { type: "string" },
                                  description: { type: "string" },
                                  link: { type: "string" },
                                  linkLabel: { type: "string" },
                                },
                                required: ["title", "description"],
                              },
                            },
                            callbackUrlHint: { type: "string" },
                          },
                          required: ["steps"],
                        },
                      },
                      required: [
                        "templateId",
                        "displayName",
                        "description",
                        "authMode",
                        "providerDefaults",
                        "setupGuide",
                      ],
                    },
                  },
                  callbackUrl: {
                    type: "string",
                    description: "OAuth callback URL for this platform instance",
                  },
                },
                required: ["templates", "callbackUrl"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
