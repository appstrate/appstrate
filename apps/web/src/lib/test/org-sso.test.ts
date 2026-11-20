// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  EMERGENCY_SIGN_IN_QUERY,
  enforcementBlocker,
  errorCallbackURL,
  isSsoRefusal,
  socialCallbackError,
  ssoDomainBody,
  ssoJoinRoleBody,
  ssoLinkTenantBody,
  type SsoDomain,
  type SsoSettings,
} from "../org-sso";

function domain(overrides: Partial<SsoDomain> = {}): SsoDomain {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    domain: "example.com",
    verified: false,
    verified_at: null,
    txt_record_name: "_appstrate.example.com",
    txt_record_value: "appstrate-domain-verification=abc",
    createdAt: "2026-11-13T00:00:00.000Z",
    ...overrides,
  };
}

function settings(overrides: Partial<SsoSettings> = {}): SsoSettings {
  return {
    tenant_id: "tid-org",
    tenant_linked_at: "2026-11-13T00:00:00.000Z",
    join_role: "member",
    enforced: false,
    enforced_at: null,
    caller_tenant_id: "tid-org",
    domains: [domain({ verified: true })],
    ...overrides,
  };
}

describe("request pieces", () => {
  it("sends the domain as typed, without the blanks of a paste", () => {
    expect(ssoDomainBody("  Example.COM \n")).toEqual({ domain: "Example.COM" });
  });

  it("sends the join role under its wire name", () => {
    expect(ssoJoinRoleBody("guest")).toEqual({ join_role: "guest" });
    expect(ssoLinkTenantBody(false)).toEqual({});
    expect(ssoLinkTenantBody(true)).toEqual({ replace: true });
  });

  it("asks for the emergency sign-in with emergency=1", () => {
    expect(new URLSearchParams(EMERGENCY_SIGN_IN_QUERY).toString()).toBe("emergency=1");
  });
});

describe("enforcementBlocker", () => {
  it("opens the enforcement once tenant, verified domain and session agree", () => {
    expect(enforcementBlocker(settings())).toBeNull();
  });

  it("names the first missing step, in the order the owner fixes them", () => {
    expect(enforcementBlocker(settings({ tenant_id: null, domains: [] }))).toBe("no_tenant");
    expect(enforcementBlocker(settings({ domains: [domain()] }))).toBe("no_verified_domain");
    expect(enforcementBlocker(settings({ caller_tenant_id: null }))).toBe("other_session");
    expect(enforcementBlocker(settings({ caller_tenant_id: "tid-other" }))).toBe("other_session");
  });
});

describe("social callback errors", () => {
  it("reads the code a refused callback came back with", () => {
    expect(socialCallbackError("?error=sso_required")).toBe("sso_required");
    expect(socialCallbackError("?redirect=%2Fruns")).toBeNull();
  });

  it("leaves a verification link's errors to the page that asked for it", () => {
    expect(socialCallbackError("?error=INVALID_TOKEN")).toBeNull();
  });

  it("knows the organization's sign-in refusals", () => {
    expect(isSsoRefusal("sso_required")).toBe(true);
    expect(isSsoRefusal("sso_tenant_mismatch")).toBe(true);
    expect(isSsoRefusal("access_denied")).toBe(false);
    expect(isSsoRefusal(null)).toBe(false);
  });

  it("returns to the same page without the previous error", () => {
    expect(errorCallbackURL("/login", "?redirect=%2Fruns&error=sso_required")).toBe(
      "/login?redirect=%2Fruns",
    );
    expect(errorCallbackURL("/login", "?error=x&error_description=y")).toBe("/login");
  });
});
