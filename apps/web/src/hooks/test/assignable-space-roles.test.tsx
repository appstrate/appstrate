// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import { useSpaceRoleOptions, type RoleObject } from "../use-roles.ts";
import { render } from "../../test/render.tsx";
import { i18nReady } from "../../i18n.ts";

await i18nReady;

const custom: RoleObject = {
  object: "role",
  kind: "custom",
  id: "srl_delegator",
  key: "delegator",
  name: "Delegated reader",
  description: null,
  permissions: ["agents:read"],
  created_at: null,
  updated_at: null,
};

function RolePicker({ spaceId }: { spaceId: string }) {
  const { options } = useSpaceRoleOptions(spaceId);
  return (
    <select>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function seed(qc: QueryClient, spaceId: string, roles: RoleObject[]) {
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces/{id}/roles", {
      params: { path: { id: spaceId }, header: { "X-Org-Id": undefined } },
    }).queryKey,
    { object: "list", data: roles, hasMore: false },
  );
}

describe("assignable space role picker", () => {
  it("renders a custom assignment from the space catalog without access to the org role catalog", () => {
    const queryClient = new QueryClient();
    seed(queryClient, "spc_delegated", [custom]);
    const html = render(<RolePicker spaceId="spc_delegated" />, { queryClient });
    expect(html).toContain('<option value="custom:srl_delegator">Delegated reader</option>');
    expect(html).not.toContain('value="preset:admin"');
  });

  it("keeps cached catalogs separate across target spaces and offers no fallback grants while loading", () => {
    const queryClient = new QueryClient();
    seed(queryClient, "spc_admin", [
      { ...custom, kind: "preset", id: null, key: "admin", name: "admin" },
    ]);
    seed(queryClient, "spc_delegated", [custom]);
    expect(render(<RolePicker spaceId="spc_admin" />, { queryClient })).toContain(
      'value="preset:admin"',
    );
    expect(render(<RolePicker spaceId="spc_delegated" />, { queryClient })).not.toContain(
      'value="preset:admin"',
    );
    expect(render(<RolePicker spaceId="spc_loading" />, { queryClient })).not.toContain("<option");
  });
});
