// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ChatConversationList, ChatHeadersProvider } from "@appstrate/module-chat/ui";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import {
  sessionsQueryKey,
  type SessionsCache,
  type SessionSummary,
} from "../../../../../packages/module-chat/src/ui/sessions.ts";
import {
  ChatHostProvider,
  type ChatHost,
} from "../../../../../packages/module-chat/src/ui/runtime-context.ts";
import { FileAttachment } from "../../../../../packages/module-chat/src/ui/file-attachment.tsx";
import { ChatRunProgressCard } from "../../../../../packages/module-chat/src/ui/chat-run-progress-card.tsx";
import { render } from "../../test/render.tsx";

function conversation(id: string, title: string, unread: boolean): SessionSummary {
  return { id, title, unread, generating: false, updatedAt: "2026-09-05T10:00:00Z" };
}

/** One loaded page, as the session-list infinite query caches it. */
function cache(data: SessionSummary[]): SessionsCache {
  return { pages: [{ data, hasMore: false }], pageParams: [null] };
}

/**
 * Render the conversation list as the chat shell mounts it. The list is the
 * shell's navigation, not part of `ChatPage`; the headers provider is what
 * scopes the sessions query to one space. Its visibility read needs a document,
 * no DOM or effects.
 */
function renderConversationList(qc: QueryClient, can: (permission: string) => boolean): string {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible" },
  });
  try {
    return render(
      <SidebarProvider>
        <ChatHeadersProvider value={() => ({ "X-Space-Id": "spc_a" })}>
          <ChatConversationList activeId="chat_active" t={(key) => key} can={can} />
        </ChatHeadersProvider>
      </SidebarProvider>,
      { queryClient: qc },
    );
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

function hostWith(granted: string[]): ChatHost {
  return {
    openFile: () => {},
    downloadFile: () => {},
    useFileImageSrc: () => "blob:thumbnail",
    t: (key) => key,
    can: (permission) => granted.includes(permission),
    personalModelCredentials: true,
    formatBytes: String,
  };
}

describe("chat page session scope", () => {
  it("derives unread markers from the same space cache as its conversation list", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      sessionsQueryKey("spc_a"),
      cache([
        conversation("chat_active", "Active conversation", true),
        conversation("chat_unread", "Unread in A", true),
        conversation("chat_read", "Read in A", false),
      ]),
    );
    qc.setQueryData(
      sessionsQueryKey("spc_b"),
      cache([conversation("chat_other", "Only in B", true)]),
    );

    const html = renderConversationList(qc, () => true);

    expect(html).toContain("Unread in A");
    expect(html).toContain("Read in A");
    expect(html).not.toContain("Only in B");
    // The unread dot lives in the list itself, and the test injects an identity
    // `t`, so the rendered label is the KEY. Counting it is what proves the
    // marker is derived from the same scoped query as the rows beside it —
    // `chat_active` is excluded because looking at a thread reads it.
    expect(html.match(/aria-label="threads\.unread"/g)).toHaveLength(1);
  });
});

describe("chat surfaces held to the caller's grants", () => {
  it("tells a read-only caller with no conversations nothing about sending one", () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionsQueryKey("spc_a"), cache([]));

    const readOnly = renderConversationList(qc, (p) => p === "chat:read");
    expect(readOnly).toContain("threads.emptyReadOnly");
    expect(readOnly).not.toContain("threads.empty<");

    const writer = renderConversationList(qc, (p) => p === "chat:read" || p === "chat:write");
    expect(writer).toContain("threads.empty<");
  });

  it("offers no preview, download or thumbnail of a file without files:read", () => {
    const file = { id: "file_1", name: "report.png", mime: "image/png" };
    const denied = render(
      <ChatHostProvider value={hostWith([])}>
        <FileAttachment file={file} />
      </ChatHostProvider>,
    );
    expect(denied).toContain("report.png");
    expect(denied).toContain('title="file.noAccess"');
    expect(denied).not.toContain("<button");
    expect(denied).not.toContain("blob:thumbnail");

    const granted = render(
      <ChatHostProvider value={hostWith(["files:read"])}>
        <FileAttachment file={file} />
      </ChatHostProvider>,
    );
    expect(granted).toContain("<button");
    expect(granted).toContain("blob:thumbnail");
  });

  it("says a live run is out of reach instead of starting forever", () => {
    const card = (granted: string[]) =>
      render(
        <ChatHostProvider value={hostWith(granted)}>
          <ChatRunProgressCard
            runId="run_1"
            initialStatus="running"
            runHref="/agents/@acme/bot/runs/run_1"
            phase="success"
            modalTitle="run"
            details={null}
          />
        </ChatHostProvider>,
      );

    const denied = card([]);
    expect(denied).toContain("run.noAccess");
    expect(denied).not.toContain("run.starting");
    expect(denied).not.toContain('title="run.openPage"');

    const granted = card(["runs:read"]);
    expect(granted).toContain("run.starting");
    expect(granted).toContain('title="run.openPage"');
  });
});
