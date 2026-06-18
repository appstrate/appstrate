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
                required: ["email", "org_name", "role", "inviter_name", "expiresAt", "is_new_user"],
                properties: {
                  email: { type: "string" },
                  org_name: { type: "string" },
                  role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
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
        "Accept an invitation. Requires an authenticated Better Auth session whose email matches the invitation; adds the user to the org and returns the joined organization. Account creation happens beforehand through the standard login/signup flow, never here.",
      security: [{ cookieAuth: [] }],
      parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description:
            "Invitation accepted — returns the joined organization (same shape as the items in GET /api/orgs, with `role` set to the invitation role).",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Organization" },
              example: {
                id: "550e8400-e29b-41d4-a716-446655440000",
                name: "Acme Corp",
                slug: "acme-corp",
                role: "member",
                createdAt: "2026-01-10T08:00:00Z",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
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
