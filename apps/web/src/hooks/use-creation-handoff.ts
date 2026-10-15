// SPDX-License-Identifier: Apache-2.0

import { chatDraftNavigationState, type CreationResource } from "../lib/creation-handoff";
import { useModalParam } from "./use-modal-param";

export function useCreationHandoff(resource: CreationResource, canCreate: boolean) {
  const param = useModalParam("create");

  const open = () => {
    if (canCreate) param.open(resource);
  };

  const openChat = (prompt: string) => {
    if (!canCreate) return;
    param.leave("/chat", chatDraftNavigationState(prompt));
  };

  return {
    isOpen: canCreate && param.value === resource,
    open,
    close: param.close,
    /** Leaves the chooser for the manual creation page. */
    leave: param.leave,
    openChat,
  };
}
