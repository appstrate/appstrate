import { getCurrentOrgId } from "./hooks/use-org";

const API_BASE = "/api";

async function throwIfNotOk(res: Response): Promise<void> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `API Error: ${res.status}`);
  }
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
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
