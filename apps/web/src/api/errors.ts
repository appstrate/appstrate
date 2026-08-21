// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9457 problem-details error thrown by the typed OpenAPI client
 * (`src/api/client.ts`) on any non-2xx response, so React Query errors are
 * `instanceof ApiError` with `code`/`status`/`requestId`.
 */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
    public requestId?: string,
    /**
     * RFC 9457 `param` — the request member the error is about, dotted from the
     * request root (`input.folder`, `locked_fields.folder`). Populated by the
     * error factories in `@appstrate/core/api-errors`; the surfacing layer uses
     * it to name the offending field in a translated message.
     */
    public param?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
