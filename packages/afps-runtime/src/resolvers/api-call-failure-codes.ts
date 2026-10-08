// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/** The failure codes every `api_call` path (platform proxy, sidecar, CLI) reports. */

import type { UrlPolicyRefusal } from "./credential-guard.ts";

export type ApiCallFailureCode =
  | "unauthorized_target"
  | "blocked_target"
  | "credential_exfiltration_refused"
  | "upstream_unresolvable"
  | "credential_unusable"
  | "upstream_unreachable"
  | "upstream_timeout";

export const URL_POLICY_REFUSAL_CODE = {
  unrendered: "unauthorized_target",
  unauthorized: "unauthorized_target",
  exfiltration: "credential_exfiltration_refused",
} as const satisfies Record<UrlPolicyRefusal, ApiCallFailureCode>;

/** `fetchApiCall`'s failure kinds: past preparation, an invalid header value is the credential's. */
export const ENGINE_FAILURE_CODE = {
  not_authorized: "unauthorized_target",
  ssrf: "blocked_target",
  unresolvable: "upstream_unresolvable",
  invalid_header: "credential_unusable",
  timeout: "upstream_timeout",
  transport: "upstream_unreachable",
} as const satisfies Record<string, ApiCallFailureCode>;
