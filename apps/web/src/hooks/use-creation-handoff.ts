// SPDX-License-Identifier: Apache-2.0

import { useNavigate, useSearchParams } from "react-router-dom";
import {
  CREATE_INTEGRATION_PARAM,
  chatDraftNavigationState,
  type CreationResource,
} from "../lib/creation-handoff";
import { useUrlModal } from "./use-url-modal";

const COMPANIONS = [CREATE_INTEGRATION_PARAM];

export function useCreationHandoff(resource: CreationResource, canCreate: boolean) {
  const param = useUrlModal("create", COMPANIONS);
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const open = () => {
    if (canCreate) param.open(resource);
  };

  const openChat = (prompt: string) => {
    if (!canCreate) return;
    navigate("/chat", { replace: true, state: chatDraftNavigationState(prompt) });
  };

  return {
    /** The integration an agent creation starts with (`?integration=`); unverified, the creation resolves it. */
    integrationId: resource === "agent" ? search.get(CREATE_INTEGRATION_PARAM) : null,
    isOpen: canCreate && param.value === resource,
    open,
    close: param.close,
    /** Leaves the chooser for a creation page: the manual editor or the MCP URL wizard. */
    leave: (to: string) => navigate(to, { replace: true }),
    openChat,
  };
}
