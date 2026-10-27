// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared credential-proxy primitives.
 * These must match the behaviour both the credential-proxy route and
 * the in-container sidecar rely on — any change here affects both
 * entrypoints simultaneously.
 */

import { describe, it, expect } from "bun:test";
import {
  buildInjectedCredentialHeader,
  applyInjectedCredentialHeader,
  applyInjectedCredentialHeaderToHeaders,
  credentialCarryingHeader,
} from "../src/proxy-primitives.ts";
import { InvalidHeaderValueError } from "@appstrate/afps-shared/delivery-http";

describe("buildInjectedCredentialHeader", () => {
  it("builds `Bearer <token>` when prefix is set", () => {
    const out = buildInjectedCredentialHeader({
      credentials: { access_token: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer ",
      credentialFieldName: "access_token",
    });
    expect(out).toEqual({ name: "Authorization", value: "Bearer abc" });
  });

  it("keeps a composite Authorization prefix literal", () => {
    const out = buildInjectedCredentialHeader({
      credentials: { api_key: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Token token=",
      credentialFieldName: "api_key",
    });
    expect(out).toEqual({ name: "Authorization", value: "Token token=abc" });
  });

  it("omits the space when no prefix", () => {
    const out = buildInjectedCredentialHeader({
      credentials: { api_key: "secret" },
      credentialHeaderName: "X-Api-Key",
      credentialFieldName: "api_key",
    });
    expect(out).toEqual({ name: "X-Api-Key", value: "secret" });
  });

  it("returns undefined when header name is absent (no injection)", () => {
    expect(
      buildInjectedCredentialHeader({
        credentials: { access_token: "abc" },
        credentialFieldName: "access_token",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the referenced field is empty", () => {
    expect(
      buildInjectedCredentialHeader({
        credentials: { access_token: "" },
        credentialHeaderName: "Authorization",
        credentialFieldName: "access_token",
      }),
    ).toBeUndefined();
  });
});

describe("applyInjectedCredentialHeader (record)", () => {
  it("adds the header when absent", () => {
    const headers: Record<string, string> = {};
    applyInjectedCredentialHeader(headers, {
      credentials: { access_token: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer ",
      credentialFieldName: "access_token",
    });
    expect(headers).toEqual({ Authorization: "Bearer abc" });
  });

  it("replaces a case-insensitive caller header by default", () => {
    const headers: Record<string, string> = { authorization: "Bearer caller" };
    applyInjectedCredentialHeader(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer ",
      credentialFieldName: "access_token",
    });
    expect(headers).toEqual({ Authorization: "Bearer server" });
  });

  it("respects a case-insensitive caller override when explicitly allowed", () => {
    const headers: Record<string, string> = { authorization: "Bearer caller" };
    const decision = applyInjectedCredentialHeader(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer ",
      credentialAllowServerOverride: true,
      credentialFieldName: "access_token",
    });
    expect(headers).toEqual({ authorization: "Bearer caller" });
    expect(decision).toEqual({ kind: "caller_override", headerName: "Authorization" });
  });

  it("identifies an allowed caller override when the platform field is empty", () => {
    const headers: Record<string, string> = { "x-api-key": "caller" };
    const decision = applyInjectedCredentialHeader(headers, {
      credentials: { api_key: "" },
      credentialHeaderName: "X-Api-Key",
      credentialAllowServerOverride: true,
      credentialFieldName: "api_key",
    });
    expect(headers).toEqual({ "x-api-key": "caller" });
    expect(decision).toEqual({ kind: "caller_override", headerName: "X-Api-Key" });
  });
});

describe("credentialCarryingHeader", () => {
  const creds = {
    credentials: { access_token: "server" },
    credentialHeaderName: "X-Token",
    credentialFieldName: "access_token",
  };

  it("names the injected header, or the caller's allowed override, never a no-op", () => {
    expect(credentialCarryingHeader(applyInjectedCredentialHeader({}, creds))).toBe("X-Token");
    const override = applyInjectedCredentialHeader(
      { "x-token": "caller" },
      { ...creds, credentialAllowServerOverride: true },
    );
    expect(credentialCarryingHeader(override)).toBe("X-Token");
    const none = applyInjectedCredentialHeader({}, { ...creds, credentialHeaderName: undefined });
    expect(credentialCarryingHeader(none)).toBeUndefined();
  });
});

describe("applyInjectedCredentialHeaderToHeaders (Headers instance)", () => {
  it("adds the header when absent", () => {
    const headers = new Headers();
    applyInjectedCredentialHeaderToHeaders(headers, {
      credentials: { access_token: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer ",
      credentialFieldName: "access_token",
    });
    expect(headers.get("authorization")).toBe("Bearer abc");
  });

  it("replaces a case-insensitive caller header by default", () => {
    const headers = new Headers({ Authorization: "Bearer caller" });
    applyInjectedCredentialHeaderToHeaders(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer ",
      credentialFieldName: "access_token",
    });
    expect(headers.get("authorization")).toBe("Bearer server");
  });

  it("respects a case-insensitive caller override when explicitly allowed", () => {
    const headers = new Headers({ Authorization: "Bearer caller" });
    const decision = applyInjectedCredentialHeaderToHeaders(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer ",
      credentialAllowServerOverride: true,
      credentialFieldName: "access_token",
    });
    expect(headers.get("authorization")).toBe("Bearer caller");
    expect(decision).toEqual({ kind: "caller_override", headerName: "Authorization" });
  });
});

describe("injecting a credential that is no HTTP field value", () => {
  const secret = "SECRETKEY";
  const creds = (value: string) => ({
    credentials: { api_key: value },
    credentialHeaderName: "X-Api-Key",
    credentialHeaderPrefix: "",
    credentialFieldName: "api_key",
  });

  // Bun's `Headers` TypeError quotes the value: the injector refuses before it can be raised.
  it("throws an error naming the header, never the value", () => {
    for (const value of [`${secret}\r\nX-Evil: 1`, `${secret}\u20ac`, `${secret}\u0000`]) {
      for (const inject of [
        () => applyInjectedCredentialHeaderToHeaders(new Headers(), creds(value)),
        () => applyInjectedCredentialHeader({}, creds(value)),
      ]) {
        let caught: unknown;
        try {
          inject();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(InvalidHeaderValueError);
        expect((caught as Error).message).not.toContain(secret);
      }
    }
  });
});
