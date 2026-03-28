export const invitationsPaths = {
  "/invite/{token}/info": {
    get: {
      operationId: "getInvitationInfo",
      tags: ["Invitations"],
      summary: "Get invitation info",
      description: "Public endpoint. Returns invitation metadata (email, org name, role, inviter).",
      security: [],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Invitation metadata",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string" },
                  orgName: { type: "string" },
                  role: { type: "string" },
                  inviterName: { type: "string" },
                  expiresAt: { type: "string" },
                  isNewUser: { type: "boolean" },
                },
              },
            },
          },
        },
        "404": { description: "Invitation not found" },
        "410": { description: "Invitation already accepted, cancelled, or expired" },
      },
    },
  },
  "/invite/{token}/accept": {
    post: {
      operationId: "acceptInvitation",
      tags: ["Invitations"],
      summary: "Accept invitation",
      description:
        "Accept an invitation. Creates user account if new, adds to org, sets session cookie.",
      security: [],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                password: { type: "string", description: "Password (required for new users)" },
                displayName: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Invitation accepted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  isNewUser: { type: "boolean" },
                  orgId: { type: "string" },
                  requiresLogin: {
                    type: "boolean",
                    description: "Present when isNewUser is false",
                  },
                },
              },
            },
          },
        },
        "400": { description: "Validation error (password required for new users, min 8 chars)" },
        "403": {
          description: "Email mismatch — authenticated user's email does not match the invitation email",
        },
        "404": { description: "Invitation not found" },
        "410": { description: "Invitation already accepted, cancelled, or expired" },
      },
    },
  },
} as const;
