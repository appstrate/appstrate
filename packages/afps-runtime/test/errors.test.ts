// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  AfpsRuntimeError,
  CredentialResolutionError,
  ProviderAuthorizationError,
  ResolverError,
  RunCancelledError,
  RunHistoryError,
  RunTimeoutError,
  WorkloadExitError,
  isAfpsError,
  toProblem,
} from "../src/errors.ts";
import { BundleError } from "../src/bundle/errors.ts";
import { BundleSignaturePolicyError } from "../src/bundle/signature-policy.ts";
import { AfpsEntrypointError } from "../src/bundle/tool-entrypoint.ts";

describe("AfpsRuntimeError taxonomy", () => {
  it("each typed error exposes a stable code + name", () => {
    expect(new RunCancelledError("x").code).toBe("RUN_CANCELLED");
    expect(new RunCancelledError("x").name).toBe("RunCancelledError");

    expect(new WorkloadExitError("docker", 137).code).toBe("WORKLOAD_EXIT_NONZERO");
    expect(new WorkloadExitError("docker", 137).name).toBe("WorkloadExitError");

    expect(new RunTimeoutError("timed out").code).toBe("RUN_TIMEOUT");
    expect(new RunTimeoutError("timed out").name).toBe("RunTimeoutError");

    expect(new ProviderAuthorizationError("PROVIDER_AUTHORIZED_URIS_EMPTY", "x").code).toBe(
      "PROVIDER_AUTHORIZED_URIS_EMPTY",
    );

    expect(new ResolverError("RESOLVER_INVALID_TOOL_SHAPE", "x").code).toBe(
      "RESOLVER_INVALID_TOOL_SHAPE",
    );

    expect(new RunHistoryError("RUN_HISTORY_TIMEOUT", "x").code).toBe("RUN_HISTORY_TIMEOUT");
    expect(new CredentialResolutionError("x").code).toBe("CREDENTIAL_RESOLUTION");
  });

  it("WorkloadExitError carries exitCode + adapterName + lastError", () => {
    const err = new WorkloadExitError("docker", 137, "OOM killed");
    expect(err.exitCode).toBe(137);
    expect(err.adapterName).toBe("docker");
    expect(err.message).toBe("OOM killed");
    expect(err.details).toEqual({ adapterName: "docker", exitCode: 137, lastError: "OOM killed" });
  });

  it("WorkloadExitError synthesises a default message when no lastError", () => {
    const err = new WorkloadExitError("docker", 1);
    expect(err.message).toBe("docker workload exited with code 1");
    expect(err.details).toEqual({ adapterName: "docker", exitCode: 1 });
  });

  it("ProviderAuthorizationError preserves the security-relevant target + provider in details", () => {
    const err = new ProviderAuthorizationError("PROVIDER_AUTHORIZED_URIS_MISMATCH", "rejected", {
      provider: "@appstrate/gmail",
      target: "https://evil.com/",
    });
    expect(err.details).toEqual({ provider: "@appstrate/gmail", target: "https://evil.com/" });
  });
});

describe("isAfpsError marker", () => {
  it("is true for every typed error in the package", () => {
    expect(isAfpsError(new RunCancelledError("x"))).toBe(true);
    expect(isAfpsError(new WorkloadExitError("d", 1))).toBe(true);
    expect(isAfpsError(new RunTimeoutError("x"))).toBe(true);
    expect(isAfpsError(new ProviderAuthorizationError("PROVIDER_AUTHORIZED_URIS_EMPTY", "x"))).toBe(
      true,
    );
    expect(isAfpsError(new ResolverError("RESOLVER_INVALID_TOOL_SHAPE", "x"))).toBe(true);
    expect(isAfpsError(new RunHistoryError("RUN_HISTORY_FETCH_FAILED", "x"))).toBe(true);
    expect(isAfpsError(new CredentialResolutionError("x"))).toBe(true);
    expect(isAfpsError(new BundleError("INTEGRITY_MISMATCH", "x"))).toBe(true);
    expect(isAfpsError(new BundleSignaturePolicyError("signature_invalid", "x"))).toBe(true);
    expect(isAfpsError(new AfpsEntrypointError("MISSING", "x"))).toBe(true);
  });

  it("is false for plain Error / non-Error values", () => {
    expect(isAfpsError(new Error("plain"))).toBe(false);
    expect(isAfpsError("string")).toBe(false);
    expect(isAfpsError(null)).toBe(false);
    expect(isAfpsError(undefined)).toBe(false);
    expect(isAfpsError({ code: "x" })).toBe(false);
  });
});

describe("toProblem (RFC 9457)", () => {
  it("emits problem+json from typed errors with code in the type URI", () => {
    const err = new ProviderAuthorizationError("PROVIDER_AUTHORIZED_URIS_MISMATCH", "rejected", {
      provider: "@appstrate/gmail",
      target: "https://evil.com/",
    });
    const problem = toProblem(err);
    expect(problem.code).toBe("PROVIDER_AUTHORIZED_URIS_MISMATCH");
    expect(problem.type).toBe("https://errors.appstrate.dev/PROVIDER_AUTHORIZED_URIS_MISMATCH");
    expect(problem.title).toBe("ProviderAuthorizationError");
    expect(problem.status).toBe(422);
    expect(problem.detail).toBe("rejected");
    expect(problem.errors).toEqual({ provider: "@appstrate/gmail", target: "https://evil.com/" });
  });

  it("respects fallback overrides", () => {
    const err = new RunCancelledError("aborted");
    const problem = toProblem(err, { type: "x", title: "y", status: 409 });
    expect(problem.type).toBe("x");
    expect(problem.title).toBe("y");
    expect(problem.status).toBe(409);
  });

  it("falls back to a 500 envelope for plain Error", () => {
    const problem = toProblem(new Error("boom"));
    expect(problem.type).toBe("about:blank");
    expect(problem.status).toBe(500);
    expect(problem.detail).toBe("boom");
    expect(problem.code).toBeUndefined();
  });

  it("falls back to a 500 envelope for non-Error values", () => {
    const problem = toProblem("string error");
    expect(problem.detail).toBe("string error");
    expect(problem.status).toBe(500);
  });
});

describe("AfpsRuntimeError abstract base", () => {
  it("forwards ErrorOptions.cause", () => {
    class MyErr extends AfpsRuntimeError {
      readonly code = "RUN_CANCELLED" as const;
    }
    const root = new Error("root");
    const wrapped = new MyErr("wrapped", undefined, { cause: root });
    expect(wrapped.cause).toBe(root);
  });

  it("omits details when not provided", () => {
    class MyErr extends AfpsRuntimeError {
      readonly code = "RUN_CANCELLED" as const;
    }
    expect(new MyErr("x").details).toBeUndefined();
  });
});
