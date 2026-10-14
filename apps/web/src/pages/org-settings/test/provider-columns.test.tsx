// SPDX-License-Identifier: Apache-2.0

/**
 * The instance's row menu in the providers table: what it offers per model, read off the element
 * tree through `children` alone (a Radix menu draws its items in a portal a static render drops,
 * and its sub-menus need the open menu's context to render).
 */

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { orgModelFixture as model } from "../../../test/org-model-fixture.ts";
import type { OrgModelInfo } from "../../../hooks/use-models.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { useProviderColumns } = await import("../provider-columns.tsx");
const { providerRows } = await import("../../../lib/model-providers.ts");
const { render } = await import("../../../test/render.tsx");

const BUILT_IN = model({
  id: "mdl_builtin",
  label: "Modèle système",
  source: "built-in",
  binding: "system",
  credentialId: null,
});
const BUILT_IN_OFF = model({ ...BUILT_IN, id: "mdl_builtin_off", enabled: false });
const ALIAS = model({
  id: "mdl_alias",
  label: "Alias de l'organisation",
  source: "custom",
  binding: "managed",
  aliased: true,
  credentialId: null,
});
const ALIAS_OFF = model({ ...ALIAS, id: "mdl_alias_off", enabled: false });

type MenuItem = { disabled?: boolean; onSelect?: () => void };

function menuItems(node: ReactNode, items = new Map<string, MenuItem>()): Map<string, MenuItem> {
  if (Array.isArray(node)) node.forEach((child: ReactNode) => menuItems(child, items));
  else if (isValidElement<Record<string, unknown>>(node)) {
    const id = node.props["data-testid"];
    if (typeof id === "string") items.set(id, node.props);
    menuItems(node.props.children as ReactNode, items);
  }
  return items;
}

function instanceMenu(
  models: OrgModelInfo[],
  over: { canWriteModels?: boolean; onDeleteModel?: (m: OrgModelInfo) => void } = {},
): Map<string, MenuItem> {
  let items = new Map<string, MenuItem>();
  function Probe() {
    const columns = useProviderColumns({
      registry: [],
      testingIds: new Set(),
      testResults: {},
      renamingId: null,
      onRenamingChange: () => {},
      onTest: () => {},
      onRename: async () => {},
      onChangeKey: () => {},
      onReconnect: () => {},
      onDelete: () => {},
      onSetDefault: () => {},
      onDeleteModel: over.onDeleteModel,
      canWriteModels: over.canWriteModels ?? true,
    });
    const instance = providerRows(models, [], [], undefined).find((r) => r.kind === "system")!;
    items = menuItems(columns.find((c) => c.id === "actions")!.cell(instance));
    return null;
  }
  render(<Probe />, { queryClient: new QueryClient() });
  return items;
}

describe("the instance's row menu", () => {
  it("deletes an alias the organization added, never a built-in model", () => {
    const deleted: string[] = [];
    const items = instanceMenu([BUILT_IN, ALIAS], { onDeleteModel: (m) => deleted.push(m.id) });
    expect(items.has("delete-model-mdl_alias")).toBe(true);
    expect(items.has("delete-model-mdl_builtin")).toBe(false);
    items.get("delete-model-mdl_alias")!.onSelect!();
    expect(deleted).toEqual(["mdl_alias"]);
  });

  it("offers the deletion to a caller who may delete models though not write them", () => {
    const items = instanceMenu([ALIAS], { canWriteModels: false, onDeleteModel: () => {} });
    expect(items.has("delete-model-mdl_alias")).toBe(true);
    expect(items.has("set-default-model-mdl_alias")).toBe(false);
  });

  it("offers no deletion without the permission", () => {
    expect(instanceMenu([BUILT_IN, ALIAS]).has("delete-model-mdl_alias")).toBe(false);
  });

  it("keeps a switched-off built-in model eligible as the default, not a switched-off alias", () => {
    const items = instanceMenu([BUILT_IN, BUILT_IN_OFF, ALIAS_OFF]);
    expect(items.get("set-default-model-mdl_builtin_off")?.disabled).toBe(false);
    expect(items.get("set-default-model-mdl_alias_off")?.disabled).toBe(true);
  });
});
