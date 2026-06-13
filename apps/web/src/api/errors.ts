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
  ) {
    super(message);
    this.name = "ApiError";
  }
}
