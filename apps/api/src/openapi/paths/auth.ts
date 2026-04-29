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
  "/api/auth/bootstrap/redeem": {
    post: {
      operationId: "redeemBootstrapToken",
      tags: ["Auth"],
      summary: "Claim ownership of an unattended install",
      description:
        "Redeem the one-shot AUTH_BOOTSTRAP_TOKEN written by `appstrate install --yes` to seize ownership of a closed-by-default instance (issue #344). Single-use — once any organization exists, the token is dead. Creates the user, the bootstrap organization, the default application, and the hello-world agent in one round-trip; sets the session cookie so the SPA is logged in immediately.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["token", "email", "password", "name"],
              properties: {
                token: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  description: "Bootstrap token from the install banner / .env.",
                },
                email: { type: "string", format: "email" },
                password: { type: "string", minLength: 8 },
                name: { type: "string", minLength: 1, maxLength: 120 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Ownership claimed, session cookie set",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  user: { $ref: "#/components/schemas/User" },
                  session: { type: "object" },
                  bootstrap: {
                    type: "object",
                    properties: {
                      orgId: { type: "string" },
                      orgSlug: { type: "string" },
                      warnings: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Optional advisory codes — e.g. `default_app_provisioning_failed` when the post-bootstrap default-app/agent hook failed. The owner+org are still committed; the operator can self-heal via /api/applications.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { description: "Validation error" },
        "401": { description: "Invalid bootstrap token" },
        "403": {
          description:
            "Email rejected by AUTH_ALLOWED_SIGNUP_DOMAINS — the bootstrap-token bypass is scoped to AUTH_DISABLE_SIGNUP only; an active domain allowlist still applies.",
        },
        "409": {
          description:
            "Either an account with that email already exists, OR another bootstrap redemption is in progress on this instance (cluster-wide advisory lock + in-process CAS).",
        },
        "410": {
          description:
            "No bootstrap token is currently redeemable (none configured, already redeemed, or instance bootstrapped via AUTH_BOOTSTRAP_OWNER_EMAIL)",
        },
        "422": { description: "Signup rejected (weak password, duplicate email)" },
        "429": {
          description:
            "Rate-limited (5 redeem attempts per minute per source IP) — defense against brute-force on misconfigured short tokens.",
        },
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
