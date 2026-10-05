// SPDX-License-Identifier: Apache-2.0

/**
 * `prepareApiCallRequest` — the caller half every api_call path prepares the same way: target,
 * header and body templates in; wire values out, or every reason the call is not prepared.
 */

import { describe, it, expect } from "bun:test";
import { prepareApiCallRequest } from "../../src/resolvers/api-call-request.ts";

const fields: Record<string, string> = { token: "ghp_live", tenant: "acme" };
const target = "https://api.example.com/";

/** The prepared request, failing the test when it was refused. */
function prepared(
  call: { target?: string; headers?: Record<string, string>; bodyTemplates?: string[] },
  bag = fields,
) {
  const result = prepareApiCallRequest({ target, headers: {}, ...call, fields: bag });
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.issues)}`);
  return result.request;
}

/** The issues of a refused request, failing the test when it was prepared. */
function issues(
  call: { target?: string; headers?: Record<string, string>; bodyTemplates?: string[] },
  bag = fields,
) {
  const result = prepareApiCallRequest({ target, headers: {}, ...call, fields: bag });
  if (result.ok) throw new Error("prepared");
  return result.issues;
}

describe("prepareApiCallRequest — substitution", () => {
  it("substitutes the target and the headers, and names the headers a credential went into", () => {
    const request = prepared({
      target: "https://{{tenant}}.example.com/v1?k={{ token }}",
      headers: { Authorization: "Bearer {{token}}", Accept: "application/json" },
    });
    expect(request.url).toBe("https://acme.example.com/v1?k=ghp_live");
    expect(request.headers).toEqual({
      Authorization: "Bearer ghp_live",
      Accept: "application/json",
    });
    expect(request.credentialHeaders).toEqual(["Authorization"]);
  });

  it("returns every template of the call: target, headers as repaired, body", () => {
    const request = prepared({
      target: "https://api.example.com/{{tenant}}",
      headers: { Authorization: "Bearer{{token}}", "X-Trace": "abc" },
      bodyTemplates: ['{"k":"{{token}}"}'],
    });
    expect(request.templates).toEqual([
      "https://api.example.com/{{tenant}}",
      "Bearer {{token}}",
      "abc",
      '{"k":"{{token}}"}',
    ]);
  });

  it("does not mutate the caller's headers", () => {
    const headers = { Authorization: "Bearer{{token}}" };
    prepared({ headers });
    expect(headers).toEqual({ Authorization: "Bearer{{token}}" });
  });

  it("names a header an empty credential went into", () => {
    const request = prepared({ headers: { "X-Key": "{{token}}" } }, { token: "" });
    expect(request.headers).toEqual({ "X-Key": "" });
    expect(request.credentialHeaders).toEqual(["X-Key"]);
  });

  it("substitutes once: a `{{word}}` inside a credential value is sent as is", () => {
    const request = prepared(
      { target: "https://api.example.com/{{token}}", headers: { "X-Key": "{{token}}" } },
      { token: "a{{tenant}}b" },
    );
    expect(request.url).toBe("https://api.example.com/a{{tenant}}b");
    expect(request.headers).toEqual({ "X-Key": "a{{tenant}}b" });
  });

  it("returns a caller value a credential spoils: judging it is the sender's", () => {
    const request = prepared({ headers: { "X-Key": "{{token}}" } }, { token: "a\nb" });
    expect(request.headers).toEqual({ "X-Key": "a\nb" });
    expect(request.credentialHeaders).toEqual(["X-Key"]);
  });
});

describe("prepareApiCallRequest — auth scheme repair (on the template, #988)", () => {
  const sent = (name: string, template: string, bag = fields) =>
    prepared({ headers: { [name]: template } }, bag).headers[name];

  it.each([
    ["Authorization", "Bearer{{token}}", "Bearer ghp_live"],
    ["Authorization", "Basic{{token}}", "Basic ghp_live"],
    ["Authorization", "Token{{token}}", "Token ghp_live"],
    ["Authorization", "bearer{{token}}", "bearer ghp_live"],
    ["Authorization", "Bearer{{ token }}", "Bearer ghp_live"],
    ["authorization", "Bearer{{token}}", "Bearer ghp_live"],
    ["Authorization", "Bearer {{token}}", "Bearer ghp_live"],
  ])("%s: %s → %s", (name, template, value) => {
    expect(sent(name, template)).toBe(value);
  });

  it("leaves another header untouched", () => {
    expect(sent("X-Custom", "Bearer{{token}}")).toBe("Bearerghp_live");
  });

  it("never rewrites a value: a secret whose first bytes spell a scheme is returned as is", () => {
    for (const secret of ["basically_a_key_123", "tokenlive_sk_123", "bearerXYZ"]) {
      expect(sent("Authorization", secret)).toBe(secret);
      expect(sent("Authorization", "{{token}}", { token: secret })).toBe(secret);
    }
  });
});

describe("prepareApiCallRequest — refusals", () => {
  it("resolves own fields only: {{constructor}} is unresolved, not Object.prototype's", () => {
    expect(issues({ target: "https://api.example.com/{{constructor}}" })).toEqual([
      { kind: "unresolved_placeholder", in: "target", keys: ["constructor"] },
    ]);
  });

  it("names every issue, in order: target, each header, body", () => {
    expect(
      issues({
        target: "https://api.example.com/{{missing}}/{{gone}}",
        headers: { "X-Ok": "{{token}}", "X-Missing": "{{nope}}", "X-Bad": "a\nb" },
        bodyTemplates: ["{{b1}} {{token}}", "{{b2}} {{b1}}"],
      }),
    ).toEqual([
      { kind: "unresolved_placeholder", in: "target", keys: ["missing", "gone"] },
      { kind: "unresolved_placeholder", in: "header", header: "X-Missing", keys: ["nope"] },
      { kind: "invalid_header", header: "X-Bad" },
      { kind: "unresolved_placeholder", in: "body", keys: ["b1", "b2"] },
    ]);
  });

  it.each(["a\nb", "a\rb", "a\0b", "cafĀ"])(
    "a caller value that is no HTTP field value (%j)",
    (value) => {
      expect(issues({ headers: { "X-Bad": value } })).toEqual([
        { kind: "invalid_header", header: "X-Bad" },
      ]);
    },
  );

  it("a header both invalid and unresolved is reported invalid", () => {
    expect(issues({ headers: { "X-Bad": "{{nope}}\n" } })).toEqual([
      { kind: "invalid_header", header: "X-Bad" },
    ]);
  });
});
