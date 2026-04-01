import { describe, test, expect } from "bun:test";
import { AppError, createErrorStatusMap } from "../src/errors.ts";

describe("AppError", () => {
  test("extends Error with code property", () => {
    const err = new AppError("NOT_FOUND", "Resource not found");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Resource not found");
    expect(err.name).toBe("AppError");
  });

  test("can be caught as Error", () => {
    try {
      throw new AppError("FORBIDDEN", "Access denied");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as AppError).code).toBe("FORBIDDEN");
    }
  });
});

describe("createErrorStatusMap", () => {
  const getStatus = createErrorStatusMap({
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    UNAUTHORIZED: 401,
    CONFLICT: 409,
  });

  test("maps known codes to their HTTP status", () => {
    expect(getStatus("NOT_FOUND")).toBe(404);
    expect(getStatus("FORBIDDEN")).toBe(403);
    expect(getStatus("UNAUTHORIZED")).toBe(401);
    expect(getStatus("CONFLICT")).toBe(409);
  });

  test("returns 500 for unknown codes", () => {
    expect(getStatus("UNKNOWN_CODE")).toBe(500);
    expect(getStatus("")).toBe(500);
  });
});
