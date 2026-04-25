// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-logic tests for the actor ↔ persistence-scope helpers introduced
 * by ADR-011 (unified checkpoint + memory). These exercise the boundary
 * translation only — DB-touching reads/writes are integration-level and
 * live under `apps/api/test/integration`.
 */

import { describe, it, expect } from "bun:test";
import {
  scopeFromRunContext,
  scopeFromActor,
} from "../../src/services/state/package-persistence.ts";

describe("scopeFromRunContext", () => {
  it("end-user wins over dashboard user (impersonation precedence)", () => {
    const scope = scopeFromRunContext({ userId: "user-1", endUserId: "eu-1" });
    expect(scope).toEqual({ type: "end_user", id: "eu-1" });
  });

  it("dashboard user when no end-user present", () => {
    const scope = scopeFromRunContext({ userId: "user-7", endUserId: null });
    expect(scope).toEqual({ type: "member", id: "user-7" });
  });

  it("falls back to shared when both fields are null (scheduled / system run)", () => {
    const scope = scopeFromRunContext({ userId: null, endUserId: null });
    expect(scope).toEqual({ type: "shared" });
  });

  it("falls back to shared when both fields are undefined", () => {
    const scope = scopeFromRunContext({});
    expect(scope).toEqual({ type: "shared" });
  });
});

describe("scopeFromActor", () => {
  it("null actor → shared (scheduler / system convergence path)", () => {
    expect(scopeFromActor(null)).toEqual({ type: "shared" });
  });

  it("member actor passes through", () => {
    expect(scopeFromActor({ type: "member", id: "user-9" })).toEqual({
      type: "member",
      id: "user-9",
    });
  });

  it("end_user actor passes through", () => {
    expect(scopeFromActor({ type: "end_user", id: "eu-9" })).toEqual({
      type: "end_user",
      id: "eu-9",
    });
  });
});
