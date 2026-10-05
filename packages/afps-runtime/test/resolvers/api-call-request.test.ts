// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { prepareApiCallRequest } from "../../src/resolvers/api-call-request.ts";

const fields: Record<string, string> = { token: "ghp_live", tenant: "acme" };
type Call = { target?: string; headers?: Record<string, string>; bodyTemplates?: string[] };

const prepare = (call: Call, bag = fields) =>
  prepareApiCallRequest({
    target: "https://api.example.com/",
    headers: {},
    bodyTemplates: [],
    ...call,
    fields: bag,
  });

function prepared(call: Call, bag = fields) {
  const result = prepare(call, bag);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.request;
}

function refusal(call: Call, bag = fields) {
  const result = prepare(call, bag);
  if (result.ok) throw new Error("prepared");
  return result.refusal;
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

  it("returns every template of the call: target, headers, body", () => {
    const request = prepared({
      target: "https://api.example.com/{{tenant}}",
      headers: { "X-Key": "{{token}}", "X-Trace": "abc" },
      bodyTemplates: ['{"k":"{{token}}"}'],
    });
    expect(request.templates).toEqual([
      "https://api.example.com/{{tenant}}",
      "{{token}}",
      "abc",
      '{"k":"{{token}}"}',
    ]);
  });

  it("names a header an empty credential went into", () => {
    const request = prepared({ headers: { "X-Key": "{{token}}" } }, { token: "" });
    expect(request.headers).toEqual({ "X-Key": "" });
    expect(request.credentialHeaders).toEqual(["X-Key"]);
  });

  it("returns a value a credential makes invalid: only the caller's own text is judged", () => {
    expect(prepared({ headers: { "X-Key": "{{token}}" } }, { token: "a\nb" }).headers).toEqual({
      "X-Key": "a\nb",
    });
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
    ["X-Custom", "Bearer{{token}}", "Bearerghp_live"],
  ])("%s: %s → %s", (name, template, value) => {
    expect(sent(name, template)).toBe(value);
  });

  it("never rewrites a value: a secret whose first bytes spell a scheme is returned as is", () => {
    for (const secret of ["basically_a_key_123", "tokenlive_sk_123", "bearerXYZ"]) {
      expect(sent("Authorization", secret)).toBe(secret);
      expect(sent("Authorization", "{{token}}", { token: secret })).toBe(secret);
    }
  });
});

describe("prepareApiCallRequest — the first refusal", () => {
  it("an unresolved target placeholder, each key once, ahead of any header", () => {
    expect(
      refusal({
        target: "https://api.example.com/{{missing}}/{{gone}}/{{missing}}",
        headers: { "X-Bad": "a\nb" },
      }),
    ).toEqual({
      kind: "unresolved_placeholder",
      message: "Unresolved placeholders in target: {{missing,gone}}",
    });
  });

  it("resolves own fields only: {{constructor}} is unresolved, not Object.prototype's", () => {
    expect(refusal({ target: "https://api.example.com/{{constructor}}" }).message).toBe(
      "Unresolved placeholders in target: {{constructor}}",
    );
  });

  it("the first header at fault, in the caller's order, ahead of the body", () => {
    expect(
      refusal({
        headers: { "X-Ok": "{{token}}", "X-Missing": "{{nope}}", "X-Bad": "a\nb" },
        bodyTemplates: ["{{b}}"],
      }),
    ).toEqual({
      kind: "unresolved_placeholder",
      message: 'Unresolved placeholders in header "X-Missing": {{nope}}',
    });
  });

  it("a caller value that is no HTTP field value, ahead of its own placeholders", () => {
    expect(refusal({ headers: { "X-Bad": "{{nope}}\n" } })).toEqual({
      kind: "invalid_header",
      message: 'Header "X-Bad" is not a valid HTTP field value',
    });
  });

  it("an unresolved placeholder in any body template", () => {
    expect(refusal({ bodyTemplates: ["{{b1}} {{token}}", "{{b2}} {{b1}}"] })).toEqual({
      kind: "unresolved_placeholder",
      message: "Unresolved placeholders in body: {{b1,b2}}",
    });
  });
});
