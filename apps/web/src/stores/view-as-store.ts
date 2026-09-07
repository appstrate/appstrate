// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" — the persona an owner or administrator is previewing the
 * product as. The server enforces it on every call (`apps/api/src/lib/view-as.ts`);
 * this is only the SPA's copy. Persisted under ONE key carrying its own
 * `orgId`, read at module init and never again, so tabs hold personas the way
 * they hold organizations.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.7, §8
 */

import { z } from "zod";
import { VIEW_AS_ORG_ROLES } from "@appstrate/core/permissions";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { queryClient } from "../lib/query-client";
import { orgKeys, removeOrgScopedQueries } from "../lib/query-keys";
import { getCurrentOrgId, orgStore } from "./org-store";

export const STORAGE_KEY = "appstrate_view_as";

/**
 * The space half carries the two strings the banner shows, captured on entry:
 * resolving a role name later would need a catalog read under the very
 * permissions being previewed away.
 */
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

interface ViewAsState {
  persona: ViewAsPersona | null;
  /**
   * Why the preview ended, waiting to be told to the user — set only when the
   * SERVER refused the persona.
   *
   * State rather than a toast fired on the spot: the refusal usually lands on
   * the boot org list, and Sonner drops anything published before its
   * `<Toaster/>` subscribes.
   */
  stoppedReason: string | null;
  commit: (persona: ViewAsPersona | null, stoppedReason: string | null) => void;
}

/**
 * The init read. A stored value that no longer parses is dropped rather than
 * repaired: it would otherwise reach the server as a malformed header on every
 * request.
 */
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

/** Reactive read for components. */
export function useViewAs(): ViewAsPersona | null {
  return useStore(viewAsStore, (s) => s.persona);
}

/**
 * {@link getViewAsHeader} as a reactive value, for the effects that OPEN a
 * connection: an `EventSource` reads its URL once, so listing this in an
 * effect's dependencies is what makes entering or leaving a preview reconnect.
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
 * Take the pending reason, clearing it. Atomic rather than read-then-clear
 * because StrictMode runs the effect that shows it twice.
 */
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

/** Enter the preview, with the labels the entry dialog already rendered. */
export function enterViewAs(persona: ViewAsPersona): void {
  viewAsStore.getState().commit(persona, null);
  resetScopedCache();
}

/**
 * The ONE exit path — "Quitter", org switch, sign-out and a refused persona all
 * land here. `reason` is set only by the refusal path.
 */
export function exitViewAs(reason?: string): void {
  if (!viewAsStore.getState().persona) return;
  viewAsStore.getState().commit(null, reason ?? null);
  resetScopedCache();
}

/**
 * `["orgs"]` is REFETCHED rather than dropped or left alone: under a persona
 * `GET /api/orgs` answers with the persona's `role` and `permissions`, which is
 * what every `can()` gate in the SPA reads.
 */
function resetScopedCache(): void {
  removeOrgScopedQueries(queryClient);
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
 * Header value for the selected organization, or `null` — a persona validated
 * in one org says nothing about another.
 */
export function getViewAsHeader(): string | null {
  const { persona } = viewAsStore.getState();
  if (!persona || persona.orgId !== getCurrentOrgId()) return null;
  return serializeViewAs(persona);
}
