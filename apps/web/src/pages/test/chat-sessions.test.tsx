// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ChatPage } from "@appstrate/module-chat/ui";
import {
  sessionsQueryKey,
  type SessionSummary,
} from "../../../../../packages/module-chat/src/ui/sessions.ts";
import { render } from "../../test/render.tsx";

function conversation(id: string, title: string, unread: boolean): SessionSummary {
  return { id, title, unread, generating: false, updatedAt: "2026-09-05T10:00:00Z" };
}

describe("chat page session scope", () => {
  it("derives unread markers from the same space cache as its conversation list", () => {
    const qc = new QueryClient();
    qc.setQueryData(sessionsQueryKey("spc_a"), [
      conversation("chat_active", "Active conversation", true),
      conversation("chat_unread", "Unread in A", true),
      conversation("chat_read", "Read in A", false),
    ]);
    qc.setQueryData(sessionsQueryKey("spc_b"), [conversation("chat_other", "Only in B", true)]);

    // This SPA-only component reads visibility from the browser on render.
    // No DOM or effects are needed to observe its real query/provider wiring.
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "visible" },
    });
    let html: string;
    try {
      html = render(
        <ChatPage
          getHeaders={() => ({ "X-Space-Id": "spc_a" })}
          conversationId="chat_active"
          downloadFile={() => {}}
          useFileImageSrc={() => null}
          uploadFile={async () => "upload://unused"}
          t={(key) => key}
        />,
        { queryClient: qc },
      );
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }

    expect(html).toContain("Unread in A");
    expect(html).toContain("Read in A");
    expect(html).not.toContain("Only in B");
    // ChatPage computes this marker, while ThreadList reads its own query.
    // Seeing the row alone would miss an observer stranded outside the provider.
    expect(html.match(/aria-label="Réponse non lue"/g)).toHaveLength(1);
  });
});
