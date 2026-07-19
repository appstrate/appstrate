// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { McpServerBrowserCapability } from "@appstrate/core/mcp-server";
import { isValidRange, satisfiesRange } from "@appstrate/core/semver";
import { getEnv } from "@appstrate/env";

const packageIdPattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

const browserDriverGrantSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    packageId: z.string().regex(packageIdPattern),
    versionRange: z.string().refine(isValidRange, "must be a valid semver range"),
    origins: z
      .array(
        z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.origin === value &&
            !url.username &&
            !url.password &&
            url.pathname === "/" &&
            !url.search &&
            !url.hash
          );
        }, "must be a canonical exact https origin"),
      )
      .max(64)
      .optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export type BrowserDriverGrant = z.infer<typeof browserDriverGrantSchema>;

export interface BrowserCapabilityPolicy {
  readonly browserEnabled: boolean;
  readonly browserConnectEnabled: boolean;
}

export interface BrowserCapabilityAuthorization {
  readonly trustedDriver: boolean;
  readonly driverGrantId?: string;
}

export class BrowserCapabilityPolicyError extends Error {
  readonly code = "BROWSER_POLICY_DENIED" as const;

  constructor(message: string) {
    super(`BROWSER_POLICY_DENIED: ${message}`);
    this.name = "BrowserCapabilityPolicyError";
  }
}

let grants: readonly BrowserDriverGrant[] | null = null;

export function initBrowserCapabilityGrants(rawOverride?: unknown[]): void {
  const raw = rawOverride ?? (getEnv().BROWSER_DRIVER_GRANTS as unknown[]);
  const parsed: BrowserDriverGrant[] = [];
  const ids = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const result = browserDriverGrantSchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `BROWSER_DRIVER_GRANTS[${index}] is invalid: ${result.error.issues
          .map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`)
          .join("; ")}`,
      );
    }
    if (ids.has(result.data.id)) {
      throw new Error(`BROWSER_DRIVER_GRANTS contains duplicate id '${result.data.id}'`);
    }
    ids.add(result.data.id);
    parsed.push({
      ...result.data,
      ...(result.data.origins ? { origins: [...new Set(result.data.origins)] } : {}),
    });
  }

  grants = parsed;
}

export function resetBrowserCapabilityGrantsForTest(): void {
  grants = null;
}

function currentPolicy(): BrowserCapabilityPolicy {
  const env = getEnv();
  return {
    browserEnabled: env.BROWSER_ENABLED,
    browserConnectEnabled: env.BROWSER_CONNECT_ENABLED,
  };
}

/**
 * Authorize a normalized browser capability. Automation is available behind
 * the general feature gate. Connection acquisition additionally requires an
 * exact package grant whose semver range and optional origin ceiling match.
 */
export function authorizeBrowserCapability(
  input: {
    packageId: string;
    version: string;
    source: "system" | "version";
    capability: McpServerBrowserCapability;
  },
  policy: BrowserCapabilityPolicy = currentPolicy(),
): BrowserCapabilityAuthorization {
  if (!policy.browserEnabled) {
    throw new BrowserCapabilityPolicyError("browser capability is disabled by operator policy");
  }

  if (input.capability.purpose === "automation") {
    return { trustedDriver: false };
  }

  if (!policy.browserConnectEnabled) {
    throw new BrowserCapabilityPolicyError(
      "browser connection acquisition is disabled by operator policy",
    );
  }
  if (input.source !== "system") {
    throw new BrowserCapabilityPolicyError(
      "browser connection acquisition is restricted to system packages",
    );
  }
  if (!grants) {
    throw new BrowserCapabilityPolicyError("browser capability grants were not initialized");
  }

  const grant = grants.find(
    (candidate) =>
      candidate.enabled &&
      candidate.packageId === input.packageId &&
      satisfiesRange(input.version, candidate.versionRange) &&
      (!candidate.origins ||
        input.capability.origins.every((origin) => candidate.origins!.includes(origin))),
  );
  if (!grant) {
    throw new BrowserCapabilityPolicyError(
      `browser connection driver '${input.packageId}@${input.version}' has no matching operator grant`,
    );
  }

  return { trustedDriver: true, driverGrantId: grant.id };
}
