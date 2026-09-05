// SPDX-License-Identifier: Apache-2.0

/**
 * `formatErrorChain` — the renderer that closes the gap left by threading
 * `{ cause }` through the codebase with nothing on the other end to print it.
 *
 * The first test here is the DEFECT WITNESS: it asserts the property that made
 * a formatter necessary at all, so if a future runtime starts building
 * cause-aware stacks, this file says so rather than the formatter quietly
 * becoming redundant.
 */

import { describe, it, expect } from "bun:test";
import { formatErrorChain, getErrorMessage } from "../src/errors.ts";
import { ApiError } from "../src/api-errors.ts";
import { BundlerError } from "../src/mcp-server-bundle/npm-vendor.ts";
import { PackageZipError } from "../src/zip.ts";

describe("the gap formatErrorChain closes", () => {
  it("does not appear in .stack — V8 builds it at construction", () => {
    // Delete-to-fail: remove this and `formatErrorChain` looks like a
    // convenience wrapper instead of the only renderer of the chain.
    const inner = new Error("INNER_SENTINEL");
    const outer = new Error("outer failed", { cause: inner });

    expect(outer.stack).toContain("outer failed");
    expect(outer.stack).not.toContain("INNER_SENTINEL");
    // …and the flattener every log site uses drops it too.
    expect(getErrorMessage(outer)).toBe("outer failed");
  });
});

describe("formatErrorChain", () => {
  it("is identical to getErrorMessage when there is no cause", () => {
    // Delete-to-fail: without this, widening the formatter's output (adding a
    // prefix, always bracketing) could silently reshape 194 existing log lines.
    const err = new Error("plain failure");
    expect(formatErrorChain(err)).toBe(getErrorMessage(err));
    expect(formatErrorChain("not an error")).toBe("not an error");
    expect(formatErrorChain(42)).toBe("42");
    expect(formatErrorChain(null)).toBe("null");
  });

  it("appends every cause in order", () => {
    // Delete-to-fail: this is the whole feature.
    const chained = new Error("could not import package", {
      cause: new Error("Failed to decompress ZIP artifact", {
        cause: new Error("invalid zip data"),
      }),
    });
    expect(formatErrorChain(chained)).toBe(
      "could not import package: Failed to decompress ZIP artifact: invalid zip data",
    );
  });

  it("renders a non-Error cause", () => {
    // A `cause` is typed `unknown` — a string or a rejected non-Error value
    // reaches here, and the walk must stop there rather than read `.cause`
    // off a primitive.
    expect(formatErrorChain(new Error("wrapper", { cause: "raw reason" }))).toBe(
      "wrapper: raw reason",
    );
  });

  it("terminates on a cyclic chain instead of hanging", () => {
    // Delete-to-fail: with the `seen` set removed this test never returns and
    // the suite times out — which is exactly the production symptom.
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    const out = formatErrorChain(b);
    expect(out).toBe("b: a: [circular cause]");
  });

  it("terminates on a self-referential chain", () => {
    const solo = new Error("solo");
    (solo as { cause?: unknown }).cause = solo;
    expect(formatErrorChain(solo)).toBe("solo: [circular cause]");
  });

  it("caps a deep chain and says that it did", () => {
    // Delete-to-fail: without the depth cap a 10 000-link chain writes a
    // 10 000-segment log line. The marker matters as much as the cap — a
    // silently truncated chain reads as a complete one.
    let err = new Error("depth-8");
    for (let i = 7; i >= 0; i--) err = new Error(`depth-${i}`, { cause: err });

    const out = formatErrorChain(err);
    expect(out).toBe(
      "depth-0: depth-1: depth-2: depth-3: depth-4: depth-5: [cause chain truncated]",
    );
    expect(out).not.toContain("depth-6");
  });
});

describe("custom Error classes carry a cause through construction", () => {
  // `preserve-caught-error` only inspects `throw new <builtin Error>`, so for
  // these the obligation is enforced by nothing but these assertions: each
  // class must ACCEPT a cause and each must leave it reachable.

  it("ApiError accepts a cause and keeps it out of the problem body", () => {
    // Delete-to-fail: the two halves of the log-vs-body boundary, asserted on
    // the serialiser itself. `toProblemDetail` reading `cause` would leak
    // internal detail into a public contract.
    const inner = new Error("duplicate key value violates unique constraint orgs_slug_key");
    const err = new ApiError({
      status: 400,
      code: "delete_failed",
      title: "Bad Request",
      detail: "Failed to delete organization",
      cause: inner,
    });

    expect(err.cause).toBe(inner);
    expect(formatErrorChain(err)).toBe(
      "Failed to delete organization: duplicate key value violates unique constraint orgs_slug_key",
    );

    const body = err.toProblemDetail("req_test");
    expect(body.detail).toBe("Failed to delete organization");
    expect(JSON.stringify(body)).not.toContain("orgs_slug_key");
  });

  it("ApiError raised without a cause has no `cause` own property", () => {
    // The error handler branches on `err.cause !== undefined` to decide
    // whether to emit a log line at all. Always passing `{ cause: undefined }`
    // to `super` would still satisfy that check — but it would put a `cause`
    // key on every one of the thousands of routine 404s.
    const err = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "gone",
    });
    expect("cause" in err).toBe(false);
  });

  it("BundlerError accepts a cause", () => {
    const inner = new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
    const err = new BundlerError("installed package.json is not valid JSON", "INSTALL_TREE_PARSE", {
      cause: inner,
    });
    expect(err.code).toBe("INSTALL_TREE_PARSE");
    expect(err.cause).toBe(inner);
    expect(formatErrorChain(err)).toContain("<!DOCTYPE");
  });

  it("PackageZipError keeps its cause behind the `details` parameter", () => {
    // Its `ErrorOptions` is the FOURTH argument, after an optional `details`.
    // Passing `{ cause }` in the third slot would silently land in `details`
    // and the chain would be lost while looking threaded.
    const inner = new SyntaxError("Unexpected end of JSON input");
    const err = new PackageZipError(
      "INVALID_MANIFEST",
      "manifest.json is not valid JSON",
      undefined,
      {
        cause: inner,
      },
    );
    expect(err.details).toBeUndefined();
    expect(err.cause).toBe(inner);
  });
});

describe("ApiError extension members (RFC 9457 §3.2)", () => {
  const build = (extensions: Record<string, unknown>) =>
    new ApiError({
      status: 409,
      code: "role_in_use",
      title: "Conflict",
      detail: "Still assigned",
      extensions,
    }).toProblemDetail("req_test");

  it("carries a machine-readable extension onto the wire", () => {
    const body = build({ member_count: 3 }) as unknown as Record<string, unknown>;
    expect(body.member_count).toBe(3);
    expect(body.code).toBe("role_in_use");
  });

  it("drops an extension named after a standard field, present or absent", () => {
    // `errors` is OPTIONAL and absent on this problem, so a `key in body` guard
    // would have let it through — and a client branching on `errors` cannot
    // tell a validation list from an extension that took the name.
    const body = build({ errors: ["nope"], status: 200, param: "x" }) as unknown as Record<
      string,
      unknown
    >;
    expect(body.errors).toBeUndefined();
    expect(body.param).toBeUndefined();
    expect(body.status).toBe(409);
  });
});
