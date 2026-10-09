// SPDX-License-Identifier: Apache-2.0

import type { CredentialFailureCause } from "@appstrate/core/sidecar-types";

/**
 * The words for each {@link CredentialFailureCause}, written into the `detail` of the 410/502 a
 * credential endpoint answers and into its log lines. Nothing upstream of the response builds
 * prose: the refresh decision concludes a cause, the endpoint that answers words it.
 */
export const CREDENTIAL_FAILURE_SENTENCES: Record<CredentialFailureCause, string> = {
  connection_flagged: "the connection is flagged as needing re-connection",
  refresh_token_revoked: "the refresh token was revoked upstream",
  refresh_token_missing: "no refresh token is stored, so nothing can refresh the token",
  refresh_failures_exhausted:
    "the token refresh failed too many consecutive times and the token has expired",
  unrefreshable: "the credential was rejected upstream and its auth cannot be refreshed",
  credentials_undecryptable: "the stored credentials could not be decrypted",
  upstream_transient: "the token refresh failed upstream (transient)",
  discovery_transient: "the token endpoint could not be discovered (transient)",
  connection_changed: "the connection was reconnected or changed while its token was refreshed",
  oauth_client_rejected:
    "the token endpoint rejected the OAuth client (invalid_client or unauthorized_client): " +
    "its registration must be fixed, a reconnect cannot",
};
