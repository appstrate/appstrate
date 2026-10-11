// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { prepareApiCallRequest } from "../../src/resolvers/api-call-request.ts";

const fields: Record<string, string> = { token: "ghp_live", tenant: "acme" };
type Call = {
  target?: string;
  headers?: Record<string, string>;
  body?: string | null;
  bodyParts?: string[];
};

const prepare = (call: Call, bag = fields) =>
  prepareApiCallRequest({
    target: "https://api.example.com/",
    headers: {},
    body: null,
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

  it("returns every template of the call: target, headers, body, body parts", () => {
    const request = prepared({
      target: "https://api.example.com/{{tenant}}",
      headers: { "X-Key": "{{token}}", "Content-Type": "application/json" },
      body: '{"k":"{{token}}"}',
      bodyParts: ["{{tenant}}"],
    });
    expect(request.templates).toEqual([
      "https://api.example.com/{{tenant}}",
      "{{token}}",
      "application/json",
      '{"k":"{{token}}"}',
      "{{tenant}}",
    ]);
  });

  it("names a header an empty credential went into", () => {
    const request = prepared({ headers: { "X-Key": "{{token}}" } }, { token: "" });
    expect(request.headers).toEqual({ "X-Key": "" });
    expect(request.credentialHeaders).toEqual(["X-Key"]);
  });

  it("leaves a body it is not given alone", () => {
    expect(prepared({}).body).toBeNull();
  });
});

describe("prepareApiCallRequest — a value is encoded for the place it takes", () => {
  const hostile = { v: 'a&b=c#d/e?f "g"\\', base: "https://api.example.com/app" };

  it("URL: a path segment and a query component stay one component", () => {
    const { url } = prepared(
      { target: "https://api.example.com/users/{{v}}/keys?q={{v}}&page=2" },
      hostile,
    );
    const parsed = new URL(url);
    expect(parsed.pathname.split("/")).toHaveLength(4);
    expect([...parsed.searchParams]).toEqual([
      ["q", hostile.v],
      ["page", "2"],
    ]);
    expect(parsed.hash).toBe("");
  });

  it("URL: a leading field is the base URL as is; one in the host cannot leave it", () => {
    expect(prepared({ target: "{{base}}/v1/{{v}}" }, { ...hostile, v: "a/b" }).url).toBe(
      "https://api.example.com/app/v1/a%2Fb",
    );
    const { url } = prepared({ target: "https://{{v}}.example.com/x" }, { v: "evil.test/?" });
    expect(url).toBe("https://evil.test%2F%3F.example.com/x");
  });

  it("body: by the caller's Content-Type, raw only as declared text/plain", () => {
    const body = (contentType: string, template: string) =>
      prepared({ headers: { "content-type": contentType }, body: template }, hostile).body;
    expect(JSON.parse(body("application/json; charset=utf-8", '{"k":"{{v}}","n":1}')!)).toEqual({
      k: hostile.v,
      n: 1,
    });
    expect([
      ...new URLSearchParams(body("application/x-www-form-urlencoded", "k={{v}}&n=1")!),
    ]).toEqual([
      ["k", hostile.v],
      ["n", "1"],
    ]);
    expect(body("text/plain", "k={{v}}")).toBe(`k=${hostile.v}`);
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
        body: "{{b}}",
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

  it("an unresolved placeholder in the body or any of its parts", () => {
    expect(refusal({ body: "{{b1}} {{token}}", bodyParts: ["{{b2}} {{b1}}"] })).toEqual({
      kind: "unresolved_placeholder",
      message: "Unresolved placeholders in body: {{b1,b2}}",
    });
  });

  it.each([
    ["a header", { headers: { "X-Key": "{{token}}" } }, "a\r\nX-Evil: 1"],
    ["a Cookie header", { headers: { Cookie: "sid={{token}}" } }, "a; admin=1"],
    ["a path segment", { target: "https://api.example.com/{{token}}/x" }, ".."],
    [
      "a text body, ill-formed",
      { headers: { "Content-Type": "text/plain" }, body: "{{token}}" },
      "\ud800",
    ],
    ["a body part, ill-formed", { bodyParts: ["k={{token}}"] }, "a\ud800"],
  ])("a value %s cannot carry, naming the placeholder only", (_where, call, token) => {
    const { kind, message } = refusal(call, { token });
    expect(kind).toBe("credential_unusable");
    expect(message).toContain("{{token}}");
    expect(message).not.toContain(token);
  });

  it.each([
    ["no Content-Type", {}],
    ["a media type with no encoder", { "Content-Type": "application/graphql" }],
  ])("a body with placeholders under %s, as the request's fault", (_what, headers) => {
    const token = '","admin":true,"z":"';
    const { kind, message } = refusal({ headers, body: '{"a":"{{token}}"}' }, { token });
    expect(kind).toBe("invalid_body");
    expect(message).toContain("Content-Type");
    expect(message).not.toContain(token);
  });

  it("headers holding one name twice in different case", () => {
    expect(refusal({ headers: { Accept: "a/b", accept: "c/d" } }).kind).toBe("invalid_header");
  });
});
