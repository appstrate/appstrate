// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-logic tests for the actor → persistence-scope helper introduced
 * by ADR-011 (unified checkpoint + memory). These exercise the boundary
 * translation only — DB-touching reads/writes are integration-level and
 * live under `apps/api/test/integration`.
 */

import { describe, it, expect } from "bun:test";
import { scopeFromActor } from "../../src/services/state/package-persistence.ts";

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
