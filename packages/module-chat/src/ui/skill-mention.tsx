// SPDX-License-Identifier: Apache-2.0

// `/skill` mentions: the composer popover and the sent-bubble chip. With
// `skill-directive.ts`, `skill-trigger.ts` and the root in `thread.tsx`, the only
// users of assistant-ui's `unstable_*` surface.

import * as React from "react";
import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { BookOpenIcon } from "lucide-react";
import { useChatHost } from "./runtime-context.ts";
import { splitSkillDirectives } from "../skill-mentions.ts";
import { skillMentionItems } from "./skill-directive.ts";
import { createSkillTriggerMatcher } from "./skill-trigger.ts";
import { useChatSkillsCatalog } from "./use-chat-skills.ts";

/** Inside the `relative` composer root; styled on itself, since closed it renders bare. */
export function SkillMentionPopover() {
  const { t } = useChatHost();
  const { skills } = useChatSkillsCatalog();

  const items = React.useMemo(() => skillMentionItems(skills), [skills]);
  const matcher = React.useMemo(() => createSkillTriggerMatcher(items), [items]);
  // The chat's MCP tools are the model's business, not something a user types.
  const { adapter, directive } = unstable_useMentionAdapter({
    items,
    includeModelContextTools: false,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      matcher={matcher}
      adapter={adapter}
      aria-label={t("skills.mention.label")}
      data-testid="skill-mention-popover"
      className="bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-2 max-h-64 w-[min(22rem,calc(100vw-2.5rem))] overflow-y-auto rounded-lg border p-1 text-sm shadow-md"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive {...directive} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(matched) =>
          matched.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">
              {t("skills.mention.empty")}
            </p>
          ) : (
            matched.map((item, index) => (
              <SkillMentionRow key={item.id} item={item} index={index} />
            ))
          )
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

function SkillMentionRow({ item, index }: { item: Unstable_TriggerItem; index: number }) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItem
      item={item}
      index={index}
      data-testid="skill-mention-option"
      className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left"
    >
      <span className="flex w-full items-center gap-1.5">
        <BookOpenIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-xs font-medium">{item.label}</span>
      </span>
      {item.description ? (
        <span className="text-muted-foreground line-clamp-2 text-left text-[0.7rem] leading-snug">
          {item.description}
        </span>
      ) : null}
    </ComposerPrimitive.Unstable_TriggerPopoverItem>
  );
}

/** A mention chip: the id is on `title` for a pointer, in `aria-label` for a reader. */
function SkillChip({ label, id }: { label: string; id: string }) {
  const { t } = useChatHost();
  return (
    <span
      title={id}
      aria-label={t("skills.mention.chip", { id })}
      className="bg-background text-foreground mx-0.5 inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium"
    >
      <BookOpenIcon className="size-3 shrink-0 self-center" />
      {label}
    </span>
  );
}

/** A user bubble's `Text` part: prose as typed, directives as chips; `<p>` keeps parts apart. */
export function SkillDirectiveText({ text }: { text: string }) {
  const segments = React.useMemo(() => splitSkillDirectives(text), [text]);
  return (
    <p>
      {segments.map((segment, i) =>
        segment.kind === "skill" ? (
          <SkillChip key={i} label={segment.label} id={segment.id} />
        ) : (
          <React.Fragment key={i}>{segment.text}</React.Fragment>
        ),
      )}
    </p>
  );
}
