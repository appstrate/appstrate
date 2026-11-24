// SPDX-License-Identifier: Apache-2.0

import { useAui, useAuiState } from "@assistant-ui/react";
import { Button } from "@appstrate/ui/components/button";
import { FieldLegend, FieldSet } from "@appstrate/ui/components/field";
import { asRecord } from "@appstrate/core/safe-json";
import { pendingSpaceChoiceSchema, SPACE_CHOICE_PART } from "../space-choice.ts";
import { useChatHost } from "./runtime-context.ts";
import { useConversationScope } from "./conversation-scope.ts";

/** Only the latest assistant message can still be waiting for an answer. A click starts a new user turn. */
export function TurnSpaceChoice() {
  const aui = useAui();
  const { t, actingSpaceIds, useSpaceLabelOf, can } = useChatHost();
  const labelOf = useSpaceLabelOf();
  const { restricted, originSpaceId } = useConversationScope();
  const current = useAuiState(
    (s) => s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id,
  );
  const running = useAuiState((s) => s.thread.isRunning);
  const parts = useAuiState((s) => s.message.content);
  if (!current || actingSpaceIds === null) return null;
  const canReply = can("chat:write");

  const choices = parts.flatMap((part) => {
    if (part.type !== "tool-call") return [];
    const data = pendingSpaceChoiceSchema.safeParse(asRecord(part.result).spaceChoice);
    return data.success ? [{ toolCallId: part.toolCallId, ...data.data }] : [];
  });
  return choices.map(({ toolCallId, spaceIds, tool, operationId }) => {
    const options = spaceIds
      .filter((id) => actingSpaceIds.includes(id) && (!restricted || id === originSpaceId))
      .map((id) => ({ id, name: labelOf(id) ?? id }));
    if (!options.length || !canReply) {
      return (
        <p key={toolCallId} role="status" className="text-muted-foreground my-3 text-sm">
          {t("tool.spaceChoiceUnavailable")}
          {canReply && ` ${t("tool.spaceChoiceRetry")}`}
        </p>
      );
    }
    return (
      <FieldSet key={toolCallId} className="my-3 gap-2 rounded-lg border p-3" disabled={running}>
        <FieldLegend variant="label" className="mb-0 px-1">
          {t("tool.chooseSpace")}
        </FieldLegend>
        <div className="flex flex-wrap gap-2">
          {options.map(({ id, name }) => (
            <Button
              key={id}
              type="button"
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal"
              onClick={() => {
                const state = aui.thread().getState();
                if (
                  state.isRunning ||
                  state.messages[state.messages.length - 1]?.id !== aui.message().getState().id
                )
                  return;
                aui.thread().append({
                  role: "user",
                  content: [
                    { type: "text", text: t("tool.spaceChoiceReply") },
                    {
                      type: "data",
                      name: SPACE_CHOICE_PART.slice("data-".length),
                      data: { tool, spaceId: id, ...(operationId && { operationId }) },
                    },
                  ],
                });
              }}
            >
              {name}
              {options.some((other) => other.id !== id && other.name === name) && (
                <code className="text-muted-foreground text-xs">{id}</code>
              )}
            </Button>
          ))}
        </div>
      </FieldSet>
    );
  });
}
