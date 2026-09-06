// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" — the persona an organization owner or administrator is
 * previewing the product as.
 *
 * The store is the SPA's only copy of the persona: the transport reads it
 * ({@link getViewAsHeader}), the banner renders from it, and nothing else
 * derives the preview from a response. The server enforces the restriction on
 * every call (`apps/api/src/lib/view-as.ts`) — a client-side preview that only
 * hid buttons would be the Airtable failure the plan names.
 *
 * Persisted under ONE key carrying its own `orgId`, so switching organization
 * cannot leave a persona pointing at the wrong one: the header is emitted only
 * while that id is the selected org, and `switchOrg` drops it outright.
 *
 * Read from `localStorage` at module init and never again, like `org-store` and
 * unlike `pairing-store`: a NEW TAB therefore opens inside an active preview,
 * which the banner makes plain, while a tab that leaves it is not followed by
 * the others. Tabs holding different personas is the same shape as tabs holding
 * different organizations, and the server judges every request on its own.
 *
 * @see docs/architecture/RBAC_VIEW_AS_PLAN.md §6
 */

import { z } from "zod";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { queryClient } from "../lib/query-client";
import { orgKeys } from "../lib/query-keys";
import { getCurrentOrgId, orgStore } from "./org-store";

export const STORAGE_KEY = "appstrate_view_as";

/**
 * The space half carries the two strings the banner shows. They are captured
 * when the preview is entered — a banner that had to resolve a role name would
 * need a catalog read under the very permissions it is previewing away.
 */
const personaSchema = z.object({
  orgId: z.string().min(1),
  /** Previewing `owner`/`admin` is refused server-side: a preview only removes. */
  orgRole: z.enum(["member", "guest"]),
  space: z
    .object({
      spaceId: z.string().min(1),
      /** Wire form, as the header carries it: `preset:<key>` or `custom:<srl_ id>`. */
      role: z.string().min(1),
      roleLabel: z.string(),
      spaceName: z.string(),
    })
    .nullable(),
});

export type ViewAsPersona = z.infer<typeof personaSchema>;

interface ViewAsState {
  persona: ViewAsPersona | null;
  /**
   * Why the preview ended, waiting to be told to the user — set only when the
   * SERVER refused the persona, never when they left on purpose.
   *
   * It is state rather than a toast fired on the spot because the refusal
   * usually lands during boot, on the org list `main.tsx` starts before React
   * mounts: Sonner drops anything published before its `<Toaster/>` subscribes,
   * so the message would be lost exactly when it matters most.
   */
  stoppedReason: string | null;
  commit: (persona: ViewAsPersona | null, stoppedReason: string | null) => void;
}

/**
 * The init read, exported so a test can exercise the parse it performs (the
 * same shape `pairing-store` exposes). A stored value that no longer parses is
 * dropped rather than repaired: it would otherwise reach the server as a
 * malformed header on every request.
 */
export function readPersistedPersona(): ViewAsPersona | null {
  // Feature-detect the store itself, not `window`: this also runs under the
  // SSR test harness, and a blocked store throws on access rather than being
  // absent (hence the catch).
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = personaSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function persist(persona: ViewAsPersona | null): void {
  try {
    if (persona) localStorage.setItem(STORAGE_KEY, JSON.stringify(persona));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, sandboxed iframe) — the preview still
    // works for this tab, it just does not survive a reload.
  }
}

export const viewAsStore = createStore<ViewAsState>()((set) => ({
  persona: readPersistedPersona(),
  stoppedReason: null,
  commit: (persona, stoppedReason) => {
    set({ persona, stoppedReason });
    persist(persona);
  },
}));

/** Reactive read for components. */
export function useViewAs(): ViewAsPersona | null {
  return useStore(viewAsStore, (s) => s.persona);
}

/**
 * {@link getViewAsHeader} as a reactive value, for the effects that OPEN a
 * connection: an `EventSource` reads its URL once, so a stream opened before
 * the preview started keeps streaming the caller's real authority into a
 * previewed page — and into the cache `enterViewAs` just emptied. Putting this
 * in the effect's dependencies is what makes entering or leaving reconnect.
 */
export function useViewAsHeader(): string | null {
  const persona = useStore(viewAsStore, (s) => s.persona);
  const orgId = useStore(orgStore, (s) => s.id);
  return persona && persona.orgId === orgId ? serializeViewAs(persona) : null;
}

/** The pending "your preview was stopped" message, if the server refused one. */
export function useViewAsStopped(): string | null {
  return useStore(viewAsStore, (s) => s.stoppedReason);
}

/**
 * Take the pending reason, clearing it. An atomic take rather than a separate
 * read-then-clear because StrictMode runs the effect that shows it twice: the
 * second call gets `null` and no second toast is raised.
 */
export function takeViewAsStopped(): string | null {
  const { stoppedReason } = viewAsStore.getState();
  if (stoppedReason !== null) viewAsStore.setState({ stoppedReason: null });
  return stoppedReason;
}

/**
 * Enter the preview. Phase 3's entry dialog is the only caller; it supplies
 * the labels it already rendered in its own pickers.
 */
export function enterViewAs(persona: ViewAsPersona): void {
  viewAsStore.getState().commit(persona, null);
  resetScopedCache();
}

/**
 * The ONE exit path — "Quitter", org switch, sign-out, and a persona the
 * server refuses all land here. Clearing the cache is the point: every cached
 * row was answered under the other authority.
 *
 * `reason` is set only by the refusal path; leaving on purpose needs no
 * explanation.
 */
export function exitViewAs(reason?: string): void {
  if (!viewAsStore.getState().persona) return;
  viewAsStore.getState().commit(null, reason ?? null);
  resetScopedCache();
}

/**
 * Every cached row was answered under the other authority, so all of them go —
 * except `["orgs"]`, which is REFETCHED instead of dropped. `OrgGate` blocks on
 * that query, so removing it flashes the boot screen on every enter and exit;
 * and it cannot merely be left alone either, because under a persona
 * `GET /api/orgs` answers with the persona's `role` and `permissions`, which is
 * what every `can()` gate in the SPA reads. Same split `switchOrg` makes, for
 * the same reason.
 */
function resetScopedCache(): void {
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== orgKeys.all[0] });
  void queryClient.refetchQueries({ queryKey: orgKeys.all });
}

/** The `X-View-As` grammar the server parses; `; ` separated `key=value` pairs. */
function serializeViewAs(persona: ViewAsPersona): string {
  const fields = [`org_role=${persona.orgRole}`];
  if (persona.space) {
    fields.push(`space=${persona.space.spaceId}`, `role=${persona.space.role}`);
  }
  return fields.join("; ");
}

/**
 * Header value for the selected organization, or `null`. Non-hook, for the
 * transport: a persona validated in one org says nothing about another, so
 * outside its own org the caller is simply themselves.
 */
export function getViewAsHeader(): string | null {
  const { persona } = viewAsStore.getState();
  if (!persona || persona.orgId !== getCurrentOrgId()) return null;
  return serializeViewAs(persona);
}
