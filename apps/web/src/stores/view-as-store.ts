// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" — the persona an owner/admin is previewing as. The server
 * enforces it on every call (`apps/api/src/lib/view-as.ts`); this is the SPA's
 * copy, persisted under one key carrying its own `orgId`, read once at init.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.7, §8
 */

import { z } from "zod";
import { VIEW_AS_ORG_ROLES } from "@appstrate/core/permissions";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { components } from "../api/schema";
import { queryClient } from "../lib/query-client";
import { orgKeys, removeOrgScopedQueries } from "../lib/query-keys";
import { getCurrentOrgId, orgStore } from "./org-store";

export const STORAGE_KEY = "appstrate_view_as";

/** Banner labels are captured on entry: resolving them later needs reads the preview may forbid. */
const personaSchema = z.object({
  orgId: z.string().min(1),
  /** Previewing `owner`/`admin` is refused server-side: a preview only removes. */
  orgRole: z.enum(VIEW_AS_ORG_ROLES),
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

/** A row of `GET /api/orgs` — where `permissions` lives. */
type Organization = components["schemas"]["Organization"];

interface ViewAsState {
  persona: ViewAsPersona | null;
  /**
   * Set only when the SERVER refused the persona. State, not an immediate toast:
   * the refusal usually lands before `<Toaster/>` subscribes and Sonner drops it.
   */
  stoppedReason: string | null;
  commit: (persona: ViewAsPersona | null, stoppedReason: string | null) => void;
}

/** A stored value that no longer parses is dropped, never sent as a malformed header. */
export function readPersistedPersona(): ViewAsPersona | null {
  // The store itself, not `window`: the SSR harness has one without the other.
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
    // Storage blocked (private mode, sandboxed iframe): the preview works for
    // this tab, it just does not survive a reload.
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

export function useViewAs(): ViewAsPersona | null {
  return useStore(viewAsStore, (s) => s.persona);
}

/**
 * Reactive {@link getViewAsHeader}: an `EventSource` reads its URL once, so
 * effects that OPEN a connection must depend on this to reconnect.
 */
export function useViewAsHeader(): string | null {
  const persona = useStore(viewAsStore, (s) => s.persona);
  const orgId = useStore(orgStore, (s) => s.id);
  return persona && persona.orgId === orgId ? serializeViewAs(persona) : null;
}

export function useViewAsStopped(): string | null {
  return useStore(viewAsStore, (s) => s.stoppedReason);
}

/** Atomic take-and-clear: StrictMode runs the consuming effect twice. */
export function takeViewAsStopped(): string | null {
  const { stoppedReason } = viewAsStore.getState();
  if (stoppedReason !== null) viewAsStore.setState({ stoppedReason: null });
  return stoppedReason;
}

/** The space half exists only when BOTH were chosen — the header's own rule. */
export function toViewAsPersona(
  orgId: string,
  orgRole: ViewAsPersona["orgRole"],
  space: { id: string; name: string } | undefined,
  roleOption: { value: string; label: string } | undefined,
): ViewAsPersona {
  return {
    orgId,
    orgRole,
    space:
      space && roleOption
        ? {
            spaceId: space.id,
            role: roleOption.value,
            roleLabel: roleOption.label,
            spaceName: space.name,
          }
        : null,
  };
}

/**
 * Start — or replace — a preview.
 *
 * `orgs` is the org listing ALREADY answered for this persona (`fetchOrgsAs`),
 * passed in rather than fetched here because the two must land in the same tick:
 * `["orgs"]` is the one query the cache reset spares, every `can()` gate reads
 * `permissions` off that row, and React Query keeps serving the previous value
 * through a background refetch — and forever if it fails. Committing the persona
 * alone would present the previewer's own authority as the persona's; loading
 * first also means a load that fails starts no preview at all.
 */
export function enterViewAs(persona: ViewAsPersona, orgs: Organization[]): void {
  viewAsStore.getState().commit(persona, null);
  queryClient.setQueryData(orgKeys.all, orgs);
  removeOrgScopedQueries(queryClient);
}

/** The ONE exit path — "Quitter", org switch, sign-out and a refused persona. */
export function exitViewAs(reason?: string): void {
  if (!viewAsStore.getState().persona) return;
  viewAsStore.getState().commit(null, reason ?? null);
  removeOrgScopedQueries(queryClient);
  // Invalidated, not refetched: a failed refetch would leave the persona's
  // reduced row serving the caller for good. Exit must need no network.
  void queryClient.invalidateQueries({ queryKey: orgKeys.all });
}

/** The `X-View-As` grammar the server parses; `; ` separated `key=value` pairs. */
export function serializeViewAs(persona: ViewAsPersona): string {
  const fields = [`org_role=${persona.orgRole}`];
  if (persona.space) {
    fields.push(`space=${persona.space.spaceId}`, `role=${persona.space.role}`);
  }
  return fields.join("; ");
}

/** Header for the selected organization only — a persona says nothing about another org. */
export function getViewAsHeader(): string | null {
  const { persona } = viewAsStore.getState();
  if (!persona || persona.orgId !== getCurrentOrgId()) return null;
  return serializeViewAs(persona);
}
