import { bodyLimit as honoBodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import { payloadTooLarge } from "../lib/errors.ts";

/**
 * Global body-size cap. Throws an `ApiError` so the response goes through the
 * RFC 9457 problem+json error handler (instead of Hono's default plaintext 413).
 */
export function bodyLimit(maxSize: number): MiddlewareHandler {
  return honoBodyLimit({
    maxSize,
    onError: () => {
      throw payloadTooLarge(`Request body exceeds the ${maxSize}-byte limit`);
    },
  });
}
