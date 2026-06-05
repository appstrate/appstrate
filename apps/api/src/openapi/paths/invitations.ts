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
                  org_name: { type: "string" },
                  role: { type: "string" },
                  inviter_name: { type: "string" },
                  expiresAt: { type: "string" },
                  is_new_user: { type: "boolean" },
                },
              },
              example: {
                email: "newuser@example.com",
                org_name: "Acme Corp",
                role: "member",
                inviter_name: "Alice Martin",
                expiresAt: "2026-02-15T10:30:00Z",
                is_new_user: true,
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
                code: "invitation_not_found",
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
                code: "invitation_accepted",
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
                password: {
                  type: "string",
                  minLength: 8,
                  description: "Password (required for new users, minimum 8 characters)",
                },
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
                  is_new_user: { type: "boolean" },
                  orgId: { type: "string" },
                  requires_login: {
                    type: "boolean",
                    description: "Present when is_new_user is false",
                  },
                },
              },
              example: {
                success: true,
                is_new_user: true,
                orgId: "550e8400-e29b-41d4-a716-446655440000",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": {
          description: "Invitation email does not match the authenticated session",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Email mismatch",
                status: 403,
                detail: "This invitation is for newuser@example.com",
                code: "email_mismatch",
                requestId: "req_stu901",
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
                code: "invitation_not_found",
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
                code: "invitation_accepted",
                requestId: "req_pqr678",
              },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
} as const;
