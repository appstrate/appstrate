// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu: assistant-ui's trigger popover, fed from the chat's commands. Choosing
 * an entry writes a skill or agent directive into the text, which the editor draws as an inline
 * chip (`composer-input.tsx`) and the send reads (`directive-send.ts`). The rules are in
 * `composer-commands.ts`.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ComposerPrimitive,
  unstable_useTriggerPopoverScopeContext as useTriggerPopoverScope,
  useAuiState,
} from "@assistant-ui/react";
import type { TriggerAdapter, TriggerItem } from "@assistant-ui/core";
import { BookOpenIcon, CheckIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { AGENT_DIRECTIVE } from "../directives.ts";
import { AgentGlyph } from "./agent-glyph.tsx";
import type { AgentAppearance } from "./agent-appearance.ts";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import { pinIds } from "./chat-skills.ts";
import { commandList, noCommandMatch, searchCommands, slashMatch } from "./composer-commands.ts";
import { useChatHost, useChatTransport } from "./runtime-context.ts";
import { useConversationSkillsContext, useDraftSkills } from "./use-conversation-skills.ts";
import { useChatCommands } from "./use-chat-commands.ts";

/** Wraps the composer: the popover and the editor find each other through it. */
export const CommandTriggers = ComposerPrimitive.TriggerPopoverRoot;

interface MenuNotice {
  text: string;
  className: string;
}

/** What the menu shows around its listbox: whether it is open, and its notice. */
interface MenuState {
  open: boolean;
  notice: MenuNotice | null;
}

const CLOSED: MenuState = { open: false, notice: null };

/** The menu, inside the composer card (it opens above it). */
export function CommandPopover() {
  const { can, t } = useChatHost();
  const transport = useChatTransport() ?? undefined;
  const conversation = useConversationSkillsContext();
  const { effective } = useDraftSkills();
  const draft = useAuiState((s) => s.composer.text);
  const running = useAuiState((s) => s.thread.isRunning);
  const writes = can("chat:write");
  // Read once the draft holds a `/` (the route's own guard: the caller may write the chat).
  const commands = useChatCommands(transport, writes && draft.includes("/"));
  const { data } = commands;
  const skills = useMemo(
    () => conversation && { pinned: pinIds(conversation.skills), effective },
    [conversation, effective],
  );
  const list = useMemo(
    () => (data ? commandList(data, { skills, running, draft }) : null),
    [data, skills, running, draft],
  );
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      // One flat list: the skills and the agents are headed in the popover, not drilled into.
      categories: () => [],
      categoryItems: () => [],
      search: (query) => (list ? searchCommands(list.items, query) : []),
    }),
    [list],
  );
  const failed = commands.isError;
  const matcher = (text: string, _char: string, cursor: number) =>
    slashMatch(text, cursor, (query) => noCommandMatch(list, query));
  // The listbox may hold only options: the card around it draws the notice, from a live region
  // that stays mounted so a screen reader hears each change.
  const [menu, setMenu] = useState<MenuState>(CLOSED);
  const { notice } = menu;
  return (
    <div
      className={cn(
        menu.open &&
          "bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-30 mb-2 flex flex-col overflow-hidden rounded-xl border shadow-md",
      )}
    >
      <p
        role="status"
        aria-live="polite"
        data-testid="slash-status"
        className={notice ? cn("px-3 pt-1", notice.className) : "sr-only"}
      >
        {notice?.text ?? ""}
      </p>
      <ComposerPrimitive.TriggerPopover
        char="/"
        adapter={adapter}
        matcher={matcher}
        isLoading={!list && !failed}
        aria-label={t("slash.label")}
        data-testid="slash-menu"
        className="max-h-72 overflow-y-auto overscroll-contain p-1"
      >
        <ComposerPrimitive.TriggerPopover.Directive />
        <Entries capped={list?.capped ?? []} failed={failed} onMenu={setMenu} />
      </ComposerPrimitive.TriggerPopover>
    </div>
  );
}

function Entries({
  capped,
  failed,
  onMenu,
}: {
  capped: readonly TriggerItem[];
  failed: boolean;
  /** Hands the menu's state to the card around the listbox, which this scope cannot reach. */
  onMenu: (menu: MenuState) => void;
}) {
  const { t } = useChatHost();
  const { open, items, query, isLoading } = useTriggerPopoverScope();
  const notice: MenuNotice | null = !open
    ? null
    : items.length === 0 && isLoading
      ? { text: t("slash.loading"), className: "text-muted-foreground text-sm py-2" }
      : items.length === 0 && failed
        ? { text: t("slash.error"), className: "text-destructive text-sm py-2" }
        : searchCommands(capped, query).length > 0
          ? {
              text: t("skills.chosenMax", { max: MAX_PINNED_SKILLS }),
              className: "text-muted-foreground text-xs py-1.5",
            }
          : null;
  const text = notice?.text;
  const className = notice?.className;
  // Before paint: the card appears with the listbox, never a frame after it.
  useLayoutEffect(
    () => onMenu({ open, notice: text ? { text, className: className ?? "" } : null }),
    [onMenu, open, text, className],
  );
  // Closed, the popover renders its children without its listbox: nothing of ours shows.
  if (!open) return null;
  const skills = items.filter((item) => item.type !== AGENT_DIRECTIVE);
  const agents = items.filter((item) => item.type === AGENT_DIRECTIVE);
  // Two listed skills of one name: their package id tells them apart.
  const names = skills.map((skill) => skill.label);
  const homonyms = new Set(names.filter((name, i) => names.indexOf(name) !== i));
  return (
    <>
      {/* The listbox carries the menu's name; each section is a group named by its heading. */}
      <Section heading={t("slash.skills")} items={skills} from={0} homonyms={homonyms} />
      <Section
        heading={t("slash.agents")}
        items={agents}
        from={skills.length}
        homonyms={homonyms}
      />
    </>
  );
}

function Section({
  heading,
  items,
  from,
  homonyms,
}: {
  heading: string;
  items: readonly TriggerItem[];
  from: number;
  homonyms: ReadonlySet<string>;
}) {
  if (items.length === 0) return null;
  return (
    <div role="group" aria-label={heading}>
      <div role="presentation" className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
        {heading}
      </div>
      {items.map((item, offset) => (
        <Row
          key={item.id}
          item={item}
          index={from + offset}
          homonym={item.type !== AGENT_DIRECTIVE && homonyms.has(item.label)}
        />
      ))}
    </div>
  );
}

function Row({ item, index, homonym }: { item: TriggerItem; index: number; homonym: boolean }) {
  const { t } = useChatHost();
  const { highlightedIndex } = useTriggerPopoverScope();
  const active = index === highlightedIndex;
  const ref = useRef<HTMLButtonElement>(null);
  // The list scrolls: the arrow keys must not move the active option out of sight.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const agent = item.type === AGENT_DIRECTIVE;
  const version = item.metadata?.version;
  return (
    <ComposerPrimitive.TriggerPopoverItem
      ref={ref}
      item={item}
      index={index}
      className={cn(
        "desktop-pointer:min-h-9 flex min-h-10 w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left",
        active && "bg-accent text-accent-foreground",
      )}
      // The editor keeps the focus: a click must not take it.
      onMouseDown={(event) => event.preventDefault()}
    >
      {agent ? (
        <>
          <AgentGlyph
            agent={item.metadata?.appearance as AgentAppearance | undefined}
            label={item.label}
            className="mt-0.5"
          />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium">{item.label}</span>
            <span className="text-muted-foreground shrink-0 text-xs">/{item.id}</span>
          </span>
        </>
      ) : (
        <>
          <BookOpenIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="truncate text-sm font-medium">{item.label}</span>
              {typeof version === "string" && (
                <span className="text-muted-foreground shrink-0 text-xs">v{version}</span>
              )}
              {homonym && <span className="text-muted-foreground truncate text-xs">{item.id}</span>}
            </span>
            <span className="text-muted-foreground line-clamp-1 block text-xs">
              {item.description}
            </span>
          </span>
          {(item.metadata?.pinned === true || item.metadata?.cited === true) && (
            <>
              <CheckIcon className="text-primary mt-0.5 size-4 shrink-0" />
              <span className="sr-only">
                {t(item.metadata.pinned === true ? "slash.pinned" : "slash.cited")}
              </span>
            </>
          )}
        </>
      )}
    </ComposerPrimitive.TriggerPopoverItem>
  );
}
