import { supabase } from "./lib/supabase";

const API_BASE = "/api";

async function throwIfNotOk(res: Response): Promise<void> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `API Error: ${res.status}`);
  }
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(path, {
    ...options,
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
  const authHeaders = await getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders,
    body: formData,
  });
  await throwIfNotOk(res);
  return res.json();
}

export async function apiBlob(path: string): Promise<Blob> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: authHeaders,
  });
  await throwIfNotOk(res);
  return res.blob();
}
