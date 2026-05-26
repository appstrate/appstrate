// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the AFPS 2.0 `delivery.http` resolver (snake_case,
 * `{$credential.<field>}` value templates). Pure data; no DB/network.
 */

import { describe, it, expect } from "bun:test";
import { resolveAfpsHttpDelivery } from "../src/afps-delivery.ts";

describe("resolveAfpsHttpDelivery — defaults per auth type", () => {
  it("oauth2 → Authorization: Bearer <access_token> via template default", () => {
    const plan = resolveAfpsHttpDelivery("oauth2", { access_token: "tok" }, undefined);
    expect(plan).toEqual({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      value: "tok",
      allowServerOverride: false,
    });
  });

  it("api_key → X-Api-Key: <api_key>", () => {
    const plan = resolveAfpsHttpDelivery("api_key", { api_key: "k" }, undefined);
    expect(plan).toEqual({
      headerName: "X-Api-Key",
      headerPrefix: "",
      value: "k",
      allowServerOverride: false,
    });
  });

  it("basic → Authorization: Basic <base64(user:pass)>", () => {
    const plan = resolveAfpsHttpDelivery("basic", { username: "u", password: "p" }, undefined);
    expect(plan!.headerName).toBe("Authorization");
    expect(plan!.headerPrefix).toBe("Basic ");
    expect(plan!.value).toBe(Buffer.from("u:p", "utf8").toString("base64"));
  });

  it("custom with no http declaration → null (proxy injects nothing)", () => {
    expect(resolveAfpsHttpDelivery("custom", {}, undefined)).toBeNull();
  });
});

describe("resolveAfpsHttpDelivery — value-template resolution", () => {
  it("resolves a {$credential.<field>} value template against the bag", () => {
    const plan = resolveAfpsHttpDelivery(
      "custom",
      { token: "abc123" },
      { in: "header", name: "X-Token", prefix: "T ", value: "{$credential.token}" },
    );
    expect(plan).toEqual({
      headerName: "X-Token",
      headerPrefix: "T ",
      value: "abc123",
      allowServerOverride: false,
    });
  });

  it("resolves a multi-ref template", () => {
    const plan = resolveAfpsHttpDelivery(
      "custom",
      { email: "pierre@example.com", api_token: "abc123" },
      { in: "header", name: "X-Auth", value: "{$credential.email}/{$credential.api_token}" },
    );
    expect(plan!.value).toBe("pierre@example.com/abc123");
  });

  it("renders a missing ref as empty (not the literal placeholder)", () => {
    const plan = resolveAfpsHttpDelivery(
      "custom",
      { email: "pierre@example.com" },
      { in: "header", name: "X-Auth", value: "{$credential.email}/{$credential.api_token}" },
    );
    expect(plan!.value).toBe("pierre@example.com/");
  });

  it("applies base64 encoding to the rendered value", () => {
    const plan = resolveAfpsHttpDelivery(
      "custom",
      { email: "pierre@example.com", api_token: "abc123" },
      {
        in: "header",
        name: "Authorization",
        value: "{$credential.email}/token:{$credential.api_token}",
        encoding: "base64",
      },
    );
    expect(plan!.value).toBe(
      Buffer.from("pierre@example.com/token:abc123", "utf8").toString("base64"),
    );
  });

  it("explicit name/prefix override the auth-type defaults", () => {
    const plan = resolveAfpsHttpDelivery(
      "oauth2",
      { access_token: "tok" },
      { in: "header", name: "X-Access", prefix: "Token " },
    );
    // value falls back to the oauth2 default template {$credential.access_token}.
    expect(plan).toEqual({
      headerName: "X-Access",
      headerPrefix: "Token ",
      value: "tok",
      allowServerOverride: false,
    });
  });

  it("reflects allow_server_override in the plan", () => {
    const plan = resolveAfpsHttpDelivery(
      "oauth2",
      { access_token: "tok" },
      { in: "header", allow_server_override: true },
    );
    expect(plan!.allowServerOverride).toBe(true);
  });

  it("returns null when an explicit declaration yields an empty header name", () => {
    const plan = resolveAfpsHttpDelivery("custom", { x: "y" }, { in: "header", name: "" });
    expect(plan).toBeNull();
  });

  it("custom auth with an explicit empty value template yields an empty value", () => {
    const plan = resolveAfpsHttpDelivery(
      "custom",
      {},
      { in: "header", name: "X-Empty", value: "" },
    );
    expect(plan).toEqual({
      headerName: "X-Empty",
      headerPrefix: "",
      value: "",
      allowServerOverride: false,
    });
  });

  it("Zendesk-style basic vendor pattern — prefix kept uncoded, value base64'd (§7.6)", () => {
    // §7.6 spec-text reads "applied to the rendered prefix+value before
    // placement", but the §7.6 commented example shows the output as
    // `Basic <base64(email/token:apikey)>` — prefix unencoded, value
    // base64'd. We resolve the ambiguity in favour of the example (matches
    // RFC 7617 HTTP Basic). This test pins that behaviour so a future
    // refactor doesn't silently flip the encoding scope.
    const plan = resolveAfpsHttpDelivery(
      "basic",
      { email: "alice@example.com", api_key: "ABC" },
      {
        in: "header",
        name: "Authorization",
        prefix: "Basic ",
        value: "{$credential.email}/token:{$credential.api_key}",
        encoding: "base64",
      },
    );
    expect(plan!.headerName).toBe("Authorization");
    expect(plan!.headerPrefix).toBe("Basic ");
    expect(plan!.value).toBe(Buffer.from("alice@example.com/token:ABC", "utf8").toString("base64"));
  });
});
