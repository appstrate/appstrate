// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, it, expect } from "bun:test";
import {
  ENFORCED_SESSION_MAX_AGE_MS,
  cappedRefresh,
  decideSession,
  type SessionOrigin,
} from "../../src/sso/policy.ts";
import type { DomainPolicy } from "../../src/sso/store.ts";

const TENANT = "11111111-2222-3333-4444-555555555555";
const now = new Date("2026-11-13T12:00:00Z");
const ADDRESS = "alice@corp.test";
const weekLater = new Date(now.getTime() + 7 * 24 * 3600_000);
const policy = (enforced: boolean): DomainPolicy => ({
  orgId: "org",
  domain: "corp.test",
  tenantId: TENANT,
  joinRole: "member",
  enforced,
});
const capped = new Date(now.getTime() + ENFORCED_SESSION_MAX_AGE_MS);

const OTHERS: SessionOrigin[] = [{ kind: "other" }];

describe("decideSession", () => {
  it("leaves an address of no bound domain alone", () => {
    expect(decideSession(null, { kind: "other" }, ADDRESS, weekLater, now)).toEqual({
      allow: true,
      expiresAt: weekLater,
    });
  });

  it("refuses another tenant whether or not the domain is enforced", () => {
    for (const enforced of [false, true]) {
      for (const tenantId of ["99999999-8888-7777-6666-555555555555", null]) {
        expect(
          decideSession(
            policy(enforced),
            { kind: "microsoft", tenantId, email: ADDRESS },
            ADDRESS,
            weekLater,
            now,
          ),
        ).toEqual({
          allow: false,
          code: "sso_tenant_mismatch",
        });
      }
    }
  });

  it("lets every method through on a linked, unenforced domain", () => {
    for (const origin of [
      ...OTHERS,
      { kind: "microsoft", tenantId: TENANT, email: ADDRESS } as const,
    ]) {
      expect(decideSession(policy(false), origin, ADDRESS, weekLater, now)).toEqual({
        allow: true,
        expiresAt: weekLater,
      });
    }
  });

  it("admits only the bound tenant and an owner's emergency sign-in once enforced, for 24 h", () => {
    for (const origin of [
      { kind: "microsoft", tenantId: TENANT, email: ADDRESS },
      { kind: "break_glass" },
    ] as const) {
      expect(decideSession(policy(true), origin, ADDRESS, weekLater, now)).toEqual({
        allow: true,
        expiresAt: capped,
      });
    }
    expect(decideSession(policy(true), { kind: "other" }, ADDRESS, weekLater, now)).toEqual({
      allow: false,
      code: "sso_required",
    });
  });

  it("keeps a shorter requested expiry", () => {
    const soon = new Date(now.getTime() + 3600_000);
    expect(decideSession(policy(true), { kind: "break_glass" }, ADDRESS, soon, now)).toEqual({
      allow: true,
      expiresAt: soon,
    });
  });

  it("gives a replacing session the deadline of the one it replaces", () => {
    const replacedCreatedAt = new Date(now.getTime() - 20 * 3600_000);
    expect(
      decideSession(policy(true), { kind: "rotation", replacedCreatedAt }, ADDRESS, weekLater, now),
    ).toEqual({
      allow: true,
      expiresAt: new Date(replacedCreatedAt.getTime() + ENFORCED_SESSION_MAX_AGE_MS),
      createdAt: replacedCreatedAt,
    });
  });
});

describe("a Microsoft identity speaks only for its own address", () => {
  it("refuses another member of the tenant, linked or enforced", () => {
    for (const enforced of [false, true]) {
      for (const email of ["mallory@corp.test", null]) {
        expect(
          decideSession(
            policy(enforced),
            { kind: "microsoft", tenantId: TENANT, email },
            ADDRESS,
            weekLater,
            now,
          ),
        ).toEqual({ allow: false, code: "sso_tenant_mismatch" });
      }
    }
  });

  it("compares addresses case-insensitively and by normalized domain", () => {
    const origin = { kind: "microsoft", tenantId: TENANT, email: "Alice@Corp.Test." } as const;
    expect(decideSession(policy(true), origin, ADDRESS, weekLater, now)).toEqual({
      allow: true,
      expiresAt: capped,
    });
  });
});

describe("cappedRefresh", () => {
  it("never writes an expiry past creation + 24 h", () => {
    const createdAt = new Date(now.getTime() - 3 * 3600_000);
    expect(cappedRefresh(createdAt, weekLater)).toEqual(
      new Date(createdAt.getTime() + ENFORCED_SESSION_MAX_AGE_MS),
    );
    const sooner = new Date(now.getTime() + 60_000);
    expect(cappedRefresh(createdAt, sooner)).toEqual(sooner);
  });
});
