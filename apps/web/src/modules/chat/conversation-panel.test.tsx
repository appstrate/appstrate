// SPDX-License-Identifier: Apache-2.0

/**
 * The context panel. Closed, its reads wait (`active` false), and nothing it draws in the meantime
 * is an error or an empty list made up from a read that never ran. Open, the summary leads with
 * what failed, only when something did.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { renderInSpace, memberSpaceClient, testSpace } = await import("../../test/space-context.ts");
const { makeRun } = await import("../../test/run-fixture.ts");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { ConversationSummary } = await import("./conversation-summary.tsx");
const { ConversationFiles, ConversationRuns } = await import("./conversation-lists.tsx");
const { ConversationToolsList, ShownToolCall } = await import("./conversation-tools-tab.tsx");

await i18nReady;
await i18n.changeLanguage("fr");
await i18n.loadNamespaces(["chat", "common"]);

const spaces = [testSpace("spc_a", ["chat:read", "runs:read", "files:read"])];
const noop = () => {};

function closed(node: React.ReactElement): string {
  return renderInSpace(node, { queryClient: memberSpaceClient(spaces), overview: false });
}

describe("the context panel, closed", () => {
  const panes: [string, React.ReactElement][] = [
    ["Résumé", <ConversationSummary conversationId="chs_1" active={false} dispatch={noop} />],
    ["Runs", <ConversationRuns conversationId="chs_1" active={false} />],
    ["Fichiers", <ConversationFiles conversationId="chs_1" active={false} onSelect={noop} />],
    ["Outils", <ConversationToolsList conversationId="chs_1" active={false} onSelect={noop} />],
    [
      "un appel",
      <ShownToolCall
        conversationId="chs_1"
        toolCallId="call_1"
        active={false}
        missing={false}
        onBack={noop}
        onShowInThread={noop}
      />,
    ],
  ];

  for (const [name, pane] of panes) {
    it(`holds ${name} in its loading shape, never an error or an empty list`, () => {
      const html = closed(pane);
      expect(html).not.toContain(i18n.t("common:error.generic"));
      expect(html).not.toContain(i18n.t("chat:context.runs.empty"));
      expect(html).not.toContain(i18n.t("chat:context.files.empty"));
      expect(html).not.toContain(i18n.t("chat:context.tools.empty"));
      expect(html).not.toContain(i18n.t("chat:context.tools.gone"));
      // One `status` for the pane that waits.
      expect(html.split('role="status"').length - 1).toBe(1);
    });
  }
});

describe("the summary, open", () => {
  /** The summary once its conversation holds `parts` and its runs reads answered. */
  function summary(
    parts: unknown[],
    runs: unknown[],
    failedRuns: unknown[],
    active = true,
  ): string {
    const queryClient = memberSpaceClient(spaces);
    queryClient.setQueryData(
      ["get", "/api/orgs/{orgId}/chat/sessions/{id}", { params: { path: { id: "chs_1" } } }],
      {
        id: "chs_1",
        title: "Rapport",
        generating: false,
        unread: false,
        updatedAt: "2026-11-26T10:00:00.000Z",
        createdAt: "2026-11-26T09:00:00.000Z",
        spaceId: "spc_a",
        restricted: false,
        space_ids: ["spc_a"],
        usage: {},
        skills: { discovery: true, pins: [] },
        messages: [{ id: "msg_1", role: "assistant", parts }],
      },
    );
    const runsKey = (query: Record<string, unknown>) => [
      "get",
      "/api/orgs/{orgId}/runs",
      {
        params: {
          path: { orgId: "org_1" },
          query: { chat_session_id: "chs_1", limit: 3, ...query },
        },
      },
    ];
    const list = (data: unknown[]) => ({
      object: "list",
      data,
      total: data.length,
      hasMore: false,
    });
    queryClient.setQueryData(runsKey({}), list(runs));
    queryClient.setQueryData(runsKey({ status: ["failed", "timeout"] }), list(failedRuns));
    queryClient.setQueryData(
      [
        "get",
        "/api/orgs/{orgId}/files",
        {
          params: {
            path: { orgId: "org_1" },
            query: { context_chat_session_id: "chs_1", limit: 3 },
          },
        },
      ],
      { object: "list", data: [], hasMore: false },
    );
    return renderInSpace(
      <ConversationSummary conversationId="chs_1" active={active} dispatch={noop} />,
      {
        queryClient,
        overview: false,
      },
    );
  }

  const failedLookup = {
    type: "tool-search",
    toolCallId: "call_1",
    state: "output-error",
    input: { query: "gmail" },
    errorText: "boom",
  };

  it("leads with « À vérifier »: the failed runs, then the failed calls, a lookup included", () => {
    const failed = makeRun({ id: "run_7", runNumber: 7, status: "failed" });
    const html = summary([failedLookup], [failed], [failed]);
    expect(html).toContain("À vérifier");
    expect(html).toContain("#7");
    expect(html).toContain(i18n.t("chat:context.tools.status.error"));
    expect(html.indexOf("À vérifier")).toBeLessThan(html.indexOf(i18n.t("common:nav.runs")));
  });

  it("leaves « À vérifier » out when nothing failed", () => {
    const html = summary([], [makeRun({ id: "run_8", runNumber: 8 })], []);
    expect(html).not.toContain("À vérifier");
    expect(html).toContain("#8");
  });

  it("keeps what the cache holds while the panel closes: no skeleton, no read lost", () => {
    const html = summary([], [makeRun({ id: "run_9", runNumber: 9 })], [], false);
    expect(html).toContain("Rapport");
    expect(html).toContain("#9");
    expect(html).not.toContain('role="status"');
  });
});
