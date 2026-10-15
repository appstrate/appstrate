// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WidgetProps } from "@rjsf/utils";
import { Combobox, MultiCombobox } from "../src/components/combobox.tsx";
import { MultiSelectWidget, SelectWidget } from "../src/schema-form/widgets.tsx";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];
const common = { options, searchPlaceholder: "Search", emptyText: "None" };

describe("Combobox", () => {
  it("shows the placeholder while nothing is selected", () => {
    const html = renderToStaticMarkup(
      <Combobox {...common} value="" onValueChange={() => {}} placeholder="Pick one" />,
    );
    expect(html).toContain("Pick one");
    expect(html).not.toContain("Alpha");
  });

  it("shows the label of the selected option", () => {
    const html = renderToStaticMarkup(<Combobox {...common} value="b" onValueChange={() => {}} />);
    expect(html).toContain("Beta");
    expect(html).not.toContain("Alpha");
  });
});

describe("MultiCombobox", () => {
  it("shows the placeholder while nothing is selected", () => {
    const html = renderToStaticMarkup(
      <MultiCombobox {...common} value={[]} onValueChange={() => {}} placeholder="Pick" />,
    );
    expect(html).toContain("Pick");
  });

  it("shows every selected option as a badge, in option order", () => {
    const html = renderToStaticMarkup(
      <MultiCombobox {...common} value={["b", "a"]} onValueChange={() => {}} />,
    );
    expect(html.indexOf("Alpha")).toBeGreaterThan(-1);
    expect(html.indexOf("Alpha")).toBeLessThan(html.indexOf("Beta"));
  });
});

/** The widgets are plain function components: calling one yields the combobox element to drive. */
function drive(Widget: (props: WidgetProps) => ReactElement, props: Record<string, unknown>) {
  const enumOptions = [
    { label: "Alpha", value: 1 },
    { label: "Beta", value: { id: 2 } },
    { label: "Gamma", value: "c" },
  ];
  const element = Widget({ id: "s", options: { enumOptions }, ...props } as unknown as WidgetProps);
  return element.props as {
    value: string | string[];
    emptyText: string;
    onValueChange: (value: never) => void;
  };
}

describe("select widgets over comboboxes", () => {
  it("keys a single select by option position, and empty when nothing matches", () => {
    expect(drive(SelectWidget, { value: { id: 2 } }).value).toBe("1");
    expect(drive(SelectWidget, { value: "unknown" }).value).toBe("");
  });

  it("hands the option's own value to onChange, and undefined when cleared", () => {
    const seen: unknown[] = [];
    const { onValueChange } = drive(SelectWidget, { onChange: (v: unknown) => seen.push(v) });
    onValueChange("1" as never);
    onValueChange("" as never);
    expect(seen).toEqual([{ id: 2 }, undefined]);
  });

  it("emits a multi selection in option order, whatever the pick order", () => {
    const seen: unknown[] = [];
    const { onValueChange, value } = drive(MultiSelectWidget, {
      value: ["c", 1],
      onChange: (v: unknown) => seen.push(v),
    });
    expect(value).toEqual(["0", "2"]);
    onValueChange(["2", "0", "1"] as never);
    expect(seen).toEqual([[1, { id: 2 }, "c"]]);
  });

  it("words the empty list from the form's labels, with an English fallback", () => {
    expect(drive(SelectWidget, {}).emptyText).toBe("No options");
    const registry = { formContext: { labels: { noOptions: "Aucun résultat" } } };
    expect(drive(SelectWidget, { registry }).emptyText).toBe("Aucun résultat");
  });
});
