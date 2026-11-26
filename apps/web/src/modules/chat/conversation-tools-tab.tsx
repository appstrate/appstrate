// SPDX-License-Identifier: Apache-2.0

import { useId, type ReactNode } from "react";
import { ArrowLeftIcon, MessageSquareIcon, WrenchIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConversationToolCall } from "@appstrate/module-chat/conversation-tools";
import type { ShownCall } from "@appstrate/module-chat/tool-presentation";
import { ToolCallDetail } from "@appstrate/module-chat/tool-call-detail";
import { SubjectGlyph } from "@appstrate/module-chat/subject-glyph";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Switch } from "@appstrate/ui/components/switch";
import { EmptyState, ErrorState } from "../../components/page-states";
import { Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { RowSpaceName } from "../../components/run-row";
import { formatDuration } from "../../lib/format-duration";
import type { SidebarOrigin } from "./conversation-sidebar-state";
import {
  TOOL_STATUS_LABEL,
  TOOL_STATUS_TONE,
  actsInSeveralSpaces,
  useConversationTools,
  useToolLabel,
} from "./use-conversation-tools";
import { useChatTranslate } from "./use-chat-runtime";

/** A text button of the panel: 40 px on touch, its own size under a mouse. */
const PANEL_BUTTON = "desktop-pointer:h-9 h-10";

/** The line holding the lookups' switch: the whole line is its label, a 40 px target. */
const SWITCH_LINE_CLASS = "flex min-h-10 items-center justify-between gap-3 border-b px-4";

const TURN_HEAD_CLASS =
  "text-muted-foreground bg-muted/40 border-b px-4 py-1.5 text-xs font-medium";

/** One call's row: its glyph tile beside two lines. */
const CALL_ROW_CLASS = "flex min-h-14 w-full items-center gap-3 px-4 py-2.5";

const GLYPH_CLASS = "flex size-8 shrink-0 items-center justify-center rounded-lg";

/**
 * The call's icon: the glyph of what it acted on, as its card draws it, else its icon (`showCall`)
 * in its status' tone.
 */
export function ToolCallIcon({ call, shown }: { call: ConversationToolCall; shown: ShownCall }) {
  if (shown.subject) return <SubjectGlyph subject={shown.subject} />;
  const { Icon } = shown;
  return <Icon aria-hidden="true" className={cn("size-4", TOOL_STATUS_TONE[call.status])} />;
}

/** The call's lead glyph: its icon on a tile. */
function ToolGlyph({ call, shown }: { call: ConversationToolCall; shown: ShownCall }) {
  return (
    <span className={cn("bg-muted", GLYPH_CLASS)}>
      <ToolCallIcon call={call} shown={shown} />
    </span>
  );
}

/** How long the call ran, in the interface's language, as a run's duration reads; absent while it runs. */
function callDuration(call: ConversationToolCall): string | null {
  return call.durationMs === undefined ? null : formatDuration(call.durationMs);
}

/** One call: its tool, what it acted on, its outcome when it is not a plain success, how long it ran. */
function ToolCallRow({
  call,
  shown,
  spanning,
  onSelect,
}: {
  call: ConversationToolCall;
  shown: ShownCall;
  /** The calls acted in several spaces: the row names its own. */
  spanning: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("chat");
  const { label, idText } = shown;
  const status =
    call.status === "success"
      ? call.lookup
        ? t("context.tools.lookup")
        : null
      : t(TOOL_STATUS_LABEL[call.status]);
  const detail = [idText, status, callDuration(call)].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={cn(CALL_ROW_CLASS, "hover:bg-muted/50 text-left transition-colors")}
      onClick={onSelect}
    >
      <ToolGlyph call={call} shown={shown} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        {detail && (
          <span className="text-muted-foreground block truncate text-xs tabular-nums">
            {detail}
          </span>
        )}
      </span>
      {spanning && <RowSpaceName spaceId={call.spaceId} />}
    </button>
  );
}

/** A call's row on its way: its tile and its two lines. */
function CallRowSkeleton({ width }: { width: string }) {
  return (
    <div className={CALL_ROW_CLASS}>
      <Skeleton className={GLYPH_CLASS} />
      <span className="min-w-0 flex-1">
        <SkeletonLine className={cn("text-sm font-medium", width)} />
        <SkeletonLine className="w-20 text-xs" />
      </span>
    </div>
  );
}

/**
 * The Tools tab while its calls are read: a turn's heading, its rows. No lookups' switch: the list
 * draws it only when the calls hold a lookup.
 */
function ToolsListSkeleton() {
  return (
    <Waiting>
      <div className={TURN_HEAD_CLASS}>
        <SkeletonLine className="w-12" />
      </div>
      <div className="divide-y">
        {["w-32", "w-40", "w-28"].map((width) => (
          <CallRowSkeleton key={width} width={width} />
        ))}
      </div>
    </Waiting>
  );
}

/** The conversation's calls by turn, its lookups behind a switch the panel keeps. */
export function ConversationToolsList({
  conversationId,
  active,
  showLookups,
  onShowLookupsChange,
  onSelect,
}: {
  conversationId: string | null;
  active: boolean;
  showLookups: boolean;
  onShowLookupsChange: (show: boolean) => void;
  onSelect: (call: ConversationToolCall) => void;
}) {
  const { t } = useTranslation("chat");
  const switchId = useId();
  const { tools, error } = useConversationTools(conversationId, active);
  const show = useToolLabel();

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={WrenchIcon} compact />;
  }
  if (error) return <ErrorState error={error} compact />;
  // Not read yet, or held while the panel is closed.
  if (tools === undefined) return <ToolsListSkeleton />;
  // The server holds no such conversation.
  if (tools === null) return <ErrorState compact />;
  if (tools.calls.length === 0) {
    return <EmptyState message={t("context.tools.empty")} icon={WrenchIcon} compact />;
  }

  const lookups = tools.calls.filter((call) => call.lookup).length;
  const shown = showLookups ? tools.calls : tools.calls.filter((call) => !call.lookup);
  const spanning = actsInSeveralSpaces(shown);
  const turns = [...new Set(shown.map((call) => call.turn))];

  return (
    <div>
      {lookups > 0 ? (
        <div className={SWITCH_LINE_CLASS}>
          {/* The whole line is the switch's label: a 40 px target, the switch itself is smaller. */}
          <label
            htmlFor={switchId}
            className="text-muted-foreground flex min-h-10 flex-1 items-center text-xs"
          >
            {t("context.tools.showLookups", { count: lookups })}
          </label>
          <Switch id={switchId} checked={showLookups} onCheckedChange={onShowLookupsChange} />
        </div>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState message={t("context.tools.noAction")} icon={WrenchIcon} compact />
      ) : (
        turns.map((turn) => (
          <section key={turn} aria-labelledby={`${switchId}-turn-${turn}`}>
            <h3 id={`${switchId}-turn-${turn}`} className={TURN_HEAD_CLASS}>
              {t("context.tools.turn", { turn })}
            </h3>
            <div className="divide-y border-b last:border-b-0">
              {shown
                .filter((call) => call.turn === turn)
                .map((call) => (
                  <ToolCallRow
                    key={call.toolCallId}
                    call={call}
                    shown={show(call)}
                    spanning={spanning}
                    onSelect={() => onSelect(call)}
                  />
                ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/** The detail's way back, to where the call was opened from. */
function BackButton({
  from,
  onBack,
}: {
  from: Exclude<SidebarOrigin, "thread">;
  onBack: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <Button variant="ghost" size="sm" className={cn("self-start", PANEL_BUTTON)} onClick={onBack}>
      <ArrowLeftIcon />
      {from === "summary" ? t("context.backToSummary") : t("context.tools.backToList")}
    </Button>
  );
}

/** A call's detail on its way: its way back, its heading, "See in the thread", one section. */
function ShownToolCallSkeleton({ back }: { back: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-3">
      {back}
      <Waiting className="flex flex-col gap-4">
        <div className="flex items-start gap-3 px-1">
          <Skeleton className={GLYPH_CLASS} />
          <div className="min-w-0 flex-1">
            <SkeletonLine className="w-40 text-sm font-medium" />
            <SkeletonLine className="mt-1 w-28 text-xs" />
          </div>
        </div>
        <div className="px-1">
          <Skeleton className={cn("w-36 rounded-md", PANEL_BUTTON)} />
        </div>
        <div className="flex flex-col gap-1">
          <SkeletonLine className="w-16 text-[0.65rem] font-semibold" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </Waiting>
    </div>
  );
}

/**
 * One call over the Tools list: its outcome, input and output. "See in the thread" asks the panel
 * to bring its card into view (`onShowInThread`); `missing` says the last ask found no card. Its
 * way back leads where it was opened from (`from`).
 */
export function ShownToolCall({
  conversationId,
  toolCallId,
  active,
  missing,
  from,
  onBack,
  onShowInThread,
}: {
  conversationId: string | null;
  toolCallId: string;
  active: boolean;
  missing: boolean;
  from: Exclude<SidebarOrigin, "thread">;
  onBack: () => void;
  onShowInThread: (call: ConversationToolCall) => void;
}) {
  const { t } = useTranslation("chat");
  const chatT = useChatTranslate();
  const { tools, error } = useConversationTools(conversationId, active);
  const show = useToolLabel();
  const call = tools?.calls.find((candidate) => candidate.toolCallId === toolCallId);

  const back = <BackButton from={from} onBack={onBack} />;
  if (error) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {back}
        <ErrorState error={error} compact />
      </div>
    );
  }
  if (tools === undefined) return <ShownToolCallSkeleton back={back} />;
  if (!call) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {back}
        <EmptyState message={t("context.tools.gone")} icon={WrenchIcon} compact />
      </div>
    );
  }

  const shown = show(call);
  const { label, idText } = shown;
  const duration = callDuration(call);
  return (
    <div className="flex flex-col gap-4 p-3">
      {back}
      <div className="flex items-start gap-3 px-1">
        <ToolGlyph call={call} shown={shown} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium break-words">{label}</h3>
          {idText ? (
            <code className="text-muted-foreground block text-xs break-all">{idText}</code>
          ) : null}
          <p className={cn("mt-1 text-xs tabular-nums", TOOL_STATUS_TONE[call.status])}>
            {[
              t(TOOL_STATUS_LABEL[call.status]),
              t("context.tools.turn", { turn: call.turn }),
              duration,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1 px-1">
        <Button
          variant="outline"
          size="sm"
          className={cn("self-start", PANEL_BUTTON)}
          onClick={() => onShowInThread(call)}
        >
          <MessageSquareIcon />
          {t("context.tools.showInThread")}
        </Button>
        {missing ? (
          <p className="text-muted-foreground text-xs">{t("context.tools.notInThread")}</p>
        ) : null}
      </div>
      <ToolCallDetail
        t={chatT}
        input={call.input}
        output={call.output}
        error={call.error}
        metadata={{
          tool_call_id: call.toolCallId,
          ...(call.durationMs === undefined ? {} : { duration_ms: call.durationMs }),
        }}
      />
    </div>
  );
}
