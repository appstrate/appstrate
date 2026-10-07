// SPDX-License-Identifier: Apache-2.0

/**
 * A URL naming a conversation the caller does not have (deleted, or someone
 * else's): the page says so and mounts NO composer. `POST /api/chat` creates a
 * session for any id it does not know, so a composer there re-created the
 * deleted conversation under its old id on the first send.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ChatPage } from "../src/ui/index.tsx";
import { sessionQueryKey } from "../src/ui/sessions.ts";

// `ChatPage` reads the tab's visibility during render; SSR has no `document`.
const realDocument: unknown = Reflect.get(globalThis, "document");
beforeAll(() => {
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  });
});
afterAll(() => {
  if (realDocument === undefined) Reflect.deleteProperty(globalThis, "document");
  else Object.assign(globalThis, { document: realDocument });
});

const getHeaders = () => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" });

/** Seeds the history read, so the render is the answer and not a fetch. */
function render(history: unknown, can: (permission: string) => boolean): string {
  const qc = new QueryClient();
  qc.setQueryData(sessionQueryKey("spc_a", "chs_gone"), history);
  return renderToString(
    <QueryClientProvider client={qc}>
      <ChatPage
        getHeaders={getHeaders}
        conversationId="chs_gone"
        onConversationChange={() => {}}
        downloadFile={() => {}}
        useFileImageSrc={() => null}
        uploadFile={async () => "upload://upl_1"}
        t={(key) => key}
        can={can}
      />
    </QueryClientProvider>,
  );
}

describe("a conversation URL the caller has no conversation for", () => {
  it("says the conversation was not found and offers no composer", () => {
    const html = render(null, () => true);
    expect(html).toContain('data-testid="chat-conversation-not-found"');
    expect(html).toContain("conversation.notFound.title");
    expect(html).toContain("threads.new");
    expect(html).not.toContain("composer.placeholder");
  });

  it("offers no new conversation to a caller who cannot write", () => {
    const html = render(null, (permission) => permission === "chat:read");
    expect(html).toContain("conversation.notFound.title");
    expect(html).not.toContain("threads.new");
  });

  it("never calls a conversation minted on this page not found", () => {
    // Bare `/chat`: the id is minted here and has no row until its first turn
    // is admitted. A refused first send leaves the list row behind, and the
    // history reconcile then writes its 404 (`null`) into this cache entry —
    // which must not replace the user's message, its error and Retry.
    const qc = new QueryClient();
    qc.setQueryDefaults(["chat", "session"], { initialData: null });
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <ChatPage
          getHeaders={getHeaders}
          conversationId={null}
          onConversationChange={() => {}}
          downloadFile={() => {}}
          useFileImageSrc={() => null}
          uploadFile={async () => "upload://upl_1"}
          t={(key) => key}
          can={() => true}
        />
      </QueryClientProvider>,
    );
    expect(html).not.toContain("conversation.notFound.title");
    expect(html).toContain("composer.placeholder");
  });

  it("still mounts the composer for a conversation that exists", () => {
    // Guards the assertions above: the harness does render the thread.
    const html = render(
      { messages: [], skills: { skillMode: "auto", pinnedSkills: [] } },
      () => true,
    );
    expect(html).not.toContain("conversation.notFound.title");
    expect(html).toContain("composer.placeholder");
  });
});
