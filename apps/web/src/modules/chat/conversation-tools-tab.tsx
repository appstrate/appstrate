// SPDX-License-Identifier: Apache-2.0

import { useEffect, useId, useRef } from "react";
import { MessageSquareIcon, WrenchIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  activityCounts,
  type ConversationToolCall,
} from "@appstrate/module-chat/conversation-tools";
import type { ShownCall } from "@appstrate/module-chat/tool-presentation";
import { ToolCallDetail } from "@appstrate/module-chat/tool-call-detail";
import { CallStep } from "@appstrate/module-chat/call-step";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { IntegrationIcon } from "@appstrate/ui/components/integration-icon";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Switch } from "@appstrate/ui/components/switch";
import { EmptyState, ErrorState } from "../../components/page-states";
import { Waiting } from "../../components/loading-skeletons";
import { SkeletonLine } from "../../components/skeleton-line";
import { RowSpaceName } from "../../components/run-row";
import { formatDuration } from "../../lib/format-duration";
import {
  TOOL_STATUS_LABEL,
  actsInSeveralSpaces,
  useConversationTools,
  useToolLabel,
} from "./use-conversation-tools";
import { useChatTranslate } from "./use-chat-runtime";

/** The line holding the lookups' switch: the whole line is its label, a 40 px target. */
const SWITCH_LINE_CLASS = "flex min-h-10 items-center justify-between gap-3 border-b px-4";

const TURN_HEAD_CLASS =
  "text-muted-foreground bg-muted/40 flex items-center gap-2 border-b px-4 py-1.5 text-xs font-medium";

/** A turn's step lines, under its heading. */
const TURN_CALLS_CLASS = "border-b px-4 py-1 last:border-b-0";

/**
 * The call's icon: the logo of the integration it acted on, as its card draws it, else its icon
 * (`showCall`) in its line's muted tone. An agent's tile is not drawn: it reads the chat host,
 * which the panel is rendered outside of.
 */
export function ToolCallIcon({ shown }: { shown: ShownCall }) {
  if (shown.subject?.kind === "integration") {
    return <IntegrationIcon src={shown.subject.icon} className="size-4 rounded-sm" />;
  }
  const { Icon } = shown;
  return <Icon aria-hidden="true" className="size-4" />;
}

/**
 * One call as the thread draws it, a step line (`CallStep`): its detail opens under it, led by
 * "See in the thread" (`missing`: the last ask found no card). Once open it scrolls into view, so
 * a call opened from the summary or by a reveal that missed is in sight; one the reader opened
 * already is, and does not move.
 */
function ToolCallStep({
  call,
  shown,
  spanning,
  open,
  missing,
  onOpenChange,
  onShowInThread,
}: {
  call: ConversationToolCall;
  shown: ShownCall;
  /** The calls acted in several spaces: the line names its own. */
  spanning: boolean;
  open: boolean;
  missing: boolean;
  onOpenChange: (open: boolean) => void;
  onShowInThread: () => void;
}) {
  const { t } = useTranslation("chat");
  const chatT = useChatTranslate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <CallStep
      ref={ref}
      lead={<ToolCallIcon shown={shown} />}
      label={shown.label}
      idText={shown.idText}
      running={call.status === "running"}
      trailing={
        <>
          {spanning ? <RowSpaceName spaceId={call.spaceId} /> : null}
          {call.durationMs === undefined ? null : (
            <span className="shrink-0 text-xs tabular-nums">{formatDuration(call.durationMs)}</span>
          )}
        </>
      }
      failure={
        call.status === "error" || call.status === "denied"
          ? { label: t(TOOL_STATUS_LABEL[call.status]), visible: true }
          : undefined
      }
      errorText={call.error}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="mb-3 flex flex-col gap-1">
        <Button
          variant="outline"
          size="sm"
          className="desktop-pointer:h-9 h-10 self-start"
          onClick={onShowInThread}
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
    </CallStep>
  );
}

/** A step line on its way: its icon's square and its label's bar. */
function CallLineSkeleton({ width }: { width: string }) {
  return (
    <div className="desktop-pointer:h-8 flex h-10 items-center gap-2">
      <Skeleton className="size-4 shrink-0 rounded-sm" />
      <SkeletonLine className={cn("text-sm", width)} />
    </div>
  );
}

/**
 * The Tools tab while its calls are read: a turn's heading, its step lines. No lookups' switch:
 * the list draws it only when the calls hold a lookup.
 */
function ToolsListSkeleton() {
  return (
    <Waiting>
      <div className={TURN_HEAD_CLASS}>
        <SkeletonLine className="w-12" />
      </div>
      <div className={TURN_CALLS_CLASS}>
        {["w-32", "w-40", "w-28"].map((width) => (
          <CallLineSkeleton key={width} width={width} />
        ))}
      </div>
    </Waiting>
  );
}

/**
 * The conversation's calls by turn, each heading counting its turn's calls as the thread's group
 * does, its lookups behind a switch the panel keeps. A call is a step line holding its detail;
 * the one the panel holds open (`openToolCallId`) is listed even when it is a hidden lookup.
 */
export function ConversationToolsList({
  conversationId,
  active,
  showLookups,
  onShowLookupsChange,
  openToolCallId,
  missing,
  onOpenChange,
  onShowInThread,
}: {
  conversationId: string | null;
  active: boolean;
  showLookups: boolean;
  onShowLookupsChange: (show: boolean) => void;
  openToolCallId: string | null;
  /** "See in the thread" found no card for the open call. */
  missing: boolean;
  onOpenChange: (call: ConversationToolCall, open: boolean) => void;
  onShowInThread: (call: ConversationToolCall) => void;
}) {
  const { t } = useTranslation("chat");
  const chatT = useChatTranslate();
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
  const shown = showLookups
    ? tools.calls
    : tools.calls.filter((call) => !call.lookup || call.toolCallId === openToolCallId);
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
        turns.map((turn) => {
          const turnCalls = tools.calls.filter((call) => call.turn === turn);
          const turnLookups = turnCalls.filter((call) => call.lookup).length;
          return (
            <section key={turn} aria-labelledby={`${switchId}-turn-${turn}`}>
              <h3 id={`${switchId}-turn-${turn}`} className={TURN_HEAD_CLASS}>
                <span className="shrink-0">{t("context.tools.turn", { turn })}</span>
                <span className="ml-auto min-w-0 truncate font-normal">
                  {activityCounts(chatT, {
                    lookups: turnLookups,
                    actions: turnCalls.length - turnLookups,
                  })}
                </span>
              </h3>
              <div className={TURN_CALLS_CLASS}>
                {shown
                  .filter((call) => call.turn === turn)
                  .map((call) => {
                    const open = call.toolCallId === openToolCallId;
                    return (
                      <ToolCallStep
                        key={call.toolCallId}
                        call={call}
                        shown={show(call)}
                        spanning={spanning}
                        open={open}
                        missing={open && missing}
                        onOpenChange={(next) => onOpenChange(call, next)}
                        onShowInThread={() => onShowInThread(call)}
                      />
                    );
                  })}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
