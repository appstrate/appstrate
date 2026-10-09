// SPDX-License-Identifier: Apache-2.0

import type { IntegrationManifestView } from "../../hooks/use-integrations";
import { useHostedConnectPopup } from "../integration-connect/use-integration-oauth-popup";
import { requestedScopes, type ScopeChoice } from "./connect-scope-choice";

export interface ScopeTarget {
  packageId: string;
  authKey: string;
  manifest: IntegrationManifestView;
  choice: ScopeChoice;
}

/** Tests pass an `openPopup`: the real one needs a browser. */
export interface ConnectWithScopesDeps {
  openPopup?: ReturnType<typeof useHostedConnectPopup>["openPopup"];
}

/** Starts the hosted connect with the ticked scopes in catalog order; none for the baseline. */
export function useConnectWithScopes(
  target: ScopeTarget & { forceAccountSelect: boolean },
  deps: ConnectWithScopesDeps = {},
) {
  const hosted = useHostedConnectPopup();
  const openPopup = deps.openPopup ?? hosted.openPopup;
  const connect = (ticked: readonly string[]) => {
    const scopes = requestedScopes(target.choice, ticked);
    return openPopup({
      packageId: target.packageId,
      authKey: target.authKey,
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(target.forceAccountSelect ? { forceAccountSelect: true } : {}),
    });
  };
  return { connect, isPending: hosted.isPending };
}
