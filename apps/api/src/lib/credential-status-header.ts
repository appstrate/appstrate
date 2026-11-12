// SPDX-License-Identifier: Apache-2.0

/**
 * `X-Appstrate-Credential-Status`: what the credential proxy concluded about the connection's
 * credential when it relays an upstream 401 after a forced refresh that did not serve a replay.
 * An RFC 8941 Item, a token and its parameters:
 *
 *   in_use; cause=unrefreshable; failures=1; max-failures=5
 *   needs_reconnection; cause=refresh_token_revoked
 *
 * `in_use`: the credential stays in use and this rejection may count toward
 * `INTEGRATION_REFRESH_MAX_FAILURES` (`failures`/`max-failures` when it did);
 * `needs_reconnection`: the connection is now flagged so. `cause` is a
 * {@link CredentialFailureCause}, the vocabulary of the internal credential endpoints' 410/502.
 * A 401 without the header is the upstream refusing a credential the platform did not judge (or
 * a replay's answer).
 *
 * Produced once, where {@link refreshConnectionCredential}'s verdict is known (the proxy's
 * forced refresh); its internal `retry` / `dead` names never leave the platform.
 */

import {
  CREDENTIAL_FAILURE_CAUSES,
  type CredentialFailureCause,
} from "@appstrate/core/sidecar-types";

export const CREDENTIAL_STATUS_HEADER = "X-Appstrate-Credential-Status";

/** What the platform concluded about a rejected credential, as the header and `api_call` name it. */
export type CredentialStatus =
  | {
      status: "in_use";
      cause: CredentialFailureCause;
      /** Counted rejections toward `INTEGRATION_REFRESH_MAX_FAILURES`, when this one was counted. */
      failures?: number;
      maxFailures?: number;
    }
  | { status: "needs_reconnection"; cause: CredentialFailureCause };

export function formatCredentialStatus(credential: CredentialStatus): string {
  const value = `${credential.status}; cause=${credential.cause}`;
  if (
    credential.status === "in_use" &&
    credential.failures !== undefined &&
    credential.maxFailures !== undefined
  ) {
    return `${value}; failures=${credential.failures}; max-failures=${credential.maxFailures}`;
  }
  return value;
}

const CAUSES: ReadonlySet<string> = new Set(CREDENTIAL_FAILURE_CAUSES);

/** The status a header value carries, or `null` for a value this platform does not write. */
export function parseCredentialStatus(value: string | null): CredentialStatus | null {
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
  if (status === "needs_reconnection") return { status, cause: known };
  if (status !== "in_use") return null;
  const failures = Number(named.get("failures"));
  const maxFailures = Number(named.get("max-failures"));
  return Number.isSafeInteger(failures) && Number.isSafeInteger(maxFailures)
    ? { status, cause: known, failures, maxFailures }
    : { status, cause: known };
}
