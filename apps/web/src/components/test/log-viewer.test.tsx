// SPDX-License-Identifier: Apache-2.0

/**
 * The journal's two empty bodies: a run that logged nothing says so plainly,
 * and only a journal whose filters hide every event offers to clear them. A row
 * draws its type as an icon and says it to assistive technology, its metadata
 * after the event. A tool row is named by the integration tool it reached, and
 * the inspector reads a call of the platform's `recall_memory` as the memories
 * it returned. The runner's consecutive lines read as one disclosure row.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type {
  ExecutionEntry,
  JournalGroup,
  JournalIntegrations,
  ToolExecutionEntry,
} from "../log-utils.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { LogEntryInspector, LogGroupRow, LogRow, LogViewer, ToolCallEvent } =
  await import("../log-viewer.tsx");
const { formatTimestamp } = await import("../log-utils.ts");
const { formatDuration } = await import("../../lib/format-duration.ts");
const { render } = await import("../../test/render.tsx");
const agentsFr = (await import("../../locales/fr/agents.json")).default;
const commonFr = (await import("../../locales/fr/common.json")).default;
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const NAMES: Record<string, string> = { "@acme/github": "GitHub" };
/** A resolved read: GitHub is known, any other integration keeps its id. */
const integrations: JournalIntegrations = (id) => ({ name: NAMES[id] ?? id, pending: false });

const message: ExecutionEntry = {
  id: "log_1",
  kind: "agent",
  level: "debug",
  message: "Je lis la boîte de réception.",
  createdAt: "2026-07-01T10:00:00.000Z",
};

describe("LogViewer — an empty journal", () => {
  it("says a run with no events has none, without offering to clear filters", () => {
    const html = render(
      <LogViewer entries={[]} integrations={integrations} onSelectEntry={() => {}} />,
    );
    expect(html).toContain(agentsFr["log.empty"]);
    expect(html).not.toContain(agentsFr["log.noMatches"]);
    expect(html).not.toContain(commonFr["toolbar.clearAll"]);
  });

  it("says no event matches when the filters hide every one", () => {
    const html = render(
      <LogViewer
        entries={[message]}
        integrations={integrations}
        onSelectEntry={() => {}}
        initialFocus="errors"
      />,
    );
    expect(html).toContain(agentsFr["log.noMatches"]);
    expect(html).toContain(commonFr["toolbar.clearAll"]);
    expect(html).not.toContain(agentsFr["log.empty"]);
  });
});

describe("LogViewer — the list", () => {
  it("is a named log that does not announce rows mounting as it scrolls", () => {
    const html = render(
      <LogViewer entries={[message]} integrations={integrations} onSelectEntry={() => {}} />,
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="off"');
    expect(html).toContain(`aria-label="${agentsFr["log.listLabel"]}"`);
  });

  it("draws rows on their way, not the empty state, while the journal is read", () => {
    const html = render(
      <LogViewer entries={[]} integrations={integrations} isLoading onSelectEntry={() => {}} />,
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain(agentsFr["log.empty"]);
  });
});

describe("LogRow — one event per line", () => {
  const search: ToolExecutionEntry = {
    id: "tool:call-9",
    kind: "tool",
    tool: "acme_docs__search",
    status: "success",
    durationMs: 1200,
    createdAt: "2026-07-01T10:00:00.000Z",
  };
  const row = (entry: ExecutionEntry, options: { open?: boolean; showTimestamp?: boolean } = {}) =>
    render(
      <LogRow
        entry={entry}
        integrations={integrations}
        showTimestamp={options.showTimestamp ?? false}
        open={options.open ?? false}
        inspectorId="journal-inspector"
        onToggle={() => {}}
      />,
    );
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  it("draws no type word, and says the type to assistive technology", () => {
    for (const [entry, type] of [
      [message, agentsFr["log.type.message"]],
      [search, agentsFr["log.type.tool"]],
    ] as const) {
      const html = row(entry);
      expect(html).toContain(`<span class="sr-only">${type}</span>`);
      expect(count(html, type)).toBe(1);
    }
  });

  it("puts a tool's duration after the event, and its time only on request", () => {
    const duration = formatDuration(1200);
    const time = formatTimestamp(search.createdAt, "fr");
    const html = row(search);
    expect(html.indexOf(duration)).toBeGreaterThan(html.indexOf("acme_docs__search"));
    expect(html).not.toContain(time);
    const timed = row(search, { showTimestamp: true });
    expect(timed.indexOf(time)).toBeGreaterThan(timed.indexOf(duration));
  });

  it("gives a message its time on request, and no duration", () => {
    const time = formatTimestamp(message.createdAt, "fr");
    const html = row(message, { showTimestamp: true });
    expect(html.indexOf(time)).toBeGreaterThan(html.indexOf(message.message));
    expect(row(message)).not.toContain(time);
  });

  it("says whether its inspector is open, and points at it only then", () => {
    const closed = row(search);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("aria-controls");
    const open = row(search, { open: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-controls="journal-inspector"');
    expect(open).not.toContain("aria-pressed");
  });
});

describe("LogGroupRow — the runner's lines folded into one row", () => {
  const step = (id: string, at: string): ExecutionEntry => ({
    id,
    kind: "runtime",
    level: "info",
    message: id,
    sourceType: "progress",
    createdAt: at,
  });
  const group: JournalGroup = {
    kind: "group",
    id: "group:a",
    entries: [
      step("a", "2026-07-01T10:00:00.000Z"),
      step("b", "2026-07-01T10:00:01.000Z"),
      step("c", "2026-07-01T10:00:03.000Z"),
    ],
  };
  const row = (expanded: boolean) =>
    render(
      <LogGroupRow group={group} showTimestamp={false} expanded={expanded} onToggle={() => {}} />,
    );

  it("counts its lines, and says whether they are shown", () => {
    const html = row(false);
    expect(html).toContain("3 étapes système");
    expect(html).toContain('aria-expanded="false"');
    expect(row(true)).toContain('aria-expanded="true"');
  });

  it("puts the time its lines took after the label", () => {
    const html = row(false);
    expect(html.indexOf(formatDuration(3000))).toBeGreaterThan(html.indexOf("3 étapes système"));
  });
});

describe("LogEntryInspector — an entry's type", () => {
  const tool = (status: "running" | "success"): ExecutionEntry => ({
    id: `tool_${status}`,
    kind: "tool",
    tool: "acme_docs__search",
    status,
  });
  const cases: [string, ExecutionEntry, string][] = [
    ["an agent message", message, agentsFr["log.type.message"]],
    ["a running tool", tool("running"), agentsFr["log.type.tool"]],
    ["a settled tool", tool("success"), agentsFr["log.type.tool"]],
    [
      "a line the agent wrote",
      { id: "log_2", kind: "log", level: "info", message: "Trois factures trouvées." },
      agentsFr["log.type.journal"],
    ],
    [
      "a runner event",
      { id: "log_3", kind: "runtime", level: "debug", message: "running", sourceType: "progress" },
      agentsFr["log.type.system"],
    ],
  ];

  for (const [name, entry, label] of cases) {
    it(`reads ${name} as ${label}`, () => {
      const html = render(
        <LogEntryInspector integrations={integrations} entry={entry} onClose={() => {}} />,
      );
      const type = html.match(
        new RegExp(`${agentsFr["log.filterType"]}</dt><dd[^>]*>([^<]*)</dd>`),
      );
      expect(type?.[1]).toBe(label);
    });
  }

  it("names a tool's state in its status, not in its type", () => {
    const html = render(
      <LogEntryInspector integrations={integrations} entry={tool("running")} onClose={() => {}} />,
    );
    expect(html).toContain(agentsFr["log.toolStatus.running"]);
  });
});

describe("LogEntryInspector — a platform tool's result", () => {
  const result = { content: [{ type: "text", text: '{"memories":[]}' }] };
  const recall = (integration?: { id: string; tool: string }): ExecutionEntry => ({
    id: "tool_1",
    kind: "tool",
    tool: "appstrate_platform__recall_memory",
    status: "success",
    args: { query: "relevé" },
    result,
    ...(integration ? { integration } : {}),
  });
  const inspect = (entry: ExecutionEntry) =>
    render(<LogEntryInspector integrations={integrations} entry={entry} onClose={() => {}} />);

  it("reads a call of the platform's recall_memory as the memories it returned", () => {
    const html = inspect(recall({ id: "@appstrate/platform", tool: "recall_memory" }));
    expect(html).toContain(agentsFr["log.recalledNone"]);
  });

  it("keeps the result as JSON for another integration's tool of the same name", () => {
    const html = inspect(recall({ id: "@acme/memory", tool: "recall_memory" }));
    expect(html).toContain(JSON.stringify(result, null, 2));
    expect(html).not.toContain(agentsFr["log.recalledNone"]);
  });

  it("keeps the result as JSON for a call recorded without identity", () => {
    const html = inspect(recall());
    expect(html).toContain(JSON.stringify(result, null, 2));
    expect(html).not.toContain(agentsFr["log.recalledNone"]);
  });
});

describe("ToolCallEvent and LogEntryInspector — a tool call's identity", () => {
  const github: ToolExecutionEntry = {
    id: "tool:call-1",
    kind: "tool",
    tool: "acme_github__list_issues_1a2b3c4d",
    status: "success",
    integration: { id: "@acme/github", tool: "list.issues", title: "List issues" },
  };
  const row = (entry: ToolExecutionEntry, resolve = integrations) =>
    render(<ToolCallEvent entry={entry} integrations={resolve} />);

  it("names the row by its integration and its server's title", () => {
    const html = row(github);
    expect(html).toContain("GitHub");
    expect(html).toContain("List issues");
    expect(html).not.toContain("acme_github__list_issues_1a2b3c4d");
  });

  it("names an integration the read does not know by its id", () => {
    const html = row({ ...github, integration: { id: "@gone/tracker", tool: "list.issues" } });
    expect(html).toContain("@gone/tracker");
    expect(html).toContain("list.issues");
  });

  it("draws placeholders, not the id, while the integrations are read", () => {
    const html = row(github, (id) => ({ name: id, pending: true }));
    expect(html).not.toContain("@acme/github");
    expect(html).toContain("animate-pulse");
    expect(html).toContain("List issues");
  });

  it("labels the runner's own tools, with no integration", () => {
    const html = row({ id: "tool:call-2", kind: "tool", tool: "output", status: "success" });
    expect(html).toContain(agentsFr["log.harness.output"]);
  });

  it("keeps the exposed name of a call recorded without identity", () => {
    const html = row({
      id: "tool:call-3",
      kind: "tool",
      tool: "acme_docs__search",
      status: "success",
    });
    expect(html).toContain("acme_docs__search");
  });

  it("keeps the technical name, the integration id and the server's name in the inspector", () => {
    const html = render(
      <LogEntryInspector integrations={integrations} entry={github} onClose={() => {}} />,
    );
    for (const label of [
      "log.filterIntegration",
      "log.integrationId",
      "log.upstreamTool",
      "log.technicalName",
    ] as const) {
      expect(html).toContain(agentsFr[label]);
    }
    for (const value of [
      "GitHub",
      "@acme/github",
      "list.issues",
      "acme_github__list_issues_1a2b3c4d",
    ]) {
      expect(html).toContain(value);
    }
  });
  it("does not repeat the server's name when it is already the tool's label", () => {
    const untitled: ToolExecutionEntry = {
      ...github,
      integration: { id: "@acme/github", tool: "list.issues" },
    };
    const html = render(
      <LogEntryInspector integrations={integrations} entry={untitled} onClose={() => {}} />,
    );
    expect(html).not.toContain(agentsFr["log.upstreamTool"]);
    expect(html).toContain(agentsFr["log.technicalName"]);
  });
});
