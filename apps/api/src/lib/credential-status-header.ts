// SPDX-License-Identifier: Apache-2.0

/**
 * `X-Appstrate-Credential-Status`: what the credential proxy concluded about the connection's
 * credential when it relays an upstream 401 after a forced refresh that did not serve a replay.
 * An RFC 8941 Item, a token and its parameters:
 *
 *   retry; cause=unrefreshable; failures=1; max-failures=5
 *   dead; cause=refresh_token_revoked
 *
 * `retry`: the credential stays in use and this rejection may count toward
 * `INTEGRATION_REFRESH_MAX_FAILURES` (`failures`/`max-failures` when it did); `dead`: the
 * connection is now flagged `needs_reconnection`. `cause` is a {@link CredentialFailureCause},
 * the vocabulary of the internal credential endpoints' 410/502. A 401 without the header is the
 * upstream refusing a credential the platform did not judge (or a replay's answer).
 */

import {
  CREDENTIAL_FAILURE_CAUSES,
  type CredentialFailureCause,
} from "@appstrate/core/sidecar-types";
import type { ProxyCredentialVerdict } from "../services/credential-proxy/integration-resolver.ts";

export const CREDENTIAL_STATUS_HEADER = "X-Appstrate-Credential-Status";

export function formatCredentialStatus(verdict: ProxyCredentialVerdict): string {
  let value = `${verdict.status}; cause=${verdict.cause}`;
  if (verdict.status === "retry" && verdict.rejections) {
    const { failures, maxFailures } = verdict.rejections;
    value += `; failures=${failures}; max-failures=${maxFailures}`;
  }
  return value;
}

const CAUSES: ReadonlySet<string> = new Set(CREDENTIAL_FAILURE_CAUSES);

/** The verdict a header value carries, or `null` for a value this platform does not write. */
export function parseCredentialStatus(value: string | null): ProxyCredentialVerdict | null {
  if (value === null) return null;
  const [status, ...params] = value.split(";").map((part) => part.trim());
  const named = new Map<string, string>();
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq <= 0) return null;
    named.set(param.slice(0, eq), param.slice(eq + 1));
  }
  const cause = named.get("cause");
  if (cause === undefined || !CAUSES.has(cause)) return null;
  const known = cause as CredentialFailureCause;
  if (status === "dead") return { status, cause: known };
  if (status !== "retry") return null;
  const failures = Number(named.get("failures"));
  const maxFailures = Number(named.get("max-failures"));
  return Number.isSafeInteger(failures) && Number.isSafeInteger(maxFailures)
    ? { status, cause: known, rejections: { failures, maxFailures } }
    : { status, cause: known };
}
