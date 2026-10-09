// SPDX-License-Identifier: Apache-2.0

/**
 * `-k` / `--insecure`, as in `curl -k` (issue #189): skip TLS certificate
 * verification process-wide until the returned function restores the previous
 * setting. Opt-in per invocation and restored on every exit path; fine for a
 * one-shot CLI, never copy it into a long-running process.
 */
export function skipTlsVerification(): () => void {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return () => {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  };
}
