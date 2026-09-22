// SPDX-License-Identifier: Apache-2.0

/**
 * `/skill` mentions: the composer popover that inserts one, and the chip that
 * renders one back in the sent bubble.
 *
 * Together with `skill-directive.ts` — which owns the string contract and the
 * two pure functions this file renders through — these are the ONLY places
 * assistant-ui's `unstable_*` surface is touched. The trigger popover, the
 * mention adapter and the directive formatter are all marked unstable by the
 * library and WILL change shape; keeping every call site in two adjacent files
 * makes a version bump something you read, not something you grep for. The
 * split itself is not editorial: the lint gate refuses a module that exports
 * both components and plain functions (fast-refresh boundaries), and the pure
 * half is what the tests want anyway.
 *
 * The catalogue behind the popover is the picker's query
 * (`chatSkillsQueryKey` / `fetchChatSkills`): one cache entry serves both, so
 * typing `/` after opening the picker costs nothing.
 */

import * as React from "react";
import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon } from "lucide-react";
import { chatSkillsQueryKey, fetchChatSkills } from "./chat-skills.ts";
import { useChatHeaders, useChatHost } from "./runtime-context.ts";
import { spaceIdFromHeaders } from "./sessions.ts";
import { skillMentionItems, splitSkillDirectives } from "./skill-directive.ts";

/** The catalogue changes when a package is published or activated — rarely. */
const SKILLS_STALE_MS = 60_000;

// ─── Composer popover ────────────────────────────────────────────────────────

/**
 * The `/` popover. Mounted INSIDE `ComposerPrimitive.Root` (which must be
 * `relative`) and under `ComposerPrimitive.Unstable_TriggerPopoverRoot`, which
 * is what installs the composer-input plugin registry the primitive needs:
 * without that ancestor the plain textarea never forwards ↑/↓/Enter/Esc and
 * the popover stays inert.
 *
 * The primitive renders NO positioning and NO container of its own while the
 * trigger is inactive — closed, it renders its children bare, and both of them
 * (`Directive`, `Items`) return `null` then. So the box styling and the
 * `absolute bottom-full` placement belong on the popover element itself, never
 * on a wrapper: a wrapper would paint an empty card over the composer whenever
 * the trigger is closed.
 */
export function SkillMentionPopover() {
  const { t } = useChatHost();
  const getHeaders = useChatHeaders();
  const spaceId = spaceIdFromHeaders(getHeaders);

  // Shares the picker's cache entry, so whichever surface asks first pays for
  // the fetch. Enabled on mount rather than on the first `/`: the primitive
  // exposes its open state only to its own descendants, and a 60 s-fresh list
  // of at most ~100 rows is not worth the plumbing.
  const skills = useQuery({
    queryKey: chatSkillsQueryKey(spaceId),
    queryFn: () => fetchChatSkills(getHeaders),
    enabled: !!spaceId,
    staleTime: SKILLS_STALE_MS,
  });
  // `isPending` stays true forever while the query is disabled, so a missing
  // space must read as "nothing to offer", not as "still loading".
  const loading = !!spaceId && skills.isPending;

  const items = React.useMemo(() => skillMentionItems(skills.data ?? []), [skills.data]);
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

/**
 * One row. `data-highlighted` is set by the primitive on the keyboard-active
 * entry (and on hover, which it treats as a highlight move), so the active
 * style is a pure CSS concern — no state of ours.
 */
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
        {/* The picker's own group header, reused verbatim: one concept, one
            string — rewording it there must not leave this row behind. */}
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

/** An inline mention chip. `title` carries the package id the model resolves. */
function SkillChip({ label, id }: { label: string; id: string }) {
  return (
    <span
      title={id}
      className="bg-background text-foreground mx-0.5 inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium"
    >
      <BookOpenIcon className="size-3 shrink-0 self-center" />
      {label}
    </span>
  );
}

/**
 * The `Text` part renderer of a USER bubble: prose as it was typed (the bubble
 * is `whitespace-pre-wrap`, never markdown), each `/skill` directive as a chip.
 */
export function SkillDirectiveText({ text }: { text: string }) {
  const segments = React.useMemo(() => splitSkillDirectives(text), [text]);
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "skill" ? (
          // Index keys: segments have no identity of their own and the list is
          // fully re-derived whenever the text changes.
          <SkillChip key={i} label={segment.label} id={segment.id} />
        ) : (
          <React.Fragment key={i}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  );
}
