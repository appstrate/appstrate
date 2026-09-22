// SPDX-License-Identifier: Apache-2.0

/**
 * `/skill` mentions: the composer popover that inserts one, and the chip that
 * renders one back in the sent bubble. With `skill-directive.ts` (the string
 * contract) and `skill-trigger.ts` (when the popover may open) — the pure
 * halves, split out because the lint gate refuses a module exporting both
 * components and plain functions — these are the ONLY places assistant-ui's
 * `unstable_*` surface is touched, so a version bump is something you read.
 */

import * as React from "react";
import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { BookOpenIcon } from "lucide-react";
import { useChatHost } from "./runtime-context.ts";
import { skillMentionItems, splitSkillDirectives } from "./skill-directive.ts";
import { createSkillTriggerMatcher } from "./skill-trigger.ts";
import { useChatSkillsCatalog } from "./use-chat-skills.ts";

// ─── Composer popover ────────────────────────────────────────────────────────

/**
 * The `/` popover. Must be INSIDE `ComposerPrimitive.Root` (which must be
 * `relative`) and under `Unstable_TriggerPopoverRoot`, which installs the
 * plugin registry: without it the textarea never forwards ↑/↓/Enter/Esc.
 * Closed, the primitive renders its children bare — so the box styling and the
 * `absolute bottom-full` placement belong on the popover element itself, never
 * on a wrapper that would paint an empty card over the composer.
 */
export function SkillMentionPopover() {
  const { t } = useChatHost();
  // The picker's cache entry: whichever surface asks first pays for the fetch.
  const { skills, loading } = useChatSkillsCatalog();

  const items = React.useMemo(() => skillMentionItems(skills), [skills]);
  const matcher = React.useMemo(() => createSkillTriggerMatcher(items), [items]);
  // Flat list, no categories: `includeModelContextTools` is off because the
  // chat's MCP tools are the model's business, not something a user types.
  const { adapter, directive } = unstable_useMentionAdapter({
    items,
    includeModelContextTools: false,
  });
  const label = t("skills.mention.label");

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      matcher={matcher}
      adapter={adapter}
      isLoading={loading}
      aria-label={label}
      className="bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-2 max-h-64 w-[min(22rem,calc(100vw-2.5rem))] overflow-y-auto rounded-lg border p-1 text-sm shadow-md"
    >
      {/* `directive` is `{ formatter: unstable_defaultDirectiveFormatter }` —
          spread rather than reconstructed so the adapter and the insertion
          behaviour can never drift apart. */}
      <ComposerPrimitive.Unstable_TriggerPopover.Directive {...directive} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems aria-label={label}>
        {(matched) =>
          matched.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">
              {loading ? t("skills.mention.loading") : t("skills.mention.empty")}
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

/** One row. `data-highlighted` is the primitive's — the active style is pure CSS. */
function SkillMentionRow({ item, index }: { item: Unstable_TriggerItem; index: number }) {
  const { t } = useChatHost();
  const isPlatform = item.metadata?.["source"] === "platform";
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItem
      item={item}
      index={index}
      className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left"
    >
      <span className="flex w-full items-center gap-1.5">
        <BookOpenIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-xs font-medium">{item.label}</span>
        {/* The picker's group header, reused verbatim: one concept, one string. */}
        {isPlatform && (
          <span className="text-muted-foreground shrink-0 text-[0.65rem]">
            {t("skills.group.platform")}
          </span>
        )}
      </span>
      {item.description ? (
        <span className="text-muted-foreground line-clamp-2 text-left text-[0.7rem] leading-snug">
          {item.description}
        </span>
      ) : null}
    </ComposerPrimitive.Unstable_TriggerPopoverItem>
  );
}

// ─── Sent bubble ─────────────────────────────────────────────────────────────

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

/**
 * The `Text` part renderer of a USER bubble: prose as typed (the bubble is
 * `whitespace-pre-wrap`, never markdown), each directive as a chip. The `<p>`
 * is the default renderer's and is load-bearing — two text parts of one message
 * would otherwise run together on a single line.
 */
export function SkillDirectiveText({ text }: { text: string }) {
  const segments = React.useMemo(() => splitSkillDirectives(text), [text]);
  return (
    <p>
      {segments.map((segment, i) =>
        segment.kind === "skill" ? (
          // Index keys: segments have no identity, and the list is re-derived.
          <SkillChip key={i} label={segment.label} id={segment.id} />
        ) : (
          <React.Fragment key={i}>{segment.text}</React.Fragment>
        ),
      )}
    </p>
  );
}
