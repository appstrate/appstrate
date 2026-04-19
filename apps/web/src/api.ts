// SPDX-License-Identifier: Apache-2.0

import { getCurrentOrgId } from "./hooks/use-org";
import { getCurrentApplicationId } from "./stores/app-store";

const API_BASE = "/api";

/** Direct-upload endpoint consumed by `<SchemaForm uploadPath={...} />`. */
export const UPLOADS_PATH = `${API_BASE}/uploads`;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    // RFC 9457 format: { code, detail, status, ... }
    if (body.code) {
      throw new ApiError(
        body.code,
        body.detail || `API Error: ${res.status}`,
        res.status,
        body.errors,
      );
    }
    throw new Error(body.detail || `API Error: ${res.status}`);
  }
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const appId = getCurrentApplicationId();
  if (appId) headers["X-App-Id"] = appId;
  return headers;
}

export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const authHeaders = getAuthHeaders();
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...options.headers,
    },
  });
  await throwIfNotOk(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  return apiFetch<T>(`${API_BASE}${path}`, options);
}

export async function uploadFormData<T = unknown>(
  path: string,
  formData: FormData,
  method: "POST" | "PUT" = "POST",
): Promise<T> {
  const authHeaders = getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers: authHeaders,
    body: formData,
  });
  await throwIfNotOk(res);
  return res.json();
}

export async function apiBlob(path: string): Promise<Blob> {
  const authHeaders = getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: authHeaders,
  });
  await throwIfNotOk(res);
  return res.blob();
}
