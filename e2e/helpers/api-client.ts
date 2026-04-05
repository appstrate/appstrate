// SPDX-License-Identifier: Apache-2.0

/**
 * Typed API client for E2E tests.
 * Wraps Playwright's APIRequestContext with auth headers and org/app context.
 */

import type { APIRequestContext, APIResponse } from "@playwright/test";

export interface ApiClientOptions {
  cookie: string;
  orgId: string;
  appId: string;
}

export interface ApiClient {
  get(path: string): Promise<APIResponse>;
  post(path: string, data?: unknown): Promise<APIResponse>;
  put(path: string, data?: unknown): Promise<APIResponse>;
  patch(path: string, data?: unknown): Promise<APIResponse>;
  delete(path: string): Promise<APIResponse>;
  /** Create a new client with a different appId (same auth + org) */
  withApp(appId: string): ApiClient;
  /** Create a new client with different org + app context */
  withContext(orgId: string, appId: string): ApiClient;
}

export function createApiClient(request: APIRequestContext, options: ApiClientOptions): ApiClient {
  const headers = (extra?: Record<string, string>) => ({
    Cookie: options.cookie,
    "X-Org-Id": options.orgId,
    "X-App-Id": options.appId,
    ...extra,
  });

  return {
    get(path: string) {
      return request.get(`/api${path}`, { headers: headers() });
    },
    post(path: string, data?: unknown) {
      return request.post(`/api${path}`, {
        headers: headers({ "Content-Type": "application/json" }),
        data,
      });
    },
    put(path: string, data?: unknown) {
      return request.put(`/api${path}`, {
        headers: headers({ "Content-Type": "application/json" }),
        data,
      });
    },
    patch(path: string, data?: unknown) {
      return request.patch(`/api${path}`, {
        headers: headers({ "Content-Type": "application/json" }),
        data,
      });
    },
    delete(path: string) {
      return request.delete(`/api${path}`, { headers: headers() });
    },
    withApp(appId: string) {
      return createApiClient(request, { ...options, appId });
    },
    withContext(orgId: string, appId: string) {
      return createApiClient(request, { ...options, orgId, appId });
    },
  };
}

/**
 * Create an API client for org-only routes (no X-App-Id header).
 */
export function createOrgOnlyClient(
  request: APIRequestContext,
  cookie: string,
  orgId: string,
): {
  get(path: string): Promise<APIResponse>;
  post(path: string, data?: unknown): Promise<APIResponse>;
  put(path: string, data?: unknown): Promise<APIResponse>;
  patch(path: string, data?: unknown): Promise<APIResponse>;
  delete(path: string): Promise<APIResponse>;
} {
  const headers = (extra?: Record<string, string>) => ({
    Cookie: cookie,
    "X-Org-Id": orgId,
    ...extra,
  });

  return {
    get(path: string) {
      return request.get(`/api${path}`, { headers: headers() });
    },
    post(path: string, data?: unknown) {
      return request.post(`/api${path}`, {
        headers: headers({ "Content-Type": "application/json" }),
        data,
      });
    },
    put(path: string, data?: unknown) {
      return request.put(`/api${path}`, {
        headers: headers({ "Content-Type": "application/json" }),
        data,
      });
    },
    patch(path: string, data?: unknown) {
      return request.patch(`/api${path}`, {
        headers: headers({ "Content-Type": "application/json" }),
        data,
      });
    },
    delete(path: string) {
      return request.delete(`/api${path}`, { headers: headers() });
    },
  };
}
