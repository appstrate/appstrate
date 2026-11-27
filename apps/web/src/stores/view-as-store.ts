// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" persona (SPA copy; the server enforces it, `apps/api/src/lib/view-as.ts`).
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.7, §8
 */

import { z } from "zod";
import { VIEW_AS_ORG_ROLES } from "@appstrate/core/permissions";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { components } from "../api/schema";
import { queryClient } from "../lib/query-client";
import { orgKeys, removeOrgScopedQueries } from "../lib/query-keys";
import {
  LOCAL_STORAGE_KEYS,
  createLocalStore,
  jsonCodec,
  storageKey,
} from "@appstrate/ui/local-storage";
import { getCurrentOrgId, orgStore } from "./org-store";

export const STORAGE_KEY = storageKey(LOCAL_STORAGE_KEYS.viewAs);

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

type Organization = components["schemas"]["Organization"];

interface ViewAsState {
  persona: ViewAsPersona | null;
  returnSpaceId: string | null;
  /** Set when the preview can no longer be restored or applied. State, not a toast: it lands before `<Toaster/>` subscribes. */
  stoppedReason: string | null;
  commit: (
    persona: ViewAsPersona | null,
    stoppedReason: string | null,
    returnSpaceId: string | null,
  ) => void;
}

const storedPreviewSchema = personaSchema.extend({ returnSpaceId: z.string().min(1).nullable() });
const persistedPreview = createLocalStore(
  LOCAL_STORAGE_KEYS.viewAs,
  jsonCodec(
    (value) => (value === null ? null : storedPreviewSchema.safeParse(value).data),
    () => undefined,
  ),
);

export function readStoredPreview(): Pick<
  ViewAsState,
  "persona" | "returnSpaceId" | "stoppedReason"
> {
  const value = persistedPreview.read();
  const empty = { persona: null, returnSpaceId: null, stoppedReason: null };
  if (value === null) return empty;
  if (value === undefined) {
    persistedPreview.write(null);
    return { ...empty, stoppedReason: "invalid_view_as" };
  }
  const { returnSpaceId, ...persona } = value;
  return { persona, returnSpaceId, stoppedReason: null };
}

export const viewAsStore = createStore<ViewAsState>()((set) => ({
  ...readStoredPreview(),
  commit: (persona, stoppedReason, returnSpaceId) => {
    set({ persona, stoppedReason, returnSpaceId });
    persistedPreview.write(persona && { ...persona, returnSpaceId });
  },
}));

export function useViewAs(): ViewAsPersona | null {
  return useStore(viewAsStore, (s) => s.persona);
}

/** Reactive {@link getViewAsHeader}: an `EventSource` reads its URL once, so connection-opening effects depend on this. */
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
 * Start (or replace) a preview. `orgs` is the listing ALREADY fetched as this
 * persona (`fetchOrgsAs`): `["orgs"]` is spared by the cache reset and every
 * `can()` reads it, so persona and listing must land in the same tick, and a
 * failed load must start no preview.
 */
export function enterViewAs(
  persona: ViewAsPersona,
  orgs: Organization[],
  returnSpaceId: string | null = null,
): void {
  const previous = viewAsStore.getState();
  previous.commit(
    persona,
    null,
    previous.persona?.orgId === persona.orgId ? previous.returnSpaceId : returnSpaceId,
  );
  // Cancel first: an `/api/orgs` in flight under the PREVIOUS authority would
  // overwrite the seeded persona permissions (`exitViewAs` gets this from `invalidateQueries`).
  void queryClient.cancelQueries({ queryKey: orgKeys.all });
  queryClient.setQueryData(orgKeys.all, orgs);
  removeOrgScopedQueries(queryClient);
}

/** The ONE exit path ("Quitter", org switch, sign-out, refused persona); returns the space to go back to. */
export function exitViewAs(reason?: string): string | null {
  const { persona, returnSpaceId, commit } = viewAsStore.getState();
  if (!persona) return null;
  commit(null, reason ?? null, null);
  removeOrgScopedQueries(queryClient);
  // Invalidated, not refetched: a failed refetch would leave the persona's
  // reduced row serving the caller for good. Exit must need no network.
  void queryClient.invalidateQueries({ queryKey: orgKeys.all });
  return returnSpaceId;
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
