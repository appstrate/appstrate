// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { filterSensitiveHeaders, redactLocationHeader, scrubSecretMaterial } from "../redact.ts";

describe("filterSensitiveHeaders", () => {
  it("drops set-cookie from a Headers instance", () => {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    h.set("Set-Cookie", "session=abc123; HttpOnly");
    const out = filterSensitiveHeaders(h);
    expect(out["content-type"] ?? out["Content-Type"]).toBe("application/json");
    expect(out["set-cookie"]).toBeUndefined();
    expect(out["Set-Cookie"]).toBeUndefined();
  });

  it("drops www-authenticate, proxy-authenticate, authorization, x-api-key, cookie", () => {
    const h: Record<string, string> = {
      "WWW-Authenticate": "Bearer realm=oauth",
      "Proxy-Authenticate": "Basic",
      Authorization: "Bearer leaked-token",
      "x-api-key": "sk-leaked",
      Cookie: "session=abc",
      "x-request-id": "req_keepme",
      "content-type": "application/json",
    };
    const out = filterSensitiveHeaders(h);
    expect(out["WWW-Authenticate"]).toBeUndefined();
    expect(out["Proxy-Authenticate"]).toBeUndefined();
    expect(out["Authorization"]).toBeUndefined();
    expect(out["x-api-key"]).toBeUndefined();
    expect(out["Cookie"]).toBeUndefined();
    expect(out["x-request-id"]).toBe("req_keepme");
    expect(out["content-type"]).toBe("application/json");
  });

  it("matches header names case-insensitively", () => {
    const h: Record<string, string> = {
      "SET-COOKIE": "x=1",
      "set-Cookie": "y=2",
      "X-API-Key": "leaked",
    };
    const out = filterSensitiveHeaders(h);
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("preserves non-sensitive headers unchanged (RateLimit, retry-after, request-id)", () => {
    const h: Record<string, string> = {
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "0",
      "Retry-After": "30",
      "x-request-id": "req_xyz",
      "content-type": "application/json",
    };
    const out = filterSensitiveHeaders(h);
    expect(out).toEqual(h);
  });

  it("returns an empty object when all headers are sensitive", () => {
    const h: Record<string, string> = {
      "set-cookie": "x",
      authorization: "Bearer y",
    };
    expect(filterSensitiveHeaders(h)).toEqual({});
  });

  it("redacts Location to origin + path instead of dropping it (Headers instance)", () => {
    const h = new Headers();
    h.set("Location", "https://files.example.com/dl/report.pdf?X-Amz-Signature=SECRET&x=1");
    h.set("content-type", "text/html");
    const out = filterSensitiveHeaders(h);
    // Headers normalises names to lowercase.
    expect(out["location"]).toBe("https://files.example.com/dl/report.pdf");
    expect(out["content-type"]).toBe("text/html");
  });

  it("redacts Location case-insensitively on a plain record, preserving casing", () => {
    const h: Record<string, string> = {
      LOCATION: "https://sso.example.com/cb?access_token=tok_leak#frag",
    };
    const out = filterSensitiveHeaders(h);
    expect(out["LOCATION"]).toBe("https://sso.example.com/cb");
  });
});

describe("redactLocationHeader", () => {
  it("strips the query string from an absolute URL", () => {
    expect(redactLocationHeader("https://h.example/p/a?token=secret")).toBe(
      "https://h.example/p/a",
    );
  });

  it("keeps an absolute URL without query untouched (origin + path)", () => {
    expect(redactLocationHeader("https://h.example/p/a")).toBe("https://h.example/p/a");
  });

  it("strips userinfo from an absolute URL", () => {
    expect(redactLocationHeader("https://user:pass@h.example/p?q=1")).toBe("https://h.example/p");
  });

  it("preserves a non-default port (diagnostic) while stripping the query", () => {
    expect(redactLocationHeader("https://h.example:8443/p?sig=s")).toBe("https://h.example:8443/p");
  });

  it("strips the query from a relative Location and keeps the path", () => {
    expect(redactLocationHeader("/oauth/cb?code=abc&state=xyz")).toBe("/oauth/cb");
  });

  it("keeps a plain relative path as-is", () => {
    expect(redactLocationHeader("/next")).toBe("/next");
  });

  it("strips the fragment from a relative Location", () => {
    expect(redactLocationHeader("/page#access_token=tok")).toBe("/page");
  });

  it("strips userinfo and query from a scheme-relative Location", () => {
    expect(redactLocationHeader("//user:pass@h.example/p?sig=s")).toBe("//h.example/p");
  });
});

describe("scrubSecretMaterial", () => {
  it("masks an sk-ant token embedded in an error body", () => {
    expect(scrubSecretMaterial('{"error":"bad key sk-ant-oat01-abc-def"}')).toBe(
      '{"error":"bad key [redacted-key]"}',
    );
  });

  it("masks a Bearer sequence, keeping the scheme so the log stays readable", () => {
    expect(scrubSecretMaterial("upstream said: Bearer eyJhbGciOi.abc_def-ghi rejected")).toBe(
      "upstream said: Bearer [redacted] rejected",
    );
  });

  it("is case-insensitive on sk-ant and leaves clean text byte-identical", () => {
    expect(scrubSecretMaterial("bearer tok123 and SK-ANT-x1")).toBe(
      "bearer [redacted] and [redacted-key]",
    );
    const clean = '{"error":{"type":"overloaded_error"}}';
    expect(scrubSecretMaterial(clean)).toBe(clean);
  });

  // The reason this function replaced `scrubBearerMaterial`: each shape below
  // reached an operator log unmasked on the `/llm` path while the identical
  // shape was masked on the runner-stderr path, because two scrubbers of
  // unequal strength lived in the same process.
  it("masks the shapes the previous /llm scrubber let through", () => {
    expect(scrubSecretMaterial("key ghp_ABCdef123456789")).toBe("key [redacted-key]");
    expect(scrubSecretMaterial("aws key AKIAIOSFODNN7EXAMPLE")).toBe("aws key [redacted-key]");
    expect(scrubSecretMaterial("got ya29.a0AfH6SMBx-abc_123")).toBe("got [redacted-key]");
    expect(scrubSecretMaterial("used Basic aWQ6c2VjcmV0")).toBe("used Basic [redacted]");
    expect(scrubSecretMaterial("raw eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(
      "raw [redacted-jwt]",
    );
  });

  // Regression, in two parts, because the first fix was incomplete.
  //
  // 1. The first version put `\b` on the `Bearer|Basic` and `sk-ant-` rules.
  //    In percent-encoded text the `0` of `%20` sits immediately before the
  //    literal, so the anchor never matched and the key shipped verbatim.
  // 2. Dropping `\b` was NOT sufficient, and the commit that did it claimed
  //    otherwise. `%20` is not `\s`, so `(Bearer|Basic)\s+` still could not
  //    match `Bearer%20<token>` — the assertions below only passed because
  //    every fixture token began with `sk-ant-`, which its own rule catches.
  //    Hence the OPAQUE token cases: they fail unless the separator groups
  //    themselves accept the percent-encoded forms.
  it("masks credentials that are not preceded by a word boundary", () => {
    const key = "sk-ant-api03-9fK2mQzXbT4LpR7wV";
    expect(
      scrubSecretMaterial(`https://api.x/v1?h=Authorization%3A%20Bearer%20${key}`),
    ).not.toContain(key);
    expect(scrubSecretMaterial(`/cb#Bearer%20${key}`)).not.toContain(key);
    expect(scrubSecretMaterial(`a${key}`)).not.toContain(key);
    expect(scrubSecretMaterial("_Bearer tokABC123xyz")).not.toContain("tokABC123xyz");
  });

  it("masks percent-encoded credentials that no key-shape rule would catch", () => {
    // Deliberately opaque: matches no vendor prefix, no JWT header, no AWS or
    // Google shape. Only the separator handling can redact this.
    const opaque = "A1b2C3d4E5f6G7h8I9j0";
    expect(
      scrubSecretMaterial(`https://api.x/cb?h=Authorization%3A%20Bearer%20${opaque}`),
    ).not.toContain(opaque);
    expect(scrubSecretMaterial(`/cb#Bearer%20${opaque}`)).not.toContain(opaque);
    expect(scrubSecretMaterial(`x?a=Basic%20${opaque}`)).not.toContain(opaque);
    expect(scrubSecretMaterial(`/cb?access_token%3D${opaque}&next=1`)).not.toContain(opaque);
    // The surviving text still tells the operator which header was involved.
    expect(scrubSecretMaterial(`/cb?access_token%3D${opaque}&next=1`)).toContain("next=1");
  });

  // Third regression on the SAME defect. Round 1 put `\b` on the Bearer rule;
  // round 2 removed it there and widened that rule's separators — and left the
  // identical `\b` on the key-name, JWT, family, AKIA and ya29 rules, where it
  // fails for the identical reason. Every percent-triplet ends in an
  // alphanumeric, so `\b` cannot match a credential preceded by an encoded
  // separator. These fixtures are DOUBLY encoded (`%3F`/`%26`/`%22` before the
  // key name), which the `?`-prefixed fixtures above structurally cannot reach.
  it("masks credentials preceded by a percent-encoded separator", () => {
    const opaque = "A1b2C3d4E5f6G7h8I9j0";
    const encoded = [
      `redirect_uri=https%3A%2F%2Fx.io%2Fcb%3Faccess_token%3D${opaque}`,
      `https://x/cb?a=1%26access_token%3D${opaque}`,
      `body=%7B%22access_token%22%3A%22${opaque}%22%7D`,
    ];
    for (const input of encoded) expect(scrubSecretMaterial(input)).not.toContain(opaque);

    // Same anchor, the other four shapes that carried it.
    expect(scrubSecretMaterial("r=%3FeyJhbGciOiJIUzI1NiIs.abcdefghij")).not.toContain("eyJhbGci");
    expect(scrubSecretMaterial("u=x%26ghp_A1b2C3d4E5f6G7h8")).not.toContain("ghp_A1b2");
    expect(scrubSecretMaterial("p=1%26AKIA1234567890ABCD")).not.toContain("AKIA1234567890ABCD");
    expect(scrubSecretMaterial("r=%2Fcb%3Fya29.aBcDeFgHiJkL")).not.toContain("ya29.aBcDeFgHiJkL");
  });

  // The token class admits `%` so an encoded base64 credential is masked whole:
  // without it, masking stopped at the first `%2B` and shipped the rest.
  it("masks a percent-encoded base64 bearer to its end", () => {
    expect(scrubSecretMaterial("Bearer%20abc%2Bdef%3Dghi")).toBe("Bearer [redacted]");
  });

  // Fourth regression on the anchor, from the other side. `CRED_START`
  // excludes `_` on the left, so a keyword glued to an UNDERSCORE never
  // matched — and `FOO_TOKEN=` is the dominant shape on the paths this
  // scrubber was just routed through: docker's `--env-file` diagnostics quote
  // back `NAME=value` lines and runner stderr prints env names, both landing
  // in `failed[].error` on the UNAUTHENTICATED `GET /integrations/boot-report`.
  it("masks a keyword preceded by an underscore (FOO_TOKEN=…)", () => {
    expect(scrubSecretMaterial("NOTION_TOKEN=ntn_9fJ2kQwErTyUiOpAsDfGhJk")).not.toContain(
      "ntn_9fJ2kQwErTyUiOpAsDfGhJk",
    );
    expect(scrubSecretMaterial("no variable name on line 'GCP_SECRET=hunter2'")).not.toContain(
      "hunter2",
    );
    expect(scrubSecretMaterial("STRIPE_API_KEY=rk_live_0123456789")).not.toContain(
      "rk_live_0123456789",
    );
  });

  // URL userinfo is a credential channel of its own: `git`-style remotes and
  // proxy URLs carry it, and no keyword/prefix rule sees it.
  it("masks URL userinfo", () => {
    expect(scrubSecretMaterial("https://user:hunter2@host/path")).not.toContain("hunter2");
    expect(scrubSecretMaterial("clone http://x-token:s3cr3tvalue@github.com/o/r")).not.toContain(
      "s3cr3tvalue",
    );
    // The rest of the URL survives — it is what an operator diagnoses with.
    expect(scrubSecretMaterial("https://user:hunter2@host/path")).toContain("host/path");
    // An `@` in a path is not userinfo.
    expect(scrubSecretMaterial("https://host/users/me@example.com")).toBe(
      "https://host/users/me@example.com",
    );
  });

  it("leaves prose that merely starts with a key prefix alone", () => {
    expect(scrubSecretMaterial("found skeletons in pkgroots directory")).toBe(
      "found skeletons in pkgroots directory",
    );
    // CRED_START must stay exactly as strict as the `\b` it replaced on the
    // left-hand side: a key shape glued to a preceding word is still prose.
    expect(scrubSecretMaterial("risk-averse and disk-usage notes")).toBe(
      "risk-averse and disk-usage notes",
    );
    // `mytoken=` is preceded by `y`, not a boundary — still prose. Admitting
    // `_` on the keyword rule must not admit an alphanumeric too.
    expect(scrubSecretMaterial("the mytoken=abc case")).toBe("the mytoken=abc case");
    expect(scrubSecretMaterial("mypassword=abc and 9secret=z")).toBe(
      "mypassword=abc and 9secret=z",
    );
  });

  // Fifth regression on the same anchor, and the one that matters most on the
  // sink these rules were routed to. Admitting `_` on the LEFT of the keyword
  // only covers env names whose LAST segment is the keyword (`NOTION_TOKEN`).
  // The separator group after the keyword does not admit `_`, so every name
  // with a segment AFTER the keyword — `AWS_SECRET_ACCESS_KEY`, the single most
  // canonical `delivery.env` name there is, and `CLIENT_SECRET_ID` — shipped
  // its value verbatim into `failed[].error` on the UNAUTHENTICATED
  // `GET /integrations/boot-report`.
  it("masks a keyword that is an INFIX of an env-var name (AWS_SECRET_ACCESS_KEY=…)", () => {
    expect(scrubSecretMaterial("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY")).toBe(
      "AWS_SECRET_ACCESS_KEY=[redacted]",
    );
    expect(scrubSecretMaterial("CLIENT_SECRET_ID=zzz111")).toBe("CLIENT_SECRET_ID=[redacted]");
    // Bare `KEY` as an env-name segment: the literal name the docker-spawn
    // suite uses for a `delivery.env` credential.
    expect(scrubSecretMaterial("GCP_KEY=hunter2secret")).toBe("GCP_KEY=[redacted]");
    expect(scrubSecretMaterial("PRIVATE_KEY=abc123def")).toBe("PRIVATE_KEY=[redacted]");
    // The env NAME survives — it is what tells the operator which credential
    // the container failed to boot with.
    expect(scrubSecretMaterial("env-file line 1: AWS_SECRET_ACCESS_KEY=wJalrXUtnFE")).toContain(
      "AWS_SECRET_ACCESS_KEY",
    );
  });

  it("control: `key` on its own is prose, not an env-var name", () => {
    // The widening is to env-var NAMES, not to the bare word. `key` appears in
    // every second error string an operator reads; redacting the word after it
    // would cost more legibility than it buys. It only counts when glued into
    // an underscore-joined name.
    expect(scrubSecretMaterial("key ghp_ABCdef123456789")).toBe("key [redacted-key]");
    expect(scrubSecretMaterial("no api key provided")).toBe("no api key provided");
    expect(scrubSecretMaterial("monkey_bars=up")).toBe("monkey_bars=up");
    // And the left-anchor stays exactly as strict as before for the infix form.
    expect(scrubSecretMaterial("mysecretstuff=abc")).toBe("mysecretstuff=abc");
  });

  // The userinfo rule shipped blind to the percent-encoded form the rest of
  // this file exists to handle: `redirect_uri=` values are encoded by
  // definition, and an encoded `user:pass@host` is exactly the shape an OAuth
  // error body echoes back.
  it("masks percent-encoded URL userinfo", () => {
    const out = scrubSecretMaterial("redirect_uri=https%3A%2F%2Fuser%3Ahunter2%40host%2Fcb");
    expect(out).not.toContain("hunter2");
    // The host survives — same trade as the literal form.
    expect(out).toContain("host%2Fcb");
  });

  // …and too broad in the other direction: the negated class stopped only at
  // `/?#` and whitespace, so a comma between two unrelated URLs let the match
  // run from the first authority to an `@` in the second, swallowing the host
  // the operator diagnoses with.
  it("control: a comma is not authority-legal, so a bare host keeps its name", () => {
    expect(scrubSecretMaterial("see https://docs.example.com,contact:admin@example.com")).toBe(
      "see https://docs.example.com,contact:admin@example.com",
    );
    // Same shape with whitespace, which the old class already refused.
    expect(scrubSecretMaterial("see https://docs.example.com then admin@example.com")).toBe(
      "see https://docs.example.com then admin@example.com",
    );
  });

  // The ENCODED rule shipped in the same commit as the fix above and
  // reproduced, verbatim, the defect that fix had just closed: its tempering
  // named three delimiters (`%2F`, `%3F`, `%23`) and every OTHER encoded
  // delimiter decomposes into bytes (`%`, `2`, `C`) the byte class admitted one
  // at a time. Both renderings of an authority now share one exclusion list.
  it("control: an ENCODED delimiter ends the encoded authority too", () => {
    for (const sep of ["%2C", "%20", "%22", "%26", "%27x%2C"]) {
      const input = `see https%3A%2F%2Fdocs.example.com${sep}contact%3Aadmin%40example.com`;
      expect(scrubSecretMaterial(input)).toBe(input);
    }
    // The host an operator diagnoses with survives in full — the exact bytes
    // the shipped rule destroyed while masking nothing sensitive.
    expect(
      scrubSecretMaterial("see https%3A%2F%2Fdocs.example.com%2Ccontact%3Aadmin%40example.com"),
    ).toContain("docs.example.com");
  });

  // The narrowing that fixed the comma replaced a negated class with a
  // POSITIVE one and dropped eight RFC 3986 §3.2.1 sub-delims that have
  // nothing to do with the comma problem. Every one of them is a byte a real
  // DSN password carries, and every password below shipped verbatim.
  it("masks a DSN password built from RFC 3986 sub-delims", () => {
    for (const pw of [
      "s3cr3t!x",
      "pa$$w0rd",
      "p(ass)",
      "x'y",
      "pass=word",
      "a;b*c",
      "p!a$s'w(o)r*d;=x",
    ]) {
      const out = scrubSecretMaterial(`postgres://user:${pw}@db.internal:5432/app`);
      expect(out).toBe("postgres://[redacted]@db.internal:5432/app");
    }
    // A masked proxy URL still reads as one — `*` is authority-legal.
    expect(scrubSecretMaterial("http://user:****@us-proxy.example.com:8080")).toBe(
      "http://[redacted]@us-proxy.example.com:8080",
    );
  });

  // Control for the rule above: admitting the sub-delims must NOT re-admit the
  // three bytes the comma fix excluded, or the fix is undone.
  it('control: sub-delims are back but `,`, `&`, `"` and whitespace are not', () => {
    for (const sep of [",", "&", '"', " "]) {
      const input = `see https://docs.example.com${sep}contact:admin@example.com`;
      expect(scrubSecretMaterial(input)).toBe(input);
    }
  });

  // The keyword rule's separator group accepted bare whitespace, so
  // `<NAME> <word>` redacted `<word>` — including in the sidecar's OWN
  // user-visible errors. This exact string is thrown by `server.ts`, caught
  // three lines down, scrubbed, and written to stdout as
  // `APPSTRATE_CONNECT_ERROR:`, which the platform stores and shows the user.
  // The one word carrying the diagnosis was the one destroyed.
  it("control: an env-name-shaped keyword does not eat the next word of prose", () => {
    for (const line of [
      "connect-run: CONNECT_RESULT_KEY missing — refusing to emit bundle",
      "connect-run: CONNECT_RESULT_KEY must decode to 32 bytes (AES-256 key)",
      "missing required field: api_key_id in manifest",
      "Integration auth refresh skipped — no token_endpoint and no issuer",
      "auth_key must match ^[a-z][a-z0-9_]*$",
      "primary_key_violation on table runs",
      "Restore the CONNECTION_ENCRYPTION_KEY this deployment booted with",
    ]) {
      expect(scrubSecretMaterial(line)).toBe(line);
    }
  });

  // Second half of the same fix: an assignment separator alone does not reach
  // the lower_snake FIELD names that share the env-name shape, because they DO
  // carry an assignment. The env-name tier is uppercase-only for that reason.
  it("control: lower_snake field names are not env-var names", () => {
    for (const line of [
      'token_endpoint_auth_method: "none"',
      "token_endpoint_auth_method='none'",
      'refresh_token_issuance: "not_supported"',
      "authorization_endpoint + token_endpoint for marketplace connect",
    ]) {
      expect(scrubSecretMaterial(line)).toBe(line);
    }
    // …while the SCREAMING_SNAKE twin of the same shape is still masked, and a
    // lowercase name whose LAST segment is a keyword stays covered by the bare
    // keyword tier.
    expect(scrubSecretMaterial("TOKEN_ENDPOINT_AUTH_METHOD='none'")).toBe(
      "TOKEN_ENDPOINT_AUTH_METHOD='[redacted]'",
    );
    expect(scrubSecretMaterial("notion_token=ntn_9fJ2kQwErTyUiOpAsDfGhJk")).toBe(
      "notion_token=[redacted]",
    );
  });

  // The separator change must not cost the shapes that DO carry a credential:
  // all three real leak forms use an assignment character.
  it("keeps every assignment-separated leak shape masked", () => {
    expect(scrubSecretMaterial("AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMIK7MDENGbPxRfiCY")).toBe(
      "AWS_SECRET_ACCESS_KEY = [redacted]",
    );
    expect(scrubSecretMaterial('{"token": "abc123def456"}')).toBe('{"token": "[redacted]"}');
    expect(scrubSecretMaterial("KEY_FILE=/etc/secrets/id_rsa")).toBe("KEY_FILE=[redacted]");
  });
});
