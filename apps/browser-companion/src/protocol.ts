// SPDX-License-Identifier: Apache-2.0

const ATTEMPT_PATH =
  /^\/api\/integrations\/connect\/companion\/attempts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CompanionCapability {
  endpoint: URL;
  token: string;
}

function isSecurePlatformUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

export function parseCompanionCapability(raw: string): CompanionCapability {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid companion link");
  }
  if (
    url.protocol !== "appstrate-browser:" ||
    url.hostname !== "connect" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Invalid companion link");
  }
  const endpointRaw = url.searchParams.get("endpoint");
  const token = url.searchParams.get("token") ?? "";
  if (!endpointRaw || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("Invalid companion capability");
  }
  const endpoint = new URL(endpointRaw);
  if (
    !isSecurePlatformUrl(endpoint) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !ATTEMPT_PATH.test(endpoint.pathname)
  ) {
    throw new Error("Unsafe companion endpoint");
  }
  return { endpoint, token };
}

export interface CompanionContextResponse {
  attempt_id: string;
  package_id: string;
  display_name: string;
  start_url: string;
  allowed_origins: string[];
  target_provider: "browser-use-cloud" | "process";
  status:
    | "pending"
    | "claimed"
    | "state_received"
    | "provisioning"
    | "interaction_required"
    | "complete"
    | "failed";
  interaction_url: string | null;
  error_code: string | null;
  expires_at: string;
}

const ATTEMPT_STATUSES = new Set<CompanionContextResponse["status"]>([
  "pending",
  "claimed",
  "state_received",
  "provisioning",
  "interaction_required",
  "complete",
  "failed",
]);

function exactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !/[*?{}[\]]/.test(url.hostname) &&
      url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Treat every API response as untrusted before it reaches Chrome or the OS. */
export function validateCompanionContext(
  value: unknown,
  capability: CompanionCapability,
): CompanionContextResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed companion context");
  }
  const context = value as Record<string, unknown>;
  const attemptId = capability.endpoint.pathname.split("/").at(-1);
  if (
    typeof context.attempt_id !== "string" ||
    context.attempt_id !== attemptId ||
    typeof context.package_id !== "string" ||
    context.package_id.length < 1 ||
    context.package_id.length > 256 ||
    typeof context.display_name !== "string" ||
    context.display_name.length < 1 ||
    context.display_name.length > 256 ||
    (context.target_provider !== "browser-use-cloud" && context.target_provider !== "process") ||
    typeof context.status !== "string" ||
    !ATTEMPT_STATUSES.has(context.status as CompanionContextResponse["status"]) ||
    (context.error_code !== null &&
      (typeof context.error_code !== "string" ||
        !/^BROWSER_[A-Z_]{1,64}$/.test(context.error_code))) ||
    typeof context.expires_at !== "string" ||
    !Number.isFinite(Date.parse(context.expires_at))
  ) {
    throw new Error("Malformed companion context");
  }
  if (
    !Array.isArray(context.allowed_origins) ||
    context.allowed_origins.length < 1 ||
    context.allowed_origins.length > 64
  ) {
    throw new Error("Malformed companion origins");
  }
  const allowedOrigins = context.allowed_origins.map(exactHttpsOrigin);
  if (allowedOrigins.some((origin) => origin === null)) {
    throw new Error("Unsafe companion origin");
  }
  const uniqueOrigins = [...new Set(allowedOrigins as string[])];
  if (uniqueOrigins.length !== allowedOrigins.length) {
    throw new Error("Malformed companion origins");
  }
  let startUrl: URL;
  try {
    startUrl = new URL(String(context.start_url));
  } catch {
    throw new Error("Unsafe companion start URL");
  }
  if (
    typeof context.start_url !== "string" ||
    context.start_url.length > 4096 ||
    startUrl.protocol !== "https:" ||
    startUrl.username ||
    startUrl.password ||
    !uniqueOrigins.includes(startUrl.origin)
  ) {
    throw new Error("Unsafe companion start URL");
  }
  if (context.interaction_url !== null) {
    if (typeof context.interaction_url !== "string" || context.interaction_url.length > 4096) {
      throw new Error("Unsafe provider interaction URL");
    }
    const interaction = new URL(context.interaction_url);
    if (interaction.protocol !== "https:" || interaction.username || interaction.password) {
      throw new Error("Unsafe provider interaction URL");
    }
  }
  return {
    attempt_id: context.attempt_id,
    package_id: context.package_id,
    display_name: context.display_name,
    start_url: context.start_url,
    allowed_origins: uniqueOrigins,
    target_provider: context.target_provider,
    status: context.status as CompanionContextResponse["status"],
    interaction_url: context.interaction_url as string | null,
    error_code: context.error_code as string | null,
    expires_at: context.expires_at,
  };
}

async function readApiError(response: Response): Promise<string> {
  const value = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return typeof value?.detail === "string" ? value.detail : `HTTP ${response.status}`;
}

export async function readCompanionContext(
  capability: CompanionCapability,
): Promise<CompanionContextResponse> {
  const response = await fetch(capability.endpoint, {
    headers: { Authorization: `Bearer ${capability.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return validateCompanionContext(await response.json(), capability);
}

export async function submitBrowserState(
  capability: CompanionCapability,
  browserState: string,
): Promise<void> {
  const response = await fetch(`${capability.endpoint.href}/handoff`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${capability.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ browser_state: browserState }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

export type CompanionFailureReason = "closed" | "timeout" | "failed";

/**
 * Tell the platform that local acquisition stopped before a handoff was
 * accepted. This prevents the hosted page from polling a dead process until
 * the full attempt TTL elapses.
 */
export async function reportCompanionFailure(
  capability: CompanionCapability,
  reason: CompanionFailureReason,
): Promise<void> {
  const response = await fetch(`${capability.endpoint.href}/failure`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${capability.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(await readApiError(response));
}
