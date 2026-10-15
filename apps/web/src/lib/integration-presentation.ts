// SPDX-License-Identifier: Apache-2.0

import type { IntegrationAuthStatus, IntegrationAuthType } from "../hooks/use-integrations";

/** Auth keys are identifiers, not capabilities or steps the user must activate. */
export function authMethodLabel(
  auth: Pick<IntegrationAuthStatus, "auth_key" | "type">,
  auths: ReadonlyArray<Pick<IntegrationAuthStatus, "auth_key" | "type">>,
  typeLabel: string,
): string {
  return auths.filter((candidate) => candidate.type === auth.type).length > 1
    ? `${typeLabel} (${auth.auth_key})`
    : typeLabel;
}

export interface ConnectionAuthContext {
  authKey: string;
  authType: IntegrationAuthType;
  canRenew: boolean;
}
