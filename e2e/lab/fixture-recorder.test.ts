// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  Pseudonymizer,
  UnsafeFixtureValueError,
  canonicalizeOpenApiPath,
  classifyResponse,
  dedupeCaptures,
  generateCandidate,
  sanitizeJson,
  sanitizeQuery,
} from "./fixture-recorder.mjs";

const paths = {
  "/api/integrations/{packageId}": { get: {} },
  "/api/integrations/{packageId}/connections": { get: {} },
  "/api/packages/agents/{scope}/{name}": { get: {} },
  "/api/runs/{id}": { get: {} },
};

describe("canonicalizeOpenApiPath", () => {
  it("resolves multi-segment parameters and prefers the most specific template", () => {
    expect(
      canonicalizeOpenApiPath(
        "/api/integrations/@appstrate/google-drive/connections",
        "GET",
        paths,
      ),
    ).toBe("/api/integrations/{packageId}/connections");
    expect(canonicalizeOpenApiPath("/api/packages/agents/@tractr/compta", "get", paths)).toBe(
      "/api/packages/agents/{scope}/{name}",
    );
  });

  it("requires the concrete HTTP method to exist", () => {
    expect(canonicalizeOpenApiPath("/api/runs/run_1", "delete", paths)).toBeNull();
  });
});

describe("privacy", () => {
  it("pseudonymizes ids, PII, names, dates and remote hosts deterministically", () => {
    const pseudonymizer = new Pseudonymizer();
    pseudonymizer.alias("name", "Olivier Tarbès");
    const sanitized = sanitizeJson(
      {
        id: "usr_real123",
        ownerId: "usr_real123",
        created_by: "private-creator-value-without-a-prefix",
        email: "olivier@tractr.net",
        name: "Olivier Tarbès",
        createdAt: "2026-08-23T12:34:56.000Z",
        callbackUrl: "https://private.example.com/runs/run_private123#run_private456",
      },
      pseudonymizer,
    );

    expect(sanitized).toEqual({
      id: "id_1",
      ownerId: "id_1",
      created_by: "id_2",
      email: "person_1@example.invalid",
      name: "name_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      callbackUrl: "https://service_1.example.invalid/runs/id_3#id_4",
    });
  });

  it("replaces known live identifiers inside text and dynamic object keys", () => {
    const pseudonymizer = new Pseudonymizer();
    pseudonymizer.alias("scope", "@private-org");
    pseudonymizer.alias("agent", "private-agent-mt68x5um");

    expect(
      sanitizeJson(
        {
          description: "E2E agent private-agent-mt68x5um",
          "@private-org/private-agent-mt68x5um": 1,
        },
        pseudonymizer,
      ),
    ).toEqual({
      description: "E2E agent agent_1",
      "scope_1/agent_1": 1,
    });

    expect(
      sanitizeJson(
        {
          description: "Older fixture-recorder-abc123",
          "@scope/fixture-recorder-abc123": 1,
          conn_private123: true,
          "bdce12bf-1234-4abc-8def-123456789012": true,
        },
        pseudonymizer,
      ),
    ).toEqual({
      description: "Older agent_2",
      "@scope/agent_2": 1,
      id_1: true,
      id_2: true,
    });
  });

  it("fails closed on sensitive keys and unknown high-entropy strings", () => {
    expect(() => sanitizeJson({ session: { token: "real-session-token" } })).toThrow(
      UnsafeFixtureValueError,
    );
    expect(() => sanitizeJson({ opaque: "aB9!kL2@mN7#pQ4$rS8%vX1&zC6*" })).toThrow("high-entropy");
    expect(() =>
      sanitizeJson({ content: JSON.stringify({ credentials: { access_token: "real-token" } }) }),
    ).toThrow("sensitive key");
    expect(() =>
      sanitizeJson({ downloadUrl: "https://files.example.com/a?X-Amz-Signature=real" }),
    ).toThrow("sensitive query");
    expect(sanitizeJson({ id: "aB9!kL2@mN7#pQ4$rS8%vX1&zC6*" })).toEqual({ id: "id_1" });
    expect(() => sanitizeJson({ password: { value: "ordinary" } })).toThrow("sensitive key");
    expect(() => sanitizeJson({ credentials: { value: "ordinary" } })).toThrow("sensitive key");
    expect(() =>
      sanitizeJson({ opaque: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }),
    ).toThrow("high-entropy");
    expect(() =>
      sanitizeJson({
        opaque: "QWxwaGEvQmV0YSsxMjM0NTY3ODkwYWJjZGVmR0hJSktMTU5PUFFSU1RVVldYWVo=",
      }),
    ).toThrow("high-entropy");
  });

  it("does not mistake credential schema properties for captured credentials", () => {
    expect(
      sanitizeJson({
        properties: {
          api_key: { type: "string", title: "API key" },
          credentials: { type: "object" },
        },
        auths: {
          primary: { credentials: { schema: { type: "object", properties: {} } } },
        },
        delivery: { value: "{$credential.access_token}" },
      }),
    ).toEqual({
      properties: {
        api_key: { type: "string", title: "API key" },
        credentials: { type: "object" },
      },
      auths: {
        primary: { credentials: { schema: { type: "object", properties: {} } } },
      },
      delivery: { value: "{$credential.access_token}" },
    });
    expect(() =>
      sanitizeJson({ properties: { token: { type: "string", value: "real-token" } } }),
    ).toThrow("sensitive key");
    expect(() =>
      sanitizeJson({ credentials: { schema: { type: "object" }, value: "real-token" } }),
    ).toThrow("sensitive key");
  });

  it("keeps query variants but rejects secret-bearing query keys", () => {
    const pseudonymizer = new Pseudonymizer();
    expect(
      sanitizeQuery(new URLSearchParams("cursor=cursor_private_1&limit=20"), pseudonymizer),
    ).toBe("cursor=query_1&limit=20");
    expect(sanitizeQuery(new URLSearchParams("z=1&a=2"), pseudonymizer)).toBe("z=1&a=2");
    expect(() => sanitizeQuery(new URLSearchParams("token=secret"), pseudonymizer)).toThrow(
      "sensitive query",
    );
    expect(
      sanitizeQuery(new URLSearchParams("chat_session_id=session_123&api_key_id=key_123")),
    ).toBe("chat_session_id=query_1&api_key_id=query_2");
    expect(() =>
      sanitizeQuery(
        new URLSearchParams([["opaque", "aB9!kL2@mN7#pQ4$rS8%vX1&zC6*"]]),
        pseudonymizer,
      ),
    ).toThrow("high-entropy query");
  });
});

describe("capture reduction and generation", () => {
  const base = {
    method: "get",
    path: "/api/runs/{id}",
    query: "",
    scope: { org: "org_1", application: "app_1" },
    body: { id: "id_1" },
  };

  it("orders by browser request and dedupes only equal query and scope variants", () => {
    const result = dedupeCaptures([
      { ...base, order: 3, screen: "third" },
      { ...base, order: 1, screen: "first" },
      { ...base, order: 2, screen: "query", query: "b=2&a=1" },
      { ...base, order: 4, screen: "scope", scope: { org: "org_2", application: "app_1" } },
      { ...base, order: 5, screen: "query-again", query: "a=1&b=2" },
    ]);

    expect(result.captures).toHaveLength(3);
    expect(result.captures[0]).toMatchObject({ order: 1, screens: ["first", "third"] });
    expect(result.captures.map((capture) => capture.query)).toEqual(["", "b=2&a=1", ""]);
    expect(result.captures[1].screens).toEqual(["query", "query-again"]);
    expect(result.conflicts).toEqual([]);
  });

  it("emits every body as an explicit Json200 declaration", () => {
    const source = generateCandidate([{ ...base, order: 1, screen: "run", screens: ["run"] }]);
    expect(source).toContain('import type { Json200 } from "./fixtures";');
    expect(source).toContain('Json200<"/api/runs/{id}", "get">');
    expect(source).toContain('"screens": [\n      "run"\n    ]');
    expect(source).toContain("This file is not imported by the lab");
  });

  it("reports one conflict per request signature even when it changes repeatedly", () => {
    const result = dedupeCaptures([
      { ...base, order: 1, screen: "first" },
      { ...base, order: 2, screen: "second", body: { id: "id_2" } },
      { ...base, order: 3, screen: "third", body: { id: "id_3" } },
    ]);
    expect(result.conflicts).toEqual([
      { path: "/api/runs/{id}", method: "get", firstOrder: 1, nextOrder: 2 },
    ]);
  });
});

describe("special responses", () => {
  const openApi = {
    paths: {
      "/api/items": {
        get: {
          responses: {
            "200": { content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
    },
  };

  it("accepts only documented JSON 200 responses", () => {
    expect(
      classifyResponse({
        path: "/api/items",
        method: "get",
        status: 200,
        contentType: "application/json; charset=utf-8",
        openApi,
      }),
    ).toEqual({ kind: "json200" });
  });

  it("reports Better Auth, 204, SSE and binary without reading a body", () => {
    const cases = [
      ["/api/auth/get-session", 200, "application/json", "Better Auth"],
      ["/api/items", 204, "application/json", "204"],
      ["/api/items", 200, "text/event-stream", "SSE"],
      ["/api/items", 200, "application/octet-stream", "Binary"],
    ] as const;
    for (const [path, status, contentType, reason] of cases) {
      expect(classifyResponse({ path, method: "get", status, contentType, openApi })).toMatchObject(
        { kind: "special", reason: expect.stringContaining(reason) },
      );
    }
  });
});
