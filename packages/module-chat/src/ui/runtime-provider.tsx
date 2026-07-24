// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the whole host→module injection seam in one wrapper, so `ChatPage`
 * mounts a single provider instead of a stack of nested ones and adding a
 * service later touches this file only.
 *
 * Every value is passed straight through from a prop (never constructed inline
 * here), so a consumer only re-renders when the host actually changes that
 * service.
 */

import type { ReactNode } from "react";
import {
  ChatHeadersProvider,
  ChatTranslateProvider,
  DocumentImageSrcProvider,
  DownloadDocumentProvider,
  MaxUploadBytesProvider,
  OpenDocumentProvider,
  SelectConversationProvider,
  UploadFileProvider,
} from "./runtime-context.ts";
import type {
  ChatTranslate,
  DownloadDocument,
  GetHeaders,
  OpenDocument,
  SelectConversation,
  UploadFile,
  UseDocumentImageSrc,
} from "./runtime-context.ts";

export function ChatRuntimeProvider({
  getHeaders,
  selectConversation,
  openDocument,
  downloadDocument,
  useDocumentImageSrc,
  uploadFile,
  maxUploadBytes,
  t,
  children,
}: {
  getHeaders: GetHeaders | null;
  selectConversation: SelectConversation | null;
  openDocument: OpenDocument | null;
  downloadDocument: DownloadDocument;
  useDocumentImageSrc: UseDocumentImageSrc;
  uploadFile: UploadFile;
  maxUploadBytes: number;
  t: ChatTranslate;
  children: ReactNode;
}) {
  return (
    <ChatHeadersProvider value={getHeaders}>
      <ChatTranslateProvider value={t}>
        <SelectConversationProvider value={selectConversation}>
          <OpenDocumentProvider value={openDocument}>
            <DownloadDocumentProvider value={downloadDocument}>
              <DocumentImageSrcProvider value={useDocumentImageSrc}>
                <UploadFileProvider value={uploadFile}>
                  <MaxUploadBytesProvider value={maxUploadBytes}>{children}</MaxUploadBytesProvider>
                </UploadFileProvider>
              </DocumentImageSrcProvider>
            </DownloadDocumentProvider>
          </OpenDocumentProvider>
        </SelectConversationProvider>
      </ChatTranslateProvider>
    </ChatHeadersProvider>
  );
}
