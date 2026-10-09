// SPDX-License-Identifier: Apache-2.0

import type { CredentialFailureCause } from "@appstrate/core/sidecar-types";

/** The one wording of each {@link CredentialFailureCause} (410/502 `detail`, logs, OpenAPI). */
export const CREDENTIAL_FAILURE_SENTENCES: Record<CredentialFailureCause, string> = {
  connection_flagged: "the connection is flagged as needing re-connection",
  refresh_token_revoked: "the refresh token was revoked upstream (invalid_grant)",
  refresh_token_missing: "no refresh token is stored, so nothing can refresh the token",
  refresh_failures_exhausted:
    "the token refresh failed too many consecutive times and the token has expired",
  unrefreshable:
    "the credential was rejected upstream and its auth cannot be refreshed; each rejection is counted",
  credentials_undecryptable: "the stored credentials could not be decrypted",
  upstream_transient: "the token refresh failed upstream (transient); the failure is counted",
  discovery_transient: "the token endpoint could not be discovered (transient)",
  connection_changed: "the connection was reconnected or changed while its token was refreshed",
  oauth_client_rejected:
    "the token endpoint rejected the OAuth client (invalid_client or unauthorized_client): " +
    "its registration must be fixed, a reconnect cannot, so the failure is never counted",
};
