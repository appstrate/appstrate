// SPDX-License-Identifier: Apache-2.0

/** When the skills catalogue is read: where the conversation reaches, not wherever the chat acts. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationScopeProvider } from "../src/ui/conversation-scope.ts";
import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { useSkillCatalogue } from "../src/ui/use-skill-catalogue.ts";
import { transportOf } from "./fake-request.ts";

// The chat acts in spc_a and spc_b; only spc_b grants `skills:read`.
const host = {
  can: (permission: string) => permission === "skills:read",
  canIn: (spaceId: string, permission: string) =>
    spaceId === "spc_b" && permission === "skills:read",
  actingSpaceIds: ["spc_a", "spc_b"],
} as unknown as ChatHost;

function Readable() {
  const { readable } = useSkillCatalogue(transportOf(() => ({})));
  return <b data-readable={String(readable)} />;
}

function readable(originSpaceId: string, restricted: boolean): string {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatHostProvider value={host}>
        <ConversationScopeProvider value={{ originSpaceId, restricted, setRestricted: () => {} }}>
          <Readable />
        </ConversationScopeProvider>
      </ChatHostProvider>
    </QueryClientProvider>,
  );
  return html.match(/data-readable="(\w+)"/)![1]!;
}

describe("the skills catalogue of a conversation", () => {
  it("is read, unlimited, when some space where the chat acts grants it", () => {
    expect(readable("spc_a", false)).toBe("true");
  });

  it("is read, limited, only when the origin space grants it", () => {
    expect(readable("spc_b", true)).toBe("true");
    expect(readable("spc_a", true)).toBe("false");
  });
});
