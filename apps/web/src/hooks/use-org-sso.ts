// SPDX-License-Identifier: Apache-2.0

/** Enterprise sign-in hooks over `/api/org-sso*` (commercial module, `features.enterpriseSso`). Every write answers the whole settings object, which replaces the cached read. */

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import type { SsoSettings } from "../lib/org-sso";
import { useOrgOnlyScope } from "./use-org-scope";

export function useOrgSso() {
  const { enabled, header } = useOrgOnlyScope();
  return $api.useQuery("get", "/api/org-sso", { params: { header } }, { enabled });
}

function useStoreSettings() {
  const queryClient = useQueryClient();
  const { header } = useOrgOnlyScope();
  const key = $api.queryOptions("get", "/api/org-sso", { params: { header } }).queryKey;
  return (settings: SsoSettings) => queryClient.setQueryData(key, settings);
}

export function useOrgSsoMutations() {
  const store = useStoreSettings();
  const onSuccess = (settings: SsoSettings) => store(settings);
  return {
    update: $api.useMutation("patch", "/api/org-sso", { onSuccess }),
    // Its two callers word the refusal themselves: the button turns `microsoft_session_required`
    // into a Microsoft sign-in, the return from that sign-in toasts.
    linkTenant: $api.useMutation("post", "/api/org-sso/tenant", {
      onSuccess,
      meta: { errorHandledByCaller: true },
    }),
    unlinkTenant: $api.useMutation("delete", "/api/org-sso/tenant", { onSuccess }),
    addDomain: $api.useMutation("post", "/api/org-sso/domains", { onSuccess }),
    verifyDomain: $api.useMutation("post", "/api/org-sso/domains/{domainId}/verify", {
      onSuccess,
    }),
    removeDomain: $api.useMutation("delete", "/api/org-sso/domains/{domainId}", { onSuccess }),
    enforce: $api.useMutation("post", "/api/org-sso/enforcement", { onSuccess }),
    lift: $api.useMutation("delete", "/api/org-sso/enforcement", { onSuccess }),
  };
}
