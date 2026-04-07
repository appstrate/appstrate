// SPDX-License-Identifier: Apache-2.0

export const authPaths = {
  "/api/auth/sign-up/email": {
    post: {
      operationId: "signUpEmail",
      tags: ["Auth"],
      summary: "Create account",
      description: "Create a new account with email, password, and name. Sets session cookie.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email", "password", "name"],
              properties: {
                email: { type: "string", format: "email" },
                password: { type: "string", minLength: 8 },
                name: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Account created, session cookie set",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  user: { $ref: "#/components/schemas/User" },
                  session: { type: "object" },
                },
              },
              example: {
                user: {
                  id: "usr_abc123",
                  email: "alice@example.com",
                  name: "Alice Martin",
                },
                session: { token: "sess_..." },
              },
            },
          },
        },
        "400": { description: "Validation error" },
      },
    },
  },
  "/api/auth/sign-in/email": {
    post: {
      operationId: "signInEmail",
      tags: ["Auth"],
      summary: "Log in",
      description: "Login with email and password. Sets session cookie.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email", "password"],
              properties: {
                email: { type: "string", format: "email" },
                password: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Logged in, session cookie set",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  user: { $ref: "#/components/schemas/User" },
                  session: { type: "object" },
                },
              },
              example: {
                user: {
                  id: "usr_abc123",
                  email: "alice@example.com",
                  name: "Alice Martin",
                },
                session: { token: "sess_..." },
              },
            },
          },
        },
        "401": { description: "Invalid credentials" },
      },
    },
  },
  "/api/auth/sign-out": {
    post: {
      operationId: "signOut",
      tags: ["Auth"],
      summary: "Log out",
      description: "Clears session cookie.",
      responses: {
        "200": {
          description: "Logged out",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/auth/get-session": {
    get: {
      operationId: "getSession",
      tags: ["Auth"],
      summary: "Get current session",
      description: "Returns the current session and user info.",
      responses: {
        "200": {
          description: "Session info",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  user: { $ref: "#/components/schemas/User" },
                  session: { type: "object" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;
