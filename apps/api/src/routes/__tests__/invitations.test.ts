import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import { queues, resetQueues, db, schemaStubs } from "../../services/__tests__/_db-mock.ts";

// --- Configurable mock state ---

type Invitation = {
  id: string;
  token: string;
  email: string;
  orgId: string;
  role: string;
  status: string;
  invitedBy: string | null;
  expiresAt: Date;
};

let mockInvitation: Invitation | null = null;
let mockOrgName = "Test Org";
let mockInviterName = "Alice";
let markAcceptedCalls: { id: string; userId: string }[] = [];
let addMemberCalls: { orgId: string; userId: string; role: string }[] = [];
let addMemberError: Error | null = null;

let mockSignUpResult: { user?: { id: string } } | null = null;
let signUpCalls: { email: string; password: string; name: string }[] = [];
let signInCalls: { email: string; password: string }[] = [];
let mockSignInResponse: Response | null = null;
let mockSession: { user?: { id: string } } | null = null;

// --- Mocks (must be before dynamic import) ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));

mock.module("@appstrate/db/schema", () => ({
  ...schemaStubs,
  user: { id: "id", email: "email", name: "name" },
}));

mock.module("../../services/invitations.ts", () => ({
  getInvitationByToken: async () => mockInvitation,
  markInvitationAccepted: async (id: string, userId: string) => {
    markAcceptedCalls.push({ id, userId });
  },
  getOrgName: async () => mockOrgName,
  getInviterName: async () => mockInviterName,
}));

mock.module("../../services/organizations.ts", () => ({
  addMember: async (orgId: string, userId: string, role: string) => {
    addMemberCalls.push({ orgId, userId, role });
    if (addMemberError) throw addMemberError;
  },
}));

mock.module("../../lib/auth.ts", () => ({
  auth: {
    api: {
      signUpEmail: async ({
        body,
      }: {
        body: { email: string; password: string; name: string };
      }) => {
        signUpCalls.push(body);
        return mockSignUpResult;
      },
      signInEmail: async ({ body }: { body: { email: string; password: string } }) => {
        signInCalls.push(body);
        return mockSignInResponse;
      },
      getSession: async () => mockSession,
    },
  },
}));

// --- Dynamic import (after all mocks) ---

const { default: router } = await import("../invitations.ts");

// --- Test app ---

const app = new Hono();
app.route("/invite", router);

// --- Helpers ---

function validInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: "inv-1",
    token: "abc123",
    email: "newuser@test.com",
    orgId: "org-1",
    role: "member",
    status: "pending",
    invitedBy: "user-inviter",
    expiresAt: new Date(Date.now() + 86400000), // +1 day
    ...overrides,
  };
}

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

// --- Reset ---

beforeEach(() => {
  resetQueues();
  mockInvitation = null;
  mockOrgName = "Test Org";
  mockInviterName = "Alice";
  markAcceptedCalls = [];
  addMemberCalls = [];
  addMemberError = null;
  mockSignUpResult = null;
  signUpCalls = [];
  signInCalls = [];
  mockSignInResponse = null;
  mockSession = null;
});

// ==================== GET /invite/:token/info ====================

describe("GET /invite/:token/info", () => {
  test("returns 404 when invitation not found", async () => {
    mockInvitation = null;

    const res = await app.request("/invite/bad-token/info");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("INVITATION_NOT_FOUND");
  });

  test("returns 410 when already accepted", async () => {
    mockInvitation = validInvitation({ status: "accepted" });

    const res = await app.request("/invite/abc123/info");
    expect(res.status).toBe(410);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("INVITATION_ACCEPTED");
  });

  test("returns 410 when cancelled", async () => {
    mockInvitation = validInvitation({ status: "cancelled" });

    const res = await app.request("/invite/abc123/info");
    expect(res.status).toBe(410);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("INVITATION_CANCELLED");
  });

  test("returns 410 when expired (status)", async () => {
    mockInvitation = validInvitation({ status: "expired" });

    const res = await app.request("/invite/abc123/info");
    expect(res.status).toBe(410);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("INVITATION_EXPIRED");
  });

  test("returns 410 when expired (date passed)", async () => {
    mockInvitation = validInvitation({ expiresAt: new Date(Date.now() - 1000) });

    const res = await app.request("/invite/abc123/info");
    expect(res.status).toBe(410);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("INVITATION_EXPIRED");
  });

  test("returns isNewUser: true when no existing user", async () => {
    mockInvitation = validInvitation();
    queues.select.push([]); // user lookup → no match

    const res = await app.request("/invite/abc123/info");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      email: string;
      orgName: string;
      isNewUser: boolean;
      inviterName: string;
    };
    expect(json.email).toBe("newuser@test.com");
    expect(json.orgName).toBe("Test Org");
    expect(json.inviterName).toBe("Alice");
    expect(json.isNewUser).toBe(true);
  });

  test("returns isNewUser: false when user exists", async () => {
    mockInvitation = validInvitation();
    queues.select.push([{ id: "existing-user-1" }]); // user lookup → found

    const res = await app.request("/invite/abc123/info");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { isNewUser: boolean };
    expect(json.isNewUser).toBe(false);
  });
});

// ==================== POST /invite/:token/accept (new user) ====================

describe("POST /invite/:token/accept — new user", () => {
  beforeEach(() => {
    mockInvitation = validInvitation();
    queues.select.push([]); // existingUser check → not found
    mockSignUpResult = { user: { id: "new-user-1" } };
    mockSignInResponse = new Response(JSON.stringify({ ok: true }), {
      headers: { "Set-Cookie": "session=abc123; Path=/" },
    });
  });

  test("returns 400 when no password provided", async () => {
    const res = await jsonRequest("/invite/abc123/accept", "POST", {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  test("returns 400 when password too short (7 chars)", async () => {
    const res = await jsonRequest("/invite/abc123/accept", "POST", { password: "1234567" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  test("accepts password at exactly 8 chars", async () => {
    const res = await jsonRequest("/invite/abc123/accept", "POST", { password: "12345678" });
    expect(res.status).toBe(200);
  });

  test("returns 400 when no body at all", async () => {
    const res = await app.request("/invite/abc123/accept", { method: "POST" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  test("creates account with valid password → 200", async () => {
    const res = await jsonRequest("/invite/abc123/accept", "POST", {
      password: "securePassword123",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; isNewUser: boolean; orgId: string };
    expect(json.success).toBe(true);
    expect(json.isNewUser).toBe(true);
    expect(json.orgId).toBe("org-1");
  });

  test("forwards Set-Cookie from sign-in response", async () => {
    const res = await jsonRequest("/invite/abc123/accept", "POST", {
      password: "securePassword123",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("session=abc123");
  });

  test("adds member to org and marks invitation accepted", async () => {
    await jsonRequest("/invite/abc123/accept", "POST", { password: "securePassword123" });

    expect(addMemberCalls).toHaveLength(1);
    expect(addMemberCalls[0]).toEqual({ orgId: "org-1", userId: "new-user-1", role: "member" });

    expect(markAcceptedCalls).toHaveLength(1);
    expect(markAcceptedCalls[0]).toEqual({ id: "inv-1", userId: "new-user-1" });
  });

  test("passes provided password to signUpEmail and signInEmail", async () => {
    await jsonRequest("/invite/abc123/accept", "POST", { password: "mySecurePass99" });

    expect(signUpCalls).toHaveLength(1);
    expect(signUpCalls[0]!.email).toBe("newuser@test.com");
    expect(signUpCalls[0]!.password).toBe("mySecurePass99");

    expect(signInCalls).toHaveLength(1);
    expect(signInCalls[0]!.password).toBe("mySecurePass99");
  });

  test("passes displayName to signUpEmail when provided", async () => {
    await jsonRequest("/invite/abc123/accept", "POST", {
      password: "securePassword123",
      displayName: "  John Doe  ",
    });

    expect(signUpCalls).toHaveLength(1);
    expect(signUpCalls[0]!.name).toBe("John Doe");
  });

  test("falls back to email when displayName not provided", async () => {
    await jsonRequest("/invite/abc123/accept", "POST", { password: "securePassword123" });

    expect(signUpCalls).toHaveLength(1);
    expect(signUpCalls[0]!.name).toBe("newuser@test.com");
  });

  test("skips duplicate member error gracefully", async () => {
    addMemberError = new Error("duplicate key value violates unique constraint");

    const res = await jsonRequest("/invite/abc123/accept", "POST", {
      password: "securePassword123",
    });
    expect(res.status).toBe(200);
  });

  test("propagates non-duplicate addMember errors", async () => {
    addMemberError = new Error("connection refused");

    const res = await jsonRequest("/invite/abc123/accept", "POST", {
      password: "securePassword123",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("ACCEPT_FAILED");
  });

  test("returns 500 when signup returns no user", async () => {
    mockSignUpResult = {};

    const res = await jsonRequest("/invite/abc123/accept", "POST", {
      password: "securePassword123",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("SIGNUP_FAILED");
  });
});

// ==================== POST /invite/:token/accept (existing user) ====================

describe("POST /invite/:token/accept — existing user", () => {
  beforeEach(() => {
    mockInvitation = validInvitation();
    queues.select.push([{ id: "existing-user-1" }]); // existingUser check → found
  });

  test("adds existing user to org → 200", async () => {
    mockSession = { user: { id: "existing-user-1" } };

    const res = await jsonRequest("/invite/abc123/accept", "POST", {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      isNewUser: boolean;
      requiresLogin: boolean;
    };
    expect(json.success).toBe(true);
    expect(json.isNewUser).toBe(false);
    expect(json.requiresLogin).toBe(false);
  });

  test("returns requiresLogin: true when no session", async () => {
    mockSession = null;

    const res = await jsonRequest("/invite/abc123/accept", "POST", {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { requiresLogin: boolean };
    expect(json.requiresLogin).toBe(true);
  });

  test("does not require password for existing users", async () => {
    mockSession = { user: { id: "existing-user-1" } };

    // No password in body — should still succeed
    const res = await app.request("/invite/abc123/accept", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("marks invitation accepted with existing user id", async () => {
    mockSession = { user: { id: "existing-user-1" } };

    await jsonRequest("/invite/abc123/accept", "POST", {});

    expect(addMemberCalls).toHaveLength(1);
    expect(addMemberCalls[0]!.userId).toBe("existing-user-1");

    expect(markAcceptedCalls).toHaveLength(1);
    expect(markAcceptedCalls[0]!.userId).toBe("existing-user-1");
  });
});

// ==================== POST /invite/:token/accept (status checks) ====================

describe("POST /invite/:token/accept — status checks", () => {
  test("returns 404 when invitation not found", async () => {
    mockInvitation = null;

    const res = await jsonRequest("/invite/bad-token/accept", "POST", {});
    expect(res.status).toBe(404);
  });

  test("returns 410 when already accepted", async () => {
    mockInvitation = validInvitation({ status: "accepted" });

    const res = await jsonRequest("/invite/abc123/accept", "POST", {});
    expect(res.status).toBe(410);
  });

  test("returns 410 when cancelled", async () => {
    mockInvitation = validInvitation({ status: "cancelled" });

    const res = await jsonRequest("/invite/abc123/accept", "POST", {});
    expect(res.status).toBe(410);
  });

  test("returns 410 when expired", async () => {
    mockInvitation = validInvitation({ expiresAt: new Date(Date.now() - 1000) });

    const res = await jsonRequest("/invite/abc123/accept", "POST", {});
    expect(res.status).toBe(410);
  });
});
