// SPDX-License-Identifier: Apache-2.0

/**
 * Error normalization for the typed API client. Every non-2xx response the SPA
 * ever sees goes through `toApiError`, so this is what decides whether a
 * failure surfaces as a translatable `ApiError` (with `code`, `status`,
 * `requestId`, `param`) or as a plain message — and, when the body is not the
 * problem JSON the spec promises, whether the user reads something meaningful
 * or a JSON parse failure.
 */

import { describe, it, expect } from "bun:test";
import { toApiError } from "../client.ts";
import { ApiError } from "../errors.ts";

const problem = (body: unknown, status: number, statusText = "") =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/problem+json" },
  });

describe("toApiError", () => {
  it("maps an RFC 9457 body with a code to ApiError, detail first", async () => {
    const error = await toApiError(
      problem(
        {
          code: "quota_exceeded",
          detail: "quota exceeded",
          requestId: "req_1",
          param: "input.file",
        },
        413,
      ),
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.message).toBe("quota exceeded");
    expect(apiError.code).toBe("quota_exceeded");
    expect(apiError.status).toBe(413);
    expect(apiError.requestId).toBe("req_1");
    expect(apiError.param).toBe("input.file");
  });

  it("carries the polymorphic `errors` payload through as details", async () => {
    const error = (await toApiError(
      problem({ code: "validation_failed", detail: "invalid", errors: [{ path: "name" }] }, 400),
    )) as ApiError;

    expect(error.details).toEqual([{ path: "name" }] as never);
  });

  it("falls back to the status when a coded problem has no detail", async () => {
    const error = await toApiError(problem({ code: "conflict" }, 409));

    expect(error.message).toBe("API Error: 409");
  });

  it("degrades to a plain Error when the body has no code", async () => {
    const error = await toApiError(problem({ detail: "something went wrong" }, 500));

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.message).toBe("something went wrong");
  });

  it("falls back to statusText when the error body is not JSON", async () => {
    // A proxy or the dev server can answer with HTML; parsing it must not
    // replace the real failure with a SyntaxError.
    const error = await toApiError(
      new Response("<html>oops</html>", { status: 502, statusText: "Bad Gateway" }),
    );

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.message).toBe("Bad Gateway");
  });

  it("falls back to the status when there is neither a body nor a statusText", async () => {
    const error = await toApiError(new Response(null, { status: 500, statusText: "" }));

    expect(error.message).toBe("API Error: 500");
  });

  it("leaves the response body readable for the caller", async () => {
    // The middleware clones before reading — a consumer inspecting the same
    // response afterwards must not hit a locked stream.
    const response = problem({ code: "conflict", detail: "nope" }, 409);

    await toApiError(response);

    expect(await response.json()).toEqual({ code: "conflict", detail: "nope" });
  });
});
