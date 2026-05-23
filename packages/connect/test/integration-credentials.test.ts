// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the multi-auth integration credential resolver. All
 * test inputs are pure data; no DB or network involved.
 */

import { describe, it, expect } from "bun:test";
import { resolveHttpDelivery } from "../src/integration-credentials.ts";

describe("resolveHttpDelivery — defaults per auth type", () => {
  it("oauth2 → Authorization: Bearer <accessToken>", () => {
    const plan = resolveHttpDelivery("oauth2", { access_token: "tok" }, {});
    expect(plan).toEqual({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      value: "tok",
      allowServerOverride: false,
    });
  });

  it("api_key → X-Api-Key: <apiKey>", () => {
    const plan = resolveHttpDelivery("api_key", { api_key: "k" }, {});
    expect(plan).toEqual({
      headerName: "X-Api-Key",
      headerPrefix: "",
      value: "k",
      allowServerOverride: false,
    });
  });

  it("basic → Authorization: Basic <base64(user:pass)>", () => {
    const plan = resolveHttpDelivery("basic", { username: "u", password: "p" }, {});
    expect(plan!.headerName).toBe("Authorization");
    expect(plan!.headerPrefix).toBe("Basic ");
    expect(plan!.value).toBe(Buffer.from("u:p", "utf8").toString("base64"));
  });

  it("custom with no http config → null (proxy injects nothing)", () => {
    const plan = resolveHttpDelivery("custom", {}, {});
    expect(plan).toBeNull();
  });
});

describe("resolveHttpDelivery — explicit overrides", () => {
  it("respects explicit headerName / headerPrefix / valueFrom", () => {
    const plan = resolveHttpDelivery(
      "oauth2",
      { access_token: "tok" },
      { headerName: "X-Token", headerPrefix: "Token ", valueFrom: "access_token" },
    );
    expect(plan).toEqual({
      headerName: "X-Token",
      headerPrefix: "Token ",
      value: "tok",
      allowServerOverride: false,
    });
  });

  it("renders template valueFrom with {{var}} substitution and base64 encoding", () => {
    const plan = resolveHttpDelivery(
      "api_key",
      { email: "pierre@example.com", api_token: "abc123" },
      {
        valueFrom: { template: "{{email}}/token:{{api_token}}", encoding: "base64" },
      },
    );
    expect(plan!.value).toBe(
      Buffer.from("pierre@example.com/token:abc123", "utf8").toString("base64"),
    );
  });

  it("template with missing placeholder renders empty for that ref (not the literal)", () => {
    const plan = resolveHttpDelivery(
      "api_key",
      { email: "pierre@example.com" },
      { valueFrom: { template: "{{email}}/{{api_token}}" } },
    );
    expect(plan!.value).toBe("pierre@example.com/");
  });

  it("allowServerOverride flag is reflected in the plan", () => {
    const plan = resolveHttpDelivery(
      "oauth2",
      { access_token: "tok" },
      { allowServerOverride: true },
    );
    expect(plan!.allowServerOverride).toBe(true);
  });
});
