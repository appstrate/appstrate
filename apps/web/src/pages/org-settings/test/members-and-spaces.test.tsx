// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import type { DataColumn } from "../../../components/data-table.tsx";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { useSpaceColumns, type SpaceRow } from "../space-columns.tsx";

// The members page reaches the auth client, which reads `window.location` at import.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});
const { invalidateMemberWrite } = await import("../../../hooks/use-org.ts");

await i18nReady;
await i18n.changeLanguage("fr");

describe("an org member write", () => {
  it("refreshes the space seats it changed, with the org", () => {
    const queryClient = new QueryClient();
    const seats = ["get", "/api/spaces/{id}/members", { params: { path: { id: "spc_1" } } }];
    const org = ["get", "/api/orgs/{orgId}", { params: { path: { orgId: "org_1" } } }];
    queryClient.setQueryData(seats, { data: [] });
    queryClient.setQueryData(org, {});
    invalidateMemberWrite(queryClient);
    expect(queryClient.getQueryState(seats)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(org)?.isInvalidated).toBe(true);
  });
});

describe("the spaces list", () => {
  const space: SpaceRow = {
    id: "spc_1",
    name: "Production",
    isDefault: false,
    createdAt: "2026-01-01T00:00:00Z",
    personal: false,
    icon: null,
    color: null,
    visibility: "closed",
    access: "member",
  };

  function kindCell(row: SpaceRow): string {
    let columns: DataColumn<SpaceRow>[] = [];
    function Probe(): ReactElement | null {
      columns = useSpaceColumns({ defaultLabel: "Par défaut" });
      return null;
    }
    render(<Probe />);
    const kind = columns.find((column) => column.id === "kind")!;
    return render(<>{kind.cell(row)}</>);
  }

  it("says who reaches a team space", () => {
    expect(kindCell(space)).toContain("Fermé");
    const html = kindCell({ ...space, isDefault: true, visibility: "open" });
    expect(html).toContain("Ouvert");
    expect(html).toContain("Par défaut");
  });

  it("names a personal space as such", () => {
    expect(kindCell({ ...space, personal: true, visibility: "private" })).toContain("Personnel");
  });
});
