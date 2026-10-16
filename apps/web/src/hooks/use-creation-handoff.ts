// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { chatDraftNavigationState, type CreationResource } from "../lib/creation-handoff";
import { useUrlModal } from "./use-url-modal";

export function useCreationHandoff(resource: CreationResource, canCreate: boolean) {
  const param = useUrlModal("create");
  const navigate = useNavigate();

  const open = () => {
    if (canCreate) param.open(resource);
  };

  const openChat = (prompt: string) => {
    if (!canCreate) return;
    navigate("/chat", { replace: true, state: chatDraftNavigationState(prompt) });
  };

  return {
    isOpen: canCreate && param.value === resource,
    open,
    close: param.close,
    /** Leaves the chooser for the manual creation page. */
    leave: (to: string) => navigate(to, { replace: true }),
    openChat,
  };
}
