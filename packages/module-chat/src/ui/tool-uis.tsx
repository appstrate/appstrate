// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-specific tool UIs — richer than the generic ToolFallback for the
 * calls a user actually cares about. Registered by mounting the components
 * (once) inside the runtime provider; the thread's `part.toolUI` then picks
 * them up in place of the fallback card.
 *
 * `invoke_operation` is the one we dress up: a readable verb + icon for the
 * platform operation being run. The other MCP meta-tools (search/describe) stay
 * on the fallback — they're plumbing.
 */

import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { OAuthConnectCard } from "./oauth-connect-card.tsx";
import { extractAuthOffer } from "./auth-offer.ts";

/**
 * `invoke_operation` operationId for starting an integration OAuth flow. When
 * the model calls it, the result carries an `auth_url`; we surface a connect
 * button that resumes the conversation on completion (see oauth-connect-card).
 */
const INITIATE_OAUTH_OP = "initiateIntegrationOAuth";

type Tone = "muted" | "success" | "error";

const TONE_CLASS: Record<Tone, string> = {
  muted: "text-muted-foreground",
  success: "text-primary",
  error: "text-destructive",
};

/** Compact one-line tool card: status icon · label · trailing id (mono). */
function ToolLine({
  Icon,
  iconClass,
  label,
  muted,
  trailing,
}: {
  Icon: LucideIcon;
  iconClass: string;
  label: string;
  muted?: boolean;
  trailing?: string;
}) {
  return (
    <div className="bg-card text-card-foreground my-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <Icon className={`size-4 shrink-0 ${iconClass}`} />
      <span className={`flex-1 truncate ${muted ? "text-muted-foreground" : ""}`}>{label}</span>
      {trailing ? <code className="text-muted-foreground shrink-0 text-xs">{trailing}</code> : null}
    </div>
  );
}

// Readable label + icon for an Appstrate API operation, by verb prefix — a
// heuristic, not an exhaustive operationId map (which would rot). The first
// matching rule wins; unmatched ids fall back to a neutral "Opération".
const OP_RULES: { re: RegExp; label: string; tone: Tone; Icon: LucideIcon }[] = [
  { re: /^(run|trigger|execute|start)/i, label: "Lancement", tone: "success", Icon: PlayIcon },
  { re: /^(create|post|add|import|upload)/i, label: "Création", tone: "success", Icon: PlusIcon },
  { re: /^(update|patch|put|set|rename|configure)/i, label: "Modification", tone: "muted", Icon: PencilIcon }, // prettier-ignore
  { re: /^(delete|remove|cancel|archive)/i, label: "Suppression", tone: "error", Icon: Trash2Icon },
  { re: /^(list|get|search|find|read)/i, label: "Lecture", tone: "muted", Icon: SearchIcon },
];

export const InvokeOperationToolUI = makeAssistantToolUI<
  { operation_id?: string; path_params?: { packageId?: string } },
  unknown
>({
  toolName: "invoke_operation",
  render: ({ args, status, result }) => {
    const opId = args?.operation_id ?? "";

    // OAuth kickoff → render an interactive connect card (button + auto-resume)
    // once the result carries the auth_url. Until then, fall through to the
    // generic running line.
    if (opId === INITIATE_OAUTH_OP) {
      const offer = extractAuthOffer(result);
      if (offer) {
        return (
          <OAuthConnectCard
            authUrl={offer.authUrl}
            state={offer.state}
            packageId={args?.path_params?.packageId}
          />
        );
      }
    }

    const rule = OP_RULES.find((r) => r.re.test(opId)) ?? {
      Icon: ZapIcon,
      label: "Opération",
      tone: "muted" as Tone,
    };
    const running = status.type === "running";
    return (
      <ToolLine
        Icon={running ? Loader2Icon : rule.Icon}
        iconClass={running ? "text-muted-foreground animate-spin" : TONE_CLASS[rule.tone]}
        label={rule.label}
        muted
        trailing={opId}
      />
    );
  },
});
