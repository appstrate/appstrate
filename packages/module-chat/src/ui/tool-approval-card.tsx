// SPDX-License-Identifier: Apache-2.0

/**
 * Human approval of a writing tool call (`tool-approval.ts` holds it server
 * side). Same pattern as AI Elements and assistant-ui: the tool's own row stays
 * (its arguments one click away, like every tool row), and the AI Elements
 * `Confirmation` banner sits under it: a request with Deny / Allow, then a
 * quiet receipt. It reads assistant-ui's native `approval` on the part and
 * answers through `respondToApproval`, which the runtime hands to the chat's
 * `onRespondToToolApproval` (a POST to the turn).
 */

import * as React from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { ToolUIPart } from "ai";
import { CheckIcon, XIcon } from "lucide-react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  type ConfirmationProps,
} from "./confirmation.tsx";
import { useChatHost } from "./runtime-context.ts";
import { extractAgentLabel } from "./run-events.ts";
import { asRecord } from "./tool-result.ts";

/** The package the call targets: a `packageId` path param, else `@scope/name`. */
function targetOf(args: unknown): string | undefined {
  const rec = asRecord(args) ?? {};
  const packageId = asRecord(rec.path_params)?.packageId;
  if (typeof packageId === "string" && packageId) return packageId;
  return extractAgentLabel(rec);
}

/** assistant-ui's approval, in the AI SDK shape `Confirmation` takes. */
function sdkApproval(part: ToolCallMessagePartProps): ConfirmationProps["approval"] {
  const approval = part.approval;
  if (!approval) return undefined;
  if (approval.approved === undefined) return { id: approval.id };
  return { id: approval.id, approved: approval.approved, reason: approval.reason };
}

/** assistant-ui's part, read back as the AI SDK tool state `Confirmation` keys on. */
function approvalState(part: ToolCallMessagePartProps): ToolUIPart["state"] {
  const approval = part.approval;
  if (approval?.approved === undefined) return "approval-requested";
  if (!approval.approved) return "output-denied";
  return part.result === undefined ? "approval-responded" : "output-available";
}

/** The tool's own row, with the approval banner under it when the call was held. */
export function ToolApprovalGate({
  part,
  label,
  labelKey,
  children,
}: {
  part: ToolCallMessagePartProps;
  /** Shown verbatim (a tool name); `labelKey` is translated instead, as on the tool row. */
  label?: string;
  labelKey?: string;
  children: React.ReactNode;
}) {
  const { t } = useChatHost();
  const action = labelKey ? t(labelKey) : (label ?? "");
  const [failed, setFailed] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const target = targetOf(part.args);

  const respond = (approved: boolean) => {
    setSending(true);
    setFailed(false);
    part.respondToApproval({ approved }).catch(() => {
      setFailed(true);
      setSending(false);
    });
  };

  return (
    <>
      {children}
      <Confirmation
        approval={sdkApproval(part)}
        state={approvalState(part)}
        className="-mt-1 mb-3 text-sm"
      >
        <ConfirmationRequest>
          <ConfirmationTitle>
            {t("approval.request", {
              action: target ? t("approval.action", { action, target }) : action,
            })}
          </ConfirmationTitle>
          {failed ? <p className="text-destructive text-xs">{t("approval.failed")}</p> : null}
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <ConfirmationTitle className="text-muted-foreground flex items-center gap-2">
            <CheckIcon className="size-4" />
            {t("approval.allowed")}
          </ConfirmationTitle>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <ConfirmationTitle className="text-muted-foreground flex items-center gap-2">
            <XIcon className="size-4" />
            {part.approval?.reason
              ? t("approval.deniedWithReason", { reason: part.approval.reason })
              : t("approval.denied")}
          </ConfirmationTitle>
        </ConfirmationRejected>
        <ConfirmationActions>
          <ConfirmationAction variant="outline" disabled={sending} onClick={() => respond(false)}>
            {t("approval.deny")}
          </ConfirmationAction>
          <ConfirmationAction disabled={sending} onClick={() => respond(true)}>
            {t("approval.allow")}
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    </>
  );
}
