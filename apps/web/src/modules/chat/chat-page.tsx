// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the chat module page — the UI itself lives in the
// module package (`@appstrate/module-chat/ui`); this wrapper is the ONLY place
// the shell imports the module, and it injects everything the module needs:
// scoping headers, navigation, the document services (preview, authenticated
// download, authenticated image preview, staged upload) and the translator.
// Lazy-loaded behind `features.chat`.

import { useCallback, useEffect, useReducer, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChatPage, type OpenDocument } from "@appstrate/module-chat/ui";
import { buildScopingHeaders } from "../../lib/scoping-headers";
import { useSidebarStore } from "../../stores/sidebar-store";
import { DocumentPreview } from "../../components/document-preview";
import { useDocumentDownload, useDocumentImageSrc } from "../../hooks/use-documents";
import { useUploadClient } from "../../hooks/use-upload";
import {
  INITIAL_ARTIFACT_PRESENTATION_STATE,
  artifactPresentationReducer,
  visibleArtifact,
} from "./artifact-presentation";
import { ChatDocumentPanel } from "./document-panel";

const DESKTOP_ARTIFACT_QUERY = "(min-width: 1024px)";

/** Wide enough for chat + artefact side by side without an overlay. */
function useDesktopArtifactLayout(): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_ARTIFACT_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_ARTIFACT_QUERY);
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return matches;
}

export function ChatModulePage() {
  // Auto-collapse the global sidebar while in chat, restore on leave (same
  // pattern as settings/profile). Transient setter leaves the user's persisted
  // preference untouched.
  useEffect(() => {
    const { open, setOpenTransient } = useSidebarStore.getState();
    const prev = open;
    setOpenTransient(false);
    return () => {
      useSidebarStore.getState().setOpenTransient(prev);
    };
  }, []);
  // Conversation id lives in the URL (`/chat/:conversationId`) so a refresh or
  // deep-link restores the open conversation. `replace` keeps message/title
  // updates out of the back-history.
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const [artifactState, dispatchArtifact] = useReducer(
    artifactPresentationReducer,
    INITIAL_ARTIFACT_PRESENTATION_STATE,
  );
  const desktopArtifactLayout = useDesktopArtifactLayout();
  // `location.key` is unique per history entry. The chat mints a fresh
  // conversation id whenever it changes (a new-chat navigation: "+", the nav
  // link, or deleting the active one), so a brand-new conversation is created
  // lazily on its first message (ChatGPT-style) without ever resurfacing the
  // previous one on a bare `/chat`.
  const location = useLocation();
  const onConversationChange = useCallback(
    (id: string | null) => {
      dispatchArtifact({ type: "reset" });
      navigate(id ? `/chat/${id}` : "/chat", { replace: true });
    },
    [navigate],
  );
  // Scoping headers + the active UI language, so the assistant replies in the
  // language the user actually reads (the server defaults to fr without it).
  // Reads `i18n.language` at call time — the transport invokes this per
  // request, so a language switch applies to the next send.
  //
  // The same namespace's `t` is injected into the module, so the shell AROUND
  // those answers speaks the same language too — labels and aria-labels alike.
  const { t, i18n } = useTranslation("chat");
  const getHeaders = useCallback(
    () => ({ ...buildScopingHeaders(), "X-Chat-Locale": i18n.language }),
    [i18n],
  );
  const translate = useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params ?? {}),
    [t],
  );
  // One presentation interface for both direct clicks and automatic primary
  // outputs. The reducer keeps user intent authoritative and refuses automatic
  // overlays on compact layouts; module-chat never learns any shell UI state.
  const presentDocument = useCallback<OpenDocument>(
    (doc, options) => {
      dispatchArtifact({
        type: "present",
        presentation: {
          doc,
          trigger: options.trigger,
          navigationKey: location.key,
        },
        automaticPresentationAllowed: desktopArtifactLayout,
      });
    },
    [desktopArtifactLayout, location.key],
  );
  const artifact = visibleArtifact(artifactState, location.key);
  const closeArtifact = useCallback(() => dispatchArtifact({ type: "close" }), []);

  // Browser back/forward bypasses the chat's selection callback. Clear from the
  // popstate callback (not an effect body) so returning to an old entry never
  // resurrects an artefact the user did not explicitly reopen.
  useEffect(() => {
    const onHistoryNavigation = () => dispatchArtifact({ type: "reset" });
    window.addEventListener("popstate", onHistoryNavigation);
    return () => window.removeEventListener("popstate", onHistoryNavigation);
  }, []);
  // Document services the module consumes instead of reimplementing: the typed
  // download (reports failures with a toast) and the typed image preview.
  const downloadDocument = useDocumentDownload();
  const onDownloadDocument = useCallback(
    (id: string, name: string) => void downloadDocument(id, name),
    [downloadDocument],
  );
  // The very same uploader every SchemaForm file field uses — including its
  // refresh of the org storage gauge. The chat composer stages files through
  // it instead of re-implementing the 2-step upload.
  const uploadFile = useUploadClient();
  // The chat's tools (run agents, inspect runs, search…) are served by the
  // `mcp` module, which is a hard peer requirement of `chat` (enforced at
  // boot) — so tools are always available when the chat is reachable.
  // Bound the chat to the viewport height below the app shell's h-16 header so
  // the thread scrolls internally and the composer stays pinned (sticky) at the
  // bottom. Without a definite height here the flex chain grows with the message
  // list and the composer scrolls off-screen.
  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 min-w-0">
      <div className="min-w-0 flex-1">
        <ChatPage
          getHeaders={getHeaders}
          conversationId={conversationId ?? null}
          newChatKey={location.key}
          onConversationChange={onConversationChange}
          onOpenDocument={presentDocument}
          hideConversationList={desktopArtifactLayout && artifact !== null}
          downloadDocument={onDownloadDocument}
          useDocumentImageSrc={useDocumentImageSrc}
          uploadFile={uploadFile}
          t={translate}
        />
      </div>
      {desktopArtifactLayout && artifact ? (
        <ChatDocumentPanel doc={artifact.doc} onClose={closeArtifact} />
      ) : null}
      {!desktopArtifactLayout && artifact?.trigger === "manual" ? (
        <DocumentPreview doc={artifact.doc} onClose={closeArtifact} />
      ) : null}
    </div>
  );
}
