// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9457 problem-details error thrown by both the legacy fetch helpers
 * (`src/api.ts`) and the typed OpenAPI client (`src/api/client.ts`), so
 * `err instanceof ApiError` works the same everywhere during the migration.
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
