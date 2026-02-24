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
                },
              },
            },
          },
        },
        "404": { description: "Invalid or expired invitation" },
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
      responses: {
        "200": { description: "Invitation accepted" },
        "400": { description: "Invalid or expired invitation" },
      },
    },
  },
} as const;
