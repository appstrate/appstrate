// SPDX-License-Identifier: Apache-2.0

/**
 * Agent run panel (Claude Cowork style) — the right rail dedicated to what the
 * chat *launches* in Appstrate. A conversation can fire several agents, so we
 * render one collapsible card per run (the newest open by default), each
 * surfacing universal families:
 *
 *   - header     — agent name + status + duration    (GET /api/runs/:id)
 *   - Journal    — progress log, preview + full       (GET /api/runs/:id/logs)
 *   - Connexions — integrations actually used          (connections_used)
 *   - Capacités  — declared skills/MCP/integrations    (GET /api/agents — list)
 *
 * Pure front, zero new backend: REST calls to existing endpoints, derived from
 * thread state. Expand/collapse uses the native <details> element. Running runs
 * stream their journal + status live over SSE (see useRunEvents).
 */

import { useEffect, useMemo, useState } from "react";
import { useAuiState, ThreadPrimitive } from "@assistant-ui/react";
import { useRunEvents } from "./run-events.ts";
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Link2Icon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import type { GetHeaders } from "./sessions.ts";

// Only the fields this panel reads (subset of the API's EnrichedRun shape).
interface RunConnectionUsed {
  integration_id: string;
  account_id: string | null;
}

interface RunInfo {
  status: string;
  /** Technical agent id (`@scope/slug`) — used to match the agent list. */
  packageId: string;
  /** Display name (may differ from the slug) — used for the header label. */
  agent_name: string | null;
  version_ref: string;
  duration: number | null;
  runNumber: number | null;
  package_ephemeral?: boolean;
  connections_used: RunConnectionUsed[] | null;
}

interface LogEntry {
  id: number;
  level: string;
  type?: string;
  message?: string;
  event?: string;
  /** Structured payload — carries tool-call `args`, `output`, report `content`. */
  data?: Record<string, unknown> | null;
}

/** One curated journal line: an agent step, with tool args when it's a call. */
interface JournalEntry {
  id: number;
  level: string;
  text: string;
  detail?: string;
}

/** Declared capabilities from the agent manifest (getAgent dependencies). */
interface AgentCaps {
  integrations: string[];
  skills: string[];
  mcp: string[];
  /** Built-in runtime tools opted into (`manifest.runtime_tools`) — incl. log/report. */
  runtimeTools: string[];
}

const PREVIEW = 3; // journal entries shown before the "Voir tout" toggle.

const LEVEL_DOT: Record<string, string> = {
  warn: "bg-amber-500",
  error: "bg-destructive",
};

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "En attente", cls: "text-muted-foreground" },
  running: { label: "En cours", cls: "text-muted-foreground" },
  success: { label: "Succès", cls: "text-primary" },
  failed: { label: "Échec", cls: "text-destructive" },
  timeout: { label: "Expiré", cls: "text-destructive" },
  cancelled: { label: "Annulé", cls: "text-muted-foreground" },
};

/**
 * Every run the assistant launched, in order, read from the thread's
 * wait_for_run calls (deduped by runId, latest status kept). Returns a JSON
 * string from the selector (stable primitive — avoids re-render loops).
 */
export function useThreadRuns(): { runId: string; status?: string }[] {
  const encoded = useAuiState((s) => {
    const messages = s.thread.messages ?? [];
    const status = new Map<string, string | undefined>();
    const order: string[] = [];
    for (const m of messages) {
      for (const p of m?.content ?? []) {
        if (!p || p.type !== "tool-call" || p.toolName !== "wait_for_run") continue;
        const runId = (p.args as { run_id?: string } | undefined)?.run_id;
        if (!runId) continue;
        if (!status.has(runId)) order.push(runId);
        status.set(runId, (p.result as { status?: string } | undefined)?.status);
      }
    }
    return JSON.stringify(order.map((runId) => ({ runId, status: status.get(runId) })));
  });
  return JSON.parse(encoded) as { runId: string; status?: string }[];
}

async function fetchRun(getHeaders: GetHeaders, runId: string): Promise<RunInfo> {
  const res = await fetch(`/api/runs/${runId}`, { headers: { ...getHeaders?.() } });
  if (!res.ok) throw new Error(`/api/runs/${runId} returned ${res.status}`);
  return (await res.json()) as RunInfo;
}

/**
 * The run's full log trace (all levels). We fetch debug too — that's where the
 * agent's tool calls live; `buildJournal` curates them down to the meaningful
 * steps and pulls out the result.
 */
async function fetchLogs(getHeaders: GetHeaders, runId: string): Promise<LogEntry[]> {
  const res = await fetch(`/api/runs/${runId}/logs`, { headers: { ...getHeaders?.() } });
  if (!res.ok) throw new Error(`logs ${res.status}`);
  const body: unknown = await res.json();
  const rows = Array.isArray(body) ? body : ((body as { data?: LogEntry[] }).data ?? []);
  return rows as LogEntry[];
}

/** Render tool-call args inline, à la apps/web's formatToolArgs (capped). */
function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  const joined = parts.join(", ");
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined;
}

// Platform boot breadcrumbs (emitted by the runtime itself, not the agent).
// This list is small + stable because it's OUR runtime code — unlike agent
// tools, which are dynamic and can't be enumerated. Used to keep the system
// chatter out of the human "Activité" view.
const SYSTEM_NOISE =
  /^(runtime (starting|ready|adapter)|workspace initialized|bundle loaded|connecting to sidecar|MCP connected|shared workspace available|MITM |@[^:]+:)/i;

/**
 * Split raw logs into what a non-technical user cares about vs the machine
 * trace. `activity` = the agent's OWN human messages (the `log` runtime tool:
 * "a progress message to the user", + notes) — no interpretation by us, it's
 * the agent (an LLM) narrating itself. `technical` = tool calls + platform boot
 * breadcrumbs. `output`/`report` are the agent's result artifacts (the chat
 * already interprets the result, so we keep these in the technical fold).
 */
function buildJournal(logs: LogEntry[]): {
  activity: JournalEntry[];
  technical: JournalEntry[];
  output: Record<string, unknown> | null;
  report: string | null;
} {
  const activity: JournalEntry[] = [];
  const technical: JournalEntry[] = [];
  let output: Record<string, unknown> | null = null;
  const reportChunks: string[] = [];
  for (const log of logs) {
    const data = (log.data ?? {}) as Record<string, unknown>;
    if (log.event === "output" && log.data) {
      output = { ...(output ?? {}), ...data };
      continue;
    }
    if (log.event === "report" && log.type === "result") {
      const content = (data as { content?: unknown }).content;
      if (typeof content === "string") reportChunks.push(content);
      continue;
    }
    if (log.event === "run_completed" || log.type === "result") continue;

    const args = data.args as Record<string, unknown> | undefined;
    const text = (data.message as string) || log.message || log.event || "";
    if (args) {
      // A tool call — the machine action. Technical.
      technical.push({
        id: log.id,
        level: log.level,
        text: text || "Appel d'outil",
        detail: formatToolArgs(args),
      });
    } else if (!text || log.level === "debug") {
      continue;
    } else if (log.type === "progress" && !SYSTEM_NOISE.test(text)) {
      // A plain progress message that isn't a platform breadcrumb → the agent's
      // own words to the user.
      activity.push({ id: log.id, level: log.level, text });
    } else {
      technical.push({ id: log.id, level: log.level, text });
    }
  }
  return {
    activity,
    technical,
    output,
    report: reportChunks.length ? reportChunks.join("\n") : null,
  };
}

/**
 * Declared capabilities, keyed by agent id. There is no single-agent GET
 * endpoint (only sub-routes), but the agent list already carries `dependencies`
 * per agent — so we read the list ONCE for the whole panel and match each card
 * on its run's `packageId` (the run's `agent_name` is a display name, not the
 * slug, so it can't be used here).
 */
interface AgentListItem {
  id: string;
  dependencies?: { skills?: object; mcp_servers?: object; integrations?: object };
  runtime_tools?: string[];
}
async function fetchCapsLookup(getHeaders: GetHeaders): Promise<Map<string, AgentCaps>> {
  const res = await fetch("/api/agents", { headers: { ...getHeaders?.() } });
  if (!res.ok) throw new Error(`agents ${res.status}`);
  const body: unknown = await res.json();
  const rows = (
    Array.isArray(body) ? body : ((body as { data?: AgentListItem[] }).data ?? [])
  ) as AgentListItem[];
  const lookup = new Map<string, AgentCaps>();
  for (const a of rows) {
    lookup.set(a.id, {
      integrations: Object.keys(a.dependencies?.integrations ?? {}),
      skills: Object.keys(a.dependencies?.skills ?? {}),
      mcp: Object.keys(a.dependencies?.mcp_servers ?? {}),
      runtimeTools: a.runtime_tools ?? [],
    });
  }
  return lookup;
}

const shortId = (id: string) => id.replace(/^@[^/]+\//, "");

export function AgentRunPanel({
  getHeaders,
  railClass,
}: {
  getHeaders: GetHeaders;
  railClass: string;
}) {
  const runs = useThreadRuns();
  const [caps, setCaps] = useState<Map<string, AgentCaps> | null>(null);

  // The agent list is shared by every card — fetch it once when runs exist.
  useEffect(() => {
    if (runs.length === 0) return;
    let cancelled = false;
    void fetchCapsLookup(getHeaders)
      .then((l) => !cancelled && setCaps(l))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runs.length, getHeaders]);

  // Always render the rail (header + body) so the panel toggle opens a real
  // panel even before any agent runs — empty state instead of vanishing.
  return (
    <div className={`${railClass} min-h-0 overflow-hidden`}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <BotIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="flex-1 text-sm font-medium">Agents lancés</span>
        {runs.length > 0 && <span className="text-muted-foreground text-xs">{runs.length}</span>}
      </div>

      {runs.length === 0 ? (
        <AgentRunEmpty />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {runs.map((r, i) => (
            <RunCard
              key={r.runId}
              runId={r.runId}
              threadStatus={r.status}
              getHeaders={getHeaders}
              caps={caps}
              defaultOpen={i === runs.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Placeholder shown when the conversation hasn't launched any agent yet. */
function AgentRunEmpty() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <BotIcon className="text-muted-foreground/40 size-8" />
      <p className="text-muted-foreground text-sm">Aucun agent lancé dans cette conversation.</p>
      {/* Reuses the same native suggestion the empty thread offers. */}
      <ThreadPrimitive.Suggestion
        prompt="Quels agents puis-je lancer ?"
        method="replace"
        autoSend
        asChild
      >
        <button
          type="button"
          className="hover:bg-accent rounded-lg border px-3 py-2 text-sm transition-colors"
        >
          Quels agents puis-je lancer ?
        </button>
      </ThreadPrimitive.Suggestion>
    </div>
  );
}

function RunCard({
  runId,
  threadStatus,
  getHeaders,
  caps,
  defaultOpen,
}: {
  runId: string;
  threadStatus?: string;
  getHeaders: GetHeaders;
  caps: Map<string, AgentCaps> | null;
  defaultOpen: boolean;
}) {
  // Controlled <details>: React keeps `open` in sync, so we mirror user toggles
  // via onToggle — the only way to pick an initial-open card without React
  // fighting subsequent manual toggles.
  const [open, setOpen] = useState(defaultOpen);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // Live status from the SSE stream, overriding the fetched/thread status.
  const [liveStatus, setLiveStatus] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    // threadStatus in deps: refetch when the run reaches a terminal state, so
    // the journal + connections + final status land even without SSE.
    void (async () => {
      try {
        const r = await fetchRun(getHeaders, runId).catch(() => null);
        if (cancelled || !r) return;
        setRun(r);
        const entries = await fetchLogs(getHeaders, runId).catch(() => [] as LogEntry[]);
        if (!cancelled) setLogs(entries);
      } catch {
        // setState after teardown / transient render error — non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, threadStatus, getHeaders]);

  const status = liveStatus ?? run?.status ?? threadStatus ?? "running";
  const meta = STATUS[status] ?? { label: "En cours", cls: "text-muted-foreground" };
  const running = status === "running" || status === "pending";

  // While the run is in flight, stream its journal + status live. Closes once
  // it goes terminal (runId becomes null), then a canonical refetch lands the
  // final duration + connections (ordered batch replaces the live-appended one).
  useRunEvents(running ? runId : null, getHeaders, {
    onLog: (log) => {
      const l = log as LogEntry;
      if (l?.id == null) return; // keep all levels — buildJournal curates
      setLogs((prev) => (prev.some((x) => x.id === l.id) ? prev : [...prev, l]));
    },
    onStatus: (u) => {
      if (!u?.status) return;
      setLiveStatus(u.status);
      if (u.status !== "running" && u.status !== "pending") {
        void (async () => {
          try {
            const [r, entries] = await Promise.all([
              fetchRun(getHeaders, runId).catch(() => null),
              fetchLogs(getHeaders, runId).catch(() => null),
            ]);
            if (r) setRun(r);
            if (entries) setLogs(entries);
          } catch {
            // setState after teardown / transient render error — non-fatal.
          }
        })();
      }
    },
  });
  const agentLabel = run?.agent_name ?? (run?.package_ephemeral ? "Agent inline" : "Agent");
  const connections = run?.connections_used ?? [];
  const agentCaps = run && !run.package_ephemeral ? (caps?.get(run.packageId) ?? null) : null;
  const { activity, technical, output, report } = useMemo(() => buildJournal(logs), [logs]);
  // null = unknown/inline (no actionable nudge); false = agent declares neither
  // `log` nor `report`, so it *can't* narrate → nudge the user to enable them.
  const canCommunicate = agentCaps
    ? agentCaps.runtimeTools.some((t) => t === "log" || t === "report")
    : null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="bg-background rounded-md border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        {running ? (
          <Loader2Icon className={`${meta.cls} size-4 shrink-0 animate-spin`} />
        ) : status === "success" ? (
          <CheckCircle2Icon className={`${meta.cls} size-4 shrink-0`} />
        ) : (
          <XCircleIcon className={`${meta.cls} size-4 shrink-0`} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{agentLabel}</span>
          {(run?.version_ref || run?.runNumber != null) && (
            <span className="text-muted-foreground block truncate text-xs">
              {[
                run?.version_ref && `v${run.version_ref}`,
                run?.runNumber != null && `run #${run.runNumber}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
        <span className={`${meta.cls} shrink-0 text-xs`}>
          {run?.duration != null ? `${Math.round(run.duration / 1000)} s` : meta.label}
        </span>
        <ChevronRightIcon
          className={`text-muted-foreground size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </summary>

      <div className="space-y-3 border-t px-2.5 py-2 text-sm">
        {/* Activité — the agent's own words (the `log` tool), human language. */}
        <section>
          <SectionTitle>Activité</SectionTitle>
          {activity.length === 0 ? (
            <ActivityEmpty running={running} canCommunicate={canCommunicate} />
          ) : activity.length <= PREVIEW ? (
            <JournalList entries={activity} />
          ) : (
            <>
              <JournalList entries={activity.slice(0, PREVIEW)} />
              <details className="group/act mt-1">
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none text-xs [&::-webkit-details-marker]:hidden">
                  <span className="group-open/act:hidden">Voir les {activity.length} étapes</span>
                  <span className="hidden group-open/act:inline">Réduire</span>
                </summary>
                <div className="mt-1">
                  <JournalList entries={activity.slice(PREVIEW)} />
                </div>
              </details>
            </>
          )}
        </section>

        {connections.length > 0 && (
          <section>
            <SectionTitle>Connexions utilisées</SectionTitle>
            <ul className="space-y-1.5">
              {connections.map((c) => (
                <li key={c.integration_id} className="flex items-center gap-2">
                  <Link2Icon className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{shortId(c.integration_id)}</span>
                    {c.account_id && (
                      <span className="text-muted-foreground"> · {c.account_id}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Détails techniques — the machine trace, folded away from end users:
            tool calls, platform breadcrumbs, raw output/report, capabilities. */}
        {(technical.length > 0 || output || report || agentCaps) && (
          <details className="group/tech">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none text-xs font-medium tracking-wide uppercase [&::-webkit-details-marker]:hidden">
              Détails techniques
            </summary>
            <div className="mt-2 space-y-3">
              {technical.length > 0 && <JournalList entries={technical} />}

              {report && (
                <div className="bg-muted/40 text-muted-foreground max-h-56 overflow-auto rounded-md border px-2 py-1.5 text-xs break-words whitespace-pre-wrap">
                  {report}
                </div>
              )}
              {output && (
                <pre className="bg-muted/40 text-muted-foreground max-h-56 overflow-auto rounded-md border px-2 py-1.5 font-mono text-[11px] break-words whitespace-pre-wrap">
                  {JSON.stringify(output, null, 2)}
                </pre>
              )}

              {agentCaps &&
                agentCaps.integrations.length + agentCaps.skills.length + agentCaps.mcp.length >
                  0 && (
                  <div className="space-y-2">
                    {(
                      [
                        ["Intégrations", agentCaps.integrations],
                        ["Skills", agentCaps.skills],
                        ["MCP", agentCaps.mcp],
                      ] as const
                    )
                      .filter(([, items]) => items.length > 0)
                      .map(([label, items]) => (
                        <div key={label}>
                          <p className="text-muted-foreground mb-1 text-xs">{label}</p>
                          <div className="flex flex-wrap gap-1">
                            {items.map((id) => (
                              <span key={id} className="bg-muted rounded px-1.5 py-0.5 text-xs">
                                {shortId(id)}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
            </div>
          </details>
        )}
      </div>
    </details>
  );
}

/**
 * Empty "Activité": the agent produced no human narration. When we know the
 * agent declares neither `log` nor `report` (`canCommunicate === false`), nudge
 * the user to enable them — that's the only way to populate this panel.
 */
function ActivityEmpty({
  running,
  canCommunicate,
}: {
  running: boolean;
  canCommunicate: boolean | null;
}) {
  if (running) return <p className="text-muted-foreground text-xs">L'agent travaille…</p>;
  if (canCommunicate === false) {
    return (
      <p className="text-muted-foreground text-xs">
        Cet agent ne partage pas son activité. Activez le tool{" "}
        <span className="text-foreground font-medium">Log</span> ou{" "}
        <span className="text-foreground font-medium">Report</span> dans l'éditeur de l'agent
        (onglet « Outils runtime ») pour la voir ici.
      </p>
    );
  }
  return <p className="text-muted-foreground text-xs">L'agent n'a pas détaillé ses étapes.</p>;
}

function JournalList({ entries }: { entries: JournalEntry[] }) {
  return (
    <ul className="space-y-1">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-2">
          <span
            className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
              LEVEL_DOT[e.level] ?? (e.detail ? "bg-primary/60" : "bg-muted-foreground/40")
            }`}
          />
          <span className="min-w-0 flex-1 text-xs break-words">
            <span className="text-muted-foreground">{e.text}</span>
            {e.detail && (
              <span className="text-muted-foreground/60 mt-0.5 block font-mono text-[11px] break-words">
                {e.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
      {children}
    </h3>
  );
}
