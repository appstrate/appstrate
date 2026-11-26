// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from "react";
import { ArrowLeftIcon, MessageSquareIcon, WrenchIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  revealToolCall,
  type ConversationToolCall,
  type ConversationToolStatus,
} from "@appstrate/module-chat/conversation-tools";
import { toolPresentation } from "@appstrate/module-chat/tool-presentation";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Switch } from "@appstrate/ui/components/switch";
import { EmptyState, ErrorState } from "../../components/page-states";
import { JsonView } from "../../components/json-view";
import { TextSkeleton } from "../../components/loading-skeletons";
import { RowSpaceName } from "../../components/run-row";
import { spansSpaces, useConversationTools, useToolLabel } from "./use-conversation-tools";

const STATUS_KEY: Record<Exclude<ConversationToolStatus, "success">, string> = {
  running: "context.tools.status.running",
  error: "context.tools.status.error",
  denied: "context.tools.status.denied",
};

const STATUS_TONE: Record<ConversationToolStatus, string> = {
  running: "text-muted-foreground",
  success: "text-muted-foreground",
  error: "text-destructive",
  denied: "text-warning",
};

/** The call's lead glyph: its tool's icon in the status' tone, a spinner while it runs. */
function ToolGlyph({ call }: { call: ConversationToolCall }) {
  const { Icon } = toolPresentation(call.toolName, call.input);
  return (
    <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
      {call.status === "running" ? (
        <Spinner className="text-muted-foreground size-4" />
      ) : (
        <Icon className={cn("size-4", STATUS_TONE[call.status])} />
      )}
    </span>
  );
}

/** One call: its tool, what it acted on, its outcome when it is not a plain success. */
export function ToolCallRow({
  call,
  spanning,
  onSelect,
}: {
  call: ConversationToolCall;
  /** The calls acted in several spaces: the row names its own. */
  spanning: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("chat");
  const { title, target } = useToolLabel()(call);
  const outcome =
    call.status === "success"
      ? call.lookup
        ? t("context.tools.lookup")
        : null
      : t(STATUS_KEY[call.status]);
  return (
    <button
      type="button"
      className="hover:bg-muted/50 flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
      onClick={onSelect}
    >
      <ToolGlyph call={call} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {[target, outcome].filter(Boolean).join(" · ") || t("context.tools.noTarget")}
        </span>
      </span>
      {spanning && <RowSpaceName spaceId={call.spaceId} />}
    </button>
  );
}

/** The conversation's calls by turn, its lookups behind a switch. */
export function ConversationToolsList({
  conversationId,
  active,
  onSelect,
}: {
  conversationId: string | null;
  active: boolean;
  onSelect: (call: ConversationToolCall) => void;
}) {
  const { t } = useTranslation("chat");
  const switchId = useId();
  const [showLookups, setShowLookups] = useState(false);
  const { tools, isLoading, error } = useConversationTools(conversationId, active);

  if (!conversationId) {
    return <EmptyState message={t("context.unsaved")} icon={WrenchIcon} compact />;
  }
  if (isLoading) return <TextSkeleton className="p-4" />;
  if (error || !tools) return <ErrorState error={error} compact />;
  if (tools.calls.length === 0) {
    return <EmptyState message={t("context.tools.empty")} icon={WrenchIcon} compact />;
  }

  const lookups = tools.calls.filter((call) => call.lookup).length;
  const shown = showLookups ? tools.calls : tools.calls.filter((call) => !call.lookup);
  const spanning = spansSpaces(shown);
  const turns = [...new Set(shown.map((call) => call.turn))];

  return (
    <div>
      {lookups > 0 ? (
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
          <label htmlFor={switchId} className="text-muted-foreground text-xs">
            {t("context.tools.showLookups", { count: lookups })}
          </label>
          <Switch id={switchId} checked={showLookups} onCheckedChange={setShowLookups} />
        </div>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState message={t("context.tools.noAction")} icon={WrenchIcon} compact />
      ) : (
        turns.map((turn) => (
          <section key={turn} aria-labelledby={`${switchId}-turn-${turn}`}>
            <h3
              id={`${switchId}-turn-${turn}`}
              className="text-muted-foreground bg-muted/40 border-b px-4 py-1.5 text-xs font-medium"
            >
              {t("context.tools.turn", { turn })}
            </h3>
            <div className="divide-y border-b last:border-b-0">
              {shown
                .filter((call) => call.turn === turn)
                .map((call) => (
                  <ToolCallRow
                    key={call.toolCallId}
                    call={call}
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

function DetailBlock({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-muted-foreground text-xs font-medium">{title}</h4>
      <div className="bg-muted/40 overflow-x-auto rounded-lg border p-2 text-xs">
        <JsonView data={value} />
      </div>
    </section>
  );
}

/**
 * One call over the Tools list: its outcome, input and output. "See in the thread" brings its card
 * into view, after `onReveal` made room for it (the phone's sheet covers the thread).
 */
export function ShownToolCall({
  conversationId,
  toolCallId,
  active,
  onBack,
  onReveal,
}: {
  conversationId: string | null;
  toolCallId: string;
  active: boolean;
  onBack: () => void;
  onReveal: () => void;
}) {
  const { t } = useTranslation("chat");
  const label = useToolLabel();
  const [missing, setMissing] = useState(false);
  const { tools, isLoading, error } = useConversationTools(conversationId, active);
  const call = tools?.calls.find((candidate) => candidate.toolCallId === toolCallId);

  const back = (
    <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
      <ArrowLeftIcon />
      {t("context.tools.backToList")}
    </Button>
  );
  if (isLoading) return <TextSkeleton className="p-4" />;
  if (error) return <ErrorState error={error} compact />;
  if (!call) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {back}
        <EmptyState message={t("context.tools.gone")} icon={WrenchIcon} compact />
      </div>
    );
  }

  const { title, target } = label(call);
  return (
    <div className="flex flex-col gap-4 p-3">
      {back}
      <div className="flex items-start gap-3 px-1">
        <ToolGlyph call={call} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium break-words">{title}</h3>
          {target ? (
            <code className="text-muted-foreground block text-xs break-all">{target}</code>
          ) : null}
          <p className={cn("mt-1 text-xs", STATUS_TONE[call.status])}>
            {call.status === "success"
              ? t("context.tools.status.success")
              : t(STATUS_KEY[call.status])}
            {" · "}
            {t("context.tools.turn", { turn: call.turn })}
          </p>
        </div>
      </div>
      {call.error ? (
        <p className="text-destructive bg-destructive/5 border-destructive/30 rounded-lg border px-3 py-2 text-sm break-words">
          {call.error}
        </p>
      ) : null}
      <div className="flex flex-col gap-1 px-1">
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            onReveal();
            // The thread is drawn under the panel: reveal once the panel made room for it.
            requestAnimationFrame(() => setMissing(!revealToolCall(call)));
          }}
        >
          <MessageSquareIcon />
          {t("context.tools.showInThread")}
        </Button>
        {missing ? (
          <p className="text-muted-foreground text-xs">{t("context.tools.notInThread")}</p>
        ) : null}
      </div>
      <DetailBlock title={t("tool.detail.input")} value={call.input} />
      <DetailBlock title={t("tool.detail.output")} value={call.output} />
    </div>
  );
}
