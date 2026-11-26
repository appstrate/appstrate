// SPDX-License-Identifier: Apache-2.0

/**
 * The context panel. Closed, its reads wait (`active` false), and nothing it draws in the meantime
 * is an error or an empty list made up from a read that never ran. Open, the summary leads with
 * what failed, only when something did, and each of its groups stands on its own read. The Tools
 * tab lists the calls by turn, lookups behind a switch, and a call's detail.
 */

import { cloneElement } from "react";
import { describe, expect, it } from "bun:test";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { renderInSpace, memberSpaceClient, testSpace } = await import("../../test/space-context.ts");
const { makeRun } = await import("../../test/run-fixture.ts");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { formatDuration } = await import("../../lib/format-duration.ts");
const { ConversationSummary } = await import("./conversation-summary.tsx");
const { ConversationFiles, ConversationRuns } = await import("./conversation-lists.tsx");
const { ConversationToolsList, ShownToolCall } = await import("./conversation-tools-tab.tsx");
const { publishLiveConversation, withdrawLiveConversation } =
  await import("@appstrate/module-chat/live-conversation");
const { ChatTransportProvider } = await import("@appstrate/module-chat/ui");

/** The chat's transport, so the conversation's own read is built as the page builds it. */
const TRANSPORT = {
  getHeaders: () => ({ "X-Space-Id": "spc_a" }),
  orgId: "org_1",
  spaceId: "spc_a",
  request: () => Promise.reject(new Error("no request in a static render")),
};

await i18nReady;
await i18n.changeLanguage("fr");
await i18n.loadNamespaces(["chat", "common"]);

const spaces = [testSpace("spc_a", ["chat:read", "runs:read", "files:read"])];
const noop = () => {};

/** The conversation as the server stores it, its assistant turns holding `turns`' parts. */
function seedConversation(queryClient: QueryClient, turns: unknown[][]) {
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
      messages: turns.map((parts, i) => ({ id: `msg_${i + 1}`, role: "assistant", parts })),
    },
  );
}

const runsKey = (query: Record<string, unknown>): QueryKey => [
  "get",
  "/api/orgs/{orgId}/runs",
  { params: { path: { orgId: "org_1" }, query: { chat_session_id: "chs_1", ...query } } },
];
const filesKey: QueryKey = [
  "get",
  "/api/orgs/{orgId}/files",
  {
    params: { path: { orgId: "org_1" }, query: { context_chat_session_id: "chs_1", limit: 3 } },
  },
];
const LATEST_RUNS = { limit: 3 };

const list = (data: unknown[], total = data.length) => ({
  object: "list",
  data,
  total,
  hasMore: false,
});

/** A read that failed: `data` kept when the cache held some (a refetch that failed). */
function failRead(queryClient: QueryClient, key: QueryKey, data?: unknown) {
  if (data !== undefined) queryClient.setQueryData(key, data);
  const query = queryClient.getQueryCache().build(queryClient, { queryKey: key });
  query.setState({
    ...query.state,
    status: "error",
    error: new Error("boom"),
    fetchStatus: "idle",
  });
}

/** The member's query client, recording the options every read of the tree is built with. */
function recordingClient() {
  const client = memberSpaceClient(spaces);
  const built: { key: string; enabled: unknown }[] = [];
  const defaults = client.defaultQueryOptions.bind(client);
  client.defaultQueryOptions = ((options: Parameters<typeof defaults>[0]) => {
    const defaulted = defaults(options);
    built.push({ key: JSON.stringify(defaulted.queryKey), enabled: defaulted.enabled });
    return defaulted;
  }) as typeof client.defaultQueryOptions;
  // The conversation's reads: their keys carry its id.
  const conversationReads = () => built.filter(({ key }) => key.includes("chs_1"));
  return { client, conversationReads };
}

function render(node: React.ReactElement, queryClient: QueryClient = memberSpaceClient(spaces)) {
  return renderInSpace(node, { queryClient, overview: false });
}

const rowsOf = (html: string) => html.split("min-h-14 w-full").length - 1;

/** A stored tool part: an action unless `lookup`, ran for `durationMs` when given. */
function toolPart(
  toolCallId: string,
  {
    lookup = false,
    state = "output-available",
    durationMs,
    tool = "invoke_operation",
  }: { lookup?: boolean; state?: string; durationMs?: number; tool?: string } = {},
) {
  return {
    type: `tool-${tool}`,
    toolCallId,
    state,
    input: { operation_id: toolCallId },
    ...(state === "output-available" ? { output: { ok: true } } : {}),
    ...(state === "output-error" ? { errorText: "boom" } : {}),
    ...(lookup ? { callProviderMetadata: { appstrate: { lookup: true } } } : {}),
    ...(durationMs === undefined ? {} : { resultProviderMetadata: { appstrate: { durationMs } } }),
  };
}

describe("the context panel, closed", () => {
  const panes: [string, React.ReactElement<{ active: boolean }>][] = [
    ["Résumé", <ConversationSummary conversationId="chs_1" active={false} dispatch={noop} />],
    ["Runs", <ConversationRuns conversationId="chs_1" active={false} />],
    ["Fichiers", <ConversationFiles conversationId="chs_1" active={false} onSelect={noop} />],
    [
      "Outils",
      <ConversationToolsList
        conversationId="chs_1"
        active={false}
        showLookups={false}
        onShowLookupsChange={noop}
        onSelect={noop}
      />,
    ],
    [
      "un appel",
      <ShownToolCall
        conversationId="chs_1"
        toolCallId="call_1"
        active={false}
        missing={false}
        from="list"
        onBack={noop}
        onShowInThread={noop}
      />,
    ],
  ];

  for (const [name, pane] of panes) {
    it(`holds ${name} in its loading shape, never an error or an empty list`, () => {
      const html = render(pane);
      expect(html).not.toContain(i18n.t("common:error.generic"));
      expect(html).not.toContain(i18n.t("chat:context.runs.empty"));
      expect(html).not.toContain(i18n.t("chat:context.files.empty"));
      expect(html).not.toContain(i18n.t("chat:context.tools.empty"));
      expect(html).not.toContain(i18n.t("chat:context.tools.gone"));
      // One `status` for the pane that waits.
      expect(html.split('role="status"').length - 1).toBe(1);
    });

    it(`builds every read of ${name} disabled while closed, and enables them once open`, () => {
      const withTransport = (node: React.ReactElement) => (
        <ChatTransportProvider value={TRANSPORT}>{node}</ChatTransportProvider>
      );
      const closed = recordingClient();
      render(withTransport(pane), closed.client);
      expect(closed.conversationReads().length).toBeGreaterThan(0);
      expect(closed.conversationReads().filter(({ enabled }) => enabled !== false)).toEqual([]);

      const open = recordingClient();
      render(withTransport(cloneElement(pane, { active: true })), open.client);
      expect(open.conversationReads().some(({ enabled }) => enabled === true)).toBe(true);
    });
  }
});

describe("the summary, open", () => {
  /** The summary once its conversation holds `parts` and its runs reads answered. */
  function summary(
    parts: unknown[],
    runs: unknown[],
    { active = true, prepare }: { active?: boolean; prepare?: (qc: QueryClient) => void } = {},
  ): string {
    const queryClient = memberSpaceClient(spaces);
    seedConversation(queryClient, [parts]);
    queryClient.setQueryData(runsKey(LATEST_RUNS), list(runs));
    queryClient.setQueryData(filesKey, { object: "list", data: [], hasMore: false });
    prepare?.(queryClient);
    return render(
      <ConversationSummary conversationId="chs_1" active={active} dispatch={noop} />,
      queryClient,
    );
  }

  it("draws « Intégrations » with the integration calls, lookups included, and never a platform call", () => {
    const html = summary(
      [
        toolPart("call_i", { tool: "call_integration_tool" }),
        toolPart("call_l", { tool: "call_integration_tool", lookup: true }),
        toolPart("call_p"),
        toolPart("call_s", { tool: "search", lookup: true }),
      ],
      [],
    );
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    // One line per integration call (the plug icon), none for the platform's own.
    expect(html.split("lucide-plug").length - 1).toBe(2);
    expect(html).not.toContain(i18n.t("chat:context.tabs.tools"));
  });

  it("leaves « Intégrations » out when only platform tools were called", () => {
    const html = summary([toolPart("call_p")], []);
    expect(html).not.toContain(i18n.t("chat:context.summary.integrations"));
    expect(html).toContain(i18n.t("chat:context.summary.noActivity"));
  });

  it("shows a failure on its own run and call line", () => {
    const failed = makeRun({ id: "run_7", runNumber: 7, status: "failed" });
    const failedCall = toolPart("call_f", { tool: "call_integration_tool", state: "output-error" });
    const html = summary([failedCall], [failed]);
    expect(html).toContain("#7");
    expect(html).toContain(i18n.t("chat:context.tools.status.error"));
  });

  it("keeps what the cache holds while the panel closes: no skeleton, no read lost", () => {
    const html = summary([], [makeRun({ id: "run_9", runNumber: 9 })], { active: false });
    expect(html).toContain("Rapport");
    expect(html).toContain("#9");
    expect(html).not.toContain('role="status"');
  });

  it("shows its calls at once while the runs are read, the runs waiting in their place", () => {
    const html = summary([toolPart("call_a", { tool: "call_integration_tool" })], [], {
      prepare: (qc) => qc.removeQueries({ queryKey: runsKey(LATEST_RUNS), exact: true }),
    });
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    expect(html.split('role="status"').length - 1).toBe(1);
  });

  it("says a failed read in its group alone, the other groups shown", () => {
    // Held closed: open, the read would be tried again on mount.
    const html = summary([toolPart("call_a", { tool: "call_integration_tool" })], [], {
      active: false,
      prepare: (qc) => {
        qc.removeQueries({ queryKey: runsKey(LATEST_RUNS), exact: true });
        failRead(qc, runsKey(LATEST_RUNS));
      },
    });
    expect(html).toContain(i18n.t("common:error.generic"));
    expect(html).toContain(i18n.t("chat:context.summary.integrations"));
    expect(html).toContain("Rapport");
  });

  it("keeps the runs it holds when their refetch fails", () => {
    const html = summary([], [], {
      prepare: (qc) => failRead(qc, runsKey(LATEST_RUNS), list([makeRun({ runNumber: 11 })])),
    });
    expect(html).toContain("#11");
    expect(html).not.toContain(i18n.t("common:error.generic"));
  });
});

describe("the Tools tab, open", () => {
  function tools(
    turns: unknown[][],
    { showLookups = false }: { showLookups?: boolean } = {},
  ): string {
    const queryClient = memberSpaceClient(spaces);
    seedConversation(queryClient, turns);
    return render(
      <ConversationToolsList
        conversationId="chs_1"
        active
        showLookups={showLookups}
        onShowLookupsChange={noop}
        onSelect={noop}
      />,
      queryClient,
    );
  }

  it("keeps the lookups behind its switch, which counts them", () => {
    const turns = [[toolPart("call_a"), toolPart("call_l1", { lookup: true })]];
    const hidden = tools([[...turns[0]!, toolPart("call_l2", { lookup: true })]]);
    expect(hidden).toContain(i18n.t("chat:context.tools.showLookups", { count: 2 }));
    expect(rowsOf(hidden)).toBe(1);
    const shown = tools([[...turns[0]!, toolPart("call_l2", { lookup: true })]], {
      showLookups: true,
    });
    expect(rowsOf(shown)).toBe(3);
  });

  it("lists the calls under their turn", () => {
    const html = tools([[toolPart("call_a")], [toolPart("call_b"), toolPart("call_c")]]);
    const first = html.indexOf(i18n.t("chat:context.tools.turn", { turn: 1 }));
    const second = html.indexOf(i18n.t("chat:context.tools.turn", { turn: 2 }));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(rowsOf(html.slice(first, second))).toBe(1);
    expect(rowsOf(html.slice(second))).toBe(2);
  });

  it("says how long a call ran on its row", () => {
    const html = tools([[toolPart("call_a", { durationMs: 1200 })]]);
    expect(html).toContain(formatDuration(1200));
  });

  it("reads the open chat's turn in flight: its call without outcome is running", () => {
    publishLiveConversation("chs_1", {
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          parts: [toolPart("call_live", { state: "input-available" })],
        },
      ] as never,
      running: true,
    });
    try {
      // Nothing stored: the live conversation alone answers.
      const html = render(
        <ConversationToolsList
          conversationId="chs_1"
          active
          showLookups={false}
          onShowLookupsChange={noop}
          onSelect={noop}
        />,
      );
      expect(html).toContain(i18n.t("chat:context.tools.status.running"));
      expect(html).not.toContain('role="status"');
    } finally {
      withdrawLiveConversation("chs_1");
    }
  });
});

describe("a call's detail", () => {
  function detail(toolCallId: string, from: "list" | "summary" = "list"): string {
    const queryClient = memberSpaceClient(spaces);
    seedConversation(queryClient, [
      [toolPart("call_a", { durationMs: 2500 }), toolPart("call_x", { state: "output-error" })],
    ]);
    return render(
      <ShownToolCall
        conversationId="chs_1"
        toolCallId={toolCallId}
        active
        missing={false}
        from={from}
        onBack={noop}
        onShowInThread={noop}
      />,
      queryClient,
    );
  }

  it("shows its outcome, its turn, its duration and its input", () => {
    const html = detail("call_a");
    expect(html).toContain(i18n.t("chat:context.tools.status.success"));
    expect(html).toContain(formatDuration(2500));
    expect(html).toContain(i18n.t("chat:tool.detail.input"));
    expect(html).toContain(i18n.t("chat:context.tools.showInThread"));
    expect(html).toContain(i18n.t("chat:context.tools.backToList"));
  });

  it("says what a failed call says", () => {
    const html = detail("call_x");
    expect(html).toContain(i18n.t("chat:context.tools.status.error"));
    expect(html).toContain(i18n.t("chat:tool.detail.error"));
    expect(html).toContain("boom");
  });

  it("leads back to the summary it was opened from", () => {
    expect(detail("call_a", "summary")).toContain(i18n.t("chat:context.backToSummary"));
  });

  it("says a call no longer in the conversation is gone, with its way back", () => {
    const html = detail("call_gone");
    expect(html).toContain(i18n.t("chat:context.tools.gone"));
    expect(html).toContain(i18n.t("chat:context.tools.backToList"));
  });
});
