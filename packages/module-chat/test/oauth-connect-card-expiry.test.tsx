// SPDX-License-Identifier: Apache-2.0

/**
 * #1830: a started run's connect offer is minted at launch but its card shows
 * when the run ends, by which time the link may have lapsed. An expired card
 * says so and offers no button. SSR only, like `reasoning-group.test.tsx`.
 */

import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";

import { ChatHostProvider, type ChatHost } from "../src/ui/runtime-context.ts";
import { OAuthConnectCard } from "../src/ui/oauth-connect-card.tsx";

type ChatHelpers = Parameters<typeof useAISDKRuntime>[0];

const noop = async () => {};
const helpers: ChatHelpers = {
  id: "chat_1",
  messages: [],
  status: "ready",
  setMessages: () => {},
  sendMessage: noop,
  regenerate: noop,
  stop: noop,
  resumeStream: noop,
  addToolResult: noop,
  addToolOutput: noop,
  addToolApprovalResponse: noop,
  clearError: () => {},
};

const host: ChatHost = {
  openFile: () => {},
  downloadFile: () => {},
  useFileImageSrc: () => null,
  t: (key) => key,
  can: () => false,
  formatBytes: String,
};

function Card({ expiresAt }: { expiresAt?: string }) {
  const runtime = useAISDKRuntime(helpers);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <OAuthConnectCard
        authUrl="https://app/api/integrations/connect/start?token=t"
        packageId="@appstrate/gmail"
        runStarted
        expiresAt={expiresAt}
      />
    </AssistantRuntimeProvider>
  );
}

const render = (expiresAt?: string) =>
  renderToString(
    <ChatHostProvider value={host}>
      <Card expiresAt={expiresAt} />
    </ChatHostProvider>,
  );

describe("OAuthConnectCard expiry", () => {
  it("shows a lapsed link as expired, with no connect button", () => {
    const html = render(new Date(Date.now() - 1000).toISOString());
    expect(html).toContain("connect.expired");
    expect(html).not.toContain("<button");
  });

  it("keeps the connect button while the link is live, or when its expiry is unknown", () => {
    for (const expiresAt of [new Date(Date.now() + 60_000).toISOString(), undefined]) {
      const html = render(expiresAt);
      expect(html).toContain("connect.start");
      expect(html).not.toContain("connect.expired");
    }
  });
});
