// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { render } from "../test/render.tsx";
import { i18nReady } from "../i18n.ts";
import { SpaceAssignmentsField } from "./space-assignments-field.tsx";
import { hasUnavailableAssignments } from "../lib/space-assignments.ts";

await i18nReady;

const spaces = [{ id: "spc_support", name: "Assistance clients Europe et Amérique" }];
const roles = [{ value: "custom:srl_support", label: "Responsable assistance" }];
const assignments = [{ space_id: spaces[0]!.id, role: roles[0]!.value }];

function field({
  loading = false,
  error = null,
  availableSpaces = spaces,
  availableRoles = roles,
}: {
  loading?: boolean;
  error?: Error | null;
  availableSpaces?: typeof spaces;
  availableRoles?: typeof roles;
} = {}) {
  return render(
    <SpaceAssignmentsField
      value={assignments}
      onChange={() => {}}
      disabled={false}
      hint="Accès initial"
      spaces={availableSpaces}
      roleOptions={availableRoles}
      loading={loading}
      error={error}
      onRetry={() => {}}
    />,
  );
}

describe("space assignment catalog recovery", () => {
  it("preserves selected identities while loading and does not present loading as an empty catalog", () => {
    const html = field({ loading: true });
    expect(html).toContain(spaces[0]!.name);
    expect(html).toContain('role="status"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Aucun espace disponible");
  });

  it("reports a failed catalog and leaves removal available so a stale draft can be repaired", () => {
    const html = field({ error: new Error("Catalogue inaccessible") });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Catalogue inaccessible");
    expect(html).toContain("Réessayer");
    const removeButton = html.match(/<button[^>]*aria-label="Retirer cet espace"[^>]*>/)?.[0];
    expect(removeButton).toBeDefined();
    expect(removeButton).not.toContain('disabled=""');
  });

  it("keeps a deleted selection visible as unavailable without exposing its raw space ID", () => {
    const html = field({ availableSpaces: [], availableRoles: [] });
    expect(html).toContain("Espace indisponible");
    expect(html).not.toContain("spc_support");
    expect(hasUnavailableAssignments(assignments, [], roles)).toBe(true);
    expect(hasUnavailableAssignments(assignments, spaces, [])).toBe(true);
  });

  it("accepts an assignment again when the same IDs recover, even after catalog labels change", () => {
    const renamedSpaces = [{ ...spaces[0]!, name: "New name" }];
    const renamedRoles = [{ ...roles[0]!, label: "New label" }];
    expect(hasUnavailableAssignments(assignments, renamedSpaces, renamedRoles)).toBe(false);
    expect(hasUnavailableAssignments([], [], [])).toBe(false);
  });

  it("explains administrator access without showing irrelevant catalog errors", () => {
    const html = render(
      <SpaceAssignmentsField
        value={assignments}
        onChange={() => {}}
        disabled
        allSpacesAccess
        hint="Administre tous les espaces"
        spaces={[]}
        roleOptions={[]}
        loading
        error={new Error("Catalogue inaccessible")}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("Tous les espaces — tous les droits");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Catalogue inaccessible");
    expect(html).not.toContain('role="status"');
  });
});
