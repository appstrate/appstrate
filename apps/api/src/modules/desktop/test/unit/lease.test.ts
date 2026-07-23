// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  acquireDesktopLease,
  clearDesktopLeases,
  recordDesktopExposure,
  releaseDesktopLease,
  releaseDesktopLeaseByRun,
  DesktopExposureConflictError,
  DesktopLeaseConflictError,
} from "../../lease.ts";

afterEach(() => clearDesktopLeases());

describe("desktop run lease", () => {
  it("allows one run per user and rejects a concurrent run", () => {
    expect(acquireDesktopLease("u1", "r1")).toEqual({ requiresReset: false });
    expect(() => acquireDesktopLease("u1", "r2")).toThrow(DesktopLeaseConflictError);
  });

  it("requires a renderer reset when ownership changes", () => {
    acquireDesktopLease("u1", "r1");
    releaseDesktopLease("u1", "r1");
    expect(acquireDesktopLease("u1", "r2")).toEqual({ requiresReset: true });
  });

  it("returns the users released with a terminal run", () => {
    acquireDesktopLease("u1", "r1");
    acquireDesktopLease("u2", "r2");
    expect(releaseDesktopLeaseByRun("r1")).toEqual(["u1"]);
    expect(acquireDesktopLease("u1", "r3")).toEqual({ requiresReset: true });
    expect(() => acquireDesktopLease("u2", "r3")).toThrow(DesktopLeaseConflictError);
  });

  it("does not mix arbitrary evaluate and credential substitution", () => {
    acquireDesktopLease("u1", "r1");
    recordDesktopExposure("u1", "r1", "credential_substitution");
    expect(() => recordDesktopExposure("u1", "r1", "arbitrary_evaluate")).toThrow(
      DesktopExposureConflictError,
    );
  });
});
