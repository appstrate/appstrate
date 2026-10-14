// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { chatDraftNavigationState, type CreationResource } from "../lib/creation-handoff";
import { useModalParam } from "./use-modal-param";

export function useCreationHandoff(resource: CreationResource, canCreate: boolean) {
  const navigate = useNavigate();
  const param = useModalParam("create");

  const open = () => {
    if (canCreate) param.open(resource);
  };

  const openChat = (prompt: string) => {
    if (!canCreate) return;
    navigate("/chat", { state: chatDraftNavigationState(prompt) });
  };

  return { isOpen: canCreate && param.value === resource, open, close: param.close, openChat };
}
