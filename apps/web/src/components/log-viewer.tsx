// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useEffectEvent, useId, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  Braces,
  Copy,
  Check,
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  Loader2,
  CircleSlash2,
  CircleHelp,
  MessageSquareText,
  Cog,
  ChevronRight,
  ScrollText,
  SearchX,
  X,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@appstrate/ui/components/sheet";
import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "./page-actions-menu";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { CopyButton } from "@appstrate/ui/components/copy-button";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "../lib/format-duration";
import {
  formatTimestamp,
  journalLevel,
  filterJournal,
  journalGroupElapsedMs,
  journalIntegrationIds,
  journalRows,
  journalType,
  toolLabel,
  JOURNAL_TYPE_VALUES,
  type ExecutionEntry,
  type IntegrationLook,
  type JournalGroup,
  type JournalIntegrations,
  type JournalRow,
  type JournalTypeFilter,
  type ToolExecutionEntry,
  type ToolExecutionStatus,
} from "./log-utils";
import { PackageIcon } from "./package-icon";
import { ItemList } from "./item-list";
import { JournalRowsSkeleton } from "./loading-skeletons";
import { EmptyState } from "./page-states";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { RunStatusBadge } from "./status-badge";
import { formatDateField } from "../lib/format-date";
import {
  RECALL_MEMORY_TOOL,
  RUN_HISTORY_TOOL,
  historyRuns,
  platformTool,
  recalledMemories,
} from "../lib/platform-tool-results";
import { ListToolbar, type FilterSpec } from "./list-toolbar";
import { useCopyToClipboard } from "@appstrate/ui/use-copy-to-clipboard";
import { useMediaQuery } from "../hooks/use-media-query";
import { useFillHeight } from "../hooks/use-fill-height";

/** From this width the inspector stands beside the list; below, it opens in a sheet. */
const INSPECTOR_BESIDE = "(min-width: 1024px)";

interface EntryLook {
  icon: typeof Info;
  /** The icon's colour. */
  className: string;
  /** The event's colour, when it is not the foreground's. */
  text?: string;
}

/** A row's icon and tone by type; a warning or an error overrides them on any type. */
const ENTRY_LOOKS = {
  agent: { icon: MessageSquareText, className: "text-primary" },
  log: { icon: Info, className: "text-primary" },
  runtime: { icon: Cog, className: "text-muted-foreground", text: "text-muted-foreground" },
  warn: { icon: AlertTriangle, className: "text-warning", text: "text-amber-400" },
  error: { icon: XCircle, className: "text-destructive", text: "text-destructive" },
} satisfies Record<Exclude<ExecutionEntry["kind"], "tool"> | "warn" | "error", EntryLook>;

/** A tool call has no look of its own while it is fine: its status icon stands for it. */
function entryLook(entry: ExecutionEntry): EntryLook | undefined {
  const level = journalLevel(entry);
  if (level !== "info") return ENTRY_LOOKS[level];
  return entry.kind === "tool" ? undefined : ENTRY_LOOKS[entry.kind];
}

/** A row's leading icon: a tool's status, else its look. It speaks a level, never the type. */
function EntryIcon({ entry }: { entry: ExecutionEntry }) {
  const { t } = useTranslation("agents");
  if (entry.kind === "tool") return <ToolStatus status={entry.status} />;
  const level = journalLevel(entry);
  const look = entryLook(entry)!;
  const Icon = look.icon;
  return level === "info" ? (
    <Icon className={cn("size-3.5", look.className)} aria-hidden />
  ) : (
    <Icon
      className={cn("size-3.5", look.className)}
      role="img"
      aria-label={t(`log.level.${level}`)}
    />
  );
}

const toolStatusConfig = {
  running: {
    icon: Loader2,
    className: "text-primary animate-spin",
    labelKey: "log.toolStatus.running",
  },
  success: {
    icon: CheckCircle2,
    className: "text-success",
    labelKey: "log.toolStatus.success",
  },
  failed: {
    icon: XCircle,
    className: "text-destructive",
    labelKey: "log.toolStatus.failed",
  },
  interrupted: {
    icon: CircleSlash2,
    className: "text-warning",
    labelKey: "log.toolStatus.interrupted",
  },
  unknown: {
    icon: CircleHelp,
    className: "text-muted-foreground",
    labelKey: "log.toolStatus.unknown",
  },
} satisfies Record<
  ToolExecutionStatus,
  { icon: typeof Loader2; className: string; labelKey: string }
>;

function ToolStatus({
  status,
  showLabel = false,
}: {
  status: ToolExecutionStatus;
  showLabel?: boolean;
}) {
  const { t } = useTranslation("agents");
  const config = toolStatusConfig[status];
  const Icon = config.icon;
  const label = t(config.labelKey);

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <Icon
        className={cn("size-3.5 shrink-0", config.className)}
        aria-hidden={showLabel || undefined}
        aria-label={showLabel ? undefined : label}
      />
      {showLabel && <span>{label}</span>}
    </span>
  );
}

/** A line-height placeholder, a `span` so it is valid inside the row's button. */
function InlineSkeleton({ className }: { className: string }) {
  return (
    <span className={cn("bg-muted inline-block animate-pulse rounded-sm", className)} aria-hidden />
  );
}

/** The integration a call reached: its icon (decorative, its name follows) and its name. */
function IntegrationName({ look, className }: { look: IntegrationLook; className?: string }) {
  if (look.pending) {
    return (
      <>
        <InlineSkeleton className="size-4 shrink-0" />
        <InlineSkeleton className="h-3 w-16 shrink-0" />
      </>
    );
  }
  return (
    <>
      <PackageIcon type="integration" icon={look.icon} size="xs" />
      <span className={cn("truncate", className)}>{look.name}</span>
    </>
  );
}

/** A tool row's event: the integration it reached, the tool's label, then what it was asked. */
export function ToolCallEvent({
  entry,
  integrations,
}: {
  entry: ToolExecutionEntry;
  integrations: JournalIntegrations;
}) {
  const { t } = useTranslation("agents");
  return (
    <>
      {entry.integration && (
        <IntegrationName
          look={integrations(entry.integration.id)}
          className="text-muted-foreground max-w-40 shrink-0"
        />
      )}
      <span className="min-w-0 truncate">
        <span className="font-medium">{toolLabel(entry, t)}</span>
        {entry.detail && <span className="text-muted-foreground"> · {entry.detail}</span>}
      </span>
    </>
  );
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="bg-muted text-foreground/80 overflow-x-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
      {formatStructuredValue(value)}
    </pre>
  );
}

function InspectorSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{label}</h3>
      {children}
    </section>
  );
}

/**
 * A tool's result. The `@appstrate/platform` tools `recall_memory` and
 * `run_history` read as the items they returned (a memory's text, a past run's
 * status and date); anything else, and the raw payload of those two, is the JSON
 * as the runner logged it.
 */
function ToolResult({ entry }: { entry: ToolExecutionEntry }) {
  const { t } = useTranslation("agents");
  const [showJson, setShowJson] = useState(false);
  const { result } = entry;
  const tool = platformTool(entry.integration);
  const memories = tool === RECALL_MEMORY_TOOL ? recalledMemories(result) : null;
  const runs = tool === RUN_HISTORY_TOOL ? historyRuns(result) : null;
  const raw = <JsonBlock value={result} />;
  if (!memories && !runs) return raw;
  let items = raw;
  if (!showJson && memories) {
    items = (
      <ItemList
        items={memories}
        itemKey={(memory) => memory.id}
        empty={<EmptyState compact icon={Info} message={t("log.recalledNone")} />}
        renderItem={(memory) => (
          <div className="rounded-md border px-3 py-2 text-sm">
            <p className="whitespace-pre-wrap">{memory.content}</p>
            {memory.createdAt && (
              <p className="text-muted-foreground mt-1 text-xs">
                {formatDateField(memory.createdAt)}
              </p>
            )}
          </div>
        )}
      />
    );
  } else if (!showJson && runs) {
    items = (
      <ItemList
        items={runs}
        itemKey={(run) => run.id}
        empty={<EmptyState compact icon={Info} message={t("log.historyNone")} />}
        renderItem={(run) => (
          <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
            {run.status && <RunStatusBadge status={run.status} />}
            <span className="font-mono text-xs">{run.id}</span>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              {[
                run.date && formatDateField(run.date),
                run.duration != null && formatDuration(run.duration),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        )}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {items}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setShowJson((v) => !v)}
      >
        <Braces />
        {showJson ? t("run.outputShowFields") : t("run.outputShowJson")}
      </Button>
    </div>
  );
}

/**
 * One journal row: its icon, the event, then its duration and (on request) its time. The type
 * is drawn by the icon alone and spoken by assistive technology.
 */
export function LogRow({
  entry,
  integrations,
  showTimestamp,
  open,
  inspectorId,
  onToggle,
}: {
  entry: ExecutionEntry;
  integrations: JournalIntegrations;
  showTimestamp: boolean;
  open: boolean;
  inspectorId: string;
  onToggle: () => void;
}) {
  const { t, i18n } = useTranslation("agents");
  return (
    <RowShell
      icon={<EntryIcon entry={entry} />}
      expanded={open}
      controls={open ? inspectorId : undefined}
      onClick={onToggle}
      className={cn(open && "bg-muted/40")}
      duration={
        entry.kind === "tool" && entry.durationMs !== undefined
          ? formatDuration(entry.durationMs)
          : null
      }
      time={showTimestamp ? formatTimestamp(entry.createdAt, i18n.language) : null}
    >
      <span className="sr-only">{t(`log.type.${journalType(entry)}`)}</span>
      <span
        className={cn(
          "text-foreground min-w-0 flex-1",
          entry.kind === "tool" ? "flex items-center gap-1.5" : "break-words whitespace-pre-wrap",
          entryLook(entry)?.text,
        )}
      >
        {entry.kind === "tool" ? (
          <ToolCallEvent entry={entry} integrations={integrations} />
        ) : (
          entry.message
        )}
      </span>
    </RowShell>
  );
}

/** A group of runner lines: one disclosure row that opens them in place, below it. */
export function LogGroupRow({
  group,
  showTimestamp,
  expanded,
  onToggle,
}: {
  group: JournalGroup;
  showTimestamp: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, i18n } = useTranslation("agents");
  const elapsed = journalGroupElapsedMs(group);
  const look = ENTRY_LOOKS.runtime;
  return (
    <RowShell
      icon={<look.icon className={cn("size-3.5", look.className)} aria-hidden />}
      expanded={expanded}
      onClick={onToggle}
      duration={elapsed > 0 ? formatDuration(elapsed) : null}
      time={showTimestamp ? formatTimestamp(group.entries[0]?.createdAt, i18n.language) : null}
    >
      <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", look.text)}>
        <span className="truncate">{t("log.systemSteps", { count: group.entries.length })}</span>
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
          aria-hidden
        />
      </span>
    </RowShell>
  );
}

/** A journal line: its leading icon, the event, then its duration and its time when present. */
function RowShell({
  icon,
  expanded,
  controls,
  onClick,
  className,
  duration,
  time,
  children,
}: {
  icon: ReactNode;
  expanded: boolean;
  controls?: string;
  onClick: () => void;
  className?: string;
  duration: string | null;
  time: string | null;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "hover:bg-muted/50 flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left text-sm transition-colors",
        className,
      )}
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      {children}
      {(duration || time) && (
        <span className="text-muted-foreground flex shrink-0 gap-3 text-xs leading-5 whitespace-nowrap tabular-nums">
          {duration && <span>{duration}</span>}
          {time && <span className="font-mono">{time}</span>}
        </span>
      )}
    </button>
  );
}

interface LogViewerProps {
  entries: ExecutionEntry[];
  integrations: JournalIntegrations;
  /** The entries are still being read: rows on their way replace the empty state. */
  isLoading?: boolean;
  /** Terminal failures open with the causal event near the middle of the journal. */
  focusError?: boolean;
  /** New entries can still arrive: a reader away from the end is offered a way back to it. */
  live?: boolean;
  headerActions?: ReactNode;
  /** The open row, which a first positioning brings into view. */
  selectedEntryId?: string | null;
  /** `null` closes the open row: its re-click, the inspector's close, the sheet's dismissal. */
  onSelectEntry: (entryId: string | null) => void;
  /** Read once at mount: the caller keys the viewer on it to apply a new focus. */
  initialFocus?: JournalOverviewFilter;
  /** The open row's inspector: beside the list from `lg`, in a sheet below. */
  inspector?: ReactNode;
}

export type JournalOverviewFilter = "tools" | "warnings" | "errors";
type JournalLevelFilter = ReturnType<typeof journalLevel>;
const FOCUS_FILTERS: Record<
  JournalOverviewFilter,
  { levels: JournalLevelFilter[]; types: JournalTypeFilter[] }
> = {
  tools: { levels: [], types: ["tool"] },
  warnings: { levels: ["warn"], types: [] },
  errors: { levels: ["error"], types: [] },
};

/** A filter in force stays on screen, so it can be cleared. */
function facet(
  id: string,
  label: string,
  values: string[],
  available: readonly string[],
  optionLabel: (value: string) => string,
  onChange: (values: string[]) => void,
): FilterSpec[] {
  if (available.length < 2 && values.length === 0) return [];
  const options = available.map((value) => ({ value, label: optionLabel(value) }));
  return [{ id, label, values, options, onChange }];
}

export function LogViewer({
  entries,
  integrations,
  isLoading = false,
  focusError = false,
  live = false,
  headerActions,
  selectedEntryId,
  onSelectEntry,
  initialFocus,
  inspector,
}: LogViewerProps) {
  const { t, i18n } = useTranslation("agents");
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);
  const fillHeight = useFillHeight(cardRef);
  const inspectorBeside = useMediaQuery(INSPECTOR_BESIDE);
  const inspectorId = useId();

  const [autoScroll, setAutoScroll] = useState(true);
  const { copied, copy } = useCopyToClipboard();
  const [display, setDisplay] = useState<string[]>([]);
  const showTimestamps = display.includes("timestamps");
  const showTools = !display.includes("hide_tools");
  const [query, setQuery] = useState("");
  const focus = initialFocus ? FOCUS_FILTERS[initialFocus] : undefined;
  const [levelFilters, setLevelFilters] = useState<string[]>(focus?.levels ?? []);
  const [typeFilters, setTypeFilters] = useState<string[]>(focus?.types ?? []);
  const [integrationFilters, setIntegrationFilters] = useState<string[]>([]);

  const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);
  const visibleEntries = useMemo(
    () =>
      filterJournal(
        entries,
        {
          levels: levelFilters,
          types: typeFilters,
          integrations: integrationFilters,
          showTools,
          query: normalizedQuery,
          locale: i18n.language,
        },
        t,
        integrations,
      ),
    [
      entries,
      i18n.language,
      integrationFilters,
      integrations,
      levelFilters,
      normalizedQuery,
      showTools,
      t,
      typeFilters,
    ],
  );
  const rows = useMemo(
    () =>
      journalRows(visibleEntries, {
        levels: levelFilters,
        types: typeFilters,
        query: normalizedQuery,
      }),
    [levelFilters, normalizedQuery, typeFilters, visibleEntries],
  );
  // A group is folded until opened. A live run's last group is still booting: it opens as its
  // lines arrive and stays as the reader left it, so no row ever folds under them.
  const [groupOpen, setGroupOpen] = useState<Readonly<Record<string, boolean>>>({});
  const tail = rows[rows.length - 1];
  if (live && tail?.kind === "group" && groupOpen[tail.id] === undefined) {
    setGroupOpen({ ...groupOpen, [tail.id]: true });
  }
  // A folded group holding the open row (a reload, a shared link) opens to show it.
  const selectedGroupId =
    rows.find(
      (row) =>
        row.kind === "group" &&
        !groupOpen[row.id] &&
        row.entries.some((entry) => entry.id === selectedEntryId),
    )?.id ?? null;
  const drawnRows = useMemo(
    () =>
      rows.flatMap((row): JournalRow[] =>
        row.kind === "group" && (groupOpen[row.id] || row.id === selectedGroupId)
          ? [row, ...row.entries]
          : [row],
      ),
    [groupOpen, rows, selectedGroupId],
  );
  const toggleGroup = (group: JournalGroup, expanded: boolean) => {
    setGroupOpen((open) => ({ ...open, [group.id]: !expanded }));
    // Folding hides the open row: its inspector closes with it.
    if (expanded && group.entries.some((entry) => entry.id === selectedEntryId)) {
      onSelectEntry(null);
    }
  };
  const availableLevels = (["info", "warn", "error"] as const).filter((value) =>
    entries.some((entry) => journalLevel(entry) === value),
  );
  const availableTypes = JOURNAL_TYPE_VALUES.filter((value) =>
    entries.some((entry) => journalType(entry) === value),
  );
  const availableIntegrations = useMemo(() => journalIntegrationIds(entries), [entries]);
  const activeFilterCount =
    levelFilters.length + typeFilters.length + integrationFilters.length + display.length;
  const hasActiveQueryOrFilters = normalizedQuery !== "" || activeFilterCount > 0;
  const filters: FilterSpec[] = [
    ...facet(
      "level",
      t("log.filterLevel"),
      levelFilters,
      availableLevels,
      (value) => t(`log.level.${value}`),
      setLevelFilters,
    ),
    ...facet(
      "type",
      t("log.filterType"),
      typeFilters,
      availableTypes,
      (value) => t(`log.type.${value}`),
      setTypeFilters,
    ),
    ...facet(
      "integration",
      t("log.filterIntegration"),
      integrationFilters,
      availableIntegrations,
      (value) => integrations(value).name,
      setIntegrationFilters,
    ),
    {
      id: "display",
      label: t("log.filterDisplay"),
      values: display,
      options: [
        { value: "timestamps", label: t("log.toggleTimestamps") },
        { value: "hide_tools", label: t("log.hideTools") },
      ],
      onChange: setDisplay,
    },
  ];

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: drawnRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  useEffect(() => {
    positionedRef.current = false;
  }, [integrationFilters, levelFilters, normalizedQuery, showTools, typeFilters]);

  // Read by the first positioning, not depended on: choosing a row does not move the list.
  const openRowIndex = useEffectEvent((rows: readonly JournalRow[]) =>
    selectedEntryId ? rows.findIndex((row) => row.id === selectedEntryId) : -1,
  );

  // Auto-scroll when entries are added OR a running tool row settles in place.
  useEffect(() => {
    if (drawnRows.length === 0) return;
    if (!positionedRef.current) {
      // The open row (a reload, a shared link) first, then the causal error, else the end.
      let anchor = openRowIndex(drawnRows);
      if (anchor < 0 && focusError) {
        for (let index = drawnRows.length - 1; index >= 0; index -= 1) {
          const row = drawnRows[index]!;
          if (row.kind !== "group" && journalLevel(row) === "error") {
            anchor = index;
            break;
          }
        }
      }
      virtualizer.scrollToIndex(anchor >= 0 ? anchor : drawnRows.length - 1, {
        align: anchor >= 0 ? "center" : "end",
      });
      positionedRef.current = true;
      return;
    }
    if (autoScroll) {
      virtualizer.scrollToIndex(drawnRows.length - 1, { align: "end" });
    }
  }, [drawnRows, autoScroll, focusError, virtualizer]);

  // Disable auto-scroll when user scrolls up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (!atBottom && autoScroll) setAutoScroll(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [autoScroll]);

  const handleCopy = () => {
    const text = visibleEntries
      .map((e) => {
        const ts = showTimestamps ? `[${formatTimestamp(e.createdAt, i18n.language)}] ` : "";
        if (e.kind === "tool") {
          const detail = e.detail ? ` ${e.detail}` : "";
          const duration = e.durationMs !== undefined ? ` ${formatDuration(e.durationMs)}` : "";
          const args =
            e.args !== undefined
              ? `\n  ${t("log.arguments")}: ${formatStructuredValue(e.args)}`
              : "";
          const result =
            e.result !== undefined
              ? `\n  ${t("log.result")}: ${formatStructuredValue(e.result)}`
              : "";
          return `${ts}[tool:${e.status}] ${e.tool}${detail}${duration}${args}${result}`;
        }
        return `${ts}${e.message}`;
      })
      .join("\n");
    void copy(text);
  };

  const followLatest = () => {
    setAutoScroll(true);
    if (drawnRows.length > 0) {
      virtualizer.scrollToIndex(drawnRows.length - 1, { align: "end" });
    }
  };

  const clearJournalFilters = () => {
    setQuery("");
    setLevelFilters([]);
    setTypeFilters([]);
    setIntegrationFilters([]);
    setDisplay([]);
  };

  const besideList = inspectorBeside && !!inspector;

  return (
    <div className="min-w-0">
      <ListToolbar
        search={{ value: query, onChange: setQuery, placeholder: t("log.search") }}
        filters={filters}
        onReset={clearJournalFilters}
        actions={
          <div className="flex items-center gap-2">
            {headerActions}
            <PageActionsMenu>
              <DropdownMenuItem onSelect={handleCopy}>
                {copied ? <Check /> : <Copy />}
                {copied ? t("common:btn.copied") : t("log.copyLogs")}
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={autoScroll}
                onCheckedChange={(checked) => (checked ? followLatest() : setAutoScroll(false))}
              >
                {t("log.autoScroll")}
              </DropdownMenuCheckboxItem>
            </PageActionsMenu>
          </div>
        }
      />

      {/* The journal's own card: the event list and, from `lg` when a row is open, its
          inspector beside it. It ends where the page does, and its list scrolls inside it. */}
      <div
        ref={cardRef}
        className={cn(
          "bg-card flex min-w-0 overflow-hidden rounded-lg border",
          besideList ? "flex-row" : "flex-col",
        )}
        style={besideList ? { height: fillHeight } : { maxHeight: fillHeight }}
      >
        <div className="relative flex min-h-0 min-w-0 flex-[2] flex-col">
          {/* Virtualized rows mount as the list scrolls: a polite live region (the implicit
              value of `log`) would announce them as new events, so it is turned off. */}
          <div
            ref={scrollRef}
            role="log"
            aria-live="off"
            aria-label={t("log.listLabel")}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {isLoading && entries.length === 0 ? (
              <JournalRowsSkeleton />
            ) : visibleEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center py-10">
                {entries.length === 0 ? (
                  <EmptyState compact icon={ScrollText} message={t("log.empty")} />
                ) : (
                  <EmptyState
                    compact
                    icon={SearchX}
                    message={t("log.noMatches")}
                    hint={t("log.noMatchesHint")}
                  >
                    {hasActiveQueryOrFilters && (
                      <Button variant="ghost" size="sm" onClick={clearJournalFilters}>
                        {t("common:toolbar.clearAll")}
                      </Button>
                    )}
                  </EmptyState>
                )}
              </div>
            ) : (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const row = drawnRows[virtualRow.index]!;
                  const open = selectedEntryId === row.id;
                  const expanded = !!groupOpen[row.id] || row.id === selectedGroupId;
                  return (
                    <div
                      key={row.id}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {row.kind === "group" ? (
                        <LogGroupRow
                          group={row}
                          showTimestamp={showTimestamps}
                          expanded={expanded}
                          onToggle={() => toggleGroup(row, expanded)}
                        />
                      ) : (
                        <LogRow
                          entry={row}
                          integrations={integrations}
                          showTimestamp={showTimestamps}
                          open={open}
                          inspectorId={inspectorId}
                          onToggle={() => onSelectEntry(open ? null : row.id)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {live && !autoScroll && visibleEntries.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              className="absolute right-3 bottom-3 shadow-md"
              onClick={followLatest}
            >
              <ArrowDown />
              {t("log.jumpToLatest")}
            </Button>
          )}
        </div>
        {besideList && (
          <aside
            id={inspectorId}
            className="border-border flex min-h-0 min-w-80 flex-1 flex-col border-l"
          >
            {inspector}
          </aside>
        )}
      </div>

      {!inspectorBeside && (
        <Sheet open={!!inspector} onOpenChange={(open) => !open && onSelectEntry(null)}>
          <SheetContent
            id={inspectorId}
            side="right"
            aria-describedby={undefined}
            // The inspector's header carries the one close control, as beside the list.
            showCloseButton={false}
            className="flex w-[min(92vw,32rem)] flex-col gap-0 p-0 sm:max-w-none"
          >
            <SheetTitle className="sr-only">{t("log.inspectorTitle")}</SheetTitle>
            {inspector}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

export function LogEntryInspector({
  entry,
  integrations,
  onClose,
}: {
  entry: ExecutionEntry;
  integrations: JournalIntegrations;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("agents");
  const type = journalType(entry);
  const label = entry.kind === "tool" ? toolLabel(entry, t) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("log.inspectorTitle")}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-7"
          onClick={onClose}
          aria-label={t("common:btn.close")}
        >
          <X />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4">
          <FactGrid columns={1}>
            <Fact label={t("log.filterType")}>{t(`log.type.${type}`)}</Fact>
            {entry.createdAt && (
              <Fact label={t("log.timestamp")}>
                {formatTimestamp(entry.createdAt, i18n.language)}
              </Fact>
            )}
            <Fact label={t("log.filterLevel")}>{t(`log.level.${journalLevel(entry)}`)}</Fact>
            {entry.kind === "tool" && (
              <>
                <Fact label={t("log.tool")}>{label}</Fact>
                {entry.integration && (
                  <>
                    <Fact label={t("log.filterIntegration")}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IntegrationName look={integrations(entry.integration.id)} />
                      </span>
                    </Fact>
                    <Fact label={t("log.integrationId")}>
                      <CopyableValue value={entry.integration.id} />
                    </Fact>
                    {entry.integration.tool !== label && (
                      <Fact label={t("log.upstreamTool")}>
                        <CopyableValue value={entry.integration.tool} />
                      </Fact>
                    )}
                  </>
                )}
                {entry.tool !== label && (
                  <Fact label={t("log.technicalName")}>
                    <CopyableValue value={entry.tool} />
                  </Fact>
                )}
                <Fact label={t("log.status")}>
                  <ToolStatus status={entry.status} showLabel />
                </Fact>
                {entry.durationMs !== undefined && (
                  <Fact label={t("run.infoDuration")}>{formatDuration(entry.durationMs)}</Fact>
                )}
              </>
            )}
          </FactGrid>

          {entry.kind === "tool" ? (
            <>
              {entry.args !== undefined && (
                <InspectorSection label={t("log.arguments")}>
                  <JsonBlock value={entry.args} />
                </InspectorSection>
              )}
              {entry.result !== undefined && (
                <InspectorSection label={t("log.result")}>
                  <ToolResult key={entry.id} entry={entry} />
                </InspectorSection>
              )}
              {entry.detail && entry.args === undefined && (
                <InspectorSection label={t("log.details")}>
                  <InspectorProse>{entry.detail}</InspectorProse>
                </InspectorSection>
              )}
            </>
          ) : (
            <InspectorSection label={t("log.message")}>
              <InspectorProse>{entry.message}</InspectorProse>
            </InspectorSection>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function CopyableValue({ value }: { value: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-xs break-all">{value}</span>
      <CopyButton value={value} />
    </span>
  );
}

function InspectorProse({ children }: { children: string }) {
  return <p className="text-foreground/80 text-sm break-words whitespace-pre-wrap">{children}</p>;
}
