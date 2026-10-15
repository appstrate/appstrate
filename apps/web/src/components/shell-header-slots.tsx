// SPDX-License-Identifier: Apache-2.0

/**
 * The shell header's slots, apart from the header itself: a page that fills one
 * (`DetailBar`, the tab bars, the chat) imports this, and must not drag the
 * whole shell (sidebar, session, notifications) in with it.
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Where a page's own header content lands. The header belongs to the shell, and
 * the shell stays mounted while pages come and go, so a page does not pass its
 * content down to the header: it portals it into one of these slots, and it
 * leaves with the page.
 *
 * - `actions`: the controls at the header's right end, left of the notification
 *   bell (`ShellHeaderActions`).
 * - `lead`: the page's own title block, which takes the breadcrumb's place
 *   (`ShellHeaderLead`).
 * - `tabs`: the page's tab bar, a second row inside the same band
 *   (`ShellHeaderTabs`).
 */
type HeaderSlotName = "actions" | "lead" | "tabs";
type HeaderSlots = Record<HeaderSlotName, HTMLElement | null>;
type HeaderSlotSetters = Record<HeaderSlotName, (node: HTMLElement | null) => void>;

const NO_SLOTS: HeaderSlots = { actions: null, lead: null, tabs: null };
const HeaderSlotsContext = createContext<HeaderSlots>(NO_SLOTS);
const HeaderSlotSettersContext = createContext<HeaderSlotSetters | null>(null);

/** Raised once by the layout, around both the header and the page it frames. */
export function ShellFrameProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [lead, setLead] = useState<HTMLElement | null>(null);
  const [tabs, setTabs] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ actions, lead, tabs }), [actions, lead, tabs]);
  const setters = useMemo(() => ({ actions: setActions, lead: setLead, tabs: setTabs }), []);
  return (
    <HeaderSlotSettersContext.Provider value={setters}>
      <HeaderSlotsContext.Provider value={slots}>{children}</HeaderSlotsContext.Provider>
    </HeaderSlotSettersContext.Provider>
  );
}

function HeaderPortal({ slot, children }: { slot: HeaderSlotName; children: ReactNode }) {
  const node = useContext(HeaderSlotsContext)[slot];
  return node ? createPortal(children, node) : null;
}

/** A page's controls for the header's right end, left of the notification bell. */
export function ShellHeaderActions({ children }: { children: ReactNode }) {
  return <HeaderPortal slot="actions">{children}</HeaderPortal>;
}

/** A page's title block: while one is drawn, it stands where the breadcrumb would. */
export function ShellHeaderLead({ children }: { children: ReactNode }) {
  return <HeaderPortal slot="lead">{children}</HeaderPortal>;
}

/**
 * A page's tab bar, in the header's second row. Portalled, so the bar keeps the
 * page's own context: Radix tabs rendered here still answer the page's `<Tabs>`.
 */
export function ShellHeaderTabs({ children }: { children: ReactNode }) {
  return <HeaderPortal slot="tabs">{children}</HeaderPortal>;
}

/** The element a slot's content is portalled into, drawn by the header itself. */
export function HeaderSlotOutlet({
  slot,
  ...props
}: { slot: HeaderSlotName } & ComponentPropsWithoutRef<"div">) {
  const setters = useContext(HeaderSlotSettersContext);
  return <div ref={setters?.[slot]} {...props} />;
}
