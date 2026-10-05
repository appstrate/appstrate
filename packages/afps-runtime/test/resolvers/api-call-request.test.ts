// SPDX-License-Identifier: Apache-2.0

/**
 * `prepareApiCallRequest` — the caller half every api_call path prepares the same way: target and
 * header templates in, wire values out, or the one reason nothing is sent.
 */

import { describe, it, expect } from "bun:test";
import { prepareApiCallRequest } from "../../src/resolvers/api-call-request.ts";

const fields = { token: "ghp_live", tenant: "acme" };

/** The prepared request, failing the test when it was refused. */
function prepared(
  target: string,
  headers: Record<string, string>,
  bag: Record<string, string> = fields,
) {
  const result = prepareApiCallRequest(target, headers, bag);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.issue)}`);
  return result.request;
}

describe("prepareApiCallRequest — substitution", () => {
  it("substitutes the target and the headers, and names the headers a credential went into", () => {
    const request = prepared("https://{{tenant}}.example.com/v1?k={{ token }}", {
      Authorization: "Bearer {{token}}",
      Accept: "application/json",
    });
    expect(request.url).toBe("https://acme.example.com/v1?k=ghp_live");
    expect(request.headers).toEqual({
      Authorization: "Bearer ghp_live",
      Accept: "application/json",
    });
    expect(request.credentialHeaders).toEqual(["Authorization"]);
  });

  it("returns the templates it substituted into: the target, then each header as repaired", () => {
    const request = prepared("https://api.example.com/{{tenant}}", {
      Authorization: "Bearer{{token}}",
      "X-Trace": "abc",
    });
    expect(request.templates).toEqual([
      "https://api.example.com/{{tenant}}",
      "Bearer {{token}}",
      "abc",
    ]);
  });

  it("does not mutate the caller's headers", () => {
    const headers = { Authorization: "Bearer{{token}}" };
    prepared("https://api.example.com/", headers);
    expect(headers).toEqual({ Authorization: "Bearer{{token}}" });
  });

  it("resolves own fields only: {{constructor}} is unresolved, not Object.prototype's", () => {
    expect(prepareApiCallRequest("https://api.example.com/{{constructor}}", {}, fields)).toEqual({
      ok: false,
      issue: { kind: "unresolved_placeholder", in: "target", keys: ["constructor"] },
    });
  });
});

describe("prepareApiCallRequest — auth scheme repair (on the template, #988)", () => {
  const authorization = (name: string, template: string, bag: Record<string, string> = fields) =>
    prepared("https://api.example.com/", { [name]: template }, bag).headers[name];

  it.each([
    ["Authorization", "Bearer{{token}}", "Bearer ghp_live"],
    ["Authorization", "Basic{{token}}", "Basic ghp_live"],
    ["Authorization", "Token{{token}}", "Token ghp_live"],
    ["Authorization", "bearer{{token}}", "bearer ghp_live"],
    ["authorization", "Bearer{{token}}", "Bearer ghp_live"],
    ["Proxy-Authorization", "Basic{{token}}", "Basic ghp_live"],
    ["Authorization", "Bearer {{token}}", "Bearer ghp_live"],
  ])("%s: %s → %s", (name, template, sent) => {
    expect(authorization(name, template)).toBe(sent);
  });

  it("leaves another header untouched", () => {
    expect(authorization("X-Custom", "Bearer{{token}}")).toBe("Bearerghp_live");
  });

  it("never rewrites a value: a secret whose first bytes spell a scheme reaches the wire as is", () => {
    for (const secret of ["basically_a_key_123", "tokenlive_sk_123", "bearerXYZ"]) {
      expect(authorization("Authorization", secret)).toBe(secret);
      expect(authorization("Authorization", "{{token}}", { token: secret })).toBe(secret);
    }
  });
});

describe("prepareApiCallRequest — refusals, nothing substituted", () => {
  it("an unresolved target placeholder, before any header is read", () => {
    expect(
      prepareApiCallRequest("https://api.example.com/{{missing}}/{{gone}}", { A: "\n" }, fields),
    ).toEqual({
      ok: false,
      issue: { kind: "unresolved_placeholder", in: "target", keys: ["missing", "gone"] },
    });
  });

  it("the first header at fault, in the caller's order", () => {
    expect(
      prepareApiCallRequest(
        "https://api.example.com/",
        { "X-Ok": "{{token}}", "X-Missing": "{{nope}}", "X-Bad": "a\nb" },
        fields,
      ),
    ).toEqual({
      ok: false,
      issue: { kind: "unresolved_placeholder", in: "header", header: "X-Missing", keys: ["nope"] },
    });
  });

  it.each(["a\nb", "a\rb", "a\0b", "cafĀ"])(
    "a caller value that is no HTTP field value (%j)",
    (value) => {
      expect(prepareApiCallRequest("https://api.example.com/", { "X-Bad": value }, fields)).toEqual(
        { ok: false, issue: { kind: "invalid_header", header: "X-Bad" } },
      );
    },
  );

  it("judges the caller's value as written: one a credential spoils is left to the engine", () => {
    const request = prepared(
      "https://api.example.com/",
      { "X-Key": "{{token}}" },
      { token: "a\nb" },
    );
    expect(request.headers).toEqual({ "X-Key": "a\nb" });
    expect(request.credentialHeaders).toEqual(["X-Key"]);
  });
});
