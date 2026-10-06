// SPDX-License-Identifier: Apache-2.0

import { problemContent } from "../responses.ts";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@appstrate/db/password-policy";

/**
 * Better Auth answers `sign-up/email` and `sign-in/email` itself: its errors are
 * `application/json` `{ code, message }`, not the platform's ProblemDetail.
 */
const betterAuthError = {
  "application/json": {
    schema: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
} as const;

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
                password: {
                  type: "string",
                  minLength: MIN_PASSWORD_LENGTH,
                  maxLength: MAX_PASSWORD_LENGTH,
                },
                name: { type: "string" },
                callbackURL: {
                  type: "string",
                  description:
                    "Where the verification link lands once the address is verified (email verification enabled only). A path on this instance, or a URL on a trusted origin. Defaults to `/`.",
                },
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
                  token: { type: ["string", "null"] },
                },
              },
              example: {
                user: {
                  id: "usr_abc123",
                  email: "alice@example.com",
                  name: "Alice Martin",
                },
                token: "sess_...",
              },
            },
          },
        },
        "400": { description: "Validation error", content: betterAuthError },
        "403": {
          description:
            "Sign-up blocked by the platform signup gate (issue #228): signups disabled, email domain not in the allowlist, or an invitation is required; `code` names the reason.",
          content: betterAuthError,
        },
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
                callbackURL: {
                  type: "string",
                  description:
                    "Where the verification link lands when the account's address is not verified yet and this call re-sends it. When set, the 200 response answers `redirect: true` with this value as `url`.",
                },
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
                  // Better Auth's sign-in response carries a `redirect` flag
                  // (post-login redirect signalling) alongside user + token.
                  redirect: { type: "boolean" },
                  url: { type: "string" },
                  user: { $ref: "#/components/schemas/User" },
                  token: { type: ["string", "null"] },
                },
              },
              example: {
                redirect: false,
                user: {
                  id: "usr_abc123",
                  email: "alice@example.com",
                  name: "Alice Martin",
                },
                token: "sess_...",
              },
            },
          },
        },
        "401": { description: "Invalid credentials", content: betterAuthError },
        "403": {
          description:
            "The account's email address is not verified (`code: EMAIL_NOT_VERIFIED`, email verification enabled only). A fresh verification email was sent.",
          content: betterAuthError,
        },
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
        "Redeem the one-shot AUTH_BOOTSTRAP_TOKEN written by `appstrate install --yes` to seize ownership of a closed-by-default instance (issue #344). Single-use — once any organization exists, the token is dead. Creates the user, the bootstrap organization, the default space, and the hello-world agent in one round-trip; sets the session cookie so the SPA is logged in immediately.",
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
                // BOTH bounds are shared: this endpoint sets the same
                // credential `sign-up/email` does, so a ceiling of its own was
                // a second source of truth (it said 256 while Better Auth
                // enforced 128).
                password: {
                  type: "string",
                  minLength: MIN_PASSWORD_LENGTH,
                  maxLength: MAX_PASSWORD_LENGTH,
                },
                name: { type: "string", minLength: 1, maxLength: 120 },
              },
              additionalProperties: false,
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
                  token: {
                    type: ["string", "null"],
                    description:
                      "Session token (auto sign-in); session cookie also set via Set-Cookie",
                  },
                  bootstrap: {
                    type: "object",
                    properties: {
                      orgId: { type: "string" },
                      org_slug: { type: "string" },
                      warnings: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Optional advisory codes — e.g. `default_space_provisioning_failed` when the post-bootstrap default-space/agent hook failed. The owner+org are still committed; the operator can self-heal via /api/spaces.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { description: "Invalid bootstrap token", content: problemContent },
        "403": {
          description:
            "Email rejected by AUTH_ALLOWED_SIGNUP_DOMAINS — the bootstrap-token bypass is scoped to AUTH_DISABLE_SIGNUP only; an active domain allowlist still applies.",
          content: problemContent,
        },
        "409": {
          description:
            "Either an account with that email already exists, OR another bootstrap redemption is in progress on this instance (cluster-wide advisory lock + in-process CAS).",
          content: problemContent,
        },
        "410": {
          description:
            "No bootstrap token is currently redeemable (none configured, already redeemed, or instance bootstrapped via AUTH_BOOTSTRAP_OWNER_EMAIL)",
          content: problemContent,
        },
        "422": {
          description: "Signup rejected (weak password, duplicate email)",
          content: problemContent,
        },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description:
            "Rate-limited (5 redeem attempts per minute per source IP) — defense against brute-force on misconfigured short tokens.",
        },
        "500": { $ref: "#/components/responses/InternalServerError" },
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
          description: "Session info, or `null` when there is no active session.",
          content: {
            "application/json": {
              schema: {
                // Better Auth returns the literal `null` body (200) when no
                // session is active, otherwise the {user, session} envelope.
                type: ["object", "null"],
                properties: {
                  user: { anyOf: [{ $ref: "#/components/schemas/User" }, { type: "null" }] },
                  session: { type: ["object", "null"] },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
