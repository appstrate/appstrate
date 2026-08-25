// SPDX-License-Identifier: Apache-2.0

import { useLocation, useNavigate } from "react-router-dom";
import {
  chatDraftNavigationState,
  creationResourceFromSearch,
  creationSearch,
  type CreationResource,
} from "../lib/creation-handoff";

export function useCreationHandoff(resource: CreationResource, canCreate: boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  const requested = creationResourceFromSearch(location.search) === resource;

  const open = () => {
    if (!canCreate) return;
    navigate(
      {
        pathname: location.pathname,
        search: creationSearch(location.search, resource),
        hash: location.hash,
      },
      { state: location.state },
    );
  };

  const close = () =>
    navigate(
      {
        pathname: location.pathname,
        search: creationSearch(location.search, null),
        hash: location.hash,
      },
      { replace: true, state: location.state },
    );

  const openChat = (prompt: string) => {
    if (!canCreate) return;
    navigate("/chat", { state: chatDraftNavigationState(prompt) });
  };

  return { isOpen: canCreate && requested, open, close, openChat };
}
