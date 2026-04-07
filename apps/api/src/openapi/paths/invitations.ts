// SPDX-License-Identifier: Apache-2.0

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
              example: {
                email: "newuser@example.com",
                orgName: "Acme Corp",
                role: "member",
                inviterName: "Alice Martin",
                expiresAt: "2026-02-15T10:30:00Z",
                isNewUser: true,
              },
            },
          },
        },
        "404": {
          description: "Invitation not found",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Not Found",
                status: 404,
                detail: "Invitation not found",
                code: "not_found",
                requestId: "req_mno345",
              },
            },
          },
        },
        "410": {
          description: "Invitation already accepted, cancelled, or expired",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Gone",
                status: 410,
                detail: "Invitation has already been accepted",
                code: "gone",
                requestId: "req_pqr678",
              },
            },
          },
        },
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
              example: {
                success: true,
                isNewUser: true,
                orgId: "550e8400-e29b-41d4-a716-446655440000",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          description: "Invitation not found",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "410": {
          description: "Invitation already accepted, cancelled, or expired",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
} as const;
