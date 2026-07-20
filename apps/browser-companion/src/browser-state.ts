// SPDX-License-Identifier: Apache-2.0

import { CdpClient } from "./cdp.ts";

interface CdpCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

function cookieForPortableState(cookie: CdpCookie): Record<string, unknown> | null {
  if (
    typeof cookie.name !== "string" ||
    typeof cookie.value !== "string" ||
    typeof cookie.domain !== "string"
  ) {
    return null;
  }
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: typeof cookie.path === "string" ? cookie.path : "/",
    expires: typeof cookie.expires === "number" ? cookie.expires : -1,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    ...(cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None"
      ? { sameSite: cookie.sameSite }
      : {}),
  };
}

function domainAllowed(domain: string, origins: ReadonlySet<string>): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, "");
  for (const origin of origins) {
    if (new URL(origin).hostname.toLowerCase() === normalized) return true;
  }
  return false;
}

async function readTargetState(target: CdpTarget): Promise<{
  origin: string;
  cookies: CdpCookie[];
  localStorage: Array<{ name: string; value: string }>;
} | null> {
  if (!target.webSocketDebuggerUrl || !target.url) return null;
  const origin = new URL(target.url).origin;
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    const [cookieResult, storageResult] = await Promise.all([
      client.send<{ cookies?: CdpCookie[] }>("Network.getCookies", { urls: [origin] }),
      client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "Object.entries(localStorage).map(([name,value])=>({name,value}))",
        returnByValue: true,
        awaitPromise: true,
      }),
    ]);
    const cookies = Array.isArray(cookieResult.cookies) ? cookieResult.cookies : [];
    const value = storageResult.result?.value;
    if (!Array.isArray(value)) return { origin, cookies, localStorage: [] };
    const localStorage = value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as { name?: unknown; value?: unknown };
      return typeof item.name === "string" && typeof item.value === "string"
        ? [{ name: item.name, value: item.value }]
        : [];
    });
    return { origin, cookies, localStorage };
  } finally {
    client.close();
  }
}

export async function capturePortableBrowserState(
  debuggingOrigin: string,
  allowedOrigins: readonly string[],
): Promise<string> {
  const allowed = new Set(allowedOrigins);
  const targetsResponse = await fetch(`${debuggingOrigin}/json/list`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!targetsResponse.ok) throw new Error("Could not inspect local Chrome");
  const targets = (await targetsResponse.json()) as CdpTarget[];
  const originStates = new Map<string, Array<{ name: string; value: string }>>();
  const cookies: CdpCookie[] = [];
  for (const target of targets) {
    if (target.type !== "page" || !target.url) continue;
    let origin: string;
    try {
      origin = new URL(target.url).origin;
    } catch {
      continue;
    }
    if (!allowed.has(origin) || originStates.has(origin)) continue;
    const state = await readTargetState(target);
    if (state) {
      originStates.set(state.origin, state.localStorage);
      cookies.push(...state.cookies);
    }
  }
  const portableCookies = new Map<string, Record<string, unknown>>();
  for (const cookie of cookies) {
    const normalized = cookieForPortableState(cookie);
    if (!normalized || !domainAllowed(String(normalized.domain), allowed)) continue;
    const key = `${String(normalized.domain).toLowerCase()}\u0000${String(normalized.path)}\u0000${String(normalized.name)}`;
    portableCookies.set(key, normalized);
  }
  return JSON.stringify({
    version: 1,
    cookies: [...portableCookies.values()],
    origins: [...originStates].map(([origin, localStorage]) => ({ origin, localStorage })),
  });
}

export const _test = { cookieForPortableState, domainAllowed };
