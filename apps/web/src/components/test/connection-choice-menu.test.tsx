// SPDX-License-Identifier: Apache-2.0

/**
 * The one component that chooses connections, over a plain list (org default, pins, a schedule's
 * other identity). Its three modes are exclusive radios; the connections are boxes under « Choisir »;
 * and its one encoding of « no connection »: unticking the last box is no choice at this layer
 * (`null`), only the explicit « Aucune connexion » mode writes none (`[]`).
 */

import { describe, expect, it } from "bun:test";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import type { ConnectionSet } from "../../lib/connection-set.ts";
import { ConnectionSetPicker } from "../integration-connect/connection-choice-menu.tsx";
import { menuItems, textsOf, type MenuItem } from "../../test/connection-menu-tree.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

type Props = Parameters<typeof ConnectionSetPicker>[0];
type Items = Map<string, MenuItem>;

const OPTIONS = [
  { id: "a", name: "A" },
  { id: "b", name: "B", disabled: true },
];

function Probe({ props, onItems }: { props: Props; onItems: (items: Items) => void }) {
  onItems(menuItems(<ConnectionSetPicker {...props} />));
  return null;
}

/** The menu of a picker: its items by test id, each with what selecting it wrote. */
function menu(props: Partial<Props> & Pick<Props, "value">) {
  const written: ConnectionSet[] = [];
  let items: Items = new Map();
  const full: Props = {
    options: OPTIONS,
    testPrefix: "p",
    testKey: "k",
    onChange: (next) => written.push(next),
    ...props,
  };
  render(<Probe props={full} onItems={(found) => (items = found)} />);
  const item = (id: string) => {
    const found = items.get(id);
    if (!found) throw new Error(`no item ${id}`);
    return found;
  };
  const select = (id: string) => item(id).onSelect?.({ preventDefault: () => {} });
  const trigger = () => textsOf(item("p-k").children).join("");
  return { items, item, select, written, trigger };
}

describe("ConnectionSetPicker, the encoding of 'no connection'", () => {
  it("unticking the last box is no choice, never none", () => {
    const m = menu({ value: ["a"] });
    m.select("p-option-a");
    expect(m.written).toEqual([null]);
  });

  it("unticking one of several keeps the rest", () => {
    const m = menu({ value: ["a", "b"] });
    m.select("p-option-a");
    expect(m.written).toEqual([["b"]]);
  });

  it("only the none mode writes none, and going back to « Hériter » is no choice", () => {
    const unset = menu({ value: null, allowNone: true, inheritDescription: "d" });
    expect(unset.item("p-none-k")).toMatchObject({ "aria-checked": false });
    unset.select("p-none-k");
    expect(unset.written).toEqual([[]]);

    const none = menu({ value: [], allowNone: true, inheritDescription: "d" });
    expect(none.item("p-none-k")).toMatchObject({ "aria-checked": true });
    none.select("p-none-k");
    expect(none.written).toEqual([]);
    none.select("p-reset-k");
    expect(none.written).toEqual([null]);
  });

  it("ticking a connection over none replaces it, and the mode follows", () => {
    const m = menu({ value: [], allowNone: true });
    m.select("p-option-a");
    expect(m.written).toEqual([["a"]]);
  });

  it("offers no none mode without allowNone", () => {
    expect(menu({ value: [] }).items.has("p-none-k")).toBe(false);
  });

  it("a disabled option refuses a tick, but a ticked one can still be unticked", () => {
    expect(menu({ value: null }).item("p-option-b").disabled).toBe(true);
    expect(menu({ value: ["b"] }).item("p-option-b").disabled).toBe(false);
  });

  it("refuses a tick at the cap, and keeps the ticked ones reachable", () => {
    const ids = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION }, (_, i) => `c${i}`);
    const m = menu({
      options: [...ids, "extra"].map((id) => ({ id, name: id })),
      value: ids,
    });
    expect(m.item("p-option-extra").disabled).toBe(true);
    expect(m.item("p-option-c0").disabled).toBe(false);
  });

  it("waits while a write is in flight", () => {
    const m = menu({ value: ["a"], disabled: true, allowNone: true });
    expect(m.item("p-option-a").disabled).toBe(true);
    expect(m.item("p-none-k").disabled).toBe(true);
  });
});

describe("ConnectionSetPicker, three exclusive modes", () => {
  it("ticks exactly one mode: « Hériter » while nothing is chosen", () => {
    const m = menu({ value: null, allowNone: true, inheritDescription: "d" });
    expect(m.item("p-reset-k")).toMatchObject({ role: "menuitemradio", "aria-checked": true });
    expect(m.item("p-choose-k")).toMatchObject({ role: "menuitemradio", "aria-checked": false });
    expect(m.item("p-none-k")).toMatchObject({ role: "menuitemradio", "aria-checked": false });
  });

  it("switches to « Choisir » as soon as a connection is ticked, boxes under it", () => {
    const m = menu({ value: ["a"], allowNone: true, inheritDescription: "d" });
    expect(m.item("p-reset-k")).toMatchObject({ "aria-checked": false });
    expect(m.item("p-choose-k")).toMatchObject({ "aria-checked": true });
    expect(m.item("p-option-a")).toMatchObject({ role: "menuitemcheckbox", "aria-checked": true });
  });

  it("leaves « Hériter » out where inheriting is no answer", () => {
    const m = menu({ value: null, allowNone: true });
    expect(m.items.has("p-reset-k")).toBe(false);
    expect(m.items.has("p-choose-k")).toBe(true);
  });

  it("with the list alone there is nothing to tell apart: the boxes, without a radio", () => {
    const m = menu({ value: ["a"] });
    expect(m.items.has("p-choose-k")).toBe(false);
    expect(m.items.has("p-reset-k")).toBe(false);
    expect(m.items.has("p-option-a")).toBe(true);
  });

  it("with no connection to list, « Hériter » and « Aucune connexion » remain", () => {
    const m = menu({ options: [], value: null, allowNone: true, inheritDescription: "d" });
    expect(m.items.has("p-choose-k")).toBe(false);
    expect(m.items.has("p-reset-k")).toBe(true);
    expect(m.items.has("p-none-k")).toBe(true);
  });
});

describe("ConnectionSetPicker, the trigger reads the choice", () => {
  it("names « Hériter » when it is the choice, else asks to choose", () => {
    expect(menu({ value: null, inheritDescription: "d" }).trigger()).toBe(
      i18n.t("agents:detail.integrationMemberPicker.inherit"),
    );
    expect(menu({ value: null }).trigger()).toBe(
      i18n.t("agents:detail.integrationMemberPicker.modeChoose"),
    );
  });

  it("names none, the one connection, or how many", () => {
    expect(menu({ value: [], allowNone: true }).trigger()).toBe(
      i18n.t("agents:detail.integrationMemberPicker.none"),
    );
    expect(menu({ value: ["a"] }).trigger()).toBe("A");
    expect(menu({ value: ["a", "b"] }).trigger()).toBe(
      i18n.t("agents:detail.integrationMemberPicker.selectedCount", { count: 2 }),
    );
  });

  it("counts the stored members that are no longer offered, and lists them unticked", () => {
    const m = menu({ value: ["a"], unavailableIds: ["gone"] });
    expect(m.trigger()).toBe(
      `A · ${i18n.t("agents:detail.integrationMemberPicker.unavailableCount", { count: 1 })}`,
    );
    expect(m.item("p-unavailable-gone")).toMatchObject({ "aria-checked": false, disabled: true });
  });
});
