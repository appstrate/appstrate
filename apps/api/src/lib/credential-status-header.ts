// SPDX-License-Identifier: Apache-2.0

/**
 * `X-Appstrate-Credential-Status`: what the credential proxy concluded about the connection's
 * credential when it relays an upstream 401 after a forced refresh that did not serve a replay.
 * The platform emits these two forms of RFC 8941 Item:
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
import { CREDENTIAL_FAILURE_SENTENCES } from "./credential-failure.ts";

export const CREDENTIAL_STATUS_HEADER = "X-Appstrate-Credential-Status";

/** What the platform concluded about a rejected credential, as the header and `call_integration_tool` name it. */
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
  const match =
    /^(in_use|needs_reconnection); *cause=([a-z_]+)(?:; *failures=(\d+); *max-failures=(\d+))?$/.exec(
      value,
    );
  if (!match || !CAUSES.has(match[2]!)) return null;
  const cause = match[2] as CredentialFailureCause;
  if (match[1] === "needs_reconnection")
    return match[3] === undefined ? { status: "needs_reconnection", cause } : null;
  if (match[3] === undefined) return { status: "in_use", cause };
  const failures = Number(match[3]);
  const maxFailures = Number(match[4]);
  return Number.isSafeInteger(failures) && Number.isSafeInteger(maxFailures)
    ? { status: "in_use", cause, failures, maxFailures }
    : null;
}

/** A {@link CredentialStatus} on the wire: an `api_call` entry's or a tool call refusal's `credential`. */
export interface CredentialMember {
  status: CredentialStatus["status"];
  cause: CredentialStatus["cause"];
  detail: string;
  failures?: number;
  max_failures?: number;
}

/**
 * What the platform concluded about the connection's credential when the upstream refused it and
 * a forced refresh could not recover it, as a model reads it.
 */
export function credentialMember(credential: CredentialStatus): CredentialMember {
  const member = {
    status: credential.status,
    cause: credential.cause,
    detail: CREDENTIAL_FAILURE_SENTENCES[credential.cause],
  };
  return credential.status === "in_use" &&
    credential.failures !== undefined &&
    credential.maxFailures !== undefined
    ? { ...member, failures: credential.failures, max_failures: credential.maxFailures }
    : member;
}
